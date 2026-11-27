package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"
)

// OpenCode 2.x runs one background service per user (`opencode serve
// --service`) that every TUI of that user connects to; it owns the sessions,
// their messages and their pending permissions and forms. termote reads them
// through the service's HTTP API, never through opencode.db or the TUI's
// screen, and never runs the opencode CLI: `opencode api` and the TUI start
// the service when none runs, and termote must not.
//
// The service records where it listens in $XDG_STATE_HOME/opencode/service.json
// (else ~/.local/state/opencode/service.json, mode 0600): its url, pid,
// version and the password every /api route asks for as HTTP Basic auth with
// the user name "opencode" (checked on OpenCode 2.3.0). The file read is the
// one of the user running termote; the password only ever goes into the
// Authorization header of a request to the loopback address that file names.

const (
	// opencodeMinVersion is the first OpenCode with the background service
	// and the API read here.
	opencodeMinVersion = "2.0.0"
	// opencodeServiceTTL is how long one check of the service (its file and
	// /api/info) is used before the file is read again.
	opencodeServiceTTL = 30 * time.Second
	// opencodeTimeout bounds one request to the service.
	opencodeTimeout = 2 * time.Second
	// opencodeFileMax bounds service.json.
	opencodeFileMax = 64 << 10
	// opencodeSmallMax bounds a reply that holds no message (info, the
	// active sessions, a session, its permissions and forms).
	opencodeSmallMax = 1 << 20
)

// The bounds of a read of messages, vars tests lower with opencodeImageMax.
var (
	// opencodeMessagesMax bounds a page of messages: a user message carries
	// the base64 of every image pasted with it.
	opencodeMessagesMax int64 = 24 << 20
	// opencodeOneMessageMax bounds one message read alone (an image's, or
	// the Chat view's page of one message, oneMessage): the base64 of five
	// images of opencodeImageMax, and its other fields.
	opencodeOneMessageMax int64 = 72 << 20
)

var (
	// OpenCode makes ses_ + 26 base62 characters; an id given with
	// --session only has to start with "ses" (its OpenAPI pattern).
	opencodeSessionIDRe = regexp.MustCompile(`^ses[A-Za-z0-9_]{1,64}$`)
	// A fork's copies of its parent's messages add _<n> to their ids.
	opencodeMessageIDRe    = regexp.MustCompile(`^msg_[A-Za-z0-9_]{1,64}$`)
	opencodePermissionIDRe = regexp.MustCompile(`^per_[A-Za-z0-9]{1,64}$`)
	opencodeFormIDRe       = regexp.MustCompile(`^frm_[A-Za-z0-9]{1,64}$`)
)

func isOpencodeSessionID(s string) bool { return opencodeSessionIDRe.MatchString(s) }

var (
	// errOpencodeUnavailable: no service runs, it is older than 2.0.0, or it
	// refused the password. The pane then shows only the agent's logo.
	errOpencodeUnavailable = errors.New("opencode service unavailable")
	// errOpencodeNotFound: the service answered 404 (a session that does
	// not exist yet, a permission already answered).
	errOpencodeNotFound = errors.New("opencode: not found")
	// errOpencodeTooLarge: a reply over its limit (a page of messages with
	// many pasted images); asked again for less.
	errOpencodeTooLarge = errors.New("opencode: reply too large")
)

// opencodeStateDir is where OpenCode keeps its state, as OpenCode itself
// finds it; tests replace it.
var opencodeStateDir = opencodeDefaultStateDir

func opencodeDefaultStateDir() string {
	if d := os.Getenv("XDG_STATE_HOME"); filepath.IsAbs(d) {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil || !filepath.IsAbs(home) {
		return ""
	}
	return filepath.Join(home, ".local", "state")
}

// opencodeServiceFile is the part of service.json read here.
type opencodeServiceFile struct {
	URL      string `json:"url"`
	PID      int    `json:"pid"`
	Version  string `json:"version"`
	Password string `json:"password"`
}

// readOpencodeServiceFile reads service.json and checks that it names a
// loopback address.
func readOpencodeServiceFile() (opencodeServiceFile, *url.URL, error) {
	dir := opencodeStateDir()
	if dir == "" {
		return opencodeServiceFile{}, nil, errOpencodeUnavailable
	}
	f, err := os.Open(filepath.Join(dir, "opencode", "service.json"))
	if err != nil {
		return opencodeServiceFile{}, nil, errOpencodeUnavailable
	}
	defer f.Close()
	var sf opencodeServiceFile
	if err := json.NewDecoder(io.LimitReader(f, opencodeFileMax)).Decode(&sf); err != nil {
		return opencodeServiceFile{}, nil, fmt.Errorf("opencode service file: %w", errOpencodeUnavailable)
	}
	u, ok := opencodeLoopbackURL(sf.URL)
	if !ok || sf.PID <= 0 || sf.Password == "" {
		return opencodeServiceFile{}, nil, fmt.Errorf("opencode service file: unusable: %w", errOpencodeUnavailable)
	}
	return sf, u, nil
}

// opencodeLoopbackURL accepts only http://<loopback IP>:<port>, with no user,
// path, query or fragment: the password must never leave this machine, and a
// name would be resolved through DNS or /etc/hosts.
func opencodeLoopbackURL(raw string) (*url.URL, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Opaque != "" ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return nil, false
	}
	ip := net.ParseIP(u.Hostname())
	port, err := strconv.Atoi(u.Port())
	if ip == nil || !ip.IsLoopback() || err != nil || port <= 0 || port > 65535 {
		return nil, false
	}
	return &url.URL{Scheme: "http", Host: u.Host}, true
}

// opencodeClient talks to one running service.
type opencodeClient struct {
	base *url.URL
	// auth is the Authorization header value; never logged or returned.
	auth    string
	pid     int
	version string
	http    *http.Client
}

// opencodeHTTP never follows a redirect (the password would go with it),
// never uses a proxy from the environment, and talks only to a socket of
// the server's own user (opencodeDial).
var opencodeHTTP = &http.Client{
	Transport: &http.Transport{Proxy: nil, DialContext: opencodeDial, MaxIdleConnsPerHost: 4,
		IdleConnTimeout: 30 * time.Second},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// opencodeConnCheck is untrustedConn, the check the CLI makes before it
// sends termote's own password; tests replace it.
var opencodeConnCheck = untrustedConn

// errOpencodeForeign: the port service.json names is held by another user's
// process (the service died and another user took its port), or its owner
// cannot be seen.
var errOpencodeForeign = errors.New("opencode service port not held by this user")

// opencodeDial connects and checks, before a byte (the password) is sent,
// that the process listening at the other end runs as the server's own
// user (or root).
func opencodeDial(ctx context.Context, network, addr string) (net.Conn, error) {
	conn, err := (&net.Dialer{Timeout: opencodeTimeout}).DialContext(ctx, network, addr)
	if err != nil {
		return nil, err
	}
	tcp, ok := conn.RemoteAddr().(*net.TCPAddr)
	if !ok || opencodeConnCheck(tcp.Port, conn) != 0 {
		conn.Close()
		return nil, errOpencodeForeign
	}
	return conn, nil
}

// opencodeServices shares one check of the service between every lookup
// for opencodeServiceTTL; a refused password or a failed connection drops it
// (opencodeForget), so a service restarted on another port is found again. A
// failed check is not kept: opencodeDown only spaces the next one by
// opencodeRetry, so a service just started is found within it.
var (
	opencodeServices = newTTLCache[*opencodeClient](opencodeServiceTTL)
	opencodeDown     = newTTLCache[struct{}](opencodeRetry)
)

// opencodeRetry is how long a failed check of the service is trusted.
const opencodeRetry = 2 * time.Second

// opencodeConnect returns a client for the user's running service: its
// service.json read, and /api/info answering with the pid and version the
// file names (as OpenCode checks its own service), at least 2.0.0.
func opencodeConnect() (*opencodeClient, error) {
	if _, down := opencodeDown.peek(""); down {
		return nil, errOpencodeUnavailable
	}
	c, err := opencodeServices.do("", opencodeCheck)
	if err != nil {
		opencodeServices.forgetPrefix("")
		opencodeDown.do("", func() (struct{}, error) { return struct{}{}, nil })
	}
	return c, err
}

// opencodeCheck reads service.json and asks the service it names.
func opencodeCheck() (*opencodeClient, error) {
	{
		sf, base, err := readOpencodeServiceFile()
		if err != nil {
			return nil, err
		}
		c := &opencodeClient{
			base: base, pid: sf.PID, version: sf.Version, http: opencodeHTTP,
			auth: "Basic " + base64.StdEncoding.EncodeToString([]byte("opencode:"+sf.Password)),
		}
		var info struct {
			Version string `json:"version"`
			PID     int    `json:"pid"`
		}
		ctx, cancel := context.WithTimeout(context.Background(), opencodeTimeout)
		defer cancel()
		if err := c.get(ctx, "/api/info", nil, opencodeSmallMax, &info); err != nil {
			return nil, fmt.Errorf("opencode info: %w", err)
		}
		if info.PID != sf.PID || (sf.Version != "" && info.Version != sf.Version) ||
			!versionRe.MatchString(info.Version) || compareVersions(info.Version, opencodeMinVersion) < 0 {
			return nil, fmt.Errorf("opencode info: another service or version %q: %w", info.Version, errOpencodeUnavailable)
		}
		return c, nil
	}
}

// opencodeForget drops the cached service, so the next lookup reads
// service.json again (a restarted service has a new password and pid).
func opencodeForget() { opencodeServices.forgetPrefix("") }

// opencodeForgetIfDial drops the cached service when err is a failed
// connection to it (refused, timed out, or its port held by another user):
// the service it names is gone. Any other error keeps it.
func opencodeForgetIfDial(err error) {
	var op *net.OpError
	if errors.Is(err, errOpencodeForeign) || (errors.As(err, &op) && op.Op == "dial") {
		opencodeForget()
	}
}

// opencodeLargeReads bounds the replies over opencodeSmallMax read at once,
// whatever asks for them (transcript pages by cursor, history, usage,
// skills, models): each is held in memory twice, as bytes and decoded, so N
// clients asking for different pages must not hold N of them. The slot
// covers the read and the decode only, never the answer to the client.
var opencodeLargeReads = make(chan struct{}, 4)

// get reads path into out, answering errOpencodeNotFound for a 404 and
// errOpencodeUnavailable for a refused password. The body is read up to
// limit bytes; its text never goes into an error.
func (c *opencodeClient) get(ctx context.Context, path string, q url.Values, limit int64, out any) error {
	if limit > opencodeSmallMax {
		select {
		case opencodeLargeReads <- struct{}{}:
			defer func() { <-opencodeLargeReads }()
		case <-ctx.Done():
			return fmt.Errorf("opencode %s: %w", path, errors.Join(errOpencodeUnavailable, ctx.Err()))
		}
	}
	u := *c.base
	u.Path = path
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", c.auth)
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		opencodeForgetIfDial(err)
		return fmt.Errorf("opencode %s: %w", path, errors.Join(errOpencodeUnavailable, err))
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		opencodeForget()
		return fmt.Errorf("opencode %s: status %d: %w", path, resp.StatusCode, errOpencodeUnavailable)
	case resp.StatusCode == http.StatusNotFound:
		return fmt.Errorf("opencode %s: %w", path, errOpencodeNotFound)
	case resp.StatusCode != http.StatusOK:
		return fmt.Errorf("opencode %s: status %d", path, resp.StatusCode)
	}
	body := io.LimitReader(resp.Body, limit+1)
	data, err := io.ReadAll(body)
	if err != nil {
		return fmt.Errorf("opencode %s: read: %w", path, err)
	}
	if int64(len(data)) > limit {
		return fmt.Errorf("opencode %s: over %d bytes: %w", path, limit, errOpencodeTooLarge)
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("opencode %s: decode reply", path)
	}
	return nil
}

// active is the set of sessions running a turn now.
func (c *opencodeClient) active(ctx context.Context) (map[string]bool, error) {
	var res struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if err := c.get(ctx, "/api/session/active", nil, opencodeSmallMax, &res); err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(res.Data))
	for id := range res.Data {
		if isOpencodeSessionID(id) {
			out[id] = true
		}
	}
	return out, nil
}

// opencodePending is one permission request or form a session waits on.
// A permission names the action asked for (shell, edit, read...), the
// resources it is asked on (a command, a file) and the patterns "always"
// saves; a form its title and fields. The rest of either is not read.
type opencodePending struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionID"`
	// Permission
	Action    string   `json:"action"`
	Resources []string `json:"resources"`
	Save      []string `json:"save"`
	// Form
	Title  string              `json:"title"`
	Fields []opencodeFormField `json:"fields"`
}

// opencodeFormField is one field of a form, every kind OpenCode 2.3.0 has:
// string, number, integer, boolean, multiselect and external (a link to
// open). Bounds and defaults are raw: OpenCode writes an unbounded one as
// "Infinity".
type opencodeFormField struct {
	Key         string               `json:"key"`
	Type        string               `json:"type"`
	Title       string               `json:"title"`
	Description string               `json:"description"`
	Required    bool                 `json:"required"`
	Hidden      bool                 `json:"hidden"`
	Format      string               `json:"format"`
	Placeholder string               `json:"placeholder"`
	Options     []opencodeFormOption `json:"options"`
	Custom      bool                 `json:"custom"`
	MinLength   *int                 `json:"minLength"`
	MaxLength   *int                 `json:"maxLength"`
	Minimum     json.RawMessage      `json:"minimum"`
	Maximum     json.RawMessage      `json:"maximum"`
	MinItems    *int                 `json:"minItems"`
	MaxItems    *int                 `json:"maxItems"`
	Default     json.RawMessage      `json:"default"`
	When        []struct {
		Key   string          `json:"key"`
		Op    string          `json:"op"`
		Value json.RawMessage `json:"value"`
	} `json:"when"`
}

type opencodeFormOption struct {
	Value       string `json:"value"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

// pending lists what session id waits on: its permission requests, then its
// forms. Only ids of the expected shape and of this session are kept.
func (c *opencodeClient) pending(ctx context.Context, id string) (permissions, forms []opencodePending, err error) {
	if !isOpencodeSessionID(id) {
		return nil, nil, errOpencodeNotFound
	}
	keep := func(path string, re *regexp.Regexp) ([]opencodePending, error) {
		var res struct {
			Data []opencodePending `json:"data"`
		}
		if err := c.get(ctx, "/api/session/"+id+path, nil, opencodeSmallMax, &res); err != nil {
			return nil, err
		}
		var out []opencodePending
		for _, p := range res.Data {
			if p.SessionID == id && re.MatchString(p.ID) {
				out = append(out, p)
			}
		}
		return out, nil
	}
	if permissions, err = keep("/permission", opencodePermissionIDRe); err != nil {
		return nil, nil, err
	}
	if forms, err = keep("/form", opencodeFormIDRe); err != nil {
		return nil, nil, err
	}
	return permissions, forms, nil
}

// opencodeMessage is the part of a message the Chat view reads. content,
// files and the tool states are decoded loosely: OpenCode may add fields or
// kinds within 2.x, and an unknown kind is skipped.
type opencodeMessage struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	Time struct {
		Created   float64 `json:"created"`
		Completed float64 `json:"completed"`
	} `json:"time"`
	Text    string            `json:"text"`
	Files   []opencodeFile    `json:"files"`
	Content []opencodeContent `json:"content"`
	// Compaction: its status and summary; shell: its status, command and
	// output; skill: its name.
	Status  string `json:"status"`
	Summary string `json:"summary"`
	Command string `json:"command"`
	Name    string `json:"name"`
	Output  *struct {
		Output string `json:"output"`
	} `json:"output"`
	// Idle: how the turn ended, and the error a failed one ended on (its
	// message only: the provider's raw response body is never read).
	Outcome string `json:"outcome"`
	Error   *struct {
		Message string `json:"message"`
	} `json:"error"`
	// Assistant, still open: the provider refused and OpenCode tries
	// again (a rate limit); the same: only the error's message is read.
	Retry *struct {
		Attempt int `json:"attempt"`
		Error   *struct {
			Message string `json:"message"`
		} `json:"error"`
	} `json:"retry"`
	// Assistant: the model it ran on and the tokens of its request.
	Model struct {
		ID         string `json:"id"`
		ProviderID string `json:"providerID"`
	} `json:"model"`
	Tokens *opencodeTokens `json:"tokens"`
}

// opencodeTokens is a request's tokens, as OpenCode records them.
type opencodeTokens struct {
	Input     int64 `json:"input"`
	Output    int64 `json:"output"`
	Reasoning int64 `json:"reasoning"`
	Cache     struct {
		Read  int64 `json:"read"`
		Write int64 `json:"write"`
	} `json:"cache"`
}

// total is every token of the request, the context it filled as OpenCode
// counts it (TokenUsage's sum in 2.3.0).
func (t opencodeTokens) total() int64 {
	return t.Input + t.Output + t.Reasoning + t.Cache.Read + t.Cache.Write
}

// opencodeFile is a file of a user message without its bytes: a list of
// messages is never asked for them. An image pasted into OpenCode is
// "inline", its base64 in the message itself.
type opencodeFile struct {
	Mime   string `json:"mime"`
	Name   string `json:"name"`
	Source struct {
		Type string `json:"type"`
	} `json:"source"`
}

type opencodeContent struct {
	Type  string `json:"type"`
	Text  string `json:"text"`
	ID    string `json:"id"`
	Name  string `json:"name"`
	State struct {
		Status  string         `json:"status"`
		Input   map[string]any `json:"input"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		Error json.RawMessage `json:"error"`
	} `json:"state"`
}

// opencodePage is one page of a session's messages, newest first, and the
// service's own cursor to the page of older ones ("" when this page reached
// the first message).
type opencodePage struct {
	messages []opencodeMessage
	older    string
}

// messages reads up to limit messages of session id, newest first, up to
// opencodeMessagesMax: the
// newest page when cursor is empty, else the page cursor names (a cursor
// the service gave, only ever passed back to it).
func (c *opencodeClient) messages(ctx context.Context, id, cursor string, limit int) (opencodePage, error) {
	if !isOpencodeSessionID(id) {
		return opencodePage{}, errOpencodeNotFound
	}
	q := url.Values{"limit": {strconv.Itoa(limit)}}
	if cursor != "" {
		q.Set("cursor", cursor)
	} else {
		q.Set("order", "desc")
	}
	return c.messagePage(ctx, id, q, limit, opencodeMessagesMax)
}

// opencodeBigReads bounds the reads of one message up to
// opencodeOneMessageMax that run at once (each holds its reply in memory).
var opencodeBigReads = make(chan struct{}, 2)

// oneMessage reads the one message of the page cursor names ("" for the
// newest), up to opencodeOneMessageMax: what a page of messages over
// opencodeMessagesMax shrinks to.
func (c *opencodeClient) oneMessage(ctx context.Context, id, cursor string) (opencodePage, error) {
	if !isOpencodeSessionID(id) {
		return opencodePage{}, errOpencodeNotFound
	}
	q := url.Values{"limit": {"1"}}
	if cursor != "" {
		q.Set("cursor", cursor)
	} else {
		q.Set("order", "desc")
	}
	select {
	case opencodeBigReads <- struct{}{}:
		defer func() { <-opencodeBigReads }()
	case <-ctx.Done():
		return opencodePage{}, fmt.Errorf("opencode message: %w", errors.Join(errOpencodeUnavailable, ctx.Err()))
	}
	return c.messagePage(ctx, id, q, 1, opencodeOneMessageMax)
}

// messagePage reads the page of session id's messages q asks for, up to
// max bytes.
func (c *opencodeClient) messagePage(ctx context.Context, id string, q url.Values, limit int, max int64) (opencodePage, error) {
	var res struct {
		Data   []opencodeMessage `json:"data"`
		Cursor struct {
			Next *string `json:"next"`
		} `json:"cursor"`
	}
	if err := c.get(ctx, "/api/session/"+id+"/message", q, max, &res); err != nil {
		return opencodePage{}, err
	}
	page := opencodePage{}
	for _, m := range res.Data {
		if opencodeMessageIDRe.MatchString(m.ID) {
			page.messages = append(page.messages, m)
		}
	}
	// The service gives a cursor to older messages even on the last page;
	// a page shorter than asked is the last.
	if len(res.Data) >= limit && res.Cursor.Next != nil && len(*res.Cursor.Next) <= 1024 {
		page.older = *res.Cursor.Next
	}
	return page, nil
}

// opencodeImageFile is a file of one user message with its bytes.
type opencodeImageFile struct {
	Mime   string `json:"mime"`
	Data   string `json:"data"`
	Source struct {
		Type string `json:"type"`
	} `json:"source"`
}

// messageFiles reads the files of message msg of session id (session.message.get),
// with their bytes: only the ones an image reference names are ever asked
// for. The service answers 404 for a message of another session.
func (c *opencodeClient) messageFiles(ctx context.Context, id, msg string) ([]opencodeImageFile, error) {
	if !isOpencodeSessionID(id) || !opencodeMessageIDRe.MatchString(msg) {
		return nil, errOpencodeNotFound
	}
	var res struct {
		Data struct {
			ID    string              `json:"id"`
			Type  string              `json:"type"`
			Files []opencodeImageFile `json:"files"`
		} `json:"data"`
	}
	if err := c.get(ctx, "/api/session/"+id+"/message/"+msg, nil, opencodeOneMessageMax, &res); err != nil {
		return nil, err
	}
	if res.Data.ID != msg || res.Data.Type != "user" {
		return nil, errOpencodeNotFound
	}
	return res.Data.Files, nil
}

// opencodeChild is the part of a subagent's session the tree reads.
type opencodeChild struct {
	ID       string `json:"id"`
	ParentID string `json:"parentID"`
	Agent    string `json:"agent"`
	Title    string `json:"title"`
	Outcome  string `json:"outcome"`
	Time     struct {
		Created float64 `json:"created"`
		Updated float64 `json:"updated"`
		Busy    float64 `json:"busy"`
		Idle    float64 `json:"idle"`
	} `json:"time"`
	// The files it touched name paths relative to its directory.
	Location struct {
		Directory string `json:"directory"`
	} `json:"location"`
	// The usage reads its own requests' tokens and cost.
	Tokens opencodeTokens `json:"tokens"`
	Cost   float64        `json:"cost"`
}

// opencodeModelRef names a model as OpenCode does: its provider and its id.
type opencodeModelRef struct {
	ID         string `json:"id"`
	ProviderID string `json:"providerID"`
}

// children lists the sessions whose parent is session id (the subagents it
// started), newest first, at most limit: the service lists only direct
// children (checked on OpenCode 2.3.0); more is true when it holds more.
func (c *opencodeClient) children(ctx context.Context, id string, limit int) (kids []opencodeChild, more bool, err error) {
	if !isOpencodeSessionID(id) {
		return nil, false, errOpencodeNotFound
	}
	q := url.Values{"parentID": {id}, "limit": {strconv.Itoa(limit + 1)}}
	var res struct {
		Data []opencodeChild `json:"data"`
	}
	if err := c.get(ctx, "/api/session", q, opencodeSmallMax, &res); err != nil {
		return nil, false, err
	}
	more = len(res.Data) > limit
	for _, s := range res.Data[:min(len(res.Data), limit)] {
		if s.ParentID == id && s.ID != id && isOpencodeSessionID(s.ID) {
			kids = append(kids, s)
		}
	}
	return kids, more, nil
}

// session reads session id (session.get).
func (c *opencodeClient) session(ctx context.Context, id string) (opencodeSessionInfo, error) {
	if !isOpencodeSessionID(id) {
		return opencodeSessionInfo{}, errOpencodeNotFound
	}
	var res struct {
		Data opencodeSessionInfo `json:"data"`
	}
	if err := c.get(ctx, "/api/session/"+id, nil, opencodeSmallMax, &res); err != nil {
		return opencodeSessionInfo{}, err
	}
	if res.Data.ID != id {
		return opencodeSessionInfo{}, errOpencodeNotFound
	}
	return res.Data, nil
}

// directory is the directory session id runs in, as the service records it.
func (c *opencodeClient) directory(ctx context.Context, id string) (string, error) {
	s, err := c.session(ctx, id)
	return s.Location.Directory, err
}

// opencodeModelsMax bounds the list of models: every model of every
// provider the user set up.
const opencodeModelsMax = 8 << 20

// modelWindows is the context window of each model the service offers in
// dir, keyed by provider and model id ("provider\x00id"). The list also
// holds every provider's settings, its API key among them: only the
// provider, the id and the window are decoded, and the body is never kept,
// logged or returned.
func (c *opencodeClient) modelWindows(ctx context.Context, dir string) (map[string]int64, error) {
	var q url.Values
	if dir != "" {
		q = url.Values{"location[directory]": {dir}}
	}
	var res struct {
		Data []struct {
			ID         string `json:"id"`
			ProviderID string `json:"providerID"`
			Limit      struct {
				Context int64 `json:"context"`
			} `json:"limit"`
		} `json:"data"`
	}
	if err := c.get(ctx, "/api/model", q, opencodeModelsMax, &res); err != nil {
		return nil, err
	}
	out := make(map[string]int64, len(res.Data))
	for _, m := range res.Data {
		if m.ID != "" && m.ProviderID != "" && m.Limit.Context > 0 {
			out[m.ProviderID+"\x00"+m.ID] = m.Limit.Context
		}
	}
	return out, nil
}

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// zellijBin is the zellij executable; tests replace it with a script.
var zellijBin = "zellij"

// zellijMinVersion is the oldest Zellij the backend drives: 0.45.0 has
// --no-focus, per-client tabs, --pane-id/--tab-id on actions and the JSON
// listings.
var zellijMinVersion = [3]int{0, 45, 0}

// zellijContractDir is the socket subdirectory of the client/server contract
// the supported Zellij releases speak (0.44 onward).
const zellijContractDir = "contract_version_1"

// zellijDefaultSession is the session the snapshot creates when none is
// running, as tmux's TMUX_SESSION.
const zellijDefaultSession = "main"

// zellijQueryAttempts bounds the retries of a listing that printed nothing:
// Zellij sometimes answers a query with no output and exit 0 (upstream
// #5382).
const (
	zellijQueryAttempts = 6
	zellijQueryBackoff  = 50 * time.Millisecond // grows by itself each attempt
)

// zellijNoSessions is what `ls` prints, with exit 1, when no session runs.
const zellijNoSessions = "No active zellij sessions found."

// zellijNoSession is what an action prints, with exit 1, for a session that
// is not running.
const zellijNoSession = "There is no active session!"

// errZellijWindows refuses the Zellij backend on Windows, natively; the
// container runs it on any host.
var errZellijWindows = errors.New("zellij is not supported on Windows by termote yet; use --mux tmux (psmux) or herdr, or termote container up --mux zellij")

// errZellijNoSession: the session named is not running (or is EXITED).
var errZellijNoSession = errors.New("zellij session not running")

// errZellijEmpty: a listing printed nothing on every attempt.
var errZellijEmpty = errors.New("zellij printed nothing")

// zellijEnv is the environment of every zellij command: terminalEnv, which
// keeps ZELLIJ_SOCKET_DIR, XDG_RUNTIME_DIR and TMPDIR (where the CLI finds
// the sessions) and drops a pane's identity, so a server started inside a
// Zellij pane does not act as that pane.
func zellijEnv() []string { return terminalEnv() }

// zellijCmd runs zellij with args, never through a shell.
func zellijCmd(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, zellijBin, args...)
	cmd.Env = zellijEnv()
	cmd.WaitDelay = time.Second
	return cmd
}

// zellijActionArgs is `--session <s> action <args...>`. The session name
// comes before `action`, never after a `--`: it was checked by
// zellijPassableName.
func zellijActionArgs(session string, args ...string) []string {
	return append([]string{"--session", session, "action"}, args...)
}

// zellijGate keeps Termote's zellij commands out of the moment one of its
// clients connects. Every zellij command connects to a session server as a
// client of its own and takes the lowest free client id; when it exits,
// Zellij 0.45 removes that id twice (route.rs: on ClientExited and again as
// the route thread ends), so a client that connected in between, and got
// the same id, is removed in its place ("lost connection"). Commands hold
// the read side; attaching a client holds the write side until the client
// has drawn its first screen.
var zellijGate sync.RWMutex

// zellijRun runs a zellij command and returns its stdout. Its stderr is
// logged, never returned: it can hold paths. A session that is not running
// is errZellijNoSession.
func zellijRun(ctx context.Context, args ...string) ([]byte, error) {
	cmd := zellijCmd(ctx, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := runZellijGated(cmd)
	if errors.Is(err, errZellijSocketDir) {
		return nil, err
	}
	if err != nil {
		msg := strings.TrimSpace(stderr.String() + " " + stdout.String())
		if strings.Contains(msg, zellijNoSession) {
			return nil, errZellijNoSession
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// A focus on the pane already focused is an answer, not a failure.
		if !strings.Contains(msg, "is already focused") {
			log.Printf("zellij %s: %v: %s", zellijArgSummary(args), err, capBytes(msg, 512))
		}
		return nil, &zellijCmdError{cmd: zellijArgSummary(args), err: err, msg: msg}
	}
	return stdout.Bytes(), nil
}

// zellijCmdError is a zellij command that failed. msg is its output, for
// the callers that tell one failure from another; it is never sent to a
// client.
type zellijCmdError struct {
	cmd string
	err error
	msg string
}

func (e *zellijCmdError) Error() string { return "zellij " + e.cmd + ": " + e.err.Error() }
func (e *zellijCmdError) Unwrap() error { return e.err }

// zellijFailedWith reports whether err is a zellij command whose output
// holds text.
func zellijFailedWith(err error, text string) bool {
	var ce *zellijCmdError
	return errors.As(err, &ce) && strings.Contains(ce.msg, text)
}

// errZellijSocketDir refuses every zellij command while the socket dir
// could be another user's (zellijCheckSocketDir); the reason is logged.
var errZellijSocketDir = &codedError{code: "zellij_socket_dir",
	msg: "the zellij socket directory is not private to this user", status: 503}

// zellijFinal reports whether err is a failure a retry cannot change.
func zellijFinal(err error) bool {
	return errors.Is(err, errZellijNotListed) || errors.Is(err, errZellijSocketDir)
}

// runZellijGated runs cmd under the read side of zellijGate, once the
// socket dir is checked.
func runZellijGated(cmd *exec.Cmd) error {
	if err := zellijCheckSocketDir(); err != nil {
		return err
	}
	zellijGate.RLock()
	defer zellijGate.RUnlock()
	return cmd.Run()
}

// zellijArgSummary names a command for a log line: the subcommand and the
// action, never a name or a value.
func zellijArgSummary(args []string) string {
	for i, a := range args {
		if a == "action" && i+1 < len(args) {
			return "action " + args[i+1]
		}
	}
	if len(args) > 0 {
		return args[0]
	}
	return ""
}

// zellijAction runs one action on a session. Termote's actions on one
// session run one at a time: two at once can swap their outputs (see
// zellijGate).
func zellijAction(ctx context.Context, session string, args ...string) ([]byte, error) {
	if err := zellijRequireListed(ctx, session); err != nil {
		return nil, err
	}
	mu := zellijSessionLock(session)
	mu.Lock()
	defer mu.Unlock()
	return zellijRun(ctx, zellijActionArgs(session, args...)...)
}

// zellijSessionLocks holds a lock for each session a listing found, so a
// name nobody runs, from a client's id, never adds one.
var zellijSessionLocks sync.Map // session name → *sync.Mutex

// zellijListed is the running sessions the last listing found.
var zellijListed struct {
	sync.Mutex
	names map[string]struct{}
}

// errZellijNotListed: the session is not in a listing taken now. It is
// errZellijNoSession for the callers, and never retried.
var errZellijNotListed = fmt.Errorf("%w: not listed", errZellijNoSession)

// zellijRememberListed keeps the running sessions of a listing.
func zellijRememberListed(list []zellijSession) {
	names := make(map[string]struct{}, len(list))
	for _, s := range list {
		if !s.exited {
			names[s.name] = struct{}{}
		}
	}
	zellijListed.Lock()
	zellijListed.names = names
	zellijListed.Unlock()
}

// zellijRequireListed fails unless session runs: known from the last
// listing, else found by listing the sessions again (one started since).
// The new listing itself decides: another one, read earlier, may have
// replaced the remembered names since.
func zellijRequireListed(ctx context.Context, session string) error {
	if zellijIsListed(session) {
		return nil
	}
	list, err := zellijListSessions(ctx)
	if err != nil {
		return err
	}
	if slices.ContainsFunc(list, func(s zellijSession) bool { return s.name == session && !s.exited }) {
		return nil
	}
	return errZellijNotListed
}

// zellijWaitListed waits until a listing shows session, as one `attach -b`
// just started may not be listed at once.
func zellijWaitListed(ctx context.Context, session string) error {
	for i := 0; ; i++ {
		err := zellijRequireListed(ctx, session)
		if !errors.Is(err, errZellijNotListed) || i+1 >= zellijQueryAttempts {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(i+1) * zellijQueryBackoff):
		}
	}
}

// zellijIsListed reports whether the last listing found session running.
func zellijIsListed(session string) bool {
	zellijListed.Lock()
	defer zellijListed.Unlock()
	_, ok := zellijListed.names[session]
	return ok
}

func zellijSessionLock(session string) *sync.Mutex {
	mu, _ := zellijSessionLocks.LoadOrStore(session, &sync.Mutex{})
	return mu.(*sync.Mutex)
}

// zellijQuery runs a listing action and retries any failure or an answer
// that valid refuses. A command is removed from the server now and then as
// it runs (zellijGate: another command's id removal), so it prints nothing,
// fails, says the session is not running, or gets the output of the command
// before it (a tab id where a listing was expected). After the last attempt
// it is an error, never an empty or foreign listing.
func zellijQuery(ctx context.Context, session string, valid func([]byte) bool, args ...string) ([]byte, error) {
	for i := 0; ; i++ {
		out, err := zellijAction(ctx, session, args...)
		switch {
		case err == nil && len(bytes.TrimSpace(out)) > 0 && valid(out):
			return out, nil
		case err != nil && (ctx.Err() != nil || i+1 >= zellijQueryAttempts || zellijFinal(err)):
			return nil, err
		case i+1 >= zellijQueryAttempts:
			return nil, errZellijEmpty
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(i+1) * zellijQueryBackoff):
		}
	}
}

// zellijRepeat runs an action that is harmless to run twice (a rename, a
// focus, closing a pane by an id Zellij never reuses) and runs it again when
// it fails: a command can be removed from the server before it acted
// (zellijGate). "already focused" ends it as done.
func zellijRepeat(ctx context.Context, session string, args ...string) error {
	var err error
	for i := 0; i < zellijQueryAttempts; i++ {
		if _, err = zellijAction(ctx, session, args...); err == nil || zellijFailedWith(err, "is already focused") {
			return nil
		}
		if ctx.Err() != nil || zellijFinal(err) || errors.Is(err, errZellijNoSession) && i > 1 {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(i+1) * zellijQueryBackoff):
		}
	}
	return err
}

// zellijJSONList returns a validator accepting a non-empty JSON array of
// objects whose first holds every key: a listing of another kind (tabs for
// panes) is refused.
func zellijJSONList(keys ...string) func([]byte) bool {
	return func(out []byte) bool {
		var list []map[string]json.RawMessage
		if json.Unmarshal(out, &list) != nil || len(list) == 0 {
			return false
		}
		for _, k := range keys {
			if _, ok := list[0][k]; !ok {
				return false
			}
		}
		return true
	}
}

// Validators of the two listings.
var (
	zellijTabsList  = zellijJSONList("tab_id", "position")
	zellijPanesList = zellijJSONList("id", "is_plugin", "tab_id")
)

// zellijAnyOutput accepts any non-empty output.
func zellijAnyOutput([]byte) bool { return true }

// zellijReserved are `attach` subcommand names: `zellij attach help` prints
// help instead of attaching. Refused in any case.
var zellijReserved = []string{"help", "options"}

// zellijPassableName reports whether an existing session's name can be
// passed to zellij safely: not empty, no leading '-' (clap would read it as
// a flag, and after `--` it starts a command), not a reserved word, no
// control, format or line-break character (a listing line would break), no
// '/' and not '.' or '..' (zellij joins the name to its socket dir, and
// refuses a '/' itself), and short enough for the socket path. A name taken
// from a client's id is held to the same rule as one Termote creates.
func zellijPassableName(name string) bool {
	if name == "" || strings.HasPrefix(name, "-") || !utf8.ValidString(name) ||
		strings.Contains(name, "/") || name == "." || name == ".." || len(name) > zellijMaxNameLen() {
		return false
	}
	for _, r := range zellijReserved {
		if strings.EqualFold(name, r) {
			return false
		}
	}
	for _, r := range name {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || r == ' ' || r == ' ' {
			return false
		}
	}
	return true
}

// validZellijName accepts a name Termote creates or renames a session to:
// passable and no trailing ';'.
func validZellijName(name string) bool {
	return zellijPassableName(name) && !strings.HasSuffix(name, ";")
}

// validZellijTabName accepts a tab name: Zellij stores names verbatim, so
// control and format characters are refused here; it goes after `--` or in
// a `-n=` value, so a leading '-' is harmless.
func validZellijTabName(name string) bool {
	if name == "" || len(name) > 64 || !utf8.ValidString(name) || strings.HasSuffix(name, ";") {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return false
		}
	}
	return true
}

// zellijSunPath is sockaddr_un.sun_path's size: 104 on macOS, 108 on Linux.
func zellijSunPath() int {
	if runtime.GOOS == "darwin" {
		return 104
	}
	return 108
}

// zellijMaxNameLen is the longest session name whose socket path fits in
// sun_path (with its terminating NUL), as zellij checks it.
func zellijMaxNameLen() int {
	n := zellijSunPath() - 1 - len(filepath.Join(zellijSocketDir(), zellijContractDir)+"/")
	return max(n, 0)
}

// zellijSocketDir is where zellij keeps its sockets, resolved as zellij
// does: ZELLIJ_SOCKET_DIR, else $XDG_RUNTIME_DIR/zellij (Linux), else
// $TMPDIR/zellij-<uid>. The contract subdirectory is not included.
func zellijSocketDir() string {
	if d := os.Getenv("ZELLIJ_SOCKET_DIR"); d != "" {
		return d
	}
	if runtime.GOOS == "linux" {
		if d := os.Getenv("XDG_RUNTIME_DIR"); d != "" && filepath.IsAbs(d) {
			return filepath.Join(d, "zellij")
		}
	}
	return filepath.Join(os.TempDir(), "zellij-"+strconv.Itoa(os.Getuid()))
}

// zellijOtherContracts reports whether sessions run under another contract
// directory than the one this backend speaks: a Zellij upgraded under
// running sessions, which the CLI can no longer reach correctly.
func zellijOtherContracts() bool {
	dirs, _ := filepath.Glob(filepath.Join(zellijSocketDir(), "contract_version_*"))
	for _, d := range dirs {
		if filepath.Base(d) == zellijContractDir {
			continue
		}
		entries, err := os.ReadDir(d)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.Type()&os.ModeSocket != 0 {
				return true
			}
		}
	}
	return false
}

// errZellijVersionMismatch refuses to create anything while sessions of
// another Zellij contract run.
var errZellijVersionMismatch = &codedError{code: "zellij_version_mismatch",
	msg:    "zellij was upgraded while sessions were running: restart your Zellij sessions or Termote",
	status: 503}

// Ids. A group is "z" + the session name in unpadded base64url (a name
// zellijPassableName accepts; any other id is refused); a tab is <group>:t<tab_id> and a pane
// <group>:p<N> for terminal_N, so the two never collide, and none starts
// with '-'.

func zellijGroupID(session string) string {
	return "z" + base64.RawURLEncoding.EncodeToString([]byte(session))
}

func parseZellijGroupID(id string) (string, bool) {
	rest, ok := strings.CutPrefix(id, "z")
	if !ok || rest == "" {
		return "", false
	}
	b, err := base64.RawURLEncoding.DecodeString(rest)
	if err != nil || !zellijPassableName(string(b)) {
		return "", false
	}
	return string(b), true
}

func zellijTabID(session string, tab int) string {
	return zellijGroupID(session) + ":t" + strconv.Itoa(tab)
}

func zellijPaneID(session string, n int) string {
	return zellijGroupID(session) + ":p" + strconv.Itoa(n)
}

// zellijNumRe is a decimal Zellij id: no sign, no leading zero, int32.
var zellijNumRe = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})$`)

func parseZellijChildID(id, kind string) (string, int, bool) {
	gid, num, ok := strings.Cut(id, ":"+kind)
	if !ok || !zellijNumRe.MatchString(num) {
		return "", 0, false
	}
	session, ok := parseZellijGroupID(gid)
	if !ok {
		return "", 0, false
	}
	n, _ := strconv.Atoi(num)
	return session, n, true
}

// parseZellijTabID returns the session and Zellij tab id of a tab id.
func parseZellijTabID(id string) (string, int, bool) { return parseZellijChildID(id, "t") }

// parseZellijPaneID returns the session and N of terminal_N of a pane id.
func parseZellijPaneID(id string) (string, int, bool) { return parseZellijChildID(id, "p") }

// zellijPaneKey names a pane on the server, for state kept by pane (the
// files routes, the push watcher): the session's group id and terminal_N.
func zellijPaneKey(session string, n int) string {
	return zellijGroupID(session) + "/terminal_" + strconv.Itoa(n)
}

// zellijTerminal is a pane's id as Zellij takes it.
func zellijTerminal(n int) string { return "terminal_" + strconv.Itoa(n) }

// Version. `zellij --version` is cached with what identifies the binary
// (its resolved path, size and mtime) and read again when any changes,
// checked at most every zellijVersionCheck.

const zellijVersionCheck = 30 * time.Second

type zellijBinKey struct {
	path  string
	size  int64
	mtime time.Time
}

var zellijVersion struct {
	sync.Mutex
	key     zellijBinKey
	checked time.Time
	version [3]int
	ok      bool
}

// resetZellijVersion forgets the cached version (tests).
func resetZellijVersion() {
	zellijVersion.Lock()
	defer zellijVersion.Unlock()
	zellijVersion.key, zellijVersion.checked, zellijVersion.ok = zellijBinKey{}, time.Time{}, false
}

func zellijBinary() (zellijBinKey, error) {
	p, err := exec.LookPath(zellijBin)
	if err != nil {
		return zellijBinKey{}, err
	}
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	fi, err := os.Stat(p)
	if err != nil {
		return zellijBinKey{}, err
	}
	return zellijBinKey{path: p, size: fi.Size(), mtime: fi.ModTime()}, nil
}

var zellijVersionRe = regexp.MustCompile(`^zellij ([0-9]{1,4})\.([0-9]{1,4})\.([0-9]{1,4})`)

func parseZellijVersion(s string) ([3]int, bool) {
	m := zellijVersionRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return [3]int{}, false
	}
	var v [3]int
	for i := range v {
		v[i], _ = strconv.Atoi(m[i+1])
	}
	return v, true
}

func versionAtLeast(v, min [3]int) bool {
	for i := range v {
		if v[i] != min[i] {
			return v[i] > min[i]
		}
	}
	return true
}

// zellijCheckVersion returns the installed Zellij's version, or an error when
// it is missing or older than zellijMinVersion.
func zellijCheckVersion(ctx context.Context) ([3]int, error) {
	zellijVersion.Lock()
	defer zellijVersion.Unlock()
	now := time.Now()
	if zellijVersion.ok && now.Sub(zellijVersion.checked) < zellijVersionCheck {
		return zellijVersion.version, nil
	}
	key, err := zellijBinary()
	if err != nil {
		zellijVersion.ok = false
		return [3]int{}, fmt.Errorf("zellij not found: %w", err)
	}
	if zellijVersion.ok && key == zellijVersion.key {
		zellijVersion.checked = now
		return zellijVersion.version, nil
	}
	out, err := zellijRun(ctx, "--version")
	if err != nil {
		zellijVersion.ok = false
		return [3]int{}, err
	}
	v, ok := parseZellijVersion(string(out))
	if !ok {
		zellijVersion.ok = false
		return [3]int{}, fmt.Errorf("unrecognised zellij version %q", capBytes(strings.TrimSpace(string(out)), 64))
	}
	if !versionAtLeast(v, zellijMinVersion) {
		zellijVersion.ok = false
		return v, fmt.Errorf("zellij %d.%d.%d is too old: termote needs %d.%d.%d or later",
			v[0], v[1], v[2], zellijMinVersion[0], zellijMinVersion[1], zellijMinVersion[2])
	}
	zellijVersion.key, zellijVersion.checked, zellijVersion.version, zellijVersion.ok = key, now, v, true
	return v, nil
}

// zellijSession is one line of `zellij ls -n`.
type zellijSession struct {
	name   string
	exited bool
}

// zellijCreatedRe is the end of an `ls -n` line after the name.
var zellijCreatedRe = regexp.MustCompile(`^ \[Created [^\]]*\] ?(\(current\) ?)?(\(EXITED - attach to resurrect\))? *$`)

// parseZellijSessions reads `zellij ls -n`: one session a line, the name
// then ` [Created … ago]`, and `(EXITED - attach to resurrect)` for a session
// kept only for resurrection. A name can hold spaces and brackets, so it ends
// at the last " [Created ". A line that does not parse is dropped.
func parseZellijSessions(out string) []zellijSession {
	var list []zellijSession
	for line := range strings.SplitSeq(out, "\n") {
		line = strings.TrimRight(line, "\r")
		i := strings.LastIndex(line, " [Created ")
		if i <= 0 {
			continue
		}
		m := zellijCreatedRe.FindStringSubmatch(line[i:])
		if m == nil {
			continue
		}
		list = append(list, zellijSession{name: line[:i], exited: m[2] != ""})
	}
	return list
}

// zellijListSessions runs `zellij ls -n`. No session is an empty list, not an
// error.
func zellijListSessions(ctx context.Context) ([]zellijSession, error) {
	cmd := zellijCmd(ctx, "list-sessions", "--no-formatting")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := runZellijGated(cmd)
	if errors.Is(err, errZellijSocketDir) {
		return nil, err
	}
	if strings.Contains(stdout.String()+stderr.String(), zellijNoSessions) {
		zellijRememberListed(nil)
		return nil, nil
	}
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		log.Printf("zellij list-sessions: %v: %s", err, capBytes(strings.TrimSpace(stderr.String()), 512))
		return nil, fmt.Errorf("zellij list-sessions: %w", err)
	}
	list := parseZellijSessions(stdout.String())
	zellijRememberListed(list)
	return list, nil
}

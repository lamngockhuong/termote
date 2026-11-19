package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode"
)

// Writing to an OpenCode pane goes through the service's API, never into the
// pane's keys: a message is a prompt, an answer a permission or form reply.
// The session written to is the one the server found for the pane right
// before the write (sessionNow), never an id from the client; a permission
// or form is answered only while the session's own list still holds it.

const (
	// opencodeWriteTimeout bounds one write to the service: a message may
	// carry several images.
	opencodeWriteTimeout = 15 * time.Second
	// opencodeMaxFields and opencodeMaxOptions bound a form the card shows;
	// a bigger one is answered in the terminal.
	opencodeMaxFields  = 32
	opencodeMaxOptions = 64
	// opencodeMaxCardText bounds a permission's resources on the card.
	opencodeMaxCardText = 4 * 1024
	// opencodeMaxLabel bounds a title, label or description on the card.
	opencodeMaxLabel = 1024
	// opencodeImageMax bounds an image read from the uploads.
	opencodeImageMax = 10 << 20
)

var (
	// errOpencodeRefused: the service answered 400 (an answer it found
	// invalid).
	errOpencodeRefused = errors.New("opencode: refused")
	// errOpencodeSettled: the service answered 409 (a form already
	// answered or cancelled).
	errOpencodeSettled = errors.New("opencode: already settled")
	// errOpencodeNoReply: the service could not be reached for a write, or
	// failed it; the client is told without the service's words.
	errOpencodeNoReply = fail(http.StatusBadGateway, "agent_unavailable", "the agent's service did not answer")
)

// send makes a write request with body as JSON (none when nil); the reply's
// body is never read into an error.
func (c *opencodeClient) send(ctx context.Context, method, path string, body any) error {
	return c.write(ctx, method, path, body, nil)
}

// write makes a write request as send does and, when out is not nil,
// decodes a successful reply into it (read up to opencodeSmallMax).
func (c *opencodeClient) write(ctx context.Context, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(data)
	}
	u := *c.base
	u.Path = path
	req, err := http.NewRequestWithContext(ctx, method, u.String(), rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", c.auth)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		opencodeForgetIfDial(err)
		return fmt.Errorf("opencode %s %s: %w", method, path, errors.Join(errOpencodeUnavailable, err))
	}
	defer resp.Body.Close()
	if out != nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		data, err := io.ReadAll(io.LimitReader(resp.Body, opencodeSmallMax+1))
		if err != nil || len(data) > opencodeSmallMax || json.Unmarshal(data, out) != nil {
			return fmt.Errorf("opencode %s %s: decode reply", method, path)
		}
		return nil
	}
	// A message's reply repeats its images: drained only a little, so the
	// connection may be reused for a small one.
	io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	switch s := resp.StatusCode; {
	case s >= 200 && s < 300:
		return nil
	case s == http.StatusUnauthorized || s == http.StatusForbidden:
		opencodeForget()
		return fmt.Errorf("opencode %s %s: status %d: %w", method, path, s, errOpencodeUnavailable)
	case s == http.StatusNotFound:
		return fmt.Errorf("opencode %s %s: %w", method, path, errOpencodeNotFound)
	case s == http.StatusConflict:
		return fmt.Errorf("opencode %s %s: %w", method, path, errOpencodeSettled)
	case s == http.StatusBadRequest:
		return fmt.Errorf("opencode %s %s: %w", method, path, errOpencodeRefused)
	default:
		return fmt.Errorf("opencode %s %s: status %d", method, path, s)
	}
}

// opencodeAttachment is an image of a message, inline as a data: URI.
type opencodeAttachment struct {
	URI  string `json:"uri"`
	Name string `json:"name,omitempty"`
}

// prompt sends a message to session id. "queue" is asked for, as Claude Code
// on termote does: OpenCode's own default ("steer") would put it into the
// turn running now.
func (c *opencodeClient) prompt(ctx context.Context, id, text string, files []opencodeAttachment, skills []opencodeSkillAttachment) error {
	if !isOpencodeSessionID(id) {
		return errOpencodeNotFound
	}
	body := map[string]any{"text": text, "delivery": "queue"}
	if len(files) > 0 {
		body["files"] = files
	}
	if len(skills) > 0 {
		body["skills"] = skills
	}
	return c.send(ctx, http.MethodPost, "/api/session/"+id+"/prompt", body)
}

// permissionReply answers permission per of session id: once, always or
// reject.
func (c *opencodeClient) permissionReply(ctx context.Context, id, per, decision string) error {
	if !isOpencodeSessionID(id) || !opencodePermissionIDRe.MatchString(per) {
		return errOpencodeNotFound
	}
	return c.send(ctx, http.MethodPost, "/api/session/"+id+"/permission/"+per+"/reply",
		map[string]any{"decision": decision})
}

// formReply answers form frm of session id; nil answer cancels it.
func (c *opencodeClient) formReply(ctx context.Context, id, frm string, answer map[string]any) error {
	if !isOpencodeSessionID(id) || !opencodeFormIDRe.MatchString(frm) {
		return errOpencodeNotFound
	}
	path := "/api/session/" + id + "/form/" + frm
	if answer == nil {
		return c.send(ctx, http.MethodDelete, path, nil)
	}
	return c.send(ctx, http.MethodPost, path+"/reply", map[string]any{"answer": answer})
}

// busySince is when session id's running turn started (zero when it runs
// none).
func (c *opencodeClient) busySince(ctx context.Context, id string) (time.Time, error) {
	if !isOpencodeSessionID(id) {
		return time.Time{}, errOpencodeNotFound
	}
	var res struct {
		Data struct {
			Time struct {
				Busy float64 `json:"busy"`
			} `json:"time"`
		} `json:"data"`
	}
	if err := c.get(ctx, "/api/session/"+id, nil, opencodeSmallMax, &res); err != nil {
		return time.Time{}, err
	}
	if res.Data.Time.Busy <= 0 {
		return time.Time{}, nil
	}
	return time.UnixMilli(int64(res.Data.Time.Busy)), nil
}

// sendOpencode sends a message to s, the pane's session read right before:
// its text and the images at paths (the server's own uploads). A "/name"
// before any image runs that command and an "@name" attaches that skill,
// when the session's lists, read now, hold them. A message to a session
// running a turn waits in OpenCode's queue: errQueued.
func (a *agentAPI) sendOpencode(ctx context.Context, s AgentSession, parts, paths []string) error {
	text := opencodeJoinParts(parts)
	// The text before the first image, as the join left it (its white
	// space at the image gone), so it still starts text exactly.
	lead := parts[0]
	if len(parts) > 1 {
		lead = strings.TrimRightFunc(lead, unicode.IsSpace)
	}
	var files []opencodeAttachment
	for _, p := range paths {
		f, err := opencodeImage(p)
		if err != nil {
			log.Printf("opencode message: image: %v", err)
			return fail(http.StatusBadRequest, "invalid_request", "an image could not be read")
		}
		files = append(files, f)
	}
	c, err := opencodeConnect()
	if err != nil {
		return errOpencodeNoReply
	}
	ctx, cancel := context.WithTimeout(ctx, opencodeWriteTimeout)
	defer cancel()
	plan, err := planOpencodeSend(ctx, c, s.ID, lead, text)
	if err == nil {
		err = sendOpencodePlan(ctx, c, s.ID, plan, files)
	}
	switch {
	case err == errOpencodeNoReply:
		return err // logged already
	case errors.Is(err, errOpencodeNotFound):
		// A session named with --session is made with the TUI's first
		// message: none to send to yet.
		return fail(http.StatusConflict, "input_not_ready", "send the first message in the terminal")
	case errors.Is(err, errOpencodeRefused):
		// Sending it again would not help.
		return fail(http.StatusBadRequest, "invalid_request", "the agent refused this message")
	case err != nil:
		log.Printf("opencode message: %v", err)
		return errOpencodeNoReply
	}
	opencodeActive.forgetPrefix("")
	if s.Status == "working" || s.Status == "blocked" {
		return errQueued
	}
	return nil
}

// opencodeJoinParts is a message's text without its images: OpenCode takes
// them as files, not in the text. The composer keeps a space beside each
// image's place (its "[Image #n] " token, which Claude Code and Codex paste
// the image at); where an image was, the white space on both sides is one
// space between words (a line break when it held one, a blank line when
// it held two), and none at the start or the end of the text.
func opencodeJoinParts(parts []string) string {
	var b strings.Builder
	// breaks: the most line breaks one run of white space between the
	// last word and the next held.
	breaks := 0
	for i, p := range parts {
		if i > 0 {
			trimmed := strings.TrimLeftFunc(p, unicode.IsSpace)
			breaks = max(breaks, strings.Count(p[:len(p)-len(trimmed)], "\n"))
			p = trimmed
		}
		trail := 0
		if i < len(parts)-1 {
			trimmed := strings.TrimRightFunc(p, unicode.IsSpace)
			trail = strings.Count(p[len(trimmed):], "\n")
			p = trimmed
		}
		if p != "" {
			if b.Len() > 0 {
				switch {
				case breaks > 1:
					b.WriteString("\n\n")
				case breaks == 1:
					b.WriteByte('\n')
				default:
					b.WriteByte(' ')
				}
			}
			b.WriteString(p)
			breaks = 0
		}
		breaks = max(breaks, trail)
	}
	return b.String()
}

// opencodeImage reads an upload as a data: URI. path comes from the upload
// store (imagePaths), never from the client; its type from its extension,
// which the store gave it from the image's own bytes.
func opencodeImage(path string) (opencodeAttachment, error) {
	ext := strings.TrimPrefix(filepath.Ext(path), ".")
	mime := ""
	for mt, e := range uploadExts {
		if e == ext {
			mime = mt
		}
	}
	if mime == "" {
		return opencodeAttachment{}, fmt.Errorf("unknown type %q", ext)
	}
	f, err := os.Open(path)
	if err != nil {
		return opencodeAttachment{}, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, opencodeImageMax+1))
	if err != nil {
		return opencodeAttachment{}, err
	}
	if len(data) > opencodeImageMax {
		return opencodeAttachment{}, errors.New("over the upload limit")
	}
	return opencodeAttachment{
		URI:  "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data),
		Name: "image." + ext,
	}, nil
}

// opencodeRead is what the prompt route answers for an OpenCode session: the
// first permission or form it waits on as a card (with sig, its request's
// id), and the working line while it runs a turn.
type opencodeRead struct {
	prompt   *AgentPrompt
	sig      string
	activity *AgentActivity
}

// opencodeReads shares one read of a session between every client polling it.
var opencodeReads = newTTLCache[opencodeRead](agentCacheTTL)

// readOpencodePrompt reads session s's pending requests and working line.
func readOpencodePrompt(s AgentSession) (opencodeRead, error) {
	return opencodeReads.do(s.ID, func() (opencodeRead, error) {
		c, err := opencodeConnect()
		if err != nil {
			return opencodeRead{}, nil
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*opencodeTimeout)
		defer cancel()
		perms, forms, err := c.pending(ctx, s.ID)
		if errors.Is(err, errOpencodeNotFound) {
			return opencodeRead{}, nil // no message yet
		}
		if err != nil {
			return opencodeRead{}, err
		}
		switch {
		case len(perms) > 0:
			p := opencodePermissionCard(perms[0])
			return opencodeRead{prompt: &p, sig: "per:" + perms[0].ID}, nil
		case len(forms) > 0:
			p := opencodeFormCard(forms[0])
			return opencodeRead{prompt: &p, sig: "frm:" + forms[0].ID}, nil
		}
		if s.Status != "working" {
			return opencodeRead{}, nil
		}
		return opencodeRead{activity: opencodeActivity(ctx, c, s.ID)}, nil
	})
}

// opencodeActivity is the working line of a session running a turn: how
// long it has run, whether it thinks, and the provider error it retries
// after (its message only).
func opencodeActivity(ctx context.Context, c *opencodeClient, id string) *AgentActivity {
	act := &AgentActivity{}
	if busy, err := c.busySince(ctx, id); err == nil && !busy.IsZero() {
		act.Elapsed = max(0, int(time.Since(busy)/time.Second))
	} else if err != nil {
		log.Printf("opencode activity: %v", err)
	}
	page, err := c.messages(ctx, id, "", 1)
	if err != nil {
		log.Printf("opencode activity: %v", err)
		return act
	}
	if len(page.messages) == 0 {
		return act
	}
	m := page.messages[0]
	if m.Type != "assistant" || m.Time.Completed != 0 {
		return act
	}
	if m.Retry != nil && m.Retry.Attempt > 0 {
		act.Retry = &ActivityRetry{Attempt: m.Retry.Attempt}
		if m.Retry.Error != nil {
			act.Retry.Error, _ = clampText(oneLine(stripANSI(m.Retry.Error.Message)), activityMaxText)
		}
	} else if n := len(m.Content); n > 0 && m.Content[n-1].Type == "reasoning" {
		act.Phase = "thinking"
	}
	return act
}

// opencodeLabel is s on one line, cut to opencodeMaxLabel.
func opencodeLabel(s string) string {
	s, _ = clampText(strings.Join(strings.Fields(stripANSI(s)), " "), opencodeMaxLabel)
	return s
}

// opencodeText is s with its lines, cut to limit.
func opencodeText(s string, limit int) string {
	s, _ = clampText(stripANSI(s), limit)
	return s
}

// The options of a permission card, by the number the client answers with.
var opencodeDecisions = map[int]string{1: "once", 2: "always", 3: "reject"}

func opencodePermissionCard(p opencodePending) AgentPrompt {
	action := opencodeLabel(p.Action)
	title := "Allow " + action + "?"
	if action == "" {
		title = "Allow a tool?"
	}
	always := PromptOption{Index: 2, Label: "Yes, always"}
	if len(p.Save) > 0 {
		always.Detail = opencodeLabel(strings.Join(p.Save, ", "))
	}
	return AgentPrompt{
		Kind:   "permission",
		Title:  title,
		Action: action,
		Body:   opencodeText(strings.Join(p.Resources, "\n"), opencodeMaxCardText),
		Options: []PromptOption{
			{Index: 1, Label: "Yes, once"},
			always,
			{Index: 3, Label: "No"},
		},
		opencodeID: p.ID,
	}
}

// PromptField is one field of an OpenCode form: string (with options, and
// custom when other text is taken too), number, integer, boolean or
// multiselect. A field shows only while every condition of When holds.
type PromptField struct {
	Key         string        `json:"key"`
	Type        string        `json:"type"`
	Title       string        `json:"title,omitempty"`
	Description string        `json:"description,omitempty"`
	Required    bool          `json:"required,omitempty"`
	Format      string        `json:"format,omitempty"`
	Placeholder string        `json:"placeholder,omitempty"`
	Options     []FieldOption `json:"options,omitempty"`
	Custom      bool          `json:"custom,omitempty"`
	MinLength   *int          `json:"minLength,omitempty"`
	MaxLength   *int          `json:"maxLength,omitempty"`
	Minimum     *float64      `json:"minimum,omitempty"`
	Maximum     *float64      `json:"maximum,omitempty"`
	MinItems    *int          `json:"minItems,omitempty"`
	MaxItems    *int          `json:"maxItems,omitempty"`
	Default     any           `json:"default,omitempty"`
	When        []FieldWhen   `json:"when,omitempty"`
}

type FieldOption struct {
	Value  string `json:"value"`
	Label  string `json:"label"`
	Detail string `json:"detail,omitempty"`
}

// FieldWhen: the field shows when field Key's value is (eq) or is not (neq)
// Value.
type FieldWhen struct {
	Key   string `json:"key"`
	Op    string `json:"op"`
	Value any    `json:"value"`
}

var opencodeFieldTypes = []string{"string", "number", "integer", "boolean", "multiselect"}

// opencodeFormCard is a form as a card. One the card cannot take (a link to
// open, a field of an unknown kind, too many fields, an option or default
// no answer could send back, a condition on a field the card leaves out) is
// answered in the terminal: kind unsupported, its title only.
func opencodeFormCard(f opencodePending) AgentPrompt {
	p := AgentPrompt{Kind: "form", Title: opencodeLabel(f.Title), opencodeID: f.ID, opencodeForm: true}
	unsupported := func() AgentPrompt {
		return AgentPrompt{Kind: "unsupported", Title: p.Title, opencodeID: f.ID, opencodeForm: true}
	}
	if len(f.Fields) > opencodeMaxFields {
		return unsupported()
	}
	for _, in := range f.Fields {
		if in.Hidden {
			continue // OpenCode fills it itself
		}
		if !slices.Contains(opencodeFieldTypes, in.Type) || !opencodeFieldKey(in.Key) || len(in.Options) > opencodeMaxOptions {
			return unsupported()
		}
		out := PromptField{
			Key: in.Key, Type: in.Type, Title: opencodeLabel(in.Title),
			Description: opencodeText(in.Description, opencodeMaxLabel), Required: in.Required,
			Placeholder: opencodeLabel(in.Placeholder), Custom: in.Custom,
			MinLength: in.MinLength, MaxLength: in.MaxLength, MinItems: in.MinItems, MaxItems: in.MaxItems,
			Minimum: opencodeNumber(in.Minimum), Maximum: opencodeNumber(in.Maximum),
		}
		if slices.Contains([]string{"email", "uri", "date", "date-time"}, in.Format) {
			out.Format = in.Format
		}
		for _, o := range in.Options {
			if opencodeFieldText(o.Value) != nil {
				return unsupported()
			}
			out.Options = append(out.Options, FieldOption{Value: o.Value, Label: opencodeLabel(o.Label),
				Detail: opencodeLabel(o.Description)})
		}
		out.Default = opencodeDefault(in)
		// A default no answer could send back is none.
		if _, err := opencodeFieldValue(out, opencodeJSON(out.Default)); out.Default != nil && err != nil {
			out.Default = nil
		}
		for _, w := range in.When {
			var v any
			if (w.Op != "eq" && w.Op != "neq") || json.Unmarshal(w.Value, &v) != nil {
				return unsupported()
			}
			out.When = append(out.When, FieldWhen{Key: w.Key, Op: w.Op, Value: v})
		}
		p.Fields = append(p.Fields, out)
	}
	if len(p.Fields) == 0 {
		return unsupported()
	}
	for _, f := range p.Fields {
		for _, w := range f.When {
			if !slices.ContainsFunc(p.Fields, func(o PromptField) bool { return o.Key == w.Key }) {
				return unsupported()
			}
		}
	}
	return p
}

func opencodeJSON(v any) json.RawMessage {
	data, _ := json.Marshal(v)
	return data
}

// opencodeFieldKey: a key the card can name, sent back as it is.
// __proto__ is refused: the PWA keeps the answers in a plain object.
func opencodeFieldKey(k string) bool {
	return k != "" && k != "__proto__" && len(k) <= 128 && strings.IndexFunc(k, unicode.IsControl) < 0
}

// opencodeNumber is a bound: a finite number, else none ("Infinity").
func opencodeNumber(raw json.RawMessage) *float64 {
	var n float64
	if len(raw) == 0 || json.Unmarshal(raw, &n) != nil || math.IsInf(n, 0) || math.IsNaN(n) {
		return nil
	}
	return &n
}

// opencodeDefault is a field's default value, of the field's own type.
func opencodeDefault(f opencodeFormField) any {
	if len(f.Default) == 0 {
		return nil
	}
	switch f.Type {
	case "string":
		var s string
		if json.Unmarshal(f.Default, &s) == nil {
			return opencodeText(s, agentMaxFreeText)
		}
	case "number", "integer":
		if n := opencodeNumber(f.Default); n != nil {
			return *n
		}
	case "boolean":
		var b bool
		if json.Unmarshal(f.Default, &b) == nil {
			return b
		}
	case "multiselect":
		var l []string
		if json.Unmarshal(f.Default, &l) == nil {
			return l
		}
	}
	return nil
}

// opencodeChoice checks a client's answer to an OpenCode card: an option's
// number or "cancel" for a permission, {"answer": {...}} or "cancel" for a
// form. It returns the decision for a permission, or the form's answer (nil
// to cancel it).
func opencodeChoice(p AgentPrompt, choice json.RawMessage) (decision string, answer map[string]any, err error) {
	var name string
	if json.Unmarshal(choice, &name) == nil && name == "cancel" {
		if p.opencodeForm {
			return "", nil, nil
		}
		return "reject", nil, nil
	}
	invalid := fail(http.StatusBadRequest, "invalid_choice", "choice is not one of the options")
	if !p.opencodeForm {
		var n int
		if json.Unmarshal(choice, &n) != nil || opencodeDecisions[n] == "" {
			return "", nil, invalid
		}
		return opencodeDecisions[n], nil, nil
	}
	var c struct {
		Answer map[string]json.RawMessage `json:"answer"`
	}
	if p.Kind != "form" || json.Unmarshal(choice, &c) != nil || c.Answer == nil {
		return "", nil, invalid
	}
	answer = map[string]any{}
	for key, raw := range c.Answer {
		i := slices.IndexFunc(p.Fields, func(f PromptField) bool { return f.Key == key })
		if i < 0 {
			return "", nil, fail(http.StatusBadRequest, "invalid_choice", "the form has no such field")
		}
		v, err := opencodeFieldValue(p.Fields[i], raw)
		if err != nil {
			return "", nil, err
		}
		answer[key] = v
	}
	for _, f := range p.Fields {
		// A required field may still be left out when its conditions hide
		// it: OpenCode itself checks which fields are shown.
		if _, ok := answer[f.Key]; f.Required && !ok && len(f.When) == 0 {
			return "", nil, fail(http.StatusBadRequest, "invalid_choice", "a required field has no answer")
		}
	}
	return "", answer, nil
}

// opencodeFieldValue checks one answer against its field: its type, an
// option when the field takes no other text, the field's number bounds and
// item count, and termote's own limits on text (agentMaxFreeText, no
// control character). OpenCode checks the rest (lengths, formats).
func opencodeFieldValue(f PromptField, raw json.RawMessage) (any, error) {
	wrong := fail(http.StatusBadRequest, "invalid_choice", "a field's answer is not of its type")
	// null would decode as the type's zero value.
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, wrong
	}
	text := opencodeFieldText
	option := func(s string) bool {
		return f.Custom || slices.ContainsFunc(f.Options, func(o FieldOption) bool { return o.Value == s })
	}
	switch f.Type {
	case "string":
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return nil, wrong
		}
		if err := text(s); err != nil {
			return nil, err
		}
		if len(f.Options) > 0 && !option(s) {
			return nil, fail(http.StatusBadRequest, "invalid_choice", "choice is not one of the options")
		}
		return s, nil
	case "number", "integer":
		var n float64
		if json.Unmarshal(raw, &n) != nil || math.IsInf(n, 0) || math.IsNaN(n) ||
			(f.Type == "integer" && n != math.Trunc(n)) {
			return nil, wrong
		}
		if (f.Minimum != nil && n < *f.Minimum) || (f.Maximum != nil && n > *f.Maximum) {
			return nil, fail(http.StatusBadRequest, "invalid_choice", "a number is out of range")
		}
		return n, nil
	case "boolean":
		var b bool
		if json.Unmarshal(raw, &b) != nil {
			return nil, wrong
		}
		return b, nil
	case "multiselect":
		var l []string
		if json.Unmarshal(raw, &l) != nil || len(l) > opencodeMaxOptions {
			return nil, wrong
		}
		for _, s := range l {
			if err := text(s); err != nil {
				return nil, err
			}
			if !option(s) {
				return nil, fail(http.StatusBadRequest, "invalid_choice", "choice is not one of the options")
			}
		}
		if (f.MinItems != nil && len(l) < *f.MinItems) || (f.MaxItems != nil && len(l) > *f.MaxItems) {
			return nil, fail(http.StatusBadRequest, "invalid_choice", "too few or too many options are chosen")
		}
		return l, nil
	}
	return nil, wrong
}

// opencodeFieldText checks a string of an answer: at most agentMaxFreeText
// bytes, no control character.
func opencodeFieldText(s string) error {
	switch {
	case len(s) > agentMaxFreeText:
		return errFreeTooLong
	case strings.IndexFunc(s, unicode.IsControl) >= 0:
		return fail(http.StatusBadRequest, "invalid_text", "text has a control character")
	}
	return nil
}

// opencodePromptOf turns s's read into the card a client gets, as promptOf
// does for a screen: a view-only one as viewCard makes it.
func (a *agentAPI) opencodePromptOf(paneID string, s AgentSession, read opencodeRead, viewOnly bool) *AgentPrompt {
	if read.prompt == nil {
		a.input.answered(paneID, "")
		return nil
	}
	p := *read.prompt
	if viewOnly {
		return viewCard(p)
	}
	if p.Kind != "unsupported" && !a.input.answered(paneID, read.sig) {
		p.PromptID = a.input.issuePrompt(paneID, s, read.sig, p)
	}
	return &p
}

// answerOpencode answers rec, a card of s (the pane's session, read again
// right before), with a permission decision or a form's answer (nil
// cancels the form): only while s's own list still holds the request.
func (a *agentAPI) answerOpencode(ctx context.Context, paneID string, s AgentSession, rec *promptRecord, decision string, answer map[string]any) error {
	expired := fail(http.StatusConflict, "prompt_expired", "this dialog was already answered or has expired")
	c, err := opencodeConnect()
	if err != nil {
		return errOpencodeNoReply
	}
	ctx, cancel := context.WithTimeout(ctx, opencodeWriteTimeout)
	defer cancel()
	perms, forms, err := c.pending(ctx, s.ID)
	if err != nil && !errors.Is(err, errOpencodeNotFound) {
		log.Printf("opencode answer: %v", err)
		return errOpencodeNoReply
	}
	list := perms
	if rec.prompt.opencodeForm {
		list = forms
	}
	if !slices.ContainsFunc(list, func(p opencodePending) bool { return p.ID == rec.prompt.opencodeID }) {
		return expired
	}
	if rec.prompt.opencodeForm {
		err = c.formReply(ctx, s.ID, rec.prompt.opencodeID, answer)
	} else {
		err = c.permissionReply(ctx, s.ID, rec.prompt.opencodeID, decision)
	}
	switch {
	case errors.Is(err, errOpencodeNotFound), errors.Is(err, errOpencodeSettled):
		return expired
	case errors.Is(err, errOpencodeRefused):
		// Nothing was taken: the same card is answered again.
		a.input.restorePrompt(rec)
		return fail(http.StatusBadRequest, "invalid_choice", "the agent refused this answer")
	case err != nil:
		log.Printf("opencode answer: %v", err)
		return errOpencodeNoReply
	}
	a.input.markAnswered(paneID, rec.sig)
	same := func(k string) bool { return k == s.ID }
	opencodeReads.forgetFunc(same)
	opencodeBlocked.forgetFunc(same)
	return nil
}

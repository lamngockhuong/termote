package main

import (
	"context"
	"errors"
	"log"
	"slices"
	"strings"
	"time"
)

// An OpenCode TUI in a pane. Its session is read from the TUI's own argv
// (--session/-s <id>) on tmux, psmux, Zellij and herdr-core, and from what
// Herdr's OpenCode integration reports on Herdr: the service tells no client
// which session it shows (checked on OpenCode 2.3.0), so a TUI started
// without --session, or one moved to another session from inside, has no
// session termote can name (argv keeps the first). Such a pane, and one
// whose service does not run, shows the agent's logo only.

const opencodeExeName = "opencode"

// opencodeSubcommands are the opencode commands that are not the TUI.
var opencodeSubcommands = []string{
	"upgrade", "update", "uninstall", "acp", "api", "debug", "auth", "mcp", "plugin", "models", "stats",
	"mini", "run", "session", "service", "reload", "pair", "serve", "help", "completion",
}

// opencodeTUIArgs reads an opencode argv (without the program): whether it
// runs the TUI, and the session it was asked to show when that TUI uses the
// background service (not --standalone or --server).
func opencodeTUIArgs(args []string) (tui bool, session string) {
	own := true
	positional := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			break
		}
		name, val, hasVal := strings.Cut(a, "=")
		switch name {
		case "--session", "-s":
			if !hasVal {
				if i+1 >= len(args) {
					return true, ""
				}
				i++
				val = args[i]
			}
			session = val
		case "--server":
			own = false
			if !hasVal {
				i++
			}
		case "--prompt", "--log-level", "--completions":
			if !hasVal {
				i++
			}
		case "--standalone":
			own = false
		case "--help", "-h", "--version", "-v":
			return false, ""
		default:
			if strings.HasPrefix(a, "-") || positional {
				continue
			}
			// The first word is a subcommand, or the TUI's directory.
			if slices.Contains(opencodeSubcommands, a) {
				return false, ""
			}
			positional = true
		}
	}
	if !own || !isOpencodeSessionID(session) {
		session = ""
	}
	return true, session
}

// opencodeProcOf checks whether pid is an OpenCode TUI. Its executable is
// named opencode (the npm launcher runs that binary as its child).
func opencodeProcOf(pid int) (claudeProc, bool) {
	if !agentProcSupported || procExeBase(pid) != opencodeExeName {
		return claudeProc{}, false
	}
	args := procArgs(pid)
	if len(args) == 0 {
		return claudeProc{}, false
	}
	tui, session := opencodeTUIArgs(args[1:])
	start, ok := procStartTime(pid)
	if !tui || !ok {
		return claudeProc{}, false
	}
	return claudeProc{agent: "opencode", pid: pid, procStart: start, opencodeSession: session}, true
}

// opencodeSessionOf is the session of an OpenCode TUI: its argv's, while
// the service runs. Without either it is still the pane's agent, with no
// session and status unknown.
func opencodeSessionOf(p claudeProc) (AgentSession, bool) {
	s := AgentSession{Agent: "opencode", Status: "unknown", PID: p.pid, ProcStart: p.procStart}
	if p.opencodeSession == "" {
		return s, true
	}
	c, err := opencodeConnect()
	if err != nil {
		return s, true
	}
	s.ID, s.Status = p.opencodeSession, opencodeStatus(c, p.opencodeSession)
	return s, true
}

// opencodeActive shares one read of the running sessions between every pane
// and client; opencodeBlocked one read of a session's pending requests.
var (
	opencodeActive  = newTTLCache[map[string]bool](agentCacheTTL)
	opencodeBlocked = newTTLCache[bool](agentCacheTTL)
)

// opencodeStatus is session id's status: blocked while it waits on a
// permission or a form (it is then still running), working while it runs a
// turn, else idle; unknown when the service cannot tell.
func opencodeStatus(c *opencodeClient, id string) string {
	active, err := opencodeActive.do("", func() (map[string]bool, error) {
		ctx, cancel := context.WithTimeout(context.Background(), opencodeTimeout)
		defer cancel()
		return c.active(ctx)
	})
	if err != nil {
		log.Printf("opencode status: %v", err)
		return "unknown"
	}
	if !active[id] {
		return "idle"
	}
	blocked, err := opencodeBlocked.do(id, func() (bool, error) {
		ctx, cancel := context.WithTimeout(context.Background(), opencodeTimeout)
		defer cancel()
		perms, forms, err := c.pending(ctx, id)
		return len(perms)+len(forms) > 0, err
	})
	if err != nil {
		log.Printf("opencode status: %v", err)
		return "working"
	}
	if blocked {
		return "blocked"
	}
	return "working"
}

const (
	// opencodeTailMessages is how many messages a first read asks for, and
	// a read of older ones; a page over opencodeMessagesMax (pasted images)
	// is asked again with fewer (opencodeShrink), down to one message, read
	// up to opencodeOneMessageMax.
	opencodeTailMessages = 100
	// opencodeForwardPages are the pages a cursor read asks for, newest
	// first, until it meets the last message the client has: the first is
	// small, since a poll usually finds nothing new. A client further behind
	// starts over from the end.
	// Cursor files: the last message the client has, or the service's own
	// cursor to the messages older than the client's first.
	opencodeCursorAfter  = "oc:"
	opencodeCursorBefore = "ocb:"
)

// opencodeReadTimeout bounds one read of a transcript or an image (a
// variable for the tests that move tens of MB).
var opencodeReadTimeout = 2 * opencodeTimeout

const (
	// opencodeForwardMax and opencodeForwardReads bound a cursor read: the
	// messages it reads back, and its requests (pages of one message after a
	// page over its limit).
	opencodeForwardMax   = 175
	opencodeForwardReads = 16
)

// opencodeTopBig: the newest page of a session was over its limit at its
// first size, so the next cursor reads of it start with one message (no
// read of a page over the limit on each poll).
var opencodeTopBig = newTTLCache[struct{}](30 * time.Second)

var (
	opencodeForwardPages = []int{5, 20, 50, 100}
	opencodeShrink       = []int{opencodeTailMessages, 20, 5, 1}
)

// readOpencodeTranscript reads s's messages through the service, as
// readTranscript reads a file: from the end without a valid cursor, the
// messages after the last one the client has with one, or the page before.
// Only settled messages are sent (opencodeSettled): the client appends what
// it gets, and a message still being written changes in place.
func readOpencodeTranscript(s AgentSession, cursor, before string) (transcriptResponse, error) {
	c, err := opencodeConnect()
	if err != nil {
		return transcriptResponse{}, errNoTranscript
	}
	ctx, cancel := context.WithTimeout(context.Background(), opencodeReadTimeout)
	defer cancel()
	res := transcriptResponse{Agent: s.Agent, SessionID: s.ID, Status: s.Status, Entries: []TranscriptEntry{}}
	beforeOf := func(older string) string {
		if older == "" {
			return ""
		}
		return encodeCursor(agentCursor{Session: s.ID, File: opencodeCursorBefore + older})
	}
	if before != "" {
		bc, ok := decodeCursor(before)
		if !ok {
			return transcriptResponse{}, errInvalidBefore
		}
		// Another session's, or another agent's, starts over below.
		if older, isBefore := strings.CutPrefix(bc.File, opencodeCursorBefore); isBefore && bc.Session == s.ID && older != "" {
			page, err := opencodePageShrinking(ctx, c, s.ID, older)
			if err != nil {
				return transcriptResponse{}, opencodeReadError(err)
			}
			// Older than a message the client has: all settled.
			if e := opencodeEntries(oldestFirstMessages(page.messages), s.ID); e != nil {
				res.Entries = e
			}
			res.Before = beforeOf(page.older)
			return res, nil
		}
	} else if cc, ok := decodeCursor(cursor); ok && cc.Session == s.ID {
		if last, ok := strings.CutPrefix(cc.File, opencodeCursorAfter); ok {
			newer, found, err := opencodeAfter(ctx, c, s.ID, last)
			if err != nil && !errors.Is(err, errOpencodeTooLarge) {
				return transcriptResponse{}, opencodeReadError(err)
			}
			if found {
				kept, lastID := opencodeSettled(newer, last)
				if e := opencodeEntries(kept, s.ID); e != nil {
					res.Entries = e
				}
				res.Cursor = encodeCursor(agentCursor{Session: s.ID, File: opencodeCursorAfter + lastID})
				return res, nil
			}
		}
	}
	page, err := opencodePageShrinking(ctx, c, s.ID, "")
	if errors.Is(err, errOpencodeNotFound) {
		// A session named with --session is made with its first message.
		page, err = opencodePage{}, nil
	}
	if err != nil {
		return transcriptResponse{}, opencodeReadError(err)
	}
	kept, lastID := opencodeSettled(oldestFirstMessages(page.messages), "")
	res.Reset = true
	if e := opencodeEntries(kept, s.ID); e != nil {
		res.Entries = e
	}
	res.Cursor = encodeCursor(agentCursor{Session: s.ID, File: opencodeCursorAfter + lastID})
	res.Before = beforeOf(page.older)
	return res, nil
}

// opencodePageShrinking reads the page cursor names ("" for the newest),
// asking for fewer messages while a page is over opencodeMessagesMax.
func opencodePageShrinking(ctx context.Context, c *opencodeClient, id, cursor string) (opencodePage, error) {
	page, _, err := opencodePageFitting(ctx, c, id, cursor, opencodeTailMessages)
	return page, err
}

// opencodePageFitting reads up to n messages of the page cursor names, and
// while that page is over its limit, the fewer of each opencodeShrink step
// below n, the last one message alone (oneMessage). It returns the number
// it asked for last.
func opencodePageFitting(ctx context.Context, c *opencodeClient, id, cursor string, n int) (opencodePage, int, error) {
	read := func(n int) (opencodePage, error) {
		if n == 1 {
			return c.oneMessage(ctx, id, cursor)
		}
		return c.messages(ctx, id, cursor, n)
	}
	page, err := read(n)
	for _, fewer := range opencodeShrink {
		if !errors.Is(err, errOpencodeTooLarge) {
			break
		}
		if fewer < n {
			n = fewer
			page, err = read(n)
		}
	}
	return page, n, err
}

// opencodeReadError logs err and answers the client without the service's
// words: a session or service gone is a transcript not found.
func opencodeReadError(err error) error {
	if !errors.Is(err, errOpencodeNotFound) && !errors.Is(err, errOpencodeUnavailable) {
		log.Printf("opencode transcript: %v", err)
	}
	return errNoTranscript
}

// opencodeAfter returns the messages of session id newer than message last
// (all of them when last is empty), oldest first, reading back through
// opencodeForwardPages, at most opencodeForwardMax messages in
// opencodeForwardReads requests; found is false when last was not met. Once
// a page shrank to fewer messages, the older pages are asked with as few.
func opencodeAfter(ctx context.Context, c *opencodeClient, id, last string) ([]opencodeMessage, bool, error) {
	var newest []opencodeMessage // newest first
	cursor := ""
	size := 0 // the pages' own sizes until one shrinks
	if _, big := opencodeTopBig.peek(id); big {
		size = 1
	}
	for i := 0; i < opencodeForwardReads && len(newest) < opencodeForwardMax; i++ {
		n := opencodeForwardPages[min(i, len(opencodeForwardPages)-1)]
		if size > 0 {
			n = min(n, size)
		}
		page, asked, err := opencodePageFitting(ctx, c, id, cursor, n)
		if asked < n {
			size = asked
			if cursor == "" {
				opencodeTopBig.forgetFunc(func(k string) bool { return k == id })
				opencodeTopBig.do(id, func() (struct{}, error) { return struct{}{}, nil })
			}
		}
		if errors.Is(err, errOpencodeNotFound) && last == "" && cursor == "" {
			return nil, true, nil // still no message: the session is made with the first
		}
		if err != nil {
			return nil, false, err
		}
		for _, m := range page.messages {
			if m.ID == last {
				return oldestFirstMessages(newest), true, nil
			}
			newest = append(newest, m)
		}
		if page.older == "" {
			// The first message reached: last is gone unless the client had none.
			return oldestFirstMessages(newest), last == "", nil
		}
		cursor = page.older
	}
	return nil, false, nil
}

func oldestFirstMessages(newestFirst []opencodeMessage) []opencodeMessage {
	out := slices.Clone(newestFirst)
	slices.Reverse(out)
	return out
}

// opencodeSettled keeps msgs (oldest first) up to the first one still open
// (an answer not completed, a compaction or a shell command running) that
// no idle message follows: OpenCode ends every turn, finished, failed or
// interrupted, with one, so what comes before it no longer changes. It
// returns them and the id of the last one kept (last when none is).
func opencodeSettled(msgs []opencodeMessage, last string) ([]opencodeMessage, string) {
	lastIdle := -1
	for i, m := range msgs {
		if m.Type == "idle" {
			lastIdle = i
		}
	}
	for i, m := range msgs[lastIdle+1:] {
		open := false
		switch m.Type {
		case "assistant":
			open = m.Time.Completed == 0
		case "compaction", "shell":
			open = m.Status == "running"
		}
		if open {
			msgs = msgs[:lastIdle+1+i]
			break
		}
	}
	if len(msgs) > 0 {
		last = msgs[len(msgs)-1].ID
	}
	return msgs, last
}

// opencodeEntries turns messages (oldest first) of session into Chat view
// rows; a kind the Chat view has no row for is skipped. Every image pasted
// inline gets its reference for agent/image.
func opencodeEntries(msgs []opencodeMessage, session string) []TranscriptEntry {
	var out []TranscriptEntry
	for _, m := range msgs {
		e, ok := opencodeEntry(m)
		if !ok {
			continue
		}
		for j := range e.Parts {
			if p := &e.Parts[j]; p.Kind == "image" && p.imageN >= 0 {
				p.Image = encodeImageRef(agentImageRef{Session: session, File: opencodeImageRefFile + m.ID, N: p.imageN})
			}
		}
		out = append(out, e)
	}
	return out
}

func opencodeEntry(m opencodeMessage) (TranscriptEntry, bool) {
	e := TranscriptEntry{ID: m.ID}
	if m.Time.Created > 0 {
		e.TS = time.UnixMilli(int64(m.Time.Created)).UTC().Format(time.RFC3339Nano)
	}
	switch m.Type {
	case "user":
		e.Role = "user"
		// OpenCode stores a command's expanded template, the output of its
		// !`cmd` included, as the user's text, unmarked.
		e.viewHidesText = true
		if strings.TrimSpace(m.Text) != "" {
			e.Parts = append(e.Parts, textPart("text", m.Text, claudeMaxText))
		}
		// imageN is the file's place in the message, -1 (no reference,
		// the chip alone) for an image kept elsewhere than in the message.
		for i, f := range m.Files {
			if strings.HasPrefix(f.Mime, "image/") {
				n := i
				if f.Source.Type != "inline" {
					n = -1
				}
				e.Parts = append(e.Parts, TranscriptPart{Kind: "image", imageN: n})
			}
		}
	case "assistant":
		e.Role = "assistant"
		if m.Tokens != nil && m.Tokens.total() > 0 {
			e.usage = &entryUsage{contextTokens: m.Tokens.total(), model: m.Model.ID, provider: m.Model.ProviderID}
		}
		for _, c := range m.Content {
			switch c.Type {
			case "text":
				if strings.TrimSpace(c.Text) != "" {
					e.Parts = append(e.Parts, textPart("text", c.Text, claudeMaxText))
				}
			case "reasoning":
				if strings.TrimSpace(c.Text) != "" {
					e.Parts = append(e.Parts, textPart("thinking", c.Text, claudeMaxText))
				}
			case "tool":
				e.Parts = append(e.Parts, opencodeToolPart(c))
			}
		}
	case "compaction":
		switch m.Status {
		case "completed":
			e.Role = "summary"
			text := m.Summary
			if strings.TrimSpace(text) == "" {
				text = compactedText
			}
			e.Parts = []TranscriptPart{textPart("text", text, claudeMaxText)}
		case "failed":
			e.Role = "note"
			e.Parts = []TranscriptPart{{Kind: "text", Text: "Context compaction failed"}}
		}
	case "shell":
		// A command the user ran with !: a note, as Claude Code's.
		if strings.TrimSpace(m.Command) == "" {
			break
		}
		e.Role = "note"
		text := "$ " + m.Command
		if m.Output != nil && m.Output.Output != "" {
			text += "\n" + m.Output.Output
		}
		e.Parts = []TranscriptPart{textPart("text", text, claudeMaxResult)}
	case "skill":
		if m.Name != "" {
			e.Role = "note"
			e.Parts = []TranscriptPart{{Kind: "text", Text: "Skill: " + oneLine(m.Name)}}
		}
	case "idle":
		// The end of a turn: a note when it did not succeed, since a failed
		// one (a rate limit, a provider error) often leaves no answer at all.
		switch m.Outcome {
		case "failed":
			text := "Turn failed"
			if m.Error != nil && strings.TrimSpace(m.Error.Message) != "" {
				text += ": " + oneLine(m.Error.Message)
			}
			e.Role = "note"
			e.Parts = []TranscriptPart{textPart("text", text, claudeMaxResult)}
		case "interrupted":
			e.Role = "note"
			e.Parts = []TranscriptPart{{Kind: "text", Text: "Interrupted"}}
		}
	}
	if len(e.Parts) == 0 {
		return TranscriptEntry{}, false
	}
	return e, true
}

// opencodeToolPart is a tool call with its result, which OpenCode keeps on
// the call itself.
func opencodeToolPart(c opencodeContent) TranscriptPart {
	name := c.Name
	if name == "" {
		name = "tool"
	}
	p := TranscriptPart{Kind: "tool", Tool: name, ToolID: c.ID, Input: summarizeToolInput(c.State.Input),
		Detail: opencodeToolDetail(name, c.State.Input)}
	var texts []string
	for _, t := range c.State.Content {
		if t.Type == "text" && t.Text != "" {
			texts = append(texts, t.Text)
		}
	}
	switch c.State.Status {
	case "completed":
		p.Result, p.Clipped = clampText(stripANSI(strings.Join(texts, "\n")), claudeMaxResult)
	case "error":
		p.IsError = true
		p.Result, p.Clipped = clampText(stripANSI(strings.Join(texts, "\n")), claudeMaxResult)
		if p.Result == "" {
			p.Result = "Error"
		}
	}
	return p
}

// opencodeToolDetail is claudeToolDetail for OpenCode's tools: shell runs a
// command, edit replaces oldString with newString, write puts content.
func opencodeToolDetail(tool string, in map[string]any) *ToolDetail {
	switch tool {
	case "shell":
		return claudeToolDetail("Bash", in)
	case "edit":
		in = opencodeEditInput(in)
		in["old_string"], in["new_string"] = in["oldString"], in["newString"]
		return claudeToolDetail("Edit", in)
	case "write":
		return claudeToolDetail("Write", opencodeEditInput(in))
	}
	return claudeToolDetail(tool, in)
}

// opencodeEditInput is in with its file (path or filePath) where
// claudeToolDetail looks for it, so a sensitive file's text stays out.
func opencodeEditInput(in map[string]any) map[string]any {
	out := make(map[string]any, len(in)+3)
	for k, v := range in {
		out[k] = v
	}
	for _, k := range []string{"path", "filePath"} {
		if s := jsonStr(in[k]); s != "" {
			out["file_path"] = s
		}
	}
	return out
}

// opencodeWindowTTL: the models of a directory, and the directory of a
// session, are read again after this.
const opencodeWindowTTL = time.Minute

var (
	opencodeDirs    = newTTLCache[string](opencodeWindowTTL)
	opencodeWindows = newTTLCache[map[string]int64](opencodeWindowTTL)
)

// opencodeWindow is the context window of model of provider, which session
// id ran on, as the service's list of models for the session's directory
// gives it (its limit.context); 0 when the service does not list it or
// cannot be asked.
func opencodeWindow(id, provider, model string) int64 {
	if provider == "" || model == "" {
		return 0
	}
	c, err := opencodeConnect()
	if err != nil {
		return 0
	}
	dir, err := opencodeDirs.do(id, func() (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), opencodeTimeout)
		defer cancel()
		return c.directory(ctx, id)
	})
	if err != nil {
		opencodeDirs.forgetPrefix(id)
		dir = "" // the service's own list
	}
	windows, err := opencodeWindows.do(dir, func() (map[string]int64, error) {
		ctx, cancel := context.WithTimeout(context.Background(), opencodeTimeout)
		defer cancel()
		return c.modelWindows(ctx, dir)
	})
	if err != nil {
		opencodeWindows.forgetPrefix(dir)
		if !errors.Is(err, errOpencodeUnavailable) {
			log.Printf("opencode models: %v", err)
		}
		return 0
	}
	return windows[provider+"\x00"+model]
}

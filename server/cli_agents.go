package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
	"unicode/utf8"
)

// termote agents: the coding agents in the running server's panes, for an
// agent that coordinates them (the orchestrator skill). Every command calls
// a route the PWA uses, over the local socket only: the socket signs the
// CLI in as its own OS user, so no password or token is ever sent, printed
// or needed, and --no-auth makes no difference. A pane is named by its id
// or a name only one pane has; a command that writes reaches one pane,
// and only wait reads several.

const agentsUsage = `usage: termote agents list [--json]
       termote agents read <pane> [--all] [--json]
       termote agents send <pane> <text | ->
       termote agents wait <pane>... [--after <seq>] [--timeout <duration>]
       termote agents answer <pane> [<option number> | cancel | next | --text <answer>]
       termote agents stop <pane> --cursor <cursor>
       termote agents diff <pane> [--stat] [--base <branch>]
       termote agents start --workspace <id | name> --kind <claude | codex | opencode> [--name <tab name>]
                            [--worktree <new branch> [--base <branch>]] [<prompt> | -]`

// The exit statuses of agents wait besides 0 (a turn ended), 1 (an error)
// and 2 (usage). With several panes ending at once, the gravest wins.
const (
	agentsExitDialog  = 3 // the agent waits on a dialog
	agentsExitTimeout = 4 // still working when --timeout passed
	agentsExitGone    = 5 // the pane no longer runs an agent
	agentsExitIdle    = 6 // no pane works and none ended since the mark
	agentsExitReset   = 7 // the server dropped the changes after the mark
)

// The longest each kind of request may take. A message can wait minutes for
// the pane's lock and a long paste (agentRequestMost); a start polls the
// pane for a few seconds; reads answer at once.
var (
	agentsReadTimeout  = 15 * time.Second
	agentsWriteTimeout = agentRequestMost + 30*time.Second
	agentsStartTimeout = 2 * time.Minute
	// agentsWaitEvery: how often wait reads the snapshot; agentsWaitGrace:
	// how long an agent that has not started working (a message just sent)
	// is given to start before wait reports it done.
	agentsWaitEvery = 2 * time.Second
	agentsWaitGrace = 10 * time.Second
	// agentsWaitFailures snapshot reads in a row that fail end a wait.
	agentsWaitFailures = 5
	// agentsStartEvery: how often start follows the agent's start.
	agentsStartEvery = time.Second
)

// agentsReadMax bounds an answer the CLI reads: a transcript tail is up to
// 8 MiB of the file, which JSON escaping can make several times larger.
var agentsReadMax = 64 << 20

func (c *cli) cmdAgents(args []string) error {
	if len(args) == 0 {
		return usageError(agentsUsage)
	}
	switch args[0] {
	case "list", "ls":
		return c.agentsList(args[1:])
	case "read":
		return c.agentsRead(args[1:])
	case "send":
		return c.agentsSend(args[1:])
	case "wait":
		return c.agentsWait(args[1:])
	case "answer":
		return c.agentsAnswer(args[1:])
	case "stop":
		return c.agentsStop(args[1:])
	case "diff":
		return c.agentsDiff(args[1:])
	case "start":
		return c.agentsStart(args[1:])
	}
	return usageError("unknown agents command: %s\n%s", args[0], agentsUsage)
}

// agentsPort is the port of the native server to talk to, or why there is
// none to reach over a local socket.
func (c *cli) agentsPort() (int, error) {
	saved, _ := c.loadConfig()
	if saved != nil && saved.Container != nil && c.installedSupervisor() == nil {
		return 0, errors.New("termote agents is not supported in container mode (the container has no local socket); " +
			"run termote natively (termote start) to coordinate agents from the command line")
	}
	return c.savedPort(saved), nil
}

// agentsReply is the server's answer to one request.
type agentsReply struct {
	status int
	body   []byte
}

// agentsErrorBody is what a refused agent request carries.
type agentsErrorBody struct {
	Error  string          `json:"error"`
	Code   string          `json:"code"`
	Prompt json.RawMessage `json:"prompt"`
}

func (r agentsReply) failure() agentsErrorBody {
	var e agentsErrorBody
	json.Unmarshal(r.body, &e)
	return e
}

// agentsCall sends method path with body (JSON when not nil) over the local
// socket and reads the answer. It never falls back to TCP.
func (c *cli) agentsCall(port int, method, path string, body any, timeout time.Duration) (agentsReply, error) {
	var data []byte
	if body != nil {
		var err error
		if data, err = json.Marshal(body); err != nil {
			return agentsReply{}, err
		}
	}
	resp, out := c.socketRequestWithin(port, method, path, data, timeout)
	switch out {
	case socketUnused:
		return agentsReply{}, fmt.Errorf("termote did not answer on port %d over its local socket: it is not running natively (start it: termote start), or it did not answer in time (check: termote status)", port)
	case socketMaybeSent:
		return agentsReply{}, errAgentsMaybeSent
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, int64(agentsReadMax)+1))
	if err != nil {
		return agentsReply{}, fmt.Errorf("reading the server's answer: %v", err)
	}
	if len(b) > agentsReadMax {
		return agentsReply{}, fmt.Errorf("the server's answer is larger than %d MB", agentsReadMax>>20)
	}
	return agentsReply{status: resp.StatusCode, body: b}, nil
}

// agentsGet reads path into out, or says why the server refused.
func (c *cli) agentsGet(port int, path string, out any) error {
	r, err := c.agentsCall(port, http.MethodGet, path, nil, agentsReadTimeout)
	if err != nil {
		return err
	}
	if r.status != http.StatusOK {
		return agentsRefusal(r)
	}
	if err := json.Unmarshal(r.body, out); err != nil {
		return fmt.Errorf("unexpected answer from the server: %v", err)
	}
	return nil
}

// agentsRefusal words a refused request, with the server's code when it
// sent one. The server's text is a safe message (codedError, agentFailure);
// it is still printed without control characters.
func agentsRefusal(r agentsReply) error {
	e := r.failure()
	msg := plainText(e.Error)
	switch {
	case r.status == http.StatusNotFound && msg == "not found":
		return errors.New("the running server does not know this request; update it: termote update")
	case msg == "" && e.Code == "":
		return fmt.Errorf("the server answered HTTP %d", r.status)
	case e.Code == "":
		return fmt.Errorf("the server refused: %s", msg)
	}
	hint := ""
	switch e.Code {
	case "input_has_draft":
		hint = "; the user typed something in the terminal's input box: ask them to send or clear it"
	case "input_busy":
		hint = "; try again in a moment"
	case "session_changed", "target_changed":
		hint = "; check the pane again: termote agents list"
	case "prompt_changed":
		hint = "; read the dialog again: termote agents answer <pane>"
	case "agent_not_working":
		hint = "; nothing to stop"
	case "agent_blocked":
		hint = "; it waits on a dialog: termote agents answer <pane>"
	case "interrupt_pending":
		hint = "; it was just stopped: check it with termote agents list"
	case "busy":
		hint = "; another worktree change is still running: try again in a moment"
	case "linked_source":
		hint = "; run start from the main checkout's workspace, not from a worktree"
	case "branch_exists":
		hint = "; pick a new branch name"
	case "invalid_name":
		hint = "; it is not a valid branch name"
	case "open_failed":
		hint = "; the worktree was made: open it from the PWA, then start the agent there"
	case "unknown":
		hint = "; check the PWA's worktrees before trying again"
	}
	if e.Code == "input_not_ready" && strings.Contains(msg, "dialog") {
		hint = "; answer it first: termote agents answer <pane>"
	}
	return fmt.Errorf("the server refused: %s (%s)%s", msg, plainText(e.Code), hint)
}

// snapPane is one pane of the snapshot, with where it is.
type snapPane struct {
	group Group
	tab   Tab
	pane  Pane
}

// label is the name the pane goes by: the name the user gave it, else its
// tab's.
func (p snapPane) label() string {
	if p.pane.Name != "" {
		return p.pane.Name
	}
	return p.tab.Name
}

// ref names the pane for a person: workspace/label.
func (p snapPane) ref() string {
	return p.group.Name + "/" + p.label()
}

func (p snapPane) status() string {
	if p.pane.Agent == nil {
		return ""
	}
	return p.pane.Agent.Status
}

func (p snapPane) cwd() string {
	if p.pane.Process == nil {
		return ""
	}
	return p.pane.Process.Cwd
}

// snapshotPanes lists every pane of s in order.
func snapshotPanes(s Snapshot) []snapPane {
	var out []snapPane
	for _, g := range s.Groups {
		for _, t := range g.Tabs {
			for _, p := range t.Panes {
				out = append(out, snapPane{group: g, tab: t, pane: p})
			}
		}
	}
	return out
}

// resolvePane finds the pane name names: its id, else the only pane whose
// label or workspace/label it is. Several matches are refused with the
// candidates, never guessed between.
func resolvePane(s Snapshot, name string) (snapPane, error) {
	panes := snapshotPanes(s)
	for _, p := range panes {
		if p.pane.ID == name {
			return p, nil
		}
	}
	// A name counts the panes that run an agent: a shell pane beside an
	// agent in its tab shares the tab's name without making it ambiguous.
	// Only a name no agent has falls back to every pane.
	var found, any []snapPane
	for _, p := range panes {
		if p.label() == name || p.ref() == name {
			any = append(any, p)
			if p.pane.Agent != nil {
				found = append(found, p)
			}
		}
	}
	if len(found) == 0 {
		found = any
	}
	switch len(found) {
	case 0:
		return snapPane{}, fmt.Errorf("no pane is named %q; see: termote agents list", plainText(name))
	case 1:
		return found[0], nil
	}
	names := make([]string, len(found))
	for i, p := range found {
		names[i] = fmt.Sprintf("%s (id %s)", plainText(p.ref()), plainText(p.pane.ID))
	}
	return snapPane{}, fmt.Errorf("%d panes are named %q; name one by its id: %s", len(found), plainText(name), strings.Join(names, ", "))
}

// agentsSnapshot reads the server's snapshot.
func (c *cli) agentsSnapshot(port int) (Snapshot, error) {
	var s Snapshot
	err := c.agentsGet(port, "/api/mux/snapshot", &s)
	return s, err
}

// agentsPane resolves name to a pane running an agent.
func (c *cli) agentsPane(port int, name string) (snapPane, error) {
	s, err := c.agentsSnapshot(port)
	if err != nil {
		return snapPane{}, err
	}
	p, err := resolvePane(s, name)
	if err != nil {
		return snapPane{}, err
	}
	if p.pane.Agent == nil {
		return snapPane{}, fmt.Errorf("pane %s (%s) runs no agent", plainText(p.pane.ID), plainText(p.ref()))
	}
	return p, nil
}

func panePath(id, rest string) string {
	return "/api/mux/panes/" + url.PathEscape(id) + rest
}

// agentRow is one agent as list prints it.
type agentRow struct {
	Pane           string   `json:"pane"`
	Name           string   `json:"name"`
	Workspace      string   `json:"workspace"`
	WorkspaceID    string   `json:"workspaceId"`
	Tab            string   `json:"tab"`
	TabID          string   `json:"tabId"`
	Agent          string   `json:"agent"`
	Status         string   `json:"status"`
	Since          string   `json:"since,omitempty"`
	Cwd            string   `json:"cwd,omitempty"`
	Branch         string   `json:"branch,omitempty"`
	Changed        *int     `json:"changed,omitempty"`
	ContextPercent *float64 `json:"contextPercent,omitempty"`
	LastText       string   `json:"lastText,omitempty"`
	LastTS         string   `json:"lastTs,omitempty"`
}

// workspaceRow is one workspace: its directory when every pane that reports
// one is in the same, else empty (not clear which).
type workspaceRow struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Cwd  string `json:"cwd,omitempty"`
}

type agentsListing struct {
	Backend    string         `json:"backend"`
	AgentStart bool           `json:"agentStart"`
	Agents     []agentRow     `json:"agents"`
	Workspaces []workspaceRow `json:"workspaces"`
}

func (c *cli) agentsList(args []string) error {
	asJSON := false
	fs := c.newFlagSet("agents list")
	fs.BoolVar(&asJSON, "json", false, "")
	if pos, err := parseArgs(fs, args); err != nil {
		return flagErr(err)
	} else if len(pos) > 0 {
		return usageError(agentsUsage)
	}
	port, err := c.agentsPort()
	if err != nil {
		return err
	}
	s, err := c.agentsSnapshot(port)
	if err != nil {
		return err
	}
	// The overview adds each agent's last words, branch and context; the
	// list stands without it.
	var ov overviewResponse
	if err := c.agentsGet(port, "/api/mux/overview", &ov); err != nil {
		ov = overviewResponse{}
	}
	byPane := map[string]overviewPane{}
	for _, p := range ov.Panes {
		byPane[p.PaneID] = p
	}
	l := agentsListing{Backend: s.Backend, AgentStart: s.Caps.AgentStart, Agents: []agentRow{}, Workspaces: []workspaceRow{}}
	for _, g := range s.Groups {
		l.Workspaces = append(l.Workspaces, workspaceRow{ID: g.ID, Name: g.Name, Cwd: groupCwd(g)})
	}
	for _, p := range snapshotPanes(s) {
		if p.pane.Agent == nil {
			continue
		}
		row := agentRow{Pane: p.pane.ID, Name: p.label(), Workspace: p.group.Name, WorkspaceID: p.group.ID,
			Tab: p.tab.Name, TabID: p.tab.ID, Agent: p.pane.Agent.Name, Status: p.pane.Agent.Status,
			Since: p.pane.Agent.Since, Cwd: p.cwd()}
		if o, ok := byPane[p.pane.ID]; ok {
			row.Branch, row.Changed, row.LastText, row.LastTS = o.Branch, o.Changed, o.LastText, o.LastTS
			if o.Usage != nil {
				row.ContextPercent = o.Usage.ContextPercent
			}
		}
		l.Agents = append(l.Agents, row)
	}
	if asJSON {
		return writeJSON(c.out, l)
	}
	if len(l.Agents) == 0 {
		fmt.Fprintln(c.out, "No agent runs in any pane.")
	} else {
		tw := tabwriter.NewWriter(c.out, 0, 0, 2, ' ', 0)
		fmt.Fprintln(tw, "PANE\tWORKSPACE/NAME\tAGENT\tSTATUS\tSINCE\tDIR")
		for _, r := range l.Agents {
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", plainText(r.Pane), plainText(r.Workspace+"/"+r.Name),
				plainText(r.Agent), dash(plainText(r.Status)), dash(sinceText(r.Since)), dash(plainText(r.Cwd)))
		}
		tw.Flush()
		for _, r := range l.Agents {
			if r.LastText != "" {
				fmt.Fprintf(c.out, "\n%s: %s", plainText(r.Workspace+"/"+r.Name), clipLine(r.LastText, 200))
			}
		}
		fmt.Fprintln(c.out)
	}
	fmt.Fprintln(c.out, "\nWorkspaces:")
	tw := tabwriter.NewWriter(c.out, 0, 0, 2, ' ', 0)
	for _, w := range l.Workspaces {
		fmt.Fprintf(tw, "  %s\t%s\t%s\n", plainText(w.ID), plainText(w.Name), dash(plainText(w.Cwd)))
	}
	tw.Flush()
	return nil
}

// groupCwd is the directory every pane of g that reports one is in, or ""
// when they differ or none reports one.
func groupCwd(g Group) string {
	dir := ""
	for _, t := range g.Tabs {
		for _, p := range t.Panes {
			if p.Process == nil || p.Process.Cwd == "" {
				continue
			}
			if dir != "" && dir != p.Process.Cwd {
				return ""
			}
			dir = p.Process.Cwd
		}
		for _, p := range t.Processes {
			if p.Cwd == "" {
				continue
			}
			if dir != "" && dir != p.Cwd {
				return ""
			}
			dir = p.Cwd
		}
	}
	return dir
}

func writeJSON(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// sinceText is how long ago an RFC 3339 time was, in a few characters.
func sinceText(ts string) string {
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return ""
	}
	d := max(time.Since(t).Truncate(time.Second), 0)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}

// cleanOut is text from the server as the CLI prints it: without control
// characters other than newline and tab, nor hidden or bidi ones that
// would reorder what the terminal shows.
func cleanOut(s string) string {
	return strings.Map(func(r rune) rune {
		if hiddenRune(r) {
			return -1
		}
		return r
	}, cleanText(s))
}

// clipLine is s on one line, cut to max runes.
func clipLine(s string, max int) string {
	s = strings.Join(strings.Fields(cleanOut(s)), " ")
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return string(r[:max-1]) + "…"
}

func (c *cli) agentsRead(args []string) error {
	asJSON, all := false, false
	fs := c.newFlagSet("agents read")
	fs.BoolVar(&asJSON, "json", false, "")
	fs.BoolVar(&all, "all", false, "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) != 1 {
		return usageError(agentsUsage)
	}
	port, err := c.agentsPort()
	if err != nil {
		return err
	}
	p, err := c.agentsPane(port, pos[0])
	if err != nil {
		return err
	}
	var t transcriptResponse
	if err := c.agentsGet(port, panePath(p.pane.ID, "/agent/transcript"), &t); err != nil {
		return err
	}
	entries := t.Entries
	if !all {
		entries = lastTurn(entries)
	}
	if asJSON {
		// cursor: the conversation read, which a stop names so it never
		// reaches another session.
		return writeJSON(c.out, map[string]any{"pane": p.pane.ID, "agent": t.Agent, "status": p.status(), "cursor": t.Cursor, "entries": entries})
	}
	if len(entries) == 0 {
		fmt.Fprintf(c.out, "%s (%s) has no messages yet.\n", plainText(p.ref()), plainText(p.pane.ID))
		return nil
	}
	for i, e := range entries {
		if i > 0 {
			fmt.Fprintln(c.out)
		}
		fmt.Fprintf(c.out, "## %s", plainText(e.Role))
		if e.TS != "" {
			fmt.Fprintf(c.out, " (%s)", plainText(e.TS))
		}
		fmt.Fprintln(c.out)
		for _, part := range e.Parts {
			fmt.Fprintln(c.out, partText(part))
		}
	}
	if st := p.status(); st != "" {
		fmt.Fprintf(c.out, "\n[status: %s]\n", plainText(st))
	}
	return nil
}

// lastTurn is the entries from the last message of the user on: the request
// the agent works on and everything it has answered since.
func lastTurn(entries []TranscriptEntry) []TranscriptEntry {
	for i := len(entries) - 1; i >= 0; i-- {
		if entries[i].Role == "user" {
			return entries[i:]
		}
	}
	return entries
}

// partText is one part of an entry as read prints it: text whole, a tool
// call on a line of its own with its result cut short.
func partText(p TranscriptPart) string {
	switch p.Kind {
	case "text":
		return cleanOut(p.Text)
	case "thinking":
		return "(thinking) " + clipLine(p.Text, 300)
	case "tool":
		s := "[" + plainText(p.Tool) + "]"
		if p.Input != "" {
			s += " " + clipLine(p.Input, 200)
		}
		if p.Result != "" {
			mark := "→"
			if p.IsError {
				mark = "→ error:"
			}
			s += "\n  " + mark + " " + clipLine(p.Result, 300)
		}
		return s
	case "image":
		return "[image]"
	}
	return "[" + plainText(p.Kind) + "]"
}

// readText is args' one text: the argument itself, or standard input for
// "-".
func (c *cli) readText(arg string) (string, error) {
	if arg != "-" {
		return arg, nil
	}
	b, err := io.ReadAll(io.LimitReader(c.in, agentMessageBody+1))
	if err != nil {
		return "", fmt.Errorf("reading the message: %v", err)
	}
	if len(b) > agentMessageBody {
		return "", fmt.Errorf("the message is longer than %d KB", agentMaxText/1024)
	}
	return strings.TrimRight(string(b), "\n"), nil
}

func (c *cli) agentsSend(args []string) error {
	if len(args) != 2 {
		return usageError(agentsUsage)
	}
	text, err := c.readText(args[1])
	if err != nil {
		return err
	}
	if strings.TrimSpace(text) == "" {
		return usageError("the message is empty")
	}
	if len(text) > agentMaxText {
		return fmt.Errorf("the message is longer than %d KB", agentMaxText/1024)
	}
	port, err := c.agentsPort()
	if err != nil {
		return err
	}
	p, err := c.agentsPane(port, args[0])
	if err != nil {
		return err
	}
	// The mark is taken before the message goes, so the turn it starts is
	// after it however soon it ends.
	hint := c.afterHint(port, p.pane.ID)
	queued, err := c.sendToAgent(port, p.pane.ID, text)
	if err != nil {
		return err
	}
	if queued {
		c.infof("Queued for %s (%s): the agent is working and reads it when it is ready%s", plainText(p.ref()), plainText(p.pane.ID), hint)
	} else {
		c.infof("Sent to %s (%s)%s", plainText(p.ref()), plainText(p.pane.ID), hint)
	}
	return nil
}

// sendToAgent sends text as the PWA does: with the cursor of the
// conversation it reads first, once more with a new one when the pane runs
// another session by then.
func (c *cli) sendToAgent(port int, paneID, text string) (queued bool, err error) {
	for attempt := 0; ; attempt++ {
		var t transcriptResponse
		if err := c.agentsGet(port, panePath(paneID, "/agent/transcript"), &t); err != nil {
			return false, err
		}
		r, err := c.agentsCall(port, http.MethodPost, panePath(paneID, "/agent/message"),
			map[string]string{"text": text, "cursor": t.Cursor}, agentsWriteTimeout)
		if err != nil {
			return false, err
		}
		switch {
		case r.status == http.StatusNoContent:
			return false, nil
		case r.status == http.StatusAccepted:
			return true, nil
		case attempt == 0 && r.failure().Code == "session_changed":
			continue
		}
		return false, agentsRefusal(r)
	}
}

// agentsWaitMost panes are waited on at once.
const agentsWaitMost = 32

// waitEnd is how a waited pane ended since the mark: its turn ended, a
// dialog waits, or its agent is gone.
type waitEnd string

const (
	waitDone   waitEnd = "done"
	waitDialog waitEnd = "dialog"
	waitGone   waitEnd = "gone"
)

// waitExit is the exit status for an end: the gravest one wins (gone over
// a dialog over a turn that ended).
func (e waitEnd) exit() int {
	switch e {
	case waitGone:
		return agentsExitGone
	case waitDialog:
		return agentsExitDialog
	}
	return 0
}

// waitVerdict is how each of ids ended in events, the activity after the
// mark, with s the snapshot read just before them. A pane ends when its
// turn ends (working or blocked to idle or done), when it goes to a dialog
// that it still shows, or when its agent goes. A status it had before the
// mark (a dialog shown, a turn done) ends nothing: only a change after it
// does, so a pane that finished while the caller was busy elsewhere is
// still reported, and one already reported is not reported again.
func waitVerdict(events []activityEvent, ids []string, s Snapshot) map[string]waitEnd {
	out := map[string]waitEnd{}
	for _, id := range ids {
		ended, blocked, gone := false, false, false
		for _, e := range events {
			if e.PaneID != id {
				continue
			}
			gone = e.To == ""
			switch {
			case e.To == "blocked":
				blocked = true
			case (e.From == "working" || e.From == "blocked") && (e.To == "idle" || e.To == "done"):
				ended = true
			}
		}
		now, ok := findAgentPane(s, id)
		switch {
		case gone || !ok || now.pane.Agent == nil:
			out[id] = waitGone
		case blocked && now.status() == "blocked":
			out[id] = waitDialog
		case ended:
			out[id] = waitDone
		}
	}
	return out
}

// activityLatest is the seq of the newest status change the server
// recorded, read after a snapshot so the changes it showed are counted.
func (c *cli) activityLatest(port int) (uint64, error) {
	var page activityPage
	if err := c.agentsGet(port, "/api/mux/activity", &page); err != nil {
		return 0, err
	}
	return page.Latest, nil
}

// afterHint is how a command that just gave an agent work says where a wait
// for it starts, so the turn is counted even when it ends before the wait.
func (c *cli) afterHint(port int, paneID string) string {
	latest, err := c.activityLatest(port)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("; wait for it: termote agents wait %s --after %d", plainText(paneID), latest)
}

func (c *cli) agentsWait(args []string) error {
	timeout := 30 * time.Minute
	after, hasAfter := uint64(0), false
	fs := c.newFlagSet("agents wait")
	fs.DurationVar(&timeout, "timeout", timeout, "")
	fs.Func("after", "", func(v string) error {
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			return errors.New("--after is the number a previous command printed")
		}
		after, hasAfter = n, true
		return nil
	})
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) == 0 || timeout <= 0 {
		return usageError(agentsUsage)
	}
	if len(pos) > agentsWaitMost {
		return usageError("wait takes at most %d panes", agentsWaitMost)
	}
	port, err := c.agentsPort()
	if err != nil {
		return err
	}
	s, err := c.agentsSnapshot(port)
	if err != nil {
		return err
	}
	// Every name is resolved before the wait starts, and a pane named twice
	// is waited on once.
	var ids []string
	refs := map[string]string{}
	for _, name := range pos {
		p, err := resolvePane(s, name)
		if err != nil {
			return err
		}
		if p.pane.Agent == nil {
			return fmt.Errorf("pane %s (%s) runs no agent", plainText(p.pane.ID), plainText(p.ref()))
		}
		if _, dup := refs[p.pane.ID]; !dup {
			ids = append(ids, p.pane.ID)
			refs[p.pane.ID] = plainText(p.ref())
		}
	}
	if !hasAfter {
		if after, err = c.activityLatest(port); err != nil {
			return err
		}
	}
	start := time.Now()
	deadline := start.Add(timeout)
	// mark: where this wait started, which a pane that did not end keeps
	// for the next one; after moves on with each page read, and events
	// keeps the waited panes' changes since mark.
	mark := after
	var events []activityEvent
	waited := map[string]bool{}
	for _, id := range ids {
		waited[id] = true
	}
	// Failed reads in a row, of the activity and of the snapshot.
	actFailures, snapFailures := 0, 0
	for {
		var page activityPage
		if err := c.agentsGet(port, "/api/mux/activity?after="+strconv.FormatUint(after, 10), &page); err != nil {
			if actFailures++; actFailures >= agentsWaitFailures {
				return err
			}
		} else {
			actFailures = 0
			if page.Reset {
				return c.waitReset(s, ids, refs, page.Latest)
			}
			for _, e := range page.Events {
				if waited[e.PaneID] {
					events = append(events, e)
				}
			}
			after = max(after, page.Latest)
			if ends := waitVerdict(events, ids, s); len(ends) > 0 {
				return c.waitEnded(ids, refs, ends, mark, page.Latest)
			}
			if time.Since(start) >= agentsWaitGrace && !anyWorking(s, ids) {
				return c.waitNothing(s, ids, refs, page.Latest)
			}
		}
		if time.Now().After(deadline) {
			var working []string
			for _, id := range ids {
				if p, ok := findAgentPane(s, id); ok && p.status() == "working" {
					working = append(working, fmt.Sprintf("%s (%s)", refs[id], plainText(id)))
				}
			}
			fmt.Fprintf(c.out, "still working after %s: %s\n", timeout, dash(strings.Join(working, ", ")))
			fmt.Fprintf(c.out, "next: termote agents wait %s --after %d\n", waitIDs(ids), mark)
			return &exitError{code: agentsExitTimeout}
		}
		time.Sleep(agentsWaitEvery)
		// The snapshot first: reading it records the status changes the
		// activity read then returns, with no page open in a browser.
		// A server restarting (an update) or a backend slow for a moment
		// does not end a long wait; a few failed reads in a row do.
		if now, err := c.agentsSnapshot(port); err != nil {
			if snapFailures++; snapFailures >= agentsWaitFailures {
				return err
			}
		} else {
			s, snapFailures = now, 0
		}
	}
}

// anyWorking: one of ids shows its agent working in s.
func anyWorking(s Snapshot, ids []string) bool {
	for _, id := range ids {
		if p, ok := findAgentPane(s, id); ok && p.status() == "working" {
			return true
		}
	}
	return false
}

func waitIDs(ids []string) string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = plainText(id)
	}
	return strings.Join(out, " ")
}

// waitEnded prints every pane that ended, in the order named, and the wait
// that follows the others: from mark still, so a change of theirs recorded
// after the snapshot this verdict read is not skipped.
func (c *cli) waitEnded(ids []string, refs map[string]string, ends map[string]waitEnd, mark, latest uint64) error {
	code := 0
	var rest []string
	for _, id := range ids {
		end, ok := ends[id]
		if !ok {
			rest = append(rest, id)
			continue
		}
		ref, pid := refs[id], plainText(id)
		switch end {
		case waitDone:
			fmt.Fprintf(c.out, "%s (%s) is done; read it: termote agents read %s\n", ref, pid, pid)
		case waitDialog:
			fmt.Fprintf(c.out, "%s (%s) waits on a dialog; see it: termote agents answer %s\n", ref, pid, pid)
		case waitGone:
			fmt.Fprintf(c.out, "%s (%s) no longer runs an agent\n", ref, pid)
		}
		code = max(code, end.exit())
	}
	if len(rest) > 0 {
		fmt.Fprintf(c.out, "next: termote agents wait %s --after %d\n", waitIDs(rest), mark)
	} else {
		fmt.Fprintf(c.out, "next wait starts after %d (termote agents wait <pane>... --after %d)\n", latest, latest)
	}
	if code != 0 {
		return &exitError{code: code}
	}
	return nil
}

// waitStatus prints what each pane shows now, for a wait that cannot tell
// what ended.
func (c *cli) waitStatus(s Snapshot, ids []string, refs map[string]string) {
	for _, id := range ids {
		ref, pid := refs[id], plainText(id)
		p, ok := findAgentPane(s, id)
		switch {
		case !ok || p.pane.Agent == nil:
			fmt.Fprintf(c.out, "%s (%s) no longer runs an agent\n", ref, pid)
		case p.status() == "blocked":
			fmt.Fprintf(c.out, "%s (%s) waits on a dialog; see it: termote agents answer %s\n", ref, pid, pid)
		default:
			fmt.Fprintf(c.out, "%s (%s) is %s; read it: termote agents read %s\n", ref, pid, dash(plainText(p.status())), pid)
		}
	}
}

// waitNothing: no pane works and none ended since the mark, so nothing
// would ever end the wait.
func (c *cli) waitNothing(s Snapshot, ids []string, refs map[string]string, latest uint64) error {
	fmt.Fprintln(c.out, "Nothing to wait for: no pane is working and none ended a turn since the mark.")
	c.waitStatus(s, ids, refs)
	fmt.Fprintf(c.out, "next wait starts after %d\n", latest)
	return &exitError{code: agentsExitIdle}
}

// waitReset: the server dropped the changes after the mark (too many, or it
// restarted), so each pane is read again rather than guessed.
func (c *cli) waitReset(s Snapshot, ids []string, refs map[string]string, latest uint64) error {
	fmt.Fprintln(c.out, "history was reset; check each pane with read")
	c.waitStatus(s, ids, refs)
	fmt.Fprintf(c.out, "next: termote agents wait %s --after %d\n", waitIDs(ids), latest)
	return &exitError{code: agentsExitReset}
}

// findAgentPane finds pane id in s.
func findAgentPane(s Snapshot, id string) (snapPane, bool) {
	for _, p := range snapshotPanes(s) {
		if p.pane.ID == id {
			return p, true
		}
	}
	return snapPane{}, false
}

func (c *cli) agentsAnswer(args []string) error {
	text := ""
	hasText := false
	fs := c.newFlagSet("agents answer")
	fs.Func("text", "", func(s string) error { text, hasText = s, true; return nil })
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) < 1 || len(pos) > 2 || (hasText && len(pos) == 2) {
		return usageError(agentsUsage)
	}
	var choice any
	switch {
	case hasText:
		choice = map[string]string{"text": text}
	case len(pos) == 2:
		if n, err := strconv.Atoi(pos[1]); err == nil {
			choice = n
		} else if pos[1] == "cancel" || pos[1] == "next" {
			choice = pos[1]
		} else {
			return usageError("the answer is an option's number, cancel, next or --text <answer>\n%s", agentsUsage)
		}
	}
	port, err := c.agentsPort()
	if err != nil {
		return err
	}
	p, err := c.agentsPane(port, pos[0])
	if err != nil {
		return err
	}
	var pr promptResponse
	if err := c.agentsGet(port, panePath(p.pane.ID, "/agent/prompt"), &pr); err != nil {
		return err
	}
	if pr.Prompt == nil {
		fmt.Fprintf(c.out, "%s (%s) shows no dialog.\n", plainText(p.ref()), plainText(p.pane.ID))
		if choice != nil {
			return &exitError{code: 1}
		}
		return nil
	}
	if choice == nil {
		c.printPrompt(*pr.Prompt, p.pane.ID)
		return nil
	}
	if pr.Prompt.PromptID == "" {
		c.printPrompt(*pr.Prompt, p.pane.ID)
		if pr.Prompt.Kind == "unsupported" {
			return errors.New("this dialog cannot be answered from termote; ask the user to answer it in the terminal")
		}
		return errors.New("the dialog cannot be answered right now (it was just answered, or the agent does not show it waiting yet); check again in a moment")
	}
	r, err := c.agentsCall(port, http.MethodPost, panePath(p.pane.ID, "/agent/answer"),
		map[string]any{"promptId": pr.Prompt.PromptID, "choice": choice}, agentsWriteTimeout)
	if err != nil {
		return err
	}
	if r.status == http.StatusNoContent {
		c.infof("Answered the dialog of %s (%s)", plainText(p.ref()), plainText(p.pane.ID))
		return nil
	}
	e := r.failure()
	var now AgentPrompt
	if e.Code == "prompt_changed" && json.Unmarshal(e.Prompt, &now) == nil && now.Kind != "" {
		fmt.Fprintln(c.out, "The dialog changed; it now reads:")
		c.printPrompt(now, p.pane.ID)
	}
	return agentsRefusal(r)
}

// agentsStop ends the turn the agent in a pane is running, as Esc in its
// terminal, only in the session cursor (from read --json) names. A session
// changed since is refused and never tried again: the caller looks again.
func (c *cli) agentsStop(args []string) error {
	cursor := ""
	fs := c.newFlagSet("agents stop")
	fs.StringVar(&cursor, "cursor", "", "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) != 1 || cursor == "" {
		return usageError(agentsUsage)
	}
	port, err := c.agentsPort()
	if err != nil {
		return err
	}
	p, err := c.agentsPane(port, pos[0])
	if err != nil {
		return err
	}
	r, err := c.agentsCall(port, http.MethodPost, panePath(p.pane.ID, "/agent/interrupt"), map[string]string{"cursor": cursor}, agentsWriteTimeout)
	if err != nil {
		return err
	}
	if r.status != http.StatusNoContent {
		return agentsRefusal(r)
	}
	id := plainText(p.pane.ID)
	c.infof("Stopped the turn of %s (%s); it may take a moment to settle: termote agents list", plainText(p.ref()), id)
	if p.pane.Agent.Name == "claude" {
		// Claude Code puts the messages it had queued back into its input
		// box when its turn is interrupted.
		c.warnf("a message queued for it may be back in its input box; a send is then refused (input_has_draft) until the user sends or clears it")
	}
	return nil
}

// printPrompt prints a dialog and how to answer it.
func (c *cli) printPrompt(p AgentPrompt, paneID string) {
	fmt.Fprintf(c.out, "Dialog (%s): %s\n", plainText(p.Kind), plainText(p.Title))
	if p.Body != "" {
		fmt.Fprintf(c.out, "%s\n", cleanOut(p.Body))
	}
	for _, o := range p.Options {
		mark := ""
		if o.Checked {
			mark = " [x]"
		}
		fmt.Fprintf(c.out, "  %d. %s%s", o.Index, plainText(o.Label), mark)
		if o.Detail != "" {
			fmt.Fprintf(c.out, " - %s", clipLine(o.Detail, 200))
		}
		fmt.Fprintln(c.out)
	}
	if p.FreeText != nil {
		fmt.Fprintf(c.out, "  %d. %s (answer with --text)\n", p.FreeText.Index, plainText(p.FreeText.Label))
	}
	if p.Kind == "unsupported" {
		fmt.Fprintln(c.out, "This dialog cannot be answered from termote: the user answers it in the terminal.")
		return
	}
	if p.PromptID == "" {
		fmt.Fprintln(c.out, "It cannot be answered right now (just answered, or not shown as waiting yet); check again in a moment.")
		return
	}
	id := plainText(paneID)
	fmt.Fprintf(c.out, "Answer: termote agents answer %s <number> | cancel", id)
	if p.Kind == "multiselect" {
		fmt.Fprint(c.out, " | next")
	}
	if p.FreeText != nil {
		fmt.Fprintf(c.out, " | --text <answer>")
	}
	fmt.Fprintln(c.out)
}

func (c *cli) agentsStart(args []string) error {
	var workspace, kind, name, branch, base string
	fs := c.newFlagSet("agents start")
	fs.StringVar(&workspace, "workspace", "", "")
	fs.StringVar(&kind, "kind", "", "")
	fs.StringVar(&name, "name", "", "")
	fs.StringVar(&branch, "worktree", "", "")
	fs.StringVar(&base, "base", "", "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if workspace == "" || kind == "" || len(pos) > 1 || base != "" && branch == "" {
		return usageError(agentsUsage)
	}
	if _, ok := agentStartArgs[kind]; !ok {
		return usageError("--kind is claude, codex or opencode")
	}
	// The prompt is the agent's first message, handed to it at its start
	// (the server reads it from a file, never typing it): Codex has no
	// session to send one to before that, and an OpenCode session named at
	// its start is made by it.
	prompt := ""
	if len(pos) == 1 {
		if prompt, err = c.readText(pos[0]); err != nil {
			return err
		}
		if strings.TrimSpace(prompt) == "" {
			return usageError("the prompt is empty")
		}
		if len(prompt) > agentMaxText {
			return fmt.Errorf("the prompt is longer than %d KB", agentMaxText/1024)
		}
	}
	port, err := c.agentsPort()
	if err != nil {
		return err
	}
	s, err := c.agentsSnapshot(port)
	if err != nil {
		return err
	}
	if !s.Caps.AgentStart {
		return fmt.Errorf("the %s backend of this server cannot start agents", plainText(s.Backend))
	}
	g, err := resolveGroup(s, workspace)
	if err != nil {
		return err
	}
	var t startTarget
	if branch != "" {
		t, err = c.worktreeTarget(port, s, g, kind, branch, base, name)
	} else {
		t, err = c.tabTarget(port, g, name)
	}
	if err != nil {
		return err
	}
	return c.startInPane(port, t, kind, prompt)
}

// startTarget is the fresh shell an agent starts in, and how to name it.
type startTarget struct {
	paneID string
	dir    string
	where  string // workspace, and branch for a worktree, as printed
	// undo removes what the start made when it was refused for sure; nil
	// keeps it (a worktree is never removed).
	undo func()
	// keep is said of what stays after a failure, nil when nothing does.
	keep string
	// used: the pane was not opened by this command (a worktree workspace
	// a run before opened), so its shell may hold the user's typing.
	used bool
}

// fail is err of a start refused for sure, with what it made undone, or
// named when it stays.
func (t startTarget) fail(err error) error {
	if t.undo != nil {
		t.undo()
		return err
	}
	return t.note(err)
}

// note is err with what the start made and keeps named.
func (t startTarget) note(err error) error {
	if t.keep != "" {
		return fmt.Errorf("%w (%s)", err, t.keep)
	}
	return err
}

// tabTarget opens a new tab of g, which opens where the backend opens a tab
// of it (tmux: the session's own directory), not necessarily where its
// panes are now.
func (c *cli) tabTarget(port int, g Group, name string) (startTarget, error) {
	r, err := c.agentsCall(port, http.MethodPost, "/api/mux/tabs", map[string]string{"groupId": g.ID, "name": name}, agentsReadTimeout)
	if err != nil {
		return startTarget{}, err
	}
	if r.status != http.StatusOK {
		return startTarget{}, agentsRefusal(r)
	}
	var tab struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(r.body, &tab) != nil || tab.ID == "" {
		return startTarget{}, errors.New("unexpected answer from the server to the new tab")
	}
	s, err := c.agentsSnapshot(port)
	if err != nil {
		return startTarget{}, err
	}
	var p snapPane
	found := false
	for _, sp := range snapshotPanes(s) {
		if sp.group.ID == g.ID && sp.tab.ID == tab.ID {
			p, found = sp, true
			break
		}
	}
	if !found {
		return startTarget{}, fmt.Errorf("the new tab %s is not in the snapshot", plainText(tab.ID))
	}
	// undo removes the new tab when the start was refused for sure, so a
	// refused start leaves no shell tab behind.
	t := startTarget{paneID: p.pane.ID, dir: p.cwd(), where: plainText(g.Name), undo: func() {
		c.agentsCall(port, http.MethodDelete, "/api/mux/tabs/"+url.PathEscape(tab.ID)+"?key="+url.QueryEscape(p.tab.Key), nil, agentsReadTimeout)
	}}
	// The folder list showed, and the user agreed to, is where the agent
	// starts, or nothing starts.
	if want, got := groupCwd(g), p.cwd(); want != "" && got != "" && want != got {
		return startTarget{}, t.fail(fmt.Errorf("a new tab of %s opens in %s, not in %s where its panes are; nothing was started (ask the user which workspace to use)",
			plainText(g.Name), plainText(got), plainText(want)))
	}
	return t, nil
}

// startInPane starts kind in t's pane, a shell opened just now, and follows
// the start until it is final.
func (c *cli) startInPane(port int, t startTarget, kind, prompt string) error {
	paneID := t.paneID
	// newTab: the shell was opened just now (a new tab, or a new worktree's
	// workspace), so it gets no C-c: its rc files may still run, and the
	// C-c would cut them short. A pane opened before gets the C-c and the
	// idle checks, which clear what the user may have half typed.
	start := map[string]any{"kind": kind, "newTab": !t.used}
	if prompt != "" {
		start["prompt"] = prompt
	}
	hint := c.afterHint(port, paneID)
	r, err := c.agentsCall(port, http.MethodPost, panePath(paneID, "/agent/start"), start, agentsStartTimeout)
	if err != nil {
		return t.note(err)
	}
	// start_unknown: the server could not tell whether the command was
	// typed and follows the start as if it was; starting: one is already
	// under way there. Both are followed, as the PWA does.
	if code := r.failure().Code; r.status != http.StatusOK && code != "start_unknown" && code != "starting" {
		return t.fail(agentsRefusal(r))
	}
	// Only a 200 says whether the prompt was taken; start_unknown and
	// starting are followed without claiming it.
	took := r.status == http.StatusOK && startTookPrompt(r)
	if r.status == http.StatusOK && prompt != "" && !took {
		return t.note(fmt.Errorf("the running server is older than this command: %s runs in pane %s without the prompt; restart the server (termote restart), then give it the task there (Claude Code: termote agents send %s -)",
			kind, plainText(paneID), plainText(paneID)))
	}
	state, err := c.followAgentStart(port, paneID)
	if err != nil {
		return t.note(err)
	}
	dir := dash(plainText(t.dir))
	withPrompt := ""
	if took {
		withPrompt = " with the prompt" + hint
	}
	switch state {
	case startReady:
	case startBlocked:
		c.infof("Started %s in pane %s (%s, in %s)%s; it waits on a dialog: termote agents answer %s", kind, plainText(paneID), t.where, dir, withPrompt, plainText(paneID))
		return &exitError{code: agentsExitDialog}
	case startExited:
		return t.fail(fmt.Errorf("%s did not start in pane %s: its command ended (is it installed?)", kind, plainText(paneID)))
	default:
		return t.note(fmt.Errorf("%s did not start in pane %s (%s); see: termote agents list", kind, plainText(paneID), plainText(state)))
	}
	c.infof("Started %s in pane %s (%s, in %s)%s", kind, plainText(paneID), t.where, dir, withPrompt)
	return nil
}

// startTookPrompt: the start's answer says the prompt was taken; a server
// older than this command ignores it and starts the agent without it.
func startTookPrompt(r agentsReply) bool {
	var took struct {
		Prompt bool `json:"prompt"`
	}
	return json.Unmarshal(r.body, &took) == nil && took.Prompt
}

// followAgentStart polls the start in paneID until it is final, a little
// past the server's own deadline for it.
func (c *cli) followAgentStart(port int, paneID string) (string, error) {
	return c.followAgentStartWithin(port, paneID, agentStartTimeout+agentStartGrace+10*time.Second)
}

// followAgentStartWithin is followAgentStart giving up after limit.
func (c *cli) followAgentStartWithin(port int, paneID string, limit time.Duration) (string, error) {
	deadline := time.Now().Add(limit)
	for {
		var st struct {
			State string `json:"state"`
		}
		if err := c.agentsGet(port, panePath(paneID, "/agent/start"), &st); err != nil {
			return "", err
		}
		if startFinal(st.State) {
			return st.State, nil
		}
		if time.Now().After(deadline) {
			return startTimeout, nil
		}
		time.Sleep(agentsStartEvery)
	}
}

// resolveGroup finds the workspace name names: its id, else the only one
// with that name.
func resolveGroup(s Snapshot, name string) (Group, error) {
	for _, g := range s.Groups {
		if g.ID == name {
			return g, nil
		}
	}
	var found []Group
	for _, g := range s.Groups {
		if g.Name == name {
			found = append(found, g)
		}
	}
	switch len(found) {
	case 0:
		return Group{}, fmt.Errorf("no workspace is named %q; see: termote agents list", plainText(name))
	case 1:
		return found[0], nil
	}
	ids := make([]string, len(found))
	for i, g := range found {
		ids[i] = plainText(g.ID)
	}
	return Group{}, fmt.Errorf("%d workspaces are named %q; name one by its id: %s", len(found), plainText(name), strings.Join(ids, ", "))
}

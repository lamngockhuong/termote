package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// A delegated answer (termote agents answer <pane> --delegated): the
// orchestrator answers a Claude Code permission dialog under a grant the
// user gave from the PWA (job_grants.go). The server decides, never the
// caller: the dialog on screen and the one tool call the main transcript
// has waiting must name the same command or file, the command or file must
// pass agent_delegate_rules.go, a grant in force for that agent must cover
// it, and the option chosen is always the one labelled "Yes", never one
// that stops asking. Anything it cannot read for sure is refused, and the
// user is asked as before.

// delegateHeaders maps a Claude Code permission dialog's header to the
// grant kind and the tools it can stand for.
var delegateHeaders = map[string]struct {
	kind  string
	tools []string
}{
	"Bash command":   {"bash", []string{"Bash"}},
	"Run command":    {"bash", []string{"Bash"}},
	"Edit file":      {"edit", []string{"Edit", "MultiEdit"}},
	"Write file":     {"edit", []string{"Write"}},
	"Create file":    {"edit", []string{"Write"}},
	"Overwrite file": {"edit", []string{"Write"}},
}

// delegateBashKeys are the only inputs a delegated Bash call may have: one
// in the background, or with anything else, is refused.
var delegateBashKeys = []string{"command", "description", "timeout"}

// delegateTailMax bounds the end of the transcript read for the waiting
// tool call.
var delegateTailMax int64 = 4 << 20

// pendingTool is a tool call of the main conversation with no result yet.
type pendingTool struct {
	ID    string
	Name  string
	Input map[string]any
}

// pendingTools reads, from the end of s's transcript, the tool calls of the
// main conversation (no subagent's) that have no result yet. Claude Code
// writes a call before it draws the call's dialog (measured on 2.1.330: 50
// to 110 ms ahead); two calls of one message are both left out until both
// are done, so a dialog of either finds none waiting and is refused.
func pendingTools(s AgentSession) ([]pendingTool, error) {
	path, err := claudeJournal{}.Locate(s)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	start := max(fi.Size()-delegateTailMax, 0)
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(f, delegateTailMax))
	if err != nil {
		return nil, err
	}
	if start > 0 {
		// The first line read is cut.
		if i := bytes.IndexByte(data, '\n'); i >= 0 {
			data = data[i+1:]
		} else {
			data = nil
		}
	}
	var uses []pendingTool
	done := map[string]bool{}
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 64<<10), int(delegateTailMax)+1)
	for sc.Scan() {
		var row struct {
			Type        string `json:"type"`
			IsSidechain bool   `json:"isSidechain"`
			Message     struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(sc.Bytes(), &row) != nil || row.IsSidechain || (row.Type != "assistant" && row.Type != "user") {
			continue
		}
		var blocks []struct {
			Type      string         `json:"type"`
			ID        string         `json:"id"`
			Name      string         `json:"name"`
			Input     map[string]any `json:"input"`
			ToolUseID string         `json:"tool_use_id"`
		}
		if json.Unmarshal(row.Message.Content, &blocks) != nil {
			continue
		}
		for _, b := range blocks {
			switch b.Type {
			case "tool_use":
				uses = append(uses, pendingTool{ID: b.ID, Name: b.Name, Input: b.Input})
			case "tool_result":
				done[b.ToolUseID] = true
			}
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return slices.DeleteFunc(uses, func(u pendingTool) bool { return u.ID == "" || done[u.ID] }), nil
}

// dialogCommand is the command a Bash permission dialog shows between its
// two dashed rules under the header, a wrapped row marked "│ ", as its
// words; ok is false when the screen does not show it that way.
func dialogCommand(screen, header string) (words []string, ok bool) {
	lines := parseScreen(screen)
	h := -1
	for i, l := range lines {
		if strings.TrimSpace(l.text) == header {
			h = i
		}
	}
	if h < 0 {
		return nil, false
	}
	var rules []int
	for i := h + 1; i < len(lines) && len(rules) < 2; i++ {
		if isDashedRule(lines[i].text) {
			rules = append(rules, i)
		}
	}
	if len(rules) < 2 || rules[1]-rules[0] < 2 {
		return nil, false
	}
	for _, l := range lines[rules[0]+1 : rules[1]] {
		t := strings.TrimSpace(l.text)
		t = strings.TrimSpace(strings.TrimPrefix(t, "│"))
		words = append(words, strings.Fields(t)...)
	}
	return words, len(words) > 0
}

// dialogPath is the file an edit dialog names on the row under its header.
func dialogPath(screen, header string) (string, bool) {
	lines := parseScreen(screen)
	h := -1
	for i, l := range lines {
		if strings.TrimSpace(l.text) == header {
			h = i
		}
	}
	if h < 0 || h+1 >= len(lines) {
		return "", false
	}
	p := strings.TrimSpace(lines[h+1].text)
	return p, p != "" && !strings.ContainsAny(p, " \t")
}

// delegation is a dialog a grant covers: the job and grant, and what the
// dialog asked for (one of command and path).
type delegation struct {
	jobID, grantID string
	yes            int
	command, path  string
}

// grantInForce: g of j still lets its agent's dialogs be answered at now.
func grantInForce(j job, g grant, now time.Time) bool {
	if g.Revoked != "" || jobFinished(j.State) || j.Agent == nil || !sameJobAgent(*j.Agent, g.Agent) {
		return false
	}
	exp, err := time.Parse(time.RFC3339Nano, g.Expires)
	return err == nil && now.Before(exp)
}

// sameJobAgent: a and b record the same agent.
func sameJobAgent(a, b jobAgent) bool {
	if a.Key != b.Key || a.Kind != b.Kind || a.PID != b.PID || a.Start != b.Start {
		return false
	}
	return a.PID != 0 || a.Session == b.Session
}

// checkDelegation decides whether the dialog on screen in pane p, run by
// s, may be answered under a grant, and with which option.
func (a *agentAPI) checkDelegation(p snapPane, s AgentSession, sc agentScreen, screen string) (delegation, error) {
	if s.Agent != "claude" {
		return delegation{}, refuseDelegation("not_claude")
	}
	pr := sc.prompt
	if pr == nil || pr.Kind != "permission" || pr.textTitle {
		return delegation{}, refuseDelegation("unparsed")
	}
	h, ok := delegateHeaders[pr.Title]
	if !ok {
		return delegation{}, refuseDelegation("unparsed")
	}
	d := delegation{}
	for _, o := range pr.Options {
		if o.Label == "Yes" {
			if d.yes != 0 {
				return delegation{}, refuseDelegation("no_yes")
			}
			d.yes = o.Index
		}
	}
	if d.yes == 0 {
		return delegation{}, refuseDelegation("no_yes")
	}
	tree, err := a.subagentTree(s)
	if err != nil {
		return delegation{}, refuseDelegation("subagent")
	}
	if anySubagentRunning(tree.Nodes) {
		return delegation{}, refuseDelegation("subagent")
	}
	pending, err := pendingTools(s)
	switch {
	case err != nil || len(pending) == 0:
		return delegation{}, refuseDelegation("unparsed")
	case len(pending) > 1:
		return delegation{}, refuseDelegation("pending_many")
	}
	call := pending[0]
	if !slices.Contains(h.tools, call.Name) {
		return delegation{}, refuseDelegation("mismatch")
	}
	grants := a.grantsFor(p, s, h.kind)
	if h.kind == "bash" {
		for k := range call.Input {
			if !slices.Contains(delegateBashKeys, k) {
				return delegation{}, refuseDelegation("input_keys")
			}
		}
		cmd, _ := call.Input["command"].(string)
		if code := checkDelegateCommand(cmd, ""); code != "" {
			return delegation{}, refuseDelegation(code)
		}
		words, ok := dialogCommand(screen, pr.Title)
		if !ok || !slices.Equal(words, strings.Fields(cmd)) {
			return delegation{}, refuseDelegation("mismatch")
		}
		why := "no_grant"
		for _, g := range grants {
			switch code := checkDelegateCommand(cmd, g.grant.Prefix); code {
			case "":
				d.jobID, d.grantID, d.command = g.job, g.grant.ID, cmd
				return d, nil
			case "no_grant":
			default:
				// The prefix matched but a word after it is an option.
				why = code
			}
		}
		return delegation{}, refuseDelegation(why)
	}
	file, _ := call.Input["file_path"].(string)
	shown, ok := dialogPath(screen, pr.Title)
	if file == "" || !filepath.IsAbs(file) || !ok {
		return delegation{}, refuseDelegation("mismatch")
	}
	why := "no_grant"
	for _, g := range grants {
		rel, err := filepath.Rel(g.grant.Dir, file)
		if g.grant.Dir == "" || err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		if filepath.ToSlash(rel) != shown {
			why = "mismatch"
			continue
		}
		if code := checkDelegatePath(rel); code != "" {
			why = code
			continue
		}
		if code := checkDelegateFile(g.grant.Dir, rel); code != "" {
			why = code
			continue
		}
		if code := checkDelegateHook(g.grant.Dir, rel); code != "" {
			why = code
			continue
		}
		d.jobID, d.grantID, d.path = g.job, g.grant.ID, filepath.ToSlash(rel)
		return d, nil
	}
	return delegation{}, refuseDelegation(why)
}

func anySubagentRunning(nodes []subagentNode) bool {
	for _, n := range nodes {
		if n.Status == "running" || anySubagentRunning(n.Children) {
			return true
		}
	}
	return false
}

type jobGrant struct {
	job   string
	grant grant
}

// grantsFor lists the grants in force of kind for the agent s runs in p.
func (a *agentAPI) grantsFor(p snapPane, s AgentSession, kind string) []jobGrant {
	if a.jobs == nil {
		return nil
	}
	list, _ := a.jobs.jobs()
	now := a.jobs.now()
	var out []jobGrant
	for _, j := range list {
		for _, g := range j.Grants {
			if g.Kind == kind && grantInForce(j, g, now) && g.Agent.matches(p, s) {
				out = append(out, jobGrant{j.ID, g})
			}
		}
	}
	return out
}

// delegatedAnswer checks the dialog of paneID under the pane's lock and
// returns the option to answer with. promptID must name the dialog on
// screen now.
func (a *agentAPI) delegatedAnswer(ctx context.Context, wr agentWriter, paneID, promptID string) (delegation, error) {
	s, err := sessionNow(ctx, wr, paneID)
	if err != nil {
		return delegation{}, err
	}
	screen, err := wr.Capture(ctx, s.Target)
	if err != nil {
		return delegation{}, err
	}
	sc := readAgentScreen(s.Agent, screen)
	if !a.input.promptIs(paneID, promptID, sc.sig, s) {
		f := fail(409, "prompt_changed", "the screen changed; check the dialog again")
		f.prompt = a.promptOf(paneID, s, sc)
		return delegation{}, f
	}
	p, ok := a.paneNow(paneID)
	if !ok {
		return delegation{}, errTargetChanged
	}
	return a.checkDelegation(p, s, sc, screen)
}

// paneNow is paneID's pane in the tracker's last snapshot, else in a new
// one.
func (a *agentAPI) paneNow(paneID string) (snapPane, bool) {
	find := func(snap Snapshot) (snapPane, bool) {
		for _, sp := range snapshotPanes(snap) {
			if sp.pane.ID == paneID {
				return sp, true
			}
		}
		return snapPane{}, false
	}
	snap, _ := a.activity.lastSnapshot()
	if p, ok := find(snap); ok {
		return p, true
	}
	ctx, cancel := context.WithTimeout(context.Background(), muxTimeout)
	defer cancel()
	snap, err := a.m.Snapshot(ctx)
	if err != nil {
		return snapPane{}, false
	}
	return find(snap)
}

// recordDelegation keeps the answer on its grant and job, and in the log:
// the command's hash only, never the command.
func (a *agentAPI) recordDelegation(paneID string, d delegation, confirmed bool) {
	sum := sha256.Sum256([]byte(d.command + d.path))
	auditf("dialog_delegated", "grant", d.grantID, "job", d.jobID, "pane", paneID, "path", d.path,
		"command_sha256", hex.EncodeToString(sum[:]), "confirmed", confirmed)
	if a.jobs == nil {
		return
	}
	_, err := a.jobs.update(d.jobID, "", func(j *job) error {
		at := a.jobs.now().UTC().Format(activityTimeFormat)
		for i := range j.Grants {
			if j.Grants[i].ID != d.grantID {
				continue
			}
			j.Grants[i].Uses = append(j.Grants[i].Uses, grantUse{At: at, Command: cutRunes(d.command, maxGrantCommand), Path: d.path})
			if n := len(j.Grants[i].Uses) - maxGrantUses; n > 0 {
				j.Grants[i].Uses = slices.Delete(j.Grants[i].Uses, 0, n)
			}
		}
		text := d.command
		if text == "" {
			text = d.path
		}
		a.jobs.addEvent(j, "delegated", text)
		return nil
	})
	if err != nil && !errors.Is(err, errJobNotFound) {
		auditf("dialog_delegated_unrecorded", "grant", d.grantID, "job", d.jobID)
	}
}

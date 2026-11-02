package main

import (
	"cmp"
	"encoding/json"
	"errors"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
)

// The state of herdr-core as termote keeps it: terminals from the events
// stream, herdr-app's layout document (read only), and the snapshot built
// from both. Every string from the core is untrusted: names and titles are
// cleaned, argv and pids never reach a snapshot.

// Limits on herdr-app's document: deeper or bigger is not a layout herdr-app
// writes, and is dropped for the label fallback.
const (
	hcDocMaxDepth = 32
	hcDocMaxNodes = 4096
)

// hcEvent is the params of an "event" notification (schema/README.md, Events).
type hcEvent struct {
	Seq      uint64          `json:"seq"`
	Type     string          `json:"type"`
	Terminal string          `json:"terminal"`
	Machine  *string         `json:"machine"`
	Data     json.RawMessage `json:"data"`
}

// hcMissed is the params of a "missed" notification: a fresh snapshot.
type hcMissed struct {
	Seq       uint64       `json:"seq"`
	Terminals []hcTerminal `json:"terminals"`
}

// hcDoc is herdr-app's layout document (herdr-app src/mirror.rs Document @f896da4).
type hcDoc struct {
	Spaces []hcDocSpace `json:"spaces"`
}

type hcDocSpace struct {
	ID     string     `json:"id"`
	Name   string     `json:"name"`
	Folder string     `json:"folder"`
	Tabs   []hcDocTab `json:"tabs"`
}

type hcDocTab struct {
	ID   string  `json:"id"`
	Name string  `json:"name"`
	Root *hcNode `json:"root"`
}

// hcNode is a node of a tab's tree (herdr-app src/layout.rs Node): a block
// (terminal, mod, ...) or a row, column or stack of nodes, with blocks
// floating over it.
type hcNode struct {
	ID       string    `json:"id"`
	Type     string    `json:"type"`
	Content  hcContent `json:"content"`
	Children []hcNode  `json:"children"`
	Active   *string   `json:"active"`
	Hidden   bool      `json:"hidden"`
	Floating []struct {
		ID      string    `json:"id"`
		Content hcContent `json:"content"`
	} `json:"floating"`
}

// hcContent is what a block shows; only a terminal matters here.
type hcContent struct {
	Terminal string `json:"terminal"`
}

// parseHcDoc reads herdr-app's document. A value of another shape, or past
// the limits, is an error: the snapshot then places terminals by label.
func parseHcDoc(raw json.RawMessage) (*hcDoc, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var d hcDoc
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, err
	}
	nodes := 0
	var walk func(n *hcNode, depth int) error
	walk = func(n *hcNode, depth int) error {
		nodes += 1 + len(n.Floating)
		if depth > hcDocMaxDepth || nodes > hcDocMaxNodes {
			return errors.New("herdr-app document too deep or too big")
		}
		for i := range n.Children {
			if err := walk(&n.Children[i], depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	for _, s := range d.Spaces {
		if s.ID == "" {
			return nil, errors.New("herdr-app document: space without id")
		}
		for _, t := range s.Tabs {
			if t.ID == "" {
				return nil, errors.New("herdr-app document: tab without id")
			}
			if t.Root != nil {
				if err := walk(t.Root, 0); err != nil {
					return nil, err
				}
			}
		}
	}
	return &d, nil
}

// hcTabPlan is one tab's terminals in the document's tree order and the rect
// of each one shown, in cells.
type hcTabPlan struct {
	terminals []string
	rects     map[string]PaneLayout
	cols      int
	rows      int
}

// planHcTab walks a tab's tree. Every terminal in it is a pane of the tab,
// floating, hidden or behind a stack's active child included; only the tiled
// ones the desktop shows get a rect. herdr-app sizes each terminal to its
// block (weight or px), so a block's cells are its terminal's own size: rows
// add up widths, columns heights, and a stack is its active child.
func planHcTab(root *hcNode, size func(addr string) (int, int)) hcTabPlan {
	p := hcTabPlan{rects: map[string]PaneLayout{}}
	if root == nil {
		return p
	}
	seen := map[string]bool{}
	add := func(t string) {
		if t != "" && !seen[t] {
			seen[t] = true
			p.terminals = append(p.terminals, t)
		}
	}
	var collect func(n *hcNode)
	collect = func(n *hcNode) {
		if n.Type == "block" {
			add(n.Content.Terminal)
		}
		for _, c := range n.Children {
			collect(&c)
		}
		for _, f := range n.Floating {
			add(f.Content.Terminal)
		}
	}
	collect(root)

	// measure returns a node's cells as shown; place then lays it out.
	var measure func(n *hcNode) (int, int)
	visible := func(n *hcNode) []*hcNode {
		var out []*hcNode
		switch n.Type {
		case "stack":
			if c := hcActiveChild(n); c != nil {
				out = append(out, c)
			}
		case "row", "column":
			for i := range n.Children {
				if !n.Children[i].Hidden {
					out = append(out, &n.Children[i])
				}
			}
		}
		return out
	}
	measure = func(n *hcNode) (int, int) {
		if n.Hidden {
			return 0, 0
		}
		if n.Type == "block" {
			if n.Content.Terminal == "" {
				return 0, 0
			}
			return size(n.Content.Terminal)
		}
		w, h := 0, 0
		for _, c := range visible(n) {
			cw, ch := measure(c)
			if n.Type == "column" {
				w, h = max(w, cw), h+ch
			} else if n.Type == "row" {
				w, h = w+cw, max(h, ch)
			} else {
				w, h = cw, ch
			}
		}
		return w, h
	}
	var place func(n *hcNode, x, y, w, h int)
	place = func(n *hcNode, x, y, w, h int) {
		if n.Type == "block" {
			if t := n.Content.Terminal; t != "" && w > 0 && h > 0 {
				p.rects[t] = PaneLayout{ID: t, X: x, Y: y, Cols: w, Rows: h}
			}
			return
		}
		for _, c := range visible(n) {
			cw, ch := measure(c)
			switch n.Type {
			case "row":
				place(c, x, y, cw, h)
				x += cw
			case "column":
				place(c, x, y, w, ch)
				y += ch
			default:
				place(c, x, y, w, h)
			}
		}
	}
	p.cols, p.rows = measure(root)
	place(root, 0, 0, p.cols, p.rows)
	return p
}

// hcActiveChild is a stack's shown child: its active one when visible, else
// the first visible (herdr-app layout.rs active_child).
func hcActiveChild(n *hcNode) *hcNode {
	var first *hcNode
	for i := range n.Children {
		c := &n.Children[i]
		if c.Hidden {
			continue
		}
		if n.Active != nil && c.ID == *n.Active {
			return c
		}
		if first == nil {
			first = c
		}
	}
	return first
}

// hcAgentNames maps an agent's OSC 7501 app to the name Herdr ships for it
// (herdr-app defaults/programs.json: each agent's key and its "match"
// aliases; src/programs.rs agent_name). Claude Code reports claude-code.
var hcAgentNames = map[string]string{
	"claude": "claude", "claude-code": "claude", "codex": "codex", "pi": "pi", "opencode": "opencode",
	"cursor": "cursor", "cursor-agent": "cursor", "copilot": "copilot", "github-copilot": "copilot",
	"amp": "amp", "gemini": "gemini", "grok": "grok", "grok-build": "grok",
}

// hcAgentName is a reported app as a name termote shows: one Herdr ships,
// else "other" ("unknown" when it named none), never the program's own words.
func hcAgentName(app string) string {
	app = strings.ToLower(strings.TrimSpace(app))
	if app == "" {
		return "unknown"
	}
	if n, ok := hcAgentNames[app]; ok {
		return n
	}
	return "other"
}

// hcAgentStatuses are the 7501 words termote shows as they are.
var hcAgentStatuses = map[string]bool{"idle": true, "working": true, "blocked": true, "done": true}

// hcAgent is a terminal's agent as the snapshot shows it, nil when its
// program never reported a status. idle and done follow herdr.seen, shared
// by every Herdr client (herdr-app docs/labels.md): done while a turn ended
// since a person last looked, idle once one has. Without the label the
// program's own word stays.
func hcAgent(t *hcTerminal) *AgentInfo {
	if t.Status == nil {
		return nil
	}
	status := t.Status.State
	if !hcAgentStatuses[status] {
		status = "unknown"
	}
	if status == "idle" || status == "done" {
		if seen, ok := hcSeen(t); ok {
			status = "idle"
			if t.Turn > seen {
				status = "done"
			}
		}
	}
	return &AgentInfo{Name: hcAgentName(t.Status.App), Status: status}
}

// hcSeen is a terminal's herdr.seen label; a missing or unreadable one is
// not 0 (labels.md).
func hcSeen(t *hcTerminal) (uint64, bool) {
	v, ok := t.Labels[hcLabelSeen]
	if !ok {
		return 0, false
	}
	n, err := strconv.ParseUint(v, 10, 64)
	return n, err == nil
}

// hcShown reports whether a terminal is one of herdr's on this machine:
// live, addressed by a local id, with a herdr.space label. Terminals of
// other apps (no label) stay hidden, as in herdr-app.
func hcShown(t *hcTerminal) bool {
	return t.State == "live" && validHcAddress(t.Address) && t.Labels[hcLabelSpace] != "" && t.Labels[hcLabelTab] != ""
}

// hcFolderName names a folder the way herdr-app names a space after one
// (model.rs folder_name): ~ for home, else its last part.
func hcFolderName(path, home string) string {
	full := path
	path = strings.TrimRight(path, `/\`)
	home = strings.TrimRight(home, `/\`)
	same := path == home
	if runtime.GOOS == "windows" {
		same = strings.EqualFold(path, home)
	}
	if full == "" || same {
		return "~"
	}
	if path == "" {
		return full[:1]
	}
	parts := strings.FieldsFunc(path, func(r rune) bool { return r == '/' || r == '\\' })
	if len(parts) == 0 {
		return path
	}
	return parts[len(parts)-1]
}

// hcLiveFolder is where a terminal works now: its foreground's folder, else
// the one it started in.
func hcLiveFolder(t *hcTerminal) string {
	if t.Foreground != nil && t.Foreground.Cwd != "" {
		return t.Foreground.Cwd
	}
	return t.Cwd
}

// hcBuildInput is everything a snapshot is built from.
type hcBuildInput struct {
	terminals map[string]*hcTerminal
	doc       *hcDoc
	home      string
	// top is a folder's git checkout (a worktree's own), "" when not known
	// (yet) or not in one.
	top func(dir string) string
}

// buildHcSnapshot builds the snapshot herdr-app would show: the document's
// spaces, tabs and pane order for the terminals it holds, then terminals it
// does not hold yet (herdr-app not running, or not caught up) placed by
// their herdr.space and herdr.tab labels.
func buildHcSnapshot(in hcBuildInput) Snapshot {
	type tabAcc struct {
		tab  Tab
		plan *hcTabPlan
	}
	type groupAcc struct {
		id, name, folder string
		tabs             []*tabAcc
		tabIdx           map[string]*tabAcc
	}
	var groups []*groupAcc
	groupIdx := map[string]*groupAcc{}
	placed := map[string]bool{}
	size := func(addr string) (int, int) {
		if t := in.terminals[addr]; t != nil {
			return t.Cols, t.Rows
		}
		return 0, 0
	}
	pane := func(t *hcTerminal) Pane {
		p := Pane{ID: t.Address, key: t.Address, Title: cleanPaneName(t.Title), Agent: hcAgent(t)}
		if t.Foreground != nil {
			name := processName(t.Foreground.Name)
			if name != "" {
				p.Process = &ProcessInfo{Name: name, Cwd: processCwd(hcLiveFolder(t))}
			}
		}
		return p
	}
	group := func(id, name, folder string) *groupAcc {
		if g := groupIdx[id]; g != nil {
			return g
		}
		g := &groupAcc{id: id, name: name, folder: folder, tabIdx: map[string]*tabAcc{}}
		groups = append(groups, g)
		groupIdx[id] = g
		return g
	}

	if in.doc != nil {
		for _, s := range in.doc.Spaces {
			g := group(s.ID, s.Name, s.Folder)
			for _, dt := range s.Tabs {
				if g.tabIdx[dt.ID] != nil {
					continue
				}
				plan := planHcTab(dt.Root, size)
				acc := &tabAcc{tab: Tab{ID: dt.ID, Key: dt.ID, Name: dt.Name}, plan: &plan}
				for _, addr := range plan.terminals {
					t := in.terminals[addr]
					if t == nil || !hcShown(t) || placed[addr] {
						continue
					}
					placed[addr] = true
					acc.tab.Panes = append(acc.tab.Panes, pane(t))
				}
				g.tabs = append(g.tabs, acc)
				g.tabIdx[dt.ID] = acc
			}
		}
	}

	// The rest by label, oldest first so a new tab lands last.
	var rest []*hcTerminal
	for addr, t := range in.terminals {
		if !placed[addr] && hcShown(t) {
			rest = append(rest, t)
		}
	}
	slices.SortFunc(rest, func(a, b *hcTerminal) int {
		return cmp.Or(cmp.Compare(a.CreatedMs, b.CreatedMs), cmp.Compare(len(a.Address), len(b.Address)), strings.Compare(a.Address, b.Address))
	})
	for _, t := range rest {
		g := group(t.Labels[hcLabelSpace], "", "")
		tabID := t.Labels[hcLabelTab]
		acc := g.tabIdx[tabID]
		if acc == nil {
			acc = &tabAcc{tab: Tab{ID: tabID, Key: tabID}}
			g.tabs = append(g.tabs, acc)
			g.tabIdx[tabID] = acc
		}
		acc.tab.Panes = append(acc.tab.Panes, pane(t))
	}

	snap := Snapshot{Groups: []Group{}}
	for _, g := range groups {
		out := Group{ID: g.id, Tabs: []Tab{}}
		var first *hcTerminal
		for _, acc := range g.tabs {
			if len(acc.tab.Panes) == 0 {
				continue // herdr-app closes a tab whose terminals ended
			}
			if first == nil {
				first = in.terminals[acc.tab.Panes[0].ID]
			}
			t := acc.tab
			t.Name = cleanPaneName(t.Name)
			if t.Name == "" {
				t.Name = strconv.Itoa(len(out.Tabs) + 1)
			}
			t.Panes[0].Active = true
			t.Active = len(out.Tabs) == 0
			if acc.plan != nil && acc.plan.cols > 0 && acc.plan.rows > 0 {
				l := &TabLayout{Cols: acc.plan.cols, Rows: acc.plan.rows, Panes: []PaneLayout{}}
				for _, p := range t.Panes {
					if r, ok := acc.plan.rects[p.ID]; ok {
						l.Panes = append(l.Panes, r)
					}
				}
				t.Layout = l
			}
			out.Tabs = append(out.Tabs, t)
		}
		if len(out.Tabs) == 0 {
			continue
		}
		out.Name = cleanPaneName(g.name)
		if out.Name == "" {
			out.Name = hcSpaceName(first, g.folder, in)
		}
		snap.Groups = append(snap.Groups, out)
	}
	return snap
}

// hcSpaceName names a space that has no name the way herdr-app does
// (model.rs space_name): after its first terminal's git checkout, else
// that terminal's folder, else the space's folder.
func hcSpaceName(first *hcTerminal, folder string, in hcBuildInput) string {
	dir := ""
	if first != nil {
		live := hcLiveFolder(first)
		if in.top != nil && live != "" {
			dir = in.top(live)
		}
		if dir == "" {
			dir = live
		}
	}
	if dir == "" {
		dir = folder
	}
	return cleanPaneName(hcFolderName(dir, in.home))
}

// hcState is the core's state as the events stream told it.
type hcState struct {
	mu        sync.Mutex
	seq       uint64
	terminals map[string]*hcTerminal
	doc       *hcDoc
	docVer    uint64
	docBad    uint64 // the last version that failed to parse, logged once
}

func newHcState() *hcState { return &hcState{terminals: map[string]*hcTerminal{}} }

// reset takes a fresh snapshot (subscribe, missed, reconnect).
func (s *hcState) reset(seq uint64, terminals []hcTerminal) {
	m := make(map[string]*hcTerminal, len(terminals))
	for i := range terminals {
		t := terminals[i]
		m[t.Address] = &t
	}
	s.mu.Lock()
	s.seq, s.terminals = seq, m
	s.mu.Unlock()
}

// upsert adds or replaces a terminal record termote got from a reply (run),
// so its tab shows before the created event arrives.
func (s *hcState) upsert(t hcTerminal) {
	s.mu.Lock()
	s.terminals[t.Address] = &t
	s.mu.Unlock()
}

// apply applies one event, skipping those a snapshot already holds. It
// reports a doc event for herdr-app's document on this machine.
func (s *hcState) apply(ev hcEvent) (docVersion uint64, isDoc bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ev.Seq <= s.seq {
		return 0, false
	}
	s.seq = ev.Seq
	if ev.Type == "doc" {
		var d struct {
			Name    string `json:"name"`
			Version uint64 `json:"version"`
		}
		if ev.Machine == nil && json.Unmarshal(ev.Data, &d) == nil && d.Name == hcAppDoc {
			return d.Version, true
		}
		return 0, false
	}
	if ev.Type == "created" || ev.Type == "restarted" {
		var t hcTerminal
		if json.Unmarshal(ev.Data, &t) == nil && t.Address != "" {
			s.terminals[t.Address] = &t
		}
		return 0, false
	}
	if ev.Type == "removed" {
		delete(s.terminals, ev.Terminal)
		return 0, false
	}
	t := s.terminals[ev.Terminal]
	if t == nil {
		if ev.Type == "labels" {
			var d struct {
				Record *hcTerminal `json:"record"`
			}
			if json.Unmarshal(ev.Data, &d) == nil && d.Record != nil && d.Record.Address != "" {
				s.terminals[d.Record.Address] = d.Record
			}
		}
		return 0, false
	}
	c := *t // records are replaced, never changed in place: build reads them unlocked
	switch ev.Type {
	case "lost", "finished":
		var d struct {
			Reason *string `json:"reason"`
		}
		json.Unmarshal(ev.Data, &d)
		c.Reason, c.Foreground = d.Reason, nil
		if ev.Type == "finished" {
			c.State = "finished"
		}
	case "keep":
		var d struct{ Keep bool }
		json.Unmarshal(ev.Data, &d)
		c.Keep = d.Keep
	case "status":
		var d struct {
			Status *hcStatus `json:"status"`
		}
		json.Unmarshal(ev.Data, &d)
		c.Status = d.Status
	case "turn":
		var d struct{ Turn uint64 }
		json.Unmarshal(ev.Data, &d)
		c.Turn = d.Turn
	case "title":
		var d struct{ Title string }
		json.Unmarshal(ev.Data, &d)
		c.Title = d.Title
	case "labels":
		var d struct {
			Labels map[string]string `json:"labels"`
		}
		json.Unmarshal(ev.Data, &d)
		if d.Labels != nil {
			c.Labels = d.Labels
		}
	case "size":
		var d struct{ Cols, Rows int }
		json.Unmarshal(ev.Data, &d)
		c.Cols, c.Rows = d.Cols, d.Rows
	case "foreground":
		var fg *hcForeground
		json.Unmarshal(ev.Data, &fg)
		c.Foreground = fg
	default:
		return 0, false
	}
	s.terminals[ev.Terminal] = &c
	return 0, false
}

// setDoc keeps a document read at version; an older read than the one kept
// is dropped. A nil doc (unwritten, or not parsed) falls back to labels.
func (s *hcState) setDoc(version uint64, doc *hcDoc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if version < s.docVer {
		return
	}
	s.doc, s.docVer = doc, version
}

// docVersion is the version of the document kept.
func (s *hcState) docVersion() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.docVer
}

// input is what a snapshot is built from now; the records are shared, not
// copied, as apply replaces them rather than changing them.
func (s *hcState) input() hcBuildInput {
	s.mu.Lock()
	defer s.mu.Unlock()
	terms := make(map[string]*hcTerminal, len(s.terminals))
	for k, v := range s.terminals {
		terms[k] = v
	}
	return hcBuildInput{terminals: terms, doc: s.doc}
}

// terminal is a copy of one record.
func (s *hcState) terminal(addr string) (hcTerminal, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.terminals[addr]
	if t == nil {
		return hcTerminal{}, false
	}
	return *t, true
}

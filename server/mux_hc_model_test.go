package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

// hcTerm is a live terminal of herdr's for model tests.
func hcTerm(addr, space, tab string, cols, rows int, created int64) *hcTerminal {
	labels := map[string]string{}
	if space != "" {
		labels[hcLabelSpace] = space
	}
	if tab != "" {
		labels[hcLabelTab] = tab
	}
	return &hcTerminal{Address: addr, Labels: labels, State: "live", Cols: cols, Rows: rows, Cwd: "/w", CreatedMs: created}
}

func loadHcDoc(t *testing.T, name string) *hcDoc {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	var res struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(b, &res); err != nil {
		t.Fatal(err)
	}
	d, err := parseHcDoc(res.Value)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func paneIDs(t Tab) []string {
	var ids []string
	for _, p := range t.Panes {
		ids = append(ids, p.ID)
	}
	return ids
}

// The document herdr-app wrote on a dev machine: a tab split in two and a
// tab with one terminal, in an unnamed space named after its checkout.
func TestHcSnapshotFromRealDoc(t *testing.T) {
	doc := loadHcDoc(t, "hc-herdr-app-doc.json")
	sp, tb1, tb2 := "sp4edb720aa4b17f5a613793b7a96b7965", "tb4958b85f9429906ea3b85a34be43d4c3", "tbd34e4c4c59605762a3a691af2454b914"
	terms := map[string]*hcTerminal{
		"t1": hcTerm("t1", sp, tb1, 94, 40, 1), "t7": hcTerm("t7", sp, tb1, 94, 40, 3), "t4": hcTerm("t4", sp, tb2, 194, 40, 2),
	}
	terms["t1"].Cwd = "/home/u/code/termote/server"
	snap := buildHcSnapshot(hcBuildInput{terminals: terms, doc: doc, home: "/home/u", top: func(dir string) string {
		if strings.HasPrefix(dir, "/home/u/code/termote") {
			return "/home/u/code/termote"
		}
		return ""
	}})
	if len(snap.Groups) != 1 {
		t.Fatalf("groups %+v", snap.Groups)
	}
	g := snap.Groups[0]
	if g.ID != sp || g.Name != "termote" || len(g.Tabs) != 2 {
		t.Fatalf("group %+v", g)
	}
	a, b := g.Tabs[0], g.Tabs[1]
	if a.ID != tb1 || a.Key != tb1 || a.Name != "1" || !a.Active || !reflect.DeepEqual(paneIDs(a), []string{"t1", "t7"}) {
		t.Fatalf("tab 1 %+v", a)
	}
	if b.Name != "2" || b.Active || !reflect.DeepEqual(paneIDs(b), []string{"t4"}) {
		t.Fatalf("tab 2 %+v", b)
	}
	want := &TabLayout{Cols: 188, Rows: 40, Panes: []PaneLayout{{ID: "t1", Cols: 94, Rows: 40}, {ID: "t7", X: 94, Cols: 94, Rows: 40}}}
	if !reflect.DeepEqual(a.Layout, want) {
		t.Fatalf("layout %+v", a.Layout)
	}
	if !a.Panes[0].Active || a.Panes[1].Active {
		t.Fatal("first pane not the active one")
	}
}

func TestHcSnapshotFromRichDoc(t *testing.T) {
	doc := loadHcDoc(t, "hc-herdr-app-doc-rich.json")
	terms := map[string]*hcTerminal{
		"t1": hcTerm("t1", "spa", "tba", 40, 30, 1), "t2": hcTerm("t2", "spa", "tba", 60, 10, 2),
		"t3": hcTerm("t3", "spa", "tba", 60, 20, 3), "t4": hcTerm("t4", "spa", "tba", 60, 20, 4),
		"t5": hcTerm("t5", "spa", "tba", 20, 10, 5), "t6": hcTerm("t6", "spa", "tbb", 80, 24, 6),
		"t8": hcTerm("t8", "spa", "tbc", 80, 24, 8), "t9": hcTerm("t9", "spa", "tba", 10, 10, 9),
		"t10": hcTerm("t10", "spb", "tbd", 80, 24, 10),
		// Not shown: no labels, finished, another machine.
		"t11": hcTerm("t11", "", "", 80, 24, 11), "t12": hcTerm("t12", "spa", "tba", 80, 24, 12),
		"rohan/t7": hcTerm("rohan/t7", "spa", "tbb", 80, 24, 7),
		// By label only: a new space with two tabs, and one more pane of tba.
		"t13": hcTerm("t13", "spNew", "tbNew", 80, 24, 13), "t14": hcTerm("t14", "spNew", "tbNew", 80, 24, 14),
		"t15": hcTerm("t15", "spNew", "tbNew2", 80, 24, 15), "t16": hcTerm("t16", "spa", "tba", 80, 24, 16),
		"t17": hcTerm("t17", "spa", "", 80, 24, 17),
	}
	terms["t8"].State = "finished"
	terms["t12"].State = "finished"
	terms["t10"].Cwd = "/home/u/proj/sub"
	terms["t13"].Cwd = "/home/u"
	snap := buildHcSnapshot(hcBuildInput{terminals: terms, doc: doc, home: "/home/u", top: func(dir string) string {
		if strings.HasPrefix(dir, "/home/u/proj") {
			return "/home/u/proj"
		}
		return ""
	}})
	if len(snap.Groups) != 3 {
		t.Fatalf("%d groups: %+v", len(snap.Groups), snap.Groups)
	}
	a := snap.Groups[0]
	if a.ID != "spa" || a.Name != cleanPaneName("Work \x1b[31mspace\u202e") || strings.ContainsAny(a.Name, "\x1b\u202e") {
		t.Fatalf("group a %q %q", a.ID, a.Name)
	}
	// tbc's only terminal ended: the tab is gone. t17 has a space but no
	// tab label: a tab of its own, as herdr-app adopts it.
	if len(a.Tabs) != 3 || a.Tabs[1].Name != "logs" || a.Tabs[2].ID != "tb-t17" || a.Tabs[2].Name != "3" ||
		hcTabLabel(a.Tabs[2].ID) != "" || hcTabLabel("tba") != "tba" {
		t.Fatalf("tabs %+v", a.Tabs)
	}
	tba := a.Tabs[0]
	// Tree order, the stack's hidden child, a hidden block and a floating one
	// included; t1 again in tbb and the mod are not panes.
	if got := paneIDs(tba); !reflect.DeepEqual(got, []string{"t1", "t2", "t3", "t4", "t9", "t5", "t16"}) {
		t.Fatalf("tba panes %v", got)
	}
	want := &TabLayout{Cols: 100, Rows: 30, Panes: []PaneLayout{
		{ID: "t1", Cols: 40, Rows: 30}, {ID: "t2", X: 40, Cols: 60, Rows: 10}, {ID: "t4", X: 40, Y: 10, Cols: 60, Rows: 20},
	}}
	if !reflect.DeepEqual(tba.Layout, want) {
		t.Fatalf("tba layout %+v", tba.Layout)
	}
	if got := paneIDs(a.Tabs[1]); !reflect.DeepEqual(got, []string{"t6"}) {
		t.Fatalf("tbb panes %v", got)
	}
	// spb: its document tab holds no terminal of this machine (tb1 is not an
	// id, t10 sits in a node type herdr-app has no such thing as), so t10 is
	// placed by label; the space is named after t10's checkout.
	b := snap.Groups[1]
	if b.ID != "spb" || b.Name != "proj" || len(b.Tabs) != 1 || b.Tabs[0].ID != "tbd" || !reflect.DeepEqual(paneIDs(b.Tabs[0]), []string{"t10"}) {
		t.Fatalf("group b %+v", b)
	}
	c := snap.Groups[2]
	if c.ID != "spNew" || c.Name != "~" || len(c.Tabs) != 2 || c.Tabs[0].Name != "1" || c.Tabs[1].Name != "2" ||
		!reflect.DeepEqual(paneIDs(c.Tabs[0]), []string{"t13", "t14"}) || c.Tabs[0].Layout != nil {
		t.Fatalf("group c %+v", c)
	}
}

// Without a document every labelled terminal still shows, by label.
func TestHcSnapshotWithoutDoc(t *testing.T) {
	terms := map[string]*hcTerminal{
		"t2": hcTerm("t2", "sp1", "tb1", 80, 24, 2), "t1": hcTerm("t1", "sp1", "tb1", 80, 24, 2),
		"t3": hcTerm("t3", "sp2", "tb2", 80, 24, 1),
	}
	snap := buildHcSnapshot(hcBuildInput{terminals: terms, home: "/h"})
	if len(snap.Groups) != 2 || snap.Groups[0].ID != "sp2" || snap.Groups[1].Name != "w" ||
		!reflect.DeepEqual(paneIDs(snap.Groups[1].Tabs[0]), []string{"t1", "t2"}) {
		t.Fatalf("%+v", snap.Groups)
	}
	if s := buildHcSnapshot(hcBuildInput{}); s.Groups == nil || len(s.Groups) != 0 {
		t.Fatalf("empty %+v", s)
	}
}

func TestParseHcDocRefusals(t *testing.T) {
	if d, err := parseHcDoc(nil); d != nil || err != nil {
		t.Fatal("empty value")
	}
	if d, err := parseHcDoc(json.RawMessage("null")); d != nil || err != nil {
		t.Fatal("null value")
	}
	deep := `{"id":"x","type":"block","content":{"terminal":"t1"}}`
	for i := 0; i < hcDocMaxDepth+2; i++ {
		deep = `{"id":"x","type":"row","children":[` + deep + `]}`
	}
	wide := `{"id":"x","type":"row","children":[` + strings.Repeat(`{"id":"y","type":"block"},`, hcDocMaxNodes) + `{"id":"z"}]}`
	for name, raw := range map[string]string{
		"not json":     `{`,
		"wrong shape":  `{"spaces":{"a":1}}`,
		"no space id":  `{"spaces":[{"tabs":[]}]}`,
		"no tab id":    `{"spaces":[{"id":"s","tabs":[{"name":"x"}]}]}`,
		"too deep":     `{"spaces":[{"id":"s","tabs":[{"id":"t","root":` + deep + `}]}]}`,
		"too many":     `{"spaces":[{"id":"s","tabs":[{"id":"t","root":` + wide + `}]}]}`,
		"bad children": `{"spaces":[{"id":"s","tabs":[{"id":"t","root":{"children":"x"}}]}]}`,
	} {
		if _, err := parseHcDoc(json.RawMessage(raw)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// Unknown fields and node types are fine.
	d, err := parseHcDoc(json.RawMessage(`{"spaces":[{"id":"s","extra":1,"tabs":[{"id":"t","root":{"id":"t","type":"grid"}}]}],"v":2}`))
	if err != nil || len(d.Spaces) != 1 {
		t.Fatalf("%+v %v", d, err)
	}
}

func TestPlanHcTabEdges(t *testing.T) {
	size := func(addr string) (int, int) {
		if addr == "t1" {
			return 80, 24
		}
		return 0, 0
	}
	if p := planHcTab(nil, size); len(p.terminals) != 0 || p.cols != 0 {
		t.Fatalf("%+v", p)
	}
	// A stack whose active child is hidden shows its first visible child;
	// one with none shows nothing; unknown sizes get no rect.
	root := &hcNode{Type: "column", Children: []hcNode{
		{Type: "stack", Active: ptr("b"), Children: []hcNode{
			{ID: "a", Type: "block", Content: hcContent{"t1"}}, {ID: "b", Type: "block", Hidden: true, Content: hcContent{"t2"}},
		}},
		{Type: "stack", Children: []hcNode{{ID: "c", Type: "block", Hidden: true, Content: hcContent{"t3"}}}},
		{Type: "block", Content: hcContent{"t4"}},
	}}
	p := planHcTab(root, size)
	if !reflect.DeepEqual(p.terminals, []string{"t1", "t2", "t3", "t4"}) || p.cols != 80 || p.rows != 24 || len(p.rects) != 1 ||
		p.rects["t1"] != (PaneLayout{ID: "t1", Cols: 80, Rows: 24}) {
		t.Fatalf("%+v", p)
	}
}

func TestHcAgent(t *testing.T) {
	for _, tc := range []struct {
		app, state string
		turn       uint64
		seen       string // "" no label
		want       *AgentInfo
	}{
		{"claude-code", "working", 0, "", &AgentInfo{Name: "claude", Status: "working"}},
		{"Claude", "blocked", 0, "", &AgentInfo{Name: "claude", Status: "blocked"}},
		{"codex", "done", 2, "", &AgentInfo{Name: "codex", Status: "done"}},
		{"codex", "idle", 2, "", &AgentInfo{Name: "codex", Status: "idle"}},
		{"codex", "done", 2, "2", &AgentInfo{Name: "codex", Status: "idle"}},
		{"codex", "idle", 3, "2", &AgentInfo{Name: "codex", Status: "done"}},
		{"codex", "idle", 3, "x", &AgentInfo{Name: "codex", Status: "idle"}},
		{"codex", "working", 3, "1", &AgentInfo{Name: "codex", Status: "working"}},
		{"grok-build", "error", 0, "", &AgentInfo{Name: "grok", Status: "unknown"}},
		{"github-copilot", "thinking\x1b", 0, "", &AgentInfo{Name: "copilot", Status: "unknown"}},
		{"my-own-bot", "working", 0, "", &AgentInfo{Name: "other", Status: "working"}},
		{" ", "idle", 0, "", &AgentInfo{Name: "unknown", Status: "idle"}},
	} {
		term := hcTerm("t1", "s", "t", 80, 24, 0)
		term.Status, term.Turn = &hcStatus{App: tc.app, State: tc.state}, tc.turn
		if tc.seen != "" {
			term.Labels[hcLabelSeen] = tc.seen
		}
		if got := hcAgent(term); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%+v: got %+v", tc, got)
		}
	}
	if hcAgent(hcTerm("t1", "s", "t", 1, 1, 0)) != nil {
		t.Error("an agent without a status")
	}
}

func TestHcFolderName(t *testing.T) {
	for _, tc := range []struct{ path, home, want string }{
		{"/home/u", "/home/u", "~"}, {"/home/u/", "/home/u", "~"}, {"", "/home/u", "~"},
		{"/home/u/code/app", "/home/u", "app"}, {"/home/u/code/app/", "/home/u", "app"},
		{"/", "/home/u", "/"}, {`C:\Users\u\proj`, `C:\Users\u`, "proj"},
	} {
		if got := hcFolderName(tc.path, tc.home); got != tc.want {
			t.Errorf("%q: %q", tc.path, got)
		}
	}
	if runtime.GOOS == "windows" && hcFolderName(`c:\users\U`, `C:\Users\u`) != "~" {
		t.Error("home not matched without case on Windows")
	}
}

// Names and titles are cleaned; nothing of argv, pids or the environment
// reaches a snapshot, whatever the core sends.
func TestHcSnapshotCarriesNoSecrets(t *testing.T) {
	st := newHcState()
	st.reset(1, nil)
	applyHcEvents(t, st, "hc-events.jsonl")
	in := st.input()
	in.home = "/h"
	snap := buildHcSnapshot(in)
	b, _ := json.Marshal(snap)
	for _, bad := range []string{"secret", "s3cret", "--token", "4242", "4243", "argv"} {
		if strings.Contains(string(b), bad) {
			t.Fatalf("snapshot carries %q: %s", bad, b)
		}
	}
	long := hcTerm("t1", "s\x07", "t", 80, 24, 0)
	long.Title = strings.Repeat("é", 1<<19) + "\x1b]0;x\x07"
	long.Foreground = &hcForeground{Pid: 9, Name: "/usr/bin/vim\u202e --x", Cwd: "relative"}
	snap = buildHcSnapshot(hcBuildInput{terminals: map[string]*hcTerminal{"t1": long}, doc: &hcDoc{Spaces: []hcDocSpace{{ID: "s\x07", Name: strings.Repeat("n", 1<<20)}}}})
	p := snap.Groups[0].Tabs[0].Panes[0]
	if len(p.Title) > maxPaneName || len(snap.Groups[0].Name) > maxPaneName || strings.ContainsAny(p.Title, "\x1b\x07") ||
		p.Process == nil || p.Process.Name != "vim" || p.Process.Cwd != "" {
		t.Fatalf("pane %+v process %+v name %d", p, p.Process, len(snap.Groups[0].Name))
	}
}

// applyHcEvents applies the event lines of a fixture.
func applyHcEvents(t *testing.T, st *hcState, name string) []uint64 {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var docs []uint64
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var l hcEventLine
		if err := json.Unmarshal(sc.Bytes(), &l); err != nil {
			t.Fatal(err)
		}
		var ev hcEvent
		json.Unmarshal(l.Params, &ev)
		if v, ok := st.apply(ev); ok {
			docs = append(docs, v)
		}
	}
	return docs
}

func TestHcStateAppliesEvents(t *testing.T) {
	st := newHcState()
	t1 := *hcTerm("t1", "sp1", "tb0", 80, 24, 1)
	t1.Title = "kept"
	t1.Foreground = &hcForeground{Name: "zsh", Cwd: "/w"}
	t3, t4 := *hcTerm("t3", "sp1", "tb0", 80, 24, 3), *hcTerm("t4", "sp1", "tb0", 80, 24, 4)
	st.reset(10, []hcTerminal{t1, t3, t4})
	docs := applyHcEvents(t, st, "hc-events.jsonl")
	if !reflect.DeepEqual(docs, []uint64{5}) {
		t.Fatalf("doc events %v: another machine's or app's document counted", docs)
	}
	get := func(a string) hcTerminal {
		v, ok := st.terminal(a)
		if !ok {
			t.Fatalf("%s missing", a)
		}
		return v
	}
	if get("t1").Title != "" || get("t1").Labels[hcLabelTab] != "tb0" {
		// seq 10 was skipped; the restart replaced the record (no title).
		t.Fatalf("t1 %+v", get("t1"))
	}
	t2 := get("t2")
	if t2.Status == nil || t2.Status.App != "claude-code" || t2.Status.State != "idle" || t2.Turn != 1 || !t2.Keep ||
		t2.Cols != 100 || t2.Rows != 30 || t2.Title != "✳ fixing" || t2.Foreground == nil || t2.Foreground.Cwd != "/w/sub" {
		t.Fatalf("t2 %+v", t2)
	}
	if a := hcAgent(&t2); a.Name != "claude" || a.Status != "done" {
		t.Fatalf("t2 agent %+v", a)
	}
	if get("t3").State != "finished" || get("t3").Reason == nil || *get("t3").Reason != "exited" {
		t.Fatalf("t3 %+v", get("t3"))
	}
	if _, ok := st.terminal("t4"); ok {
		t.Fatal("removed t4 kept")
	}
	if get("t9").Labels[hcLabelSpace] != "sp9" {
		t.Fatal("labels record not added")
	}
	if _, ok := st.terminal("t404"); ok {
		t.Fatal("event for an unknown terminal added one")
	}
	// lost keeps a kept terminal live without its foreground.
	st.apply(hcEvent{Seq: 100, Type: "foreground", Terminal: "t2", Data: json.RawMessage(`{"pid":1,"name":"x","cwd":"/a"}`)})
	st.apply(hcEvent{Seq: 101, Type: "lost", Terminal: "t2", Data: json.RawMessage(`{"reason":"signaled"}`)})
	if l := get("t2"); l.State != "live" || l.Foreground != nil || *l.Reason != "signaled" {
		t.Fatalf("lost %+v", l)
	}
	// A record read earlier is not changed by later events.
	before := get("t2")
	st.apply(hcEvent{Seq: 102, Type: "title", Terminal: "t2", Data: json.RawMessage(`{"title":"new"}`)})
	if before.Title == "new" {
		t.Fatal("records changed in place")
	}
	st.apply(hcEvent{Seq: 103, Type: "foreground", Terminal: "t2", Data: json.RawMessage(`null`)})
	st.apply(hcEvent{Seq: 104, Type: "labels", Terminal: "t2", Data: json.RawMessage(`{}`)})
	if l := get("t2"); l.Foreground != nil || l.Labels == nil {
		t.Fatalf("t2 %+v", l)
	}
	// upsert and documents: an older read never replaces a newer one.
	st.upsert(*hcTerm("t50", "s", "t", 1, 1, 0))
	get("t50")
	st.setDoc(7, &hcDoc{}, false)
	st.setDoc(6, nil, false)
	if st.docVersion() != 7 || st.input().doc == nil {
		t.Fatal("older document read replaced a newer one")
	}
	// The first read on a connection is taken whatever its version: the
	// core's state may have been wiped.
	st.setDoc(1, nil, true)
	if st.docVersion() != 1 || st.input().doc != nil {
		t.Fatal("a fresh read was dropped")
	}
}

func TestHcLostClearsPid(t *testing.T) {
	st := newHcState()
	rec := *hcTerm("t1", "s", "t", 80, 24, 0)
	pid := 42
	rec.Pid = &pid
	st.reset(1, []hcTerminal{rec})
	st.apply(hcEvent{Seq: 2, Type: "lost", Terminal: "t1", Data: json.RawMessage(`{"reason":"signaled"}`)})
	if got, _ := st.terminal("t1"); got.Pid != nil {
		t.Fatal("a lost terminal keeps its pid")
	}
}

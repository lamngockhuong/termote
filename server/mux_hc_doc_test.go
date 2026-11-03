package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
)

// hcSimDoc is herdr-app's document on the sim's core: doc.get reads it,
// doc.set writes it over the version read, as herdr-core does.
type hcSimDoc struct {
	mu      sync.Mutex
	value   json.RawMessage
	version uint64
	// conflicts: how many writes still lose to another writer (the version
	// moves on under them).
	conflicts int
	// getErr, setErr: doc.get, doc.set fail with this kind.
	getErr, setErr string
	// mutate, when set, is what the other writer does at each conflict.
	mutate func(map[string]any)
	sets   int
}

// The fields herdr-app writes that termote does not know must survive a write.
const hcSimDocValue = `{"spaces":[
 {"id":"sp1","name":"","folder":"/w","look":{"theme":"dusk","font_size":13.5},"tabs":[
  {"id":"tb1","name":"","root":{"id":"r1","type":"row","children":[
   {"id":"b1","type":"block","content":{"terminal":"t1"},"size":{"weight":1.5}},
   {"id":"b2","type":"block","content":{"terminal":"t2"},"size":{"px":320}}]}},
  {"id":"tbx","name":"empty","root":{"id":"rx","type":"row","children":[]}},
  {"id":"tb2","name":"","root":{"id":"b4","type":"block","content":{"terminal":"t4"}}}]},
 {"id":"sp2","name":"two","folder":"/v","tabs":[
  {"id":"tb3","name":"","root":{"id":"b6","type":"block","content":{"terminal":"t6"}}}]}]}`

// withDoc gives the sim's core a document holding sp1 (tb1, an empty tab
// tbx, tb2) and sp2 (tb3: t6), and waits until the mux has read it.
func (s *hcSim) withDoc(t *testing.T) *hcSimDoc {
	t.Helper()
	d := &hcSimDoc{value: json.RawMessage(hcSimDocValue), version: 5}
	s.mu.Lock()
	core := s.core
	s.terms["t6"] = map[string]any{"address": "t6", "labels": map[string]string{hcLabelSpace: "sp2", hcLabelTab: "tb3"},
		"state": "live", "cols": 80, "rows": 24, "cwd": "/v", "created_ms": 50}
	rec := s.recLocked("t6")
	s.mu.Unlock()
	core.handle("doc.get", func(f *fakeHcCore, id uint64, _ json.RawMessage) {
		d.mu.Lock()
		defer d.mu.Unlock()
		if d.getErr != "" {
			f.replyError(id, d.getErr, "doc.get failed")
			return
		}
		f.reply(id, map[string]any{"value": d.value, "version": d.version})
	})
	core.handle("doc.set", func(f *fakeHcCore, id uint64, params json.RawMessage) {
		var p struct {
			Name    string          `json:"name"`
			Version uint64          `json:"version"`
			Value   json.RawMessage `json:"value"`
		}
		json.Unmarshal(params, &p)
		d.mu.Lock()
		defer d.mu.Unlock()
		d.sets++
		if d.setErr != "" {
			f.replyError(id, d.setErr, "doc.set failed")
			return
		}
		if d.conflicts > 0 {
			d.conflicts--
			d.version++
			if d.mutate != nil {
				var v map[string]any
				json.Unmarshal(d.value, &v)
				d.mutate(v)
				d.value = mustJSON(v)
			}
		}
		if p.Name != hcAppDoc || p.Version != d.version {
			f.replyError(id, "conflict", "stale")
			return
		}
		d.value, d.version = p.Value, d.version+1
		f.reply(id, map[string]any{"version": d.version})
	})
	s.emit("t6", "created", rec)
	s.emit("", "doc", map[string]any{"name": hcAppDoc, "version": d.version})
	waitFor(t, func() bool {
		snap, err := s.m.Snapshot(ctx5s(t))
		return err == nil && s.m.Caps().RenameTab && len(snap.Groups) == 2
	})
	return d
}

// doc is the document as the core holds it now.
func (d *hcSimDoc) doc(t *testing.T) map[string]any {
	t.Helper()
	d.mu.Lock()
	defer d.mu.Unlock()
	var v map[string]any
	if err := json.Unmarshal(d.value, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func (d *hcSimDoc) setCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.sets
}

// ids lists the ids of a document array.
func hcSimIDs(list []any) string {
	var ids []string
	for _, v := range list {
		ids = append(ids, hcDocID(v))
	}
	return strings.Join(ids, ",")
}

func TestHcDocCapsFollowTheDocument(t *testing.T) {
	s := newHcSim(t)
	// No document (herdr-app never ran here): nothing is offered or written.
	if c := s.m.Caps(); c.RenameTab || c.RenameGroup || c.ReorderTabs || c.ReorderGroups {
		t.Fatalf("caps without a document %+v", c)
	}
	if err := s.m.RenameTab(ctx5s(t), "tb1", "x", "tb1"); err != errHcNoLayout {
		t.Errorf("rename without a document: %v", err)
	}
	if len(s.core.callsOf("doc.set")) != 0 {
		t.Error("wrote a document")
	}
	s.withDoc(t)
	if c := s.m.Caps(); !c.RenameTab || !c.RenameGroup || !c.ReorderTabs || !c.ReorderGroups || c.RenamePane {
		t.Fatalf("caps with a document %+v", c)
	}
}

func TestHcDocRename(t *testing.T) {
	s := newHcSim(t)
	d := s.withDoc(t)
	ctx := ctx5s(t)
	if err := s.m.RenameTab(ctx, "tb1", "Build", "tb1"); err != nil {
		t.Fatal(err)
	}
	if err := s.m.RenameGroup(ctx, "sp1", "Proj"); err != nil {
		t.Fatal(err)
	}
	doc := d.doc(t)
	sp1 := hcDocFind(hcDocList(doc, "spaces"), "sp1")
	tb1 := hcDocFind(hcDocList(sp1, "tabs"), "tb1")
	if sp1["name"] != "Proj" || tb1["name"] != "Build" {
		t.Fatalf("names %v %v", sp1["name"], tb1["name"])
	}
	// Everything else as herdr-app wrote it, numbers included.
	d.mu.Lock()
	raw := string(d.value)
	d.mu.Unlock()
	for _, want := range []string{`"look":{"font_size":13.5,"theme":"dusk"}`, `"size":{"weight":1.5}`, `"size":{"px":320}`, `"folder":"/w"`} {
		if !strings.Contains(raw, want) {
			t.Errorf("lost %s in %s", want, raw)
		}
	}
	// The snapshot shows the names at once, without waiting for an event.
	snap, err := s.m.Snapshot(ctx)
	if err != nil || snap.Groups[0].Name != "Proj" || snap.Groups[0].Tabs[0].Name != "Build" {
		t.Fatalf("snapshot %+v %v", snap.Groups, err)
	}
	// The same name writes nothing.
	n := d.setCount()
	if err := s.m.RenameTab(ctx, "tb1", "Build", ""); err != nil || d.setCount() != n {
		t.Errorf("same name: %v, %d writes", err, d.setCount()-n)
	}
	for _, c := range []struct {
		tab, name, key string
		want           error
	}{
		{"tb1", "x", "tb2", errTabChanged},
		{"nope", "x", "", errUnknownTab},
	} {
		if err := s.m.RenameTab(ctx, c.tab, c.name, c.key); err != c.want {
			t.Errorf("rename %s: %v, want %v", c.tab, err, c.want)
		}
	}
	for _, bad := range []string{"", "a‮b", "a\x01", strings.Repeat("x", 65)} {
		var ie inputError
		if err := s.m.RenameTab(ctx, "tb1", bad, ""); !errors.As(err, &ie) {
			t.Errorf("tab name %q: %v", bad, err)
		}
		if err := s.m.RenameGroup(ctx, "sp1", bad); err != errInvalidGroupName {
			t.Errorf("group name %q: %v", bad, err)
		}
	}
	if err := s.m.RenameGroup(ctx, "nope", "x"); err != errUnknownGroup {
		t.Errorf("unknown group: %v", err)
	}
	if d.setCount() != n {
		t.Errorf("a refused rename wrote %d times", d.setCount()-n)
	}
}

func TestHcDocMove(t *testing.T) {
	s := newHcSim(t)
	d := s.withDoc(t)
	ctx := ctx5s(t)
	// sp1 shows tb1, tb2 (tbx has no terminal): tb2 first, tbx stays put.
	if id, err := s.m.MoveTab(ctx, "tb2", 0); err != nil || id != "tb2" {
		t.Fatalf("move tab: %q %v", id, err)
	}
	sp1 := hcDocFind(hcDocList(d.doc(t), "spaces"), "sp1")
	if got := hcSimIDs(hcDocList(sp1, "tabs")); got != "tb2,tbx,tb1" {
		t.Errorf("tabs %s", got)
	}
	if err := s.m.MoveGroup(ctx, "sp2", 0); err != nil {
		t.Fatal(err)
	}
	if got := hcSimIDs(hcDocList(d.doc(t), "spaces")); got != "sp2,sp1" {
		t.Errorf("spaces %s", got)
	}
	snap, _ := s.m.Snapshot(ctx)
	if snap.Groups[0].ID != "sp2" || snap.Groups[1].Tabs[0].ID != "tb2" {
		t.Errorf("snapshot %+v", snap.Groups)
	}
	n := d.setCount()
	if id, err := s.m.MoveTab(ctx, "tb2", 0); err != nil || id != "tb2" || d.setCount() != n {
		t.Errorf("same place: %q %v", id, err)
	}
	for _, c := range []struct {
		tab   string
		index int
		want  error
	}{{"tb2", 2, errInvalidIndex}, {"nope", 0, errUnknownTab}} {
		if _, err := s.m.MoveTab(ctx, c.tab, c.index); err != c.want {
			t.Errorf("move %s to %d: %v", c.tab, c.index, err)
		}
	}
	if err := s.m.MoveGroup(ctx, "sp1", 2); err != errInvalidIndex {
		t.Errorf("group index: %v", err)
	}
	if err := s.m.MoveGroup(ctx, "nope", 0); err != errUnknownGroup {
		t.Errorf("unknown group: %v", err)
	}
	if d.setCount() != n {
		t.Error("a refused move wrote")
	}
}

func TestHcDocConflict(t *testing.T) {
	s := newHcSim(t)
	d := s.withDoc(t)
	ctx := ctx5s(t)
	// herdr-app wrote in between once: read again and write.
	d.mu.Lock()
	d.conflicts = 1
	d.mu.Unlock()
	if err := s.m.RenameTab(ctx, "tb1", "One", ""); err != nil {
		t.Fatal(err)
	}
	if d.setCount() != 2 {
		t.Errorf("%d writes", d.setCount())
	}
	// It keeps writing: give up, busy.
	d.mu.Lock()
	d.conflicts = hcDocWriteTries
	d.mu.Unlock()
	if err := s.m.RenameTab(ctx, "tb1", "Two", ""); err != errHcDocBusy {
		t.Errorf("busy: %v", err)
	}
	if name := hcDocFind(hcDocList(hcDocFind(hcDocList(d.doc(t), "spaces"), "sp1"), "tabs"), "tb1")["name"]; name != "One" {
		t.Errorf("name %v", name)
	}
}

func TestHcDocUnderstoodOnly(t *testing.T) {
	s := newHcSim(t)
	d := s.withDoc(t)
	// A document herdr-app would not write (a space without id) is left alone.
	d.mu.Lock()
	d.value = json.RawMessage(`{"spaces":[{"name":"x","tabs":[]}]}`)
	d.mu.Unlock()
	if err := s.m.RenameGroup(ctx5s(t), "sp1", "x"); err != errHcNoLayout {
		t.Errorf("odd document: %v", err)
	}
	if d.setCount() != 0 {
		t.Error("wrote over a document it did not understand")
	}
}

func TestHcDocSetParams(t *testing.T) {
	ok := hcDocSetParams{Version: 3, Value: json.RawMessage(`{"spaces":[]}`)}
	if err := ok.hcCheck(); err != nil {
		t.Fatal(err)
	}
	got := map[string]any{}
	json.Unmarshal(mustJSON(ok), &got)
	if got["name"] != hcAppDoc || got["version"] != 3.0 || len(got) != 3 {
		t.Errorf("params %v", got)
	}
	for _, p := range []hcDocSetParams{
		{Version: 0, Value: json.RawMessage(`{}`)},
		{Version: 1, Value: json.RawMessage(`null`)},
		{Version: 1, Value: json.RawMessage(`[]`)},
		{Version: 1, Value: json.RawMessage(`{"a":`)},
		{Version: 1, Value: json.RawMessage(`{"a":"` + strings.Repeat("x", hcDocMaxValue) + `"}`)},
	} {
		if p.hcCheck() == nil {
			t.Errorf("accepted %.40s", p.Value)
		}
	}
}

// herdr-app moved tabs between termote's read and its write: the move is
// made again on the order herdr-app left, not on the snapshot's.
func TestHcDocMoveKeepsAConcurrentMove(t *testing.T) {
	s := newHcSim(t)
	d := s.withDoc(t)
	// Another tab with a terminal, so three show: tb1, tb2, tb5.
	s.mu.Lock()
	s.terms["t7"] = map[string]any{"address": "t7", "labels": map[string]string{hcLabelSpace: "sp1", hcLabelTab: "tb5"},
		"state": "live", "cols": 80, "rows": 24, "cwd": "/w", "created_ms": 60}
	rec := s.recLocked("t7")
	s.mu.Unlock()
	s.emit("t7", "created", rec)
	d.mu.Lock()
	var v map[string]any
	json.Unmarshal(d.value, &v)
	sp1 := hcDocFind(hcDocList(v, "spaces"), "sp1")
	sp1["tabs"] = append(hcDocList(sp1, "tabs"), map[string]any{"id": "tb5", "name": "",
		"root": map[string]any{"id": "b7", "type": "block", "content": map[string]any{"terminal": "t7"}}})
	d.value, d.version = mustJSON(v), d.version+1
	version := d.version
	d.mu.Unlock()
	s.emit("", "doc", map[string]any{"name": hcAppDoc, "version": version})
	waitFor(t, func() bool {
		snap, _ := s.m.Snapshot(ctx5s(t))
		return len(snap.Groups) == 2 && len(snap.Groups[0].Tabs) == 3
	})
	// herdr-app puts tb5 first while termote moves tb2 first.
	d.mu.Lock()
	d.conflicts = 1
	d.mutate = func(v map[string]any) {
		sp1 := hcDocFind(hcDocList(v, "spaces"), "sp1")
		tabs := hcDocList(sp1, "tabs")
		sp1["tabs"] = []any{tabs[3], tabs[0], tabs[1], tabs[2]} // tb5, tb1, tbx, tb2
	}
	d.mu.Unlock()
	if _, err := s.m.MoveTab(ctx5s(t), "tb2", 0); err != nil {
		t.Fatal(err)
	}
	sp1 = hcDocFind(hcDocList(d.doc(t), "spaces"), "sp1")
	if got := hcSimIDs(hcDocList(sp1, "tabs")); got != "tb2,tb5,tbx,tb1" {
		t.Errorf("tabs %s", got)
	}
}

func TestHcDocOddDocuments(t *testing.T) {
	s := newHcSim(t)
	d := s.withDoc(t)
	ctx := ctx5s(t)
	set := func(value string) {
		d.mu.Lock()
		d.value = json.RawMessage(value)
		d.mu.Unlock()
	}
	// Two spaces of one id: a move cannot tell them apart, nothing written.
	set(`{"spaces":[{"id":"sp1","tabs":[]},{"id":"sp2","tabs":[]},{"id":"sp1","name":"again","tabs":[]}]}`)
	if err := s.m.MoveGroup(ctx, "sp2", 0); err != errHcNoLayout {
		t.Errorf("duplicate ids: %v", err)
	}
	// Deleted (null over a version): no layout.
	set(`null`)
	if err := s.m.RenameGroup(ctx, "sp1", "x"); err != errHcNoLayout {
		t.Errorf("deleted document: %v", err)
	}
	if d.setCount() != 0 {
		t.Errorf("%d writes", d.setCount())
	}
	// Numbers past float64 and names with HTML and line separators survive.
	set(`{"spaces":[{"id":"sp1","name":"","n":12345678901234567890,"w":1.0,"tabs":[{"id":"tb1","name":"","root":{"id":"b1","type":"block","content":{"terminal":"t1"}}}]},
	 {"id":"sp2","name":"","tabs":[{"id":"tb3","name":"","root":{"id":"b6","type":"block","content":{"terminal":"t6"}}}]}]}`)
	if err := s.m.RenameTab(ctx, "tb1", "a<b>&c\u2028d", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.m.RenameTab(ctx, "tb1", "a<b>&c\u2028d", ""); err != nil {
		t.Fatal(err)
	}
	d.mu.Lock()
	raw := string(d.value)
	d.mu.Unlock()
	if !strings.Contains(raw, "12345678901234567890") || !strings.Contains(raw, `"w":1.0`) {
		t.Errorf("numbers changed: %s", raw)
	}
	tb1 := hcDocFind(hcDocList(hcDocFind(hcDocList(d.doc(t), "spaces"), "sp1"), "tabs"), "tb1")
	if tb1["name"] != "a<b>&c\u2028d" || d.setCount() != 1 {
		t.Errorf("name %q, %d writes", tb1["name"], d.setCount())
	}
}

// A tab placed by its labels alone (herdr-app has not taken it in) shows
// after the document's tabs: it cannot be moved or renamed, and a move to its
// place lands last among the document's tabs.
func TestHcDocLabelOnlyTab(t *testing.T) {
	s := newHcSim(t)
	d := s.withDoc(t)
	ctx := ctx5s(t)
	s.mu.Lock()
	s.terms["t8"] = map[string]any{"address": "t8", "labels": map[string]string{hcLabelSpace: "sp1", hcLabelTab: "tbL"},
		"state": "live", "cols": 80, "rows": 24, "cwd": "/w", "created_ms": 70}
	rec := s.recLocked("t8")
	s.mu.Unlock()
	s.emit("t8", "created", rec)
	waitFor(t, func() bool {
		snap, _ := s.m.Snapshot(ctx)
		return len(snap.Groups) == 2 && len(snap.Groups[0].Tabs) == 3 && snap.Groups[0].Tabs[2].ID == "tbL"
	})
	if _, err := s.m.MoveTab(ctx, "tbL", 0); err != errUnknownTab {
		t.Errorf("move a label tab: %v", err)
	}
	if err := s.m.RenameTab(ctx, "tbL", "x", ""); err != errUnknownTab {
		t.Errorf("rename a label tab: %v", err)
	}
	if _, err := s.m.MoveTab(ctx, "tb1", 2); err != nil {
		t.Fatal(err)
	}
	sp1 := hcDocFind(hcDocList(d.doc(t), "spaces"), "sp1")
	if got := hcSimIDs(hcDocList(sp1, "tabs")); got != "tb2,tbx,tb1" {
		t.Errorf("tabs %s", got)
	}
	// Already last among the document's: nothing written.
	n := d.setCount()
	if _, err := s.m.MoveTab(ctx, "tb1", 2); err != nil || d.setCount() != n {
		t.Errorf("no-op move: %v, %d writes", err, d.setCount()-n)
	}
}

func TestHcDocCapsOnAnEmptyMux(t *testing.T) {
	if (&hcMux{}).Caps().RenameTab {
		t.Error("caps without state")
	}
}

func TestHcDocCoreErrors(t *testing.T) {
	s := newHcSim(t)
	d := s.withDoc(t)
	ctx := ctx5s(t)
	d.mu.Lock()
	d.getErr = "unavailable"
	d.mu.Unlock()
	if err := s.m.RenameTab(ctx, "tb1", "x", ""); err != errHcRestarting {
		t.Errorf("doc.get failing: %v", err)
	}
	d.mu.Lock()
	d.getErr, d.setErr = "", "invalid"
	d.mu.Unlock()
	if err := s.m.RenameGroup(ctx, "sp1", "x"); err == nil || hcErrorKind(err) != "invalid" {
		t.Errorf("doc.set failing: %v", err)
	}
	// A space placed by its labels alone is not in the document.
	s.mu.Lock()
	s.terms["t9"] = map[string]any{"address": "t9", "labels": map[string]string{hcLabelSpace: "spL", hcLabelTab: "tbM"},
		"state": "live", "cols": 80, "rows": 24, "cwd": "/w", "created_ms": 80}
	rec := s.recLocked("t9")
	s.mu.Unlock()
	s.emit("t9", "created", rec)
	waitFor(t, func() bool {
		snap, _ := s.m.Snapshot(ctx)
		return len(snap.Groups) == 3
	})
	d.mu.Lock()
	d.setErr = ""
	d.mu.Unlock()
	if err := s.m.MoveGroup(ctx, "spL", 0); err != errUnknownGroup {
		t.Errorf("move a label space: %v", err)
	}
}

// The core does not run: nothing is read or written.
func TestHcDocCoreDown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m := newHcMux(ctx, "/usr/bin/hc", nil)
	m.client.running = func(context.Context, []string) bool { return false }
	if err := m.RenameTab(ctx5s(t), "tb1", "x", ""); err != errHcUnavailable {
		t.Errorf("rename: %v", err)
	}
	if _, err := m.MoveTab(ctx5s(t), "tb1", 0); err == nil {
		t.Error("move tab without a core")
	}
	if err := m.MoveGroup(ctx5s(t), "sp1", 0); err == nil {
		t.Error("move group without a core")
	}
}

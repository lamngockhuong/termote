package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// touchedFixture is a testdata/touched file with @ROOT@ made root.
func touchedFixture(t *testing.T, name, root string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "touched", name))
	if err != nil {
		t.Fatal(err)
	}
	q, _ := json.Marshal(root)
	return strings.ReplaceAll(string(b), "@ROOT@", string(q[1:len(q)-1]))
}

// readTouched writes body to a journal and reads it with r.
func readTouched(t *testing.T, r *touchedReader, agent, p string, sub bool) []touchedFile {
	t.Helper()
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	fi, _ := f.Stat()
	return r.files(agent, sessionFile{path: p, f: f, fi: fi, sub: sub})
}

// touchedByRel keys files by their path relative to root, slash separated.
func touchedByRel(t *testing.T, root string, files []touchedFile) map[string]touchedFile {
	t.Helper()
	out := map[string]touchedFile{}
	for _, f := range files {
		rel, err := filepath.Rel(root, f.abs)
		if err != nil {
			t.Fatal(err)
		}
		out[filepath.ToSlash(rel)] = f
	}
	return out
}

func TestTouchedClaudeTranscript(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(t.TempDir(), "s.jsonl")
	writeFile(t, p, touchedFixture(t, "claude-session.jsonl", root))
	got := touchedByRel(t, root, readTouched(t, newTouchedReader(), "claude", p, false))

	a := got["src/a.go"]
	if a.count != 2 || a.ops != touchedEdit || a.running || a.sub ||
		!a.last.Equal(time.Date(2026, 11, 10, 10, 3, 1, 0, time.UTC)) {
		t.Errorf("a.go (Edit then MultiEdit) = %+v", a)
	}
	if b := got["notes/b.md"]; b.count != 1 || b.ops != touchedWrite {
		t.Errorf("b.md (a Write relative to cwd) = %+v", b)
	}
	if nb := got["nb.ipynb"]; !nb.running || nb.count != 0 || nb.ops != touchedEdit ||
		!nb.last.Equal(time.Date(2026, 11, 10, 10, 5, 0, 0, time.UTC)) {
		t.Errorf("nb.ipynb (a NotebookEdit without its result) = %+v", nb)
	}
	for _, name := range []string{"src/c.go", "src/read.go", "side.go", "side-running.go"} {
		if f, ok := got[name]; ok {
			t.Errorf("%s (a failed edit, a read, a sidechain row) listed: %+v", name, f)
		}
	}
	if len(got) != 3 {
		t.Errorf("files = %v", got)
	}
}

func TestTouchedClaudeSubagentFile(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(t.TempDir(), "agent-a.jsonl")
	writeFile(t, p, touchedFixture(t, "claude-session.jsonl", root))
	got := touchedByRel(t, root, readTouched(t, newTouchedReader(), "claude", p, true))
	// In a subagent's own file, its sidechain rows are what it did.
	if s := got["side.go"]; s.count != 1 || !s.sub {
		t.Errorf("side.go = %+v", s)
	}
	if s := got["side-running.go"]; !s.running || !s.sub {
		t.Errorf("side-running.go = %+v", s)
	}
	if a := got["src/a.go"]; !a.sub {
		t.Errorf("a subagent's file is not marked: %+v", a)
	}
}

func TestTouchedCodexSubagentRollout(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(t.TempDir(), "rollout.jsonl")
	writeFile(t, p, touchedFixture(t, "codex-subagent-rollout.jsonl", root))
	got := touchedByRel(t, root, readTouched(t, newTouchedReader(), "codex", p, true))
	want := map[string]touchedOp{
		"new.txt": touchedWrite, "rel/r.txt": touchedEdit, "old.txt": touchedEdit, "moved.txt": touchedMove,
		"gone.txt": touchedDelete, "legacy.txt": touchedEdit, "sub/x.txt": touchedWrite,
	}
	for name, op := range want {
		f, ok := got[name]
		if !ok || f.ops != op || f.count != 1 || !f.sub || f.running {
			t.Errorf("%s = %+v (listed %v), want op %v", name, f, ok, op.names())
		}
	}
	if len(got) != len(want) {
		t.Errorf("files = %v, want only %v (no copied, failed, declined or unknown change)", got, want)
	}
}

func TestTouchedCodexCwdWithoutMeta(t *testing.T) {
	// A relative path before any cwd is known cannot be placed.
	p := filepath.Join(t.TempDir(), "rollout.jsonl")
	writeFile(t, p, `{"timestamp":"2026-11-10T10:00:00Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","status":"completed","changes":{"a.txt":{"type":"add"}}}}}`+"\n"+
		`{"timestamp":"2026-11-10T10:00:00Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","status":"completed"}}}`+"\n"+
		`{"timestamp":"2026-11-10T10:00:00Z","type":"event_msg","payload":{"type":"FileChange"}}`+"\n"+
		"{not json \"FileChange\"\n")
	if got := readTouched(t, newTouchedReader(), "codex", p, false); len(got) != 0 {
		t.Errorf("files = %+v", got)
	}
}

func TestTouchedClaudeIgnoredRows(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(t.TempDir(), "s.jsonl")
	q, _ := json.Marshal(filepath.Join(root, "x.go"))
	rows := []string{
		"{broken tool_use",
		`{"type":"assistant","message":{"content":"tool_use as text"}}`,
		`{"type":"assistant","tool_use":1}`,
		`{"type":"assistant","message":{"content":["tool_use"]}}`,
		// No id, no path, a relative path without a cwd, a NUL in a path.
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":` + string(q) + `}}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"Edit","input":{}}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"b","name":"Edit","input":{"file_path":"rel.go"}}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"c","name":"Edit","input":{"file_path":"/x\u0000y"}}]}}`,
		// A tool_use in a user row, a result in an assistant row, a result
		// for no call.
		`{"type":"user","message":{"content":[{"type":"tool_use","id":"d","name":"Edit","input":{"file_path":` + string(q) + `}}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"e","name":"Edit","input":{"file_path":` + string(q) + `}}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_result","tool_use_id":"e"}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"nope"}]}}`,
	}
	writeFile(t, p, strings.Join(rows, "\n")+"\n")
	got := readTouched(t, newTouchedReader(), "claude", p, false)
	// Only e is left, still running: its result came in an assistant row.
	if len(got) != 1 || !got[0].running || got[0].count != 0 {
		t.Errorf("files = %+v", got)
	}
}

func TestTouchedIncremental(t *testing.T) {
	root := t.TempDir()
	r := newTouchedReader()
	p := filepath.Join(t.TempDir(), "s.jsonl")
	use := func(id, name string) string {
		q, _ := json.Marshal(filepath.Join(root, name))
		return `{"type":"assistant","timestamp":"2026-11-10T10:00:00Z","message":{"content":[{"type":"tool_use","id":"` + id +
			`","name":"Edit","input":{"file_path":` + string(q) + `}}]}}` + "\n"
	}
	result := func(id string) string {
		return `{"type":"user","timestamp":"2026-11-10T10:00:01Z","message":{"content":[{"type":"tool_result","tool_use_id":"` + id + `"}]}}` + "\n"
	}
	writeFile(t, p, use("1", "a.go"))
	if got := readTouched(t, r, "claude", p, false); len(got) != 1 || !got[0].running {
		t.Fatalf("before the result = %+v", got)
	}
	appendFile(t, p, result("1")+use("2", "b.go")+strings.TrimSuffix(result("2"), "\n"))
	got := touchedByRel(t, root, readTouched(t, r, "claude", p, false))
	if a := got["a.go"]; a.running || a.count != 1 {
		t.Errorf("a.go after its result = %+v", a)
	}
	// b's result is not a complete line yet.
	if b := got["b.go"]; !b.running {
		t.Errorf("b.go = %+v", b)
	}
	appendFile(t, p, "\n"+use("3", "a.go"))
	got = touchedByRel(t, root, readTouched(t, r, "claude", p, false))
	if b := got["b.go"]; b.running || b.count != 1 {
		t.Errorf("b.go after its line ended = %+v", b)
	}
	// A file edited once and being edited again.
	if a := got["a.go"]; !a.running || a.count != 1 {
		t.Errorf("a.go edited again = %+v", a)
	}
}

func TestTouchedLongResultStaysRunning(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(t.TempDir(), "s.jsonl")
	q, _ := json.Marshal(filepath.Join(root, "a.go"))
	long := `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"1","content":"` +
		strings.Repeat("x", agentMaxLine+10) + `"}]}}`
	writeFile(t, p, `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"1","name":"Write","input":{"file_path":`+
		string(q)+`}}]}}`+"\n"+long+"\n")
	got := readTouched(t, newTouchedReader(), "claude", p, false)
	if len(got) != 1 || !got[0].running {
		t.Errorf("files = %+v", got)
	}
}

func TestTouchedPendingBound(t *testing.T) {
	st := newTouchedState()
	for i := range touchedPendingMax + 5 {
		id := fmt.Sprint(i)
		st.wait(id, touchedPending{key: touchKey{abs: "/f" + id}})
	}
	st.wait("7", touchedPending{key: touchKey{abs: "/again"}}) // a repeated id keeps the first
	if len(st.pending) != touchedPendingMax || len(st.order) != touchedPendingMax {
		t.Fatalf("pending = %d, order = %d", len(st.pending), len(st.order))
	}
	if _, ok := st.pending["0"]; ok {
		t.Error("the oldest call was kept")
	}
	if p, ok := st.resolve("7"); !ok || p.key.abs != "/f7" {
		t.Errorf("resolve 7 = %+v %v", p, ok)
	}
	if _, ok := st.resolve("7"); ok || slices.Contains(st.order, "7") {
		t.Error("a call resolved twice")
	}
}

func TestTouchedOfMerges(t *testing.T) {
	t0 := time.Date(2026, 11, 10, 10, 0, 0, 0, time.UTC)
	main := []touchedFile{
		{abs: "/r/a", ops: touchedEdit, count: 2, last: t0},
		{abs: "/r/b", ops: touchedWrite, count: 1, last: t0.Add(time.Minute)},
	}
	sub := []touchedFile{
		{abs: "/r/a", ops: touchedWrite, count: 1, last: t0.Add(2 * time.Minute), sub: true, running: true},
		{abs: "/r/c", ops: touchedEdit, count: 1, last: t0, sub: true},
	}
	got, truncated := touchedOf([][]touchedFile{main, sub})
	if truncated || len(got) != 3 {
		t.Fatalf("got %+v, %v", got, truncated)
	}
	if a := got[0]; a.abs != "/r/a" || a.count != 3 || a.ops != touchedEdit|touchedWrite || a.sub || !a.running {
		t.Errorf("a (by the session and a subagent) = %+v", a)
	}
	if got[1].abs != "/r/b" || got[2].abs != "/r/c" || !got[2].sub {
		t.Errorf("order = %+v", got)
	}
}

func TestTouchedOfFoldsCase(t *testing.T) {
	old := pathsFold
	t.Cleanup(func() { pathsFold = old })
	files := [][]touchedFile{{{abs: "/R/A.go", count: 1}}, {{abs: "/r/a.go", count: 1, sub: true}}}
	pathsFold = true
	if got, _ := touchedOf(files); len(got) != 1 || got[0].count != 2 {
		t.Errorf("folded = %+v", got)
	}
	pathsFold = false
	if got, _ := touchedOf(files); len(got) != 2 {
		t.Errorf("not folded = %+v", got)
	}
}

func TestTouchedOfLimit(t *testing.T) {
	t0 := time.Date(2026, 11, 10, 10, 0, 0, 0, time.UTC)
	var files []touchedFile
	for i := range touchedMax + 1 {
		files = append(files, touchedFile{abs: fmt.Sprintf("/r/%05d", i), count: 1, last: t0.Add(time.Duration(i) * time.Second)})
	}
	got, truncated := touchedOf([][]touchedFile{files})
	if !truncated || len(got) != touchedMax || got[0].abs != fmt.Sprintf("/r/%05d", touchedMax) {
		t.Errorf("len %d, truncated %v, first %s", len(got), truncated, got[0].abs)
	}
}

func TestTouchedOpNames(t *testing.T) {
	if got := (touchedEdit | touchedDelete | touchedMove | touchedWrite).names(); !slices.Equal(got, []string{"edit", "write", "delete", "move"}) {
		t.Errorf("names = %v", got)
	}
	if got := touchedOp(0).names(); got != nil {
		t.Errorf("no op = %v", got)
	}
}

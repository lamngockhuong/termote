package main

import (
	"bytes"
	"encoding/json"
	"image/color"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	testForkParentID = "01a0fbc2-4df0-7f32-864d-eb33100e5530"
	testForkGrandID  = "01a0fbc2-4df0-7f32-864d-eb33100e5531"
)

func codexMetaRow(ts, id, source, forkedFrom string) string {
	p := map[string]any{"id": id, "cwd": "/work", "thread_source": source}
	if forkedFrom != "" {
		p["forked_from_id"] = forkedFrom
	}
	b, _ := json.Marshal(map[string]any{"timestamp": ts, "type": "session_meta", "payload": p})
	return string(b) + "\n"
}

// codexSaid is an assistant message written at ts.
func codexSaid(ts, text string) string {
	b, _ := json.Marshal(map[string]any{"timestamp": ts, "type": "event_msg", "payload": map[string]any{
		"type": "item_completed", "turn_id": "t1",
		"item": map[string]any{"type": "AgentMessage", "id": text, "content": []any{map[string]any{"type": "text", "text": text}}},
	}})
	return string(b) + "\n"
}

// writeRolloutOn creates <home>/sessions/<day>/rollout-<day>T08-00-00-<id>.jsonl.
func writeRolloutOn(t *testing.T, home, day, id, content string) string {
	t.Helper()
	dir := filepath.Join(home, "sessions", filepath.FromSlash(day))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "rollout-"+strings.ReplaceAll(day, "/", "-")+"T08-00-00-"+id+".jsonl")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return real
}

func codexForkSession(t *testing.T, home, p, id string) AgentSession {
	t.Helper()
	return AgentSession{Agent: "codex", ID: id, CodexHome: home, Rollout: p, RolloutID: rolloutIdentity(p, nil, mustStat(t, p))}
}

func resetCodexForks(t *testing.T) {
	t.Helper()
	clear := func() {
		codexForks.Lock()
		codexForks.m = map[string][]codexForkLink{}
		codexForks.Unlock()
	}
	clear()
	t.Cleanup(clear)
}

func TestReadTranscriptCodexFork(t *testing.T) {
	resetCodexForks(t)
	home := t.TempDir()
	// The grandparent went on after the parent was forked from it, and the
	// parent after the fork: neither later part is the fork's.
	grand := writeRolloutOn(t, home, "2026/10/01", testForkGrandID,
		codexMetaRow("2026-10-01T08:00:00.000Z", testForkGrandID, "user", "")+
			codexSaid("2026-10-01T08:00:01.000Z", "g1")+
			codexSaid("2026-10-01T09:00:00.000Z", "g-after"))
	parent := writeRolloutOn(t, home, "2026/10/02", testForkParentID,
		codexMetaRow("2026-10-01T08:30:00.000Z", testForkParentID, "user", testForkGrandID)+
			codexSaid("2026-10-02T08:00:01.000Z", "p1"))
	child := writeRolloutOn(t, home, "2026/10/03", testCodexID,
		codexMetaRow("2026-10-02T08:00:01.000Z", testCodexID, "user", testForkParentID))
	appendFile(t, parent, codexSaid("2026-10-02T08:00:01.500Z", "p-after"))

	s := codexForkSession(t, home, child, testCodexID)
	first, err := readTranscript(s, "", "")
	if err != nil || !first.Reset || strings.Join(texts(first.Entries), ",") != "g1,p1" {
		t.Fatalf("first = %+v, %v", first, err)
	}
	// The fork's own rows follow, read on from the cursor.
	appendFile(t, child, codexSaid("2026-10-03T08:00:00.000Z", "c1"))
	appendFile(t, grand, codexSaid("2026-10-03T08:00:00.000Z", "g-later"))
	next, err := readTranscript(s, first.Cursor, "")
	if err != nil || next.Reset || strings.Join(texts(next.Entries), ",") != "c1" {
		t.Fatalf("next = %+v, %v", next, err)
	}
	c, _ := decodeCursor(next.Cursor)
	if !strings.HasPrefix(c.File, s.RolloutID+"+") || strings.Count(c.File, "+") != 2 {
		t.Errorf("cursor file = %q", c.File)
	}

	// A parent replaced since it was found: the fork reads as itself, and
	// its ancestors are looked up again next time.
	tmp := parent + ".new"
	if err := os.WriteFile(tmp, []byte(codexMetaRow("2026-10-01T08:30:00.000Z", testForkParentID, "user", "")+
		codexSaid("2026-10-02T08:00:00.000Z", "p0")), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, parent); err != nil {
		t.Fatal(err)
	}
	if fileIdentity(mustStat(t, parent)) == "" {
		return // no identity to tell the files apart (Windows)
	}
	alone, err := readTranscript(s, next.Cursor, "")
	if err != nil || !alone.Reset || strings.Join(texts(alone.Entries), ",") != "c1" {
		t.Fatalf("replaced parent = %+v, %v", alone, err)
	}
	again, err := readTranscript(s, "", "")
	if err != nil || strings.Join(texts(again.Entries), ",") != "p0,c1" {
		t.Fatalf("found again = %+v, %v", again, err)
	}
}

func TestReadTranscriptCodexForkReadsAsItself(t *testing.T) {
	for name, tc := range map[string]struct {
		meta   string
		parent bool
	}{
		"subagent thread":    {codexMetaRow("2026-10-02T09:00:00Z", testCodexID, "subagent", testForkParentID), true},
		"parent missing":     {codexMetaRow("2026-10-02T09:00:00Z", testCodexID, "user", testForkGrandID), true},
		"no fork":            {codexMetaRow("2026-10-02T09:00:00Z", testCodexID, "user", ""), true},
		"forked from itself": {codexMetaRow("2026-10-02T09:00:00Z", testCodexID, "user", testCodexID), true},
		"bad fork time":      {codexMetaRow("yesterday", testCodexID, "user", testForkParentID), true},
		"parent is newer":    {codexMetaRow("2026-10-02T07:00:00Z", testCodexID, "user", testForkParentID), true},
		"no session_meta":    {`{"timestamp":"2026-10-02T09:00:00Z","type":"turn_context"}` + "\n", true},
	} {
		t.Run(name, func(t *testing.T) {
			resetCodexForks(t)
			home := t.TempDir()
			if tc.parent {
				writeRolloutOn(t, home, "2026/10/02", testForkParentID,
					codexMetaRow("2026-10-02T08:00:00Z", testForkParentID, "user", "")+codexSaid("2026-10-02T08:00:01Z", "p1"))
			}
			child := writeRolloutOn(t, home, "2026/10/02", testCodexID, tc.meta+codexSaid("2026-10-02T09:00:01Z", "c1"))
			s := codexForkSession(t, home, child, testCodexID)
			got, err := readTranscript(s, "", "")
			if err != nil || strings.Join(texts(got.Entries), ",") != "c1" {
				t.Fatalf("= %+v, %v", got, err)
			}
			if c, _ := decodeCursor(got.Cursor); strings.Contains(c.File, "+") {
				t.Errorf("cursor file = %q", c.File)
			}
		})
	}
}

func TestReadTranscriptCodexForkWrongParentFile(t *testing.T) {
	resetCodexForks(t)
	home := t.TempDir()
	// A file named after the parent whose session_meta is another thread's.
	writeRolloutOn(t, home, "2026/10/02", testForkParentID,
		codexMetaRow("2026-10-02T08:00:00Z", testForkGrandID, "user", "")+codexSaid("2026-10-02T08:00:01Z", "p1"))
	child := writeRolloutOn(t, home, "2026/10/02", testCodexID,
		codexMetaRow("2026-10-02T09:00:00Z", testCodexID, "user", testForkParentID)+codexSaid("2026-10-02T09:00:01Z", "c1"))
	got, err := readTranscript(codexForkSession(t, home, child, testCodexID), "", "")
	if err != nil || strings.Join(texts(got.Entries), ",") != "c1" {
		t.Fatalf("= %+v, %v", got, err)
	}
}

func TestFindCodexRolloutBounds(t *testing.T) {
	home := t.TempDir()
	sessions := filepath.Join(home, "sessions")
	parent := writeRolloutOn(t, home, "2026/10/01", testForkParentID, "")
	child := writeRolloutOn(t, home, "2026/10/02", testCodexID, "")
	// A rollout of a later day than the child's is never the parent.
	writeRolloutOn(t, home, "2026/10/03", testForkGrandID, "")
	sessions, _ = filepath.EvalSymlinks(sessions)
	if p, ok := findCodexRollout(sessions, child, testForkParentID); !ok || p != parent {
		t.Errorf("parent = %q %v", p, ok)
	}
	if _, ok := findCodexRollout(sessions, child, testForkGrandID); ok {
		t.Error("found a later day's rollout")
	}
	if _, ok := findCodexRollout(sessions, filepath.Join(home, "x.jsonl"), testForkParentID); ok {
		t.Error("found from outside the day dirs")
	}
	old := historyMaxScan
	historyMaxScan = 1
	t.Cleanup(func() { historyMaxScan = old })
	if _, ok := findCodexRollout(sessions, child, testForkParentID); ok {
		t.Error("looked past historyMaxScan rollouts")
	}
}

func TestCodexCutAt(t *testing.T) {
	at := time.Date(2026, 10, 2, 8, 0, 0, 0, time.UTC)
	long := `{"type":"x","pad":"` + strings.Repeat("a", 100<<10) + `","timestamp":"2026-10-02T09:00:00Z"}` + "\n"
	for name, tc := range map[string]struct {
		rows string
		want int
	}{
		"cut at the first later row": {codexSaid("2026-10-02T07:00:00Z", "a") + codexSaid("2026-10-02T08:00:00Z", "b") + codexSaid("2026-10-02T08:00:00.001Z", "c"), 2},
		"every row before":           {codexSaid("2026-10-02T07:00:00Z", "a"), 1},
		"a partial last row":         {codexSaid("2026-10-02T07:00:00Z", "a") + `{"timestamp":"2026-10-02T07:00:01Z"`, 1},
		"not JSON is kept":           {"garbage\n" + codexSaid("2026-10-02T09:00:00Z", "b"), 1},
		"no timestamp is kept":       {`{"type":"x"}` + "\n" + codexSaid("2026-10-02T09:00:00Z", "b"), 1},
		"timestamp not first":        {`{"type":"x","timestamp":"2026-10-02T09:00:00Z"}` + "\n", 0},
		"a long row, time not first": {codexSaid("2026-10-02T07:00:00Z", "a") + long, 2},
	} {
		t.Run(name, func(t *testing.T) {
			lines := strings.SplitAfter(tc.rows, "\n")
			want := int64(len(strings.Join(lines[:tc.want], "")))
			if got := codexCutAt(strings.NewReader(tc.rows), int64(len(tc.rows)), at); got != want {
				t.Errorf("= %d, want %d", got, want)
			}
		})
	}
}

func TestCodexForkReader(t *testing.T) {
	dir := t.TempDir()
	open := func(name, content string) *os.File {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		f, err := os.Open(p)
		if err != nil {
			t.Fatal(err)
		}
		return f
	}
	r := &codexForkReader{parts: []codexForkPart{
		{open("a", "abcXX"), 0, 3}, {open("b", "de"), 3, 2}, {open("c", "fgh"), 5, 3},
	}}
	defer r.Close()
	if b, err := io.ReadAll(io.NewSectionReader(r, 0, 8)); err != nil || string(b) != "abcdefgh" {
		t.Errorf("all = %q %v", b, err)
	}
	buf := make([]byte, 4)
	if n, err := r.ReadAt(buf, 2); n != 4 || err != nil || string(buf) != "cdef" {
		t.Errorf("across = %d %v %q", n, err, buf)
	}
	if n, err := r.ReadAt(buf, 6); n != 2 || err != io.EOF || string(buf[:n]) != "gh" {
		t.Errorf("past the end = %d %v", n, err)
	}
	if _, err := r.ReadAt(buf, -1); err == nil {
		t.Error("negative offset read")
	}
	// A part shorter than it was found: not read as if it were complete.
	short := &codexForkReader{parts: []codexForkPart{{open("d", "ab"), 0, 4}}}
	defer short.Close()
	if n, err := short.ReadAt(buf, 0); n != 2 || err != io.ErrUnexpectedEOF {
		t.Errorf("short = %d %v", n, err)
	}
}

func TestAgentImageServesCodexForkParentImages(t *testing.T) {
	resetCodexForks(t)
	red := testPNG(t, color.RGBA{255, 0, 0, 255})
	home := t.TempDir()
	writeRolloutOn(t, home, "2026/11/13", testForkParentID,
		codexMetaRow("2026-11-13T00:00:00Z", testForkParentID, "user", "")+
			codexInput(dataURL("image/png", red))+
			codexImageMessage("m1", codexLocalImage("/tmp/p0.png")))
	child := writeRolloutOn(t, home, "2026/11/15", testCodexID,
		codexMetaRow("2026-11-15T00:00:00Z", testCodexID, "user", testForkParentID))
	mux, _ := subagentsServer(t, codexForkSession(t, home, child, testCodexID))
	refs := imageRefs(getTranscriptRes(t, mux))
	if len(refs) != 1 || refs[0] == "" {
		t.Fatalf("refs = %q", refs)
	}
	if rec := getImage(mux, refs[0], nil); rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), red) {
		t.Fatalf("image = %d (%d bytes)", rec.Code, rec.Body.Len())
	}
}

func TestReadTranscriptCodexForkSessionMetaLater(t *testing.T) {
	resetCodexForks(t)
	home := t.TempDir()
	writeRolloutOn(t, home, "2026/10/02", testForkParentID,
		codexMetaRow("2026-10-02T08:00:00Z", testForkParentID, "user", "")+codexSaid("2026-10-02T08:00:01Z", "p1"))
	// session_meta not written in full yet: read as itself, looked at again.
	meta := codexMetaRow("2026-10-02T09:00:00Z", testCodexID, "user", testForkParentID)
	child := writeRolloutOn(t, home, "2026/10/02", testCodexID, meta[:20])
	s := codexForkSession(t, home, child, testCodexID)
	if got, err := readTranscript(s, "", ""); err != nil || len(got.Entries) != 0 {
		t.Fatalf("partial meta = %+v, %v", got, err)
	}
	appendFile(t, child, meta[20:])
	if got, err := readTranscript(s, "", ""); err != nil || strings.Join(texts(got.Entries), ",") != "p1" {
		t.Fatalf("meta written = %+v, %v", got, err)
	}
}

func TestCodexForkCacheStartsOver(t *testing.T) {
	resetCodexForks(t)
	codexForks.Lock()
	for i := range codexForkCacheMax {
		codexForks.m[strconv.Itoa(i)] = nil
	}
	codexForks.Unlock()
	home := t.TempDir()
	child := writeRolloutOn(t, home, "2026/10/02", testCodexID, codexMetaRow("2026-10-02T09:00:00Z", testCodexID, "user", ""))
	if _, err := readTranscript(codexForkSession(t, home, child, testCodexID), "", ""); err != nil {
		t.Fatal(err)
	}
	codexForks.Lock()
	n := len(codexForks.m)
	codexForks.Unlock()
	if n != 1 {
		t.Errorf("cache holds %d", n)
	}
}

func TestCodexForkViewWithoutSessions(t *testing.T) {
	f, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, home := range []string{"", "relative", t.TempDir()} {
		if r, _, id := codexForkView(home, "/x", f, 0, "i"); r != f || id != "i" {
			t.Errorf("%q = %v %q", home, r, id)
		}
	}
}

func TestReadTranscriptCodexForkParentOutsideOrMisnamed(t *testing.T) {
	for name, target := range map[string]func(home string) string{
		// The name resolves outside sessions.
		"outside": func(string) string {
			p := filepath.Join(t.TempDir(), "rollout-2026-10-02T08-00-00-"+testForkParentID+".jsonl")
			os.WriteFile(p, []byte(codexMetaRow("2026-10-02T08:00:00Z", testForkParentID, "user", "")+codexSaid("2026-10-02T08:00:01Z", "p1")), 0o600)
			return p
		},
		// The name resolves to another thread's rollout.
		"misnamed": func(home string) string {
			return writeRolloutOn(t, home, "2026/10/01", testForkGrandID,
				codexMetaRow("2026-10-02T08:00:00Z", testForkParentID, "user", "")+codexSaid("2026-10-02T08:00:01Z", "p1"))
		},
	} {
		t.Run(name, func(t *testing.T) {
			resetCodexForks(t)
			home := t.TempDir()
			day := filepath.Join(home, "sessions", "2026", "10", "02")
			if err := os.MkdirAll(day, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target(home), filepath.Join(day, "rollout-2026-10-02T07-00-00-"+testForkParentID+".jsonl")); err != nil {
				t.Skip("no symlinks:", err)
			}
			child := writeRolloutOn(t, home, "2026/10/02", testCodexID,
				codexMetaRow("2026-10-02T09:00:00Z", testCodexID, "user", testForkParentID)+codexSaid("2026-10-02T09:00:01Z", "c1"))
			got, err := readTranscript(codexForkSession(t, home, child, testCodexID), "", "")
			if err != nil || strings.Join(texts(got.Entries), ",") != "c1" {
				t.Fatalf("= %+v, %v", got, err)
			}
		})
	}
}

func TestFindCodexRolloutSkipsOddEntries(t *testing.T) {
	home := t.TempDir()
	parent := writeRolloutOn(t, home, "2026/10/01", testForkParentID, "")
	child := writeRolloutOn(t, home, "2026/10/03", testCodexID, "")
	// A directory named like a rollout, and a day dir that cannot be read.
	if err := os.Mkdir(filepath.Join(filepath.Dir(child), "rollout-2026-10-02T09-00-00-"+testForkParentID+".jsonl"), 0o700); err != nil {
		t.Fatal(err)
	}
	locked := filepath.Join(home, "sessions", "2026", "10", "02")
	if err := os.Mkdir(locked, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(locked, 0o700) })
	sessions, _ := filepath.EvalSymlinks(filepath.Join(home, "sessions"))
	if p, ok := findCodexRollout(sessions, child, testForkParentID); !ok || p != parent {
		t.Errorf("parent = %q %v", p, ok)
	}
}

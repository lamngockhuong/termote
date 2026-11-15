package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// codexMetaLine is a session_meta first line; extra fields go into its
// payload.
func codexMetaLine(id, cwd string, extra map[string]any) string {
	p := map[string]any{"id": id, "cwd": cwd, "base_instructions": map[string]any{"text": "be good"}}
	for k, v := range extra {
		p[k] = v
	}
	b, _ := json.Marshal(map[string]any{"type": "session_meta", "payload": p})
	return string(b)
}

func codexUserLine(text string) string {
	b, _ := json.Marshal(map[string]any{"type": "event_msg", "payload": map[string]any{"type": "user_message", "message": text}})
	return string(b)
}

// writeCodexRollout writes a rollout of id run in cwd on mtime's day.
func writeHistoryRollout(t *testing.T, codexHome, id, cwd, prompt string, mtime time.Time) string {
	t.Helper()
	body := codexMetaLine(id, cwd, nil) + "\n" + codexUserLine(prompt) + "\n"
	return writeCodexFile(t, codexHome, id, body, mtime)
}

func writeCodexFile(t *testing.T, codexHome, id, body string, mtime time.Time) string {
	t.Helper()
	day := filepath.Join(codexHome, "sessions", mtime.Format("2006"), mtime.Format("01"), mtime.Format("02"))
	p := filepath.Join(day, "rollout-"+mtime.Format("2006-01-02T15-04-05")+"-"+id+".jsonl")
	writeFile(t, p, body)
	if err := os.Chtimes(p, mtime, mtime); err != nil {
		t.Fatal(err)
	}
	return p
}

func parseCodexFile(t *testing.T, id, body string) (historyFile, bool) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "r.jsonl")
	writeFile(t, p, body)
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	fi, _ := f.Stat()
	return parseCodexHistory(f, fi.Size(), id)
}

func TestParseCodexHistory(t *testing.T) {
	got, ok := parseCodexFile(t, histID1, codexMetaLine(histID1, "/r", map[string]any{"git": map[string]any{"branch": "dev"}})+"\n"+codexUserLine("fix tests")+"\n")
	if !ok || got.title != "fix tests" || got.src != titlePrompt || got.cwd != "/r" || got.branch != "dev" || got.child {
		t.Fatalf("parse = %+v %v", got, ok)
	}
	// A thread a subagent started is marked, not the user's.
	got, _ = parseCodexFile(t, histID1, codexMetaLine(histID1, "/r", map[string]any{"thread_source": "subagent"})+"\n")
	if !got.child || got.title != "" {
		t.Errorf("child = %+v", got)
	}
	for name, body := range map[string]string{
		"other id":     codexMetaLine(histID2, "/r", nil) + "\n",
		"not meta":     codexUserLine("x") + "\n" + codexMetaLine(histID1, "/r", nil) + "\n",
		"no cwd":       codexMetaLine(histID1, "", nil) + "\n",
		"no line end":  codexMetaLine(histID1, "/r", nil),
		"broken JSON":  "{\n",
		"line too big": codexMetaLine(histID1, "/r", map[string]any{"base_instructions": strings.Repeat("x", historyCodexMeta)}) + "\n",
	} {
		if got, ok := parseCodexFile(t, histID1, body); ok {
			t.Errorf("%s: kept %+v", name, got)
		}
	}
	// The first prompt after the agent's own words, with more beyond the
	// read.
	got, _ = parseCodexFile(t, histID1, codexMetaLine(histID1, "/r", nil)+"\n"+
		`{"type":"event_msg","payload":{"type":"agent_message","message":"hello"}}`+"\n"+
		codexUserLine("the ask")+"\n"+codexUserLine(strings.Repeat("z", historyHead*2))+"\n")
	if got.title != "the ask" {
		t.Errorf("after agent = %+v", got)
	}
	// A prompt cut off by the read: no title, still listed.
	got, ok = parseCodexFile(t, histID1, codexMetaLine(histID1, "/r", nil)+"\n"+codexUserLine(strings.Repeat("y", historyHead*2))+"\n")
	if !ok || got.title != "" {
		t.Errorf("long prompt = %+v %v", got, ok)
	}
}

func TestScanCodex(t *testing.T) {
	fx := newHistoryFixture(t)
	day1 := time.Date(2026, 9, 30, 10, 0, 0, 0, time.Local)
	day2 := time.Date(2026, 10, 2, 10, 0, 0, 0, time.Local)
	writeHistoryRollout(t, fx.codex, histID1, fx.root, "old one", day1)
	writeHistoryRollout(t, fx.codex, histID2, filepath.Join(fx.root, "sub"), "new one", day2)
	writeHistoryRollout(t, fx.codex, histID3, "/elsewhere", "other", day2)
	// A subagent's thread in the root is not listed.
	writeCodexFile(t, fx.codex, "aaaaaaaa-0000-4000-8000-000000000009", codexMetaLine("aaaaaaaa-0000-4000-8000-000000000009", fx.root, map[string]any{"thread_source": "subagent"})+"\n", day1)
	// Files and dirs that are no rollout of a day are passed over.
	writeFile(t, filepath.Join(fx.codex, "sessions", "2026", "10", "02", "notes.jsonl"), "x")
	writeFile(t, filepath.Join(fx.codex, "sessions", "2026", "10", "02", "rollout-x-"+strings.ToUpper(histID1)+".jsonl"), "x")
	os.MkdirAll(filepath.Join(fx.codex, "sessions", "archive"), 0o755)
	writeFile(t, filepath.Join(fx.codex, "sessions", "2026", "readme"), "x")
	// The index names a thread; a broken line or an id of another form is
	// skipped.
	writeFile(t, filepath.Join(fx.codex, "session_index.jsonl"), strings.Join([]string{
		`{"id":"` + histID2 + `","thread_name":"First name"}`,
		`{"id":"` + histID2 + `","thread_name":"Renamed\u0007"}`,
		`{"id":"NOT-AN-ID","thread_name":"x"}`,
		`{broken`,
		`{"id":"` + histID1 + `","thread_name":"   "}`,
	}, "\n")+"\n")
	got, truncated := fx.h.scanCodex(fx.codex, fx.root)
	if truncated || len(got) != 2 {
		t.Fatalf("scan = %+v %v", got, truncated)
	}
	if got[0].ID != histID2 || got[0].Title != "Renamed" || got[0].TitleSource != titleCustom || got[0].Cwd != "sub" {
		t.Errorf("newest = %+v", got[0])
	}
	if got[1].ID != histID1 || got[1].Title != "old one" || got[1].TitleSource != titlePrompt {
		t.Errorf("oldest = %+v", got[1])
	}
	old := historyMaxScan
	historyMaxScan = 2
	t.Cleanup(func() { historyMaxScan = old })
	got, truncated = fx.h.scanCodex(fx.codex, fx.root)
	// The two newest rollouts (one of them elsewhere) are all it reads.
	if !truncated || len(got) != 1 || got[0].ID != histID2 {
		t.Errorf("limited scan = %+v %v", got, truncated)
	}
	for _, home := range []string{"", "rel", filepath.Join(fx.root, "none"), fx.root} {
		if got, _ := fx.h.scanCodex(home, fx.root); got != nil {
			t.Errorf("home %q = %v", home, got)
		}
	}
}

func TestScanCodexSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	fx := newHistoryFixture(t)
	outside := realTemp(t)
	now := time.Date(2026, 10, 2, 10, 0, 0, 0, time.Local)
	// A rollout linked from outside the sessions dir is not read.
	target := filepath.Join(outside, "rollout-2026-10-02T10-00-00-"+histID1+".jsonl")
	writeFile(t, target, codexMetaLine(histID1, fx.root, nil)+"\n")
	day := filepath.Join(fx.codex, "sessions", "2026", "10", "02")
	os.MkdirAll(day, 0o755)
	os.Symlink(target, filepath.Join(day, filepath.Base(target)))
	// A link inside it to a rollout of another id is not read either.
	other := writeHistoryRollout(t, fx.codex, histID3, fx.root, "x", now.Add(-48*time.Hour))
	os.Symlink(other, filepath.Join(day, "rollout-2026-10-02T10-00-01-"+histID2+".jsonl"))
	// The index read through a link to outside is ignored.
	writeFile(t, filepath.Join(outside, "idx"), `{"id":"`+histID3+`","thread_name":"leaked"}`+"\n")
	os.Symlink(filepath.Join(outside, "idx"), filepath.Join(fx.codex, "session_index.jsonl"))
	got, _ := fx.h.scanCodex(fx.codex, fx.root)
	if len(got) != 1 || got[0].ID != histID3 || got[0].Title != "x" {
		t.Fatalf("scan = %+v", got)
	}
}

func TestNumberedDirs(t *testing.T) {
	d := t.TempDir()
	for _, n := range []string{"9", "10", "02", "x", "-1"} {
		os.MkdirAll(filepath.Join(d, n), 0o755)
	}
	writeFile(t, filepath.Join(d, "11"), "a file")
	if got := strings.Join(numberedDirs(d), ","); got != "10,9,02" {
		t.Errorf("numberedDirs = %s", got)
	}
	if numberedDirs(filepath.Join(d, "none")) != nil {
		t.Error("missing dir")
	}
}

func TestScanCodexForkTitles(t *testing.T) {
	fx := newHistoryFixture(t)
	day := time.Date(2026, 10, 2, 10, 0, 0, 0, time.Local)
	fork := func(id, from string, at time.Time) {
		writeCodexFile(t, fx.codex, id, codexMetaLine(id, fx.root, map[string]any{"thread_source": "user", "forked_from_id": from})+"\n", at)
	}
	const (
		named  = "aaaaaaaa-0000-4000-8000-000000000091"
		gone   = "aaaaaaaa-0000-4000-8000-000000000092"
		fork1  = "aaaaaaaa-0000-4000-8000-000000000011"
		fork2  = "aaaaaaaa-0000-4000-8000-000000000012"
		fork3  = "aaaaaaaa-0000-4000-8000-000000000013"
		fork4  = "aaaaaaaa-0000-4000-8000-000000000014"
		itself = "aaaaaaaa-0000-4000-8000-000000000015"
	)
	writeHistoryRollout(t, fx.codex, histID1, fx.root, "the ask", day)
	fork(fork1, histID1, day.Add(time.Minute))
	// A fork of a fork, listed before its parent.
	fork(fork2, fork1, day.Add(2*time.Minute))
	// A parent the index names but the scan does not list.
	writeFile(t, filepath.Join(fx.codex, "session_index.jsonl"), `{"id":"`+named+`","thread_name":"Named"}`+"\n")
	fork(fork3, named, day.Add(3*time.Minute))
	// A parent nowhere, and a fork naming itself: no title.
	fork(fork4, gone, day.Add(4*time.Minute))
	fork(itself, itself, day.Add(5*time.Minute))
	// A fork with a prompt of its own keeps it.
	writeCodexFile(t, fx.codex, histID2, codexMetaLine(histID2, fx.root, map[string]any{"thread_source": "user", "forked_from_id": histID1})+"\n"+codexUserLine("own ask")+"\n", day.Add(6*time.Minute))
	got, _ := fx.h.scanCodex(fx.codex, fx.root)
	titles := map[string]string{}
	for _, s := range got {
		titles[s.ID] = s.Title + "/" + s.TitleSource
	}
	want := map[string]string{
		histID1: "the ask/prompt", fork1: "the ask/prompt", fork2: "the ask/prompt", fork3: "Named/custom",
		fork4: "/prompt", itself: "/prompt", histID2: "own ask/prompt",
	}
	for id, w := range want {
		if titles[id] != w {
			t.Errorf("%s = %q, want %q", id, titles[id], w)
		}
	}
}

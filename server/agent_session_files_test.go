package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
	"time"
)

const (
	codexParent = "01a00000-0000-7000-8000-0000000000a1"
	codexChild  = "01a00000-0000-7000-8000-0000000000b1"
	codexGrand  = "01a00000-0000-7000-8000-0000000000c1"
	codexOther  = "01a00000-0000-7000-8000-0000000000d1"
)

// sessionFileNames opens s's files and lists their base names, a subagent's
// marked with a "+".
func sessionFileNames(t *testing.T, h *historyAPI, s AgentSession) ([]string, error) {
	t.Helper()
	files, err := h.sessionFiles(s)
	defer closeSessionFiles(files)
	var out []string
	for _, f := range files {
		n := filepath.Base(f.path)
		if f.sub {
			n = "+" + n
		}
		out = append(out, n)
	}
	return out, err
}

func canSymlink(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need a privilege on Windows")
	}
}

func TestClaudeSessionFiles(t *testing.T) {
	fx := newHistoryFixture(t)
	writeClaudeSession(t, fx.claude, fx.root, histID1, claudeRows(fx.root, "main", "hi"), time.Now())
	s := AgentSession{Agent: "claude", ID: histID1, ClaudeDir: fx.claude}
	// No subagents directory: the transcript alone.
	if got, err := sessionFileNames(t, fx.h, s); err != nil || len(got) != 1 || got[0] != histID1+".jsonl" {
		t.Fatalf("alone = %v %v", got, err)
	}
	subs := filepath.Join(fx.claude, "projects", claudeProjectName(fx.root), histID1, "subagents")
	writeFile(t, filepath.Join(subs, "agent-a1.jsonl"), "{}\n")
	writeFile(t, filepath.Join(subs, "agent-a1.meta.json"), "{}")
	writeFile(t, filepath.Join(subs, "notes.jsonl"), "{}\n")
	if err := os.Mkdir(filepath.Join(subs, "agent-dir.jsonl"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := sessionFileNames(t, fx.h, s)
	if err != nil || !slices.Equal(got, []string{histID1 + ".jsonl", "+agent-a1.jsonl"}) {
		t.Errorf("with a subagent = %v %v", got, err)
	}

	// Not written yet, none at all, another agent.
	if _, err := sessionFileNames(t, fx.h, AgentSession{Agent: "claude", ID: histID2, ClaudeDir: fx.claude}); !errors.Is(err, errTranscriptNotWritten) {
		t.Errorf("not written = %v", err)
	}
	if _, err := sessionFileNames(t, fx.h, AgentSession{Agent: "claude", ID: histID1}); !errors.Is(err, errNoTranscript) {
		t.Errorf("no dir = %v", err)
	}
	if _, err := sessionFileNames(t, fx.h, AgentSession{Agent: "gemini"}); !errors.Is(err, errAgentUnsupported) {
		t.Errorf("gemini = %v", err)
	}
}

func TestClaudeSessionFilesLinks(t *testing.T) {
	canSymlink(t)
	fx := newHistoryFixture(t)
	writeClaudeSession(t, fx.claude, fx.root, histID1, claudeRows(fx.root, "main", "hi"), time.Now())
	s := AgentSession{Agent: "claude", ID: histID1, ClaudeDir: fx.claude}
	outside := filepath.Join(realTemp(t), "agent-x.jsonl")
	writeFile(t, outside, "{}\n")
	// A subagent file that is a link is never read.
	subs := filepath.Join(fx.claude, "projects", claudeProjectName(fx.root), histID1, "subagents")
	writeFile(t, filepath.Join(subs, "agent-a1.jsonl"), "{}\n")
	if err := os.Symlink(outside, filepath.Join(subs, "agent-x.jsonl")); err != nil {
		t.Fatal(err)
	}
	if got, _ := sessionFileNames(t, fx.h, s); !slices.Equal(got, []string{histID1 + ".jsonl", "+agent-a1.jsonl"}) {
		t.Errorf("linked file = %v", got)
	}
	// Nor a subagents directory that is a link.
	if err := os.RemoveAll(subs); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(outside), subs); err != nil {
		t.Fatal(err)
	}
	if got, _ := sessionFileNames(t, fx.h, s); len(got) != 1 {
		t.Errorf("linked dir = %v", got)
	}
	// A transcript linked from another project dir has no subagents read.
	if err := os.Remove(subs); err != nil {
		t.Fatal(err)
	}
	if p, ok := claudeSessionProject(fx.claude, filepath.Join(fx.claude, "elsewhere", histID1+".jsonl"), histID1); ok {
		t.Errorf("project of a moved transcript = %q", p)
	}
}

func TestCodexSessionFiles(t *testing.T) {
	fx := newHistoryFixture(t)
	day := time.Date(2026, 11, 10, 9, 0, 0, 0, time.Local)
	sub := func(id, parent string, at time.Time) string {
		meta := codexMetaLine(id, fx.root, map[string]any{"thread_source": "subagent", "parent_thread_id": parent})
		return writeCodexFile(t, fx.codex, id, meta+"\n", at)
	}
	parent := writeHistoryRollout(t, fx.codex, codexParent, fx.root, "go", day)
	sub(codexChild, codexParent, day.Add(time.Minute))
	// A thread of the child, started the next day.
	sub(codexGrand, codexChild, day.Add(25*time.Hour))
	// Another parent's, a tool's and a day before the parent's: none.
	sub(codexOther, histID3, day.Add(2*time.Minute))
	writeCodexFile(t, fx.codex, histID2, codexMetaLine(histID2, fx.root, map[string]any{"thread_source": "exec", "parent_thread_id": codexParent})+"\n", day.Add(3*time.Minute))
	sub(histID3, codexParent, day.Add(-48*time.Hour))
	// A forked_from_id names the parent of an older subagent.
	writeCodexFile(t, fx.codex, histID1, codexMetaLine(histID1, fx.root, map[string]any{"thread_source": "subagent", "forked_from_id": codexParent})+"\n", day.Add(4*time.Minute))

	s := AgentSession{Agent: "codex", ID: codexParent, CodexHome: fx.codex, Rollout: parent}
	got, err := sessionFileNames(t, fx.h, s)
	if err != nil || len(got) != 4 {
		t.Fatalf("files = %v %v", got, err)
	}
	want := []string{filepath.Base(parent), "+" + filepath.Base(fx.codexPath(t, codexChild)), "+" + filepath.Base(fx.codexPath(t, histID1)),
		"+" + filepath.Base(fx.codexPath(t, codexGrand))}
	if !slices.Equal(got, want) {
		t.Errorf("files = %v, want %v", got, want)
	}

	// The scan stops after historyMaxScan rollouts.
	old := historyMaxScan
	historyMaxScan = 1
	t.Cleanup(func() { historyMaxScan = old })
	if got, _ := sessionFileNames(t, fx.h, s); len(got) != 2 {
		t.Errorf("limited = %v", got)
	}
	historyMaxScan = old

	// A rollout outside the day dirs has no children found; a missing one
	// is no transcript.
	if kids := fx.h.codexChildRollouts(filepath.Join(fx.codex, "sessions"), filepath.Join(fx.codex, "sessions", "x.jsonl"), codexParent); kids != nil {
		t.Errorf("children of a loose rollout = %v", kids)
	}
	if _, err := sessionFileNames(t, fx.h, AgentSession{Agent: "codex", ID: codexOther, CodexHome: fx.codex, Rollout: parent}); !errors.Is(err, errNoTranscript) {
		t.Errorf("wrong id = %v", err)
	}
}

// codexPath finds the rollout of id under fx.codex.
func (fx *historyFixture) codexPath(t *testing.T, id string) string {
	t.Helper()
	m, _ := filepath.Glob(filepath.Join(fx.codex, "sessions", "*", "*", "*", "rollout-*-"+id+".jsonl"))
	if len(m) != 1 {
		t.Fatalf("rollout of %s: %v", id, m)
	}
	return m[0]
}

func TestDayBefore(t *testing.T) {
	for _, c := range []struct {
		a, b []string
		want bool
	}{
		{[]string{"2026", "11", "09"}, []string{"2026", "11", "10"}, true},
		{[]string{"2026", "11", "10"}, []string{"2026", "11", "10"}, false},
		{[]string{"2027", "01", "01"}, []string{"2026", "12", "31"}, false},
		{[]string{"2026", "9", "30"}, []string{"2026", "10", "01"}, true},
	} {
		if got := dayBefore(c.a, c.b); got != c.want {
			t.Errorf("dayBefore(%v, %v) = %v", c.a, c.b, got)
		}
	}
	if numberOf("1x") != -1 || numberOf("012") != 12 {
		t.Error("numberOf")
	}
}

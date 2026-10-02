package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeCodexExe copies sh to <tmp>/codex, so a process runs with an
// executable named codex.
func fakeCodexExe(t *testing.T) string {
	t.Helper()
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	b, err := os.ReadFile(sh)
	if err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(exe, b, 0o755); err != nil {
		t.Fatal(err)
	}
	return exe
}

// startFakeCodex runs `sh → codex -c script codex args...` (the codex being
// sh under another name) and returns the root sh and the codex pid once
// script reached `sleep 30 & wait`.
func startFakeCodex(t *testing.T, env []string, script string, args ...string) (root, codex int) {
	t.Helper()
	argv := append([]string{"-c", `"$FAKE_CODEX" -c "$FAKE_SCRIPT" codex "$@" & wait`, "sh"}, args...)
	cmd := exec.Command("sh", argv...)
	cmd.Env = append(os.Environ(), append(env, "FAKE_CODEX="+fakeCodexExe(t), "FAKE_SCRIPT="+script+"\nsleep 30 & wait")...)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		children, _ := procChildrenFunc()
		for _, c := range children(cmd.Process.Pid) {
			for _, gc := range children(c) {
				syscallKill(gc)
			}
			syscallKill(c)
		}
		cmd.Process.Kill()
		cmd.Wait()
	})
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		children, _ := procChildrenFunc()
		for _, c := range children(cmd.Process.Pid) {
			if procExeBase(c) == codexExeName && len(children(c)) > 0 {
				return cmd.Process.Pid, c
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("fake codex did not start")
	return 0, 0
}

func syscallKill(pid int) {
	if p, err := os.FindProcess(pid); err == nil {
		p.Kill()
	}
}

// writeCodexRollout writes a rollout with its session_meta and an open turn.
func writeCodexRollout(t *testing.T, home, id, source string) string {
	t.Helper()
	meta := fmt.Sprintf(`{"type":"session_meta","payload":{"id":%q,"thread_source":%q}}`+"\n", id, source)
	return writeRollout(t, home, id, meta+codexEvent(map[string]any{"type": "task_started"}))
}

func TestFindCodexSessionUnderPane(t *testing.T) {
	home := t.TempDir()
	p := writeCodexRollout(t, home, testCodexID, "user")
	root, codex := startFakeCodex(t, []string{"CODEX_HOME=" + home, "R=" + p}, `exec 3>>"$R"`)
	s, ok := findClaudeSession("codex-under-pane", root)
	if ok && s.Status != "unknown" {
		t.Errorf("status before the first scan finished = %q", s.Status)
	}
	// The first status scan runs in the background.
	waitFor(t, func() bool { s, ok = findClaudeSession("codex-under-pane", root); return s.Status == "working" })
	real, _ := filepath.EvalSymlinks(p)
	start, _ := procStartTime(codex)
	if !ok || s.Agent != "codex" || s.ID != testCodexID || s.Rollout != real || s.CodexHome != home ||
		s.RolloutID != fileIdentity(mustStat(t, p)) || s.Status != "working" || s.PID != codex || s.ProcStart != start {
		t.Fatalf("session = %+v, %v", s, ok)
	}
	// The transcript route reads that file.
	appendFile(t, p, codexItemRow(map[string]any{"type": "AgentMessage", "content": []any{map[string]any{"type": "text", "text": "hi"}}}))
	if r, err := readTranscript(s, "", ""); err != nil || strings.Join(texts(r.Entries), ",") != "hi" {
		t.Errorf("transcript = %+v, %v", r, err)
	}
	if s, ok := findClaudeSessionNow(root); ok || s.Agent != "" {
		// The fake codex runs in the background of its sh, not in a
		// terminal's foreground: a write would be refused.
		t.Errorf("background codex accepted for a write: %+v", s)
	}
}

func TestFindCodexSessionRefusals(t *testing.T) {
	home := t.TempDir()
	user := writeCodexRollout(t, home, testCodexID, "user")
	other := writeCodexRollout(t, home, "01a0fbc8-691f-74a1-a8f8-9e1e78f963dd", "user")
	sub := writeCodexRollout(t, home, testCodexSubID, "subagent")
	outsideHome := t.TempDir()
	outside := writeCodexRollout(t, outsideHome, testCodexID, "user")
	link := filepath.Join(filepath.Dir(user), "rollout-2026-10-02T09-00-00-"+testCodexID+".jsonl")
	os.Remove(user)
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	user = writeCodexRollout(t, home, testCodexID, "user")

	for name, c := range map[string]struct {
		env    []string
		script string
		args   []string
	}{
		"read-only fd":           {[]string{"CODEX_HOME=" + home, "R=" + user}, `exec 3<"$R"`, nil},
		"app-server daemon":      {[]string{"CODEX_HOME=" + home, "R=" + user}, `exec 3>>"$R"`, []string{"app-server", "--managed-daemon"}},
		"file outside sessions":  {[]string{"CODEX_HOME=" + home, "R=" + outside}, `exec 3>>"$R"`, nil},
		"symlink out of session": {[]string{"CODEX_HOME=" + home, "R=" + link}, `exec 3>>"$R"`, nil},
		"two user threads":       {[]string{"CODEX_HOME=" + home, "R=" + user, "S=" + other}, `exec 3>>"$R" 4>>"$S"`, nil},
		"relative CODEX_HOME":    {[]string{"CODEX_HOME=rel", "R=" + user}, `exec 3>>"$R"`, nil},
		"no rollout yet":         {[]string{"CODEX_HOME=" + home}, `:`, nil},
	} {
		t.Run(name, func(t *testing.T) {
			root, _ := startFakeCodex(t, c.env, c.script, c.args...)
			if s, ok := findClaudeSession("refusal-"+name, root); ok {
				t.Errorf("found %+v", s)
			}
		})
	}

	// A process that is not codex holding the rollout (tail -f, an editor).
	cmd := exec.Command("sh", "-c", `exec 3>>"$R"; sleep 30 & wait`)
	cmd.Env = append(os.Environ(), "CODEX_HOME="+home, "R="+user)
	cmd.Start()
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	waitFor(t, func() bool {
		return len(procWriteFiles(cmd.Process.Pid, func(string) bool { return true })) > 0
	})
	if s, ok := findClaudeSession("not-codex", cmd.Process.Pid); ok {
		t.Errorf("non-codex process accepted: %+v", s)
	}

	// A user thread and a sub-agent's thread: the user one.
	root, _ := startFakeCodex(t, []string{"CODEX_HOME=" + home, "R=" + user, "S=" + sub}, `exec 3>>"$R" 4>>"$S"`)
	if s, ok := findClaudeSession("with-subagent", root); !ok || s.ID != testCodexID {
		t.Errorf("with a sub-agent thread = %+v, %v", s, ok)
	}
}

func TestFindCodexSessionFollowsNew(t *testing.T) {
	home := t.TempDir()
	first := writeCodexRollout(t, home, testCodexID, "user")
	second := writeCodexRollout(t, home, testCodexSubID, "user")
	gate := filepath.Join(t.TempDir(), "go")
	// Like a restart into a new thread: the old rollout is closed, a new one
	// opened, in the same process.
	root, _ := startFakeCodex(t, []string{"CODEX_HOME=" + home, "R=" + first, "S=" + second, "G=" + gate},
		`exec 3>>"$R"; while [ ! -e "$G" ]; do sleep 0.02; done; exec 3>&- 4>>"$S"; : > "$G.done"`)
	key := "codex-new"
	if s, ok := findClaudeSession(key, root); !ok || s.ID != testCodexID {
		t.Fatalf("first = %+v, %v", s, ok)
	}
	os.WriteFile(gate, nil, 0o600)
	waitFor(t, func() bool { _, err := os.Stat(gate + ".done"); return err == nil })
	// The walk is still cached; the rollout is read again.
	if s, ok := findClaudeSession(key, root); !ok || s.ID != testCodexSubID {
		t.Errorf("after the switch = %+v, %v", s, ok)
	}
}

func TestClaudeOnlyPaneListsNoFiles(t *testing.T) {
	dir := t.TempDir()
	root, leaf := startFakeClaude(t, "CLAUDE_CONFIG_DIR="+dir)
	// Count only this pane's processes: lookups of other tests may still run.
	var calls atomic.Int32
	orig := procWriteFilesFn
	procWriteFilesFn = func(pid int, match func(string) bool) []procFile {
		if pid == root || pid == leaf {
			calls.Add(1)
		}
		return orig(pid, match)
	}
	t.Cleanup(func() { procWriteFilesFn = orig })

	start, _ := procStartTime(leaf)
	writeSessionFile(t, dir, leaf, start, claudePIDDomain(), "busy")
	if _, ok := findClaudeSession("claude-only", root); !ok && claudePIDDomain() != "" {
		t.Fatal("claude not found")
	}
	if n := calls.Load(); n != 0 {
		t.Errorf("listed open files %d times for a pane without codex", n)
	}

}

func TestCodexAndClaudeInOneTree(t *testing.T) {
	domain := claudePIDDomain()
	if domain == "" {
		t.Skip("no machine-id")
	}
	dir, home := t.TempDir(), t.TempDir()
	p := writeCodexRollout(t, home, testCodexID, "user")
	env := []string{"CODEX_HOME=" + home, "R=" + p, "CLAUDE_CONFIG_DIR=" + dir}
	claudeAt := func(pid int) {
		start, _ := procStartTime(pid)
		writeSessionFile(t, dir, pid, start, domain, "busy")
	}

	// sh → codex → sleep, with a Claude Code session file for the sleep:
	// codex is met first.
	root, codex := startFakeCodex(t, env, `exec 3>>"$R"`)
	children, _ := procChildrenFunc()
	claudeAt(children(codex)[0])
	if s, ok := findClaudeSession("codex-above-claude", root); !ok || s.Agent != "codex" {
		t.Errorf("codex above claude = %+v, %v", s, ok)
	}
	// The pane's shell itself is Claude Code: it is met first.
	root, _ = startFakeCodex(t, env, `exec 3>>"$R"`)
	claudeAt(root)
	if s, ok := findClaudeSession("claude-above-codex", root); !ok || s.Agent != "claude" || s.PID != root {
		t.Errorf("claude above codex = %+v, %v", s, ok)
	}
}

func TestFindCodexSessionByID(t *testing.T) {
	home := t.TempDir()
	p := writeCodexRollout(t, home, testCodexID, "user")
	_, codex := startFakeCodex(t, []string{"CODEX_HOME=" + home, "R=" + p}, `exec 3>>"$R"`)
	s, ok := findCodexSession(testCodexID)
	if !ok || s.Agent != "codex" || s.PID != codex || s.CodexHome != home || s.ID != testCodexID {
		t.Fatalf("by id = %+v, %v", s, ok)
	}
	for _, id := range []string{testCodexSubID, "not-a-uuid"} {
		if s, ok := findCodexSession(id); ok {
			t.Errorf("%s found: %+v", id, s)
		}
	}
	// The holder found is cached; once it exits the session is gone.
	syscallKill(codex)
	waitFor(t, func() bool { return !claudeProcAlive(s.PID, s.ProcStart) })
	if s, ok := findCodexSession(testCodexID); ok {
		t.Errorf("after exit = %+v", s)
	}
}

func TestProcLinuxCodexHelpers(t *testing.T) {
	// A process of another user (pid 1, unless it is ours, as in some
	// containers) cannot be read.
	if _, err := os.ReadFile("/proc/1/environ"); err != nil {
		if f := procWriteFiles(1, func(string) bool { return true }); f != nil {
			t.Errorf("pid 1 files = %v", f)
		}
		if _, ok := procCodexHome(1); ok {
			t.Error("pid 1 environment read")
		}
	}
	// The test process's own environment, with or without CODEX_HOME.
	env, _ := procNULFields(os.Getpid(), "environ")
	want, wantOK := codexHomeFromEnv(envGetter(env))
	if got, ok := procCodexHome(os.Getpid()); got != want || ok != wantOK {
		t.Errorf("own CODEX_HOME = %q, %v; want %q, %v", got, ok, want, wantOK)
	}
	// A CODEX_HOME without a sessions dir holds no rollout.
	if _, _, _, ok := codexRollout(os.Getpid(), t.TempDir(), ""); ok {
		t.Error("rollout found without a sessions dir")
	}
	if procFDFlags("pos:\t0\nflags:\t02102002\n") != 0o2102002 || procFDFlags("flags:\tzz\n") != 0 || procFDFlags("") != 0 {
		t.Error("procFDFlags")
	}
	if procExeBase(-1) != "" || procArgs(-1) != nil {
		t.Error("missing process")
	}
	fake := t.TempDir()
	os.MkdirAll(filepath.Join(fake, "7"), 0o700)
	os.Symlink("/opt/codex/bin/codex (deleted)", filepath.Join(fake, "7", "exe"))
	os.WriteFile(filepath.Join(fake, "7", "cmdline"), []byte("codex\x00--no-daemon\x00"), 0o600)
	os.MkdirAll(filepath.Join(fake, "notapid"), 0o700)
	orig := procRoot
	procRoot = fake
	t.Cleanup(func() { procRoot = orig })
	if b := procExeBase(7); b != "codex" {
		t.Errorf("replaced binary = %q", b)
	}
	if a := procArgs(7); len(a) != 2 || a[1] != "--no-daemon" {
		t.Errorf("args = %q", a)
	}
	if pids := procAllPIDs(); len(pids) != 1 || pids[0] != 7 {
		t.Errorf("pids = %v", pids)
	}
	if f := procWriteFiles(7, func(string) bool { return true }); f != nil {
		t.Errorf("no fd dir = %v", f)
	}
	// A codex whose command line cannot be read might be the daemon.
	os.MkdirAll(filepath.Join(fake, "8"), 0o700)
	os.Symlink("/opt/codex", filepath.Join(fake, "8", "exe"))
	if _, ok := codexProcOf(8); ok {
		t.Error("codex without a readable argv accepted")
	}
}

func TestLookupAgentsShowsCodexWithinBudget(t *testing.T) {
	home := t.TempDir()
	p := writeCodexRollout(t, home, testCodexID, "user")
	root, _ := startFakeCodex(t, []string{"CODEX_HOME=" + home, "R=" + p}, `exec 3>>"$R"`)
	panes := make([]agentPane, 10)
	for i := range panes {
		panes[i] = agentPane{paneID: fmt.Sprintf("%%%d", 900+i), panePID: fmt.Sprint(root)}
	}
	out := lookupAgents(t.Context(), panes)
	for i, a := range out {
		if a == nil || a.Name != "codex" {
			t.Errorf("pane %d = %+v", i, a)
		}
	}
}

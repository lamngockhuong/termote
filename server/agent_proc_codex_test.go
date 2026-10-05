package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func TestCodexHomeFromEnv(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix paths: Codex is only looked up on Linux and macOS")
	}
	for _, c := range []struct {
		env  []string
		want string
		ok   bool
	}{
		{[]string{"CODEX_HOME=/x/codex", "HOME=/home/u"}, "/x/codex", true},
		{[]string{"CODEX_HOME=", "HOME=/home/u"}, "/home/u/.codex", true},
		{[]string{"CODEX_HOME=rel"}, "rel", false},
		{[]string{"HOME=rel"}, "", false},
		{nil, "", false},
	} {
		got, ok := codexHomeFromEnv(envGetter(c.env))
		if got != c.want || ok != c.ok {
			t.Errorf("%v: %q, %v", c.env, got, ok)
		}
	}
}

func TestCodexUserThread(t *testing.T) {
	home := t.TempDir()
	write := func(content string) string { return writeRollout(t, home, testCodexID, content) }
	meta := `{"type":"session_meta","payload":{"id":"` + testCodexID + `","thread_source":"user"}}` + "\n"
	if !codexUserThread(write(meta), testCodexID, "") {
		t.Error("user thread refused")
	}
	for name, content := range map[string]string{
		"sub-agent":     strings.Replace(meta, `"user"`, `"subagent"`, 1),
		"other id":      strings.Replace(meta, testCodexID, testCodexSubID, 1),
		"not meta":      strings.Replace(meta, "session_meta", "event_msg", 1),
		"no newline":    strings.TrimSuffix(meta, "\n"),
		"broken":        "{\n",
		"line too long": `{"type":"session_meta","x":"` + strings.Repeat("a", codexMetaMax) + "\"}\n",
	} {
		if codexUserThread(write(content), testCodexID, "") {
			t.Errorf("%s accepted", name)
		}
	}
	if codexUserThread(filepath.Join(home, "missing"), testCodexID, "") {
		t.Error("missing file accepted")
	}
}

// procArgs2Buf builds a kern.procargs2 buffer.
func procArgs2Buf(exec string, args, env []string) []byte {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, uint32(len(args)))
	b = append(b, exec...)
	b = append(b, 0, 0, 0)
	for _, s := range append(append([]string{}, args...), env...) {
		b = append(append(b, s...), 0)
	}
	return append(b, 0, 0)
}

func TestParseProcArgs2(t *testing.T) {
	exec, args, env, ok := parseProcArgs2(procArgs2Buf("/opt/homebrew/bin/codex", []string{"codex", "--no-daemon"}, []string{"HOME=/Users/u", "CODEX_HOME=/c"}))
	if !ok || exec != "/opt/homebrew/bin/codex" || strings.Join(args, " ") != "codex --no-daemon" || strings.Join(env, " ") != "HOME=/Users/u CODEX_HOME=/c" {
		t.Errorf("parse = %q %q %q %v", exec, args, env, ok)
	}
	if get := envGetter(env); get("CODEX_HOME") != "/c" || get("NOPE") != "" {
		t.Error("envGetter")
	}
	if _, _, _, ok := parseProcArgs2([]byte{1, 0}); ok {
		t.Error("short buffer accepted")
	}
	// argc larger than the arguments present: no environment.
	if _, args, env, ok := parseProcArgs2(procArgs2Buf("/x", []string{"x"}, nil)[:0+4+3+2]); !ok || len(args) != 0 || len(env) != 0 {
		t.Errorf("truncated = %q %q", args, env)
	}
}

func TestParseLsofWriteFiles(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix paths: Codex is only looked up on Linux and macOS")
	}
	name := "rollout-2026-10-02T08-36-50-" + testCodexID + ".jsonl"
	out := strings.Join([]string{
		"p123\x00",
		"fcwd\x00ar\x00n/Users/u/proj\x00",
		"f3\x00aw\x00n/Users/u/.codex/sessions/" + name + "\x00",
		"f4\x00au\x00n/Users/u/.codex/sessions/b-" + name + "\x00",
		"f5\x00ar\x00n/Users/u/.codex/sessions/r-" + name + "\x00",
		"f6\x00aw\x00nrelative/" + name + "\x00",
		"f7\x00aw\x00n/Users/u/x\x01/" + name + "\x00",
		"f8\x00aw\x00n/Users/u/other.log\x00",
		"",
	}, "\n")
	files := parseLsofWriteFiles([]byte(out), func(n string) bool { return strings.HasSuffix(n, name) })
	if len(files) != 2 || files[0].path != "/Users/u/.codex/sessions/"+name || files[1].path != "/Users/u/.codex/sessions/b-"+name || files[0].id != "" {
		t.Errorf("files = %+v", files)
	}
}

func TestCommandsRouteCodexIsEmpty(t *testing.T) {
	root, cfg := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(root, ".claude/commands/proj.md"), "Project one")
	writeFile(t, filepath.Join(cfg, "commands/usr.md"), "User one")
	writeFile(t, filepath.Join(cfg, "skills/s/SKILL.md"), "---\nname: s\n---\n")
	s := AgentSession{Agent: "codex", ID: testCodexID, ClaudeDir: cfg, CodexHome: cfg}
	mux := commandsServer(t, s, true, root, true)
	code, cmds := getCommands(t, mux, httptest.NewRequest(http.MethodGet, "/api/mux/panes/1/agent/commands", nil))
	if code != http.StatusOK || cmds == nil || len(cmds) != 0 {
		t.Errorf("codex commands = %d %v", code, cmds)
	}
}

func TestHerdrCodexSession(t *testing.T) {
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	ctx := context.Background()
	set := func(agent string, refAgent string) {
		f.mu.Lock()
		f.agent = agent
		f.paneExtra = map[string]any{"agent_status": "working", "agent_session": map[string]any{
			"agent": refAgent, "kind": "id", "value": testCodexID, "source": "herdr:" + refAgent}}
		f.mu.Unlock()
	}
	var asked []string
	held := AgentSession{Agent: "codex", ID: testCodexID, CodexHome: "/h/.codex", Rollout: "/h/.codex/sessions/r", RolloutID: "1:2", PID: 9, ProcStart: "5", Status: "idle"}
	holder := true
	orig := herdrCodexSession
	herdrCodexSession = func(id string) (AgentSession, bool) {
		asked = append(asked, id)
		return held, holder
	}
	t.Cleanup(func() { herdrCodexSession = orig })

	set("codex", "codex")
	s, ok, err := m.AgentSession(ctx, "wR:p3")
	if err != nil || !ok || s.Agent != "codex" || s.ID != testCodexID || s.Rollout != held.Rollout || s.PID != 9 ||
		s.Status != "working" || s.Target != "wR:p3" || len(asked) != 1 || asked[0] != testCodexID {
		t.Fatalf("codex = %+v, %v, %v (asked %v)", s, ok, err, asked)
	}
	// No --no-daemon process holds the rollout (the daemon writes it, and
	// herdr's hook may have named another pane's session).
	holder = false
	if s, ok, err := m.AgentSession(ctx, "wR:p3"); ok || err != nil {
		t.Errorf("without a holder = %+v, %v, %v", s, ok, err)
	}
	holder = true
	for name, c := range map[string][2]string{
		"codex with a claude ref": {"codex", "claude"},
		"pi with a codex ref":     {"pi", "codex"},
	} {
		set(c[0], c[1])
		if _, ok, err := m.AgentSession(ctx, "wR:p3"); ok || err != nil {
			t.Errorf("%s: ok=%v err=%v", name, ok, err)
		}
	}
}

func TestCodexRolloutChecksTheOpenFile(t *testing.T) {
	home := t.TempDir()
	meta := `{"type":"session_meta","payload":{"id":"` + testCodexID + `","thread_source":"user"}}` + "\n"
	p := writeRollout(t, home, testCodexID, meta)
	id := fileIdentity(mustStat(t, p))
	orig := procWriteFilesFn
	t.Cleanup(func() { procWriteFilesFn = orig })
	for name, c := range map[string]struct {
		file procFile
		ok   bool
	}{
		"same file":          {procFile{path: p, id: id}, true},
		"identity unknown":   {procFile{path: p}, true},
		"path names another": {procFile{path: p, id: "0:0"}, false},
	} {
		procWriteFilesFn = func(int, func(string) bool) []procFile { return []procFile{c.file} }
		if _, _, _, ok := codexRollout(1, home, ""); ok != c.ok && (id != "" || c.file.id == "") {
			t.Errorf("%s: ok = %v", name, ok)
		}
	}
}

func TestCodexRolloutSameFileTwice(t *testing.T) {
	home := t.TempDir()
	meta := `{"type":"session_meta","payload":{"id":"` + testCodexID + `","thread_source":"user"}}` + "\n"
	p := writeRollout(t, home, testCodexID, meta)
	orig := procWriteFilesFn
	t.Cleanup(func() { procWriteFilesFn = orig })
	// One file on two fds (a dup) is one rollout.
	procWriteFilesFn = func(int, func(string) bool) []procFile { return []procFile{{path: p}, {path: p}} }
	if _, id, _, ok := codexRollout(1, home, ""); !ok || id != testCodexID {
		t.Errorf("same file twice = %q, %v", id, ok)
	}
	// session_meta is remembered per file.
	fid := fileIdentity(mustStat(t, p))
	if fid == "" {
		t.Skip("no file identity on this OS")
	}
	if !codexUserThreadCached(p, testCodexID, fid) {
		t.Fatal("user thread refused")
	}
	os.WriteFile(p, []byte("{}\n"), 0o600) // same inode, rewritten
	if !codexUserThreadCached(p, testCodexID, fid) {
		t.Error("cached answer not used")
	}
	codexMetas.Lock()
	for i := len(codexMetas.m); i < codexScansMax; i++ {
		codexMetas.m[strings.Repeat("k", i)] = true
	}
	codexMetas.Unlock()
	if codexUserThreadCached(p, testCodexID, fid+"x") {
		t.Error("rewritten file accepted under a new identity")
	}
	codexMetas.Lock()
	n := len(codexMetas.m)
	codexMetas.Unlock()
	if n != 1 {
		t.Errorf("cache holds %d entries after the cap", n)
	}
}

func TestCodexStatusNow(t *testing.T) {
	p := writeRollout(t, t.TempDir(), testCodexID, codexEvent(map[string]any{"type": "task_started"}))
	fid := fileIdentity(mustStat(t, p))
	if got := codexStatusNow(p+".gone", ""); got != "unknown" {
		t.Errorf("missing = %q", got)
	}
	if fid != "" {
		if got := codexStatusNow(p, "0:0"); got != "unknown" {
			t.Errorf("another file = %q", got)
		}
	}
	// The first scan runs in the background; once done, the status is read.
	codexStatusNow(p, fid)
	waitFor(t, func() bool { return codexStatusNow(p, fid) == "working" })
}

func TestFindCodexSessionUnsupportedOrBadID(t *testing.T) {
	if _, ok := findCodexSession("../x"); ok {
		t.Error("bad id accepted")
	}
	if !codexProcSupported {
		if _, ok := findCodexSession(testCodexID); ok {
			t.Error("found where codex is not supported")
		}
		if _, ok := codexProcOf(os.Getpid()); ok {
			t.Error("codexProcOf where not supported")
		}
	}
}

func TestCodexSessionOfLogsMissOnce(t *testing.T) {
	orig := procWriteFilesFn
	t.Cleanup(func() { procWriteFilesFn = orig; codexMissOnce = sync.Once{} })
	procWriteFilesFn = func(int, func(string) bool) []procFile { return nil }
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	codexMissOnce = sync.Once{}
	p := claudeProc{agent: "codex", pid: 1, codexHome: t.TempDir()}
	os.Mkdir(filepath.Join(p.codexHome, "sessions"), 0o700)
	// herdr's lookup by id is not a pane's Codex: not logged
	if _, ok := codexSessionOf(p, testCodexID, false); ok {
		t.Fatal("found a rollout that is not open")
	}
	if buf.Len() != 0 {
		t.Errorf("lookup by id logged %q", buf.String())
	}
	for range 2 {
		if _, ok := codexSessionOf(p, "", true); ok {
			t.Fatal("found a rollout that is not open")
		}
	}
	if n := strings.Count(buf.String(), "holds no single rollout"); n != 1 {
		t.Errorf("logged %d times: %q", n, buf.String())
	}
}

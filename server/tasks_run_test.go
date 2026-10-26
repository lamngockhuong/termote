package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// taskFakeMux is a pane at dir in group "g" whose task tabs are fakes: a
// tab's shell is busy from a typed line until finish, and its text is what
// the test sets.
type taskFakeMux struct {
	filesFakeMux
	mu         sync.Mutex
	shell      string
	tabs       int
	tabErr     error
	busy       map[string]bool
	gone       map[string]bool
	neverIdle  bool
	idleErr    error
	typed      []string // target + " " + line
	interrupts []string
	text       map[string]string
	typeErr    error
	readErr    error
	// interrupt runs in Interrupt when set; its error is Interrupt's.
	interrupt func() error
}

func newTaskFake(t *testing.T, dir string) *taskFakeMux {
	t.Helper()
	m := &taskFakeMux{filesFakeMux: filesFakeMux{dir: dir, files: true}, shell: "bash",
		busy: map[string]bool{}, gone: map[string]bool{}, text: map[string]string{}}
	m.snap = Snapshot{Groups: []Group{{ID: "g", Tabs: []Tab{{ID: "0", Panes: []Pane{{ID: "0"}}}}}}}
	return m
}

func (m *taskFakeMux) NewTaskTab(_ context.Context, groupID, name, dir string) (taskTab, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.tabErr != nil {
		return taskTab{}, m.tabErr
	}
	if groupID != "g" || dir != m.dir || name == "" {
		return taskTab{}, errors.New("unexpected tab request " + groupID + " " + name + " " + dir)
	}
	m.tabs++
	n := string(rune('0' + m.tabs))
	m.text["%"+n] = "$ "
	return taskTab{TabID: "t" + n, PaneID: "p" + n, Target: "%" + n}, nil
}

func (m *taskFakeMux) IdleShell(_ context.Context, target string) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.gone[target] {
		return "", false, errTaskTargetGone
	}
	if m.idleErr != nil {
		return "", false, m.idleErr
	}
	return m.shell, !m.busy[target] && !m.neverIdle, nil
}

func (m *taskFakeMux) Interrupt(_ context.Context, target string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.interrupts = append(m.interrupts, target)
	if m.interrupt != nil {
		return m.interrupt()
	}
	return nil
}

func (m *taskFakeMux) TypeLine(_ context.Context, target, line string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.typeErr != nil {
		return m.typeErr
	}
	m.typed = append(m.typed, target+" "+line)
	m.busy[target] = true
	return nil
}

func (m *taskFakeMux) ReadTaskText(_ context.Context, target string, _ int) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.text[target], m.readErr
}

// finish ends the run typed with nonce in target with code.
func (m *taskFakeMux) finish(target, nonce, code string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.busy[target] = false
	m.text[target] += "\n[termote-task " + nonce + " start]\nboom\n[termote-task " + nonce + " exit " + code + "]\n$ "
}

func (m *taskFakeMux) typedLines() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.typed...)
}

type taskFixture struct {
	root string
	m    *taskFakeMux
	h    http.Handler
}

// shortTasks shortens the waits of a run for tests.
func shortTasks(t *testing.T) {
	t.Helper()
	shortStart(t)
	wait := taskNewShellWait
	taskNewShellWait = 120 * time.Millisecond
	t.Cleanup(func() { taskNewShellWait = wait })
}

func newTaskFixture(t *testing.T) *taskFixture {
	t.Helper()
	shortTasks(t)
	root, _ := filepath.EvalSymlinks(t.TempDir())
	writeFile(t, filepath.Join(root, "package.json"), `{"packageManager":"pnpm@9","scripts":{"test":"vitest","fail":"exit 3"}}`)
	writeFile(t, filepath.Join(root, "Makefile"), "build:\n\tgo build\n")
	m := newTaskFake(t, root)
	return &taskFixture{root: root, m: m, h: tasksHandler(t, m)}
}

func (fx *taskFixture) run(t *testing.T, body map[string]any) (int, map[string]any) {
	t.Helper()
	if _, ok := body["root"]; !ok {
		body["root"] = fx.root
	}
	rec := serve(fx.h, apiRequest("POST", "/api/mux/panes/0/tasks/run", templateJSON(t, body)))
	return rec.Code, decodeBody(t, rec)
}

func (fx *taskFixture) state(t *testing.T, runID string) (int, map[string]any) {
	t.Helper()
	rec := serve(fx.h, apiRequest("GET", "/api/mux/tasks/runs/"+runID, ""))
	if !strings.Contains(rec.Header().Get("Cache-Control"), "no-store") {
		t.Errorf("Cache-Control = %q", rec.Header().Get("Cache-Control"))
	}
	return rec.Code, decodeBody(t, rec)
}

func TestTaskRunNewTabThenReuse(t *testing.T) {
	fx := newTaskFixture(t)
	code, body := fx.run(t, map[string]any{"kind": "script", "name": "fail"})
	if code != 200 || body["reused"] != false || body["tabId"] != "t1" || body["paneId"] != "p1" || len(body["runId"].(string)) != 16 {
		t.Fatalf("run = %d %v", code, body)
	}
	nonce, runID := body["nonce"].(string), body["runId"].(string)
	typed := fx.m.typedLines()
	if len(typed) != 1 || typed[0] != "%1 "+buildTaskLine(shellPOSIX, "pnpm run 'fail'", nonce) || len(fx.m.interrupts) != 0 {
		t.Fatalf("typed %q, interrupts %v", typed, fx.m.interrupts)
	}

	// Running: a second Run is refused, naming the run; the list shows it.
	code, body = fx.run(t, map[string]any{"kind": "script", "name": "fail"})
	if code != http.StatusConflict || body["code"] != "task_running" || body["runId"] != runID || body["tabId"] != "t1" {
		t.Fatalf("second run = %d %v", code, body)
	}
	if code, body = fx.state(t, runID); code != 200 || body["state"] != "running" || body["code"] != nil {
		t.Fatalf("state = %d %v", code, body)
	}
	_, list := listPaneTasks(t, fx.h, nil)
	if r := list["runs"].(map[string]any)["script:fail"].(map[string]any); r["runId"] != runID || r["nonce"] != nonce || r["state"] != "running" {
		t.Fatalf("list runs = %v", list["runs"])
	}

	fx.m.finish("%1", nonce, "3")
	// The state is checked at most every taskStateTTL: a fresh check (a
	// run) sees the exit at once.
	code, body = fx.run(t, map[string]any{"kind": "script", "name": "fail"})
	if code != 200 || body["reused"] != true || body["tabId"] != "t1" || fx.m.tabs != 1 {
		t.Fatalf("rerun = %d %v, %d tabs", code, body, fx.m.tabs)
	}
	if len(fx.m.interrupts) != 1 || fx.m.interrupts[0] != "%1" {
		t.Errorf("the reused line was not cleared: %v", fx.m.interrupts)
	}
	if code, body = fx.state(t, runID); body["state"] != "exited" || body["code"] != 3.0 {
		t.Fatalf("first run = %d %v", code, body)
	}
	// newTab while running opens another tab.
	code, body = fx.run(t, map[string]any{"kind": "script", "name": "fail", "newTab": true})
	if code != 200 || body["reused"] != false || body["tabId"] != "t2" {
		t.Fatalf("new tab = %d %v", code, body)
	}
}

func TestTaskRunPreviousTabBusyOrGone(t *testing.T) {
	fx := newTaskFixture(t)
	_, body := fx.run(t, map[string]any{"kind": "make", "name": "build"})
	fx.m.finish("%1", body["nonce"].(string), "0")
	if _, st := fx.state(t, body["runId"].(string)); st["state"] != "exited" || st["code"] != 0.0 {
		t.Fatalf("state = %v", st)
	}
	// The user runs something else in the tab: a new tab.
	fx.m.mu.Lock()
	fx.m.busy["%1"] = true
	fx.m.mu.Unlock()
	code, body := fx.run(t, map[string]any{"kind": "make", "name": "build"})
	if code != 200 || body["reused"] != false || body["tabId"] != "t2" {
		t.Fatalf("busy tab = %d %v", code, body)
	}
	typed := fx.m.typedLines()
	if !strings.Contains(typed[1], "make 'build'") {
		t.Errorf("typed %q", typed)
	}
	// The tab was closed: gone, and a new tab.
	fx.m.mu.Lock()
	fx.m.gone["%2"] = true
	fx.m.mu.Unlock()
	runID := body["runId"].(string)
	code, body = fx.run(t, map[string]any{"kind": "make", "name": "build"})
	if code != 200 || body["tabId"] != "t3" {
		t.Fatalf("gone tab = %d %v", code, body)
	}
	if _, st := fx.state(t, runID); st["state"] != "gone" {
		t.Errorf("gone run = %v", st)
	}
}

// Two devices pressing Run at once: one tab, one line, the other refused.
func TestTaskRunConcurrent(t *testing.T) {
	fx := newTaskFixture(t)
	var wg sync.WaitGroup
	codes := make(chan int, 4)
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, _ := fx.run(t, map[string]any{"kind": "script", "name": "test"})
			codes <- code
		}()
	}
	wg.Wait()
	close(codes)
	ok := 0
	for c := range codes {
		if c == 200 {
			ok++
		} else if c != http.StatusConflict {
			t.Errorf("code %d", c)
		}
	}
	if ok != 1 || fx.m.tabs != 1 || len(fx.m.typedLines()) != 1 {
		t.Fatalf("%d runs, %d tabs, %d lines", ok, fx.m.tabs, len(fx.m.typedLines()))
	}
}

// No text of the client reaches the shell: a name not in the root, or not
// a valid name, is refused before anything is typed or opened.
func TestTaskRunRefuses(t *testing.T) {
	fx := newTaskFixture(t)
	evil := []string{"x; rm -rf ~", "$(id)", "`id`", "#(id)", "#{pane_id}", "a\nb", "it's", `a\b`, "a’b", "build "}
	for _, name := range evil {
		for _, kind := range []string{"script", "make"} {
			if code, body := fx.run(t, map[string]any{"kind": kind, "name": name}); code != http.StatusNotFound || body["code"] != "task_not_found" {
				t.Errorf("%s %q = %d %v", kind, name, code, body)
			}
		}
	}
	for _, tc := range []struct {
		body map[string]any
		code string
		st   int
	}{
		{map[string]any{"kind": "script", "name": "build"}, "task_not_found", 404},
		{map[string]any{"kind": "make", "name": "test"}, "task_not_found", 404},
		{map[string]any{"kind": "user", "id": "0123456789abcdef"}, "task_not_found", 404},
		{map[string]any{"kind": "user", "id": "../tasks"}, "task_not_found", 404},
		{map[string]any{"kind": "shell", "name": "test", "command": "rm -rf ~"}, "invalid_task", 400},
	} {
		if code, body := fx.run(t, tc.body); code != tc.st || body["code"] != tc.code {
			t.Errorf("%v = %d %v", tc.body, code, body)
		}
	}
	code, body := fx.run(t, map[string]any{"kind": "script", "name": "test", "root": "/elsewhere"})
	if code != http.StatusConflict || body["root"] != fx.root {
		t.Errorf("other root = %d %v", code, body)
	}
	if len(fx.m.typedLines()) != 0 || fx.m.tabs != 0 {
		t.Fatalf("typed %q, %d tabs", fx.m.typedLines(), fx.m.tabs)
	}
}

func TestTaskRunUserTask(t *testing.T) {
	fx := newTaskFixture(t)
	rec := serve(fx.h, apiRequest("POST", "/api/mux/tasks", `{"name":"Unit","command":"go test ./... # all"}`))
	id := decodeBody(t, rec)["task"].(map[string]any)["id"].(string)
	code, body := fx.run(t, map[string]any{"kind": "user", "id": id})
	if code != 200 {
		t.Fatalf("run = %d %v", code, body)
	}
	if typed := fx.m.typedLines(); len(typed) != 1 || !strings.Contains(typed[0], "; eval 'go test ./... # all'; printf") {
		t.Fatalf("typed %q", typed)
	}
	_, list := listPaneTasks(t, fx.h, nil)
	if _, ok := list["runs"].(map[string]any)["user:"+id]; !ok {
		t.Errorf("runs = %v", list["runs"])
	}
}

func TestTaskRunShellAndBackendErrors(t *testing.T) {
	for _, tc := range []struct {
		name   string
		set    func(m *taskFakeMux)
		status int
		code   string
	}{
		{"unsupported shell", func(m *taskFakeMux) { m.shell = "nu" }, 409, "unsupported_shell"},
		{"powershell 5.1", func(m *taskFakeMux) { m.shell = "powershell.exe" }, 409, "unsupported_shell"},
		{"shell busy", func(m *taskFakeMux) { m.neverIdle = true }, 409, "shell_busy"},
		{"no client", func(m *taskFakeMux) { m.tabErr = errZellijNoClient }, 409, "no_client"},
		{"backend down", func(m *taskFakeMux) { m.tabErr = errors.New("tmux: /secret/sock gone") }, 500, ""},
		{"check fails", func(m *taskFakeMux) { m.idleErr = errors.New("rpc /secret") }, 500, ""},
		{"type fails", func(m *taskFakeMux) { m.typeErr = errors.New("send /secret") }, 500, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fx := newTaskFixture(t)
			tc.set(fx.m)
			rec := serve(fx.h, apiRequest("POST", "/api/mux/panes/0/tasks/run", templateJSON(t, map[string]any{"kind": "script", "name": "test", "root": fx.root})))
			if rec.Code != tc.status || strings.Contains(rec.Body.String(), "secret") {
				t.Fatalf("= %d %s", rec.Code, rec.Body)
			}
			if tc.code != "" && decodeBody(t, rec)["code"] != tc.code {
				t.Errorf("code = %s", rec.Body)
			}
			if tc.code != "no_client" && tc.status != 500 && len(fx.m.typedLines()) != 0 {
				t.Errorf("typed %q", fx.m.typedLines())
			}
		})
	}
}

func TestTaskRunUnknownPaneAndDir(t *testing.T) {
	fx := newTaskFixture(t)
	fx.m.snap = Snapshot{Groups: []Group{{ID: "g", Tabs: []Tab{{ID: "9", Panes: []Pane{{ID: "9"}}}}}}}
	if code, _ := fx.run(t, map[string]any{"kind": "script", "name": "test"}); code != http.StatusBadRequest {
		t.Errorf("unknown pane = %d", code)
	}
	fx.m.err = errors.New("snapshot failed")
	if code, _ := fx.run(t, map[string]any{"kind": "script", "name": "test"}); code != http.StatusInternalServerError {
		t.Errorf("snapshot error = %d", code)
	}
	if os.PathSeparator != '/' {
		return
	}
	// A root no backend may be handed.
	base, _ := filepath.EvalSymlinks(t.TempDir())
	bad := filepath.Join(base, "a\x1bb")
	if err := os.Mkdir(bad, 0o755); err != nil {
		t.Skip(err)
	}
	writeFile(t, filepath.Join(bad, "Makefile"), "x:\n")
	m := newTaskFake(t, bad)
	h := tasksHandler(t, m)
	rec := serve(h, apiRequest("POST", "/api/mux/panes/0/tasks/run", templateJSON(t, map[string]any{"kind": "make", "name": "x", "root": bad})))
	if rec.Code != http.StatusBadRequest || decodeBody(t, rec)["code"] != "invalid_root" {
		t.Errorf("bad root = %d %s", rec.Code, rec.Body)
	}
}

func TestTaskRunGuards(t *testing.T) {
	fx := newTaskFixture(t)
	path := "/api/mux/panes/0/tasks/run"
	good := templateJSON(t, map[string]any{"kind": "script", "name": "test", "root": fx.root})
	with := func(r *http.Request, header ...string) *http.Request {
		for i := 0; i < len(header); i += 2 {
			r.Header.Set(header[i], header[i+1])
		}
		return r
	}
	for _, tc := range []struct {
		name   string
		req    *http.Request
		status int
	}{
		{"GET", apiRequest("GET", path, ""), 405},
		{"view-only", viewRequest("POST", path, good), 403},
		{"cross-site", with(apiRequest("POST", path, good), "Sec-Fetch-Site", "cross-site", "Origin", "https://evil.test"), 403},
		{"not JSON", with(apiRequest("POST", path, good), "Content-Type", "text/plain"), 415},
		{"bad JSON", apiRequest("POST", path, "{"), 400},
		{"too large", apiRequest("POST", path, `{"name":"`+strings.Repeat("a", taskRunBody)+`"}`), 413},
		{"state view-only", viewRequest("GET", "/api/mux/tasks/runs/0123456789abcdef", ""), 403},
		{"state cross-site", with(apiRequest("GET", "/api/mux/tasks/runs/0123456789abcdef", ""), "Sec-Fetch-Site", "cross-site"), 403},
		{"state POST", apiRequest("POST", "/api/mux/tasks/runs/0123456789abcdef", "{}"), 405},
		{"state unknown", apiRequest("GET", "/api/mux/tasks/runs/0123456789abcdef", ""), 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if rec := serve(fx.h, tc.req); rec.Code != tc.status {
				t.Fatalf("= %d %s", rec.Code, rec.Body)
			}
		})
	}
	if len(fx.m.typedLines()) != 0 {
		t.Fatalf("typed %q", fx.m.typedLines())
	}
	// The handler refuses a view-only client itself too.
	cfg := testConfig(t)
	cfg.NoAuth, cfg.Pass = true, ""
	h, hub, _, err := buildServer(cfg, fx.m)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	assertViewOnly(t, "run in handler", serve(asRole(h, false), viewRequest("POST", path, good)))
	// A backend that cannot run tasks.
	plain := tasksHandler(t, &filesFakeMux{dir: fx.root, files: true})
	if rec := serve(plain, apiRequest("POST", path, good)); rec.Code != http.StatusNotImplemented {
		t.Errorf("no taskMux = %d", rec.Code)
	}
	if rec := serve(plain, apiRequest("GET", "/api/mux/tasks/runs/0123456789abcdef", "")); rec.Code != http.StatusNotFound {
		t.Errorf("no taskMux state = %d", rec.Code)
	}
}

// A state check without the end marker: running while the shell is busy,
// ended once it has been back at its prompt for taskEndedIdle after being
// seen busy (or after taskEndedAge), with the code unknown.
func TestTaskRunStateEnded(t *testing.T) {
	m := newTaskFake(t, t.TempDir())
	now := time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)
	ta := &tasksAPI{runs: newTaskRuns()}
	ta.runs.now = func() time.Time { return now }
	run := &taskRun{id: "r1", key: "k", target: "%1", nonce: "0123456789abcdef", started: now, state: taskStateRunning}
	ta.runs.add(run)
	ctx := context.Background()
	m.text["%1"] = "$ clear"

	// Idle and young, never seen busy: running.
	if got := ta.check(ctx, m, run, true); got.State != "running" {
		t.Fatalf("young = %v", got)
	}
	m.busy["%1"] = true
	now = now.Add(time.Second)
	if got := ta.check(ctx, m, run, true); got.State != "running" {
		t.Fatalf("busy = %v", got)
	}
	// Cached for taskStateTTL unless fresh.
	m.busy["%1"] = false
	now = now.Add(time.Second)
	if got := ta.check(ctx, m, run, false); got.State != "running" {
		t.Fatalf("cached = %v", got)
	}
	now = now.Add(taskStateTTL)
	if got := ta.check(ctx, m, run, false); got.State != "running" {
		t.Fatalf("just idle = %v", got)
	}
	now = now.Add(taskEndedIdle)
	if got := ta.check(ctx, m, run, false); got.State != "ended" || got.Code != nil {
		t.Fatalf("ended = %v", got)
	}
	// Final: never checked again.
	m.gone["%1"] = true
	if got := ta.check(ctx, m, run, true); got.State != "ended" {
		t.Fatalf("after end = %v", got)
	}

	// Old enough without being seen busy.
	run2 := &taskRun{id: "r2", key: "k2", target: "%2", nonce: "0123456789abcdef", started: now, state: taskStateRunning}
	ta.runs.add(run2)
	ta.check(ctx, m, run2, true)
	now = now.Add(taskEndedAge)
	if got := ta.check(ctx, m, run2, true); got.State != "ended" {
		t.Fatalf("old = %v", got)
	}
	// A failed read keeps it running.
	run3 := &taskRun{id: "r3", key: "k3", target: "%3", nonce: "0123456789abcdef", started: now, state: taskStateRunning}
	ta.runs.add(run3)
	errMux := &taskReadErrMux{m}
	if got := ta.check(ctx, errMux, run3, true); got.State != "running" {
		t.Fatalf("read error = %v", got)
	}
	m.idleErr = errors.New("rpc")
	if got := ta.check(ctx, m, run3, true); got.State != "running" {
		t.Fatalf("idle error = %v", got)
	}
}

type taskReadErrMux struct{ *taskFakeMux }

func (taskReadErrMux) ReadTaskText(context.Context, string, int) (string, error) {
	return "", errors.New("read failed")
}

func TestTaskRunsLimits(t *testing.T) {
	rs := newTaskRuns()
	now := time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)
	rs.now = func() time.Time { return now }
	rs.lockKey("old")()
	old := &taskRun{id: "old", key: "old", started: now.Add(-taskRunTTL - time.Second)}
	rs.add(old)
	unlock := rs.lockKey("held")
	held := &taskRun{id: "held", key: "held", started: now.Add(-taskRunTTL - time.Second)}
	rs.add(held)
	for i := range maxTaskRuns + 5 {
		now = now.Add(time.Millisecond)
		rs.add(&taskRun{id: string(rune(0x4e00 + i)), key: "k" + string(rune(0x4e00+i)), started: now})
	}
	if len(rs.runs) != maxTaskRuns || rs.get("old") != nil || rs.get("held") != nil || rs.get(string(rune(0x4e00))) != nil {
		t.Fatalf("%d runs kept", len(rs.runs))
	}
	if _, ok := rs.keys["old"]; ok {
		t.Error("an unheld key lock was kept")
	}
	if _, ok := rs.keys["held"]; !ok {
		t.Error("a held key lock was dropped")
	}
	unlock()
	// A run that is not its key's last leaves the key alone.
	rs.add(&taskRun{id: "a", key: "same", started: now})
	rs.add(&taskRun{id: "b", key: "same", started: now})
	rs.mu.Lock()
	rs.drop(rs.runs["a"])
	rs.mu.Unlock()
	if rs.last("same") == nil || rs.last("same").id != "b" {
		t.Error("dropping an older run forgot the key's last")
	}
}

func TestTaskPromptShown(t *testing.T) {
	for text, want := range map[string]bool{"": false, " \n\t\r\n": false, "$ ": true, "out\n> \n\n": true} {
		if got := taskPromptShown(text); got != want {
			t.Errorf("%q = %v", text, got)
		}
	}
}

// A reused tab whose clear fails, or whose shell does not come back after
// it, is not typed into.
func TestTaskRunReuseClearFails(t *testing.T) {
	for name, set := range map[string]func(m *taskFakeMux){
		"interrupt fails": func(m *taskFakeMux) { m.interrupt = func() error { return errors.New("send") } },
		"busy after clear": func(m *taskFakeMux) {
			m.interrupt = func() error { m.neverIdle = true; return nil }
		},
	} {
		t.Run(name, func(t *testing.T) {
			fx := newTaskFixture(t)
			_, body := fx.run(t, map[string]any{"kind": "script", "name": "test"})
			fx.m.finish("%1", body["nonce"].(string), "0")
			set(fx.m)
			if code, body := fx.run(t, map[string]any{"kind": "script", "name": "test"}); code == 200 {
				t.Fatalf("= %d %v", code, body)
			}
			if len(fx.m.typedLines()) != 1 {
				t.Fatalf("typed %q", fx.m.typedLines())
			}
		})
	}
}

// A new tab whose text cannot be read, a root that cannot be read, a
// backend whose panes have no directory: nothing typed.
func TestTaskRunReadFails(t *testing.T) {
	fx := newTaskFixture(t)
	fx.m.readErr = errors.New("read")
	if code, _ := fx.run(t, map[string]any{"kind": "script", "name": "test"}); code != 500 {
		t.Errorf("read error = %d", code)
	}
	fx.m.readErr = nil
	fx.m.files = false
	if code, _ := fx.run(t, map[string]any{"kind": "script", "name": "test"}); code != http.StatusNotImplemented {
		t.Errorf("no files = %d", code)
	}
	fx.m.files = true
	if os.Geteuid() != 0 && os.PathSeparator == '/' {
		os.Chmod(fx.root, 0)
		t.Cleanup(func() { os.Chmod(fx.root, 0o700) })
		if code, _ := fx.run(t, map[string]any{"kind": "script", "name": "test"}); code != http.StatusForbidden {
			t.Errorf("unreadable root = %d", code)
		}
	}
	if len(fx.m.typedLines()) != 0 {
		t.Fatalf("typed %q", fx.m.typedLines())
	}
}

func TestTaskSleep(t *testing.T) {
	if err := taskSleep(context.Background(), time.Millisecond); err != nil {
		t.Error(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := taskSleep(ctx, time.Hour); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled = %v", err)
	}
}

// A run cut short (its timeout) between steps types nothing more.
func TestTaskRunContextEnds(t *testing.T) {
	m := newTaskFake(t, t.TempDir())
	m.text["%1"] = "$ "
	ta := &tasksAPI{runs: newTaskRuns(), input: newAgentInput()}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := ta.typeTask(ctx, m, "%1", resolvedTask{Kind: taskKindMake, Name: "x"}, "0123456789abcdef", true); !errors.Is(err, context.Canceled) {
		t.Errorf("after clear = %v", err)
	}
	m.neverIdle = true
	if _, err := waitTaskShell(ctx, m, "%1", false); !errors.Is(err, context.Canceled) {
		t.Errorf("waiting = %v", err)
	}
	if len(m.typed) != 0 {
		t.Fatalf("typed %q", m.typed)
	}
}

// A tab opened for a run that could not be typed (an unsupported shell, a
// shell still loading) is the next run's: Run never piles up tabs.
func TestTaskRunKeepsAnUntypedTab(t *testing.T) {
	fx := newTaskFixture(t)
	fx.m.shell = "nu"
	for range 3 {
		if code, body := fx.run(t, map[string]any{"kind": "script", "name": "test"}); code != 409 || body["code"] != "unsupported_shell" {
			t.Fatalf("= %d %v", code, body)
		}
	}
	if fx.m.tabs != 1 || len(fx.m.interrupts) != 2 {
		t.Fatalf("%d tabs, %d interrupts", fx.m.tabs, len(fx.m.interrupts))
	}
	// Never shown to a client.
	if _, list := listPaneTasks(t, fx.h, nil); len(list["runs"].(map[string]any)) != 0 {
		t.Errorf("runs = %v", list["runs"])
	}
	fx.m.shell = "bash"
	code, body := fx.run(t, map[string]any{"kind": "script", "name": "test"})
	if code != 200 || body["reused"] != true || fx.m.tabs != 1 {
		t.Fatalf("after = %d %v", code, body)
	}
}

// The tab closed while the line was being typed: 409 tab_gone.
func TestTaskRunTabGone(t *testing.T) {
	fx := newTaskFixture(t)
	fx.m.typeErr = errTaskTargetGone
	if code, body := fx.run(t, map[string]any{"kind": "script", "name": "test"}); code != 409 || body["code"] != "tab_gone" {
		t.Fatalf("= %d %v", code, body)
	}
}

// A user task's command is checked again before it is typed: the file may
// have been edited by hand.
func TestTaskRunUserTaskCheckedAgain(t *testing.T) {
	shortTasks(t)
	root, _ := filepath.EvalSymlinks(t.TempDir())
	m := newTaskFake(t, root)
	cfg := testConfig(t)
	cfg.NoAuth, cfg.Pass = true, ""
	cfg.TasksDir = t.TempDir()
	os.WriteFile(filepath.Join(cfg.TasksDir, tasksFile), []byte(`{"v":1,"tasks":[{"id":"0123456789abcdef","name":"x","command":"echo \u001b]0;x\u0007","updated":"2026-10-26T00:00:00Z"}]}`), 0o600)
	h, hub, _, err := buildServer(cfg, m)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	rec := serve(h, apiRequest("POST", "/api/mux/panes/0/tasks/run", templateJSON(t, map[string]any{"kind": "user", "id": "0123456789abcdef", "root": root})))
	if rec.Code != 400 || decodeBody(t, rec)["code"] != "invalid_task" || len(m.typed) != 0 || m.tabs != 0 {
		t.Fatalf("= %d %s, typed %q", rec.Code, rec.Body, m.typed)
	}
}

// A request that waited on a key lock dropped meanwhile takes the map's
// lock instead, so it never runs beside a request that came after.
func TestTaskRunsLockKeyAfterDrop(t *testing.T) {
	rs := newTaskRuns()
	unlock := rs.lockKey("k")
	got := make(chan func(), 1)
	go func() { got <- rs.lockKey("k") }()
	time.Sleep(20 * time.Millisecond)
	rs.mu.Lock()
	delete(rs.keys, "k")
	rs.mu.Unlock()
	unlock()
	second := <-got
	rs.mu.Lock()
	m := rs.keys["k"]
	rs.mu.Unlock()
	if m == nil || m.TryLock() {
		t.Fatal("the lock taken is not the map's")
	}
	second()
}

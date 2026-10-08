package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestProcessName(t *testing.T) {
	long := strings.Repeat("a", 31) + "é" // 33 bytes: the cap may not split é
	for _, c := range []struct{ raw, want string }{
		{"bash", "bash"},
		{"/usr/bin/python3", "python3"},
		{"npm run dev", "npm"},
		{"deploy --token=x", "deploy"},
		{"sshd: user@pts/0", "sshd"},
		{"KEY=secret", "KEY"},
		{"vim\x1b[31m", "vim[31m"},
		{"v​im", "vim"},
		{"‮gnp.exe", "gnp.exe"},
		{"a⁦b⁩", "ab"},
		{"tab\tafter", "tab"},
		{"/usr/bin/", ""},
		{"", ""},
		{"  ", ""},
		{long, strings.Repeat("a", 31)},
		{strings.Repeat("b", 40), strings.Repeat("b", 32)},
		{"\xffbad", "bad"},
	} {
		if got := processName(c.raw); got != c.want {
			t.Errorf("processName(%q) = %q, want %q", c.raw, got, c.want)
		}
	}
}

// knownShells is the list the PWA reads too (shells.ts offers the Chat
// view's start on a pane whose process is one of them).
func TestKnownShellsMatchSharedList(t *testing.T) {
	data, err := os.ReadFile("testdata/known-shells.json")
	if err != nil {
		t.Fatal(err)
	}
	var shared struct{ Shells []string }
	if err := json.Unmarshal(data, &shared); err != nil {
		t.Fatal(err)
	}
	var names []string
	for name := range knownShells {
		names = append(names, name)
	}
	slices.Sort(names)
	slices.Sort(shared.Shells)
	if !slices.Equal(names, shared.Shells) {
		t.Errorf("knownShells = %v, testdata/known-shells.json = %v", names, shared.Shells)
	}
}

func TestProcessCwd(t *testing.T) {
	for _, c := range []struct{ raw, want string }{
		{"/home/user/a b:c", "/home/user/a b:c"},
		{"/home/‮user\n", "/home/user"},
		{"relative/dir", ""},
		{"", ""},
	} {
		if got := processCwd(c.raw); got != c.want {
			t.Errorf("processCwd(%q) = %q, want %q", c.raw, got, c.want)
		}
	}
	if got := processCwd("/" + strings.Repeat("x", 5000)); len(got) != maxProcessCwd {
		t.Errorf("cwd not capped: %d bytes", len(got))
	}
}

func TestHerdrProcessLeaderAndIdleShell(t *testing.T) {
	type proc = struct {
		PID  int    `json:"pid"`
		Name string `json:"name"`
	}
	info := func(shell, group int, ps ...proc) herdrProcessInfo {
		return herdrProcessInfo{ShellPID: shell, GroupID: group, Processes: ps}
	}
	if _, name, _ := info(1, 7, proc{8, "node"}, proc{7, "npm"}).leader(); name != "npm" {
		t.Errorf("leader = %q, want the group leader", name)
	}
	if _, name, _ := info(1, 9, proc{8, "node"}, proc{7, "npm"}).leader(); name != "node" {
		t.Errorf("leader without one = %q, want the first", name)
	}
	if _, _, ok := info(1, 1).leader(); ok {
		t.Error("leader of no process")
	}
	for _, c := range []struct {
		what string
		info herdrProcessInfo
		want bool
	}{
		{"idle bash", info(5, 5, proc{5, "bash"}), true},
		{"idle zsh, login name", info(5, 5, proc{5, "-zsh"}), false},
		{"idle pwsh on Windows", info(5, 5, proc{5, "pwsh.exe"}), true},
		{"vim from the shell", info(5, 9, proc{9, "vim"}), false},
		{"exec vim", info(5, 5, proc{5, "vim"}), false},
		{"two processes", info(5, 5, proc{5, "bash"}, proc{6, "bash"}), false},
		{"shell not leading", info(5, 6, proc{5, "bash"}), false},
		{"nothing", info(5, 5), false},
	} {
		if got := c.info.idleShell(); got != c.want {
			t.Errorf("%s: idleShell = %v, want %v", c.what, got, c.want)
		}
	}
}

// testProcCache is a cache with a clock the test moves.
func testProcCache() (*herdrProcCache, *time.Time) {
	c := newHerdrProcCache()
	now := time.Unix(1000, 0)
	c.now = func() time.Time { return now }
	return c, &now
}

func TestHerdrProcCacheFreshness(t *testing.T) {
	c, now := testProcCache()
	var calls atomic.Int32
	name := "vim"
	var fail error
	fetch := func(_ context.Context, p string) (string, error) {
		calls.Add(1)
		return name, fail
	}
	ctx := context.Background()
	got := c.names(ctx, []string{"a", "b"}, fetch)
	if got["a"] != "vim" || got["b"] != "vim" || calls.Load() != 2 {
		t.Fatalf("names = %v after %d calls", got, calls.Load())
	}
	c.names(ctx, []string{"a", "b"}, fetch)
	if calls.Load() != 2 {
		t.Errorf("fresh names fetched again: %d calls", calls.Load())
	}
	// Stale: fetched again; a failure keeps the previous name.
	*now = now.Add(herdrProcFresh)
	fail = errors.New("boom")
	if got := c.names(ctx, []string{"a"}, fetch); got["a"] != "vim" || calls.Load() != 3 {
		t.Errorf("after a failed refresh names = %v, %d calls", got, calls.Load())
	}
	// Reads that keep failing: the name goes once herdrProcKeep has passed
	// since the last good one, so a process that exited is not named.
	for now.Sub(time.Unix(1000, 0)) < herdrProcKeep {
		*now = now.Add(herdrProcFresh)
		c.names(ctx, []string{"a"}, fetch)
	}
	if got := c.names(ctx, []string{"a"}, fetch); len(got) != 0 {
		t.Errorf("names = %v after failing reads past %v", got, herdrProcKeep)
	}
	// "b" left the view: its entry goes.
	if _, ok := c.entries["b"]; ok {
		t.Error("entry of a pane no longer in the view kept")
	}
	// An empty name (no foreground process) means no process.
	*now = now.Add(herdrProcFresh)
	fail, name = nil, ""
	if got := c.names(ctx, []string{"a"}, fetch); len(got) != 0 {
		t.Errorf("names = %v, want none", got)
	}
}

func TestHerdrProcCacheStopsOnInvalidRequest(t *testing.T) {
	c, now := testProcCache()
	var calls atomic.Int32
	fetch := func(context.Context, string) (string, error) {
		calls.Add(1)
		return "", &herdrError{Code: "invalid_request", Message: "unknown variant"}
	}
	ctx := context.Background()
	panes := []string{"a"}
	c.names(ctx, panes, fetch)
	*now = now.Add(herdrProcFresh)
	// A name read before is not served while lookups are off either.
	c.entries["a"] = herdrProcEntry{name: "vim", fetched: *now, ok: *now}
	if got := c.names(ctx, panes, fetch); len(got) != 0 || calls.Load() != 1 {
		t.Errorf("names = %v, calls = %d; want none and no second call", got, calls.Load())
	}
	*now = now.Add(herdrProcRetry)
	c.names(ctx, panes, fetch)
	if calls.Load() != 2 {
		t.Errorf("not asked again after %v: %d calls", herdrProcRetry, calls.Load())
	}
}

// The request that started a refresh leaving does not cut its reads short:
// they serve every snapshot waiting on them.
func TestHerdrProcCacheOutlivesItsRequest(t *testing.T) {
	c := newHerdrProcCache()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	fetch := func(ctx context.Context, _ string) (string, error) { return "vim", ctx.Err() }
	if got := c.names(ctx, []string{"a"}, fetch); got["a"] != "vim" {
		t.Errorf("names = %v with the request gone", got)
	}
}

// Twenty slow panes: the refresh stops at its budget with what arrived.
func TestHerdrProcCacheBudget(t *testing.T) {
	c := newHerdrProcCache()
	var panes []string
	for i := range 20 {
		panes = append(panes, fmt.Sprintf("w1:p%d", i))
	}
	var inFlight, maxFlight atomic.Int32
	fetch := func(ctx context.Context, p string) (string, error) {
		n := inFlight.Add(1)
		defer inFlight.Add(-1)
		for m := maxFlight.Load(); n > m && !maxFlight.CompareAndSwap(m, n); m = maxFlight.Load() {
		}
		select {
		case <-time.After(400 * time.Millisecond):
			return "bash", nil
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	start := time.Now()
	got := c.names(context.Background(), panes, fetch)
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("names took %v", d)
	}
	if len(got) == 0 || len(got) == len(panes) {
		t.Errorf("%d of %d names, want some but not all within the budget", len(got), len(panes))
	}
	if maxFlight.Load() > herdrProcParallel {
		t.Errorf("%d calls at once, want at most %d", maxFlight.Load(), herdrProcParallel)
	}
}

func TestHerdrSnapshotProcesses(t *testing.T) {
	f := newFakeHerdr(t)
	f.procs = map[string]any{
		"wR:p3": fakeProcessInfo("wR:p3", 100, 300, fakeProc(300, "deploy", "deploy", "--token=sk-SECRET-123")),
		// The group leader is not listed first.
		"w13:p1": fakeProcessInfo("w13:p1", 100, 200, fakeProc(201, "node", "node", "server.js"), fakeProc(200, "npm", "npm", "run", "dev")),
		"w13:pC": fakeProcessInfo("w13:pC", 100, 0),
	}
	m := newTestHerdrMux(t, f)
	ctx, cancel := context.WithTimeout(context.Background(), muxTimeout)
	defer cancel()
	snap, err := m.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(snap)
	if strings.Contains(string(b), "SECRET") || strings.Contains(string(b), "server.js") {
		t.Fatalf("argv in the snapshot: %s", b)
	}
	procs := map[string]*ProcessInfo{}
	for _, g := range snap.Groups {
		for _, tab := range g.Tabs {
			if tab.Processes != nil {
				t.Errorf("tab %s has processes on Herdr", tab.ID)
			}
			for _, p := range tab.Panes {
				procs[p.ID] = p.Process
			}
		}
	}
	if p := procs["wR:p3"]; p == nil || p.Name != "deploy" || p.Cwd != "/home/user/project-a" {
		t.Errorf("wR:p3 process = %+v", p)
	}
	if p := procs["w13:p1"]; p == nil || p.Name != "npm" || p.Cwd != "/home/user/project-b" {
		t.Errorf("w13:p1 process = %+v", p)
	}
	if p := procs["w13:pC"]; p != nil {
		t.Errorf("pane without a foreground process = %+v", p)
	}
	if p := procs["wR:p22"]; p == nil || p.Name != "bash" {
		t.Errorf("idle pane process = %+v", p)
	}
	// The cached view is never written into.
	m.mu.Lock()
	for _, g := range m.cache.snap.Groups {
		for _, tab := range g.Tabs {
			for _, p := range tab.Panes {
				if p.Process != nil {
					t.Errorf("cached pane %s got a process", p.ID)
				}
			}
		}
	}
	m.mu.Unlock()

	// Fresh names are not read again.
	calls := f.count("pane.process_info")
	m.Snapshot(ctx)
	if n := f.count("pane.process_info"); n != calls {
		t.Errorf("fresh names read again: %d calls, then %d", calls, n)
	}
}

func TestHerdrSnapshotWithoutProcessInfo(t *testing.T) {
	f := newFakeHerdr(t)
	f.procFail = "invalid_request"
	m := newTestHerdrMux(t, f)
	ctx := context.Background()
	snap, err := m.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if p := snap.Groups[0].Tabs[0].Panes[0].Process; p != nil {
		t.Errorf("process = %+v from a Herdr without pane.process_info", p)
	}
	calls := f.count("pane.process_info")
	m.procs.mu.Lock()
	for p, e := range m.procs.entries {
		e.fetched = time.Time{}
		m.procs.entries[p] = e
	}
	m.procs.mu.Unlock()
	m.Snapshot(ctx)
	if n := f.count("pane.process_info"); n != calls {
		t.Errorf("asked again: %d calls, then %d", calls, n)
	}
}

// A pane slower than the budget leaves the others filled, inside muxTimeout.
func TestHerdrSnapshotSlowPane(t *testing.T) {
	f := newFakeHerdr(t)
	f.procDelay = map[string]time.Duration{"wR:p3": 3 * time.Second}
	m := newTestHerdrMux(t, f)
	ctx, cancel := context.WithTimeout(context.Background(), muxTimeout)
	defer cancel()
	start := time.Now()
	snap, err := m.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("snapshot took %v", d)
	}
	g := snap.Groups[0]
	if g.Tabs[0].Panes[0].Process != nil {
		t.Errorf("slow pane process = %+v", g.Tabs[0].Panes[0].Process)
	}
	if p := g.Tabs[1].Panes[0].Process; p == nil || p.Name != "bash" {
		t.Errorf("other pane process = %+v", p)
	}
}

// Concurrent snapshots share one round of calls, and read the view while
// others fill their copies (go test -race).
func TestHerdrSnapshotConcurrent(t *testing.T) {
	f := newFakeHerdr(t)
	f.procDelay = map[string]time.Duration{}
	panes := 0
	for _, p := range f.snapshot["panes"].([]any) {
		f.procDelay[p.(map[string]any)["pane_id"].(string)] = 100 * time.Millisecond
		panes++
	}
	m := newTestHerdrMux(t, f)
	ctx := context.Background()
	m.view(ctx)
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(2)
		go func() {
			defer wg.Done()
			if _, err := m.Snapshot(ctx); err != nil {
				t.Error(err)
			}
		}()
		go func() {
			defer wg.Done()
			v, _ := m.view(ctx)
			for _, g := range v.snap.Groups {
				for _, tab := range g.Tabs {
					for _, p := range tab.Panes {
						_ = p.Process
					}
				}
			}
		}()
	}
	wg.Wait()
	if n := f.count("pane.process_info"); n != panes {
		t.Errorf("%d pane.process_info calls, want one round of %d", n, panes)
	}
}

func TestHerdrPaneIdleShell(t *testing.T) {
	goos := herdrStartGOOS
	herdrStartGOOS = "linux"
	t.Cleanup(func() { herdrStartGOOS = goos })
	f := newFakeHerdr(t)
	f.procs = map[string]any{
		"wR:p3":  fakeProcessInfo("wR:p3", 100, 100, fakeProc(100, "vim", "vim")),
		"wR:p1V": fakeProcessInfo("wR:p1V", 100, 100, fakeProc(100, "bash", "-bash")),
	}
	m := newTestHerdrMux(t, f)
	ctx := context.Background()
	if idle, err := m.paneIdleShell(ctx, "wR:p3"); err != nil || idle {
		t.Errorf("exec vim: idle = %v, %v", idle, err)
	}
	if idle, err := m.paneIdleShell(ctx, "wR:p1V"); err != nil || !idle {
		t.Errorf("idle bash: idle = %v, %v", idle, err)
	}
	var ie inputError
	if _, err := m.paneIdleShell(ctx, "../x"); !errors.As(err, &ie) {
		t.Errorf("bad pane id: %v", err)
	}
	f.mu.Lock()
	f.procFail = "pane_not_found"
	f.mu.Unlock()
	if _, err := m.paneIdleShell(ctx, "wR:p9"); !errors.As(err, &ie) {
		t.Errorf("missing pane: %v", err)
	}
}

// Herdr on Windows names only the shell, or an agent it knows, as
// foreground: a shell running nvim reads exactly like an idle one (captured
// from Herdr 0.9.2-preview for #357). Its child process is what tells them
// apart there; elsewhere children are not read.
func TestHerdrPaneIdleShellWindows(t *testing.T) {
	f := newFakeHerdr(t)
	f.procs = map[string]any{
		"wN:p1": fakeProcessInfo("wN:p1", 6268, 6268, fakeProc(6268, "pwsh.exe", `C:\Program Files\PowerShell\7\pwsh.exe`)),
		"wJ:p2": fakeProcessInfo("wJ:p2", 22616, 23464, fakeProc(23464, "claude.exe", `C:\Users\u\.local\bin\claude.exe`)),
		"wC:p1": fakeProcessInfo("wC:p1", 4100, 4100, fakeProc(4100, "cmd.exe", `C:\Windows\System32\cmd.exe`)),
		"wP:p1": fakeProcessInfo("wP:p1", 4200, 4200, fakeProc(4200, "powershell.exe", "powershell.exe")),
	}
	m := newTestHerdrMux(t, f)
	goos, children := herdrStartGOOS, herdrProcChildren
	t.Cleanup(func() { herdrStartGOOS, herdrProcChildren = goos, children })
	var kids map[int][]int
	var snapErr error
	read := false
	herdrProcChildren = func() (func(int) []int, error) {
		read = true
		return func(pid int) []int { return kids[pid] }, snapErr
	}
	ctx := context.Background()
	for _, c := range []struct {
		what, goos, pane string
		kids             map[int][]int
		want             bool
	}{
		{"idle pwsh", "windows", "wN:p1", nil, true},
		{"idle cmd", "windows", "wC:p1", nil, true},
		{"idle powershell", "windows", "wP:p1", nil, true},
		{"pwsh running nvim", "windows", "wN:p1", map[int][]int{6268: {23240}}, false},
		{"cmd running ping", "windows", "wC:p1", map[int][]int{4100: {77}}, false},
		{"claude", "windows", "wJ:p2", nil, false},
		{"another process's child", "windows", "wN:p1", map[int][]int{999: {23240}}, true},
		{"a child on Linux", "linux", "wN:p1", map[int][]int{6268: {23240}}, true},
	} {
		herdrStartGOOS, kids, read = c.goos, c.kids, false
		if idle, err := m.paneIdleShell(ctx, c.pane); err != nil || idle != c.want {
			t.Errorf("%s: idle = %v, %v, want %v", c.what, idle, err, c.want)
		}
		if read && c.goos != "windows" {
			t.Errorf("%s: children read off Windows", c.what)
		}
	}
	herdrStartGOOS, kids, snapErr = "windows", nil, errors.New("snapshot failed")
	if idle, err := m.paneIdleShell(ctx, "wN:p1"); err == nil || idle {
		t.Errorf("snapshot failed: idle = %v, %v", idle, err)
	}
}

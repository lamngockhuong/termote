//go:build !windows

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// These tests run the hc backend against a real herdr-core: only with
// TERMOTE_TEST_HC=1 and hc on PATH (the e2e-hc CI job). Each test starts a
// core of its own on a socket in a fresh temporary directory, with its own
// HC_SESSION, HOME and XDG directories, and stops it when it ends: the
// developer's own core is never reached.

// hcRealCore is one isolated core.
type hcRealCore struct {
	t    *testing.T
	bin  string
	dir  string
	sock string
	env  []string
	pid  int
}

// hcRealTempRoots are the directories an isolated core's socket may sit
// under: the OS temporary directory, and /tmp.
func hcRealTempRoots() []string {
	var roots []string
	for _, d := range []string{os.TempDir(), "/tmp"} {
		if r, err := filepath.EvalSymlinks(d); err == nil {
			roots = append(roots, r)
		}
	}
	return roots
}

// checkHcRealSocket refuses a socket that does not sit inside dir, or a dir
// that does not sit inside one of the temporary roots: anything else could
// be a core someone uses.
func checkHcRealSocket(sock, dir string, roots []string) error {
	if !filepath.IsAbs(sock) || !filepath.IsAbs(dir) {
		return errors.New("hc test socket and dir must be absolute")
	}
	rel, err := filepath.Rel(dir, sock)
	if err != nil || !filepath.IsLocal(rel) {
		return fmt.Errorf("hc test socket %q is outside %q", sock, dir)
	}
	for _, root := range roots {
		if rel, err := filepath.Rel(root, dir); err == nil && filepath.IsLocal(rel) && rel != "." {
			return nil
		}
	}
	return fmt.Errorf("hc test dir %q is not inside a temporary directory", dir)
}

func TestHcRealSocketGuard(t *testing.T) {
	roots := []string{"/tmp"}
	for _, c := range []struct {
		sock, dir string
		ok        bool
	}{
		{"/tmp/hcq1/s.sock", "/tmp/hcq1", true},
		{"/run/user/1000/herdr-core/default.sock", "/tmp/hcq1", false},
		{"/tmp/hcq1/../hcq2/s.sock", "/tmp/hcq1", false},
		{"/tmp/s.sock", "/tmp", false},
		{"/home/u/s.sock", "/home/u", false},
		{"s.sock", "/tmp/hcq1", false},
	} {
		if err := checkHcRealSocket(c.sock, c.dir, roots); (err == nil) != c.ok {
			t.Errorf("checkHcRealSocket(%q, %q) = %v, want ok=%v", c.sock, c.dir, err, c.ok)
		}
	}
}

// newHcRealCore starts an isolated core, or skips the test.
func newHcRealCore(t *testing.T) *hcRealCore {
	t.Helper()
	if os.Getenv("TERMOTE_TEST_HC") != "1" {
		t.Skip("needs TERMOTE_TEST_HC=1 and hc on PATH (a core of its own per test)")
	}
	bin, err := exec.LookPath("hc")
	if err != nil {
		t.Fatalf("TERMOTE_TEST_HC=1 but hc is not on PATH: %v", err)
	}
	if bin, err = filepath.Abs(bin); err != nil {
		t.Fatal(err)
	}
	// A socket path must fit in sun_path (104 bytes on macOS): a long
	// TMPDIR gives way to /tmp.
	base := os.TempDir()
	if len(base) > 40 {
		base = "/tmp"
	}
	dir, err := os.MkdirTemp(base, "hcq")
	if err != nil {
		t.Fatal(err)
	}
	if dir, err = filepath.EvalSymlinks(dir); err != nil {
		t.Fatal(err)
	}
	c := &hcRealCore{t: t, bin: bin, dir: dir, sock: filepath.Join(dir, "s.sock")}
	if err := checkHcRealSocket(c.sock, dir, hcRealTempRoots()); err != nil {
		os.RemoveAll(dir)
		t.Fatal(err)
	}
	home := filepath.Join(dir, "home")
	for _, d := range []string{home, filepath.Join(dir, "st"), filepath.Join(dir, "cf"), filepath.Join(dir, "cache")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	shell := "/bin/sh"
	if _, err := os.Stat("/bin/bash"); err == nil {
		shell = "/bin/bash"
	}
	// Nothing of the developer's environment but PATH: no HC_* (a pane's
	// HC_TERMINAL_ID), no HOME with a shell profile.
	c.env = []string{
		"PATH=" + os.Getenv("PATH"), "HOME=" + home, "SHELL=" + shell, "TERM=xterm-256color", "LANG=C.UTF-8",
		"XDG_RUNTIME_DIR=" + dir, "XDG_STATE_HOME=" + filepath.Join(dir, "st"),
		"XDG_CONFIG_HOME=" + filepath.Join(dir, "cf"), "XDG_CACHE_HOME=" + filepath.Join(dir, "cache"),
		"HC_SESSION=termote-test", "HC_SOCKET=" + c.sock,
	}
	t.Cleanup(c.stop)
	c.server("start")
	return c
}

// server runs hc server start or restart and records the new core's pid
// (core.json holds none), which stop makes sure is gone.
func (c *hcRealCore) server(verb string) {
	c.t.Helper()
	var st struct {
		Pid int `json:"pid"`
	}
	if err := json.Unmarshal(c.hc("server", verb), &st); err != nil || st.Pid <= 0 {
		c.t.Fatalf("hc server %s: no pid (%v)", verb, err)
	}
	c.pid = st.Pid
}

// isHcCore reports whether pid still runs herdr-core's server: a pid the OS
// gave to another process since is never signalled.
func isHcCore(pid int) bool {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		// No /proc (macOS): the pid is the core's as long as it answers.
		return syscall.Kill(pid, 0) == nil
	}
	args := strings.Split(string(b), "\x00")
	return len(args) >= 2 && filepath.Base(args[0]) == "herdr-core" && args[1] == "serve"
}

// hc runs the hc CLI against this core and returns its stdout.
func (c *hcRealCore) hc(args ...string) []byte {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, c.bin, append(args, "--json")...)
	cmd.Env = c.env
	cmd.Dir = c.dir
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		c.t.Fatalf("hc %s: %v\n%s%s", strings.Join(args, " "), err, out, stderr.Bytes())
	}
	return out
}

// stop stops the core with the test's env, makes sure its process is gone
// and removes the directory.
func (c *hcRealCore) stop() {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, c.bin, "server", "stop", "--json")
	cmd.Env = c.env
	cmd.Dir = c.dir
	if out, err := cmd.CombinedOutput(); err != nil {
		c.t.Logf("hc server stop: %v: %s", err, out)
	}
	// Never hc server status here: it starts a core when none answers.
	if c.pid > 0 {
		deadline := time.Now().Add(5 * time.Second)
		for isHcCore(c.pid) && time.Now().Before(deadline) {
			time.Sleep(50 * time.Millisecond)
		}
		if isHcCore(c.pid) {
			c.t.Errorf("core %d still runs after hc server stop; killing it", c.pid)
			syscall.Kill(c.pid, syscall.SIGKILL)
		}
	}
	os.RemoveAll(c.dir)
}

// hcRealRPC is a plain JSON-RPC client of its own over `hc connect`, for
// what the test sets up (herdr-app's document, labels): it does not go
// through hcConn, so the backend's allowlist stays what it is.
type hcRealRPC struct {
	t      *testing.T
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	out    *bufio.Reader
	nextID int
}

func (c *hcRealCore) rpc() *hcRealRPC {
	c.t.Helper()
	cmd := exec.Command(c.bin, "connect")
	cmd.Env = c.env
	cmd.Dir = c.dir
	stdin, err := cmd.StdinPipe()
	if err != nil {
		c.t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		c.t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		c.t.Fatal(err)
	}
	r := &hcRealRPC{t: c.t, cmd: cmd, stdin: stdin, out: bufio.NewReaderSize(stdout, 1<<20)}
	c.t.Cleanup(r.close)
	r.call("hello", map[string]any{"generation": 1}, nil)
	return r
}

func (r *hcRealRPC) call(method string, params, out any) {
	r.t.Helper()
	r.nextID++
	req, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": r.nextID, "method": method, "params": params})
	if _, err := r.stdin.Write(append(req, '\n')); err != nil {
		r.t.Fatalf("%s: %v", method, err)
	}
	for {
		line, err := r.out.ReadBytes('\n')
		if err != nil {
			r.t.Fatalf("%s: %v", method, err)
		}
		var reply struct {
			ID     *int            `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(line, &reply) != nil || reply.ID == nil || *reply.ID != r.nextID {
			continue // a notification
		}
		if reply.Error != nil {
			r.t.Fatalf("%s: %s", method, reply.Error)
		}
		if out != nil {
			if err := json.Unmarshal(reply.Result, out); err != nil {
				r.t.Fatalf("%s: %v", method, err)
			}
		}
		return
	}
}

func (r *hcRealRPC) close() {
	r.stdin.Close()
	done := make(chan struct{})
	go func() { r.cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		r.cmd.Process.Kill()
		<-done
	}
}

// mux is the backend under test on this core, ended with the test.
func (c *hcRealCore) mux() *hcMux {
	ctx, cancel := context.WithCancel(context.Background())
	m := newHcMux(ctx, c.bin, c.env)
	// TestMain keeps every other test away from a real hc.
	m.client.connect = startHcConnect
	m.client.running = hcCoreRunningDefault
	c.t.Cleanup(func() {
		cancel()
		m.client.close()
	})
	return m
}

// waitHc polls cond until it holds or 15 s pass.
func waitHc(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func hcRealSnapshot(t *testing.T, m *hcMux) Snapshot {
	t.Helper()
	var snap Snapshot
	var err error
	deadline := time.Now().Add(15 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		snap, err = m.Snapshot(ctx)
		cancel()
		if err == nil {
			return snap
		}
		if time.Now().After(deadline) {
			t.Fatalf("no snapshot: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func hcRealGroup(s Snapshot, id string) (Group, bool) {
	for _, g := range s.Groups {
		if g.ID == id {
			return g, true
		}
	}
	return Group{}, false
}

// hcStreamOut collects what a stream prints.
type hcStreamOut struct {
	mu   sync.Mutex
	buf  bytes.Buffer
	size Size // the last size frame
}

// readHcStream reads s as the stream handler does: each size frame is
// acknowledged (the stream waits for it before printing at that size).
func readHcStream(s TermStream) *hcStreamOut {
	o := &hcStreamOut{}
	if r, ok := s.(sizeReporter); ok {
		go func() {
			for {
				select {
				case c := <-r.Sizes():
					if !c.Layout {
						o.mu.Lock()
						o.size = c.Size
						o.mu.Unlock()
					}
					close(c.sent)
				case <-s.Done():
					return
				}
			}
		}()
	}
	go func() {
		b := make([]byte, 32*1024)
		for {
			n, err := s.Read(b)
			o.mu.Lock()
			o.buf.Write(b[:n])
			o.mu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	return o
}

func (o *hcStreamOut) has(s string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return bytes.Contains(o.buf.Bytes(), []byte(s))
}

func (o *hcStreamOut) lastSize() Size {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.size
}

func (o *hcStreamOut) len() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.buf.Len()
}

// newHcRealGroup makes a space with one shell through the backend and
// returns it once the snapshot shows it.
func newHcRealGroup(t *testing.T, c *hcRealCore, m *hcMux) Group {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	hcRealSnapshot(t, m)
	id, err := m.NewGroup(ctx, "", c.dir)
	if err != nil {
		t.Fatalf("NewGroup: %v", err)
	}
	var g Group
	waitHc(t, "the new space", func() bool {
		var ok bool
		g, ok = hcRealGroup(hcRealSnapshot(t, m), id)
		return ok && len(g.Tabs) == 1 && len(g.Tabs[0].Panes) == 1
	})
	return g
}

// The backend talks to a real core: hello, a space made with labels, a tab
// and a split shown in the snapshot, a pane closed, the space closed.
func TestHcRealTabsSplitAndClose(t *testing.T) {
	c := newHcRealCore(t)
	m := c.mux()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := m.Health(ctx); err != nil {
		t.Fatalf("Health: %v", err)
	}
	g := newHcRealGroup(t, c, m)
	first := g.Tabs[0].Panes[0]
	if !validHcAddress(first.ID) {
		t.Fatalf("pane id %q", first.ID)
	}
	var term struct {
		Labels map[string]string `json:"labels"`
	}
	json.Unmarshal(c.hc("get", first.ID), &term)
	if term.Labels[hcLabelSpace] != g.ID || term.Labels[hcLabelTab] == "" || term.Labels[hcLabelSeen] != "0" {
		t.Fatalf("labels of the new terminal %v", term.Labels)
	}

	tab, err := m.NewTab(ctx, g.ID, "ignored")
	if err != nil {
		t.Fatalf("NewTab: %v", err)
	}
	split, err := m.SplitPane(ctx, first.ID, SplitRight, "")
	if err != nil {
		t.Fatalf("SplitPane: %v", err)
	}
	waitHc(t, "the tab and the split", func() bool {
		g, _ = hcRealGroup(hcRealSnapshot(t, m), g.ID)
		return len(g.Tabs) == 2 && len(g.Tabs[0].Panes) == 2 && g.Tabs[0].Panes[1].ID == split &&
			g.Tabs[1].ID == tab && len(g.Tabs[1].Panes) == 1
	})
	for _, tb := range g.Tabs {
		for _, p := range tb.Panes {
			if p.Process != nil && strings.Contains(p.Process.Name, "/") {
				t.Errorf("pane %s shows a path in its process name %q", p.ID, p.Process.Name)
			}
		}
	}

	if err := m.ClosePane(ctx, split); err != nil {
		t.Fatalf("ClosePane: %v", err)
	}
	waitHc(t, "the split to close", func() bool {
		g, _ = hcRealGroup(hcRealSnapshot(t, m), g.ID)
		return len(g.Tabs) == 2 && len(g.Tabs[0].Panes) == 1
	})
	if err := m.CloseGroup(ctx, g.ID); err != nil {
		t.Fatalf("CloseGroup: %v", err)
	}
	waitHc(t, "the space to close", func() bool {
		_, ok := hcRealGroup(hcRealSnapshot(t, m), g.ID)
		return !ok
	})
}

// A full client's stream: the first paint arrives, typed keys show on the
// screen without resizing the terminal, ReadText reads them back, an OSC
// 7501 report shows as the agent, and killing the terminal ends the stream.
func TestHcRealAttachTypesWithoutResizing(t *testing.T) {
	c := newHcRealCore(t)
	m := c.mux()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	g := newHcRealGroup(t, c, m)
	pane := g.Tabs[0].Panes[0].ID
	before, _ := m.state.terminal(pane)

	s, err := m.Attach(ctx, pane, Size{Cols: before.Cols + 37, Rows: before.Rows + 11})
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	defer s.Close()
	out := readHcStream(s)
	waitHc(t, "the first paint", func() bool { return out.len() > 0 })

	if _, err := s.Write([]byte("echo hc-$((40+2))\r")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	waitHc(t, "the typed command's output", func() bool { return out.has("hc-42") })
	if err := m.SendKeys(ctx, pane, "echo keys-$((50+5))\r"); err != nil {
		t.Fatalf("SendKeys: %v", err)
	}
	waitHc(t, "SendKeys' output", func() bool { return out.has("keys-55") })

	after, _ := m.state.terminal(pane)
	var got struct {
		Cols int `json:"cols"`
		Rows int `json:"rows"`
	}
	json.Unmarshal(c.hc("get", pane), &got)
	if got.Cols != before.Cols || got.Rows != before.Rows || after.Cols != before.Cols || after.Rows != before.Rows {
		t.Fatalf("typing resized the terminal: %dx%d (state %dx%d), was %dx%d",
			got.Cols, got.Rows, after.Cols, after.Rows, before.Cols, before.Rows)
	}
	var text bytes.Buffer
	if _, err := m.ReadText(ctx, pane, 50, &text); err != nil || !strings.Contains(text.String(), "hc-42") {
		t.Fatalf("ReadText = %q, %v", text.String(), err)
	}

	if _, err := s.Write([]byte(`printf '\033]7501;state=working:app=claude-code\033\\'` + "\r")); err != nil {
		t.Fatal(err)
	}
	waitHc(t, "the agent's state", func() bool {
		g, _ := hcRealGroup(hcRealSnapshot(t, m), g.ID)
		a := g.Tabs[0].Panes[0].Agent
		return a != nil && a.Name == "claude" && a.Status == "working"
	})

	// The tab's last pane goes with its tab: the terminal is killed.
	if err := m.CloseTab(ctx, g.Tabs[0].ID, g.Tabs[0].Key); err != nil {
		t.Fatalf("CloseTab: %v", err)
	}
	select {
	case <-s.Done():
	case <-time.After(15 * time.Second):
		t.Fatal("the stream did not end after the terminal was killed")
	}
}

// A view-only stream observes at the terminal's size and gets its output;
// when a full client drives the size, the view follows it (hc 0.1.16 sends
// observers no RESIZE: the size event carries it).
func TestHcRealViewOnlyStream(t *testing.T) {
	c := newHcRealCore(t)
	m := c.mux()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	g := newHcRealGroup(t, c, m)
	pane := g.Tabs[0].Panes[0].ID
	v, err := m.AttachView(ctx, pane, Size{Cols: 50, Rows: 10})
	if err != nil {
		t.Fatalf("AttachView: %v", err)
	}
	defer v.Close()
	out := readHcStream(v)
	waitHc(t, "the view's first paint", func() bool { return out.len() > 0 })
	if err := m.SendKeys(ctx, pane, "echo viewed-$((60+6))\r"); err != nil {
		t.Fatal(err)
	}
	waitHc(t, "output in the view", func() bool { return out.has("viewed-66") })
	t0, _ := m.state.terminal(pane)
	if got := out.lastSize(); got != hcSize(t0) {
		t.Fatalf("view size %+v, terminal %dx%d", got, t0.Cols, t0.Rows)
	}

	full, err := m.Attach(ctx, pane, Size{Cols: t0.Cols + 13, Rows: t0.Rows + 7})
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	defer full.Close()
	fullOut := readHcStream(full)
	waitHc(t, "the full stream's first paint", func() bool { return fullOut.len() > 0 })
	full.(*hcStream).Drive(true)
	want := Size{Cols: t0.Cols + 13, Rows: t0.Rows + 7}
	waitHc(t, "the view to follow the driven size", func() bool { return out.lastSize() == want })
	full.(*hcStream).Drive(false)
	waitHc(t, "the size given back", func() bool { return out.lastSize() == hcSize(t0) })
}

// The core restarting: the stream attaches again by itself and keeps
// typing, and the snapshot follows the new core.
func TestHcRealCoreRestartResumes(t *testing.T) {
	c := newHcRealCore(t)
	m := c.mux()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	g := newHcRealGroup(t, c, m)
	pane := g.Tabs[0].Panes[0].ID
	s, err := m.Attach(ctx, pane, Size{Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	defer s.Close()
	out := readHcStream(s)
	waitHc(t, "the first paint", func() bool { return out.len() > 0 })

	c.server("restart")
	deadline := time.Now().Add(30 * time.Second)
	for i := 0; !out.has("again-77"); i++ {
		if time.Now().After(deadline) {
			t.Fatal("the stream did not resume after the core restarted")
		}
		select {
		case <-s.Done():
			t.Fatal("the stream ended when the core restarted")
		default:
		}
		// Keys typed while no attach is in use wait for the next one; the
		// kept terminal's new shell may not take the first ones.
		if i%20 == 0 {
			s.Write([]byte("echo again-$((70+7))\r"))
		}
		time.Sleep(100 * time.Millisecond)
	}
	waitHc(t, "the snapshot after the restart", func() bool {
		_, ok := hcRealGroup(hcRealSnapshot(t, m), g.ID)
		return ok
	})
}

// Events past the 256 KiB credit window keep coming: the events channel is
// credited as it is read.
func TestHcRealEventsPastWindow(t *testing.T) {
	c := newHcRealCore(t)
	m := c.mux()
	g := newHcRealGroup(t, c, m)
	pane := g.Tabs[0].Panes[0].ID
	r := c.rpc()
	big := strings.Repeat("x", 4000)
	for i := range 100 { // ~400 KiB of label events
		r.call("terminal.label", map[string]any{
			"terminal": pane, "labels": map[string]string{"termote.test": fmt.Sprintf("%d-%s", i, big)},
		}, nil)
	}
	waitHc(t, "the last label event", func() bool {
		t, _ := m.state.terminal(pane)
		return strings.HasPrefix(t.Labels["termote.test"], "99-")
	})
	g2 := newHcRealGroup(t, c, m)
	if g2.ID == g.ID {
		t.Fatal("same space twice")
	}
}

// herdr-app's document, written by a client of the test's own: the
// snapshot takes the space name, the tabs and the panes' order from it.
func TestHcRealDocumentLayout(t *testing.T) {
	c := newHcRealCore(t)
	m := c.mux()
	r := c.rpc()
	space, tab := "sp0123456789abcdef0123456789abcdef", "tb0123456789abcdef0123456789abcdef"
	var a, b struct {
		Address string `json:"address"`
	}
	labels := map[string]string{hcLabelSpace: space, hcLabelTab: tab}
	r.call("terminal.run", map[string]any{"keep": true, "labels": labels, "cwd": c.dir}, &a)
	r.call("terminal.run", map[string]any{"keep": true, "labels": labels, "cwd": c.dir}, &b)
	// The document puts b before a.
	doc := map[string]any{"spaces": []any{map[string]any{
		"id": space, "name": "doc-space", "folder": c.dir,
		"tabs": []any{map[string]any{"id": tab, "name": "doc-tab", "root": map[string]any{
			"id": tab, "type": "row", "children": []any{
				map[string]any{"id": "p1", "type": "block", "content": map[string]any{"terminal": b.Address}, "size": map[string]any{"weight": 0.5}},
				map[string]any{"id": "p2", "type": "block", "content": map[string]any{"terminal": a.Address}, "size": map[string]any{"weight": 0.5}},
			},
		}}},
	}}}
	var cur struct {
		Version uint64 `json:"version"`
	}
	r.call("doc.get", map[string]any{"name": hcAppDoc}, &cur)
	r.call("doc.set", map[string]any{"name": hcAppDoc, "version": cur.Version, "value": doc}, nil)

	waitHc(t, "the document's layout", func() bool {
		g, ok := hcRealGroup(hcRealSnapshot(t, m), space)
		return ok && g.Name == "doc-space" && len(g.Tabs) == 1 && g.Tabs[0].Name == "doc-tab" &&
			len(g.Tabs[0].Panes) == 2 && g.Tabs[0].Panes[0].ID == b.Address && g.Tabs[0].Panes[1].ID == a.Address &&
			g.Tabs[0].Layout != nil
	})
}

// termote writes names and order into herdr-app's document on a real core:
// the version it read is accepted, the fields it does not know stay.
func TestHcRealDocumentWrite(t *testing.T) {
	c := newHcRealCore(t)
	m := c.mux()
	r := c.rpc()
	s1, s2 := "sp0123456789abcdef0123456789abcd01", "sp0123456789abcdef0123456789abcd02"
	t1, t2 := "tb0123456789abcdef0123456789abcd01", "tb0123456789abcdef0123456789abcd02"
	addr := map[string]string{}
	for _, l := range [][2]string{{s1, t1}, {s1, t2}, {s2, "tb0123456789abcdef0123456789abcd03"}} {
		var a struct {
			Address string `json:"address"`
		}
		r.call("terminal.run", map[string]any{"keep": true, "labels": map[string]string{hcLabelSpace: l[0], hcLabelTab: l[1]}, "cwd": c.dir}, &a)
		addr[l[1]] = a.Address
	}
	block := func(tab string) map[string]any {
		return map[string]any{"id": tab, "name": "", "root": map[string]any{"id": "b" + tab, "type": "block",
			"content": map[string]any{"terminal": addr[tab]}, "size": map[string]any{"weight": 1.5}}}
	}
	doc := map[string]any{"spaces": []any{
		map[string]any{"id": s1, "name": "", "folder": c.dir, "look": map[string]any{"theme": "dusk"},
			"tabs": []any{block(t1), block(t2)}},
		map[string]any{"id": s2, "name": "", "folder": c.dir, "tabs": []any{block("tb0123456789abcdef0123456789abcd03")}},
	}}
	var cur struct {
		Version uint64 `json:"version"`
	}
	r.call("doc.get", map[string]any{"name": hcAppDoc}, &cur)
	r.call("doc.set", map[string]any{"name": hcAppDoc, "version": cur.Version, "value": doc}, nil)
	waitHc(t, "the document", func() bool {
		_, ok := hcRealGroup(hcRealSnapshot(t, m), s2)
		return ok && m.Caps().RenameTab
	})

	ctx := ctx5s(t)
	if err := m.RenameTab(ctx, t1, "first", t1); err != nil {
		t.Fatal(err)
	}
	if err := m.RenameGroup(ctx, s1, "one"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.MoveTab(ctx, t2, 0); err != nil {
		t.Fatal(err)
	}
	if err := m.MoveGroup(ctx, s2, 0); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Value json.RawMessage `json:"value"`
	}
	r.call("doc.get", map[string]any{"name": hcAppDoc}, &got)
	raw := string(got.Value)
	for _, want := range []string{`"look":{"theme":"dusk"}`, `"size":{"weight":1.5}`, `"name":"first"`, `"name":"one"`} {
		if !strings.Contains(raw, want) {
			t.Errorf("document lacks %s: %s", want, raw)
		}
	}
	snap := hcRealSnapshot(t, m)
	if len(snap.Groups) < 2 || snap.Groups[0].ID != s2 {
		t.Fatalf("groups %+v", snap.Groups)
	}
	g, _ := hcRealGroup(snap, s1)
	if g.Name != "one" || len(g.Tabs) != 2 || g.Tabs[0].ID != t2 || g.Tabs[1].Name != "first" {
		t.Errorf("group %+v", g)
	}
}

// Typing opens an attach of its own that termote only writes to: a burst of
// output past its credit window must not hold the terminal's output back
// from the other viewers while that attach stays open.
func TestHcRealTypingDoesNotStallViewers(t *testing.T) {
	c := newHcRealCore(t)
	m := c.mux()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	g := newHcRealGroup(t, c, m)
	pane := g.Tabs[0].Panes[0].ID
	v, err := m.AttachView(ctx, pane, Size{Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("AttachView: %v", err)
	}
	defer v.Close()
	out := readHcStream(v)
	waitHc(t, "the view's first paint", func() bool { return out.len() > 0 })
	// A full viewer too, as herdr-app is: the core may treat it apart from an
	// observer.
	t0, _ := m.state.terminal(pane)
	full, err := m.Attach(ctx, pane, hcSize(t0))
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	defer full.Close()
	fullOut := readHcStream(full)
	waitHc(t, "the full stream's first paint", func() bool { return fullOut.len() > 0 })
	// 1 MiB of output (4 x hcWindow), then a marker the view has to see. The
	// input attach SendKeys opened stays open through it (hcInputIdle).
	if err := m.SendKeys(ctx, pane, "head -c 1048576 /dev/zero | tr '\\0' x; echo; echo burst-$((70+7))\r"); err != nil {
		t.Fatal(err)
	}
	waitHc(t, "the marker after the burst in the view", func() bool { return out.has("burst-77") })
	waitHc(t, "the marker after the burst in the full stream", func() bool { return fullOut.has("burst-77") })
}

func TestHcRealWorktreeRoundTrip(t *testing.T) {
	c := newHcRealCore(t)
	m := c.mux()
	hcRealSnapshot(t, m)
	worktreeRoundTrip(t, m, worktreeRepo(t), false, func(what string, cond func() bool) {
		t.Helper()
		waitHc(t, what, cond)
	})
}

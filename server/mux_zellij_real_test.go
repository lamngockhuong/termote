package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// These tests drive a real Zellij (0.45 or later) in an environment of their
// own: HOME, XDG dirs, TMPDIR and a short ZELLIJ_SOCKET_DIR (a long one makes
// Zellij refuse every session name). They never touch the user's sessions.

func realZellij(t *testing.T) *zellijMux {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("no Zellij backend on Windows")
	}
	if _, err := exec.LookPath("zellij"); err != nil {
		t.Skip("needs zellij")
	}
	home := t.TempDir()
	b := make([]byte, 4)
	rand.Read(b)
	sock := "/tmp/zt" + hex.EncodeToString(b)
	if err := os.Mkdir(sock, 0o700); err != nil {
		t.Fatal(err)
	}
	for k, v := range map[string]string{
		"HOME": home, "XDG_CONFIG_HOME": filepath.Join(home, ".config"), "XDG_DATA_HOME": filepath.Join(home, ".local", "share"),
		"XDG_CACHE_HOME": filepath.Join(home, ".cache"), "XDG_RUNTIME_DIR": home, "TMPDIR": home, "ZELLIJ_SOCKET_DIR": sock,
	} {
		t.Setenv(k, v)
	}
	for _, k := range []string{"ZELLIJ", "ZELLIJ_SESSION_NAME", "ZELLIJ_PANE_ID"} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	if os.Getenv("ZELLIJ_TEST_WITH_CONFIG") != "" {
		cfg, _ := exec.Command("zellij", "setup", "--dump-config").Output()
		os.MkdirAll(filepath.Join(home, ".config", "zellij"), 0o755)
		os.WriteFile(filepath.Join(home, ".config", "zellij", "config.kdl"), cfg, 0o644)
	}
	resetZellijVersion()
	m, err := newZellijMux(t.Context())
	if err != nil {
		t.Skipf("needs zellij 0.45 or later: %v", err)
	}
	t.Cleanup(func() {
		if t.Failed() {
			logs, _ := filepath.Glob(filepath.Join(home, "zellij-*", "zellij-log", "*.log"))
			for _, l := range logs {
				b, _ := os.ReadFile(l)
				if len(b) > 4000 {
					b = b[len(b)-4000:]
				}
				t.Logf("%s:\n%s", l, b)
				if d := os.Getenv("ZELLIJ_TEST_LOG_DIR"); d != "" {
					full, _ := os.ReadFile(l)
					os.WriteFile(filepath.Join(d, t.Name()+".log"), full, 0o600)
				}
			}
		}
		for _, list := range m.clients {
			for _, c := range list {
				c.close()
			}
		}
		exec.Command("zellij", "kill-all-sessions", "--yes").Run()
		exec.Command("zellij", "delete-all-sessions", "--yes", "--force").Run()
		os.RemoveAll(sock)
		resetZellijVersion()
	})
	return m
}

// userClient attaches a plain zellij client in a PTY, like the user's own
// terminal; its output is drained.
func userClient(t *testing.T, session string) TermStream {
	t.Helper()
	before, _ := zellijClients(t.Context(), session)
	// Zellij now and then drops a client right after it attaches.
	for try := 0; ; try++ {
		// As attachClient does, no zellij command runs while it connects.
		zellijGate.Lock()
		ts, err := startTerminal([]string{"zellij", "attach", session}, Size{Cols: 100, Rows: 30})
		if err != nil {
			zellijGate.Unlock()
			t.Fatal(err)
		}
		out := newZellijOutput()
		copied := make(chan struct{})
		go func() { io.Copy(out, ts); out.close(io.EOF); close(copied) }()
		out.waitDrawn(zellijConnectWait)
		zellijGate.Unlock()
		t.Cleanup(func() { ts.Close() })
		_, err = waitNewZellijClient(t.Context(), session, before, ts.Done())
		if err == nil {
			return ts
		}
		<-copied
		tail := out.buf
		if len(tail) > 600 {
			tail = tail[len(tail)-600:]
		}
		t.Logf("user client attempt %d: %v (code %d): %q", try, err, ts.ExitCode(), tail)
		if !errors.Is(err, errZellijClientExited) || try >= 5 {
			t.Fatalf("user client not listed: %v", err)
		}
		time.Sleep(300 * time.Millisecond)
	}
}

func zellijGroupNamed(t *testing.T, s Snapshot, name string) Group {
	t.Helper()
	for _, g := range s.Groups {
		if g.Name == name {
			return g
		}
	}
	t.Fatalf("no group %q in %+v", name, s.Groups)
	return Group{}
}

func zellijWaitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func TestZellijRealBackend(t *testing.T) {
	m := realZellij(t)
	ctx := t.Context()

	// A view-only read never creates the default session.
	if snap, err := m.peekSnapshot(ctx); err != nil || len(snap.Groups) != 0 {
		t.Fatalf("peek with no session = %+v, %v", snap.Groups, err)
	}
	snap, err := m.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	g := zellijGroupNamed(t, snap, "main")
	if len(g.Tabs) != 1 || len(g.Tabs[0].Panes) != 1 {
		t.Fatalf("main = %+v", g)
	}
	pane0 := g.Tabs[0].Panes[0].ID

	// Without a client, Zellij would make a broken tab.
	if _, err := m.NewTab(ctx, g.ID, "nope"); !errors.Is(err, errZellijNoClient) {
		t.Fatalf("NewTab without a client = %v, want no_client", err)
	}

	user := userClient(t, "main")
	tab2, err := m.NewTab(ctx, g.ID, "two")
	if err != nil {
		t.Fatal(err)
	}
	snap, _ = m.Snapshot(ctx)
	g = zellijGroupNamed(t, snap, "main")
	if len(g.Tabs) != 2 || g.Tabs[1].ID != tab2 || g.Tabs[1].Name != "two" {
		t.Fatalf("tabs after NewTab = %+v", g.Tabs)
	}
	pane2 := g.Tabs[1].Panes[0].ID
	key2 := g.Tabs[1].Key
	userID := ""
	clients, _ := zellijClients(ctx, "main")
	for id := range clients {
		userID = id
	}
	userPane := clients[userID]

	// A stream on the second tab lands there; the user's client stays.
	stream, err := m.Attach(ctx, pane2, Size{Cols: 90, Rows: 28})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	clients, _ = zellijClients(ctx, "main")
	if len(clients) != 2 || clients[userID] != userPane {
		t.Fatalf("clients after Attach = %v (user was on %s)", clients, userPane)
	}
	_, n2, _ := parseZellijPaneID(pane2)
	for id, p := range clients {
		if id != userID && p != zellijTerminal(n2) {
			t.Fatalf("stream client on %s, want %s", p, zellijTerminal(n2))
		}
	}
	got := make(chan []byte, 1)
	go func() {
		b := make([]byte, 64*1024)
		n, _ := stream.Read(b)
		got <- b[:n]
	}()
	select {
	case b := <-got:
		if len(b) == 0 {
			t.Fatal("stream sent nothing")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stream sent nothing")
	}

	// Keys for the first tab's pane go through a hidden client; the
	// stream's keys reach its own pane; the toolbar's Ctrl combos reach the
	// pane instead of Zellij's modes.
	if err := m.SendKeys(ctx, pane0, "echo zellij-hi\r"); err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Write([]byte("printf 'ctl:%s\\n' \"$(printf '\\x10' | od -An -c)\"\r")); err != nil {
		t.Fatal(err)
	}
	readText := func(pane string) string {
		var b bytes.Buffer
		if _, err := m.ReadText(ctx, pane, 200, &b); err != nil {
			t.Fatal(err)
		}
		return b.String()
	}
	zellijWaitFor(t, "echo in pane 0", func() bool { return strings.Contains(readText(pane0), "zellij-hi\n") })
	zellijWaitFor(t, "typed command in pane 2", func() bool { return strings.Contains(readText(pane2), "ctl:") })
	clients, _ = zellijClients(ctx, "main")
	if clients[userID] != userPane {
		t.Fatalf("user client moved to %s", clients[userID])
	}

	// No user text in argv: zellij never ran with the typed text.
	if out, _ := exec.Command("ps", "-eo", "args").Output(); strings.Contains(string(out), "zellij-hi") {
		t.Fatal("typed text seen in a process's argv")
	}

	// Rename, move, close keyed.
	if err := m.RenameTab(ctx, tab2, "renamed", key2); err != nil {
		t.Fatal(err)
	}
	if id, err := m.MoveTab(ctx, tab2, 0); err != nil || id != tab2 {
		t.Fatalf("MoveTab = %q, %v", id, err)
	}
	snap, _ = m.Snapshot(ctx)
	g = zellijGroupNamed(t, snap, "main")
	if g.Tabs[0].ID != tab2 || g.Tabs[0].Name != "renamed" {
		t.Fatalf("tabs after move = %+v", g.Tabs)
	}
	if err := m.CloseTab(ctx, tab2, "wrong-key"); !errors.Is(err, errTabChanged) {
		t.Fatalf("CloseTab with a stale key = %v", err)
	}
	stream.Close()
	if err := m.CloseTab(ctx, tab2, key2); err != nil {
		t.Fatal(err)
	}

	// Groups.
	dir := t.TempDir()
	gid, err := m.NewGroup(ctx, "other one", dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.NewGroup(ctx, "other one", dir); !errors.Is(err, errGroupExists) {
		t.Fatalf("NewGroup on a taken name = %v", err)
	}
	if err := m.RenameGroup(ctx, gid, "main"); !errors.Is(err, errGroupExists) {
		t.Fatalf("RenameGroup onto main = %v", err)
	}
	if err := m.RenameGroup(ctx, zellijGroupID("main"), "x"); !errors.Is(err, errDefaultSession) {
		t.Fatalf("RenameGroup of main = %v", err)
	}
	if err := m.RenameGroup(ctx, gid, "third"); err != nil {
		t.Fatal(err)
	}
	snap, _ = m.Snapshot(ctx)
	third := zellijGroupNamed(t, snap, "third")
	if dirGot, _, err := m.PaneDir(ctx, third.Tabs[0].Panes[0].ID); err != nil || dirGot != dir {
		t.Fatalf("PaneDir = %q, %v; want %q", dirGot, err, dir)
	}
	if err := m.CloseGroup(ctx, third.ID); err != nil {
		t.Fatal(err)
	}
	list, _ := zellijListSessions(ctx)
	for _, s := range list {
		if s.name == "third" {
			t.Fatalf("closed session still listed: %+v", s)
		}
	}
	_ = user
}

// TestZellijRealPositioningLeavesOtherClients attaches repeatedly while the
// user's client keeps sending keys: the user's client never ends up moved.
func TestZellijRealPositioningLeavesOtherClients(t *testing.T) {
	m := realZellij(t)
	ctx := t.Context()
	snap, err := m.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	g := zellijGroupNamed(t, snap, "main")
	user := userClient(t, "main")
	tab2, err := m.NewTab(ctx, g.ID, "two")
	if err != nil {
		t.Fatal(err)
	}
	_ = tab2
	snap, _ = m.Snapshot(ctx)
	g = zellijGroupNamed(t, snap, "main")
	pane2 := g.Tabs[1].Panes[0].ID
	clients, _ := zellijClients(ctx, "main")
	var userID, userPane string
	for id, p := range clients {
		userID, userPane = id, p
	}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-time.After(100 * time.Millisecond):
				user.Write([]byte(zellijNoopKey))
			}
		}
	}()
	ok := 0
	for range 5 {
		s, err := m.Attach(ctx, pane2, Size{Cols: 80, Rows: 24})
		if err != nil {
			if !errors.Is(err, errZellijBusy) {
				t.Fatal(err)
			}
		} else {
			ok++
		}
		clients, _ := zellijClients(ctx, "main")
		if clients[userID] != userPane {
			t.Fatalf("user client on %s, was %s", clients[userID], userPane)
		}
		if s != nil {
			s.Close()
		}
	}
	if ok == 0 {
		t.Fatal("no attach succeeded")
	}
}

// TestZellijRealPositioningOnTheUsersPane: the target is the very pane the
// user's client shows while it keeps sending keys; the user's client is
// never left elsewhere.
func TestZellijRealPositioningOnTheUsersPane(t *testing.T) {
	m := realZellij(t)
	ctx := t.Context()
	snap, err := m.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	pane0 := zellijGroupNamed(t, snap, "main").Tabs[0].Panes[0].ID
	user := userClient(t, "main")
	clients, _ := zellijClients(ctx, "main")
	var userID, userPane string
	for id, p := range clients {
		userID, userPane = id, p
	}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-time.After(100 * time.Millisecond):
				user.Write([]byte(zellijNoopKey))
			}
		}
	}()
	for range 4 {
		s, err := m.Attach(ctx, pane0, Size{Cols: 80, Rows: 24})
		if err != nil && !errors.Is(err, errZellijBusy) {
			t.Fatal(err)
		}
		if clients, _ := zellijClients(ctx, "main"); clients[userID] != userPane {
			t.Fatalf("user client on %s, was %s", clients[userID], userPane)
		}
		if s != nil {
			s.Close()
		}
	}
}

// TestZellijRealViewStream: a view-only stream sends the pane's size, then
// renders showing what the pane prints.
func TestZellijRealViewStream(t *testing.T) {
	m := realZellij(t)
	ctx := t.Context()
	snap, err := m.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	pane0 := zellijGroupNamed(t, snap, "main").Tabs[0].Panes[0].ID
	if !m.CanView(ctx) {
		t.Fatal("CanView false")
	}
	ts, err := m.AttachView(ctx, pane0, Size{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { ts.Close() }()
	sr := ts.(sizeReporter)
	select {
	case c := <-sr.Sizes():
		if c.Size.Cols < 1 || c.Size.Rows < 1 {
			t.Fatalf("size %v", c.Size)
		}
		close(c.sent)
	case <-time.After(5 * time.Second):
		t.Fatal("no size frame")
	}
	go func() {
		for c := range sr.Sizes() {
			close(c.sent)
		}
	}()
	if err := m.SendKeys(ctx, pane0, "echo view-marker\r"); err != nil {
		t.Fatal(err)
	}
	var got bytes.Buffer
	reopened := false
	deadline := time.Now().Add(8 * time.Second)
	buf := make([]byte, 64*1024)
	for !strings.Contains(got.String(), "view-marker\x1b") && !strings.Contains(got.String(), "view-marker\r") {
		if time.Now().After(deadline) {
			t.Fatalf("no render with the marker: %q", got.String())
		}
		n, err := ts.Read(buf)
		got.Write(buf[:n])
		if err != nil {
			// Zellij can drop the subscription (see zellijGate); the PWA
			// opens the stream again, and so does this test, once.
			if reopened {
				t.Fatal(err)
			}
			reopened = true
			ts.Close()
			if ts, err = m.AttachView(ctx, pane0, Size{}); err != nil {
				t.Fatal(err)
			}
			go func(sr sizeReporter) {
				for c := range sr.Sizes() {
					close(c.sent)
				}
			}(ts.(sizeReporter))
		}
	}
}

// A real Zellij: a pane named through termote shows its name in the
// snapshot, its title is that name, and clearing gives the title back.
func TestZellijRealRenamePane(t *testing.T) {
	m := realZellij(t)
	ctx := t.Context()
	snap, err := m.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	id := zellijGroupNamed(t, snap, "main").Tabs[0].Panes[0].ID
	_, n, _ := parseZellijPaneID(id)
	before, err := zellijFindPane(ctx, "main", n)
	if err != nil {
		t.Fatal(err)
	}
	name := func() string {
		s, err := m.Snapshot(ctx)
		if err != nil {
			t.Fatal(err)
		}
		_, _, p, _ := findSnapshotPane(s, id, false)
		return p.Name
	}
	if err := m.RenamePane(ctx, id, "Bản dựng #1"); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the pane titled with its name", func() bool {
		p, _ := zellijFindPane(ctx, "main", n)
		return p.Title == "Bản dựng #1"
	})
	if got := name(); got != "Bản dựng #1" {
		t.Errorf("name = %q", got)
	}
	if err := m.RenamePane(ctx, id, ""); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the pane's own title back", func() bool {
		p, _ := zellijFindPane(ctx, "main", n)
		return p.Title != "Bản dựng #1"
	})
	if got := name(); got != "" {
		t.Errorf("cleared name = %q (title was %q)", got, before.Title)
	}
	if err := m.RenamePane(ctx, zellijPaneID("main", 999), "x"); !errors.Is(err, errUnknownPane) {
		t.Errorf("missing pane = %v", err)
	}
}

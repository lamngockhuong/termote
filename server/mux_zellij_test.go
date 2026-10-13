package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// useFakeZellij points zellijBin at a script that logs its arguments and
// answers from replies: the key is the action name (after `action`), else
// the first argument. A reply is "<exit code>\n<stdout>"; key.N answers the
// Nth call of key when it exists, else key answers every call. A key without
// a reply prints nothing and exits 0. It returns a function reading the log.
func useFakeZellij(t *testing.T, replies map[string]string) func() string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake zellij is a shell script")
	}
	dir := t.TempDir()
	rdir := filepath.Join(dir, "replies")
	os.Mkdir(rdir, 0o755)
	for k, v := range replies {
		if err := os.WriteFile(filepath.Join(rdir, k), []byte(v), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	logPath := filepath.Join(dir, "args")
	script := filepath.Join(dir, "zellij")
	body := `#!/bin/sh
printf '%s\n' "$*" >> '` + logPath + `'
key="$1"
prev=""
for a in "$@"; do
  if [ "$prev" = "action" ]; then key="$a"; break; fi
  prev="$a"
done
n=$(cat '` + rdir + `'/".count.$key" 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > '` + rdir + `'/".count.$key"
f='` + rdir + `'/"$key.$n"
[ -f "$f" ] || f='` + rdir + `'/"$key"
[ -f "$f" ] || exit 0
code=$(head -n 1 "$f")
tail -n +2 "$f"
exit "$code"
`
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	orig := zellijBin
	zellijBin = script
	resetZellijVersion()
	// A short socket dir: under t.TempDir() on macOS the socket path alone
	// fills sun_path (104), leaving no room for any session name.
	sock, err := os.MkdirTemp("/tmp", "zs")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZELLIJ_SOCKET_DIR", sock)
	t.Cleanup(func() { zellijBin = orig; resetZellijVersion(); os.RemoveAll(sock) })
	return func() string {
		b, _ := os.ReadFile(logPath)
		return string(b)
	}
}

func newTestZellijMux() *zellijMux {
	return &zellijMux{
		slots: map[string]chan struct{}{}, clients: map[string][]*zellijClient{},
		departed: map[string]map[string]time.Time{}, reads: map[string]zellijRead{},
		tabKeys: map[zellijTabRef]string{}, skipped: map[string]bool{},
	}
}

const fakeZellijVersion = "0\nzellij 0.45.1\n"

func TestZellijNames(t *testing.T) {
	t.Setenv("ZELLIJ_SOCKET_DIR", "/tmp/zs")
	for _, tc := range []struct {
		name string
		ok   bool
	}{
		{"main", true}, {"my session", true}, {"x;y", true}, {"日本", true},
		{"", false}, {"-x", false}, {"a/b", false}, {"help", false}, {"OPTIONS", false}, {"Help", false},
		{"a\nb", false}, {"a\x1bb", false}, {"a‮b", false}, {"a​b", false}, {"trail;", false},
		{strings.Repeat("a", 200), false},
	} {
		if got := validZellijName(tc.name); got != tc.ok {
			t.Errorf("validZellijName(%q) = %v, want %v", tc.name, got, tc.ok)
		}
	}
	// The limit follows the socket path: 108 - 1 - len("/tmp/zs/contract_version_1/").
	if max := zellijMaxNameLen(); max != 107-len("/tmp/zs/contract_version_1/") && runtime.GOOS == "linux" {
		t.Errorf("zellijMaxNameLen = %d", max)
	}
	if validZellijName(strings.Repeat("a", zellijMaxNameLen()+1)) || !validZellijName(strings.Repeat("a", zellijMaxNameLen())) {
		t.Error("the length limit is off by one")
	}
	// An existing name can be passed when it holds a '/'-free... any text
	// zellij takes after `--session`.
	if !zellijPassableName("x/y") || zellijPassableName("-x") || zellijPassableName("options") {
		t.Error("zellijPassableName")
	}
}

func TestZellijIDs(t *testing.T) {
	for _, s := range []string{"main", "a b:c", "x_-y", "日本"} {
		gid := zellijGroupID(s)
		if strings.HasPrefix(gid, "-") || strings.Contains(gid, ":") {
			t.Errorf("group id %q", gid)
		}
		if got, ok := parseZellijGroupID(gid); !ok || got != s {
			t.Errorf("group %q round trip = %q, %v", s, got, ok)
		}
		tab, pane := zellijTabID(s, 3), zellijPaneID(s, 3)
		if tab == pane {
			t.Errorf("tab and pane ids collide: %q", tab)
		}
		if gs, n, ok := parseZellijTabID(tab); !ok || gs != s || n != 3 {
			t.Errorf("tab %q = %q %d %v", tab, gs, n, ok)
		}
		if gs, n, ok := parseZellijPaneID(pane); !ok || gs != s || n != 3 {
			t.Errorf("pane %q = %q %d %v", pane, gs, n, ok)
		}
		if _, _, ok := parseZellijPaneID(tab); ok {
			t.Errorf("a tab id parsed as a pane id: %q", tab)
		}
	}
	for _, bad := range []string{"", "z", "main", "zbWFpbg:p", "zbWFpbg:p01", "zbWFpbg:p-1", "zbWFpbg:p99999999999",
		"zbWFpbg:t1:p2", "z!!!:p1", zellijGroupID("-x") + ":p1", zellijGroupID("help") + ":t0"} {
		if _, _, ok := parseZellijPaneID(bad); ok {
			t.Errorf("parseZellijPaneID(%q) accepted", bad)
		}
		if _, _, ok := parseZellijTabID(bad); ok {
			t.Errorf("parseZellijTabID(%q) accepted", bad)
		}
	}
}

func TestZellijVersion(t *testing.T) {
	if v, ok := parseZellijVersion("zellij 0.45.1\n"); !ok || v != [3]int{0, 45, 1} {
		t.Errorf("parse = %v %v", v, ok)
	}
	if _, ok := parseZellijVersion("tmux 3.4"); ok {
		t.Error("parsed a foreign version")
	}
	if versionAtLeast([3]int{0, 44, 9}, zellijMinVersion) || !versionAtLeast([3]int{0, 45, 0}, zellijMinVersion) ||
		!versionAtLeast([3]int{1, 0, 0}, zellijMinVersion) {
		t.Error("versionAtLeast")
	}
}

// TestZellijVersionReread: a binary that changed (an upgrade) is read again,
// and one too old fails.
func TestZellijVersionReread(t *testing.T) {
	useFakeZellij(t, map[string]string{"--version": fakeZellijVersion})
	if _, err := zellijCheckVersion(t.Context()); err != nil {
		t.Fatal(err)
	}
	script := zellijBin
	b, _ := os.ReadFile(script)
	b = append(b, []byte("\n# changed\n")...)
	os.WriteFile(script, b, 0o755)
	os.WriteFile(filepath.Join(filepath.Dir(script), "replies", "--version"), []byte("0\nzellij 0.44.3\n"), 0o644)
	future := time.Now().Add(time.Minute)
	os.Chtimes(script, future, future)
	zellijVersion.Lock()
	zellijVersion.checked = time.Time{}
	zellijVersion.Unlock()
	if _, err := zellijCheckVersion(t.Context()); err == nil || !strings.Contains(err.Error(), "too old") {
		t.Fatalf("an upgraded binary was not read again: %v", err)
	}
}

func TestParseZellijSessions(t *testing.T) {
	out := "main [Created 2m ago] \n" +
		"old [Created 1h ago] (EXITED - attach to resurrect)\n" +
		"we ird [Created x [Created 0s ago] \n" +
		"garbage line\n" +
		"cur [Created 1s ago] (current)\n"
	got := parseZellijSessions(out)
	want := []zellijSession{{"main", false}, {"old", true}, {"we ird [Created x", false}, {"cur", false}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestZellijEnvDropsPaneIdentity(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("zellij is refused natively on Windows")
	}
	t.Setenv("ZELLIJ", "0")
	t.Setenv("ZELLIJ_PANE_ID", "4")
	t.Setenv("ZELLIJ_SESSION_NAME", "outer")
	t.Setenv("ZELLIJ_SOCKET_DIR", "/tmp/zs")
	t.Setenv("TERMOTE_PASS", "secret")
	env := strings.Join(zellijEnv(), "\n") + "\n"
	for _, gone := range []string{"ZELLIJ=", "ZELLIJ_PANE_ID=", "ZELLIJ_SESSION_NAME=", "TERMOTE_PASS="} {
		if strings.Contains("\n"+env, "\n"+gone) {
			t.Errorf("%s kept", gone)
		}
	}
	if !strings.Contains(env, "ZELLIJ_SOCKET_DIR=/tmp/zs\n") {
		t.Error("ZELLIJ_SOCKET_DIR dropped")
	}
}

func TestZellijQueryRetries(t *testing.T) {
	useFakeZellij(t, map[string]string{
		"list-tabs.1": "0\n", "list-tabs.2": "0\n1\n", "list-tabs.3": "0\n[{\"id\":0,\"is_plugin\":false,\"tab_id\":0}]\n",
		"list-tabs.4": "0\n[{\"tab_id\":0,\"position\":0}]\n",
		"list-panes":  "0\n",
	})
	out, err := zellijQuery(t.Context(), "main", zellijTabsList, "list-tabs")
	if err != nil || !strings.Contains(string(out), `"position"`) {
		t.Fatalf("an empty, then a foreign answer was not retried: %q, %v", out, err)
	}
	if _, err := zellijQuery(t.Context(), "main", zellijPanesList, "list-panes"); !errors.Is(err, errZellijEmpty) {
		t.Fatalf("always empty = %v, want errZellijEmpty", err)
	}
}

const fakeZellijTabs = `0
[{"tab_id":0,"position":1,"name":"second","active":false},{"tab_id":2,"position":0,"name":"first","active":true}]`

const fakeZellijPanes = `0
[{"id":0,"is_plugin":true,"title":"tab-bar","tab_id":0},
 {"id":3,"is_plugin":false,"is_focused":true,"title":"t3","tab_id":0,"pane_command":"/usr/bin/vim --clean secret.txt","pane_cwd":"/home/u"},
 {"id":1,"is_plugin":false,"title":"t1","tab_id":0,"pane_command":"bash","pane_cwd":"/tmp"},
 {"id":5,"is_plugin":false,"title":"t5","tab_id":2,"pane_command":"","pane_cwd":""}]`

func TestZellijSnapshot(t *testing.T) {
	log := useFakeZellij(t, map[string]string{
		"--version":     fakeZellijVersion,
		"list-sessions": "0\nmain [Created 1m ago] \nold [Created 1h ago] (EXITED - attach to resurrect)\n-bad [Created 1s ago] \n",
		"list-tabs":     fakeZellijTabs,
		"list-panes":    fakeZellijPanes,
	})
	m := newTestZellijMux()
	snap, err := m.Snapshot(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Groups) != 1 || snap.Groups[0].Name != "main" {
		t.Fatalf("groups = %+v (EXITED and unpassable names must be left out)", snap.Groups)
	}
	g := snap.Groups[0]
	if len(g.Tabs) != 2 || g.Tabs[0].Name != "first" || g.Tabs[1].Name != "second" {
		t.Fatalf("tabs not in position order: %+v", g.Tabs)
	}
	second := g.Tabs[1]
	if len(second.Panes) != 2 || second.Panes[0].ID != zellijPaneID("main", 1) || second.Panes[1].ID != zellijPaneID("main", 3) {
		t.Fatalf("panes = %+v", second.Panes)
	}
	if second.Key != zellijPaneKey("main", 1) {
		t.Errorf("tab key = %q", second.Key)
	}
	if p := second.Panes[1].Process; p == nil || p.Name != "vim" || p.Cwd != "/home/u" || !second.Panes[1].Active {
		t.Errorf("pane 3 = %+v %+v", second.Panes[1], p)
	}
	if strings.Contains(log(), "attach") {
		t.Error("a snapshot with a running session created one")
	}
}

// TestZellijTabKeyOutlivesItsFirstPane: the key stays when the pane it was
// taken from closes, and goes with the tab.
func TestZellijTabKeyOutlivesItsFirstPane(t *testing.T) {
	m := newTestZellijMux()
	k := m.tabKey("main", 0, []zellijPaneInfo{{ID: 1}, {ID: 3}})
	if again := m.tabKey("main", 0, []zellijPaneInfo{{ID: 3}}); again != k {
		t.Errorf("key changed: %q → %q", k, again)
	}
	m.pruneTabKeys([]string{"main"}, []zellijRead{{tabs: []zellijTabInfo{{TabID: 1}}}})
	if reused := m.tabKey("main", 0, []zellijPaneInfo{{ID: 7}}); reused == k {
		t.Errorf("a reused tab id kept the old key %q", k)
	}
}

func TestZellijSnapshotReadFallback(t *testing.T) {
	useFakeZellij(t, map[string]string{
		"--version":     fakeZellijVersion,
		"list-sessions": "0\nmain [Created 1m ago] \n",
		"list-tabs.1":   fakeZellijTabs,
		"list-panes.1":  fakeZellijPanes,
		"list-tabs":     "1\nboom\n",
	})
	m := newTestZellijMux()
	if _, err := m.Snapshot(t.Context()); err != nil {
		t.Fatal(err)
	}
	snap, err := m.Snapshot(t.Context())
	if err != nil || len(snap.Groups) != 1 || len(snap.Groups[0].Tabs) != 2 {
		t.Fatalf("a failed read did not stand on the last good one: %+v, %v", snap.Groups, err)
	}
	m.mu.Lock()
	r := m.reads["main"]
	r.at = time.Now().Add(-zellijReadKeep - time.Second)
	m.reads["main"] = r
	m.mu.Unlock()
	if snap, err := m.Snapshot(t.Context()); err == nil {
		t.Fatalf("an old read stood in: %+v", snap.Groups)
	}
	// A session that ended between the listing and its read is left out.
	os.WriteFile(filepath.Join(filepath.Dir(zellijBin), "replies", "list-tabs"), []byte("1\nThere is no active session!\n"), 0o644)
	if snap, err := m.Snapshot(t.Context()); err != nil || len(snap.Groups) != 0 {
		t.Fatalf("a session gone = %+v, %v", snap.Groups, err)
	}
}

func TestZellijPeekCreatesNothing(t *testing.T) {
	log := useFakeZellij(t, map[string]string{
		"--version":     fakeZellijVersion,
		"list-sessions": "1\nNo active zellij sessions found.\n",
	})
	m := newTestZellijMux()
	snap, err := m.peekSnapshot(t.Context())
	if err != nil || len(snap.Groups) != 0 {
		t.Fatalf("peek = %+v, %v", snap.Groups, err)
	}
	if v, err := viewSnapshot(t.Context(), m); err != nil || len(v.Groups) != 0 {
		t.Fatalf("view snapshot = %+v, %v", v.Groups, err)
	}
	if strings.Contains(log(), "attach") {
		t.Fatalf("a peek created a session:\n%s", log())
	}
	if _, err := m.Snapshot(t.Context()); err == nil {
		// The fake never lists the session it was asked to create.
		t.Log("snapshot created the default session")
	}
	if !strings.Contains(log(), "attach --create-background main") {
		t.Fatalf("the snapshot did not create the default session:\n%s", log())
	}
}

func TestZellijNewTabWithoutClient(t *testing.T) {
	log := useFakeZellij(t, map[string]string{"list-clients": "0\nCLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n"})
	m := newTestZellijMux()
	if _, err := m.NewTab(t.Context(), zellijGroupID("main"), "x"); !errors.Is(err, errZellijNoClient) {
		t.Fatalf("NewTab = %v, want no_client", err)
	}
	if strings.Contains(log(), "new-tab") {
		t.Fatal("new-tab ran without a client")
	}
}

func TestZellijMoveTabNeverWraps(t *testing.T) {
	log := useFakeZellij(t, map[string]string{
		"list-tabs.1": `0
[{"tab_id":4,"position":0},{"tab_id":1,"position":1},{"tab_id":2,"position":2}]`,
		"list-tabs.2": `0
[{"tab_id":1,"position":0},{"tab_id":2,"position":1},{"tab_id":4,"position":2}]`,
		"list-tabs": `0
[{"tab_id":1,"position":0},{"tab_id":2,"position":1},{"tab_id":4,"position":2}]`,
	})
	m := newTestZellijMux()
	id, err := m.MoveTab(t.Context(), zellijTabID("main", 4), 2)
	if err != nil || id != zellijTabID("main", 4) {
		t.Fatalf("MoveTab = %q, %v", id, err)
	}
	if got := strings.Count(log(), "move-tab --tab-id 4 right"); got != 1 || strings.Contains(log(), " left") {
		t.Fatalf("moves:\n%s", log())
	}
	if _, err := m.MoveTab(t.Context(), zellijTabID("main", 4), 3); !errors.Is(err, errInvalidIndex) {
		t.Fatalf("index past the end = %v", err)
	}
}

func TestZellijGroupGuards(t *testing.T) {
	log := useFakeZellij(t, map[string]string{
		"list-sessions": "0\nwork [Created 1m ago] \nspare [Created 1m ago] (EXITED - attach to resurrect)\n",
	})
	m := newTestZellijMux()
	ctx := t.Context()
	if err := m.RenameGroup(ctx, zellijGroupID("work"), "spare"); !errors.Is(err, errGroupExists) {
		t.Errorf("rename onto a kept name = %v", err)
	}
	if err := m.RenameGroup(ctx, zellijGroupID("main"), "x"); !errors.Is(err, errDefaultSession) {
		t.Errorf("rename main = %v", err)
	}
	if err := m.RenameGroup(ctx, zellijGroupID("work"), "-x"); !errors.Is(err, errInvalidGroupName) {
		t.Errorf("rename to -x = %v", err)
	}
	if _, err := m.NewGroup(ctx, "spare", "/tmp"); !errors.Is(err, errGroupExists) {
		t.Errorf("new group on an EXITED name = %v", err)
	}
	if _, err := m.NewGroup(ctx, "help", "/tmp"); !errors.Is(err, errInvalidGroupName) {
		t.Errorf("new group help = %v", err)
	}
	if strings.Contains(log(), "rename-session") || strings.Contains(log(), "attach") {
		t.Fatalf("a refused change ran:\n%s", log())
	}
	if err := m.RenameGroup(ctx, zellijGroupID("work"), "-- odd"); !errors.Is(err, errInvalidGroupName) {
		t.Errorf("rename to a dash name = %v", err)
	}
	if err := m.RenameGroup(ctx, zellijGroupID("work"), "next"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(log(), "--session work action rename-session -- next") {
		t.Fatalf("rename argv:\n%s", log())
	}
}

func TestZellijValuesFollowDoubleDash(t *testing.T) {
	log := useFakeZellij(t, map[string]string{
		"list-tabs":  `0` + "\n" + `[{"tab_id":0,"position":0}]`,
		"list-panes": `0` + "\n" + `[{"id":0,"tab_id":0}]`,
	})
	m := newTestZellijMux()
	ctx := t.Context()
	if err := m.RenameTab(ctx, zellijTabID("main", 0), "--help", ""); err != nil {
		t.Fatal(err)
	}
	if err := m.CloseTab(ctx, zellijTabID("main", 0), ""); err != nil {
		t.Fatal(err)
	}
	l := log()
	if !strings.Contains(l, "rename-tab-by-id -- 0 --help") || !strings.Contains(l, "close-tab-by-id -- 0") {
		t.Fatalf("values before `--`:\n%s", l)
	}
	if err := m.RenameTab(ctx, zellijTabID("main", 0), "a\x1b[31m", ""); err == nil {
		t.Fatal("a control character in a tab name was taken")
	}
}

// TestZellijNoUserTextInArgv: typed text, pastes and keys never go through a
// zellij action that would put them in argv; they go through a client PTY.
func TestZellijNoUserTextInArgv(t *testing.T) {
	files, _ := filepath.Glob("*zellij*.go")
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, _ := os.ReadFile(f)
		for _, action := range []string{`"write-chars"`, `"paste"`, `"send-keys"`, `"write"`} {
			if bytes.Contains(b, []byte(action)) {
				t.Errorf("%s runs zellij action %s", f, action)
			}
		}
	}
}

func TestIsZellijStreamCmdline(t *testing.T) {
	for _, tc := range []struct {
		cmd string
		ok  bool
	}{
		{strings.Join(zellijAttachArgv("main"), " "), true},
		{strings.Join(zellijAttachArgv("my session"), " "), true},
		{strings.Join(zellijSubscribeArgv("main", 3), " "), true},
		{"zellij attach main", false},
		{"zellij attach", false},
		{"zellij " + strings.Join(zellijAttachOptions, " "), false},
		{"zellij --session main subscribe --pane-id terminal_3", false},
		{"zellij --session main subscribe --pane-id terminal_x --ansi -f json", false},
	} {
		if got := isZellijStreamCmdline(tc.cmd); got != tc.ok {
			t.Errorf("isZellijStreamCmdline(%q) = %v", tc.cmd, got)
		}
	}
}

func TestZellijClientList(t *testing.T) {
	got := zellijClientList("CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n1         terminal_0     N/A\n2 plugin_3 zellij:about\n\n")
	if len(got) != 2 || got["1"] != "terminal_0" || got["2"] != "plugin_3" {
		t.Errorf("got %v", got)
	}
	if got := zellijClientList("CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n"); len(got) != 0 {
		t.Errorf("header only = %v", got)
	}
}

func TestZellijRepaint(t *testing.T) {
	b, ok := zellijRepaint([]string{"\x1b[31mred\x1b[m", "plain"}, Size{Cols: 10, Rows: 1})
	if !ok || string(b) != "\x1b[?25l\x1b[H\x1b[31mred\x1b[m\x1b[m\x1b[K\x1b[m\x1b[J" {
		t.Errorf("rows past the size must be cut: %q", b)
	}
	if _, ok := zellijRepaint([]string{strings.Repeat("x", zellijMaxRow+1)}, Size{Cols: 10, Rows: 2}); ok {
		t.Error("an oversize row was drawn")
	}
}

// TestZellijViewStreamDecode: recorded subscribe lines become a size frame
// before any render, repaints, and a size frame again when the pane's size
// changes; pane_closed ends the stream cleanly.
func TestZellijViewStreamDecode(t *testing.T) {
	lines, err := os.ReadFile(filepath.Join("testdata", "zellij-subscribe-basic.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	pr, pw := io.Pipe()
	s := &zellijViewStream{pr: pr, pw: pw, sizes: make(chan sizeChange), proc: &observer{decoded: make(chan struct{})},
		stop: make(chan struct{}), done: make(chan struct{})}
	sizes := []Size{{Cols: 50, Rows: 4}, {Cols: 40, Rows: 6}}
	reads := 0
	go s.decode(bytes.NewReader(lines), sizes[0], func(context.Context) (Size, error) {
		reads++
		return sizes[1], nil
	})
	step := func(what string, f func()) {
		done := make(chan struct{})
		go func() { f(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("stuck waiting for %s", what)
		}
	}
	size := func(want Size) {
		step(fmt.Sprintf("size %v", want), func() {
			c := <-s.sizes
			if c.Size != want {
				t.Errorf("size frame %v, want %v", c.Size, want)
			}
			close(c.sent)
		})
	}
	frame := func(want string) {
		step("frame "+want, func() {
			buf := make([]byte, 64*1024)
			n, _ := pr.Read(buf)
			if got := strings.SplitN(string(buf[:n]), "\x1b[m\x1b[K", 2)[0]; got != want {
				t.Errorf("frame %q, want %q", got, want)
			}
		})
	}
	// Each step blocks decode until it is taken, so the order is checked.
	size(sizes[0])
	frame("\x1b[?25l\x1b[Hfirst")
	size(sizes[1])
	frame("\x1b[?25l\x1b[Hsecond")
	step("the end", func() { <-s.proc.decoded })
	pw.Close()
	if !s.proc.closed {
		t.Error("pane_closed did not mark the stream closed")
	}
}

func TestParseLsofUnixOwners(t *testing.T) {
	out := "p100\nf3\nn/tmp/zs/contract_version_1/main\np200\nf4\nn/tmp/zs/contract_version_1/mainx\np300\nn/tmp/zs/contract_version_1/main\nn/tmp/zs/contract_version_1/main\n"
	if got := parseLsofUnixOwners(out, "/tmp/zs/contract_version_1/main"); fmt.Sprint(got) != "[100 300]" {
		t.Errorf("got %v", got)
	}
}

func TestZellijEnvValue(t *testing.T) {
	if zellijEnvValue([]string{"A=1", "ZELLIJ_PANE_ID=3"}, "ZELLIJ_PANE_ID") != "3" ||
		zellijEnvValue([]string{"ZELLIJ_PANE_ID=3", "ZELLIJ_PANE_ID=4"}, "ZELLIJ_PANE_ID") != "" ||
		zellijEnvValue([]string{"ZELLIJ_PANE_ID_X=3"}, "ZELLIJ_PANE_ID") != "" {
		t.Error("zellijEnvValue")
	}
}

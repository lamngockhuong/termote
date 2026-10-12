package main

import (
	"context"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// usePsmux sets tmuxIsPsmux for one test.
func usePsmux(t *testing.T, on bool) {
	t.Helper()
	orig := tmuxIsPsmux
	tmuxIsPsmux = on
	t.Cleanup(func() { tmuxIsPsmux = orig })
}

// psmux has no "=" before a window index and never matches a window name,
// so its window targets carry the bare index; sessions stay exact.
func TestParseTmuxIDPsmux(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	usePsmux(t, true)
	for id, want := range map[string]string{"0": "=main:0", "12": "=main:12", "$3:1": "$3:1"} {
		if w, ok := parseTmuxID(id); !ok || w.target() != want {
			t.Errorf("parseTmuxID(%q).target() = %q, %v; want %q", id, w.target(), ok, want)
		}
	}
}

// On psmux every window command uses the bare index, and a tab is selected
// only once display-message has answered for that very window: psmux
// answers select-window on a missing one with exit 0.
func TestPsmuxTargets(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	usePsmux(t, true)
	ctx := context.Background()
	m := tmuxMux{}
	args := useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": {out: "$3:1:work\n"}})
	if err := m.SelectTab(ctx, "$3:1"); err != nil {
		t.Fatal(err)
	}
	m.CloseTab(ctx, "$3:2", "")
	m.RenameTab(ctx, "0", "x", "")
	m.SendKeys(ctx, "$3:0", "ls")
	want := []string{
		"display-message -p -t $3:1 #{session_id}:#{window_index}:#{session_name}",
		"select-window -t $3:1",
		"kill-window -t $3:2",
		"rename-window -t =main:0 x",
		"send-keys -t $3:0 ls",
	}
	if got := strings.Split(strings.TrimSpace(args()), "\n"); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("argv = %q", got)
	}

	// psmux prints its error on stdout with exit 0, or answers for another
	// window: no select-window then.
	for _, out := range []string{"ERROR: can't find window: 9\n", "$3:0:work\n", "$4:1:work\n", ""} {
		args := useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": {out: out}})
		var ie inputError
		if err := m.SelectTab(ctx, "$3:1"); !errors.As(err, &ie) {
			t.Errorf("SelectTab with reply %q = %v", out, err)
		}
		if strings.Contains(args(), "select-window") {
			t.Errorf("reply %q: argv = %q", out, args())
		}
	}
	// The default session is checked by name.
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": {out: "$0:1:main\n"}})
	if err := m.SelectTab(ctx, "1"); err != nil {
		t.Errorf("SelectTab(1) = %v", err)
	}
}

// The agent routes address a pane by its window on psmux, where every
// session has a %1, and by tmux's own pane id on tmux. The target comes
// from tmux's reply, so a window named "2" or "$0:2" has one target (the
// pane lock's key).
func TestTmuxAgentTarget(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	find := func(string, int) (AgentSession, bool) { return AgentSession{Agent: "claude"}, true }
	ctx := context.Background()
	for _, tc := range []struct {
		psmux       bool
		id, reply   string
		wantTarget  string
		wantDisplay string
	}{
		{false, "2", "$0:2:0:%5:1:main", "%5", "-t =main:=2 "},
		{true, "2", "$0:2:0:%1:1:main", "$0:2", "-t =main:2 "},
		{true, "$0:2", "$0:2:0:%1:1:main", "$0:2", "-t $0:2 "},
		{true, "$3:1", "$3:1:0:%1:1:work", "$3:1", "-t $3:1 "},
	} {
		usePsmux(t, tc.psmux)
		args := useFakeTmux(t, tc.reply)
		s, ok, err := tmuxAgentSession(ctx, tc.id, find)
		if !ok || err != nil || s.Target != tc.wantTarget {
			t.Errorf("psmux=%v %q: %+v, %v, %v; want target %q", tc.psmux, tc.id, s, ok, err, tc.wantTarget)
		}
		if !strings.Contains(args(), tc.wantDisplay) {
			t.Errorf("psmux=%v argv = %q", tc.psmux, args())
		}
	}
}

func TestPsmuxAgentWriterTargets(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	usePsmux(t, true)
	args := useFakeTmux(t, "")
	ctx := context.Background()
	m := tmuxMux{}
	if _, err := m.Capture(ctx, "$3:1"); err != nil {
		t.Fatal(err)
	}
	if err := m.SendKeySequence(ctx, "$0:0", []string{"Enter"}); err != nil {
		t.Fatal(err)
	}
	if err := m.Paste(ctx, "$3:1", "x"); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(args()), "\n")
	if len(lines) != 3 || lines[0] != "capture-pane -p -e -t $3:1" || lines[1] != "send-keys -t $0:0 Enter" ||
		lines[2] != "send-keys -H -t $3:1 1b 5b 32 30 30 7e 78 1b 5b 32 30 31 7e" {
		t.Fatalf("argv = %q", lines)
	}
	// A pane id is ambiguous on psmux; anything but "$N:i", the form
	// agentTarget builds, is refused before tmux runs.
	var ie inputError
	for _, bad := range []string{"%1", "main:0", "=main:0", "=other:0", "$3", "$3:x", "$3:=0", "-t", "$3:1;"} {
		if _, err := m.Capture(ctx, bad); !errors.As(err, &ie) {
			t.Errorf("Capture(%q) = %v", bad, err)
		}
		if err := m.SendKeySequence(ctx, bad, []string{"Enter"}); !errors.As(err, &ie) {
			t.Errorf("SendKeySequence(%q) = %v", bad, err)
		}
	}
}

// psmux keys a tab by its id (whether its window ids are unique on the
// server is unchecked), so a close or rename with that key acts on the id's
// target with nothing listed first.
func TestPsmuxTabKeys(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	usePsmux(t, true)
	args := useFakeTmuxScript(t, map[string]fakeTmuxReply{"list-windows": {out: "$0:0:1:%1:1:@4:main:sh\n"}})
	snap, err := (tmuxMux{}).Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if tab := snap.Groups[0].Tabs[0]; tab.Key != "0" || tab.Panes[0].key != "0" {
		t.Errorf("tab key %q, pane key %q; want the id", tab.Key, tab.Panes[0].key)
	}
	before := len(strings.Split(strings.TrimSpace(args()), "\n"))
	if err := (tmuxMux{}).CloseTab(context.Background(), "0", "0"); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(args()), "\n")
	if len(lines) != before+1 || lines[before] != "kill-window -t =main:0" {
		t.Errorf("argv = %q", lines[before:])
	}
}

// psmuxPaneLine is one psmuxPaneFormat line as psmux prints it.
func psmuxPaneLine(sid, win, pane, active, cmd, path string) string {
	return strings.Join([]string{sid, win, pane, active, cmd, path}, "|") + "\r\n"
}

// psmux expands #{n:} to nothing, so its panes are read one a line.
func TestParsePsmuxPanes(t *testing.T) {
	w := func(sid, idx string) tmuxWindowKey { return tmuxWindowKey{sid, idx} }
	names := func(panes []tmuxPaneProc) string {
		var s []string
		for _, p := range panes {
			s = append(s, p.proc.Name+"@"+p.proc.Cwd)
		}
		return strings.Join(s, ",")
	}
	spaced := `C:\Users\a b\my proj`

	// Two sessions with the same window and pane index, out of pane order,
	// a path with spaces; "\r\n" ends and a last line without one.
	got := parsePsmuxPanes([]byte(psmuxPaneLine("$0", "0", "1", "1", "pwsh", spaced) +
		psmuxPaneLine("$0", "0", "0", "0", "node", `C:\x`) + psmuxPaneLine("$0", "2", "0", "1", "claude", `D:\`) +
		strings.TrimSuffix(psmuxPaneLine("$3", "0", "1", "1", "codex", `C:\y`), "\r\n")))
	if len(got) != 3 {
		t.Fatalf("windows = %+v", got)
	}
	if s, want := names(got[w("$0", "0")]), "node@"+processCwd(`C:\x`)+",pwsh@"+processCwd(spaced); s != want || !got[w("$0", "0")][1].active {
		t.Errorf("window $0:0 = %q, want %q", s, want)
	}
	if names(got[w("$0", "2")]) != "claude@"+processCwd(`D:\`) || names(got[w("$3", "0")]) != "codex@"+processCwd(`C:\y`) {
		t.Errorf("windows = %+v", got)
	}
	// "\n" ends are read too.
	got = parsePsmuxPanes([]byte("$1|0|0|1|vim|/a\n$1|0|1|0|sh|/b\n"))
	if names(got[w("$1", "0")]) != "vim@/a,sh@/b" {
		t.Errorf("LF ends: %+v", got)
	}

	// Stops at what it cannot read, keeping the windows before but not the
	// one it stopped in, which would be missing panes.
	head := psmuxPaneLine("$0", "0", "0", "1", "pwsh", `C:\h`) + psmuxPaneLine("$0", "1", "0", "1", "vim", `C:\h`)
	for name, c := range map[string]struct {
		tail string
		want []tmuxWindowKey
	}{
		"fewer fields":      {"$0|1|1|0|bash\r\n", []tmuxWindowKey{w("$0", "0")}},
		"more fields":       {"$0|1|1|0|bash|C:\\a|b\r\n", []tmuxWindowKey{w("$0", "0")}},
		"control character": {"$0|1|1|0|ba\x1bsh|C:\\a\r\n$0|2|0|1|vim|C:\\b\r\n", []tmuxWindowKey{w("$0", "0")}},
		"bad pane index":    {"$0|1|x|0|bash|C:\\a\r\n", []tmuxWindowKey{w("$0", "0")}},
		"bad active":        {"$0|1|1|2|bash|C:\\a\r\n", []tmuxWindowKey{w("$0", "0")}},
		"another window":    {"$0|2|0|9|bash|C:\\a\r\n", []tmuxWindowKey{w("$0", "0"), w("$0", "1")}},
		"blank line":        {"\r\n$0|2|0|1|vim|C:\\b\r\n", []tmuxWindowKey{w("$0", "0")}},
		"not expanded":      {psmuxPaneFormat + "\r\n", []tmuxWindowKey{w("$0", "0")}},
	} {
		got := parsePsmuxPanes([]byte(head + c.tail))
		if len(got) != len(c.want) {
			t.Errorf("%s: %+v", name, got)
		}
		for _, k := range c.want {
			if len(got[k]) != 1 {
				t.Errorf("%s: window %v = %+v", name, k, got[k])
			}
		}
	}

	// A pane listed twice is dropped, its window's other panes kept; no
	// command, no entry.
	got = parsePsmuxPanes([]byte(psmuxPaneLine("$0", "0", "0", "1", "pwsh", "/a") +
		psmuxPaneLine("$0", "0", "0", "1", "vim", "/a") + psmuxPaneLine("$0", "0", "1", "0", "top", "/a") +
		psmuxPaneLine("$0", "0", "2", "0", "", "/a")))
	if s := names(got[w("$0", "0")]); s != "top@/a" {
		t.Errorf("duplicate or empty command kept: %q", s)
	}
	// The #{n:} format psmux leaves empty reads as nothing.
	if got := parseTmuxPanes([]byte("$0:0:0:1::pwsh:C:\\x\r\n")); len(got) != 0 {
		t.Errorf("sized parser on psmux output: %+v", got)
	}
}

// list-panes asks psmux for its own format, and tmux (with -u) for lengths.
func TestTmuxPaneListing(t *testing.T) {
	usePsmux(t, true)
	args, parse := tmuxPaneListing()
	if strings.Join(args, " ") != "list-panes -a -F "+psmuxPaneFormat || len(parse([]byte("$0|0|0|1|pwsh|/a\n"))) != 1 {
		t.Errorf("psmux: %q", args)
	}
	usePsmux(t, false)
	args, parse = tmuxPaneListing()
	if strings.Join(args, " ") != "-u list-panes -a -F "+tmuxPaneFormat || len(parse([]byte("$0:0:0:1:4:pwsh2:/a\n"))) != 1 {
		t.Errorf("tmux: %q", args)
	}
}

func TestPsmuxPasteChunks(t *testing.T) {
	join := func(c []string) string { return strings.Join(c, "") }
	// Empty text still sends both markers; LF goes as CR, tabs as they are.
	if c := psmuxPasteChunks("", 4096); len(c) != 1 || c[0] != "\x1b[200~\x1b[201~" {
		t.Errorf("empty = %q", c)
	}
	if c := psmuxPasteChunks("a\nb\tc\r\n", 4096); len(c) != 1 || c[0] != "\x1b[200~a\rb\tc\r\r\x1b[201~" {
		t.Errorf("LF = %q", c)
	}
	// Exactly the limit is one chunk, one byte more two.
	if c := psmuxPasteChunks(strings.Repeat("a", 100-12), 100); len(c) != 1 {
		t.Errorf("at limit: %d chunks", len(c))
	}
	// The limit falling inside the end marker cuts before it: the last
	// piece always holds the whole marker.
	for over := 1; over <= len(pasteEnd); over++ {
		text := strings.Repeat("a", 100-12+over)
		c := psmuxPasteChunks(text, 100)
		if len(c) != 2 || join(c) != pasteStart+text+pasteEnd || !strings.HasSuffix(c[1], pasteEnd) ||
			(over < len(pasteEnd) && c[1] != pasteEnd) || (over == len(pasteEnd) && len(c[0]) != 100) {
			t.Errorf("%d past limit: %q", over, c)
		}
	}
	// Also when a multi-byte rune sits just before the marker.
	if c := psmuxPasteChunks(strings.Repeat("a", 100-12-1)+"😀", 100); len(c) != 2 || c[1] != pasteEnd || !utf8.ValidString(c[0]) {
		t.Errorf("rune before marker: %q", c)
	}
	// A rune of 1-4 bytes across the cut is never split.
	for _, r := range []string{"a", "é", "€", "😀"} {
		for pad := 0; pad < 8; pad++ {
			text := strings.Repeat("x", 30+pad) + strings.Repeat(r, 20)
			c := psmuxPasteChunks(text, 40)
			if join(c) != "\x1b[200~"+text+"\x1b[201~" {
				t.Fatalf("%q pad %d: chunks do not join back", r, pad)
			}
			if !strings.HasSuffix(c[len(c)-1], pasteEnd) {
				t.Errorf("%q pad %d: end marker cut: %q", r, pad, c)
			}
			for _, s := range c {
				if len(s) == 0 || len(s) > 40 || !utf8.ValidString(s) {
					t.Errorf("%q pad %d: chunk %q", r, pad, s)
				}
			}
		}
	}
	// Large text (24 190 bytes, as measured on psmux): 6 chunks.
	big := strings.Repeat("0123456789", 2419)
	c := psmuxPasteChunks(big, psmuxPasteChunk)
	if len(c) != 6 || join(c) != "\x1b[200~"+big+"\x1b[201~" || !strings.HasPrefix(c[0], "\x1b[200~") ||
		!strings.HasSuffix(c[5], "\x1b[201~") {
		t.Errorf("big: %d chunks", len(c))
	}
	// Bytes that are not UTF-8 still go, cut at the limit.
	bad := strings.Repeat("\x80", 50)
	if c := psmuxPasteChunks(bad, 40); join(c) != "\x1b[200~"+bad+"\x1b[201~" || len(c[0]) != 40 {
		t.Errorf("invalid UTF-8 = %q", c)
	}
}

// Paste on psmux types the bytes into the exact target, never through a
// buffer.
func TestPsmuxPasteArgv(t *testing.T) {
	usePsmux(t, true)
	args := useFakeTmux(t, "")
	text := strings.Repeat("a", 5000)
	if err := (tmuxMux{}).Paste(context.Background(), "$3:1", text); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(args()), "\n")
	if len(lines) != 2 {
		t.Fatalf("calls = %d", len(lines))
	}
	var sent []byte
	for _, l := range lines {
		f := strings.Fields(l)
		if len(f) < 4 || strings.Join(f[:4], " ") != "send-keys -H -t $3:1" {
			t.Fatalf("argv = %.60q", l)
		}
		for _, h := range f[4:] {
			b, err := hex.DecodeString(h)
			if err != nil || len(b) != 1 {
				t.Fatalf("arg %q", h)
			}
			sent = append(sent, b...)
		}
	}
	if string(sent) != "\x1b[200~"+text+"\x1b[201~" {
		t.Errorf("sent %d bytes", len(sent))
	}
	if strings.Contains(args(), "buffer") {
		t.Errorf("buffer used: %.80q", args())
	}
}

// A piece failing once the start marker may have gone out is followed by
// the end marker, and the piece's error is returned.
func TestPsmuxPasteEndsOnFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake tmux is a shell script")
	}
	usePsmux(t, true)
	dir := t.TempDir()
	logPath, count := filepath.Join(dir, "args"), filepath.Join(dir, "n")
	failAt, sleepAt := filepath.Join(dir, "fail"), filepath.Join(dir, "sleep")
	script := filepath.Join(dir, "tmux")
	// The fake fails its call number failAt and hangs on call sleepAt.
	body := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + logPath + "'\n" +
		"n=$(cat '" + count + "' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '" + count + "'\n" +
		"[ $n -eq \"$(cat '" + failAt + "')\" ] && exit 1\n" +
		"[ $n -eq \"$(cat '" + sleepAt + "')\" ] && exec sleep 5\nexit 0\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	orig, origSocket := tmuxBin, tmuxSocket
	tmuxBin, tmuxSocket = script, ""
	t.Cleanup(func() { tmuxBin, tmuxSocket = orig, origSocket })
	endMarker := "send-keys -H -t $3:1 1b 5b 32 30 31 7e"
	// run pastes text with the fake set to fail/hang at those calls and
	// returns the commands it ran.
	run := func(ctx context.Context, fail, sleep, text string) []string {
		t.Helper()
		os.Remove(logPath)
		os.Remove(count)
		os.WriteFile(failAt, []byte(fail), 0o644)
		os.WriteFile(sleepAt, []byte(sleep), 0o644)
		if err := (tmuxMux{}).Paste(ctx, "$3:1", text); err == nil {
			t.Fatal("no error")
		}
		b, _ := os.ReadFile(logPath)
		return strings.Split(strings.TrimSpace(string(b)), "\n")
	}

	// The second piece fails: the end marker follows.
	if lines := run(context.Background(), "2", "0", strings.Repeat("a", 9000)); len(lines) != 3 || lines[2] != endMarker {
		t.Errorf("second piece failing: calls = %d, last %.60q", len(lines), lines[len(lines)-1])
	}
	// The first piece refused (a missing window, the context alive): nothing
	// more is sent, no start marker went out.
	if lines := run(context.Background(), "1", "0", "x"); len(lines) != 1 {
		t.Errorf("first piece refused: calls = %q", lines)
	}
	// The first piece cut short by the context may have typed the start
	// marker: the end marker follows, on a context of its own.
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if lines := run(ctx, "0", "1", "x"); len(lines) != 2 || lines[1] != endMarker {
		t.Errorf("first piece cut short: calls = %q", lines)
	}
}

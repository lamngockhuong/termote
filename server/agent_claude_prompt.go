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

// screenLine is one row: its text, and the same text with faint (SGR 2)
// characters blanked, so a suggestion Claude paints faint in an empty box is
// told from a draft.
type screenLine struct {
	text  string
	solid string
}

// parseScreen splits a capture into rows, keeping only text and the faint
// attribute. Escapes other than SGR are dropped.
func parseScreen(s string) []screenLine {
	var out []screenLine
	faint := false
	for _, row := range strings.Split(s, "\n") {
		row = strings.TrimSuffix(row, "\r")
		var text, solid strings.Builder
		for i := 0; i < len(row); {
			c := row[i]
			if c == 0x1b {
				i = skipEscape(row, i, &faint)
				continue
			}
			r, size := utf8.DecodeRuneInString(row[i:])
			i += size
			if r < 0x20 || r == 0x7f {
				continue
			}
			text.WriteRune(r)
			if faint && r != ' ' {
				solid.WriteByte(' ')
			} else {
				solid.WriteRune(r)
			}
		}
		out = append(out, screenLine{strings.TrimRight(text.String(), " "), strings.TrimRight(solid.String(), " ")})
	}
	for len(out) > 0 && strings.TrimSpace(out[len(out)-1].text) == "" {
		out = out[:len(out)-1]
	}
	return out
}

// skipEscape consumes the escape at s[i], applying an SGR to faint, and
// returns the index after it.
func skipEscape(s string, i int, faint *bool) int {
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
			applySGR(s[i+2:j], faint)
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

func applySGR(params string, faint *bool) {
	ps := strings.Split(params, ";")
	for k := 0; k < len(ps); k++ {
		n, _ := strconv.Atoi(ps[k]) // "" is 0, a reset
		switch n {
		case 0, 22:
			*faint = false
		case 2:
			*faint = true
		case 38, 48, 58: // extended colour: skip its arguments
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
	Kind     string         `json:"kind"` // permission | select | unsupported
	Title    string         `json:"title"`
	Body     string         `json:"body,omitempty"`
	Options  []PromptOption `json:"options,omitempty"`
}

type PromptOption struct {
	Index  int    `json:"index"` // the number Claude Code shows, and the key sent
	Label  string `json:"label"`
	Detail string `json:"detail,omitempty"`
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
// without "Esc to cancel" is not a dialog this code knows.
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
			return claudeScreen{}
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
	region := lines[top+1 : footer]
	h := sha256.New()
	for _, l := range lines[top:] {
		h.Write([]byte(strings.TrimRight(strings.ReplaceAll(l.text, "❯", " "), " ")))
		h.Write([]byte{'\n'})
	}
	sc := claudeScreen{sig: hex.EncodeToString(h.Sum(nil))}
	sc.prompt = parseDialog(region)
	return sc
}

func parseDialog(region []screenLine) *AgentPrompt {
	type opt struct {
		PromptOption
		row int
	}
	var opts []opt
	first := -1
	wizard, multi := false, false
	for i, l := range region {
		t := strings.TrimSpace(l.text)
		if isQuestionTabs(t) {
			wizard = true
		}
		if m := optionRowRe.FindStringSubmatch(t); m != nil {
			idx, _ := strconv.Atoi(m[1])
			label := strings.TrimSpace(m[2])
			if strings.HasPrefix(label, "[ ]") || strings.HasPrefix(label, "[✔]") || strings.HasPrefix(label, "[x]") {
				multi = true
			}
			if first < 0 {
				first = i
			}
			opts = append(opts, opt{PromptOption{Index: idx, Label: label}, i})
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
	p := &AgentPrompt{Kind: "unsupported"}
	if len(head) > 0 {
		p.Title = strings.TrimSpace(strings.TrimPrefix(head[0], "☐"))
		p.Body, _ = clampText(strings.Join(head[1:], "\n"), claudeMaxBody)
	}
	if wizard || multi || len(opts) == 0 {
		return p
	}
	// Numbering must read 1, 2, ... so a numbered list in the body is not
	// mistaken for the options.
	for i, o := range opts {
		if o.Index != i+1 {
			return p
		}
	}
	question := len(head) > 0 && strings.HasPrefix(head[0], "☐")
	var keep []PromptOption
	for _, o := range opts {
		if question && (strings.HasPrefix(o.Label, "Type something") || o.Label == "Chat about this") {
			continue // free text and chat need the terminal
		}
		o.Detail, _ = clampText(o.Detail, 300)
		keep = append(keep, o.PromptOption)
	}
	if len(keep) == 0 || len(keep) > 9 {
		return p
	}
	switch {
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

// isQuestionTabs: the tab row AskUserQuestion draws above its question
// ("←  ☐ Size  ☐ Drink  ✔ Submit  →").
func isQuestionTabs(t string) bool {
	return (strings.HasPrefix(t, "←") || strings.HasSuffix(t, "→")) && strings.Contains(t, "Submit")
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

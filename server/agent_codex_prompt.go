package main

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Reading a Codex screen: whether its composer is at the bottom and empty,
// and which approval dialog is open. Pure functions over a capture with SGR
// escapes, checked against screens recorded from Codex 0.159.3 and 0.160.0
// on tmux and herdr (testdata/codex/screens). Codex draws no frame: the composer is a "›" row at
// column 0 with the model and shortcut hints under it, and an approval dialog
// replaces the composer with its title, its fields, numbered options (the one
// under the pointer drawn in reverse video) and a footer as the last row.
// Anything not recognised is "not ready", as for Claude Code.

const (
	// codexMaxFooterRows: the rows Codex draws under the composer (a blank
	// row, the model and directory, the shortcut hints).
	codexMaxFooterRows = 4
	// codexMaxBoxRows bounds a wrapped draft in the composer.
	codexMaxBoxRows = 100
	// codexMaxStatusRows: how far above the composer the working line is
	// looked for (it sits over a blank row and the usage warning).
	codexMaxStatusRows = 6
	// codexMaxDialogRows bounds how far up a dialog is searched for.
	codexMaxDialogRows = 80
)

// codexApprovalFooter ends both approval dialogs Codex 0.159.3 and 0.160.0
// draw.
const codexApprovalFooter = "Press enter to confirm or esc to cancel"

// codexApprovalTitles are the approval dialogs this code answers.
var codexApprovalTitles = map[string]bool{
	"Would you like to run the following command?": true,
	"Would you like to make the following edits?":  true,
}

var (
	// codexOptionRe: an option row, "› 1. Yes, proceed (y)" under the
	// pointer, "  2. …" otherwise.
	codexOptionRe = regexp.MustCompile(`^(?:› )?(\d+)\.\s+(.+)$`)
	// codexOptionKeyRe: the key Codex shows at the end of an option.
	codexOptionKeyRe = regexp.MustCompile(`^(.+?)\s+\([a-z]+\)$`)
	// codexWorkingRe: the working line, which may go on with background
	// terminals ("… esc to interrupt) · 1 background terminal running").
	codexWorkingRe = regexp.MustCompile(`^• .*\besc to interrupt\)`)
)

// agentScreenReaders are the agents whose screen is read; nothing is typed
// into another agent.
var agentScreenReaders = map[string]func(string) agentScreen{
	"claude": readClaudeScreen,
	"codex":  readCodexScreen,
}

// readAgentScreen classifies a capture with the reader of agent; an agent
// without one is never ready.
func readAgentScreen(agent, capture string) agentScreen {
	if read, ok := agentScreenReaders[agent]; ok {
		return read(capture)
	}
	return agentScreen{}
}

// readCodexScreen classifies a capture of the Codex TUI.
func readCodexScreen(capture string) agentScreen {
	lines := parseScreen(capture)
	if sc, ok := findCodexApproval(lines); ok {
		return sc
	}
	if sc, ok := findCodexComposer(lines); ok {
		return sc
	}
	return findCodexDialog(lines)
}

// atColumnZero: a row whose text starts at the left edge (a history cell, the
// composer, the option under the pointer), not an indented one.
func atColumnZero(l screenLine) bool {
	return l.text != "" && !strings.HasPrefix(l.text, " ")
}

// findCodexComposer looks for the composer at the bottom: a "›" row at column
// 0 not drawn in reverse video, its wrapped rows, then at most
// codexMaxFooterRows indented or blank rows. The option under a dialog's
// pointer is drawn in reverse video; the composer never is, though some
// terminals (herdr) get it on a background.
func findCodexComposer(lines []screenLine) (agentScreen, bool) {
	n := len(lines)
	for p := n - 1; p >= 0 && p >= n-1-codexMaxFooterRows-codexMaxBoxRows; p-- {
		if !atColumnZero(lines[p]) {
			continue
		}
		if !strings.HasPrefix(lines[p].text, "›") || strings.TrimSpace(lines[p].rv) != "" {
			return agentScreen{}, false
		}
		end := p + 1
		for end < n && end-p <= codexMaxBoxRows && strings.HasPrefix(lines[end].text, "  ") {
			end++
		}
		if n-end > codexMaxFooterRows {
			return agentScreen{}, false
		}
		sc := readCodexComposer(lines[p:end])
		if codexWorking(lines[max(0, p-codexMaxStatusRows):p]) {
			sc = agentScreen{}
		}
		return sc, true
	}
	return agentScreen{}, false
}

// readCodexComposer reads the composer's rows. Codex paints its placeholder
// faint, so a row with nothing solid holds no text.
func readCodexComposer(rows []screenLine) agentScreen {
	var text, solid []string
	for i, r := range rows {
		t, s := r.text, r.solid
		if i == 0 {
			_, size := utf8.DecodeRuneInString(t)
			t, s = t[size:], s[min(size, len(s)):]
		}
		text = append(text, strings.TrimSpace(t))
		solid = append(solid, strings.TrimSpace(s))
	}
	draft := strings.TrimSpace(strings.Join(nonEmpty(text), " "))
	if draft == "" || strings.Join(solid, "") == "" {
		return agentScreen{input: inputEmpty}
	}
	return agentScreen{input: inputDraft, draft: draft}
}

// codexWorking: the rows above the composer show the working line
// ("• Working (2s • esc to interrupt)"); Codex works with the composer
// empty, so the composer alone does not say it waits for a message.
func codexWorking(rows []screenLine) bool {
	for _, l := range rows {
		if codexWorkingRe.MatchString(strings.TrimSpace(l.text)) {
			return true
		}
	}
	return false
}

// codexFooter returns the first row of the approval footer when it ends the
// screen: the last row, or the last two of a narrow pane that wraps it.
func codexFooter(lines []screenLine) int {
	n := len(lines)
	if n == 0 {
		return -1
	}
	if strings.TrimSpace(lines[n-1].text) == codexApprovalFooter {
		return n - 1
	}
	if n >= 2 && atIndent(lines[n-2]) &&
		strings.TrimSpace(lines[n-2].text)+" "+strings.TrimSpace(lines[n-1].text) == codexApprovalFooter {
		return n - 2
	}
	return -1
}

func atIndent(l screenLine) bool { return strings.HasPrefix(l.text, "  ") }

// codexOptions reads the option rows right above row end (blank rows
// skipped): the topmost index of the block and its rows, each option with the
// rows it wraps onto. ok is false when no option block ends there.
func codexOptions(lines []screenLine, end int) (top int, opts [][]screenLine, ok bool) {
	i := end - 1
	for i >= 0 && strings.TrimSpace(lines[i].text) == "" {
		i--
	}
	last := i
	for i >= 0 && i > end-codexMaxDialogRows && strings.TrimSpace(lines[i].text) != "" {
		i--
	}
	top = i + 1
	if top > last {
		return 0, nil, false
	}
	for _, l := range lines[top : last+1] {
		if codexOptionRe.MatchString(strings.TrimSpace(l.text)) {
			opts = append(opts, []screenLine{l})
			continue
		}
		if len(opts) == 0 || !atIndent(l) {
			return 0, nil, false
		}
		opts[len(opts)-1] = append(opts[len(opts)-1], l)
	}
	return top, opts, len(opts) > 0
}

// findCodexApproval recognises an approval dialog whose footer is the last
// row. Its title is the nearest known title above the options with no row at
// column 0 between them. The card is read only, so it never shows less than
// the dialog asks, when another title is in the same stretch (text in the
// command, or a history cell right above), when the dialog's top may be off
// the screen (codexDialogTopShown), or when the body is too long to show
// whole.
func findCodexApproval(lines []screenLine) (agentScreen, bool) {
	footer := codexFooter(lines)
	if footer < 0 {
		return agentScreen{}, false
	}
	optTop, opts, ok := codexOptions(lines, footer)
	if !ok {
		return agentScreen{}, false
	}
	title := -1
	for i := optTop - 1; i >= 0 && i >= footer-codexMaxDialogRows; i-- {
		if atColumnZero(lines[i]) {
			break
		}
		if codexApprovalTitles[strings.TrimSpace(lines[i].text)] {
			title = i
			break
		}
	}
	if title < 0 {
		return findCodexDialog(lines), true
	}
	sc := agentScreen{sig: codexSig(lines[title:])}
	p := &AgentPrompt{Kind: "unsupported", Title: strings.TrimSpace(lines[title].text)}
	sc.prompt = p
	if !codexDialogTopShown(lines, title) {
		return sc, true
	}
	var body []string
	for _, l := range lines[title+1 : optTop] {
		if t := strings.TrimSpace(l.text); t != "" {
			body = append(body, t)
		}
	}
	// Kept whole, never cut: the card shows the whole command it answers.
	p.Body = strings.Join(body, "\n")
	options, ok := codexPromptOptions(opts)
	if !ok {
		return sc, true
	}
	p.Kind = "permission"
	p.Options = options
	p.pointer = codexPointer(opts)
	return sc, true
}

// codexDialogTopShown: the rows above the title, however many, up to a row
// at column 0 (the history cell the dialog follows) hold no other approval
// title, and if the screen's top comes first they are all blank. Rows of
// text reaching the top may be the rest of a command whose real title
// scrolled off, the "title" found being a line of that command.
func codexDialogTopShown(lines []screenLine, title int) bool {
	blank := true
	for i := title - 1; i >= 0; i-- {
		if atColumnZero(lines[i]) {
			return true
		}
		t := strings.TrimSpace(lines[i].text)
		if codexApprovalTitles[t] {
			return false
		}
		blank = blank && t == ""
	}
	return blank
}

// codexPromptOptions reads numbered options 1, 2, ... each ending in the key
// Codex shows for it ("(y)", "(esc)"), which is left off the label. The
// option is picked by its number, as Codex also takes.
func codexPromptOptions(opts [][]screenLine) ([]PromptOption, bool) {
	if len(opts) > 9 {
		return nil, false
	}
	var out []PromptOption
	for i, rows := range opts {
		var parts []string
		for _, r := range rows {
			parts = append(parts, strings.TrimSpace(r.text))
		}
		m := codexOptionRe.FindStringSubmatch(strings.Join(parts, " "))
		idx, _ := strconv.Atoi(m[1])
		k := codexOptionKeyRe.FindStringSubmatch(m[2])
		if idx != i+1 || k == nil {
			return nil, false
		}
		out = append(out, PromptOption{Index: idx, Label: k[1]})
	}
	return out, true
}

// codexPointer is the number of the option drawn under the pointer, 0 when
// none is.
func codexPointer(opts [][]screenLine) int {
	for i, rows := range opts {
		if strings.HasPrefix(rows[0].text, "›") {
			return i + 1
		}
	}
	return 0
}

// findCodexDialog recognises a dialog this code does not answer: an option
// under the pointer near the bottom with no composer under it. The card shows
// the rows right above its options and is read only.
func findCodexDialog(lines []screenLine) agentScreen {
	n := len(lines)
	for i := n - 1; i >= 0 && i >= n-codexMaxDialogRows; i-- {
		l := lines[i]
		if !atColumnZero(l) {
			continue
		}
		if !codexOptionRe.MatchString(l.text) || !strings.HasPrefix(l.text, "›") || strings.TrimSpace(l.rv) == "" {
			return agentScreen{}
		}
		top, _, ok := codexOptions(lines, i+1)
		if !ok {
			return agentScreen{}
		}
		head := top - 1
		for head >= 0 && strings.TrimSpace(lines[head].text) == "" {
			head--
		}
		start := head + 1
		for start > 0 && start > head-codexMaxDialogRows && strings.TrimSpace(lines[start-1].text) != "" && !atColumnZero(lines[start-1]) {
			start--
		}
		p := &AgentPrompt{Kind: "unsupported"}
		var rows []string
		for _, l := range lines[start : head+1] {
			rows = append(rows, strings.TrimSpace(l.text))
		}
		if len(rows) > 0 {
			p.Title = rows[0]
			p.Body = strings.Join(rows[1:], "\n")
		}
		return agentScreen{sig: codexSig(lines[start:]), prompt: p}
	}
	return agentScreen{}
}

// codexSig identifies a dialog by its rows from the title down, without the
// pointer, so moving the pointer is the same dialog.
func codexSig(rows []screenLine) string {
	h := sha256.New()
	for _, l := range rows {
		t := l.text
		if strings.HasPrefix(t, "›") {
			t = " " + strings.TrimPrefix(t, "›")
		}
		h.Write([]byte(strings.TrimRight(t, " ")))
		h.Write([]byte{'\n'})
	}
	return hex.EncodeToString(h.Sum(nil))
}

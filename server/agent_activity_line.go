package main

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The working line an agent draws while a turn runs, read off the same
// capture the prompt route already takes, so the Chat view can show what the
// terminal shows between two transcript writes (the transcript gets a block
// only once it is complete, and never the thinking itself).

// AgentActivity is the agent's working line, as the terminal shows it.
type AgentActivity struct {
	// Label: the spinner's word ("Incubating", "Working", "Starting MCP
	// servers (1/2): codex_apps")
	Label string `json:"label"`
	// Elapsed: seconds the turn has run, when the line says
	Elapsed int `json:"elapsed,omitempty"`
	// Phase: thinking | hooks, or empty for anything else
	Phase string `json:"phase,omitempty"`
	// Detail: the line's own words for the phase ("still thinking",
	// "running Stop hooks… 0/3", "1 background terminal running")
	Detail string `json:"detail,omitempty"`
	// Tokens: the received count as written ("15.8k")
	Tokens string `json:"tokens,omitempty"`
	// Background: set only once the turn is done, what it left running as
	// the line writes it ("2 shells", "1 shell, 1 monitor"); Label is then
	// the turn's past-tense word and Elapsed its length. Also set while the
	// answer is written and the turn only waits on background agents
	// ("1 background agent"; Label "Waiting", no Elapsed): the agent works
	// on nothing Esc would stop
	Background string `json:"background,omitempty"`
	// Retry: the provider refused and the agent tries again (OpenCode)
	Retry *ActivityRetry `json:"retry,omitempty"`
}

// ActivityRetry is the attempt the agent is on, and the provider's error
// message it retries after.
type ActivityRetry struct {
	Attempt int    `json:"attempt"`
	Error   string `json:"error,omitempty"`
}

// activityMaxText bounds every text field of an AgentActivity.
const activityMaxText = 80

// claudeActivityRows is how far above the input box's top border the working
// line is looked for: it sits right on it, or over a blank row and the
// effort row (Claude Code 2.1.312). claudeTodoRows: each indented row with
// text under it (a todo list, one row per item) moves that window up by
// one, this many at most. Only blank and indented rows are passed over: the
// first row at column 0 decides, so an answer's line is never taken for it.
const (
	claudeActivityRows = 4
	claudeTodoRows     = 20
)

// claudeRecapRows: the recap Claude Code (2.1.325) writes under the line
// that ends a turn ("※ recap: …", its wrapped rows indented) is looked for
// this far above the input box's top border; the working line is then looked
// for above it.
const claudeRecapRows = 8

var (
	// claudeActivityRe: "✻ Incubating… (5s · thinking)", or the word alone
	// before the first count. The line that ends a turn ("✻ Sautéed for
	// 1m 14s · done 4:17 AM") has no "…" after the word.
	claudeActivityRe = regexp.MustCompile(`^[·✢*✶✻✽] (\S.*?)…(?: \((.+)\))?$`)
	// claudeDoneRe: "✻ Cogitated for 5m 36s · done 12:26 AM · 2 shells
	// still running", the line that ends a turn while background tasks it
	// started still run (Claude Code 2.1.312). Its items are read apart.
	claudeDoneRe = regexp.MustCompile(`^[·✢*✶✻✽] (\S.*?) for ([0-9hms ]+?)((?: · .+)*)$`)
	// claudeWaitingRe: "✻ Waiting for 1 background agent to finish", the
	// line under an answer while the turn waits on background agents it
	// started (Claude Code 2.1.330): the session file still says busy, and
	// Esc stops nothing.
	claudeWaitingRe = regexp.MustCompile(`^[·✢*✶✻✽] (Waiting) for ([0-9]+ background .+?) to finish$`)
	// codexActivityRe: "• Working (3s • esc to interrupt) · Running hooks"
	codexActivityRe = regexp.MustCompile(`^• (.+?) \(([0-9hms ]+) • esc to interrupt\)(?: · (.+))?$`)
	// durationRe: "0s", "1m 14s", "1h 2m 3s"
	durationRe = regexp.MustCompile(`^(?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s)?$`)
	// tokensRe: "↓ 15.8k tokens"
	tokensRe = regexp.MustCompile(`^[↓↑] ([0-9.]+[kKmM]?) tokens$`)
	// hooksRe: "running Stop hooks… 0/3", "running PostToolUse hook"
	hooksRe = regexp.MustCompile(`^running .+ hooks?\b`)
)

// claudeActivity reads the working line in the rows above the input box's
// top border, nearest first.
func claudeActivity(above []screenLine) *AgentActivity {
	above = aboveRecap(above)
	limit := claudeActivityRows
	for i := len(above) - 1; i >= 0 && i >= len(above)-limit; i-- {
		if !atColumnZero(above[i]) {
			// blank, the right-aligned effort row, or a todo item
			if strings.TrimSpace(above[i].text) != "" && limit < claudeActivityRows+claudeTodoRows {
				limit++
			}
			continue
		}
		line := strings.TrimRight(above[i].text, " ")
		m := claudeActivityRe.FindStringSubmatch(line)
		if m == nil {
			if w := claudeWaitingRe.FindStringSubmatch(line); w != nil {
				return &AgentActivity{Label: w[1], Background: clipActivity(w[2])}
			}
			return claudeDone(line)
		}
		a := &AgentActivity{Label: clipActivity(m[1])}
		if m[2] != "" {
			for item := range strings.SplitSeq(m[2], " · ") {
				readActivityItem(a, item)
			}
		}
		return a
	}
	return nil
}

// aboveRecap drops a recap at the bottom of the rows above the input box,
// with the rows under it: the nearest row at column 0, when it starts the
// recap.
func aboveRecap(above []screenLine) []screenLine {
	for i := len(above) - 1; i >= 0 && i >= len(above)-claudeRecapRows; i-- {
		if !atColumnZero(above[i]) {
			continue
		}
		if strings.HasPrefix(above[i].text, "※ recap") {
			return above[:i]
		}
		break
	}
	return above
}

// claudeDone reads the line that ends a turn, but only while it says what
// the turn left running: a turn done with nothing left is no activity. What
// is left starts with its count ("2 shells"), which sets it apart from an
// answer's own words.
func claudeDone(line string) *AgentActivity {
	m := claudeDoneRe.FindStringSubmatch(line)
	if m == nil {
		return nil
	}
	elapsed, ok := parseElapsed(strings.TrimSpace(m[2]))
	if !ok {
		return nil
	}
	for item := range strings.SplitSeq(strings.TrimPrefix(m[3], " · "), " · ") {
		if what, ok := strings.CutSuffix(strings.TrimSpace(item), " still running"); ok && what != "" && what[0] >= '0' && what[0] <= '9' {
			return &AgentActivity{Label: clipActivity(m[1]), Elapsed: elapsed, Background: clipActivity(what)}
		}
	}
	return nil
}

// readActivityItem files one " · "-separated item of a working line.
func readActivityItem(a *AgentActivity, item string) {
	item = strings.TrimSpace(item)
	if s, ok := parseElapsed(item); ok {
		a.Elapsed = s
		return
	}
	if m := tokensRe.FindStringSubmatch(item); m != nil {
		a.Tokens = m[1]
		return
	}
	// Not what the agent does now: how long it thought before ("thought
	// for 1s", while it writes the answer), and a key the Chat view has no
	// way to press
	if strings.HasPrefix(item, "thought for ") || item == "esc to interrupt" {
		return
	}
	phase := ""
	switch {
	case hooksRe.MatchString(item) || strings.EqualFold(item, "running hooks"):
		phase = "hooks"
	case strings.Contains(item, "thinking") || strings.Contains(item, "thought"):
		phase = "thinking"
	}
	// The first item that names a phase names it: hooks run after the
	// thinking that a later item may still mention
	if a.Phase == "" && phase != "" {
		a.Phase, a.Detail = phase, clipActivity(item)
	} else if a.Detail == "" && a.Phase == "" {
		a.Detail = clipActivity(item)
	}
}

// codexActivityOf reads Codex's working line; nil when the line has another
// shape than the one parsed, which still counts as working.
func codexActivityOf(line string) *AgentActivity {
	m := codexActivityRe.FindStringSubmatch(line)
	if m == nil {
		return nil
	}
	a := &AgentActivity{Label: clipActivity(m[1])}
	if s, ok := parseElapsed(strings.TrimSpace(m[2])); ok {
		a.Elapsed = s
	}
	if m[3] != "" {
		for item := range strings.SplitSeq(m[3], " · ") {
			readActivityItem(a, item)
		}
	}
	return a
}

// parseElapsed reads "1h 2m 3s", "1m 14s" or "5s" as seconds.
func parseElapsed(s string) (int, bool) {
	if s == "" {
		return 0, false
	}
	m := durationRe.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	total := 0
	for i, unit := range []int{3600, 60, 1} {
		if m[i+1] != "" {
			// A count past a year is not a turn's time (and would overflow)
			n, err := strconv.Atoi(m[i+1])
			if err != nil || n > 1<<20 {
				return 0, false
			}
			total += n * unit
		}
	}
	return total, true
}

// clipActivity drops control characters and keeps at most activityMaxText
// runes.
func clipActivity(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.TrimSpace(s))
	if utf8.RuneCountInString(s) <= activityMaxText {
		return s
	}
	return string([]rune(s)[:activityMaxText-1]) + "…"
}

package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// How full an agent's context is, for the overview. Claude Code's transcript
// records the tokens of each request and the model they went to, never the
// window: claudeWindowOfModel tells it from the model id. The id comes from
// the transcript's last model row (agent_claude_model.go), which carries the
// [1m] of a 1M opt-in, else from --model in argv, else from the request's
// own row. Codex records both in its token_count rows.

const (
	claudeWindowDefault int64 = 200_000
	claudeWindowLarge   int64 = 1_000_000
	// codexBaselineTokens is what Codex counts as always in the context
	// (system prompt, tool instructions) and leaves out of its "% context
	// left": BASELINE_TOKENS of TokenUsage::percent_of_context_window_remaining
	// in codex-rs/protocol/src/protocol.rs, checked against Codex 0.162.1.
	codexBaselineTokens int64 = 12_000
)

// claudeWindowFromArgs is the context window of the --model Claude Code's
// command line chose, 0 when there is none or it is an alias ("opus") whose
// model argv does not tell.
func claudeWindowFromArgs(args []string) int64 {
	for i, a := range args {
		if a == "--" {
			return 0
		}
		var model string
		switch {
		case a == "--model":
			if i+1 < len(args) {
				model = args[i+1]
			}
		case strings.HasPrefix(a, "--model="):
			model = strings.TrimPrefix(a, "--model=")
		default:
			continue
		}
		model = strings.TrimSpace(model)
		if strings.HasPrefix(model, "-") {
			return 0
		}
		w, _ := claudeWindowOfModel(model)
		return w
	}
	return 0
}

// claudeModelRe finds the family and version in a Claude model id, also
// inside a provider's spelling ("us.anthropic.claude-opus-4-1-20250805-v1:0");
// a date after the version is not a minor version.
var claudeModelRe = regexp.MustCompile(`claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})\b)?`)

// claudeWindowOfModel is the context window of a Claude model id, and
// whether the id tells it. As Claude Code's model table has it (2.1.300,
// context.native_1m): a [1m] model is 1M; so is every model from the 5
// family on, and Opus from 4.7; any other is 200k. An alias or a name it
// cannot read tells nothing.
func claudeWindowOfModel(model string) (int64, bool) {
	m := strings.ToLower(strings.TrimSpace(model))
	if strings.HasSuffix(m, "[1m]") {
		return claudeWindowLarge, true
	}
	g := claudeModelRe.FindStringSubmatch(m)
	if g == nil {
		return 0, false
	}
	major, _ := strconv.Atoi(g[2])
	minor, _ := strconv.Atoi(g[3])
	if major >= 5 || g[1] == "opus" && major == 4 && minor >= 7 {
		return claudeWindowLarge, true
	}
	return claudeWindowDefault, true
}

// contextShare is the window an agent's context goes into, the share of it
// used in percent (one decimal) and whether the window is known rather than
// assumed. sessionWindow is the Claude session's window (0: unknown), model
// the model the request went to, entryWindow what a Codex row names. window
// 0 means no share can be told.
func contextShare(agent string, tokens int64, model string, sessionWindow, entryWindow int64) (window int64, pct float64, exact bool) {
	if agent == "codex" {
		if entryWindow <= 0 {
			return 0, 0, false
		}
		// A window no larger than the baseline: Codex shows 0% left.
		if entryWindow <= codexBaselineTokens {
			return entryWindow, 100, true
		}
		// Codex leaves the baseline out of both sides, so its first
		// prompt shows 100% left.
		used := max(tokens-codexBaselineTokens, 0)
		return entryWindow, sharePercent(used, entryWindow-codexBaselineTokens), true
	}
	window, exact = sessionWindow, sessionWindow > 0
	if !exact {
		// The request's model never carries the [1m] of an opt-in: it
		// proves a 1M window of its own, never a 200k one.
		if w, ok := claudeWindowOfModel(model); ok && w == claudeWindowLarge {
			window, exact = w, true
		} else {
			window = claudeWindowDefault
		}
	}
	// Only the 1M window holds more than 200k: an opt-in nothing showed
	// is proven by the tokens.
	if tokens > window {
		window, exact = claudeWindowLarge, true
	}
	return window, sharePercent(tokens, window), exact
}

// sharePercent is used/total in percent, one decimal, at most 100.
func sharePercent(used, total int64) float64 {
	return min(math.Round(float64(used)/float64(total)*1000)/10, 100)
}

// codexAccountHome is the CODEX_HOME whose account a Codex session uses: the
// process's own, else the server's CODEX_HOME, else ~/.codex.
func codexAccountHome(s AgentSession, getenv func(string) string, home string) string {
	if s.CodexHome != "" {
		return s.CodexHome
	}
	if h := getenv("CODEX_HOME"); h != "" {
		return h
	}
	return filepath.Join(home, ".codex")
}

// accountKey names an account in the overview without its path: a keyed
// hash, so a client can group panes by it but cannot test a guessed path.
func accountKey(codexHome string) string {
	h := hmac.New(sha256.New, agentCursorKey)
	h.Write([]byte("codex-home\x00" + filepath.Clean(codexHome)))
	return hex.EncodeToString(h.Sum(nil))[:12]
}

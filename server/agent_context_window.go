package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"path/filepath"
	"strings"
)

// How full an agent's context is, for the overview. Claude Code's transcript
// records the tokens of each request but never the size of the window they
// went into: 200k unless the model was started with the 1M context
// ("--model opus[1m]"), which only its argv shows. Codex records both in its
// token_count rows.

const (
	claudeWindowDefault int64 = 200_000
	claudeWindowLarge   int64 = 1_000_000
	// codexBaselineTokens is what Codex counts as always in the context
	// (system prompt, tool instructions) and leaves out of its "% context
	// left": BASELINE_TOKENS of TokenUsage::percent_of_context_window_remaining
	// in codex-rs/protocol/src/protocol.rs, checked against Codex 0.162.1.
	codexBaselineTokens int64 = 12_000
)

// claudeWindowFromArgs is the context window Claude Code's command line
// chose: 1M for a --model ending in [1m], 200k for any other --model, 0 when
// there is no --model (the model then comes from settings or /model, which
// argv does not show).
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
		switch {
		case model == "" || strings.HasPrefix(model, "-"):
			return 0
		case strings.HasSuffix(strings.ToLower(model), "[1m]"):
			return claudeWindowLarge
		default:
			return claudeWindowDefault
		}
	}
	return 0
}

// contextShare is the window an agent's context goes into, the share of it
// used in percent (one decimal) and whether the window is known rather than
// assumed. sessionWindow is what Claude Code's argv chose (0: unknown),
// entryWindow what a Codex row names. window 0 means no share can be told.
func contextShare(agent string, tokens, sessionWindow, entryWindow int64) (window int64, pct float64, exact bool) {
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
		window = claudeWindowDefault
	}
	// Only the 1M window holds more than 200k: a /model switch after start
	// is not in argv, yet the tokens prove it.
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

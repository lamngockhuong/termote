package main

import (
	"strings"
)

// List API prices, for the cost estimates of the overview and the history.
// Estimates only: a subscription is not billed by the token, and priority
// or regional processing, batch and fast modes change the rate.
//
// Sources, read on pricesUpdated:
//   - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
//   - OpenAI: https://developers.openai.com/api/docs/pricing (standard tier)
//
// A model matches its exact id first, else the longest prefix: a dated or
// suffixed id ("claude-opus-4-1-20250805") takes its family's price. A
// model none matches is shown with its tokens only.

const pricesUpdated = "2026-11-15"

// modelPrice is USD per 1M tokens. A request whose whole input (cache
// included) is more than longAbove tokens pays the long* prices for all of
// it. cacheWrite1h 0 is cacheWrite5m's price; OpenAI's cache write (30
// minutes) is cacheWrite5m, and a model whose cache writes are not billed
// apart lists its input price there.
type modelPrice struct {
	match                      string
	exact                      bool
	input, cacheRead, output   float64
	cacheWrite5m, cacheWrite1h float64
	longAbove                  int64
	long                       *modelPrice
}

// claude makes an Anthropic price: cache reads at read, writes at 1.25x
// (5 minutes) and 2x (1 hour) the input.
func claude(match string, input, read, output float64) modelPrice {
	return modelPrice{match: match, input: input, cacheRead: read, output: output,
		cacheWrite5m: input * 1.25, cacheWrite1h: input * 2}
}

// openai makes an OpenAI price; write 0 is a model whose cache writes are
// billed as input.
func openai(match string, input, read, write, output float64) modelPrice {
	if write == 0 {
		write = input
	}
	return modelPrice{match: match, input: input, cacheRead: read, cacheWrite5m: write, output: output}
}

func withLong(p modelPrice, above int64, long modelPrice) modelPrice {
	p.longAbove, p.long = above, &long
	return p
}

// openaiLong is the input tokens above which OpenAI's long context prices
// apply.
const openaiLong = 272_000

var modelPrices = []modelPrice{
	// Anthropic. No long context surcharge from the 4.6 models on, except
	// Haiku 5.5 above 100k.
	claude("claude-fable-5-2", 8, 0.20, 40),
	claude("claude-mythos-5-2", 8, 0.20, 40),
	claude("claude-fable-5-1", 10, 0.25, 50),
	claude("claude-mythos-5-1", 10, 0.25, 50),
	claude("claude-fable-5", 10, 1, 50),
	claude("claude-mythos-5", 10, 1, 50),
	claude("claude-opus-5-5", 4, 0.20, 20),
	claude("claude-opus-5", 5, 0.50, 25),
	claude("claude-opus-4-8", 5, 0.50, 25),
	claude("claude-opus-4-7", 5, 0.50, 25),
	claude("claude-opus-4-6", 5, 0.50, 25),
	claude("claude-opus-4-5", 5, 0.50, 25),
	claude("claude-opus-4-1", 15, 1.50, 75),
	claude("claude-opus-4", 15, 1.50, 75),
	claude("claude-sonnet-5-5", 2, 0.10, 10),
	claude("claude-sonnet-5", 2, 0.20, 10),
	claude("claude-sonnet-4-6", 3, 0.30, 15),
	claude("claude-sonnet-4-5", 3, 0.30, 15),
	claude("claude-sonnet-4", 3, 0.30, 15),
	withLong(claude("claude-haiku-5-5", 0.10, 0.01, 0.50), 100_000, claude("", 0.50, 0.05, 2.50)),
	claude("claude-haiku-4-5", 1, 0.10, 5),
	// OpenAI.
	openai("gpt-6-astra", 10, 1, 12.50, 50),
	openai("gpt-6.1-sol", 2, 0.10, 2.50, 10),
	openai("gpt-6.1-terra", 1, 0.05, 1.25, 5),
	openai("gpt-6-sol", 2, 0.20, 2.50, 10),
	withLong(openai("gpt-6-luna", 0.10, 0.01, 0.125, 0.50), openaiLong, openai("", 0.20, 0.02, 0.25, 0.75)),
	openai("gpt-5.6-sol", 4, 0.40, 5, 20),
	withLong(openai("gpt-5.6-terra", 2, 0.20, 2.50, 12), openaiLong, openai("", 4, 0.40, 5, 18)),
	withLong(openai("gpt-5.6-luna", 0.20, 0.02, 0.25, 1.20), openaiLong, openai("", 0.40, 0.04, 0.50, 1.80)),
	withLong(openai("gpt-5.5", 5, 0.50, 0, 30), openaiLong, openai("", 10, 1, 0, 45)),
	{match: "gpt-5.5-pro", input: 30, cacheRead: 30, cacheWrite5m: 30, output: 180},
	openai("gpt-5.4-mini", 0.75, 0.075, 0, 4.50),
	openai("gpt-5.4-nano", 0.20, 0.02, 0, 1.25),
	openai("gpt-5.4", 2.50, 0.25, 0, 15),
	openai("gpt-5.3-codex", 1.75, 0.175, 0, 14),
	openai("gpt-5.2", 1.75, 0.175, 0, 14),
	openai("gpt-5.1", 1.25, 0.125, 0, 10),
	openai("gpt-5-mini", 0.25, 0.025, 0, 2),
	{match: "gpt-5", exact: true, input: 1.25, cacheRead: 0.125, cacheWrite5m: 1.25, output: 10},
}

// priceOf is model's price, and whether there is one.
func priceOf(model string) (modelPrice, bool) {
	m := strings.ToLower(strings.TrimSpace(model))
	// Claude Code writes a 1M opt-in as "[1m]" on the model row; the
	// price is the model's.
	m = strings.TrimSuffix(m, "[1m]")
	// A provider's spelling: "us.anthropic.claude-opus-4-1-20250805-v1:0".
	if i := strings.Index(m, "claude-"); i > 0 {
		m = m[i:]
	}
	var best *modelPrice
	for i := range modelPrices {
		p := &modelPrices[i]
		if m == p.match {
			return *p, true
		}
		if !p.exact && priceSuffixOK(m, p.match) && (best == nil || len(p.match) > len(best.match)) {
			best = p
		}
	}
	if best == nil {
		return modelPrice{}, false
	}
	return *best, true
}

// priceSuffixOK: m is match followed by a date ("-20250805",
// "-2026-01-01", then anything, as a provider's "-v1:0") or a provider's
// "@"/":" suffix: the same model. Anything else is another one: a version
// ("claude-opus-5-5" never takes "claude-opus-5"'s price) or a variant
// ("gpt-5.1-codex-mini" not "gpt-5.1"'s); a variant priced is listed by its
// own id, the longer prefix.
func priceSuffixOK(m, match string) bool {
	rest, ok := strings.CutPrefix(m, match)
	if !ok || rest == "" {
		return ok
	}
	if rest[0] == '@' || rest[0] == ':' {
		return true
	}
	if rest[0] != '-' {
		return false
	}
	d := rest[1:]
	n := 0
	for n < len(d) && d[n] >= '0' && d[n] <= '9' {
		n++
	}
	return n >= 4
}

// costOf is r's cost in USD at p.
func costOf(p modelPrice, r usageRecord) float64 {
	if p.long != nil && r.input+r.cacheRead+r.cacheWrite5m+r.cacheWrite1h > p.longAbove {
		p = *p.long
	}
	w1h := p.cacheWrite1h
	if w1h == 0 {
		w1h = p.cacheWrite5m
	}
	return (float64(r.input)*p.input + float64(r.cacheRead)*p.cacheRead + float64(r.cacheWrite5m)*p.cacheWrite5m +
		float64(r.cacheWrite1h)*w1h + float64(r.output)*p.output) / 1e6
}

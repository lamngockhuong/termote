package main

import (
	"math"
	"testing"
	"time"
)

func TestPriceOf(t *testing.T) {
	for model, want := range map[string]float64{ // the input price
		"claude-opus-5-5":                            4,
		"claude-opus-5":                              5,
		"claude-opus-5-20260301":                     5,
		"claude-opus-5-5[1m]":                        4,
		"Claude-Sonnet-5-5":                          2,
		"claude-opus-4-1-20250805":                   15,
		"us.anthropic.claude-opus-4-1-20250805-v1:0": 15,
		"claude-haiku-5-5":                           0.10,
		"claude-fable-5-2":                           8,
		"gpt-5.6-terra":                              2,
		"gpt-5.5":                                    5,
		"gpt-5.5-pro":                                30,
		"gpt-5.5-pro-2026-01-01":                     30,
		"gpt-5":                                      1.25,
		"claude-opus-5@20260301":                     5,
	} {
		p, ok := priceOf(model)
		if !ok || p.input != want {
			t.Errorf("priceOf(%q) = %v %v, want input %v", model, p.input, ok, want)
		}
	}
	// Another version or a model none lists: no price.
	for _, model := range []string{"claude-opus-5-6", "claude-opus-5-55", "gpt-5.6", "gpt-5-codex", "gpt-5.1-codex-mini", "claude-opus-5-beta", "gpt-6", "sonnet", "", "claude-opus-5x"} {
		if p, ok := priceOf(model); ok {
			t.Errorf("priceOf(%q) = %+v, want none", model, p)
		}
	}
}

func TestModelPricesTable(t *testing.T) {
	seen := map[string]bool{}
	for _, p := range modelPrices {
		if p.match == "" || seen[p.match] {
			t.Errorf("match %q is empty or listed twice", p.match)
		}
		seen[p.match] = true
		if p.input <= 0 || p.output <= 0 || p.cacheRead <= 0 || p.cacheWrite5m <= 0 {
			t.Errorf("%s has a price of 0: %+v", p.match, p)
		}
		if p.long != nil && (p.longAbove <= 0 || p.long.input < p.input) {
			t.Errorf("%s long context price = %+v", p.match, p.long)
		}
	}
	// Every Claude family the context windows know has a price from its 5
	// models on.
	for _, family := range []string{"opus", "sonnet", "haiku", "fable", "mythos"} {
		if _, ok := priceOf("claude-" + family + "-5"); !ok && family != "haiku" {
			t.Errorf("claude-%s-5 has no price", family)
		}
		if _, ok := priceOf("claude-" + family + "-5-5"); !ok && family != "fable" && family != "mythos" {
			t.Errorf("claude-%s-5-5 has no price", family)
		}
	}
	if pricesUpdated == "" {
		t.Error("no pricesUpdated")
	}
	if _, err := time.Parse(time.DateOnly, pricesUpdated); err != nil {
		t.Errorf("pricesUpdated = %q: %v", pricesUpdated, err)
	}
}

func TestCostOf(t *testing.T) {
	near := func(a, b float64) bool { return math.Abs(a-b) < 1e-9 }
	opus, _ := priceOf("claude-opus-5-5")
	// 5 minute and 1 hour cache writes at their own prices.
	r := usageRecord{input: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000, output: 1_000_000}
	if c := costOf(opus, r); !near(c, 4+0.20+5+8+20) {
		t.Errorf("opus = %v", c)
	}
	// An OpenAI cache write has one price.
	terra, _ := priceOf("gpt-5.6-terra")
	if c := costOf(terra, usageRecord{input: 10_000, cacheWrite5m: 10_000, cacheWrite1h: 10_000, output: 10_000}); !near(c, 0.02+0.025+0.025+0.12) {
		t.Errorf("terra = %v", c)
	}
	// Above the long context threshold, every token of the request costs
	// the long price.
	haiku, _ := priceOf("claude-haiku-5-5")
	if c := costOf(haiku, usageRecord{input: 100_000, output: 1000}); !near(c, 0.01+0.0005) {
		t.Errorf("haiku at 100k = %v", c)
	}
	if c := costOf(haiku, usageRecord{input: 50_000, cacheRead: 50_001, output: 1000}); !near(c, 0.025+0.00250005+0.0025) {
		t.Errorf("haiku above 100k = %v", c)
	}
}

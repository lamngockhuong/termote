package main

import (
	"sort"
	"strings"
)

// Match tiers of a find query, best first. A query holding a '/' is only
// matched against the whole path.
const (
	findTierNone = iota
	findTierBaseSubstring
	findTierBaseSubsequence
	findTierPathSubstring
	findTierPathSubsequence
)

// findMatchTier ranks path (lower case, '/'-separated) against q (lower
// case): the basename holding q, the basename holding q's characters in
// order, then the same on the whole path. findTierNone: no match.
func findMatchTier(path, q string) int {
	if !strings.Contains(q, "/") {
		base := path[strings.LastIndexByte(path, '/')+1:]
		if strings.Contains(base, q) {
			return findTierBaseSubstring
		}
		if isSubsequence(base, q) {
			return findTierBaseSubsequence
		}
	}
	if strings.Contains(path, q) {
		return findTierPathSubstring
	}
	if isSubsequence(path, q) {
		return findTierPathSubsequence
	}
	return findTierNone
}

// isSubsequence reports whether q's bytes appear in s in order.
func isSubsequence(s, q string) bool {
	i := 0
	for j := 0; j < len(s) && i < len(q); j++ {
		if s[j] == q[i] {
			i++
		}
	}
	return i == len(q)
}

// rankFind returns the entries of lists matching q, best first: by tier,
// then the shorter path, then the path in byte order. Only matches are
// sorted, never the whole list.
func rankFind(q string, lists ...[]findEntry) []findEntry {
	q = strings.ToLower(q)
	type hit struct {
		e    findEntry
		tier int
	}
	var hits []hit
	for _, list := range lists {
		for _, e := range list {
			if tier := findMatchTier(e.lower, q); tier != findTierNone {
				hits = append(hits, hit{e, tier})
			}
		}
	}
	sort.Slice(hits, func(i, j int) bool {
		a, b := hits[i], hits[j]
		if a.tier != b.tier {
			return a.tier < b.tier
		}
		if len(a.e.rel) != len(b.e.rel) {
			return len(a.e.rel) < len(b.e.rel)
		}
		return a.e.rel < b.e.rel
	})
	out := make([]findEntry, len(hits))
	for i, h := range hits {
		out[i] = h.e
	}
	return out
}

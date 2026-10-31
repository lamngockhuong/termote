package main

import (
	"net/http"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

// maxPaneName caps a pane's name, in bytes.
const maxPaneName = 64

// errInvalidPaneName: a pane name validPaneName refuses.
var errInvalidPaneName = &codedError{"invalid_name", "invalid name", http.StatusBadRequest}

// validPaneName accepts a name a pane can be given on every backend: "" (no
// name), or up to maxPaneName bytes of valid UTF-8 without a control or
// format character (C0, C1, bidi, zero-width), a leading '-' (an option to
// a CLI) or a trailing ';' (a command separator to tmux and Zellij).
func validPaneName(name string) bool {
	if name == "" {
		return true
	}
	if len(name) > maxPaneName || !utf8.ValidString(name) || strings.HasPrefix(name, "-") || strings.HasSuffix(name, ";") {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return false
		}
	}
	return true
}

// cleanPaneName is a pane name as a backend reports it, fit to show: another
// process can set one (Herdr's socket, a tmux option), so it is stripped of
// unsafe runes, trimmed (a blank name is none) and capped like a name
// termote sets.
func cleanPaneName(name string) string {
	return capBytes(strings.TrimSpace(stripUnsafeRunes(name)), maxPaneName)
}

const (
	// maxMetaTokens caps the metadata tokens shown for one pane or group.
	maxMetaTokens = 8
	// maxMetaValueRunes caps a metadata token's value, in runes.
	maxMetaValueRunes = 64
)

// metaKeyRe is a metadata token's key as Herdr's schema allows it.
var metaKeyRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

// MetaToken is one metadata token a Herdr plugin or tool reported: plain
// text, shown as such.
type MetaToken struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// cleanMeta turns reported tokens into what the snapshot carries: any
// process that reaches Herdr's socket can report them, so keys outside
// Herdr's schema are dropped, values are stripped of unsafe runes and cut to
// maxMetaValueRunes, empty ones dropped, and at most maxMetaTokens kept, in
// key order so a snapshot does not reorder them between polls.
func cleanMeta(tokens map[string]string) []MetaToken {
	keys := make([]string, 0, len(tokens))
	for k := range tokens {
		if metaKeyRe.MatchString(k) {
			keys = append(keys, k)
		}
	}
	slices.Sort(keys)
	var out []MetaToken
	for _, k := range keys {
		v := strings.TrimSpace(stripUnsafeRunes(tokens[k]))
		if r := []rune(v); len(r) > maxMetaValueRunes {
			v = string(r[:maxMetaValueRunes])
		}
		if v == "" {
			continue
		}
		if out = append(out, MetaToken{Key: k, Value: v}); len(out) == maxMetaTokens {
			break
		}
	}
	return out
}

// withoutMeta is s with no metadata: tokens come from any process that
// reaches Herdr's socket, and a view-only client is a device paired from
// afar. s is copied, never changed: a backend can hand out its cached
// snapshot.
func withoutMeta(s Snapshot) Snapshot {
	groups := slices.Clone(s.Groups)
	for gi := range groups {
		g := &groups[gi]
		g.Meta = nil
		g.Tabs = slices.Clone(g.Tabs)
		for ti := range g.Tabs {
			t := &g.Tabs[ti]
			t.Panes = slices.Clone(t.Panes)
			for pi := range t.Panes {
				t.Panes[pi].Meta = nil
			}
		}
	}
	s.Groups = groups
	return s
}

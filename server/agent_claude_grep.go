package main

import (
	"path/filepath"
	"slices"
	"strings"
)

// grepShowsSensitive reports whether a Claude Code Grep call whose path names
// a directory still prints lines of a file isSensitive names: its output
// mode shows lines ("content"; the default lists file names, "count" counts),
// and its path is a sensitive directory or inside one, its glob names such
// a file (globMaySelectSensitive), or its type is one whose globs do.
// Grep's pattern matches lines, never file names, so it selects no file.
func grepShowsSensitive(in map[string]any) bool {
	if jsonStr(in["output_mode"]) != "content" {
		return false
	}
	if p := jsonStr(in["path"]); p != "" && isSensitive(filepath.Join(p, "x")) {
		return true
	}
	if g := jsonStr(in["glob"]); g != "" && globMaySelectSensitive(g) {
		return true
	}
	return slices.Contains(sensitiveGrepTypes, strings.ToLower(strings.TrimSpace(jsonStr(in["type"]))))
}

// sensitiveGrepTypes are the ripgrep file types (rg 14.1.1 --type-list) one
// of whose globs globMaySelectSensitive takes as naming a sensitive file;
// TestSensitiveGrepTypes checks the list against the rg on PATH.
var sensitiveGrepTypes = []string{"tf"}

// globMaxAlternatives bounds a glob's brace expansion; a glob with more
// alternatives is taken as able to select anything.
const globMaxAlternatives = 256

// globMaySelectSensitive reports whether a ripgrep glob (several split by
// whitespace or a comma outside braces, as a caller may pass them) names a
// file isSensitive names: the name it spells out, each '*' or "**" matching
// nothing, is one (".env*", "*.pem", "secrets.{json,yml}", ".ssh/**"). Read
// as every name it can match, "*.go" would be too (".env.go",
// "secrets.go"), while a Grep with no glob at all searches every one of
// them. A glob led by '!' excludes files and selects none; one that cannot
// be read counts as naming one.
func globMaySelectSensitive(glob string) bool {
	for _, g := range splitGlobs(strings.ToLower(glob)) {
		if strings.HasPrefix(g, "!") {
			continue
		}
		alts, ok := expandBraces(g)
		if !ok {
			return true
		}
		for _, alt := range alts {
			if named, ok := globNamesSensitive(alt); named || !ok {
				return true
			}
		}
	}
	return false
}

// globNamesSensitive is globMaySelectSensitive for one glob without braces:
// its last component, without its stars, can be a name sensitiveNames (or
// a temporary file's prefix) matches, or its directories, without their
// stars, hold one of sensitiveDirs.
func globNamesSensitive(g string) (named, ok bool) {
	comps := strings.Split(g, "/")
	base := comps[len(comps)-1]
	var dirs []string
	for _, c := range comps[:len(comps)-1] {
		if c = strings.ReplaceAll(c, "*", ""); c != "" {
			dirs = append(dirs, c)
		}
	}
	if len(dirs) > 0 && isSensitive("/"+strings.Join(dirs, "/")+"/x") {
		return true, true
	}
	bt, ok := globTokens(base)
	if !ok {
		return false, false
	}
	bt = slices.DeleteFunc(bt, func(t globTok) bool { return t.star })
	for _, n := range sensitiveFilePatterns() {
		if globsMeet(bt, n) {
			return true, true
		}
	}
	return false, true
}

// sensitiveFilePatterns returns sensitiveNames and the temporary files'
// prefixes isSensitive refuses, as tokens.
func sensitiveFilePatterns() [][]globTok {
	pats := append(slices.Clone(sensitiveNames), editTempPrefix+"*", renameTempPrefix+"*", uploadTempPrefix+"*")
	out := make([][]globTok, 0, len(pats))
	for _, p := range pats {
		t, _ := globTokens(strings.ToLower(p))
		out = append(out, t)
	}
	return out
}

// splitGlobs splits s at whitespace and at commas outside braces.
func splitGlobs(s string) []string {
	var out []string
	depth, start := 0, 0
	flush := func(end int) {
		if end > start {
			out = append(out, s[start:end])
		}
	}
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c == '\\':
			i++
		case c == '{':
			depth++
		case c == '}' && depth > 0:
			depth--
		case c == ',' && depth == 0, c == ' ', c == '\t', c == '\n', c == '\r':
			flush(i)
			start = i + 1
		}
	}
	flush(len(s))
	return out
}

// expandBraces expands every {a,b} in g, nested ones included; ok is false
// for an unbalanced brace or more than globMaxAlternatives alternatives.
func expandBraces(g string) ([]string, bool) {
	open := -1
	for i := 0; i < len(g); i++ {
		switch g[i] {
		case '\\':
			i++
		case '{':
			open = i
		case '}':
			if open < 0 {
				return nil, false
			}
			var out []string
			for _, part := range splitTopCommas(g[open+1 : i]) {
				more, ok := expandBraces(g[:open] + part + g[i+1:])
				if !ok || len(out)+len(more) > globMaxAlternatives {
					return nil, false
				}
				out = append(out, more...)
			}
			return out, true
		}
	}
	if open >= 0 {
		return nil, false
	}
	return []string{g}, true
}

// splitTopCommas splits the inside of an innermost brace pair at commas.
func splitTopCommas(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '\\':
			i++
		case ',':
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	return append(out, s[start:])
}

// globTok is one token of a glob component: a run of any characters (star),
// any one character (any), a character class, or a literal character.
type globTok struct {
	star, any, class bool
	negated          bool
	lit              rune
	ranges           [][2]rune
}

// meets reports whether one character can match both single tokens; two
// classes are taken as able to.
func (a globTok) meets(b globTok) bool {
	switch {
	case a.any || b.any || a.class && b.class:
		return true
	case a.class:
		return a.has(b.lit)
	case b.class:
		return b.has(a.lit)
	}
	return a.lit == b.lit
}

func (a globTok) has(r rune) bool {
	in := false
	for _, rg := range a.ranges {
		if rg[0] <= r && r <= rg[1] {
			in = true
			break
		}
	}
	return in != a.negated
}

// globTokens reads one glob component ("**" and "*" both a star); ok is
// false for an unclosed class or a trailing backslash.
func globTokens(s string) ([]globTok, bool) {
	rs := []rune(s)
	var out []globTok
	for i := 0; i < len(rs); i++ {
		switch r := rs[i]; r {
		case '*':
			if len(out) == 0 || !out[len(out)-1].star {
				out = append(out, globTok{star: true})
			}
		case '?':
			out = append(out, globTok{any: true})
		case '\\':
			if i+1 >= len(rs) {
				return nil, false
			}
			i++
			out = append(out, globTok{lit: rs[i]})
		case '[':
			t := globTok{class: true}
			j := i + 1
			if j < len(rs) && (rs[j] == '!' || rs[j] == '^') {
				t.negated = true
				j++
			}
			for first := true; ; first = false {
				if j >= len(rs) {
					return nil, false
				}
				if rs[j] == ']' && !first {
					break
				}
				lo := rs[j]
				if j+2 < len(rs) && rs[j+1] == '-' && rs[j+2] != ']' {
					t.ranges = append(t.ranges, [2]rune{lo, rs[j+2]})
					j += 3
				} else {
					t.ranges = append(t.ranges, [2]rune{lo, lo})
					j++
				}
			}
			out = append(out, t)
			i = j
		default:
			out = append(out, globTok{lit: r})
		}
	}
	return out, true
}

// globsMeet reports whether some string matches both token lists.
func globsMeet(a, b []globTok) bool {
	seen := map[[2]int]bool{}
	var walk func(i, j int) bool
	walk = func(i, j int) bool {
		if seen[[2]int{i, j}] {
			return false
		}
		seen[[2]int{i, j}] = true
		switch {
		case i == len(a) && j == len(b):
			return true
		case i < len(a) && a[i].star:
			return walk(i+1, j) || j < len(b) && walk(i, j+1)
		case j < len(b) && b[j].star:
			return walk(i, j+1) || i < len(a) && walk(i+1, j)
		case i < len(a) && j < len(b):
			return a[i].meets(b[j]) && walk(i+1, j+1)
		}
		return false
	}
	return walk(0, 0)
}

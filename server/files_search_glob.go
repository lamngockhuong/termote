package main

import (
	"net/http"
	"path"
	"strings"
)

const (
	// searchMaxGlobs caps the files and the skip globs of one search, each.
	searchMaxGlobs = 20
	// searchMaxGlobLen caps one glob, in bytes.
	searchMaxGlobLen = 255
	// searchMaxGlobStars caps the "**" of one glob.
	searchMaxGlobStars = 4
)

var errSearchInvalidGlob = &codedError{"invalid_glob", "invalid file pattern", http.StatusBadRequest}

// searchGlob is a files or skip pattern of a search, matched against a
// '/'-separated path relative to the root. One without a '/' matches the base
// name; otherwise it matches the whole path, a "**" component standing for
// any number of components and a trailing '/' for everything below.
// Names are compared as the file system usually compares them (foldName).
type searchGlob struct {
	parts []string // the components, consecutive "**" merged
	base  bool
}

func parseSearchGlob(p string) (searchGlob, error) {
	if p == "" || len(p) > searchMaxGlobLen || strings.ContainsAny(p, "\x00\\") ||
		strings.Count(p, "**") > searchMaxGlobStars {
		return searchGlob{}, errSearchInvalidGlob
	}
	p = foldName(p)
	if !strings.Contains(p, "/") {
		if _, err := path.Match(p, ""); err != nil {
			return searchGlob{}, errSearchInvalidGlob
		}
		return searchGlob{parts: []string{p}, base: true}, nil
	}
	p = strings.TrimPrefix(p, "/")
	if strings.HasSuffix(p, "/") {
		p += "**"
	}
	var g searchGlob
	for _, part := range strings.Split(p, "/") {
		if part == "" {
			return searchGlob{}, errSearchInvalidGlob
		}
		if part == "**" {
			if n := len(g.parts); n > 0 && g.parts[n-1] == "**" {
				continue
			}
		} else if _, err := path.Match(part, ""); err != nil {
			return searchGlob{}, errSearchInvalidGlob
		}
		g.parts = append(g.parts, part)
	}
	return g, nil
}

// match reports whether rel matches g. A path glob is matched by dynamic
// programming over (pattern part, path component), so it costs at most
// parts × depth path.Match calls whatever the "**" in it.
func (g searchGlob) match(rel string) bool {
	rel = foldName(rel)
	if g.base {
		ok, _ := path.Match(g.parts[0], path.Base(rel))
		return ok
	}
	comps := strings.Split(rel, "/")
	n := len(comps)
	// ok[j]: the parts from i on match the components from j on, for the
	// current i, filled from the last part backwards.
	ok := make([]bool, n+1)
	ok[n] = true
	next := make([]bool, n+1)
	for i := len(g.parts) - 1; i >= 0; i-- {
		part := g.parts[i]
		next[n] = part == "**" && ok[n]
		for j := n - 1; j >= 0; j-- {
			if part == "**" {
				next[j] = ok[j] || next[j+1]
			} else {
				m, _ := path.Match(part, comps[j])
				next[j] = m && ok[j+1]
			}
		}
		ok, next = next, ok
	}
	return ok[0]
}

// parseSearchGlobs parses the patterns of one parameter.
func parseSearchGlobs(ps []string) ([]searchGlob, error) {
	if len(ps) > searchMaxGlobs {
		return nil, errSearchInvalidGlob
	}
	out := make([]searchGlob, 0, len(ps))
	for _, p := range ps {
		g, err := parseSearchGlob(p)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, nil
}

// matchAny reports whether rel matches one of gs.
func matchAny(gs []searchGlob, rel string) bool {
	for _, g := range gs {
		if g.match(rel) {
			return true
		}
	}
	return false
}

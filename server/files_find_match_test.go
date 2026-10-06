package main

import (
	"slices"
	"testing"
)

func TestFindMatchTier(t *testing.T) {
	for _, c := range []struct {
		path, q string
		want    int
	}{
		{"src/main.go", "main", findTierBaseSubstring},
		{"src/main.go", "mgo", findTierBaseSubsequence},
		{"src/main.go", "src", findTierPathSubstring},
		{"src/main.go", "smg", findTierPathSubsequence},
		{"src/main.go", "xyz", findTierNone},
		// A query with a '/' only matches the whole path.
		{"src/main.go", "src/ma", findTierPathSubstring},
		{"src/main.go", "s/m", findTierPathSubsequence},
		{"main.go", "a/b", findTierNone},
	} {
		if got := findMatchTier(c.path, c.q); got != c.want {
			t.Errorf("findMatchTier(%q, %q) = %d, want %d", c.path, c.q, got, c.want)
		}
	}
	if !isSubsequence("abc", "") || isSubsequence("ab", "abc") {
		t.Error("isSubsequence edge cases")
	}
}

func TestRankFind(t *testing.T) {
	list := []findEntry{
		newFindEntry("docs/readme-old.md", false),
		newFindEntry("a/b/Readme.md", false),
		newFindEntry("readme/x.txt", false),
		newFindEntry("README.md", false),
		newFindEntry("r/e/a/d/m/e.txt", false),
		newFindEntry("other.go", false),
	}
	ignored := []findEntry{newFindEntry("z/readme.md", true)}
	var got []string
	for _, e := range rankFind("ReadMe", list, ignored) {
		got = append(got, e.rel)
	}
	want := []string{
		// basename substring: shorter path first, then byte order
		"README.md", "z/readme.md", "a/b/Readme.md", "docs/readme-old.md",
		// path substring, then path subsequence
		"readme/x.txt", "r/e/a/d/m/e.txt",
	}
	if !slices.Equal(got, want) {
		t.Errorf("rankFind = %q\nwant %q", got, want)
	}
	if got := rankFind("nothing"); len(got) != 0 {
		t.Errorf("no lists = %v", got)
	}
}

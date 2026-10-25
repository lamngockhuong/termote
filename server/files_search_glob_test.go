package main

import (
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestSearchGlobMatch(t *testing.T) {
	for _, c := range []struct {
		glob string
		yes  []string
		no   []string
	}{
		{"*.ts", []string{"a.ts", "src/deep/b.ts"}, []string{"a.tsx", "src/a.ts/c.go"}},
		{"src/*.ts", []string{"src/a.ts"}, []string{"a.ts", "src/x/a.ts", "lib/src/a.ts"}},
		{"/src/*.ts", []string{"src/a.ts"}, []string{"x/src/a.ts"}},
		{"**/test/*.go", []string{"test/a.go", "a/b/test/c.go"}, []string{"a/test/b/c.go", "test.go"}},
		{"src/**", []string{"src/a", "src/a/b/c.go"}, []string{"lib/src/a"}},
		{"src/", []string{"src/a", "src/a/b"}, []string{"srcx/a"}},
		{"a/**/b", []string{"a/b", "a/x/b", "a/x/y/b"}, []string{"a/x/c", "b"}},
		{"a/**/**/b", []string{"a/b", "a/x/y/b"}, []string{"a/x"}},
		{"?.md", []string{"a.md", "docs/b.md"}, []string{"ab.md"}},
		{"[ab].go", []string{"a.go", "x/b.go"}, []string{"c.go"}},
	} {
		globs, err := parseSearchGlobs([]string{c.glob})
		if err != nil {
			t.Fatalf("%s: %v", c.glob, err)
		}
		for _, p := range c.yes {
			if !matchAny(globs, p) {
				t.Errorf("%s does not match %s", c.glob, p)
			}
		}
		for _, p := range c.no {
			if matchAny(globs, p) {
				t.Errorf("%s matches %s", c.glob, p)
			}
		}
	}
	// Case follows the file system.
	g, _ := parseSearchGlob("*.MD")
	if g.match("a.md") != (runtime.GOOS == "windows" || runtime.GOOS == "darwin") {
		t.Error("case")
	}
	if matchAny(nil, "a") {
		t.Error("no globs matched")
	}
}

func TestSearchGlobInvalid(t *testing.T) {
	for _, bad := range []string{
		"", "a\x00", `a\b`, "[", "src/[", "a//b", strings.Repeat("x", searchMaxGlobLen+1),
		"**/a/**/b/**/c/**/d/**",
	} {
		if _, err := parseSearchGlob(bad); err != errSearchInvalidGlob {
			t.Errorf("%q: %v", bad, err)
		}
	}
	many := make([]string, searchMaxGlobs+1)
	for i := range many {
		many[i] = "*.go"
	}
	if _, err := parseSearchGlobs(many); err != errSearchInvalidGlob {
		t.Errorf("too many: %v", err)
	}
	if _, err := parseSearchGlobs(many[:searchMaxGlobs]); err != nil {
		t.Errorf("at the cap: %v", err)
	}
}

// The worst case of a "**" glob stays polynomial.
func TestSearchGlobWorstCase(t *testing.T) {
	g, err := parseSearchGlob("**/a/**/a/**/a/**/b")
	if err != nil {
		t.Fatal(err)
	}
	deep := strings.Repeat("a/", 32) + "c"
	start := time.Now()
	for range 100 {
		if g.match(deep) {
			t.Fatal("matched")
		}
	}
	if d := time.Since(start) / 100; d > 10*time.Millisecond {
		t.Errorf("one match took %v", d)
	}
}

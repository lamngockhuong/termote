package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// lineLog is a scanner state that keeps the lines it was given, and how
// many times it was made.
type lineLog struct{ lines []string }

func newLineScanner(inits *int) *journalScanner[lineLog] {
	return newJournalScanner([]string{"keep"}, func() lineLog { *inits++; return lineLog{} },
		func(st *lineLog, line []byte) { st.lines = append(st.lines, strings.TrimSpace(string(line))) })
}

// scanFile opens p and scans it, returning the lines kept so far.
func scanFile(t *testing.T, js *journalScanner[lineLog], p string) []string {
	t.Helper()
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	js.scan(p, f, fi, func(st *lineLog) { out = append(out, st.lines...) })
	return out
}

func TestJournalScanIncremental(t *testing.T) {
	inits := 0
	js := newLineScanner(&inits)
	p := filepath.Join(t.TempDir(), "j.jsonl")
	writeFile(t, p, "keep 1\nskip 2\nkeep 3\n")
	if got := scanFile(t, js, p); strings.Join(got, ",") != "keep 1,keep 3" {
		t.Fatalf("first scan = %v", got)
	}
	// Appended lines only; a last line without its newline waits.
	appendFile(t, p, "keep 4\nkeep 5 half")
	if got := scanFile(t, js, p); strings.Join(got, ",") != "keep 1,keep 3,keep 4" {
		t.Errorf("after an append = %v", got)
	}
	appendFile(t, p, " done\n")
	if got := scanFile(t, js, p); strings.Join(got, ",") != "keep 1,keep 3,keep 4,keep 5 half done" {
		t.Errorf("after the line ended = %v", got)
	}
	// Unchanged: nothing read again.
	if got := scanFile(t, js, p); len(got) != 4 || inits != 1 {
		t.Errorf("unchanged = %v, %d inits", got, inits)
	}
	// Cut short: read again from the start.
	writeFile(t, p, "keep a\n")
	if got := scanFile(t, js, p); strings.Join(got, ",") != "keep a" || inits != 2 {
		t.Errorf("cut short = %v, %d inits", got, inits)
	}
	// Another file under the name, as long or longer: read again too.
	other := p + ".new"
	writeFile(t, other, "keep b\nkeep c\n")
	if err := os.Rename(other, p); err != nil {
		t.Fatal(err)
	}
	if got := scanFile(t, js, p); strings.Join(got, ",") != "keep b,keep c" || inits != 3 {
		t.Errorf("replaced = %v, %d inits", got, inits)
	}
}

func TestJournalScanLongLine(t *testing.T) {
	inits := 0
	js := newLineScanner(&inits)
	p := filepath.Join(t.TempDir(), "j.jsonl")
	writeFile(t, p, "keep 1\nkeep "+strings.Repeat("x", agentMaxLine+10)+"\nkeep 3\n")
	if got := scanFile(t, js, p); strings.Join(got, ",") != "keep 1,keep 3" {
		t.Errorf("a line longer than agentMaxLine was decoded: %d lines", len(got))
	}
	// An empty file and a nil read are fine.
	e := filepath.Join(t.TempDir(), "e.jsonl")
	writeFile(t, e, "")
	f, _ := os.Open(e)
	defer f.Close()
	fi, _ := f.Stat()
	js.scan(e, f, fi, nil)
}

func TestJournalScanEvicts(t *testing.T) {
	inits := 0
	js := newLineScanner(&inits)
	js.max = 10
	dir := t.TempDir()
	var paths []string
	for i := range 12 {
		p := filepath.Join(dir, string(rune('a'+i))+".jsonl")
		writeFile(t, p, "keep\n")
		paths = append(paths, p)
		scanFile(t, js, p)
	}
	if n := len(js.files); n > 10 {
		t.Errorf("%d files kept, want at most 10", n)
	}
	// The newest is kept: a scan of it reads nothing again.
	before := inits
	scanFile(t, js, paths[11])
	if inits != before {
		t.Error("the newest file was evicted")
	}
}

package main

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"os"
	"slices"
	"sync"
	"time"
)

// journalScanner reads agent journals (Claude Code transcripts, Codex
// rollouts) incrementally: each file is read once, and a later scan of the
// same file reads only what was appended since, keeping what the earlier
// reads made of it in a state S. A file that is another one now (its
// identity changed) or got shorter is read again from its start.
//
// Only complete lines are read, a last line still being written is left for
// the next scan. A line longer than agentMaxLine is skipped undecoded, and a
// line that holds none of the match strings is never passed to step, so a
// scan decodes only the few rows it needs.

const journalScanMax = 5000 // files remembered; past it the least used tenth goes

// journalScanner keeps one state per file path.
type journalScanner[S any] struct {
	match [][]byte
	init  func() S
	step  func(*S, []byte)
	now   func() time.Time
	max   int

	mu    sync.Mutex
	files map[string]*journalScanEntry[S]
}

type journalScanEntry[S any] struct {
	mu    sync.Mutex
	fi    os.FileInfo // the file the state is of, for os.SameFile
	size  int64
	off   int64 // where the next read starts, always a line start
	state S
	used  time.Time
}

// newJournalScanner makes a scanner passing to step each complete line that
// holds one of match; init makes the state of a file read from its start.
func newJournalScanner[S any](match []string, init func() S, step func(*S, []byte)) *journalScanner[S] {
	m := make([][]byte, len(match))
	for i, s := range match {
		m[i] = []byte(s)
	}
	return &journalScanner[S]{match: m, init: init, step: step, now: time.Now, max: journalScanMax,
		files: map[string]*journalScanEntry[S]{}}
}

// scan brings path's state up to date with f (opened by the caller, which
// checked where it resolves; fi is its Stat) and calls read with it. read
// runs under the file's lock and must not keep the state, nor anything in
// it that a later step changes. Two scans of one file take turns, the
// second reading only what the first left.
func (js *journalScanner[S]) scan(path string, f *os.File, fi os.FileInfo, read func(*S)) {
	js.mu.Lock()
	e, ok := js.files[path]
	if !ok {
		e = &journalScanEntry[S]{}
		js.files[path] = e
		if len(js.files) > js.max {
			js.evictLocked(e)
		}
	}
	e.used = js.now()
	js.mu.Unlock()

	e.mu.Lock()
	defer e.mu.Unlock()
	size := fi.Size()
	if e.fi == nil || !os.SameFile(e.fi, fi) || size < e.size {
		// A new file, another one under the name, or this one cut short.
		e.state, e.off = js.init(), 0
	}
	e.fi, e.size = fi, size
	if size > e.off {
		e.off = js.readLines(f, e.off, size, &e.state)
	}
	if read != nil {
		read(&e.state)
	}
}

// readLines steps through the complete lines in [start, end) and returns
// the offset after the last one.
func (js *journalScanner[S]) readLines(f *os.File, start, end int64, st *S) int64 {
	br := lineReaders.Get().(*bufio.Reader)
	br.Reset(io.NewSectionReader(f, start, end-start))
	defer func() {
		br.Reset(nil)
		lineReaders.Put(br)
	}()
	off := start
	var n int64 // bytes of the current line read so far
	long := false
	for {
		line, err := br.ReadSlice('\n')
		n += int64(len(line))
		if errors.Is(err, bufio.ErrBufferFull) {
			long = true
			continue
		}
		if err != nil {
			return off // the last line is still being written
		}
		off += n
		if !long && js.wanted(line) {
			js.step(st, line)
		}
		n, long = 0, false
	}
}

func (js *journalScanner[S]) wanted(line []byte) bool {
	for _, m := range js.match {
		if bytes.Contains(line, m) {
			return true
		}
	}
	return false
}

// evictLocked drops the least recently used tenth of the files, never keep.
func (js *journalScanner[S]) evictLocked(keep *journalScanEntry[S]) {
	type aged struct {
		path string
		used time.Time
	}
	all := make([]aged, 0, len(js.files))
	for p, e := range js.files {
		if e != keep {
			all = append(all, aged{p, e.used})
		}
	}
	slices.SortFunc(all, func(a, b aged) int { return a.used.Compare(b.used) })
	for _, a := range all[:len(js.files)-js.max*9/10] {
		delete(js.files, a.path)
	}
}

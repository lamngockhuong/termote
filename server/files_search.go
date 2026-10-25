package main

import (
	"bytes"
	"context"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"regexp/syntax"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	// searchLineWindow is how many runes of a long line a match sends,
	// searchLineContext how many of them come before its first match.
	searchLineWindow  = 240
	searchLineContext = 40
	// searchMaxRunning scans run at once, server-wide; the next gets 429.
	searchMaxRunning = 2
	// searchWorkers read and match files in parallel, for one scan.
	searchWorkers = 4
	// searchDeadlineMargin is kept between the scan's end and the request
	// deadline, for the response.
	searchDeadlineMargin = 500 * time.Millisecond
)

var (
	// searchMaxProg caps the instructions of the compiled pattern: RE2 costs
	// input × program size, so with searchMaxLine it bounds one line.
	searchMaxProg = 1000
	// searchMaxLine caps the bytes of one line matched; past it the line is
	// cut and the response incomplete.
	searchMaxLine = 16 << 10
	// searchMaxMatches caps the matching lines of one response (truncated),
	// searchMaxPerFile those of one file (more).
	searchMaxMatches = 2000
	searchMaxPerFile = 100
	// searchMaxBytes caps the bytes one scan reads, searchTimeout how long it
	// runs; past either the response is incomplete.
	searchMaxBytes int64 = 256 << 20
	searchTimeout        = 5 * time.Second
	// Variables, so tests can lower them.

	errSearchInvalidRegex = &codedError{"invalid_regex", "invalid regular expression", http.StatusBadRequest}
	errSearchEmptyMatch   = &codedError{"empty_match", "pattern matches empty text", http.StatusBadRequest}
	errSearchBusy         = &codedError{"busy", "too many searches at once; try again", http.StatusTooManyRequests}
)

// searchBeforeFile runs before a scan reads a file ('/'-separated, relative
// to the root); only tests set it.
var searchBeforeFile = func(rel string) {}

// searchQuery is a parsed GET files/search.
type searchQuery struct {
	re          *regexp.Regexp
	files, skip []searchGlob
	// find carries the excluded names, so the list is find's.
	find  findQuery
	fresh bool
}

func parseSearchQuery(v url.Values) (searchQuery, error) {
	q := v.Get("q")
	if q == "" {
		return searchQuery{}, errFindQueryRequired
	}
	if len(q) > findMaxQuery {
		return searchQuery{}, errFindQueryTooLong
	}
	in, err := parseFindExcludes(v["exclude"])
	if err != nil {
		return searchQuery{}, err
	}
	files, err := parseSearchGlobs(v["files"])
	if err != nil {
		return searchQuery{}, err
	}
	skip, err := parseSearchGlobs(v["skip"])
	if err != nil {
		return searchQuery{}, err
	}
	regex := v.Get("regex") == "1"
	re, err := searchRegexp(q, regex, v.Get("case") == "1", v.Get("word") == "1")
	if err != nil {
		return searchQuery{}, err
	}
	return searchQuery{re: re, files: files, skip: skip, find: in, fresh: v.Get("fresh") == "1"}, nil
}

// searchRegexp builds the pattern of a query. A regex is parsed alone first,
// so wrapping never makes an invalid one valid, and wrapped as its parsed
// form (a \Q without \E would quote the wrapping). Whole word adds \b on a
// side where a literal ends in a word character (\b before "(" never
// matches), or around a regex. Go's \b is ASCII only. Every failure, and a
// program larger than searchMaxProg, is errSearchInvalidRegex: Go's message
// is never sent. A regex that can match empty text is errSearchEmptyMatch:
// finding a line's non-empty matches past empty ones would cost a scan of
// the line per position.
func searchRegexp(q string, regex, matchCase, word bool) (*regexp.Regexp, error) {
	var pat string
	if regex {
		tree, err := syntax.Parse(q, syntax.Perl)
		if err != nil {
			return nil, errSearchInvalidRegex
		}
		if matchesEmpty(tree) {
			return nil, errSearchEmptyMatch
		}
		pat = q
		if word {
			pat = `\b(?:` + tree.String() + `)\b`
		}
	} else {
		pat = regexp.QuoteMeta(q)
		if word {
			first, _ := utf8.DecodeRuneInString(q)
			last, _ := utf8.DecodeLastRuneInString(q)
			if isWordByte(first) {
				pat = `\b` + pat
			}
			if isWordByte(last) {
				pat += `\b`
			}
		}
	}
	if !matchCase {
		pat = `(?i)` + pat
	}
	tree, err := syntax.Parse(pat, syntax.Perl)
	if err != nil {
		return nil, errSearchInvalidRegex
	}
	prog, err := syntax.Compile(tree.Simplify())
	if err != nil || len(prog.Inst) > searchMaxProg {
		return nil, errSearchInvalidRegex
	}
	re, err := regexp.Compile(pat)
	if err != nil {
		return nil, errSearchInvalidRegex
	}
	return re, nil
}

// matchesEmpty reports whether re can match empty text somewhere: an
// assertion (^, $, \b) consumes nothing, so it counts as empty.
func matchesEmpty(re *syntax.Regexp) bool {
	switch re.Op {
	case syntax.OpNoMatch, syntax.OpCharClass, syntax.OpAnyCharNotNL, syntax.OpAnyChar:
		return false
	case syntax.OpLiteral:
		return len(re.Rune) == 0
	case syntax.OpStar, syntax.OpQuest:
		return true
	case syntax.OpCapture, syntax.OpPlus:
		return matchesEmpty(re.Sub[0])
	case syntax.OpRepeat:
		return re.Min == 0 || matchesEmpty(re.Sub[0])
	case syntax.OpConcat:
		for _, sub := range re.Sub {
			if !matchesEmpty(sub) {
				return false
			}
		}
		return true
	case syntax.OpAlternate:
		for _, sub := range re.Sub {
			if matchesEmpty(sub) {
				return true
			}
		}
		return false
	}
	// OpEmptyMatch and the assertions
	return true
}

// isWordByte: a character \b counts as a word one.
func isWordByte(r rune) bool {
	return r == '_' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z'
}

// searchMatch is one matching line. Text is the line, or a window of it
// around its first match when long; Col is where the window starts in the
// line and Ranges the matches inside it, both in UTF-16 code units (what a
// browser string counts).
type searchMatch struct {
	Line   int      `json:"line"`
	Text   string   `json:"text"`
	Col    int      `json:"col"`
	Ranges [][2]int `json:"ranges"`
}

type searchFileResult struct {
	Path    string        `json:"path"`
	Matches []searchMatch `json:"matches"`
	// More counts the matching lines past searchMaxPerFile.
	More int `json:"more"`
}

// searchSkipped counts the files of the list a scan did not search.
type searchSkipped struct {
	Sensitive int `json:"sensitive"`
	Hidden    int `json:"hidden"`
	Binary    int `json:"binary"`
	TooLarge  int `json:"tooLarge"`
}

type searchResponse struct {
	Root   string             `json:"root"`
	IsRepo bool               `json:"isRepo"`
	Files  []searchFileResult `json:"files"`
	// Truncated: searchMaxMatches lines were sent and more matched.
	Truncated bool `json:"truncated"`
	// Incomplete: some files were not searched (the list was cut, the time
	// or byte budget ran out) or a line was cut at searchMaxLine.
	Incomplete bool          `json:"incomplete"`
	Skipped    searchSkipped `json:"skipped"`
}

// handleSearch serves GET files/search: the lines of the files of find's
// list that match a query, grouped by file in path order. Every file is read
// through os.Root after the deny, view and sensitive checks; nothing but
// find's ls-files runs git.
func (f *filesAPI) handleSearch(w http.ResponseWriter, r *http.Request) {
	req, cancel, ok := f.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	in, err := parseSearchQuery(r.URL.Query())
	if err != nil {
		f.error(w, "files search", err)
		return
	}
	// A view-only client searches the list it may read (start built it)
	// and never makes the server drop and rebuild one.
	var list findList
	if req.view != nil {
		list = *req.view
	} else {
		if in.fresh {
			f.finds.forgetPrefix(req.root.Root + "\x00")
		}
		lists, err := f.findLists(req.ctx, req.root, in.find)
		if err != nil {
			f.error(w, "files search", err)
			return
		}
		list = lists[0]
	}
	select {
	case f.searchSlots <- struct{}{}:
		defer func() { <-f.searchSlots }()
	default:
		f.error(w, "files search", errSearchBusy)
		return
	}
	res, wait, err := f.searchList(r.Context(), searchDeadline(req.ctx, time.Now()), req, list, in)
	// The response ends once every worker has: each stops at its next line
	// (one search of at most searchMaxLine bytes) or once its read returns.
	defer wait()
	if r.Context().Err() != nil {
		return // the client left: nothing to write
	}
	if err != nil {
		f.error(w, "files search", err)
		return
	}
	jsonOK(w, res)
}

// searchDeadline is when a scan started at now stops: searchTimeout later,
// kept short of ctx's deadline (the request's, which the list build may
// have spent already). Running out of time answers what was found, never an
// empty body.
func searchDeadline(ctx context.Context, now time.Time) time.Time {
	deadline := now.Add(searchTimeout)
	if d, ok := ctx.Deadline(); ok && d.Add(-searchDeadlineMargin).Before(deadline) {
		deadline = d.Add(-searchDeadlineMargin)
	}
	return deadline
}

// searchOutcome is what a worker found in the i-th file of a scan.
type searchOutcome struct {
	i       int
	path    string
	matches []searchMatch
	more    int
	skip    searchSkip
	cut     bool // a line was cut at searchMaxLine
	stopped bool // the scan's time or byte budget ran out before or inside it
}

// searchSkip says why a file of the list was not searched, when counted.
type searchSkip int

const (
	skipNone searchSkip = iota
	skipSensitive
	skipHidden
	skipBinary
	skipTooLarge
)

// add counts one file skipped for why.
func (s *searchSkipped) add(why searchSkip) {
	switch why {
	case skipSensitive:
		s.Sensitive++
	case skipHidden:
		s.Hidden++
	case skipBinary:
		s.Binary++
	case skipTooLarge:
		s.TooLarge++
	}
}

// searchScan is the state the workers of one scan share.
type searchScan struct {
	f    *filesAPI
	root filesRoot
	rt   *os.Root
	view *findList
	in   searchQuery
	// hideDots: the root holds a home dir, so no dot-path is read, by its
	// name or where it leads
	hideDots bool
	used     atomic.Int64 // bytes read
}

// searchList scans list's files for in. The files go to searchWorkers
// workers in path order, at most 2 × searchWorkers ahead of the one the
// merge waits for, so a slow file never makes the rest pile up. The merge
// stops at a cap, the deadline or ctx's end, and cancels the workers; wait
// returns once every one of them has.
func (f *filesAPI) searchList(ctx context.Context, deadline time.Time, req *filesRequest, list findList, in searchQuery) (res searchResponse, wait func(), err error) {
	res = searchResponse{Root: req.root.Root, IsRepo: req.root.IsRepo, Files: []searchFileResult{}, Incomplete: list.incomplete}
	rt, err := os.OpenRoot(req.root.Root)
	if err != nil {
		return res, func() {}, err
	}
	// The cached list is shared: sort a copy (git lists untracked files
	// first, the walk in directory order). The globs and the dot-path rule
	// need no file system, so they run here.
	hideDots := f.holdsHome(req.root.Root)
	var todo []string
	for _, e := range list.entries {
		if (len(in.files) > 0 && !matchAny(in.files, e.rel)) || matchAny(in.skip, e.rel) {
			continue
		}
		if hideDots && hasDotPart(e.rel) {
			res.Skipped.Hidden++
			continue
		}
		todo = append(todo, e.rel)
	}
	slices.Sort(todo)

	sc := &searchScan{f: f, root: req.root, rt: rt, view: req.view, in: in, hideDots: hideDots}
	scanCtx, stop := context.WithDeadline(ctx, deadline)
	window := 2 * searchWorkers
	tokens := make(chan struct{}, window)
	jobs := make(chan int)
	done := make(chan searchOutcome)
	var wg sync.WaitGroup
	wg.Go(func() {
		defer close(jobs)
		for i := range todo {
			select {
			case tokens <- struct{}{}:
			case <-scanCtx.Done():
				return
			}
			select {
			case jobs <- i:
			case <-scanCtx.Done():
				return
			}
		}
	})
	for range searchWorkers {
		wg.Go(func() {
			for {
				var i int
				var ok bool
				select {
				case i, ok = <-jobs:
					if !ok {
						return
					}
				case <-scanCtx.Done():
					return
				}
				out := sc.file(scanCtx, i, todo[i])
				select {
				case done <- out:
				case <-scanCtx.Done():
					return
				}
			}
		})
	}
	wait = func() {
		stop()
		wg.Wait()
		rt.Close()
	}

	pending := map[int]searchOutcome{}
	total := 0
merge:
	for want := 0; want < len(todo); {
		out, ok := pending[want]
		if !ok {
			select {
			case o := <-done:
				pending[o.i] = o
			case <-scanCtx.Done():
				res.Incomplete = true
				break merge
			}
			continue
		}
		delete(pending, want)
		<-tokens
		want++
		if out.stopped {
			res.Incomplete = true
			break
		}
		if out.skip != skipNone {
			res.Skipped.add(out.skip)
			continue
		}
		res.Incomplete = res.Incomplete || out.cut
		if len(out.matches) == 0 {
			continue
		}
		if total == searchMaxMatches {
			res.Truncated = true
			break
		}
		if left := searchMaxMatches - total; len(out.matches) > left {
			out.matches, res.Truncated = out.matches[:left], true
		}
		total += len(out.matches)
		res.Files = append(res.Files, searchFileResult{Path: out.path, Matches: out.matches, More: out.more})
		if res.Truncated {
			break
		}
	}
	stop()
	return res, wait, nil
}

// hasDotPart reports whether a component of rel starts with a dot.
func hasDotPart(rel string) bool {
	for _, part := range strings.Split(rel, "/") {
		if strings.HasPrefix(part, ".") {
			return true
		}
	}
	return false
}

// file searches the i-th file, rel. Its symlinks are resolved once for the
// deny, view and sensitive checks; only then is it opened, through the
// root, and judged by what was opened.
func (sc *searchScan) file(ctx context.Context, i int, rel string) searchOutcome {
	out := searchOutcome{i: i, path: rel}
	native := filepath.FromSlash(rel)
	abs := filepath.Join(sc.root.Root, native)
	real := resolvedPath(abs)
	if sc.f.deniedPaths(sc.root.Root, abs, real, sc.root.GitDir) {
		return out
	}
	to, inside := realRelOf(sc.root.Root, native, real)
	// The list vouches for rel; where it leads must be listed too.
	if sc.view != nil && (!inside || !sc.view.listed(to, false)) {
		return out
	}
	// A link of an ordinary name to a shell history
	if sc.hideDots && inside && hasDotPart(to) {
		out.skip = skipHidden
		return out
	}
	if isSensitive(abs) || isSensitive(real) {
		out.skip = skipSensitive
		return out
	}
	if sc.used.Load() >= searchMaxBytes {
		out.stopped = true
		return out
	}
	searchBeforeFile(rel)
	fh, err := sc.rt.OpenFile(native, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return out // gone, or a link out of the root
	}
	b, _, reason, err := readTextFile(fh)
	fh.Close()
	sc.used.Add(int64(len(b)))
	switch {
	case err != nil, reason == "not-regular":
		return out
	case reason == "too-large":
		out.skip = skipTooLarge
		return out
	case reason == "binary":
		out.skip = skipBinary
		return out
	}
	out.matches, out.more, out.cut, out.stopped = searchLines(ctx, sc.in.re, b)
	return out
}

// searchLines finds the matching lines of a text file: up to
// searchMaxPerFile of them, and how many more. A line longer than
// searchMaxLine is matched on its start only (cut). The pattern never
// matches empty text (searchRegexp), so one search of a line tells whether
// it matches; ctx is checked before each line. stopped: ctx ended before the
// last line.
func searchLines(ctx context.Context, re *regexp.Regexp, b []byte) (matches []searchMatch, more int, cut, stopped bool) {
	for n := 1; len(b) > 0; n++ {
		if ctx.Err() != nil {
			return matches, more, cut, true
		}
		line, rest, _ := bytes.Cut(b, []byte{'\n'})
		b = rest
		line = bytes.TrimSuffix(line, []byte{'\r'})
		if len(line) > searchMaxLine {
			end := searchMaxLine
			for end > 0 && !utf8.RuneStart(line[end]) {
				end--
			}
			line, cut = line[:end], true
		}
		first := re.FindIndex(line)
		if first == nil {
			continue
		}
		if len(matches) == searchMaxPerFile {
			more++
			continue
		}
		matches = append(matches, lineMatch(n, line, first, re))
	}
	return matches, more, cut, false
}

// lineMatch makes the match of line n from its first match. Its other
// matches are looked for in the window only: at most searchLineWindow
// searches of at most the window's bytes each, where the whole line would
// cost a scan of the line per match. A line the window holds whole gets
// exact ranges; one cut gets the first match exact and the others found
// in the window after it, without the line's text around it (a \b or ^
// at the window's edge may differ).
func lineMatch(n int, line []byte, first []int, re *regexp.Regexp) searchMatch {
	start, end := 0, len(line)
	if runes := utf8.RuneCount(line); runes > searchLineWindow {
		at := utf8.RuneCount(line[:first[0]])
		from := max(0, min(at-searchLineContext, runes-searchLineWindow))
		start = runeOffset(line, 0, from)
		end = runeOffset(line, start, searchLineWindow)
	}
	var locs [][]int
	if start == 0 && end == len(line) {
		locs = re.FindAllIndex(line, searchLineWindow)
	} else {
		locs = [][]int{first}
		if first[1] < end {
			for _, l := range re.FindAllIndex(line[first[1]:end], searchLineWindow) {
				locs = append(locs, []int{l[0] + first[1], l[1] + first[1]})
			}
		}
	}
	text := line[start:end]
	// u16[k]: UTF-16 units of text[:k], for every rune boundary k.
	u16 := make([]int, len(text)+1)
	units := 0
	for k, r := range string(text) {
		u16[k] = units
		units += utf16.RuneLen(r)
	}
	u16[len(text)] = units
	m := searchMatch{Line: n, Text: string(text), Col: utf16Len(line[:start]), Ranges: [][2]int{}}
	for _, l := range locs {
		s, e := max(l[0], start), min(l[1], end)
		if s < e {
			m.Ranges = append(m.Ranges, [2]int{u16[s-start], u16[e-start]})
		}
	}
	return m
}

// runeOffset is the byte offset n runes after byte offset from in b (len(b)
// when b has fewer).
func runeOffset(b []byte, from, n int) int {
	for ; n > 0 && from < len(b); n-- {
		_, size := utf8.DecodeRune(b[from:])
		from += size
	}
	return from
}

// utf16Len counts the UTF-16 code units of b.
func utf16Len(b []byte) int {
	n := 0
	for _, r := range string(b) {
		n += utf16.RuneLen(r)
	}
	return n
}

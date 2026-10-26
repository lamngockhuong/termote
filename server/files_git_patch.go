package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
)

var (
	errStaleHunk       = &codedError{"stale_hunk", "the change no longer matches the file", http.StatusConflict}
	errHunkUnsupported = &codedError{"hunk_unsupported", "this change cannot be applied by hunk", http.StatusConflict}
)

// hunkID names one hunk of a diff for an apply: the sha256 of its header and
// body lines as git printed them. A client sends it back; the server finds
// the hunk in a fresh diff by it, so a hunk the file no longer has is not
// found, and no patch text ever comes from the client.
func hunkID(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// hunkHeadOK reports whether a hunk of path's diff can be applied alone,
// from the lines before the first hunk: only those an in-place change has
// (nothing about a rename, a copy, a mode or a new or deleted file), and
// ---/+++ lines naming path itself.
func hunkHeadOK(head []string, path string) bool {
	var from, to string
	for _, l := range head {
		switch {
		case strings.HasPrefix(l, "diff --git "), strings.HasPrefix(l, "index "):
		case strings.HasPrefix(l, "--- "):
			from = l[4:]
		case strings.HasPrefix(l, "+++ "):
			to = l[4:]
		default:
			return false
		}
	}
	return diffName(from) == "a/"+path && diffName(to) == "b/"+path
}

// hunkPatch builds the patch git apply takes for one hunk of path's diff
// (raw, header included). The file header is written here from path,
// never copied from git's output.
func hunkPatch(raw, path string) []byte {
	a, b := quoteC("a/"+path), quoteC("b/"+path)
	p := "diff --git " + a + " " + b + "\n--- " + a + "\n+++ " + b + "\n" + raw
	if !strings.HasSuffix(p, "\n") {
		p += "\n"
	}
	return []byte(p)
}

// diffName reads a name of a ---/+++ line: git appends a tab to a name with
// a space, and quotes one with a special character (C-style). "" when it
// cannot be read.
func diffName(s string) string {
	s = strings.TrimSuffix(s, "\t")
	if !strings.HasPrefix(s, `"`) {
		return s
	}
	u, ok := unquoteC(s)
	if !ok {
		return ""
	}
	return u
}

// quoteC quotes s as git apply reads a quoted name: always in quotes, with
// '"', '\' and every byte outside printable ASCII escaped.
func quoteC(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"' || c == '\\':
			b.WriteByte('\\')
			b.WriteByte(c)
		case c < 0x20 || c >= 0x7f:
			b.WriteString(`\` + strconv.FormatUint(uint64(c)|0o1000, 8)[1:])
		default:
			b.WriteByte(c)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// unquoteC reverses git's C-style quoting of a name.
func unquoteC(s string) (string, bool) {
	if len(s) < 2 || s[0] != '"' || s[len(s)-1] != '"' {
		return "", false
	}
	s = s[1 : len(s)-1]
	named := map[byte]byte{'a': '\a', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t', 'v': '\v', '"': '"', '\\': '\\'}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c != '\\' {
			b.WriteByte(c)
			continue
		}
		if i+1 >= len(s) {
			return "", false
		}
		if v, ok := named[s[i+1]]; ok {
			b.WriteByte(v)
			i++
			continue
		}
		if i+4 > len(s) {
			return "", false
		}
		n, err := strconv.ParseUint(s[i+1:i+4], 8, 8)
		if err != nil {
			return "", false
		}
		b.WriteByte(byte(n))
		i += 3
	}
	return b.String(), true
}

// reverseHunk undoes hunk h of the worktree side in cur, the file's bytes:
// the lines h added (with its context) are replaced by those it removed.
// Lines are compared without one trailing '\r' on either side (autocrlf
// diffs the file as "\n", an index holding "\r\n" diffs it as is), and
// written with cur's line break. Any line that differs is errStaleHunk:
// nothing is guessed.
func reverseHunk(cur []byte, h diffHunk) ([]byte, error) {
	crlf, reason := textEditReason(cur)
	if reason != "" {
		return nil, errStaleHunk
	}
	_, _, newStart, newCount, ok := parseHunkHeader(h.Header)
	if !ok {
		return nil, errStaleHunk
	}
	eol := "\n"
	if crlf {
		eol = "\r\n"
	}
	text := string(cur)
	finalNL := strings.HasSuffix(text, "\n")
	var lines []string
	if text != "" {
		lines = strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	}
	for i := range lines {
		lines[i] = strings.TrimSuffix(lines[i], "\r")
	}
	// A count of 0 puts start on the line before the hunk.
	at := newStart - 1
	if newCount == 0 {
		at = newStart
	}
	var newSide, oldSide []diffLine
	for _, l := range h.Lines {
		if l.Kind != "del" {
			newSide = append(newSide, l)
		}
		if l.Kind != "add" {
			oldSide = append(oldSide, l)
		}
	}
	if len(newSide) != newCount || at < 0 || at+newCount > len(lines) {
		return nil, errStaleHunk
	}
	atEnd := at+newCount == len(lines)
	for i, l := range newSide {
		if strings.TrimSuffix(l.Text, "\r") != lines[at+i] {
			return nil, errStaleHunk
		}
		// Only the file's last line may lack its line break, and it must
		// lack it in the file too.
		last := atEnd && i == len(newSide)-1
		if l.NoNewline != (last && !finalNL) {
			return nil, errStaleHunk
		}
	}
	if atEnd && newCount == 0 && !finalNL && len(lines) > 0 {
		return nil, errStaleHunk // the hunk would follow a line without a break
	}
	out := append([]string{}, lines[:at]...)
	for _, l := range oldSide {
		out = append(out, strings.TrimSuffix(l.Text, "\r"))
	}
	out = append(out, lines[at+newCount:]...)
	// The break after the last line: the old side's when the hunk ends the
	// file, else the file's own.
	if atEnd {
		finalNL = true
		if n := len(oldSide); n > 0 && oldSide[n-1].NoNewline {
			finalNL = false
		}
	}
	for i, l := range oldSide {
		if l.NoNewline && (!atEnd || i != len(oldSide)-1) {
			return nil, errStaleHunk
		}
	}
	if len(out) == 0 {
		return []byte{}, nil
	}
	res := strings.Join(out, eol)
	if finalNL {
		res += eol
	}
	return []byte(res), nil
}

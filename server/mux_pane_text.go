package main

import (
	"bytes"
	"context"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	// defaultPaneTextLines is how many history lines a text read asks for
	// when the client names none.
	defaultPaneTextLines = 1000
	// maxPaneTextLines caps the history lines of one text read.
	maxPaneTextLines = 5000
	// maxPaneText caps the text one read returns, in bytes; past it the
	// oldest lines go.
	maxPaneText = 2 << 20
)

// tailBuffer keeps the last max bytes written to it (plus at most max more
// until the next compaction), so a long capture never sits whole in memory.
type tailBuffer struct {
	buf     []byte
	max     int
	dropped bool
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if len(t.buf) > 2*t.max {
		t.compact()
	}
	return len(p), nil
}

// compact drops all but the last max bytes.
func (t *tailBuffer) compact() {
	if len(t.buf) <= t.max {
		return
	}
	t.buf = append(t.buf[:0], t.buf[len(t.buf)-t.max:]...)
	t.dropped = true
}

// text returns what was kept and whether older bytes were dropped. A cut
// starts after the first line break kept, so no line is returned in part.
func (t *tailBuffer) text() (string, bool) {
	t.compact()
	b := t.buf
	if t.dropped {
		if i := bytes.IndexByte(b, '\n'); i >= 0 {
			b = b[i+1:]
		} else {
			b = nil
		}
	}
	return string(b), t.dropped
}

// cleanPaneText removes control characters other than tab and line break
// (ESC among them, so what is left of an escape sequence is plain text that
// drives nothing), carriage returns and invalid UTF-8 (a U+FFFD the program
// printed stays), and the blank lines at the bottom of the screen. Format
// characters (bidi, zero-width) stay: joined emoji and some scripts need
// them; the PWA shows them.
func cleanPaneText(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for len(s) > 0 {
		r, size := utf8.DecodeRuneInString(s)
		keep := r == '\n' || r == '\t' || !(r == utf8.RuneError && size == 1) && !unicode.IsControl(r)
		if keep {
			b.WriteString(s[:size])
		}
		s = s[size:]
	}
	lines := strings.Split(b.String(), "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " \t")
	}
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return strings.Join(lines, "\n")
}

// parsePaneTextLines reads the lines query: empty → the default, else an
// integer in 1..maxPaneTextLines.
func parsePaneTextLines(q string) (int, bool) {
	if q == "" {
		return defaultPaneTextLines, true
	}
	n, err := strconv.Atoi(q)
	if err != nil || n < 1 || n > maxPaneTextLines {
		return 0, false
	}
	return n, true
}

// handlePaneText answers GET /api/mux/panes/{id}/text?lines=N: the pane's
// plain text, its history and screen with wrapped lines joined. A same-site
// read like the snapshot, and refused to a view-only client: its role shows
// the screen only, never the history.
func handlePaneText(m Mux, agent *agentAPI) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		if msg := crossSiteRejection(agent.allowed, r); msg != "" {
			jsonError(w, msg, http.StatusForbidden)
			return
		}
		if !requireWriteRole(w, r) {
			return
		}
		lines, ok := parsePaneTextLines(r.URL.Query().Get("lines"))
		if !ok {
			jsonErrorCode(w, "invalid_lines", "lines must be an integer from 1 to "+strconv.Itoa(maxPaneTextLines), http.StatusBadRequest)
			return
		}
		if !m.Caps().PaneText {
			jsonErrorCode(w, "unsupported", errUnsupported.Error(), http.StatusNotImplemented)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
		defer cancel()
		buf := &tailBuffer{max: maxPaneText}
		more, err := m.ReadText(ctx, r.PathValue("id"), lines, buf)
		if err != nil {
			muxError(w, m, "read text", err)
			return
		}
		text, truncated := buf.text()
		text = cleanPaneText(text)
		count := 0
		if text != "" {
			count = strings.Count(text, "\n") + 1
		}
		w.Header().Set("Cache-Control", "no-store")
		jsonOK(w, map[string]any{"text": text, "lines": count, "truncated": truncated, "more": more && !truncated})
	}
}

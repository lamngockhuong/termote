package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// paneTextHandler serves the routes over a fakeMux that reads text.
func paneTextHandler(t *testing.T, f *fakeMux) http.Handler {
	t.Helper()
	if f.caps == nil {
		f.caps = &Caps{PaneText: true}
	}
	return newTestHandler(t, f)
}

type paneTextReply struct {
	Text      string `json:"text"`
	Lines     int    `json:"lines"`
	Truncated bool   `json:"truncated"`
	More      bool   `json:"more"`
	Error     string `json:"error"`
	Code      string `json:"code"`
}

func decodePaneText(t *testing.T, rec *httptest.ResponseRecorder) paneTextReply {
	t.Helper()
	var r paneTextReply
	if err := json.Unmarshal(rec.Body.Bytes(), &r); err != nil {
		t.Fatalf("decode %q: %v", rec.Body, err)
	}
	return r
}

func TestPaneTextReturnsCleanText(t *testing.T) {
	f := &fakeMux{text: "one\r\n\x1b[31mred\x1b[0m\ttab \u200d\u202e\x07\xff\ufffd\nlast  \n\n   \n"}
	h := paneTextHandler(t, f)
	rec := serve(h, apiRequest(http.MethodGet, "/api/mux/panes/3/text", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q", cc)
	}
	r := decodePaneText(t, rec)
	// Escape sequences lose their ESC (the rest is plain text), CR, BEL
	// and invalid UTF-8 go; format characters stay; blank lines at the
	// bottom and trailing spaces go.
	if want := "one\n[31mred[0m\ttab \u200d\u202e\ufffd\nlast"; r.Text != want {
		t.Errorf("text = %q, want %q", r.Text, want)
	}
	if r.Lines != 3 || r.Truncated || r.More {
		t.Errorf("lines %d truncated %v more %v", r.Lines, r.Truncated, r.More)
	}
	if len(f.calls) != 1 || f.calls[0] != "text 3=1000" {
		t.Errorf("calls = %v, want the default 1000 lines", f.calls)
	}
}

func TestPaneTextMore(t *testing.T) {
	f := &fakeMux{text: "x", more: true}
	r := decodePaneText(t, serve(paneTextHandler(t, f), apiRequest(http.MethodGet, "/api/mux/panes/3/text", "")))
	if !r.More {
		t.Errorf("more lost: %+v", r)
	}
}

func TestPaneTextEmpty(t *testing.T) {
	f := &fakeMux{text: "\n\n"}
	rec := serve(paneTextHandler(t, f), apiRequest(http.MethodGet, "/api/mux/panes/3/text?lines=5", ""))
	r := decodePaneText(t, rec)
	if rec.Code != http.StatusOK || r.Text != "" || r.Lines != 0 {
		t.Errorf("%d %+v", rec.Code, r)
	}
	if f.calls[0] != "text 3=5" {
		t.Errorf("calls = %v", f.calls)
	}
}

func TestPaneTextLinesQuery(t *testing.T) {
	for _, q := range []string{"0", "-1", "5001", "abc", "1.5", "10x"} {
		f := &fakeMux{}
		rec := serve(paneTextHandler(t, f), apiRequest(http.MethodGet, "/api/mux/panes/3/text?lines="+q, ""))
		if r := decodePaneText(t, rec); rec.Code != http.StatusBadRequest || r.Code != "invalid_lines" {
			t.Errorf("lines=%s: %d %+v", q, rec.Code, r)
		}
		if len(f.calls) != 0 {
			t.Errorf("lines=%s: backend called %v", q, f.calls)
		}
	}
	for _, q := range []string{"1", "5000"} {
		f := &fakeMux{text: "x"}
		rec := serve(paneTextHandler(t, f), apiRequest(http.MethodGet, "/api/mux/panes/3/text?lines="+q, ""))
		if rec.Code != http.StatusOK || f.calls[0] != "text 3="+q {
			t.Errorf("lines=%s: %d %v", q, rec.Code, f.calls)
		}
	}
}

func TestPaneTextGuards(t *testing.T) {
	f := &fakeMux{text: "secret"}
	h := paneTextHandler(t, f)

	post := apiRequest(http.MethodPost, "/api/mux/panes/3/text", "{}")
	if rec := serve(h, post); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST: %d", rec.Code)
	}
	for _, site := range []string{"cross-site", "same-site", "none"} {
		req := apiRequest(http.MethodGet, "/api/mux/panes/3/text", "")
		req.Header.Set("Sec-Fetch-Site", site)
		if rec := serve(h, req); rec.Code != http.StatusForbidden {
			t.Errorf("Sec-Fetch-Site %s: %d", site, rec.Code)
		}
	}
	req := apiRequest(http.MethodGet, "/api/mux/panes/3/text", "")
	req.Header.Set("Origin", "https://evil.example")
	if rec := serve(h, req); rec.Code != http.StatusForbidden {
		t.Errorf("foreign Origin: %d", rec.Code)
	}
	req = apiRequest(http.MethodGet, "/api/mux/panes/3/text", "")
	req.Header.Del("Authorization")
	if rec := serve(h, req); rec.Code != http.StatusUnauthorized {
		t.Errorf("no auth: %d", rec.Code)
	}
	if len(f.calls) != 0 {
		t.Errorf("backend called: %v", f.calls)
	}
}

func TestPaneTextRefusesViewOnly(t *testing.T) {
	f := &fakeMux{text: "history", caps: &Caps{PaneText: true}}
	h, _ := newRoleHandler(t, f, true)
	assertViewOnly(t, "text", serve(h, viewRequest(http.MethodGet, "/api/mux/panes/3/text", "")))
	if len(f.calls) != 0 {
		t.Errorf("backend called: %v", f.calls)
	}
}

func TestPaneTextUnsupported(t *testing.T) {
	f := &fakeMux{caps: &Caps{}}
	rec := serve(newTestHandler(t, f), apiRequest(http.MethodGet, "/api/mux/panes/3/text", ""))
	if r := decodePaneText(t, rec); rec.Code != http.StatusNotImplemented || r.Code != "unsupported" {
		t.Errorf("%d %+v", rec.Code, r)
	}
	if len(f.calls) != 0 {
		t.Errorf("backend called: %v", f.calls)
	}
}

func TestPaneTextBackendErrors(t *testing.T) {
	for _, c := range []struct {
		err  error
		code int
		msg  string
	}{
		{inputError("unknown pane"), http.StatusBadRequest, "unknown pane"},
		{errUnsupported, http.StatusNotImplemented, errUnsupported.Error()},
		{errors.New("tmux exploded at /secret/path"), http.StatusInternalServerError, "mux command failed"},
	} {
		f := &fakeMux{err: c.err}
		rec := serve(paneTextHandler(t, f), apiRequest(http.MethodGet, "/api/mux/panes/3/text", ""))
		if r := decodePaneText(t, rec); rec.Code != c.code || r.Error != c.msg {
			t.Errorf("%v: %d %+v", c.err, rec.Code, r)
		}
	}
}

func TestPaneTextTruncatesOldestLines(t *testing.T) {
	line := strings.Repeat("x", 99) + "\n" // 100 bytes
	n := maxPaneText/len(line) + 50
	var b strings.Builder
	for i := range n {
		fmt.Fprintf(&b, "%06d%s", i, line[6:])
	}
	// Cut at the size limit: more history is never offered
	f := &fakeMux{text: b.String(), more: true}
	rec := serve(paneTextHandler(t, f), apiRequest(http.MethodGet, "/api/mux/panes/3/text?lines=5000", ""))
	r := decodePaneText(t, rec)
	if !r.Truncated || r.More || len(r.Text) > maxPaneText {
		t.Fatalf("truncated %v, %d bytes", r.Truncated, len(r.Text))
	}
	lines := strings.Split(r.Text, "\n")
	// Whole lines only, and the newest one kept.
	for _, l := range lines {
		if len(l) != 99 {
			t.Fatalf("partial line %q", l)
		}
	}
	if last := lines[len(lines)-1]; !strings.HasPrefix(last, fmt.Sprintf("%06d", n-1)) {
		t.Errorf("last line %q, want line %d", last[:6], n-1)
	}
	if r.Lines != len(lines) {
		t.Errorf("lines = %d, want %d", r.Lines, len(lines))
	}
}

func TestTailBuffer(t *testing.T) {
	tb := &tailBuffer{max: 8}
	for _, s := range []string{"aa\n", "bbbb\n", "cc\n", "dd\n", "eeeeeeee"} {
		tb.Write([]byte(s))
	}
	// Kept "\ndd\neeeeeeee"[-8:] = "eeeeeeee": no line break, nothing whole.
	if s, cut := tb.text(); s != "" || !cut {
		t.Errorf("text = %q, %v", s, cut)
	}
	tb = &tailBuffer{max: 8}
	tb.Write([]byte("a\nbc\nd\nef\n"))
	if s, cut := tb.text(); s != "d\nef\n" || !cut {
		t.Errorf("text = %q, %v", s, cut)
	}
	tb = &tailBuffer{max: 8}
	tb.Write([]byte("a\nb"))
	if s, cut := tb.text(); s != "a\nb" || cut {
		t.Errorf("text = %q, %v", s, cut)
	}
}

func TestTmuxReadText(t *testing.T) {
	usePsmux(t, false)
	orig := tmuxSession
	t.Cleanup(func() { tmuxSession = orig })
	tmuxSession = "main"
	args := useFakeTmuxScript(t, map[string]fakeTmuxReply{
		"capture-pane":    {out: "a\nb\n"},
		"display-message": {out: "300\n"},
	})
	var b strings.Builder
	more, err := (tmuxMux{}).ReadText(context.Background(), "2", 300, &b)
	if err != nil || more {
		t.Fatalf("more %v, %v: the history is all read", more, err)
	}
	if b.String() != "a\nb\n" {
		t.Errorf("text = %q", b.String())
	}
	if more, err := (tmuxMux{}).ReadText(context.Background(), "$3:1", 5, &b); err != nil || !more {
		t.Fatalf("more %v, %v: 300 rows of history past 5", more, err)
	}
	got := args()
	for _, want := range []string{"display-message -p -t =main:=2 #{history_size}\n", "capture-pane -p -J -S -300 -t =main:=2\n", "capture-pane -p -J -S -5 -t $3:=1\n"} {
		if !strings.Contains(got, want) {
			t.Errorf("args %q, want %q", got, want)
		}
	}
	if strings.Contains(got, " -e") {
		t.Errorf("capture asked for escapes: %q", got)
	}
	var ie inputError
	if _, err := (tmuxMux{}).ReadText(context.Background(), "nope;", 5, &b); !errors.As(err, &ie) {
		t.Errorf("bad id: %v", err)
	}
}

func TestTmuxReadTextErrors(t *testing.T) {
	usePsmux(t, false)
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": {stderr: "can't find window: 9", code: 1}})
	var ie inputError
	var b strings.Builder
	if _, err := (tmuxMux{}).ReadText(context.Background(), "9", 5, &b); !errors.As(err, &ie) {
		t.Errorf("missing window: %v", err)
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"capture-pane": {stderr: "can't find window: 9", code: 1}})
	if _, err := (tmuxMux{}).ReadText(context.Background(), "9", 5, &b); !errors.As(err, &ie) {
		t.Errorf("window gone before the capture: %v", err)
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"capture-pane": {stderr: "server exited", code: 1}})
	_, err := (tmuxMux{}).ReadText(context.Background(), "9", 5, &b)
	if err == nil || errors.As(err, &ie) || !strings.Contains(err.Error(), "server exited") {
		t.Errorf("tmux failure: %v", err)
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": {stderr: "no server running", code: 1}})
	_, err = (tmuxMux{}).ReadText(context.Background(), "9", 5, &b)
	if err == nil || errors.As(err, &ie) {
		t.Errorf("history size failure: %v", err)
	}
}

func TestTmuxReadTextPsmux(t *testing.T) {
	usePsmux(t, true)
	args := useFakeTmux(t, "")
	var b strings.Builder
	if _, err := (tmuxMux{}).ReadText(context.Background(), "1", 5, &b); !errors.Is(err, errUnsupported) {
		t.Errorf("psmux: %v", err)
	}
	if args() != "" {
		t.Errorf("psmux ran %q", args())
	}
	if (tmuxMux{}).Caps().PaneText {
		t.Error("caps.paneText on psmux")
	}
	usePsmux(t, false)
	if !(tmuxMux{}).Caps().PaneText {
		t.Error("caps.paneText off on tmux")
	}
}

func TestHerdrReadText(t *testing.T) {
	f := newFakeHerdr(t)
	f.readText = "old\nnew\n"
	f.scrollMax = 40
	m := newTestHerdrMux(t, f)
	ctx := context.Background()
	if !m.Caps().PaneText {
		t.Error("caps.paneText off on herdr")
	}
	var b strings.Builder
	if more, err := m.ReadText(ctx, "wR:p3", 1000, &b); err != nil || more {
		t.Fatalf("more %v, %v: 40 rows of history", more, err)
	}
	if b.String() != "old\nnew\n" {
		t.Errorf("text = %q", b.String())
	}
	p := f.lastParams(t, "pane.read")
	if p["pane_id"] != "wR:p3" || p["source"] != "recent_unwrapped" || p["format"] != "text" || p["lines"] != float64(1000) {
		t.Errorf("pane.read params = %v", p)
	}
	if more, err := m.ReadText(ctx, "wR:p3", 39, &strings.Builder{}); err != nil || !more {
		t.Fatalf("more %v, %v: 40 rows past 39", more, err)
	}

	var ie inputError
	if _, err := m.ReadText(ctx, "-bad", 5, &b); !errors.As(err, &ie) {
		t.Errorf("invalid id: %v", err)
	}
	if _, err := m.ReadText(ctx, "wR:nope", 5, &b); !errors.As(err, &ie) {
		t.Errorf("unknown pane: %v", err)
	}

	f.mu.Lock()
	f.getFail = "pane_not_found"
	f.mu.Unlock()
	if _, err := m.ReadText(ctx, "wR:p3", 5, &b); !errors.As(err, &ie) {
		t.Errorf("pane gone before pane.get: %v", err)
	}
	f.mu.Lock()
	f.getFail = ""
	f.readFail = "pane_not_found"
	f.mu.Unlock()
	if _, err := m.ReadText(ctx, "wR:p3", 5, &b); !errors.As(err, &ie) {
		t.Errorf("pane gone: %v", err)
	}
	f.mu.Lock()
	f.readFail = "invalid_request"
	f.mu.Unlock()
	if _, err := m.ReadText(ctx, "wR:p3", 5, &b); !errors.Is(err, errUnsupported) {
		t.Errorf("older herdr: %v", err)
	}
	f.mu.Lock()
	f.readFail = "internal_error"
	f.mu.Unlock()
	if _, err := m.ReadText(ctx, "wR:p3", 5, &b); err == nil || errors.As(err, &ie) || errors.Is(err, errUnsupported) {
		t.Errorf("herdr failure: %v", err)
	}
}

// failWriter fails every write.
type failWriter struct{}

func (failWriter) Write([]byte) (int, error) { return 0, errors.New("write failed") }

func TestHerdrReadTextWriteError(t *testing.T) {
	f := newFakeHerdr(t)
	f.readText = "x"
	m := newTestHerdrMux(t, f)
	if _, err := m.ReadText(context.Background(), "wR:p3", 5, failWriter{}); err == nil {
		t.Error("write error lost")
	}
}

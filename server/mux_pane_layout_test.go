package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParsePaneLayoutArgs(t *testing.T) {
	for _, s := range []string{"right", "down"} {
		if d, err := parseSplitDir(s); err != nil || string(d) != s {
			t.Errorf("parseSplitDir(%q) = %q %v", s, d, err)
		}
	}
	for _, s := range []string{"toggle", "on", "off"} {
		if m, err := parseZoomMode(s); err != nil || string(m) != s {
			t.Errorf("parseZoomMode(%q) = %q %v", s, m, err)
		}
	}
	for _, s := range []string{"prev", "next"} {
		if d, err := parseSwapDir(s); err != nil || string(d) != s {
			t.Errorf("parseSwapDir(%q) = %q %v", s, d, err)
		}
	}
	for _, s := range []string{"left", "right", "up", "down"} {
		if d, err := parseResizeDir(s); err != nil || string(d) != s {
			t.Errorf("parseResizeDir(%q) = %q %v", s, d, err)
		}
	}
	// Anything else, case and spaces included, is refused with its code.
	for _, s := range []string{"", "left", "Right", " down", "up"} {
		if _, err := parseSplitDir(s); !errors.Is(err, errInvalidDirection) {
			t.Errorf("parseSplitDir(%q) = %v", s, err)
		}
	}
	for _, s := range []string{"", "Toggle", "zoom"} {
		if _, err := parseZoomMode(s); !errors.Is(err, errInvalidMode) {
			t.Errorf("parseZoomMode(%q) = %v", s, err)
		}
	}
	for _, s := range []string{"", "up", "previous"} {
		if _, err := parseSwapDir(s); !errors.Is(err, errInvalidDirection) {
			t.Errorf("parseSwapDir(%q) = %v", s, err)
		}
	}
	for _, s := range []string{"", "Left", "north"} {
		if _, err := parseResizeDir(s); !errors.Is(err, errInvalidDirection) {
			t.Errorf("parseResizeDir(%q) = %v", s, err)
		}
	}
	for n, want := range map[float64]error{0: errInvalidAmount, 1: nil, 50: nil, 51: errInvalidAmount, -3: errInvalidAmount,
		1.5: errInvalidAmount, 1e300: errInvalidAmount} {
		if err := checkResizeAmount(n); !errors.Is(err, want) {
			t.Errorf("checkResizeAmount(%v) = %v, want %v", n, err, want)
		}
	}
}

func TestSwapNeighbor(t *testing.T) {
	panes := []string{"a", "b", "c"}
	for _, tc := range []struct {
		pane string
		dir  SwapDir
		want string
		err  error
	}{
		{"b", SwapPrev, "a", nil},
		{"b", SwapNext, "c", nil},
		{"a", SwapPrev, "", errNoNeighbor},
		{"c", SwapNext, "", errNoNeighbor},
		{"z", SwapNext, "", errUnknownPane},
	} {
		got, err := swapNeighbor(panes, tc.pane, tc.dir)
		if got != tc.want || !errors.Is(err, tc.err) {
			t.Errorf("swapNeighbor(%q, %s) = %q %v, want %q %v", tc.pane, tc.dir, got, err, tc.want, tc.err)
		}
	}
}

func TestPaneMissing(t *testing.T) {
	for err, want := range map[error]bool{
		inputError("invalid pane id"): true,
		errUnknownPane:                true,
		errNoNeighbor:                 false,
		errors.New("lost"):            false,
		nil:                           false,
	} {
		if paneMissing(err) != want {
			t.Errorf("paneMissing(%v) = %v", err, !want)
		}
	}
}

// psmux offers no layout action: every one is unsupported.
func TestPaneLayoutUnsupported(t *testing.T) {
	ctx := context.Background()
	usePsmux(t, true)
	for name, m := range map[string]Mux{"psmux": tmuxMux{}} {
		_, split := m.SplitPane(ctx, "1", SplitRight, "")
		for op, err := range map[string]error{
			"split":  split,
			"zoom":   m.ZoomPane(ctx, "1", ZoomOn),
			"swap":   m.SwapPane(ctx, "1", SwapNext),
			"resize": m.ResizePane(ctx, "1", ResizeUp, 1),
		} {
			if !errors.Is(err, errPaneLayoutUnsupported) {
				t.Errorf("%s %s = %v", name, op, err)
			}
		}
	}
}

// The layout routes: guarded like every write, their arguments checked
// before the backend is asked, the backend's errors answered with codes.
func TestPaneLayoutRoutes(t *testing.T) {
	routes := []struct{ path, body, call string }{
		{"/api/mux/panes/%254/split", `{"direction":"down"}`, "split %4 down "},
		{"/api/mux/panes/%254/zoom", `{"mode":"toggle"}`, "zoom %4 toggle"},
		{"/api/mux/panes/%254/swap", `{"direction":"prev"}`, "swap %4 prev"},
		{"/api/mux/panes/%254/resize", `{"direction":"left","amount":5}`, "resize %4 left 5"},
	}
	for _, rt := range routes {
		m := &fakeMux{}
		h := newTestHandler(t, m)
		rec := serve(h, apiRequest(http.MethodPost, rt.path, rt.body))
		body := decodeBody(t, rec)
		if rec.Code != http.StatusOK || body["ok"] != true || len(m.calls) != 1 || m.calls[0] != rt.call {
			t.Errorf("%s: %d %v, calls %v", rt.path, rec.Code, body, m.calls)
		}
		if strings.HasSuffix(rt.path, "/split") && body["id"] != "%4+" {
			t.Errorf("split id = %v", body["id"])
		}

		guards := []struct {
			name   string
			mod    func(*http.Request)
			status int
		}{
			{"cross-site", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, 403},
			{"foreign origin", func(r *http.Request) { r.Header.Del("Sec-Fetch-Site"); r.Header.Set("Origin", "https://evil.example") }, 403},
			{"not JSON", func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 415},
			{"no auth", func(r *http.Request) { r.Header.Del("Authorization") }, 401},
		}
		for _, g := range guards {
			req := apiRequest(http.MethodPost, rt.path, rt.body)
			g.mod(req)
			if rec := serve(h, req); rec.Code != g.status {
				t.Errorf("%s %s: %d, want %d", g.name, rt.path, rec.Code, g.status)
			}
		}
		if rec := serve(h, apiRequest(http.MethodGet, rt.path, "")); rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("GET %s: %d", rt.path, rec.Code)
		}
		big := `{"mode":"` + strings.Repeat("a", maxJSONBody) + `"}`
		if rec := serve(h, apiRequest(http.MethodPost, rt.path, big)); rec.Code != http.StatusBadRequest {
			t.Errorf("large body %s: %d", rt.path, rec.Code)
		}
		for err, want := range map[error]string{errUnknownPane: "unknown_pane", errPaneLayoutUnsupported: "unsupported",
			errNoNeighbor: "no_neighbor", errLastPane: "last_pane"} {
			rec := serve(newTestHandler(t, &fakeMux{err: err}), apiRequest(http.MethodPost, rt.path, rt.body))
			if got := decodeBody(t, rec); rec.Code != err.(*codedError).status || got["code"] != want {
				t.Errorf("%s with %s: %d %v", rt.path, want, rec.Code, got)
			}
		}
		rec = serve(newTestHandler(t, &fakeMux{err: errors.New("tmux: /secret/sock gone")}), apiRequest(http.MethodPost, rt.path, rt.body))
		if rec.Code != http.StatusInternalServerError || strings.Contains(rec.Body.String(), "secret") {
			t.Errorf("%s backend failure: %d %s", rt.path, rec.Code, rec.Body)
		}
	}

	// Arguments outside their words or bounds: 400 with a code, nothing asked.
	for _, c := range []struct{ path, body, code string }{
		{"split", `{"direction":"left"}`, "invalid_direction"},
		{"split", `{}`, "invalid_direction"},
		{"zoom", `{"mode":"maybe"}`, "invalid_mode"},
		{"swap", `{"direction":"up"}`, "invalid_direction"},
		{"resize", `{"direction":"north","amount":1}`, "invalid_direction"},
		{"resize", `{"direction":"up","amount":0}`, "invalid_amount"},
		{"resize", `{"direction":"up","amount":51}`, "invalid_amount"},
		{"resize", `{"direction":"up","amount":1.5}`, "invalid_amount"},
		{"resize", `{"direction":"up"}`, "invalid_amount"},
		{"split", `{"direction":"right","cwd":"relative/dir"}`, "invalid_cwd"},
		{"split", `{"direction":"right","cwd":"/no/such/termote/dir"}`, "not_found"},
	} {
		m := &fakeMux{}
		rec := serve(newTestHandler(t, m), apiRequest(http.MethodPost, "/api/mux/panes/1/"+c.path, c.body))
		if got := decodeBody(t, rec); rec.Code >= 500 || got["code"] != c.code || len(m.calls) != 0 {
			t.Errorf("%s %s: %d %v, calls %v", c.path, c.body, rec.Code, got, m.calls)
		}
	}
	if rec := serve(newTestHandler(t, &fakeMux{}), apiRequest(http.MethodPost, "/api/mux/panes/1/split", `{"direction":`)); rec.Code != http.StatusBadRequest {
		t.Errorf("broken JSON: %d", rec.Code)
	}

	// A cwd is resolved (symlinks too) before the backend gets it; empty
	// stays empty, the pane's own directory.
	dir := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(dir, link); err != nil {
		t.Fatal(err)
	}
	real, _ := filepath.EvalSymlinks(dir)
	m := &fakeMux{}
	h := newTestHandler(t, m)
	serve(h, apiRequest(http.MethodPost, "/api/mux/panes/1/split", `{"direction":"right","cwd":"`+link+`"}`))
	serve(h, apiRequest(http.MethodPost, "/api/mux/panes/1/split", `{"direction":"right"}`))
	if len(m.calls) != 2 || m.calls[0] != "split 1 right "+real || m.calls[1] != "split 1 right " {
		t.Errorf("calls = %q", m.calls)
	}
}

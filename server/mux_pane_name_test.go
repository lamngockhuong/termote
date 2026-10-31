package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestValidPaneName(t *testing.T) {
	for _, name := range []string{"", "build", "Bản dựng", "PR #42", "a#{pane_id}", "a:b", strings.Repeat("x", 64), "ứ" + strings.Repeat("x", 61)} {
		if !validPaneName(name) {
			t.Errorf("validPaneName(%q) = false", name)
		}
	}
	for _, name := range []string{"a;", "-x", "a\x1bb", "a\nb", "a\x7f", "a\u0085b", "a‮b", "a​b", "a\xffb", strings.Repeat("x", 65), "ứ" + strings.Repeat("x", 62)} {
		if validPaneName(name) {
			t.Errorf("validPaneName(%q) = true", name)
		}
	}
}

func TestCleanPaneName(t *testing.T) {
	for in, want := range map[string]string{
		"build":                     "build",
		"a‮b\x1b[31m":               "ab[31m",
		strings.Repeat("ứ", 30):     strings.Repeat("ứ", 21), // 63 bytes: no rune cut in half
		"<b>x</b>":                  "<b>x</b>",
		"\xff":                      "",
		"line\nbreak and tab\there": "linebreak and tabhere",
		"  ":                        "",
		" \u200b api \u200b ":       "api",
	} {
		if got := cleanPaneName(in); got != want {
			t.Errorf("cleanPaneName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCleanMeta(t *testing.T) {
	if got := cleanMeta(nil); got != nil {
		t.Errorf("cleanMeta(nil) = %v", got)
	}
	got := cleanMeta(map[string]string{
		"env":                   "<script>x</script>",
		"a b":                   "bad key",
		"":                      "empty key",
		"long":                  strings.Repeat("ệ", 200),
		"bidi":                  "pr‮42​",
		"blank":                 " ​ ",
		strings.Repeat("k", 33): "too long a key",
	})
	want := []MetaToken{{"bidi", "pr42"}, {"env", "<script>x</script>"}, {"long", strings.Repeat("ệ", 64)}}
	if !slices.Equal(got, want) {
		t.Errorf("cleanMeta = %q, want %q", got, want)
	}
	many := map[string]string{}
	for i := range 20 {
		many[fmt.Sprintf("k%02d", i)] = "v"
	}
	got = cleanMeta(many)
	if len(got) != maxMetaTokens || got[0].Key != "k00" || got[7].Key != "k07" {
		t.Errorf("20 tokens = %v, want the first 8 by key", got)
	}
}

func TestWithoutMeta(t *testing.T) {
	meta := []MetaToken{{"env", "dev"}}
	s := Snapshot{Groups: []Group{{ID: "g", Meta: meta, Tabs: []Tab{{ID: "t", Panes: []Pane{{ID: "p", Name: "build", Meta: meta}}}}}}}
	v := withoutMeta(s)
	if v.Groups[0].Meta != nil || v.Groups[0].Tabs[0].Panes[0].Meta != nil || v.Groups[0].Tabs[0].Panes[0].Name != "build" {
		t.Errorf("withoutMeta = %+v", v)
	}
	if s.Groups[0].Meta == nil || s.Groups[0].Tabs[0].Panes[0].Meta == nil {
		t.Error("withoutMeta changed the snapshot it was given")
	}
	if got := withoutMeta(Snapshot{}); got.Groups != nil {
		t.Errorf("withoutMeta(empty) = %+v", got)
	}
}

// PATCH /api/mux/panes/{id}: guarded like every write, the name checked
// before the backend is asked, the backend's errors answered with codes.
func TestRenamePaneRoute(t *testing.T) {
	const path = "/api/mux/panes/%254"
	m := &fakeMux{}
	h := newTestHandler(t, m)
	for _, body := range []string{`{"name":"build"}`, `{"name":""}`, `{}`} {
		rec := serve(h, apiRequest(http.MethodPatch, path, body))
		if rec.Code != http.StatusOK || decodeBody(t, rec)["ok"] != true {
			t.Errorf("%s: %d %s", body, rec.Code, rec.Body)
		}
	}
	if want := []string{"rename pane %4=build", "rename pane %4=", "rename pane %4="}; !slices.Equal(m.calls, want) {
		t.Errorf("calls = %q, want %q", m.calls, want)
	}
	// DELETE still closes the pane; any other method is refused.
	m.calls = nil
	if rec := serve(h, apiRequest(http.MethodDelete, path, "")); rec.Code != http.StatusOK || !slices.Equal(m.calls, []string{"close pane %4"}) {
		t.Errorf("DELETE: %d, calls %v", rec.Code, m.calls)
	}
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut} {
		rec := serve(h, apiRequest(method, path, "{}"))
		if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "PATCH, DELETE" {
			t.Errorf("%s: %d, Allow %q", method, rec.Code, rec.Header().Get("Allow"))
		}
	}

	m.calls = nil
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
		req := apiRequest(http.MethodPatch, path, `{"name":"x"}`)
		g.mod(req)
		if rec := serve(h, req); rec.Code != g.status {
			t.Errorf("%s: %d, want %d", g.name, rec.Code, g.status)
		}
	}
	big := `{"name":"` + strings.Repeat("a", maxJSONBody) + `"}`
	if rec := serve(h, apiRequest(http.MethodPatch, path, big)); rec.Code != http.StatusBadRequest {
		t.Errorf("large body: %d", rec.Code)
	}
	if rec := serve(h, apiRequest(http.MethodPatch, path, `{"name":`)); rec.Code != http.StatusBadRequest {
		t.Errorf("broken JSON: %d", rec.Code)
	}
	for _, name := range []string{"a;", "-x", "a‮b", strings.Repeat("x", 65)} {
		b, _ := json.Marshal(map[string]string{"name": name})
		rec := serve(h, apiRequest(http.MethodPatch, path, string(b)))
		if got := decodeBody(t, rec); rec.Code != http.StatusBadRequest || got["code"] != "invalid_name" {
			t.Errorf("name %q: %d %v", name, rec.Code, got)
		}
	}
	if len(m.calls) != 0 {
		t.Errorf("backend asked for a refused request: %v", m.calls)
	}

	for err, want := range map[error]string{errUnknownPane: "unknown_pane"} {
		rec := serve(newTestHandler(t, &fakeMux{err: err}), apiRequest(http.MethodPatch, path, `{"name":"x"}`))
		if got := decodeBody(t, rec); rec.Code != http.StatusNotFound || got["code"] != want {
			t.Errorf("with %s: %d %v", want, rec.Code, got)
		}
	}
	if rec := serve(newTestHandler(t, &fakeMux{err: errUnsupported}), apiRequest(http.MethodPatch, path, `{"name":"x"}`)); rec.Code != http.StatusNotImplemented {
		t.Errorf("unsupported: %d", rec.Code)
	}
	rec := serve(newTestHandler(t, &fakeMux{err: errors.New("tmux: /secret/sock gone")}), apiRequest(http.MethodPatch, path, `{"name":"x"}`))
	if rec.Code != http.StatusInternalServerError || strings.Contains(rec.Body.String(), "secret") {
		t.Errorf("backend failure: %d %s", rec.Code, rec.Body)
	}
}

// A view-only client is told it cannot rename, and gets the pane names but
// no metadata; a full client gets both.
func TestSnapshotPaneNamesAndMetaByRole(t *testing.T) {
	meta := []MetaToken{{"env", "<b>dev</b>"}}
	snap := Snapshot{Groups: []Group{{ID: "main", Name: "main", Meta: meta, Tabs: []Tab{
		{ID: "0", Name: "shell", Active: true, Panes: []Pane{{ID: "0", Active: true, Name: "build", Meta: meta}}},
	}}}}
	m := &viewMux{fakeMux: &fakeMux{snap: snap, caps: &Caps{RenamePane: true}}}
	h, _ := newRoleHandler(t, m, true)
	read := func(req *http.Request) Snapshot {
		t.Helper()
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		var s Snapshot
		if err := json.Unmarshal(rec.Body.Bytes(), &s); err != nil || rec.Code != http.StatusOK {
			t.Fatalf("snapshot: %d %s", rec.Code, rec.Body)
		}
		return s
	}
	// The service worker of a view-only device peeks: no metadata either
	if peek := read(viewRequest("GET", "/api/mux/snapshot?peek=1", "")); peek.Groups[0].Meta != nil ||
		peek.Groups[0].Tabs[0].Panes[0].Meta != nil || peek.Groups[0].Tabs[0].Panes[0].Name != "build" {
		t.Errorf("view-only peek = %+v", peek)
	}
	view := read(viewRequest("GET", "/api/mux/snapshot", ""))
	if view.Caps.RenamePane || view.Groups[0].Meta != nil || view.Groups[0].Tabs[0].Panes[0].Meta != nil ||
		view.Groups[0].Tabs[0].Panes[0].Name != "build" {
		t.Errorf("view-only snapshot = %+v", view)
	}
	full := apiRequest("GET", "/api/mux/snapshot", "")
	full.Header.Del("Authorization")
	s := read(full)
	if !s.Caps.RenamePane || !slices.Equal(s.Groups[0].Meta, meta) || !slices.Equal(s.Groups[0].Tabs[0].Panes[0].Meta, meta) {
		t.Errorf("full snapshot = %+v", s)
	}
	if m.snap.Groups[0].Meta == nil {
		t.Error("the view-only read changed the backend's snapshot")
	}
}

// Herdr: pane.rename from 0.9.3, a null label clearing the name; the label
// and the tokens read back from session.snapshot, cleaned.
func TestHerdrRenamePane(t *testing.T) {
	ctx := context.Background()
	f, m := newLayoutHerdr(t, "0.9.3")
	if !m.Caps().RenamePane {
		t.Fatal("caps.renamePane off on 0.9.3")
	}
	if err := m.RenamePane(ctx, "w13:p1", "build"); err != nil {
		t.Fatal(err)
	}
	if p := f.lastParams(t, "pane.rename"); p["pane_id"] != "w13:p1" || p["label"] != "build" {
		t.Errorf("pane.rename params = %v", p)
	}
	if err := m.RenamePane(ctx, "w13:p1", ""); err != nil {
		t.Fatal(err)
	}
	if p := f.lastParams(t, "pane.rename"); p["pane_id"] != "w13:p1" || p["label"] != nil {
		t.Errorf("clearing params = %v, want a null label", p)
	}
	if err := m.RenamePane(ctx, "wR:pZZ", "x"); !errors.Is(err, errUnknownPane) {
		t.Errorf("unknown pane = %v", err)
	}
	if err := m.RenamePane(ctx, "--help", "x"); !paneMissing(err) {
		t.Errorf("bad id = %v", err)
	}
	for code, want := range map[string]error{
		"pane_not_found": errUnknownPane,
		"tab_not_found":  errUnknownPane,
		"unknown_method": errUnsupported,
		"internal_error": nil,
	} {
		f.mu.Lock()
		f.layoutFail = map[string]string{"pane.rename": code}
		f.mu.Unlock()
		err := m.RenamePane(ctx, "w13:p1", "x")
		if want == nil {
			var he *herdrError
			if !errors.As(err, &he) || he.Code != code {
				t.Errorf("failing with %s = %v", code, err)
			}
			continue
		}
		if !errors.Is(err, want) {
			t.Errorf("failing with %s = %v, want %v", code, err, want)
		}
	}
	f.mu.Lock()
	f.layoutFail = map[string]string{"pane.rename": "invalid_request"}
	f.layoutMessage = "unknown variant `pane.rename`"
	f.mu.Unlock()
	if err := m.RenamePane(ctx, "w13:p1", "x"); !errors.Is(err, errUnsupported) {
		t.Errorf("invalid_request naming the method = %v", err)
	}
	if err := herdrRenameError(errors.New("lost")); err == nil || err.Error() != "lost" {
		t.Errorf("herdrRenameError(non-herdr) = %v", err)
	}

	// An older Herdr is never asked.
	old, oldMux := newLayoutHerdr(t, "0.9.2")
	if oldMux.Caps().RenamePane {
		t.Error("caps.renamePane on 0.9.2")
	}
	if err := oldMux.RenamePane(ctx, "w13:p1", "x"); !errors.Is(err, errUnsupported) || old.count("pane.rename") != 0 {
		t.Errorf("0.9.2: %v, %d calls", err, old.count("pane.rename"))
	}
}

func TestHerdrSnapshotPaneNamesAndMeta(t *testing.T) {
	f, m := newLayoutHerdr(t, "0.9.3")
	f.mu.Lock()
	for _, p := range f.snapshot["panes"].([]any) {
		p := p.(map[string]any)
		switch p["pane_id"] {
		case "w13:p1":
			p["label"] = "build‮<script>"
			p["tokens"] = map[string]any{"env": "<b>dev</b>", "a b": "x"}
		case "w13:pC":
			p["label"] = nil
		}
	}
	for _, w := range f.snapshot["workspaces"].([]any) {
		if w := w.(map[string]any); w["workspace_id"] == "w13" {
			w["tokens"] = map[string]any{"pr": "#42", "long": strings.Repeat("x", 200)}
		}
	}
	f.mu.Unlock()
	m.invalidate()
	s, err := m.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	g, _, p, ok := findSnapshotPane(s, "w13:p1", false)
	if !ok || p.Name != "build<script>" || !slices.Equal(p.Meta, []MetaToken{{"env", "<b>dev</b>"}}) {
		t.Errorf("w13:p1 = %+v", p)
	}
	if want := []MetaToken{{"long", strings.Repeat("x", 64)}, {"pr", "#42"}}; !slices.Equal(g.Meta, want) {
		t.Errorf("w13 meta = %v, want %v", g.Meta, want)
	}
	if _, _, p, _ := findSnapshotPane(s, "w13:pC", false); p.Name != "" || p.Meta != nil {
		t.Errorf("w13:pC = %+v", p)
	}
}

// workspace.metadata_updated is subscribed from 0.9.3 only: an older Herdr
// refuses an event it does not know, and the whole subscription with it.
func TestHerdrMetaEventSubscription(t *testing.T) {
	for v, want := range map[string]bool{"0.9.2": false, "0.9.3": true} {
		f, _ := newLayoutHerdr(t, v)
		if got := slices.Contains(f.subscribedTypes(), "workspace.metadata_updated"); got != want {
			t.Errorf("%s subscribed workspace.metadata_updated = %v", v, got)
		}
	}
	for v, want := range map[string]bool{"0.9.3": true, "0.10.0": true, "0.9.2": false, "": false, "x": false} {
		if herdrCanPaneMeta(v) != want {
			t.Errorf("herdrCanPaneMeta(%q) != %v", v, want)
		}
	}
}

// setTmuxVersion makes the cached tmux server version major.minor.
func setTmuxVersion(t *testing.T, major, minor int) {
	t.Helper()
	tmuxVersion.Lock()
	tmuxVersion.major, tmuxVersion.minor, tmuxVersion.ok = major, minor, true
	tmuxVersion.Unlock()
	t.Cleanup(resetTmuxVersion)
}

func TestTmuxRenamePaneUnsupported(t *testing.T) {
	ctx := context.Background()
	calls := useFakeTmuxScript(t, nil)
	setTmuxVersion(t, 2, 9)
	if (tmuxMux{}).Caps().RenamePane || listTmuxPaneNames(ctx) != nil {
		t.Error("tmux 2.9 offers pane names")
	}
	if err := (tmuxMux{}).RenamePane(ctx, "%1", "x"); !errors.Is(err, errUnsupported) {
		t.Errorf("tmux 2.9 = %v", err)
	}
	usePsmux(t, true)
	setTmuxVersion(t, 3, 6)
	if err := (tmuxMux{}).RenamePane(ctx, "1", "x"); !errors.Is(err, errUnsupported) {
		t.Errorf("psmux = %v", err)
	}
	if got := calls(); got != "" {
		t.Errorf("tmux ran: %q", got)
	}
}

func TestTmuxRenamePaneFake(t *testing.T) {
	ctx := context.Background()
	calls := useFakeTmuxScript(t, map[string]fakeTmuxReply{
		"display-message": {out: "$1:2:%7:2:0:1:main\n"},
		"set-option":      {},
	})
	setTmuxVersion(t, 3, 0)
	if !(tmuxMux{}).Caps().RenamePane {
		t.Error("tmux 3.0 does not offer pane names")
	}
	if err := (tmuxMux{}).RenamePane(ctx, "%7", "PR #42"); err != nil {
		t.Fatal(err)
	}
	if err := (tmuxMux{}).RenamePane(ctx, "%7", ""); err != nil {
		t.Fatal(err)
	}
	if err := (tmuxMux{}).RenamePane(ctx, "bad id", "x"); !paneMissing(err) {
		t.Errorf("bad id = %v", err)
	}
	log := calls()
	for _, want := range []string{"set-option -p -t %7 @termote-name PR #42\n", "set-option -p -u -t %7 @termote-name\n"} {
		if !strings.Contains(log, want) {
			t.Errorf("log %q lacks %q", log, want)
		}
	}
	// A pane that went away between the check and the call.
	useFakeTmuxScript(t, map[string]fakeTmuxReply{
		"display-message": {out: "$1:2:%7:2:0:1:main\n"},
		"set-option":      {stderr: "no such pane: %7", code: 1},
	})
	setTmuxVersion(t, 3, 6)
	if err := (tmuxMux{}).RenamePane(ctx, "%7", "x"); !errors.Is(err, errUnknownPane) {
		t.Errorf("pane gone = %v", err)
	}
}

// A failing list never fails the snapshot: the panes show without names.
func TestListTmuxPaneNames(t *testing.T) {
	ctx := context.Background()
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"-u list-panes": {out: "%1:5:build\n"}})
	setTmuxVersion(t, 3, 0)
	if got := listTmuxPaneNames(ctx); fmt.Sprint(got) != "map[%1:build]" {
		t.Errorf("names = %v", got)
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"-u list-panes": {stderr: "no server", code: 1}})
	setTmuxVersion(t, 3, 0)
	if got := listTmuxPaneNames(ctx); got != nil {
		t.Errorf("names on a failure = %v", got)
	}
}

func TestParseTmuxPaneNames(t *testing.T) {
	for _, c := range []struct {
		out  string
		want map[string]string
	}{
		{"", map[string]string{}},
		{"%1:0:\n%2:5:build\n", map[string]string{"%2": "build"}},
		{"%1:0:\r\n%2:5:build", map[string]string{"%2": "build"}},
		// A name holding ':' and a newline that looks like an entry.
		{"%1:15:a:b\n%9:5:forged\n%2:2:ok\n", map[string]string{"%1": "a:b%9:5:forged", "%2": "ok"}},
		{"%3:6:Việt\n", map[string]string{"%3": "Việt"}},
		// Unreadable: the entries before it are kept.
		{"%1:2:ok\n%2:99:short\n", map[string]string{"%1": "ok"}},
		{"%1:2:ok\nx:1:a\n", map[string]string{"%1": "ok"}},
		{"%1:2:okX%2:1:a\n", map[string]string{"%1": "ok"}},
		{"%1:-1:a\n", map[string]string{}},
		{"%1:2\n", map[string]string{}},
	} {
		if got := parseTmuxPaneNames([]byte(c.out)); fmt.Sprint(got) != fmt.Sprint(c.want) {
			t.Errorf("parseTmuxPaneNames(%q) = %v, want %v", c.out, got, c.want)
		}
	}
	groups := []tmuxGroup{{Group: Group{Tabs: []Tab{{Panes: []Pane{{ID: "%1"}, {ID: "%2"}}}}}}}
	attachTmuxPaneNames(groups, nil)
	attachTmuxPaneNames(groups, map[string]string{"%2": "build"})
	if p := groups[0].Tabs[0].Panes; p[0].Name != "" || p[1].Name != "build" {
		t.Errorf("panes = %+v", p)
	}
}

// On a real tmux: the name is stored verbatim, read back without a UTF-8
// locale, survives a newline in it without losing the window, and clears.
func TestTmuxRenamePaneReal(t *testing.T) {
	useRealTmux(t, fmt.Sprintf("termote-name-%d", os.Getpid()))
	t.Setenv("LC_ALL", "C")
	t.Setenv("LANG", "C")
	ctx := context.Background()
	m := tmuxMux{}
	if _, err := m.Snapshot(ctx); err != nil {
		t.Fatal(err)
	}
	resetTmuxVersion()
	if !m.Caps().RenamePane {
		t.Skip("needs tmux 3.0 or later")
	}
	newID, err := m.SplitPane(ctx, "0", SplitRight, "")
	if err != nil {
		t.Fatal(err)
	}
	stored := func(pane string) string {
		out, _ := tmuxCmd(ctx, "-u", "show-options", "-p", "-v", "-t", pane, tmuxPaneNameOption).Output()
		return strings.TrimSuffix(string(out), "\n")
	}
	names := func() map[string]string {
		s, err := m.Snapshot(ctx)
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]string{}
		for _, p := range s.Groups[0].Tabs[0].Panes {
			got[p.ID] = p.Name
		}
		return got
	}
	for _, name := range []string{"PR #42", "a#{pane_id}", "Bản dựng"} {
		if err := m.RenamePane(ctx, newID, name); err != nil {
			t.Fatal(err)
		}
		if got := stored(newID); got != name {
			t.Errorf("stored %q, want %q", got, name)
		}
		if got := names()[newID]; got != name {
			t.Errorf("snapshot name %q, want %q", got, name)
		}
	}
	// A tab id names the window's active pane (the first one: split -d).
	if err := m.RenamePane(ctx, "0", "tab"); err != nil {
		t.Fatal(err)
	}
	// Another process puts a newline and a forged entry in the option.
	tmuxCmd(ctx, "set-option", "-p", "-t", newID, tmuxPaneNameOption, "x\n%999:3:bad").Run()
	got := names()
	if len(got) != 2 || got[newID] != "x%999:3:bad" {
		t.Errorf("names = %q", got)
	}
	if !slices.Contains(mapValues(got), "tab") {
		t.Errorf("tab id rename not shown: %q", got)
	}
	if err := m.RenamePane(ctx, newID, ""); err != nil {
		t.Fatal(err)
	}
	if got := names()[newID]; got != "" || stored(newID) != "" {
		t.Errorf("cleared name = %q, stored %q", got, stored(newID))
	}
	if err := m.ClosePane(ctx, newID); err != nil {
		t.Fatal(err)
	}
	if err := m.RenamePane(ctx, newID, "x"); !errors.Is(err, errUnknownPane) {
		t.Errorf("closed pane = %v", err)
	}
}

func mapValues(m map[string]string) []string {
	var out []string
	for _, v := range m {
		out = append(out, v)
	}
	return out
}

func TestZellijRenamePane(t *testing.T) {
	ctx := context.Background()
	id := zellijPaneID("main", 1)
	log := useFakeZellij(t, map[string]string{"--version": "0\nzellij 0.45.0\n", "list-panes": zellijPanesJSON()})
	old := newTestZellijMux()
	if old.Caps().RenamePane {
		t.Error("renamePane on 0.45.0")
	}
	if err := old.RenamePane(ctx, id, "x"); !errors.Is(err, errUnsupported) || strings.Contains(log(), "rename-pane") {
		t.Errorf("0.45.0: %v, log %q", err, log())
	}

	log = useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": zellijPanesJSON()})
	m := newTestZellijMux()
	m.names = nil // set on the first rename
	if !m.Caps().RenamePane {
		t.Error("renamePane off on 0.45.1")
	}
	if err := m.RenamePane(ctx, id, "build"); err != nil {
		t.Fatal(err)
	}
	if m.names[zellijPaneKey("main", 1)].name != "build" {
		t.Errorf("names = %v", m.names)
	}
	if err := m.RenamePane(ctx, id, ""); err != nil {
		t.Fatal(err)
	}
	if len(m.names) != 0 {
		t.Errorf("names after clearing = %v", m.names)
	}
	for _, want := range []string{"rename-pane --pane-id terminal_1 -- build\n", "undo-rename-pane --pane-id terminal_1\n"} {
		if !strings.Contains(log(), want) {
			t.Errorf("log %q lacks %q", log(), want)
		}
	}
	for _, pane := range []string{"x", zellijPaneID("main", 9)} {
		if err := m.RenamePane(ctx, pane, "x"); !paneMissing(err) {
			t.Errorf("RenamePane(%s) = %v", pane, err)
		}
	}
	// A failing rename remembers nothing.
	useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": zellijPanesJSON(), "rename-pane": "1\nboom\n"})
	m = newTestZellijMux()
	if err := m.RenamePane(ctx, id, "build"); err == nil || len(m.names) != 0 {
		t.Errorf("failed rename: %v, names %v", err, m.names)
	}
}

// A Zellij pane's name is the one termote gave it while its title still is
// that name; a listing read around the rename keeps it; a pane gone forgets
// it.
func TestZellijPaneNameFromTitle(t *testing.T) {
	m := newTestZellijMux()
	set := time.Now().Add(-time.Minute)
	m.names = map[string]zellijPaneName{zellijPaneKey("main", 0): {"build", set}, zellijPaneKey("main", 1): {"api", set},
		zellijPaneKey("main", 7): {"gone", set}}
	panes := []zellijPaneInfo{{ID: 0, Title: "build"}, {ID: 1, Title: "✳ Claude Code"}, {ID: 2, Title: "zsh"}}
	// Read before (or just after) the rename: the old title says nothing
	early := zellijRead{tabs: []zellijTabInfo{{TabID: 0}}, panes: panes, at: set.Add(zellijRenameSettle / 2)}
	if g := m.buildGroup("main", early); g.Tabs[0].Panes[1].Name != "api" || m.names[zellijPaneKey("main", 1)].name != "api" {
		t.Errorf("an early read: %+v, names %v", g.Tabs[0].Panes[1], m.names)
	}
	r := zellijRead{tabs: []zellijTabInfo{{TabID: 0}}, panes: panes, at: time.Now()}
	g := m.buildGroup("main", r)
	got := []string{}
	for _, p := range g.Tabs[0].Panes {
		got = append(got, p.Name)
	}
	if !slices.Equal(got, []string{"build", "", ""}) {
		t.Errorf("names = %q", got)
	}
	if _, ok := m.names[zellijPaneKey("main", 1)]; ok {
		t.Error("a name whose title changed is still remembered")
	}
	m.pruneTabKeys([]string{"main"}, []zellijRead{r})
	if _, ok := m.names[zellijPaneKey("main", 7)]; ok || m.names[zellijPaneKey("main", 0)].name != "build" {
		t.Errorf("names after prune = %v", m.names)
	}
}

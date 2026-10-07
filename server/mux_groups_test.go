package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// groupsHandler serves the real routes over fakeMux, with deny as the files
// deny list.
func groupsHandler(t *testing.T, f *fakeMux, deny ...string) http.Handler {
	t.Helper()
	cfg := testConfig(t)
	cfg.FilesDenyDirs = deny
	h, err := newServeHandler(cfg, f)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

// replyOf decodes a JSON error reply.
func replyOf(t *testing.T, body []byte) (msg, code string) {
	t.Helper()
	var r struct{ Error, Code string }
	if err := json.Unmarshal(body, &r); err != nil {
		t.Fatalf("reply %q: %v", body, err)
	}
	return r.Error, r.Code
}

func jsonBody(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestGroupRoutes(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	f := &fakeMux{}
	h := groupsHandler(t, f)

	rec := serve(h, apiRequest(http.MethodPost, "/api/mux/groups", jsonBody(map[string]string{"name": "api", "cwd": dir})))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"id":"g9"`) {
		t.Fatalf("create = %d %s", rec.Code, rec.Body)
	}
	if rec := serve(h, apiRequest(http.MethodPatch, "/api/mux/groups/g9", `{"name":"web"}`)); rec.Code != http.StatusOK {
		t.Errorf("rename = %d %s", rec.Code, rec.Body)
	}
	if rec := serve(h, apiRequest(http.MethodDelete, "/api/mux/groups/g9", "")); rec.Code != http.StatusOK {
		t.Errorf("close = %d %s", rec.Code, rec.Body)
	}
	want := []string{"new group api in " + dir, "rename group g9=web", "close group g9"}
	if strings.Join(f.calls, "|") != strings.Join(want, "|") {
		t.Errorf("calls = %q", f.calls)
	}

	// No directory: the home directory.
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)
	f.calls = nil
	if rec := serve(h, apiRequest(http.MethodPost, "/api/mux/groups", `{"name":"home"}`)); rec.Code != http.StatusOK || f.calls[0] != "new group home in "+dir {
		t.Errorf("create without cwd = %d %s, calls %q", rec.Code, rec.Body, f.calls)
	}

	for path, allow := range map[string]string{"/api/mux/groups": "POST", "/api/mux/groups/g9": "PATCH, DELETE"} {
		rec := serve(h, apiRequest(http.MethodPut, path, "{}"))
		if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != allow || rec.Header().Get("Content-Type") != "application/json" {
			t.Errorf("PUT %s = %d, Allow %q", path, rec.Code, rec.Header().Get("Allow"))
		}
	}
}

// Every refusal before the backend carries its code, and the backend gets
// no call.
func TestGroupRoutesRefuseBadInput(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	denied := filepath.Join(root, "denied")
	file := filepath.Join(root, "file")
	os.Mkdir(denied, 0o755)
	os.WriteFile(file, nil, 0o644)
	link := filepath.Join(root, "link")
	symlinkOK := os.Symlink(denied, link) == nil
	f := &fakeMux{}
	h := groupsHandler(t, f, denied)

	long := strings.Repeat("x", 65)
	cases := []struct {
		name, method, path, body string
		status                   int
		code                     string
	}{
		{"empty name", "POST", "/api/mux/groups", `{"name":"","cwd":"` + root + `"}`, 400, "invalid_name"},
		{"long name", "POST", "/api/mux/groups", `{"name":"` + long + `"}`, 400, "invalid_name"},
		{"control char", "POST", "/api/mux/groups", `{"name":"a\nb"}`, 400, "invalid_name"},
		{"relative cwd", "POST", "/api/mux/groups", `{"name":"a","cwd":"src"}`, 400, "invalid_cwd"},
		{"missing cwd", "POST", "/api/mux/groups", jsonBody(map[string]string{"name": "a", "cwd": filepath.Join(root, "nope")}), 400, "not_found"},
		{"file cwd", "POST", "/api/mux/groups", jsonBody(map[string]string{"name": "a", "cwd": file}), 409, "not_directory"},
		{"under a file", "POST", "/api/mux/groups", jsonBody(map[string]string{"name": "a", "cwd": filepath.Join(file, "x")}), 409, "not_directory"},
		{"denied cwd", "POST", "/api/mux/groups", jsonBody(map[string]string{"name": "a", "cwd": filepath.Join(denied)}), 403, "not_allowed"},
		{"rename empty", "PATCH", "/api/mux/groups/g1", `{"name":""}`, 400, "invalid_name"},
	}
	if symlinkOK {
		cases = append(cases, struct {
			name, method, path, body string
			status                   int
			code                     string
		}{"symlink into denied", "POST", "/api/mux/groups", jsonBody(map[string]string{"name": "a", "cwd": link}), 403, "not_allowed"})
	}
	for _, c := range cases {
		rec := serve(h, apiRequest(c.method, c.path, c.body))
		_, code := replyOf(t, rec.Body.Bytes())
		if rec.Code != c.status || code != c.code {
			t.Errorf("%s: %d %q, want %d %q (%s)", c.name, rec.Code, code, c.status, c.code, rec.Body)
		}
	}
	if len(f.calls) != 0 {
		t.Errorf("backend called: %q", f.calls)
	}
}

// What a backend reports reaches the client with its code; anything else is
// logged and answered generically.
func TestGroupRoutesBackendErrors(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	for _, c := range []struct {
		err    error
		status int
		code   string
	}{
		{errUnknownGroup, 404, "unknown_group"},
		{errInvalidGroupID, 400, "invalid_group_id"},
		{errGroupExists, 409, "exists"},
		{errDefaultSession, 409, "default_session"},
		{errHasWorktrees, 409, "has_worktrees"},
		{errUnsupported, 501, "unsupported"},
		{errors.New("tmux exploded"), 500, ""},
	} {
		h := groupsHandler(t, &fakeMux{err: c.err})
		for _, req := range []*http.Request{
			apiRequest(http.MethodPost, "/api/mux/groups", jsonBody(map[string]string{"name": "a", "cwd": dir})),
			apiRequest(http.MethodPatch, "/api/mux/groups/g1", `{"name":"b"}`),
			apiRequest(http.MethodDelete, "/api/mux/groups/g1", ""),
		} {
			rec := serve(h, req)
			msg, code := replyOf(t, rec.Body.Bytes())
			if rec.Code != c.status || code != c.code || strings.Contains(msg, "exploded") {
				t.Errorf("%s %v: %d %q %q", req.Method, c.err, rec.Code, code, msg)
			}
		}
	}
}

// The guards in front of every group route answer before it, without code.
func TestGroupRoutesGuards(t *testing.T) {
	f := &fakeMux{}
	h := groupsHandler(t, f)
	routes := []struct{ method, path, body string }{
		{"POST", "/api/mux/groups", `{"name":"a"}`},
		{"PATCH", "/api/mux/groups/g1", `{"name":"a"}`},
		{"DELETE", "/api/mux/groups/g1", ""},
	}
	guards := []struct {
		name   string
		mod    func(*http.Request)
		status int
	}{
		{"cross-site", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, 403},
		{"foreign origin", func(r *http.Request) { r.Header.Del("Sec-Fetch-Site"); r.Header.Set("Origin", "https://evil.example") }, 403},
		{"not JSON", func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 415},
		{"unknown host", func(r *http.Request) { r.Host = "evil.example" }, 403},
		{"no auth", func(r *http.Request) { r.Header.Del("Authorization") }, 401},
	}
	for _, rt := range routes {
		for _, g := range guards {
			req := apiRequest(rt.method, rt.path, rt.body)
			g.mod(req)
			rec := serve(h, req)
			if rec.Code != g.status {
				t.Errorf("%s %s %s: %d, want %d", g.name, rt.method, rt.path, rec.Code, g.status)
			}
			if strings.Contains(rec.Body.String(), `"code"`) {
				t.Errorf("%s %s: guard reply has a code: %s", g.name, rt.path, rec.Body)
			}
		}
		if rt.body == "" {
			continue
		}
		big := `{"name":"` + strings.Repeat("a", maxJSONBody) + `"}`
		if rec := serve(h, apiRequest(rt.method, rt.path, big)); rec.Code != http.StatusBadRequest {
			t.Errorf("large body %s: %d", rt.path, rec.Code)
		}
	}
	if len(f.calls) != 0 {
		t.Errorf("backend called: %q", f.calls)
	}
}

func TestValidCwdForm(t *testing.T) {
	for _, c := range []struct {
		p       string
		windows bool
		want    bool
	}{
		{"/home/u", false, true},
		{"/", false, true},
		{"src", false, false},
		{"", false, false},
		{"/a\x00b", false, false},
		{"/a\nb", false, false},
		{`C:\Users\u`, true, true},
		{`c:/work`, true, true},
		{`C:`, true, false},
		{`C:work`, true, false},
		{`\\host\share`, true, false},
		{`//host/share`, true, false},
		{`\\?\C:\x`, true, false},
		{`\\.\pipe\x`, true, false},
		{`\work`, true, false},
		{`1:\x`, true, false},
	} {
		if got := validCwdForm(c.p, c.windows); got != c.want {
			t.Errorf("validCwdForm(%q, %v) = %v", c.p, c.windows, got)
		}
	}
}

// A directory that does not answer (a hung network mount) gives busy, and
// the request does not wait for it.
func TestResolveGroupCwdTimesOut(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	orig := groupCwdCheck
	groupCwdCheck = func(string, []string) (string, error) { <-release; return "", nil }
	defer func() { groupCwdCheck = orig }()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	abs := "/srv"
	if runtime.GOOS == "windows" {
		abs = `C:\srv`
	}
	if _, err := resolveGroupCwd(ctx, abs, nil); !errors.Is(err, errCwdBusy) {
		t.Errorf("resolveGroupCwd = %v, want busy", err)
	}
}

func TestResolveGroupCwdWithoutHome(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("os.UserHomeDir falls back to other variables")
	}
	t.Setenv("HOME", "")
	if _, err := resolveGroupCwd(context.Background(), "", nil); err == nil {
		t.Error("resolveGroupCwd without a home directory succeeded")
	}
}

func TestCheckGroupCwdUnreadable(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs a directory the user cannot search")
	}
	dir := t.TempDir()
	locked := filepath.Join(dir, "locked")
	os.Mkdir(locked, 0o755)
	os.Mkdir(filepath.Join(locked, "in"), 0o755)
	os.Chmod(locked, 0)
	defer os.Chmod(locked, 0o755)
	if _, err := checkGroupCwd(filepath.Join(locked, "in"), nil); !errors.Is(err, errCwdNotAllowed) {
		t.Errorf("checkGroupCwd under an unreadable dir = %v", err)
	}
}

// A request that waited past its deadline for another group change gets
// busy, without calling the backend on a dead context.
func TestGroupRoutesBusyAfterWaiting(t *testing.T) {
	f := &fakeMux{}
	g := &groupAPI{m: f}
	g.mu.Lock()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	go g.mu.Unlock()
	if g.lock(ctx) {
		t.Fatal("lock taken on an ended context")
	}
	if !g.mu.TryLock() {
		t.Fatal("mutex left held")
	}
	g.mu.Unlock()

	dir, _ := filepath.EvalSymlinks(t.TempDir())
	for _, c := range []struct {
		method, body string
		handle       http.HandlerFunc
	}{
		{"POST", jsonBody(map[string]string{"name": "a", "cwd": dir}), g.handleCreate},
		{"PATCH", `{"name":"b"}`, g.handleGroup},
		{"DELETE", "", g.handleGroup},
	} {
		g.mu.Lock()
		ctx, cancel := context.WithCancel(context.Background())
		req := apiRequest(c.method, "/api/mux/groups/g1", c.body).WithContext(ctx)
		req.SetPathValue("id", "g1")
		rec := httptest.NewRecorder()
		done := make(chan struct{})
		go func() { c.handle(rec, req); close(done) }()
		// The request waits on the mutex; its client gives up, then the
		// other change ends.
		time.Sleep(50 * time.Millisecond)
		cancel()
		g.mu.Unlock()
		<-done
		if _, code := replyOf(t, rec.Body.Bytes()); rec.Code != 503 || code != "busy" {
			t.Errorf("%s while another change ran = %d %q", c.method, rec.Code, code)
		}
	}
	if len(f.calls) != 0 {
		t.Errorf("backend called: %q", f.calls)
	}
}

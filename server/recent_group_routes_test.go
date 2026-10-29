package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// recentHandler builds a server without sign-in whose recent groups live
// in dir ("" for none), over f with groups on, deny as the files deny list
// and uploads as the upload dir; a request carrying viewDeviceHeader acts
// as a view-only device.
func recentHandler(t *testing.T, f *fakeMux, dir, uploads string, deny ...string) http.Handler {
	t.Helper()
	if f.caps == nil {
		f.caps = &Caps{Groups: true}
	}
	cfg := testConfig(t)
	cfg.NoAuth = true
	cfg.Pass = ""
	cfg.RecentGroupsDir = dir
	cfg.UploadDir = uploads
	cfg.FilesDenyDirs = deny
	h, hub, _, err := buildServer(cfg, f)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	return asRole(h, true)
}

// listRecent returns the recent groups as a full client reads them.
func listRecent(t *testing.T, h http.Handler) ([]map[string]any, bool) {
	t.Helper()
	rec := serve(h, apiRequest("GET", "/api/mux/recent-groups", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("list = %d %s", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	out := []map[string]any{}
	for _, g := range body["groups"].([]any) {
		out = append(out, g.(map[string]any))
	}
	return out, body["readOnly"] == true
}

func createGroup(t *testing.T, h http.Handler, name, cwd string) int {
	t.Helper()
	return serve(h, apiRequest("POST", "/api/mux/groups", jsonBody(map[string]string{"name": name, "cwd": cwd}))).Code
}

func TestRecentGroupRoutes(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	a := filepath.Join(base, "a")
	os.Mkdir(a, 0o700)
	// The directory as typed: through a symlink where one can be made.
	typed := a
	if runtime.GOOS != "windows" {
		typed = filepath.Join(base, "link")
		os.Symlink(a, typed)
	}
	denied := t.TempDir()
	f := &fakeMux{}
	h := recentHandler(t, f, t.TempDir(), "", denied)

	if code := createGroup(t, h, "api", typed+string(filepath.Separator)); code != http.StatusOK {
		t.Fatalf("create = %d", code)
	}
	list, ro := listRecent(t, h)
	if len(list) != 1 || ro || list[0]["name"] != "api" || list[0]["cwd"] != typed || !validRecentID(list[0]["id"].(string)) {
		t.Fatalf("list = %v %v", list, ro)
	}
	if _, ok := list[0]["real"]; ok {
		t.Error("the resolved directory reached the client")
	}

	// None is recorded without a directory, or when the group was not made.
	t.Setenv("HOME", base)
	t.Setenv("USERPROFILE", base)
	createGroup(t, h, "home", "")
	createGroup(t, h, "bad;", a)
	createGroup(t, h, "denied", denied)
	createGroup(t, h, "gone", filepath.Join(base, "gone"))
	f.err = errors.New("backend failed")
	createGroup(t, h, "failed", a)
	f.err = nil
	if list, _ := listRecent(t, h); len(list) != 1 {
		t.Fatalf("list = %v", list)
	}

	// The same directory again, as resolved: one entry, with the new name.
	id := list[0]["id"]
	createGroup(t, h, "api-2", a)
	if list, _ := listRecent(t, h); len(list) != 1 || list[0]["name"] != "api-2" || list[0]["cwd"] != a || list[0]["id"] != id {
		t.Fatalf("after again = %v", list)
	}

	path := "/api/mux/recent-groups/" + id.(string)
	if rec := serve(h, apiRequest("DELETE", path, "")); rec.Code != http.StatusOK {
		t.Fatalf("delete = %d %s", rec.Code, rec.Body)
	}
	for _, p := range []string{path, "/api/mux/recent-groups/nothex", "/api/mux/recent-groups/..%2f..%2fetc"} {
		rec := serve(h, apiRequest("DELETE", p, ""))
		if _, code := replyOf(t, rec.Body.Bytes()); rec.Code != http.StatusNotFound || code != "unknown_recent" {
			t.Errorf("delete %s = %d %s", p, rec.Code, rec.Body)
		}
	}
	if list, _ := listRecent(t, h); len(list) != 0 {
		t.Fatalf("after delete = %v", list)
	}

	for p, allow := range map[string]string{"/api/mux/recent-groups": "GET", path: "DELETE"} {
		rec := serve(h, apiRequest("PUT", p, "{}"))
		if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != allow || rec.Header().Get("Content-Type") != "application/json" {
			t.Errorf("PUT %s = %d, Allow %q", p, rec.Code, rec.Header().Get("Allow"))
		}
	}
}

func TestRecentGroupRoutesRefuse(t *testing.T) {
	h := recentHandler(t, &fakeMux{}, t.TempDir(), "")
	createGroup(t, h, "a", t.TempDir())
	list, _ := listRecent(t, h)
	path := "/api/mux/recent-groups/" + list[0]["id"].(string)
	with := func(r *http.Request, header ...string) *http.Request {
		for i := 0; i < len(header); i += 2 {
			r.Header.Set(header[i], header[i+1])
		}
		return r
	}
	for _, tc := range []struct {
		name   string
		req    *http.Request
		status int
		code   string
	}{
		{"view read", viewRequest("GET", "/api/mux/recent-groups", ""), 403, "view_only"},
		{"view delete", viewRequest("DELETE", path, ""), 403, "view_only"},
		{"cross-site read", with(apiRequest("GET", "/api/mux/recent-groups", ""), "Sec-Fetch-Site", "cross-site"), 403, ""},
		{"foreign origin read", with(apiRequest("GET", "/api/mux/recent-groups", ""), "Origin", "https://evil.test"), 403, ""},
		{"cross-site delete", with(apiRequest("DELETE", path, ""), "Sec-Fetch-Site", "cross-site"), 403, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := serve(h, tc.req)
			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tc.status, rec.Body)
			}
			if _, code := replyOf(t, rec.Body.Bytes()); tc.code != "" && code != tc.code {
				t.Errorf("code = %s, want %s", code, tc.code)
			}
		})
	}
	if list, _ := listRecent(t, h); len(list) != 1 {
		t.Fatalf("a refused request changed the list: %v", list)
	}
}

// The list is read as strings: an entry under a denied dir (the files deny
// list, the upload dir included) is left out and dropped from the file, a
// directory gone since stays, and no directory is stat'ed.
func TestRecentGroupRoutesDenyWithoutStat(t *testing.T) {
	denied, uploads, gone := t.TempDir(), t.TempDir(), filepath.Join(t.TempDir(), "gone")
	dir := t.TempDir()
	entry := func(id, name, cwd, real string) string {
		return fmt.Sprintf(`{"id":%q,"name":%q,"cwd":%q,"real":%q,"used":"x"}`, id, name, cwd, real)
	}
	os.WriteFile(filepath.Join(dir, recentGroupsFile), []byte(`{"v":1,"groups":[`+
		entry("0000000000000001", "gone", gone, gone)+","+
		entry("0000000000000002", "denied", filepath.Join(denied, "x"), filepath.Join(denied, "x"))+","+
		entry("0000000000000003", "uploads", gone, filepath.Join(uploads, "x"))+"]}"), 0o600)
	old := groupCwdCheck
	release := make(chan struct{})
	groupCwdCheck = func(string, []string) (string, error) { <-release; return "", errCwdNotAllowed }
	t.Cleanup(func() { close(release); groupCwdCheck = old })
	h := recentHandler(t, &fakeMux{}, dir, uploads, denied)

	start := time.Now()
	list, _ := listRecent(t, h)
	if len(list) != 1 || list[0]["name"] != "gone" {
		t.Fatalf("list = %v", list)
	}
	if took := time.Since(start); took > time.Second {
		t.Errorf("the list took %s", took)
	}
	s := newTestRecentStore(t, dir)
	if len(s.list) != 1 {
		t.Errorf("%d left in the file", len(s.list))
	}
}

// madeMux is a fakeMux that says when NewGroup returned.
type madeMux struct {
	*fakeMux
	made chan struct{}
}

func (m *madeMux) NewGroup(ctx context.Context, name, cwd string) (string, error) {
	defer func() { m.made <- struct{}{} }()
	return "g9", nil
}

func (m *madeMux) RenameGroup(context.Context, string, string) error { return nil }

// A group change never waits for the recent groups' file lock: the group
// lock is released before the list is written.
func TestRecentGroupRecordOutsideGroupLock(t *testing.T) {
	old := recentGroupsLockWait
	recentGroupsLockWait = 5 * time.Second
	t.Cleanup(func() { recentGroupsLockWait = old })
	dir := t.TempDir()
	m := &madeMux{fakeMux: &fakeMux{caps: &Caps{Groups: true}}, made: make(chan struct{}, 1)}
	cfg := testConfig(t)
	cfg.NoAuth, cfg.Pass, cfg.RecentGroupsDir = true, "", dir
	h, hub, _, err := buildServer(cfg, m)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	unlock, err := lockStateFile(filepath.Join(dir, recentGroupsLock), 0)
	if err != nil {
		t.Fatal(err)
	}
	created := make(chan int, 1)
	cwd := t.TempDir()
	go func() { created <- createGroup(t, h, "a", cwd) }()
	// The group is made; its create now waits on the file lock.
	<-m.made
	if rec := serve(h, apiRequest("PATCH", "/api/mux/groups/g9", `{"name":"b"}`)); rec.Code != http.StatusOK {
		t.Fatalf("rename = %d %s", rec.Code, rec.Body)
	}
	select {
	case code := <-created:
		t.Fatalf("create answered %d before the lock was free: the rename proved nothing", code)
	default:
	}
	unlock()
	if code := <-created; code != http.StatusOK {
		t.Fatalf("create = %d", code)
	}
}

// A backend that panics while creating leaves the group lock free.
func TestRecentGroupCreatePanicUnlocks(t *testing.T) {
	g := &groupAPI{m: panicMux{&fakeMux{}}}
	req := apiRequest("POST", "/api/mux/groups", jsonBody(map[string]string{"name": "a", "cwd": t.TempDir()}))
	func() {
		defer func() { recover() }()
		g.handleCreate(httptest.NewRecorder(), req)
	}()
	if !g.mu.TryLock() {
		t.Fatal("group lock held after a panic")
	}
	g.mu.Unlock()
}

type panicMux struct{ *fakeMux }

func (panicMux) NewGroup(context.Context, string, string) (string, error) { panic("backend") }

// A list that cannot be written never fails the group.
func TestRecentGroupWriteFailsGroupMade(t *testing.T) {
	old := recentGroupsLockWait
	recentGroupsLockWait = 20 * time.Millisecond
	t.Cleanup(func() { recentGroupsLockWait = old })
	logs := captureLog(t)
	dir := t.TempDir()
	h := recentHandler(t, &fakeMux{}, dir, "")
	unlock, err := lockStateFile(filepath.Join(dir, recentGroupsLock), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if code := createGroup(t, h, "a", t.TempDir()); code != http.StatusOK {
		t.Fatalf("create = %d", code)
	}
	if !strings.Contains(logs.String(), "recent groups:") {
		t.Errorf("not logged: %s", logs)
	}
}

func TestRecentGroupRoutesNewerFormat(t *testing.T) {
	dir := t.TempDir()
	d := filepath.Clean(t.TempDir())
	data := fmt.Sprintf(`{"v":2,"groups":[{"id":"0123456789abcdef","name":"n","cwd":%q,"real":%q}]}`, d, d)
	os.WriteFile(filepath.Join(dir, recentGroupsFile), []byte(data), 0o600)
	h := recentHandler(t, &fakeMux{}, dir, "")
	if list, ro := listRecent(t, h); len(list) != 1 || !ro {
		t.Fatalf("list = %v %v", list, ro)
	}
	rec := serve(h, apiRequest("DELETE", "/api/mux/recent-groups/0123456789abcdef", ""))
	if _, code := replyOf(t, rec.Body.Bytes()); rec.Code != http.StatusConflict || code != "newer_format" {
		t.Fatalf("delete = %d %s", rec.Code, rec.Body)
	}
	if code := createGroup(t, h, "a", t.TempDir()); code != http.StatusOK {
		t.Fatalf("create = %d", code)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, recentGroupsFile)); string(got) != data {
		t.Errorf("file changed to %s", got)
	}
}

// A file that cannot be read fails a removal without saying why.
func TestRecentGroupRoutesFailedRemove(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a directory in place of the file")
	}
	dir := t.TempDir()
	h := recentHandler(t, &fakeMux{}, dir, "")
	os.Mkdir(filepath.Join(dir, recentGroupsFile), 0o700)
	rec := serve(h, apiRequest("DELETE", "/api/mux/recent-groups/0123456789abcdef", ""))
	if b := rec.Body.String(); rec.Code != 500 || strings.Contains(b, dir) {
		t.Fatalf("failed remove = %d %s", rec.Code, b)
	}
}

func TestRecentGroupRoutesUnavailable(t *testing.T) {
	f := &fakeMux{}
	h := recentHandler(t, f, "", "")
	for _, req := range []*http.Request{
		apiRequest("GET", "/api/mux/recent-groups", ""),
		apiRequest("DELETE", "/api/mux/recent-groups/0123456789abcdef", ""),
	} {
		rec := serve(h, req)
		if _, code := replyOf(t, rec.Body.Bytes()); rec.Code != http.StatusServiceUnavailable || code != "recent_unavailable" {
			t.Errorf("%s = %d %s", req.Method, rec.Code, rec.Body)
		}
	}
	if code := createGroup(t, h, "a", t.TempDir()); code != http.StatusOK || len(f.calls) != 1 {
		t.Fatalf("create without a store = %d %v", code, f.calls)
	}
}

func TestRecentGroupCaps(t *testing.T) {
	caps := func(h http.Handler, req *http.Request) string {
		return serve(h, req).Body.String()
	}
	h := recentHandler(t, &fakeMux{}, t.TempDir(), "")
	if snap := caps(h, apiRequest("GET", "/api/mux/snapshot", "")); !strings.Contains(snap, `"recentGroups":true`) {
		t.Errorf("full: %s", snap)
	}
	if snap := caps(h, viewRequest("GET", "/api/mux/snapshot", "")); !strings.Contains(snap, `"recentGroups":false`) {
		t.Errorf("view: %s", snap)
	}
	for _, h := range []http.Handler{
		recentHandler(t, &fakeMux{}, "", ""),
		recentHandler(t, &fakeMux{caps: &Caps{}}, t.TempDir(), ""),
	} {
		if snap := caps(h, apiRequest("GET", "/api/mux/snapshot", "")); !strings.Contains(snap, `"recentGroups":false`) {
			t.Errorf("no store or no groups: %s", snap)
		}
	}
}

// /api/mux/groups/recent/{id} would clash with /api/mux/groups/{id}/move;
// the recent groups' routes do not.
func TestRecentGroupRoutesBesideGroupRoutes(t *testing.T) {
	mux := http.NewServeMux()
	f := &fakeMux{}
	registerGroupRoutes(mux, f, nil, nil)
	registerReorderRoutes(mux, f)
	registerRecentGroupRoutes(mux, nil, nil, hostAllowlist{})
	defer func() {
		if recover() == nil {
			t.Error("the clashing pattern registered")
		}
	}()
	mux.HandleFunc("/api/mux/groups/recent/{id}", func(http.ResponseWriter, *http.Request) {})
}

// A denied entry is left out even while another process holds the lock:
// the read neither waits for it nor logs, and the file keeps the entry.
func TestRecentGroupRoutesPruneFails(t *testing.T) {
	old := recentGroupsLockWait
	recentGroupsLockWait = 2 * time.Second
	t.Cleanup(func() { recentGroupsLockWait = old })
	logs := captureLog(t)
	denied, dir := t.TempDir(), t.TempDir()
	x := filepath.Join(denied, "x")
	os.WriteFile(filepath.Join(dir, recentGroupsFile), []byte(fmt.Sprintf(`{"v":1,"groups":[{"id":"0000000000000001","name":"d","cwd":%q,"real":%q}]}`, x, x)), 0o600)
	h := recentHandler(t, &fakeMux{}, dir, "", denied)
	unlock, err := lockStateFile(filepath.Join(dir, recentGroupsLock), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	start := time.Now()
	if list, _ := listRecent(t, h); len(list) != 0 {
		t.Fatalf("list = %v", list)
	}
	if took := time.Since(start); took > 500*time.Millisecond {
		t.Errorf("the read waited %s for the lock", took)
	}
	if strings.Contains(logs.String(), "recent groups") {
		t.Errorf("logged: %s", logs)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, recentGroupsFile)); !strings.Contains(string(got), `"d"`) {
		t.Errorf("file changed to %s", got)
	}
}

// A prune that fails for another reason is logged, and the list still
// answers.
func TestRecentGroupRoutesPruneWriteFails(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("Unix modes, not as root")
	}
	logs := captureLog(t)
	denied, dir := t.TempDir(), t.TempDir()
	x := filepath.Join(denied, "x")
	os.WriteFile(filepath.Join(dir, recentGroupsFile), []byte(fmt.Sprintf(`{"v":1,"groups":[{"id":"0000000000000001","name":"d","cwd":%q,"real":%q}]}`, x, x)), 0o600)
	h := recentHandler(t, &fakeMux{}, dir, "", denied)
	// The lock file exists; the dir takes no new file.
	unlock, _ := lockStateFile(filepath.Join(dir, recentGroupsLock), 0)
	unlock()
	os.Chmod(dir, 0o500)
	t.Cleanup(func() { os.Chmod(dir, 0o700) })
	if list, _ := listRecent(t, h); len(list) != 0 {
		t.Fatalf("list = %v", list)
	}
	if !strings.Contains(logs.String(), "recent groups: write") {
		t.Errorf("not logged: %s", logs)
	}
}

// Prefixes by name alone, never a stat: on Linux a path differing in case
// from a denied dir is not under it.
func TestRecentGroupUnderDirName(t *testing.T) {
	base := filepath.Join(t.TempDir(), "Deny")
	foldCase := runtime.GOOS == "windows" || runtime.GOOS == "darwin"
	for _, tc := range []struct {
		dir, p string
		under  bool
	}{
		{base, base, true},
		{base, filepath.Join(base, "x"), true},
		{base, base + "x", false},
		{base, filepath.Dir(base), false},
		{"", base, false},
		{base, filepath.Join(filepath.Dir(base), "deny", "x"), foldCase},
	} {
		if got := underDirName(tc.dir, tc.p); got != tc.under {
			t.Errorf("underDirName(%q, %q) = %v", tc.dir, tc.p, got)
		}
	}
}

// A view-only client is refused before the method is looked at.
func TestRecentGroupRoutesViewBeforeMethod(t *testing.T) {
	h := recentHandler(t, &fakeMux{}, t.TempDir(), "")
	for _, p := range []string{"/api/mux/recent-groups", "/api/mux/recent-groups/0123456789abcdef"} {
		rec := serve(h, viewRequest("PUT", p, "{}"))
		if _, code := replyOf(t, rec.Body.Bytes()); rec.Code != http.StatusForbidden || code != "view_only" {
			t.Errorf("view PUT %s = %d %s", p, rec.Code, rec.Body)
		}
	}
}

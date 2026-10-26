package main

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// userTaskHandler builds a server without sign-in whose tasks live in dir
// ("" for none); a request carrying viewDeviceHeader acts as a view-only
// device.
func userTaskHandler(t *testing.T, dir string) http.Handler {
	t.Helper()
	cfg := testConfig(t)
	cfg.NoAuth = true
	cfg.Pass = ""
	cfg.TasksDir = dir
	h, hub, _, err := buildServer(cfg, &fakeMux{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	return asRole(h, true)
}

// postUserTask creates a task and returns it as the server answered.
func postUserTask(t *testing.T, h http.Handler, name, command string) map[string]any {
	t.Helper()
	rec := serve(h, apiRequest("POST", "/api/mux/tasks", templateJSON(t, taskInput{name, command})))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create %q = %d %s", name, rec.Code, rec.Body)
	}
	return decodeBody(t, rec)["task"].(map[string]any)
}

func listUserTasks(t *testing.T, h http.Handler) []any {
	t.Helper()
	rec := serve(h, apiRequest("GET", "/api/mux/tasks", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("list = %d %s", rec.Code, rec.Body)
	}
	return decodeBody(t, rec)["tasks"].([]any)
}

func TestUserTaskRoutesCRUD(t *testing.T) {
	h := userTaskHandler(t, t.TempDir())
	rec := serve(h, apiRequest("GET", "/api/mux/tasks", ""))
	body := decodeBody(t, rec)
	if rec.Code != http.StatusOK || body["readOnly"] != false || len(body["tasks"].([]any)) != 0 {
		t.Fatalf("empty list = %d %v", rec.Code, body)
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "no-store") {
		t.Errorf("Cache-Control = %q", cc)
	}

	task := postUserTask(t, h, "Unit", "go test ./...")
	id, updated := task["id"].(string), task["updated"].(string)
	if task["name"] != "Unit" || task["command"] != "go test ./..." || len(id) != 16 {
		t.Fatalf("created %v", task)
	}
	put := func(updated, name string) *http.Request {
		return apiRequest("PUT", "/api/mux/tasks/"+id, templateJSON(t, map[string]string{"name": name, "command": "c", "updated": updated}))
	}
	rec = serve(h, put(updated, "Renamed"))
	saved := decodeBody(t, rec)["task"].(map[string]any)
	if rec.Code != http.StatusOK || saved["name"] != "Renamed" || saved["updated"] == updated {
		t.Fatalf("update = %d %v", rec.Code, saved)
	}
	// The stale device gets the task as it is now.
	rec = serve(h, put(updated, "Mine"))
	body = decodeBody(t, rec)
	if rec.Code != http.StatusConflict || body["code"] != "conflict" || body["task"].(map[string]any)["name"] != "Renamed" {
		t.Fatalf("stale update = %d %v", rec.Code, body)
	}
	rec = serve(h, apiRequest("DELETE", "/api/mux/tasks/"+id+"?updated="+updated, ""))
	if rec.Code != http.StatusConflict {
		t.Fatalf("stale delete = %d", rec.Code)
	}
	rec = serve(h, apiRequest("DELETE", "/api/mux/tasks/"+id+"?updated="+saved["updated"].(string), ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete = %d %s", rec.Code, rec.Body)
	}
	for _, req := range []*http.Request{
		apiRequest("DELETE", "/api/mux/tasks/"+id+"?updated=x", ""),
		put("x", "y"),
		apiRequest("PUT", "/api/mux/tasks/NOT-AN-ID", `{"name":"n","command":"c"}`),
	} {
		if rec := serve(h, req); rec.Code != http.StatusNotFound || decodeBody(t, rec)["code"] != "not_found" {
			t.Errorf("%s %s = %d %s", req.Method, req.URL.Path, rec.Code, rec.Body)
		}
	}
}

func TestUserTaskRoutesRejects(t *testing.T) {
	dir := t.TempDir()
	h := userTaskHandler(t, dir)
	task := postUserTask(t, h, "Taken", "x")
	itemPath := "/api/mux/tasks/" + task["id"].(string)
	good := templateJSON(t, taskInput{"n", "c"})
	with := func(r *http.Request, header ...string) *http.Request {
		for i := 0; i < len(header); i += 2 {
			r.Header.Set(header[i], header[i+1])
		}
		return r
	}
	big := templateJSON(t, taskInput{"n", strings.Repeat("a", taskBody)})
	for _, tc := range []struct {
		name   string
		req    *http.Request
		status int
		code   string
		field  string
	}{
		{"not JSON", with(apiRequest("POST", "/api/mux/tasks", good), "Content-Type", "text/plain"), 415, "", ""},
		{"cross-site write", with(apiRequest("POST", "/api/mux/tasks", good), "Sec-Fetch-Site", "cross-site", "Origin", "https://evil.test"), 403, "", ""},
		{"cross-site delete", with(apiRequest("DELETE", itemPath+"?updated="+task["updated"].(string), ""), "Sec-Fetch-Site", "cross-site"), 403, "", ""},
		{"cross-site read", with(apiRequest("GET", "/api/mux/tasks", ""), "Sec-Fetch-Site", "cross-site"), 403, "", ""},
		{"foreign origin read", with(apiRequest("GET", "/api/mux/tasks", ""), "Origin", "https://evil.test"), 403, "", ""},
		{"too large", apiRequest("POST", "/api/mux/tasks", big), 413, "too_large", ""},
		{"too large update", apiRequest("PUT", itemPath, big), 413, "too_large", ""},
		{"bad JSON", apiRequest("POST", "/api/mux/tasks", "{"), 400, "", ""},
		{"invalid name", apiRequest("POST", "/api/mux/tasks", `{"name":" ","command":"c"}`), 400, "invalid_task", "name"},
		{"two lines", apiRequest("POST", "/api/mux/tasks", `{"name":"n","command":"make\nrm -rf ~"}`), 400, "invalid_task", "command"},
		{"name taken", apiRequest("POST", "/api/mux/tasks", `{"name":"TAKEN","command":"c"}`), 409, "name_taken", ""},
		{"PATCH list", apiRequest("PATCH", "/api/mux/tasks", good), 405, "", ""},
		{"POST item", apiRequest("POST", itemPath, good), 405, "", ""},
		{"view list", viewRequest("GET", "/api/mux/tasks", ""), 403, "view_only", ""},
		{"view create", viewRequest("POST", "/api/mux/tasks", good), 403, "view_only", ""},
		{"view update", viewRequest("PUT", itemPath, good), 403, "view_only", ""},
		{"view delete", viewRequest("DELETE", itemPath+"?updated="+task["updated"].(string), ""), 403, "view_only", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := serve(h, tc.req)
			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tc.status, rec.Body)
			}
			if strings.Contains(strings.ToLower(rec.Body.String()), "template") {
				t.Errorf("the answer names templates: %s", rec.Body)
			}
			if tc.code != "" {
				body := decodeBody(t, rec)
				if body["code"] != tc.code {
					t.Errorf("code = %v, want %s", body["code"], tc.code)
				}
				if tc.field != "" && body["field"] != tc.field {
					t.Errorf("field = %v, want %s", body["field"], tc.field)
				}
			}
			if tc.status == 405 && rec.Header().Get("Allow") == "" {
				t.Error("405 without Allow")
			}
			if tc.code == "view_only" && strings.Contains(rec.Body.String(), `"x"`) {
				t.Errorf("a view-only device read a command: %s", rec.Body)
			}
		})
	}
	if list := listUserTasks(t, h); len(list) != 1 || list[0].(map[string]any)["command"] != "x" {
		t.Fatalf("a refused request changed the tasks: %v", list)
	}

	// A file that cannot be read fails the write without saying why.
	os.WriteFile(filepath.Join(dir, tasksFile), []byte("{corrupt and longer than the file was ............................................"), 0o600)
	rec := serve(h, apiRequest("POST", "/api/mux/tasks", good))
	if b := rec.Body.String(); rec.Code != 500 || strings.Contains(b, dir) || strings.Contains(b, "corrupt") || strings.Contains(b, "template") {
		t.Fatalf("failed save = %d %s", rec.Code, b)
	}
}

func TestUserTaskRoutesNewerFormat(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, tasksFile), []byte(`{"v":2,"tasks":[]}`), 0o600)
	h := userTaskHandler(t, dir)
	rec := serve(h, apiRequest("GET", "/api/mux/tasks", ""))
	if decodeBody(t, rec)["readOnly"] != true {
		t.Fatalf("list = %s", rec.Body)
	}
	rec = serve(h, apiRequest("POST", "/api/mux/tasks", `{"name":"n","command":"c"}`))
	if rec.Code != http.StatusConflict || decodeBody(t, rec)["code"] != "newer_format" {
		t.Fatalf("create = %d %s", rec.Code, rec.Body)
	}
}

func TestUserTaskRoutesCaps(t *testing.T) {
	h := userTaskHandler(t, t.TempDir())
	if snap := serve(h, apiRequest("GET", "/api/mux/snapshot", "")).Body.String(); !strings.Contains(snap, `"userTasks":true`) {
		t.Errorf("snapshot caps: %s", snap)
	}
	// A file that cannot be read: the store is off, the file kept.
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, tasksFile), []byte("{nope"), 0o600)
	for _, h := range []http.Handler{userTaskHandler(t, ""), userTaskHandler(t, dir)} {
		if snap := serve(h, apiRequest("GET", "/api/mux/snapshot", "")).Body.String(); !strings.Contains(snap, `"userTasks":false`) {
			t.Errorf("snapshot caps: %s", snap)
		}
		for _, req := range []*http.Request{
			apiRequest("GET", "/api/mux/tasks", ""),
			apiRequest("POST", "/api/mux/tasks", `{"name":"n","command":"c"}`),
			apiRequest("PUT", "/api/mux/tasks/0123456789abcdef", `{"name":"n","command":"c"}`),
			apiRequest("DELETE", "/api/mux/tasks/0123456789abcdef", ""),
		} {
			rec := serve(h, req)
			if rec.Code != http.StatusServiceUnavailable || decodeBody(t, rec)["code"] != "tasks_unavailable" {
				t.Errorf("%s %s = %d %s", req.Method, req.URL.Path, rec.Code, rec.Body)
			}
		}
	}
	if got, _ := os.ReadFile(filepath.Join(dir, tasksFile)); string(got) != "{nope" {
		t.Errorf("file changed to %s", got)
	}
}

// The tasks dir sits in the state dir, which the Files view never serves.
func TestTasksDirDeniedToFiles(t *testing.T) {
	home := t.TempDir()
	c := &cli{goos: "linux", home: home}
	cfg := testConfig(t)
	cfg.FilesDenyDirs = filesDenyDirs(c.configDir(), c.stateDir())
	cfg.TasksDir = filepath.Join(c.stateDir(), "tasks")
	h, _, _, err := buildServer(cfg, &filesFakeMux{dir: home, files: true})
	if err != nil {
		t.Fatal(err)
	}
	postUserTask(t, h, "n", "t")
	rel, _ := filepath.Rel(home, filepath.Join(cfg.TasksDir, tasksFile))
	rec := serve(h, apiRequest("GET", "/api/mux/panes/0/files/content?path="+filepath.ToSlash(rel), ""))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("files/content served the tasks: %d %s", rec.Code, rec.Body)
	}
}

// The handlers refuse a view-only client themselves, not only behind the
// layer that refuses every write method.
func TestUserTaskRoutesViewOnlyInHandler(t *testing.T) {
	cfg := testConfig(t)
	cfg.NoAuth = true
	cfg.Pass = ""
	cfg.TasksDir = t.TempDir()
	h, hub, _, err := buildServer(cfg, &fakeMux{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	h = asRole(h, false)
	for _, req := range []*http.Request{
		viewRequest("PUT", "/api/mux/tasks/0123456789abcdef", `{"name":"n","command":"c"}`),
		viewRequest("POST", "/api/mux/tasks", `{"name":"n","command":"c"}`),
	} {
		assertViewOnly(t, req.Method, serve(h, req))
	}
}

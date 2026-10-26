package main

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// tasksHandler builds a server over a pane whose root is dir, its user tasks
// in their own dir; a request carrying viewDeviceHeader acts as a view-only
// device.
func tasksHandler(t *testing.T, m Mux, deny ...string) http.Handler {
	t.Helper()
	cfg := testConfig(t)
	cfg.NoAuth = true
	cfg.Pass = ""
	cfg.TasksDir = t.TempDir()
	cfg.FilesDenyDirs = deny
	h, hub, _, err := buildServer(cfg, m)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	return asRole(h, true)
}

func listPaneTasks(t *testing.T, h http.Handler, q url.Values) (int, map[string]any) {
	t.Helper()
	rec := serve(h, apiRequest("GET", "/api/mux/panes/0/tasks?"+q.Encode(), ""))
	return rec.Code, decodeBody(t, rec)
}

func TestTasksList(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(base, "root")
	writeFile(t, filepath.Join(root, "package.json"), `{"scripts":{"test":"vitest","pretest":"tsc","x y":"no"}}`)
	writeFile(t, filepath.Join(root, "pnpm-lock.yaml"), "")
	writeFile(t, filepath.Join(root, "Makefile"), "URL = http://x\nbuild:\n\tgo build\n")
	h := tasksHandler(t, &filesFakeMux{dir: root, files: true})
	rec := serve(h, apiRequest("POST", "/api/mux/tasks", `{"name":"Unit","command":"go test ./..."}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", rec.Code, rec.Body)
	}

	rec = serve(h, apiRequest("GET", "/api/mux/panes/0/tasks", ""))
	if rec.Code != 200 || !strings.Contains(rec.Header().Get("Cache-Control"), "no-store") {
		t.Fatalf("list = %d %v", rec.Code, rec.Header())
	}
	body := decodeBody(t, rec)
	scripts := body["scripts"].([]any)
	first := scripts[0].(map[string]any)
	if body["root"] != root || body["packageManager"] != "pnpm" || body["makefile"] != "Makefile" || body["skipped"] != 1.0 ||
		len(scripts) != 2 || first["name"] != "test" || first["command"] != "vitest" || first["hooks"].([]any)[0] != "pretest" {
		t.Errorf("list = %v", body)
	}
	if targets := body["makeTargets"].([]any); len(targets) != 1 || targets[0].(map[string]any)["name"] != "build" {
		t.Errorf("targets = %v", targets)
	}
	if ut := body["userTasks"].([]any); len(ut) != 1 || ut[0].(map[string]any)["command"] != "go test ./..." {
		t.Errorf("user tasks = %v", ut)
	}
	if code, _ := listPaneTasks(t, h, url.Values{"root": {root}}); code != 200 {
		t.Errorf("same root = %d", code)
	}
	code, body := listPaneTasks(t, h, url.Values{"root": {"/elsewhere"}})
	if code != http.StatusConflict || body["root"] != root || body["scripts"] != nil {
		t.Errorf("other root = %d %v", code, body)
	}
}

// An empty root, or files that cannot be read, list nothing (as empty
// lists), naming a file too large to read.
func TestTasksListNothing(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	h := tasksHandler(t, &filesFakeMux{dir: dir, files: true})
	code, body := listPaneTasks(t, h, nil)
	if code != 200 || body["packageManager"] != "" || body["makefile"] != "" || len(body["scripts"].([]any)) != 0 ||
		len(body["makeTargets"].([]any)) != 0 || len(body["userTasks"].([]any)) != 0 || len(body["tooLarge"].([]any)) != 0 {
		t.Errorf("empty = %d %v", code, body)
	}
	os.WriteFile(filepath.Join(dir, "package.json"), make([]byte, maxTaskFile+1), 0o644)
	os.WriteFile(filepath.Join(dir, "Makefile"), []byte("all:\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "GNUmakefile"), make([]byte, maxTaskFile+1), 0o644)
	_, body = listPaneTasks(t, h, nil)
	if got := body["tooLarge"].([]any); len(got) != 2 || got[0] != "package.json" || got[1] != "GNUmakefile" ||
		body["makefile"] != "GNUmakefile" || len(body["makeTargets"].([]any)) != 0 || body["packageManager"] != "" {
		t.Errorf("too large = %v", body)
	}
	os.WriteFile(filepath.Join(dir, "package.json"), []byte(`[]`), 0o644)
	if _, body = listPaneTasks(t, h, nil); body["packageManager"] != "npm" || len(body["scripts"].([]any)) != 0 {
		t.Errorf("no scripts = %v", body)
	}
}

// Files under a deny dir are never read, even in the root.
func TestTasksListDenyDir(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	writeFile(t, filepath.Join(dir, "package.json"), `{"scripts":{"a":"b"}}`)
	h := tasksHandler(t, &filesFakeMux{dir: dir, files: true}, dir)
	_, body := listPaneTasks(t, h, nil)
	if len(body["scripts"].([]any)) != 0 || body["packageManager"] != "" {
		t.Errorf("deny dir read: %v", body)
	}
}

func TestTasksListGuards(t *testing.T) {
	plain, _ := filepath.EvalSymlinks(t.TempDir())
	writeFile(t, filepath.Join(plain, "package.json"), `{"scripts":{"a":"secret-token"}}`)
	repo, _ := viewOnlyRepo(t)
	writeFile(t, filepath.Join(repo, "package.json"), `{"scripts":{"a":"secret-token"}}`)
	if _, err := exec.LookPath("git"); err == nil {
		commitAll(t, repo)
	}
	for name, dir := range map[string]string{"plain": plain, "repo": repo} {
		h := tasksHandler(t, &filesFakeMux{dir: dir, files: true})
		rec := serve(h, viewRequest("GET", "/api/mux/panes/0/tasks", ""))
		assertViewOnly(t, name+" view-only", rec)
		if strings.Contains(rec.Body.String(), "secret-token") {
			t.Errorf("%s: view-only read a command", name)
		}
	}
	h := tasksHandler(t, &filesFakeMux{dir: plain, files: true})
	if rec := serve(h, apiRequest("POST", "/api/mux/panes/0/tasks", "{}")); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST = %d", rec.Code)
	}
	for name, set := range map[string]func(*http.Request){
		"cross-site":   func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") },
		"other origin": func(r *http.Request) { r.Header.Set("Origin", "http://evil.example") },
	} {
		req := apiRequest("GET", "/api/mux/panes/0/tasks", "")
		set(req)
		if rec := serve(h, req); rec.Code != http.StatusForbidden || strings.Contains(rec.Body.String(), "secret-token") {
			t.Errorf("%s = %d %s", name, rec.Code, rec.Body)
		}
	}
	for name, m := range map[string]Mux{
		"no PaneDirer": &fakeMux{},
		"cap off":      &filesFakeMux{dir: plain},
	} {
		if rec := serve(tasksHandler(t, m), apiRequest("GET", "/api/mux/panes/0/tasks", "")); rec.Code != http.StatusNotImplemented {
			t.Errorf("%s = %d", name, rec.Code)
		}
	}
	// A root that cannot be opened: a fixed error, no path.
	if os.Geteuid() != 0 {
		locked, _ := filepath.EvalSymlinks(t.TempDir())
		h := tasksHandler(t, &filesFakeMux{dir: locked, files: true})
		os.Chmod(locked, 0)
		t.Cleanup(func() { os.Chmod(locked, 0o700) })
		if rec := serve(h, apiRequest("GET", "/api/mux/panes/0/tasks", "")); rec.Code != http.StatusForbidden || strings.Contains(rec.Body.String(), locked) {
			t.Errorf("unreadable root = %d %s", rec.Code, rec.Body)
		}
	}
}

// caps.tasks needs the files routes and a backend that runs tasks.
func TestTasksCaps(t *testing.T) {
	for m, want := range map[Mux]string{
		newTaskFake(t, t.TempDir()):                  `"tasks":true`,
		&filesFakeMux{dir: t.TempDir(), files: true}: `"tasks":false`,
		&fakeMux{}: `"tasks":false`,
	} {
		snap := serve(tasksHandler(t, m), apiRequest("GET", "/api/mux/snapshot", "")).Body.String()
		if !strings.Contains(snap, want) {
			t.Errorf("snapshot caps, want %s: %s", want, snap)
		}
	}
}

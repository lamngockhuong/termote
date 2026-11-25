package main

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

// secretValue is what the test files hold: it must never show in an
// answer, an error or a log line.
const secretValue = "TOKEN=s3cr3t-never-shown"

func writeEnv(t *testing.T, dir, name, content string) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// The ignored .env files the main checkout holds the same do not count;
// any other does, by name.
func TestFinishTreeEnvAgainstMain(t *testing.T) {
	r := newFinishRepo(t)
	writeEnv(t, r.main, ".env.local", secretValue)
	writeEnv(t, r.wt, ".env.local", secretValue)
	writeEnv(t, r.main, "app/.env", "A=1")
	writeEnv(t, r.wt, "app/.env", "A=1")
	if f := r.mustRead(t); f.envFiles || len(f.envLost) != 0 || f.envCut {
		t.Fatalf("same as main: %+v", f)
	}

	// Another content, of the same size too.
	writeEnv(t, r.wt, "app/.env", "A=2")
	if f := r.mustRead(t); !f.envFiles || !slices.Equal(f.envLost, []string{"app/.env"}) {
		t.Errorf("changed: %+v", f)
	}
	writeEnv(t, r.wt, "app/.env", "A=1")

	// Only in the worktree.
	writeEnv(t, r.wt, ".env.test", "B=1")
	if f := r.mustRead(t); !f.envFiles || !slices.Equal(f.envLost, []string{".env.test"}) {
		t.Errorf("only here: %+v", f)
	}
	os.Remove(filepath.Join(r.wt, ".env.test"))

	if runtime.GOOS != "windows" {
		// A symlink, on the worktree's side or the main checkout's.
		os.Remove(filepath.Join(r.wt, ".env.local"))
		if err := os.Symlink(filepath.Join(r.main, ".env.local"), filepath.Join(r.wt, ".env.local")); err != nil {
			t.Fatal(err)
		}
		if f := r.mustRead(t); !slices.Equal(f.envLost, []string{".env.local"}) {
			t.Errorf("symlink in the worktree: %+v", f)
		}
		os.Remove(filepath.Join(r.wt, ".env.local"))
		writeEnv(t, r.wt, ".env.local", secretValue)
		os.Rename(filepath.Join(r.main, ".env.local"), filepath.Join(r.main, "real"))
		os.Symlink("real", filepath.Join(r.main, ".env.local"))
		if f := r.mustRead(t); !slices.Equal(f.envLost, []string{".env.local"}) {
			t.Errorf("symlink in main: %+v", f)
		}
		os.Remove(filepath.Join(r.main, ".env.local"))
		os.Rename(filepath.Join(r.main, "real"), filepath.Join(r.main, ".env.local"))

		// A folder on the way that is a symlink.
		os.RemoveAll(filepath.Join(r.wt, "app"))
		os.Symlink(filepath.Join(r.main, "app"), filepath.Join(r.wt, "app"))
		if f := r.mustRead(t); f.envFiles {
			// git does not list files behind a symlinked folder at all
			t.Logf("symlinked folder: %+v", f)
		}
		os.Remove(filepath.Join(r.wt, "app"))
		writeEnv(t, r.wt, "app/.env", "A=1")
	}
	if f := r.mustRead(t); f.envFiles {
		t.Errorf("back to the same: %+v", f)
	}

	// No main checkout to compare with.
	if got := envLost(r.wt, "", []string{".env.local"}); !slices.Equal(got, []string{".env.local"}) {
		t.Errorf("no main: %v", got)
	}
	if got := envLost(r.wt, r.wt, []string{".env.local"}); !slices.Equal(got, []string{".env.local"}) {
		t.Errorf("main is the worktree: %v", got)
	}
	if got := envLost(r.wt, filepath.Join(r.home, "gone"), []string{".env.local"}); !slices.Equal(got, []string{".env.local"}) {
		t.Errorf("main gone: %v", got)
	}
	if got := envLost(r.wt, r.main, nil); got != nil {
		t.Errorf("none: %v", got)
	}
}

func TestEnvList(t *testing.T) {
	names, cut := envList([]byte("a/.env\x00.env.local\x00"), false)
	if !slices.Equal(names, []string{"a/.env", ".env.local"}) || cut {
		t.Errorf("whole: %v %v", names, cut)
	}
	names, cut = envList([]byte("a/.env\x00.env.lo"), true)
	if !slices.Equal(names, []string{"a/.env"}) || !cut {
		t.Errorf("cut: %v %v", names, cut)
	}
	if names, cut := envList(nil, false); names != nil || cut {
		t.Errorf("empty: %v %v", names, cut)
	}
}

func TestEnvRefusalMessage(t *testing.T) {
	e := &envRefusal{files: []string{".env", "app/.env.local"}}
	if msg := e.Error(); !strings.Contains(msg, "2 .env files") || !strings.Contains(msg, "(.env, app/.env.local)") ||
		!strings.Contains(msg, "confirm their removal in the PWA") || !e.confirmable() {
		t.Errorf("two: %s", msg)
	}
	many := make([]string, 12)
	for i := range many {
		many[i] = ".env." + string(rune('a'+i))
	}
	if msg := (&envRefusal{files: many}).Error(); !strings.Contains(msg, ".env.j, ...)") || strings.Contains(msg, ".env.k") {
		t.Errorf("many: %s", msg)
	}
	cut := &envRefusal{files: []string{".env"}, cut: true}
	if msg := cut.Error(); !strings.Contains(msg, "more than 1") || !strings.Contains(msg, "too many to confirm") || cut.confirmable() {
		t.Errorf("cut: %s", msg)
	}
	tree := finishTree{envFiles: true, envLost: []string{".env", "a/.env"}}
	switch {
	case !envAllowed(tree, []string{"a/.env", ".env", "x"}):
		t.Error("all confirmed refused")
	case envAllowed(tree, []string{".env"}):
		t.Error("one left allowed")
	case envAllowed(tree, nil):
		t.Error("none confirmed allowed")
	case envAllowed(finishTree{envFiles: true, envCut: true, envLost: []string{".env"}}, []string{".env"}):
		t.Error("cut allowed")
	}
}

func TestSameReaders(t *testing.T) {
	big := strings.Repeat("x", 200<<10)
	if !sameReaders(strings.NewReader(big), strings.NewReader(big), int64(len(big))) {
		t.Error("same")
	}
	if sameReaders(strings.NewReader(big), strings.NewReader(big[:len(big)-1]+"y"), int64(len(big))) {
		t.Error("last byte differs")
	}
	if sameReaders(strings.NewReader("ab"), strings.NewReader("a"), 2) {
		t.Error("short")
	}
	if sameReaders(strings.NewReader("a"), strings.NewReader("ab"), 2) {
		t.Error("short first")
	}
}

// The same files in the main checkout: the CLI's finish removes the
// worktree.
func TestJobFinishEnvSameAsMain(t *testing.T) {
	ft := newFinishTest(t, true)
	ft.push()
	writeEnv(t, ft.repo.main, ".env.local", secretValue)
	writeEnv(t, ft.repo.wt, ".env.local", secretValue)
	code, out := ft.finish(map[string]any{"close": true, "removeWorktree": true})
	if code != http.StatusOK || out["worktreeRemoved"] != true {
		t.Fatalf("finish = %d %v", code, out)
	}
	if _, err := os.Stat(ft.repo.wt); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("worktree still there: %v", err)
	}
	if b, err := os.ReadFile(filepath.Join(ft.repo.main, ".env.local")); err != nil || string(b) != secretValue {
		t.Errorf("main's file: %v", err)
	}
}

// envConfirmOf is the job's envConfirm as a full client lists it.
func (ft *finishTest) envConfirmOf() map[string]any {
	ft.t.Helper()
	_, out := ft.do("full", http.MethodGet, "/api/mux/jobs?all=1", nil)
	for _, j := range out["jobs"].([]any) {
		if m := j.(map[string]any); m["id"] == ft.id {
			c, _ := m["envConfirm"].(map[string]any)
			return c
		}
	}
	ft.t.Fatal("job not listed")
	return nil
}

func (ft *finishTest) confirmEnv(as string, files ...string) (int, map[string]any) {
	ft.t.Helper()
	return ft.do(as, http.MethodPost, "/api/mux/jobs/"+ft.id+"/finish/env",
		map[string]any{"updated": ft.job().Updated.Format("2006-01-02T15:04:05.999999999Z07:00"), "files": files})
}

// A file not the same in the main checkout: the CLI is refused with its
// name, never its contents; only the user's confirm in the PWA removes the
// worktree, the agent cannot.
func TestJobFinishEnvConfirm(t *testing.T) {
	ft := newFinishTest(t, true)
	logs := captureLog(t)
	ft.push()
	writeEnv(t, ft.repo.main, ".env.local", "TOKEN=other")
	writeEnv(t, ft.repo.wt, ".env.local", secretValue)
	writeEnv(t, ft.repo.wt, "app/.env", secretValue)

	code, out := ft.finish(map[string]any{"close": true, "removeWorktree": true})
	msg, _ := out["error"].(string)
	if code != http.StatusConflict || out["code"] != "finish_worktree_env" || out["confirmable"] != true ||
		!strings.Contains(msg, "2 .env files") || !strings.Contains(msg, ".env.local") || !strings.Contains(msg, "app/.env") {
		t.Fatalf("finish = %d %v", code, out)
	}
	if files := out["files"].([]any); len(files) != 2 {
		t.Errorf("files %v", files)
	}
	c := ft.envConfirmOf()
	if c == nil || len(c["files"].([]any)) != 2 || c["at"] == "" {
		t.Fatalf("envConfirm %v", c)
	}

	// The agent's own ways: the socket, a finish body that names the
	// files, a server without sign-in, a view-only device.
	for _, as := range []string{"socket", "", "view", "bridge"} {
		if code, out := ft.confirmEnv(as, ".env.local", "app/.env"); code != http.StatusForbidden {
			t.Errorf("confirm as %q = %d %v", as, code, out)
		}
	}
	ft.refused("finish naming the files", map[string]any{"close": true, "removeWorktree": true,
		"envOK": []string{".env.local", "app/.env"}, "files": []string{".env.local", "app/.env"}}, http.StatusConflict, "finish_worktree_env")

	// Not the names the user was shown.
	if code, out := ft.confirmEnv("full", ".env.local"); code != http.StatusConflict || out["code"] != "finish_env_changed" {
		t.Errorf("other names = %d %v", code, out)
	}
	if code, out := ft.do("full", http.MethodPost, "/api/mux/jobs/"+ft.id+"/finish/env", map[string]any{"files": []string{"x"}}); code != http.StatusBadRequest {
		t.Errorf("no updated = %d %v", code, out)
	}
	if code, _ := ft.do("full", http.MethodPost, "/api/mux/jobs/"+ft.id+"/finish/env", "{"); code != http.StatusBadRequest {
		t.Errorf("bad JSON = %d", code)
	}
	if code, out := ft.do("full", http.MethodPost, "/api/mux/jobs/"+ft.id+"/finish/env",
		`{"updated":"x","files":["`+strings.Repeat("a", finishEnvBody)+`"]}`); code != http.StatusRequestEntityTooLarge {
		t.Errorf("too large = %d %v", code, out)
	}
	if code, _ := ft.do("full", http.MethodGet, "/api/mux/jobs/"+ft.id+"/finish/env", nil); code != http.StatusMethodNotAllowed {
		t.Errorf("GET = %d", code)
	}
	if code, _ := ft.do("full", http.MethodPost, "/api/mux/jobs/0123456789abcdef/finish/env", map[string]any{"updated": "x", "files": []string{"x"}}); code != http.StatusNotFound {
		t.Errorf("no job = %d", code)
	}
	if _, err := os.Stat(ft.repo.wt); err != nil {
		t.Fatalf("worktree gone before the confirm: %v", err)
	}

	code, out = ft.confirmEnv("full", "app/.env", ".env.local")
	if code != http.StatusOK || out["worktreeRemoved"] != true || out["closed"] != true {
		t.Fatalf("confirm = %d %v", code, out)
	}
	if _, err := os.Stat(ft.repo.wt); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("worktree still there: %v", err)
	}
	if ft.job().State != "done" || ft.envConfirmOf() != nil {
		t.Errorf("after the confirm: %+v %v", ft.job(), ft.envConfirmOf())
	}
	if code, out := ft.confirmEnv("full", ".env.local"); code != http.StatusConflict || out["code"] != "finish_env_none" {
		t.Errorf("confirm again = %d %v", code, out)
	}
	if !strings.Contains(logs.String(), `audit: job_env_confirmed job="`+ft.id+`" files="2" via="session"`) {
		t.Errorf("no audit line in\n%s", logs)
	}
	if strings.Contains(logs.String(), "s3cr3t") {
		t.Errorf("a file's contents in the log:\n%s", logs)
	}
}

// A file that appears after the ask is not confirmed with it.
func TestJobFinishEnvNewFileAfterAsk(t *testing.T) {
	ft := newFinishTest(t, true)
	ft.push()
	writeEnv(t, ft.repo.wt, ".env.local", secretValue)
	if code, _ := ft.finish(map[string]any{"close": true, "removeWorktree": true}); code != http.StatusConflict {
		t.Fatalf("finish = %d", code)
	}
	writeEnv(t, ft.repo.wt, ".env.prod", secretValue)
	code, out := ft.confirmEnv("full", ".env.local")
	if code != http.StatusConflict || out["code"] != "finish_worktree_env" || strings.Contains(out["error"].(string), "s3cr3t") {
		t.Fatalf("confirm = %d %v", code, out)
	}
	if _, err := os.Stat(ft.repo.wt); err != nil {
		t.Fatalf("worktree gone: %v", err)
	}
	// The ask now names both.
	if c := ft.envConfirmOf(); c == nil || len(c["files"].([]any)) != 2 {
		t.Errorf("envConfirm %v", c)
	}
	if code, out := ft.confirmEnv("full", ".env.prod", ".env.local"); code != http.StatusOK || out["worktreeRemoved"] != true {
		t.Errorf("confirm both = %d %v", code, out)
	}
}

// The user drops the ask; a finish refused over too many files to name
// leaves none.
func TestJobFinishEnvDismiss(t *testing.T) {
	ft := newFinishTest(t, true)
	logs := captureLog(t)
	ft.push()
	writeEnv(t, ft.repo.wt, ".env.local", secretValue)
	ft.finish(map[string]any{"close": true, "removeWorktree": true})
	if ft.envConfirmOf() == nil {
		t.Fatal("no ask")
	}
	if code, _ := ft.do("socket", http.MethodDelete, "/api/mux/jobs/"+ft.id+"/finish/env", nil); code != http.StatusForbidden {
		t.Errorf("dismiss over the socket = %d", code)
	}
	code, out := ft.do("full", http.MethodDelete, "/api/mux/jobs/"+ft.id+"/finish/env", nil)
	if code != http.StatusOK || out["job"] == nil || ft.envConfirmOf() != nil {
		t.Errorf("dismiss = %d %v", code, out)
	}
	if !strings.Contains(logs.String(), `audit: job_env_dismissed job="`+ft.id+`"`) {
		t.Errorf("no audit line in\n%s", logs)
	}

	ft.finish(map[string]any{"close": true, "removeWorktree": true})
	for i := range maxEnvNames + 1 {
		writeEnv(t, ft.repo.wt, "many/"+strings.Repeat("d", i%7+1)+"/"+string(rune('a'+i%26))+"/.env."+string(rune('a'+i/26)), "x")
	}
	code, out = ft.finish(map[string]any{"close": true, "removeWorktree": true})
	if code != http.StatusConflict || out["confirmable"] != false || !strings.Contains(out["error"].(string), "too many") {
		t.Errorf("many = %d %v", code, out)
	}
	if ft.envConfirmOf() != nil {
		t.Error("an ask over too many files")
	}
}

func TestEnvRegularAndOpen(t *testing.T) {
	dir := t.TempDir()
	writeEnv(t, dir, "a/f", "x")
	writeEnv(t, dir, "g", "y")
	r, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if _, ok := envRegular(r, filepath.Join("a", "f")); !ok {
		t.Error("a/f")
	}
	for _, rel := range []string{"a", filepath.Join("g", "f"), "none", filepath.Join("none", "f")} {
		if _, ok := envRegular(r, rel); ok {
			t.Errorf("%s taken", rel)
		}
	}
	if runtime.GOOS != "windows" {
		os.Symlink("a", filepath.Join(dir, "link"))
		if _, ok := envRegular(r, filepath.Join("link", "f")); ok {
			t.Error("through a symlinked folder")
		}
	}
	g, _ := envRegular(r, "g")
	if _, err := envOpen(r, filepath.Join("a", "f"), g); err == nil {
		t.Error("another file opened as g")
	}
	if _, err := envOpen(r, "none", g); err == nil {
		t.Error("missing file opened")
	}
	f, err := envOpen(r, "g", g)
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	// Too large to compare, and a file gone between the two reads.
	big := strings.Repeat("z", maxEnvCompare+1)
	other := t.TempDir()
	writeEnv(t, dir, "big", big)
	writeEnv(t, other, "big", big)
	o, _ := os.OpenRoot(other)
	defer o.Close()
	if envSameAsMain(r, o, "big") {
		t.Error("too large compared")
	}
	if envSameAsMain(r, o, "g") {
		t.Error("only on one side")
	}
}

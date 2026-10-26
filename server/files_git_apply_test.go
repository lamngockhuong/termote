package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// applyFixture is a repo behind the files routes with a trash, a deny dir
// (cfg) and a dir a write never touches (data).
type applyFixture struct {
	repo, trashDir string
	f              *filesAPI
	mux            *http.ServeMux
}

func newApplyFixture(t *testing.T) *applyFixture {
	t.Helper()
	requireGit(t)
	return newApplyFixtureAt(t, newTestRepo(t))
}

func newApplyFixtureAt(t *testing.T, repo string) *applyFixture {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	trash := filepath.Join(base, "trash")
	mux := http.NewServeMux()
	f := registerFilesRoutes(mux, &filesFakeMux{dir: repo, files: true}, hostAllowlist{}, []string{filepath.Join(repo, "cfg"), trash})
	f.writeDeny = filesDenyDirs(filepath.Join(repo, "data"), trash)
	if f.trash, err = newTrashStore(trash); err != nil {
		t.Fatal(err)
	}
	return &applyFixture{repo: repo, trashDir: trash, f: f, mux: mux}
}

func (ax *applyFixture) post(t *testing.T, route string, body any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	req := apiRequest("POST", "/api/mux/panes/0/files/"+route+"?root="+url.QueryEscape(ax.repo), string(b))
	req.Header.Del("Origin")
	rec := serve(ax.mux, req)
	return rec.Code, decodeBody(t, rec)
}

// apply posts an apply of action on path, plus extra fields.
func (ax *applyFixture) apply(t *testing.T, action, path string, extra map[string]any) (int, map[string]any) {
	t.Helper()
	body := map[string]any{"action": action, "path": path}
	for k, v := range extra {
		body[k] = v
	}
	return ax.post(t, "changes/apply", body)
}

func (ax *applyFixture) applyOK(t *testing.T, action, path string, extra map[string]any) map[string]any {
	t.Helper()
	code, body := ax.apply(t, action, path, extra)
	if code != http.StatusOK {
		t.Fatalf("%s %s = %d %v", action, path, code, body)
	}
	return body
}

// wantCode checks an apply is refused with status and code.
func (ax *applyFixture) wantCode(t *testing.T, status int, code, action, path string, extra map[string]any) {
	t.Helper()
	got, body := ax.apply(t, action, path, extra)
	if c, _ := body["code"].(string); got != status || c != code {
		t.Errorf("%s %s %v = %d %v, want %d %s", action, path, extra, got, body, status, code)
	}
}

func (ax *applyFixture) diff(t *testing.T, path string, staged bool) diffResponse {
	t.Helper()
	ax.f.forgetRoot(ax.repo)
	res, err := ax.f.diff(t.Context(), filesRoot{Root: ax.repo, IsRepo: true}, path, "", staged, true)
	if err != nil {
		t.Fatalf("diff %s: %v", path, err)
	}
	return res
}

func (ax *applyFixture) git(t *testing.T, args ...string) string {
	t.Helper()
	return gitT(t, ax.repo, args...)
}

func (ax *applyFixture) write(t *testing.T, rel, text string) {
	t.Helper()
	writeFile(t, filepath.Join(ax.repo, filepath.FromSlash(rel)), text)
}

func (ax *applyFixture) read(t *testing.T, rel string) string {
	t.Helper()
	return readText(t, filepath.Join(ax.repo, filepath.FromSlash(rel)))
}

func (ax *applyFixture) hash(t *testing.T, rel string) string {
	t.Helper()
	return diskHash(t, filepath.Join(ax.repo, filepath.FromSlash(rel)))
}

func (ax *applyFixture) commit(t *testing.T) {
	t.Helper()
	ax.git(t, "add", "-A")
	ax.git(t, "commit", "-q", "-m", "c")
}

// cached is `git diff --cached --name-status`, one "X path" per line.
func (ax *applyFixture) cached(t *testing.T) string {
	t.Helper()
	return strings.TrimSpace(strings.ReplaceAll(ax.git(t, "diff", "--cached", "--name-status", "--no-renames"), "\t", " "))
}

func TestApplyGuards(t *testing.T) {
	requireGit(t)
	repo := newTestRepo(t)
	writeFile(t, filepath.Join(repo, "a.txt"), "two\n")
	cfg := testConfig(t)
	cfg.TrashDir = filepath.Join(t.TempDir(), "trash")
	h, _, _, err := buildServer(cfg, &filesFakeMux{dir: repo, files: true})
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/mux/panes/0/files/changes/apply"
	q := "?root=" + url.QueryEscape(repo)
	body := `{"action":"stage","path":"a.txt"}`
	cross := apiRequest("POST", path+q, body)
	cross.Header.Set("Sec-Fetch-Site", "cross-site")
	cross.Header.Set("Origin", "https://evil.example")
	form := apiRequest("POST", path+q, body)
	form.Header.Set("Content-Type", "text/plain")
	big := `{"action":"stage","path":"a.txt","hunk":"` + strings.Repeat("x", maxJSONBody) + `"}`
	for name, c := range map[string]struct {
		req  *http.Request
		want int
	}{
		"cross-site":   {cross, http.StatusForbidden},
		"content type": {form, http.StatusUnsupportedMediaType},
		"no root":      {apiRequest("POST", path, body), http.StatusBadRequest},
		"get":          {apiRequest("GET", path+q, ""), http.StatusMethodNotAllowed},
		"bad json":     {apiRequest("POST", path+q, "{"), http.StatusBadRequest},
		"too large":    {apiRequest("POST", path+q, big), http.StatusBadRequest},
		"root moved":   {apiRequest("POST", path+"?root=/elsewhere", body), http.StatusConflict},
	} {
		if rec := serve(h, c.req); rec.Code != c.want {
			t.Errorf("%s = %d %s", name, rec.Code, rec.Body)
		}
	}
	if out := gitT(t, repo, "diff", "--cached", "--name-only"); out != "" {
		t.Errorf("a refused request staged %q", out)
	}
	if rec := serve(h, apiRequest("POST", path+q, body)); rec.Code != 200 {
		t.Errorf("stage = %d %s", rec.Code, rec.Body)
	}
	if out := gitT(t, repo, "diff", "--cached", "--name-only"); out != "a.txt\n" {
		t.Errorf("staged = %q", out)
	}
	rec := serve(h, apiRequest("POST", path+q, `{"action":"commit","path":"a.txt"}`))
	if rec.Code != 400 || decodeBody(t, rec)["code"] != "invalid_action" {
		t.Errorf("bad action = %d %s", rec.Code, rec.Body)
	}
}

func TestApplyDiscardWithoutTrash(t *testing.T) {
	ax := newApplyFixture(t)
	ax.f.trash = nil
	ax.write(t, "a.txt", "two\n")
	ax.wantCode(t, 503, "trash_unavailable", "discard", "a.txt", map[string]any{"baseHash": ax.hash(t, "a.txt")})
	// Stage needs no trash.
	ax.applyOK(t, "stage", "a.txt", nil)
}

func TestApplyStageUnstageFile(t *testing.T) {
	ax := newApplyFixture(t)
	ax.write(t, "del.txt", "d\n")
	ax.write(t, "old.txt", "content for a rename\n")
	ax.commit(t)
	ax.write(t, "a.txt", "two\n")
	os.Remove(filepath.Join(ax.repo, "del.txt"))
	ax.write(t, "dir/new.txt", "n\n")

	ax.applyOK(t, "stage", "a.txt", nil)
	ax.applyOK(t, "stage", "del.txt", nil)
	body := ax.applyOK(t, "stage", "dir/new.txt", nil)
	if body["path"] != "dir/new.txt" || body["root"] != ax.repo {
		t.Errorf("response = %v", body)
	}
	if got := ax.cached(t); got != "M a.txt\nD del.txt\nA dir/new.txt" {
		t.Errorf("staged = %q", got)
	}
	for _, p := range []string{"a.txt", "del.txt", "dir/new.txt"} {
		ax.applyOK(t, "unstage", p, nil)
	}
	if got := ax.cached(t); got != "" {
		t.Errorf("after unstage = %q", got)
	}
	if ax.read(t, "a.txt") != "two\n" {
		t.Error("unstage changed the worktree")
	}

	// A staged rename goes back whole, given its source.
	ax.git(t, "mv", "old.txt", "new.txt")
	ax.wantCode(t, 404, "not_changed", "unstage", "new.txt", nil)
	ax.applyOK(t, "unstage", "new.txt", map[string]any{"orig": "old.txt"})
	if got := ax.cached(t); got != "" {
		t.Errorf("after rename unstage = %q", got)
	}

	// A source in a dir no write touches is refused before git runs.
	ax.wantCode(t, 403, "not_allowed", "unstage", "new.txt", map[string]any{"orig": "data/x"})
	ax.wantCode(t, 403, "not_allowed", "unstage", "new.txt", map[string]any{"orig": "../x"})
	ax.wantCode(t, 403, "not_allowed", "stage", ".git/config", nil)
	ax.wantCode(t, 400, "invalid_path", "stage", ".", nil)
	ax.wantCode(t, 400, "invalid_path", "stage", "../x", nil)
	ax.wantCode(t, 404, "not_changed", "stage", "nothing.txt", nil)
	// Staged only: nothing to stage, and nothing staged to unstage.
	ax.applyOK(t, "stage", "a.txt", nil)
	ax.wantCode(t, 404, "not_changed", "stage", "a.txt", nil)
	ax.wantCode(t, 404, "not_changed", "unstage", "old.txt", nil)
}

func TestApplyUnstageWithoutCommit(t *testing.T) {
	requireGit(t)
	repo, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	gitT(t, repo, "init", "-q")
	ax := newApplyFixtureAt(t, repo)
	ax.write(t, "a.txt", "a\n")
	ax.write(t, "b.txt", "b\n")
	ax.git(t, "add", ".")
	ax.write(t, "b.txt", "b2\n") // AM
	ax.applyOK(t, "unstage", "a.txt", nil)
	ax.applyOK(t, "unstage", "b.txt", nil)
	if got := ax.cached(t); got != "" {
		t.Errorf("after unstage = %q", got)
	}
	if ax.read(t, "b.txt") != "b2\n" {
		t.Error("unstage changed the worktree")
	}
}

func TestApplyNotARepo(t *testing.T) {
	requireGit(t)
	ax := newApplyFixtureAt(t, plainDir(t))
	ax.write(t, "a.txt", "a\n")
	ax.wantCode(t, 404, "not_changed", "stage", "a.txt", nil)
}

// twoHunks commits a file of 20 lines and changes lines 2 and 19.
func twoHunks(t *testing.T, ax *applyFixture, rel string) {
	t.Helper()
	var lines []string
	for i := 1; i <= 20; i++ {
		lines = append(lines, "line "+strings.Repeat("x", i))
	}
	ax.write(t, rel, strings.Join(lines, "\n")+"\n")
	ax.commit(t)
	lines[1], lines[18] = "CHANGED TWO", "CHANGED NINETEEN"
	ax.write(t, rel, strings.Join(lines, "\n")+"\n")
}

func TestApplyHunks(t *testing.T) {
	ax := newApplyFixture(t)
	twoHunks(t, ax, "f.txt")
	d := ax.diff(t, "f.txt", false)
	if len(d.Hunks) != 2 {
		t.Fatalf("hunks = %+v", d.Hunks)
	}
	ax.applyOK(t, "stage", "f.txt", map[string]any{"hunk": d.Hunks[1].ID})
	got := ax.git(t, "diff", "--cached", "-U0")
	if !strings.Contains(got, "+CHANGED NINETEEN") || strings.Contains(got, "CHANGED TWO") {
		t.Errorf("staged = %s", got)
	}
	// The other hunk's id still applies; the staged one is gone from this side.
	ax.wantCode(t, 409, "stale_hunk", "stage", "f.txt", map[string]any{"hunk": d.Hunks[1].ID})
	s := ax.diff(t, "f.txt", true)
	if len(s.Hunks) != 1 {
		t.Fatalf("staged hunks = %+v", s.Hunks)
	}
	ax.applyOK(t, "unstage", "f.txt", map[string]any{"hunk": s.Hunks[0].ID})
	if got := ax.cached(t); got != "" {
		t.Errorf("after hunk unstage = %q", got)
	}

	// A hunk the file no longer has changes nothing.
	d = ax.diff(t, "f.txt", false)
	ax.git(t, "add", "f.txt")
	ax.git(t, "reset", "-q")
	tree := ax.git(t, "write-tree")
	ax.write(t, "f.txt", strings.Replace(ax.read(t, "f.txt"), "CHANGED TWO", "CHANGED AGAIN", 1))
	before := ax.read(t, "f.txt")
	ax.wantCode(t, 409, "stale_hunk", "stage", "f.txt", map[string]any{"hunk": d.Hunks[0].ID})
	ax.wantCode(t, 409, "stale_hunk", "discard", "f.txt", map[string]any{"hunk": d.Hunks[0].ID})
	if ax.git(t, "write-tree") != tree || ax.read(t, "f.txt") != before {
		t.Error("a stale hunk changed the index or the file")
	}
	ax.wantCode(t, 409, "stale_hunk", "stage", "f.txt", map[string]any{"hunk": "nope"})
}

func TestApplyHunkNoPrefix(t *testing.T) {
	ax := newApplyFixture(t)
	// With diff.noprefix, "src/x.txt" read with -p1 would be "x.txt".
	writeFile(t, filepath.Join(os.Getenv("HOME"), ".gitconfig"), "[diff]\n\tnoprefix = true\n")
	twoHunks(t, ax, "src/x.txt")
	ax.write(t, "x.txt", ax.read(t, "src/x.txt"))
	ax.git(t, "add", "x.txt")
	ax.git(t, "commit", "-q", "-m", "same")
	ax.git(t, "checkout", "-q", "--", "x.txt")
	ax.write(t, "x.txt", strings.Replace(ax.read(t, "x.txt"), "CHANGED TWO", "line xx", 1))
	ax.git(t, "add", "x.txt")
	ax.git(t, "commit", "-q", "-m", "x")
	d := ax.diff(t, "src/x.txt", false)
	ax.applyOK(t, "stage", "src/x.txt", map[string]any{"hunk": d.Hunks[0].ID})
	if got := ax.cached(t); got != "M src/x.txt" {
		t.Errorf("staged = %q", got)
	}
}

func TestApplyDiscardFile(t *testing.T) {
	ax := newApplyFixture(t)
	ax.write(t, "del.txt", "d\n")
	ax.write(t, "run.sh", "echo\n")
	if runtime.GOOS != "windows" {
		os.Chmod(filepath.Join(ax.repo, "run.sh"), 0o755)
	}
	ax.commit(t)

	// Changed: the whole file, kept in the trash, undone by restore.
	ax.write(t, "a.txt", "two\n")
	ax.wantCode(t, 400, "", "discard", "a.txt", nil)
	ax.wantCode(t, 409, "changed", "discard", "a.txt", map[string]any{"baseHash": hashHex([]byte("other"))})
	if ax.read(t, "a.txt") != "two\n" {
		t.Fatal("a refused discard changed the file")
	}
	body := ax.applyOK(t, "discard", "a.txt", map[string]any{"baseHash": ax.hash(t, "a.txt")})
	id, _ := body["trashId"].(string)
	if ax.read(t, "a.txt") != "one\n" || id == "" {
		t.Fatalf("discard = %q %v", ax.read(t, "a.txt"), body)
	}
	if code, b := ax.post(t, "restore", map[string]any{"trashId": id}); code != 200 || b["path"] != "a.txt" {
		t.Fatalf("restore = %d %v", code, b)
	}
	if ax.read(t, "a.txt") != "two\n" {
		t.Errorf("restored = %q", ax.read(t, "a.txt"))
	}
	if code, _ := ax.post(t, "restore", map[string]any{"trashId": id}); code != 404 {
		t.Errorf("second restore = %d", code)
	}

	// Deleted: made again with its mode, nothing in the trash.
	os.Remove(filepath.Join(ax.repo, "del.txt"))
	os.Remove(filepath.Join(ax.repo, "run.sh"))
	if body := ax.applyOK(t, "discard", "del.txt", nil); body["trashId"] != nil {
		t.Errorf("deleted discard = %v", body)
	}
	ax.applyOK(t, "discard", "run.sh", nil)
	if ax.read(t, "del.txt") != "d\n" || ax.read(t, "run.sh") != "echo\n" {
		t.Error("deleted files not back")
	}
	if fi, _ := os.Stat(filepath.Join(ax.repo, "run.sh")); runtime.GOOS != "windows" && fi.Mode().Perm() != 0o755 {
		t.Errorf("run.sh mode = %v", fi.Mode())
	}

	// Untracked: the delete route's code, under the apply's locks.
	ax.write(t, "new.txt", "n\n")
	ax.wantCode(t, 400, "", "discard", "new.txt", nil)
	done := make(chan map[string]any)
	go func() {
		_, b := ax.apply(t, "discard", "new.txt", map[string]any{"baseHash": ax.hash(t, "new.txt")})
		done <- b
	}()
	select {
	case body = <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("discard of an untracked file hangs")
	}
	if _, err := os.Stat(filepath.Join(ax.repo, "new.txt")); err == nil || body["trashId"] == nil {
		t.Fatalf("untracked discard = %v", body)
	}
	if code, b := ax.post(t, "restore", map[string]any{"trashId": body["trashId"]}); code != 200 || ax.read(t, "new.txt") != "n\n" {
		t.Errorf("untracked restore = %d %v", code, b)
	}

	// On another file system than the trash: asked again, then deleted.
	setTrashRename(t, crossDevice)
	ax.wantCode(t, 409, "cross_device", "discard", "new.txt", map[string]any{"baseHash": ax.hash(t, "new.txt")})
	body = ax.applyOK(t, "discard", "new.txt", map[string]any{"baseHash": ax.hash(t, "new.txt"), "permanent": true})
	if body["permanent"] != true {
		t.Errorf("permanent = %v", body)
	}
}

func TestApplyDiscardHunk(t *testing.T) {
	ax := newApplyFixture(t)
	twoHunks(t, ax, "f.txt")
	changed := ax.read(t, "f.txt")
	d := ax.diff(t, "f.txt", false)
	body := ax.applyOK(t, "discard", "f.txt", map[string]any{"hunk": d.Hunks[0].ID})
	got := ax.read(t, "f.txt")
	if strings.Contains(got, "CHANGED TWO") || !strings.Contains(got, "CHANGED NINETEEN") {
		t.Fatalf("after hunk discard = %q", got)
	}
	// Undo, once the file was written again since: refused, file kept.
	ax.write(t, "f.txt", got+"more\n")
	if code, b := ax.post(t, "restore", map[string]any{"trashId": body["trashId"]}); code != 409 || b["code"] != "changed" {
		t.Errorf("restore over a change = %d %v", code, b)
	}
	ax.write(t, "f.txt", got)
	if code, b := ax.post(t, "restore", map[string]any{"trashId": body["trashId"]}); code != 200 || ax.read(t, "f.txt") != changed {
		t.Errorf("restore = %d %v", code, b)
	}
	// A hunk on a side without hunks.
	ax.write(t, "u.txt", "u\n")
	ax.wantCode(t, 409, "hunk_unsupported", "discard", "u.txt", map[string]any{"hunk": "x", "baseHash": ax.hash(t, "u.txt")})
}

func TestApplyDiscardModeChange(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no executable bit")
	}
	ax := newApplyFixture(t)
	ax.write(t, "a.txt", "two\n")
	os.Chmod(filepath.Join(ax.repo, "a.txt"), 0o755)
	ax.applyOK(t, "discard", "a.txt", map[string]any{"baseHash": ax.hash(t, "a.txt")})
	fi, _ := os.Stat(filepath.Join(ax.repo, "a.txt"))
	if ax.read(t, "a.txt") != "one\n" || fi.Mode().Perm() != 0o644 {
		t.Errorf("discard = %q %v", ax.read(t, "a.txt"), fi.Mode())
	}
}

func TestApplyRestoreDiscardRefused(t *testing.T) {
	ax := newApplyFixture(t)
	discard := func() string {
		t.Helper()
		ax.write(t, "a.txt", "two\n")
		body := ax.applyOK(t, "discard", "a.txt", map[string]any{"baseHash": ax.hash(t, "a.txt")})
		return body["trashId"].(string)
	}
	restore := func(id, want string) {
		t.Helper()
		if code, b := ax.post(t, "restore", map[string]any{"trashId": id}); b["code"] != want {
			t.Errorf("restore = %d %v, want %s", code, b, want)
		}
	}
	p := filepath.Join(ax.repo, "a.txt")
	id := discard()
	os.Remove(p)
	restore(id, "changed")
	if _, err := os.Stat(p); err == nil {
		t.Error("restore made a missing file")
	}
	ax.git(t, "checkout", "--", "a.txt")
	if err := os.WriteFile(p, make([]byte, maxPreviewSize+1), 0o644); err != nil {
		t.Fatal(err)
	}
	restore(id, "changed")
	ax.git(t, "checkout", "--", "a.txt")
	if runtime.GOOS != "windows" {
		other := filepath.Join(ax.repo, "other.txt")
		writeFile(t, other, "one\n")
		os.Remove(p)
		os.Symlink("other.txt", p)
		restore(id, "changed")
		os.Remove(p)
		os.Link(other, p)
		restore(id, "changed")
		if readText(t, other) != "one\n" {
			t.Error("restore wrote through a link")
		}
		os.Remove(p)
		os.Remove(other)
		ax.git(t, "checkout", "--", "a.txt")
	}
	// The payload went: nothing to put back.
	os.Remove(filepath.Join(ax.trashDir, id))
	restore(id, "not_in_trash")
	// Too large to be put back.
	id = discard()
	if err := os.WriteFile(filepath.Join(ax.trashDir, id), make([]byte, discardMax+1), 0o600); err != nil {
		t.Fatal(err)
	}
	restore(id, "too_large")
}

func TestApplyRestoreDiscardSymlinkDir(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	ax := newApplyFixture(t)
	ax.write(t, "d/a.txt", "one\n")
	ax.commit(t)
	ax.write(t, "d/a.txt", "two\n")
	body := ax.applyOK(t, "discard", "d/a.txt", map[string]any{"baseHash": ax.hash(t, "d/a.txt")})
	// The dir is now a symlink to another holding the same file.
	os.Rename(filepath.Join(ax.repo, "d"), filepath.Join(ax.repo, "e"))
	os.Symlink("e", filepath.Join(ax.repo, "d"))
	if code, b := ax.post(t, "restore", map[string]any{"trashId": body["trashId"]}); b["code"] != "changed" {
		t.Errorf("restore through a symlink dir = %d %v", code, b)
	}
	if ax.read(t, "e/a.txt") != "one\n" {
		t.Error("restore wrote through a symlink dir")
	}
}

func TestApplyDiscardChangedDuringWrite(t *testing.T) {
	ax := newApplyFixture(t)
	ax.write(t, "a.txt", "two\n")
	setFindHook(t, &applyBeforeWrite, func() { ax.write(t, "a.txt", "agent\n") })
	ax.wantCode(t, 409, "changed", "discard", "a.txt", map[string]any{"baseHash": ax.hash(t, "a.txt")})
	if ax.read(t, "a.txt") != "agent\n" {
		t.Error("the agent's write was lost")
	}
	// Nothing of the refused discard stays in the trash.
	if ents, _ := os.ReadDir(ax.trashDir); len(ents) != 0 {
		t.Errorf("trash = %v", ents)
	}
	// A deleted file that came back meanwhile is not replaced.
	ax.git(t, "checkout", "--", "a.txt")
	os.Remove(filepath.Join(ax.repo, "a.txt"))
	ax.wantCode(t, 409, "changed", "discard", "a.txt", nil)
	if ax.read(t, "a.txt") != "agent\n" {
		t.Error("recreate replaced a file")
	}
}

func TestApplyFilters(t *testing.T) {
	ax := newApplyFixture(t)
	ax.write(t, ".gitattributes", "*.bin filter=lfs\nassets/** filter=lfs\nbig.dat filter=lfs\nx.y filter=nodriver\nno.txt -filter\n")
	for _, p := range []string{"a.bin", "assets/deep/img.png", "big.dat", "x.y", "no.txt"} {
		ax.write(t, p, "v1\n")
	}
	ax.commit(t)
	for _, p := range []string{"a.bin", "assets/deep/img.png", "big.dat", "x.y"} {
		ax.write(t, p, "v2\n")
		ax.wantCode(t, 409, "filtered", "stage", p, nil)
		ax.wantCode(t, 409, "filtered", "discard", p, map[string]any{"baseHash": ax.hash(t, p)})
		ax.git(t, "add", p)
		ax.wantCode(t, 409, "filtered", "unstage", p, nil)
	}
	// Unset is not a filter.
	ax.write(t, "no.txt", "v2\n")
	ax.applyOK(t, "stage", "no.txt", nil)
}

func TestApplyRefusals(t *testing.T) {
	ax := newApplyFixture(t)
	ax.write(t, ".env", "A=1\n")
	ax.write(t, "old.txt", "content for a rename\nsecond line\n")
	ax.write(t, "big.txt", strings.Repeat("x", maxPreviewSize+1))
	ax.commit(t)

	// Sensitive, unless revealed.
	ax.write(t, ".env", "A=2\n")
	ax.wantCode(t, 403, "sensitive", "stage", ".env", nil)
	ax.applyOK(t, "stage", ".env", map[string]any{"reveal": true})

	// Locked by another git.
	ax.write(t, "a.txt", "two\n")
	lock := filepath.Join(ax.repo, ".git", "index.lock")
	writeFile(t, lock, "")
	ax.wantCode(t, 409, "index_locked", "stage", "a.txt", nil)
	os.Remove(lock)

	// Rename with a change on top: whole file only.
	ax.git(t, "mv", "old.txt", "new.txt")
	ax.write(t, "new.txt", "content for a rename\nchanged\n")
	ax.wantCode(t, 409, "hunk_unsupported", "stage", "new.txt", map[string]any{"orig": "old.txt", "hunk": "x"})
	ax.wantCode(t, 409, "hunk_unsupported", "unstage", "new.txt", map[string]any{"orig": "old.txt", "hunk": "x"})

	// Larger than a discard keeps, in the worktree or the index.
	ax.write(t, "big.txt", "small\n")
	ax.wantCode(t, 413, "too_large", "discard", "big.txt", map[string]any{"baseHash": ax.hash(t, "big.txt")})
	ax.write(t, "big.txt", strings.Repeat("y", maxPreviewSize+1))
	ax.wantCode(t, 413, "too_large", "discard", "big.txt", map[string]any{"baseHash": ax.hash(t, "big.txt")})
	if len(ax.read(t, "big.txt")) != maxPreviewSize+1 {
		t.Error("a refused discard changed big.txt")
	}

	// Intent to add: nothing to stage by this route, nothing to discard to.
	ax.write(t, "ita.txt", "i\n")
	ax.git(t, "add", "-N", "ita.txt")
	ax.wantCode(t, 409, "unsupported", "stage", "ita.txt", nil)
	ax.wantCode(t, 409, "unsupported", "discard", "ita.txt", map[string]any{"baseHash": ax.hash(t, "ita.txt")})

	if runtime.GOOS != "windows" {
		// A file turned into a symlink (T), and a changed symlink.
		os.Remove(filepath.Join(ax.repo, "a.txt"))
		os.Symlink("old.txt", filepath.Join(ax.repo, "a.txt"))
		ax.wantCode(t, 409, "unsupported", "stage", "a.txt", nil)
		ax.wantCode(t, 409, "unsupported", "discard", "a.txt", nil)
		os.Symlink("x", filepath.Join(ax.repo, "ln"))
		ax.git(t, "add", "ln")
		ax.git(t, "commit", "-q", "-m", "ln")
		os.Remove(filepath.Join(ax.repo, "ln"))
		os.Symlink("y", filepath.Join(ax.repo, "ln"))
		ax.wantCode(t, 409, "unsupported", "discard", "ln", nil)
		ax.applyOK(t, "stage", "ln", nil)
	}
}

func TestApplyConflict(t *testing.T) {
	ax := newApplyFixture(t)
	ax.git(t, "checkout", "-q", "-b", "other")
	ax.write(t, "a.txt", "theirs\n")
	ax.git(t, "commit", "-q", "-am", "theirs")
	ax.git(t, "checkout", "-q", "main")
	ax.write(t, "a.txt", "ours\n")
	ax.git(t, "commit", "-q", "-am", "ours")
	exec.Command("git", "-C", ax.repo, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "other").Run()
	for _, action := range []string{"stage", "unstage", "discard"} {
		ax.wantCode(t, 409, "conflict", action, "a.txt", map[string]any{"baseHash": ax.hash(t, "a.txt")})
	}
}

func TestApplyLineBreaks(t *testing.T) {
	for _, c := range []struct{ name, autocrlf, eol string }{
		{"autocrlf", "true", "\r\n"},
		{"crlf in index", "false", "\r\n"},
	} {
		t.Run(c.name, func(t *testing.T) {
			ax := newApplyFixture(t)
			ax.git(t, "config", "core.autocrlf", c.autocrlf)
			body := "a\nb\nc\nd\ne\nf\ng\nh\ni\nj"
			if c.autocrlf == "false" {
				ax.write(t, "f.txt", strings.ReplaceAll(body, "\n", c.eol))
			} else {
				ax.write(t, "f.txt", body)
			}
			ax.commit(t)
			changed := strings.ReplaceAll("a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\n", "\n", c.eol)
			ax.write(t, "f.txt", changed)
			d := ax.diff(t, "f.txt", false)
			if len(d.Hunks) != 2 {
				t.Fatalf("hunks = %+v", d.Hunks)
			}
			ax.applyOK(t, "discard", "f.txt", map[string]any{"hunk": d.Hunks[1].ID})
			want := strings.ReplaceAll("a\nB\nc\nd\ne\nf\ng\nh\ni\nj", "\n", c.eol)
			if got := ax.read(t, "f.txt"); got != want {
				t.Errorf("hunk discard = %q, want %q", got, want)
			}
			ax.applyOK(t, "discard", "f.txt", map[string]any{"baseHash": ax.hash(t, "f.txt")})
			if got := ax.read(t, "f.txt"); got != strings.ReplaceAll(body, "\n", c.eol) {
				t.Errorf("whole discard = %q", got)
			}
		})
	}
}

func TestApplyWriteOutlivesRequest(t *testing.T) {
	requireUnixShell(t)
	ax := newApplyFixture(t)
	ax.write(t, "a.txt", "two\n")
	git, err := exec.LookPath("git")
	if err != nil {
		t.Skip(err)
	}
	ax.f.git.bin = writeScript(t, "sleep 0.3\nexec "+git+` "$@"`)
	ctx, cancel := context.WithCancel(t.Context())
	time.AfterFunc(50*time.Millisecond, cancel)
	err = ax.f.gitWrite(ctx, filesRoot{Root: ax.repo}, nil, "add", "--", "a.txt")
	if err != nil {
		t.Fatalf("write after the request ended: %v", err)
	}
	if got := ax.cached(t); got != "M a.txt" {
		t.Errorf("staged = %q", got)
	}
	if _, err := os.Stat(filepath.Join(ax.repo, ".git", "index.lock")); err == nil {
		t.Error("index.lock left behind")
	}
}

func TestApplyWriteInterruptedAtTimeout(t *testing.T) {
	requireUnixShell(t)
	ax := newApplyFixture(t)
	mark := filepath.Join(t.TempDir(), "interrupted")
	ax.f.git.bin = writeScript(t, "trap 'touch "+mark+"; exit 130' INT\nsleep 5 &\nwait")
	ax.f.git.writeTimeout = 200 * time.Millisecond
	if err := ax.f.gitWrite(t.Context(), filesRoot{Root: ax.repo}, nil, "add", "--", "a.txt"); err != errGitTimeout {
		t.Errorf("err = %v", err)
	}
	if _, err := os.Stat(mark); err != nil {
		t.Error("git was not interrupted")
	}
}

func TestDiscardable(t *testing.T) {
	if discardable(&changeEntry{modeIndex: "120000"}) || discardable(&changeEntry{modeWorktree: "160000"}) {
		t.Error("symlink or submodule discardable")
	}
	if !discardable(&changeEntry{modeIndex: "100644", modeWorktree: "100755"}) {
		t.Error("regular file refused")
	}
	if indexPerm("100755") != 0o755 || indexPerm("100644") != 0o644 {
		t.Error("indexPerm")
	}
}

func TestApplyGitFailures(t *testing.T) {
	requireUnixShell(t)
	ax := newApplyFixture(t)
	ax.write(t, "a.txt", "two\n")
	root := filesRoot{Root: ax.repo, IsRepo: true}
	ax.f.git.bin = writeScript(t, "exit 1")
	if err := ax.f.checkFilters(t.Context(), root, "a.txt"); err == nil {
		t.Error("check-attr failure: no error")
	}
	if _, err := ax.f.indexVersion(t.Context(), root, "a.txt"); err == nil {
		t.Error("cat-file failure: no error")
	}
	ax.f.git.bin = writeScript(t, "echo nonsense")
	if _, err := ax.f.indexVersion(t.Context(), root, "a.txt"); err == nil {
		t.Error("bad size: no error")
	}
	ax.f.git.bin = writeScript(t, `case "$*" in *-s*) echo 3;; *) exit 1;; esac`)
	if _, err := ax.f.indexVersion(t.Context(), root, "a.txt"); err == nil {
		t.Error("cat-file --filters failure: no error")
	}
	ax.f.git.bin = writeScript(t, `case "$*" in *-s*) echo 3;; *) head -c 2000000 /dev/zero;; esac`)
	if _, err := ax.f.indexVersion(t.Context(), root, "a.txt"); err != errEditTooLarge {
		t.Errorf("grown past the limit: %v", err)
	}
	// rev-parse fails some other way than a missing HEAD.
	ax.f.git.bin = "/nonexistent/git"
	if err := ax.f.unstageFile(t.Context(), root, applyRequest{Path: "a.txt"}); err == nil {
		t.Error("no git: no error")
	}
}

func TestApplyBusyAndStatusFailure(t *testing.T) {
	ax := newApplyFixture(t)
	ax.write(t, "a.txt", "two\n")
	for range cap(ax.f.writeSlots) {
		ax.f.writeSlots <- struct{}{}
	}
	ax.wantCode(t, 429, "busy", "stage", "a.txt", nil)
	for range cap(ax.f.writeSlots) {
		<-ax.f.writeSlots
	}
	requireUnixShell(t)
	ax.f.git.bin = writeScript(t, "exit 1")
	if code, _ := ax.apply(t, "stage", "a.txt", nil); code != 500 {
		t.Errorf("failing status = %d", code)
	}
}

// failGit makes git fail for the commands whose argv contains word, and
// run as itself otherwise.
func failGit(t *testing.T, ax *applyFixture, word string) {
	t.Helper()
	requireUnixShell(t)
	git, err := exec.LookPath("git")
	if err != nil {
		t.Skip(err)
	}
	ax.f.git.bin = writeScript(t, `case " $* " in *" `+word+` "*) exit 2;; esac
exec `+git+` "$@"`)
}

func TestApplyGitStepFails(t *testing.T) {
	ax := newApplyFixture(t)
	twoHunks(t, ax, "f.txt")
	ax.write(t, "del.txt", "d\n")
	ax.commit(t)
	ax.write(t, "f.txt", strings.Replace(ax.read(t, "f.txt"), "line x\n", "CHANGED\n", 1))
	os.Remove(filepath.Join(ax.repo, "del.txt"))
	d := ax.diff(t, "f.txt", false)
	tree := ax.git(t, "write-tree")

	failGit(t, ax, "apply")
	ax.wantCode(t, 409, "stale_hunk", "stage", "f.txt", map[string]any{"hunk": d.Hunks[0].ID})
	failGit(t, ax, "diff")
	if code, _ := ax.apply(t, "stage", "f.txt", map[string]any{"hunk": d.Hunks[0].ID}); code != 500 {
		t.Errorf("failing diff = %d", code)
	}
	failGit(t, ax, "cat-file")
	if code, _ := ax.apply(t, "discard", "del.txt", nil); code != 500 {
		t.Errorf("failing cat-file = %d", code)
	}
	if code, _ := ax.apply(t, "discard", "f.txt", map[string]any{"baseHash": ax.hash(t, "f.txt")}); code != 500 {
		t.Errorf("failing cat-file = %d", code)
	}
	if ax.git(t, "write-tree") != tree {
		t.Error("a failed step changed the index")
	}
	if _, err := os.Stat(filepath.Join(ax.repo, "del.txt")); err == nil {
		t.Error("a failed step made del.txt")
	}
}

func TestApplyDiscardFileChangesBeforeRead(t *testing.T) {
	ax := newApplyFixture(t)
	twoHunks(t, ax, "d/f.txt")
	d := ax.diff(t, "d/f.txt", false)
	p := filepath.Join(ax.repo, "d", "f.txt")
	changed := ax.read(t, "d/f.txt")
	hook := func(fn func()) { setFindHook(t, &applyBeforeRead, fn) }

	// The hunk's lines changed after the diff.
	hook(func() { writeFile(t, p, strings.Replace(changed, "CHANGED TWO", "AGAIN", 1)) })
	ax.wantCode(t, 409, "stale_hunk", "discard", "d/f.txt", map[string]any{"hunk": d.Hunks[0].ID})
	// The file went.
	writeFile(t, p, changed)
	hook(func() { os.Remove(p) })
	if code, _ := ax.apply(t, "discard", "d/f.txt", map[string]any{"baseHash": hashHex([]byte(changed))}); code != 404 {
		t.Errorf("file gone = %d", code)
	}
	// Its directory went.
	writeFile(t, p, changed)
	hook(func() { os.RemoveAll(filepath.Join(ax.repo, "d")) })
	if code, _ := ax.apply(t, "discard", "d/f.txt", map[string]any{"baseHash": hashHex([]byte(changed))}); code != 404 {
		t.Errorf("dir gone = %d", code)
	}
	if runtime.GOOS == "windows" {
		return
	}
	// Its directory became a symlink.
	writeFile(t, p, changed)
	hook(func() {
		os.Rename(filepath.Join(ax.repo, "d"), filepath.Join(ax.repo, "e"))
		os.Symlink("e", filepath.Join(ax.repo, "d"))
	})
	ax.wantCode(t, 422, "not_editable", "discard", "d/f.txt", map[string]any{"baseHash": hashHex([]byte(changed))})
	if ax.read(t, "e/f.txt") != changed {
		t.Error("discard wrote through a symlink dir")
	}
	hook(func() {})
	os.Remove(filepath.Join(ax.repo, "d"))
	os.Rename(filepath.Join(ax.repo, "e"), filepath.Join(ax.repo, "d"))
	// A second hard link: replacing the file would split them.
	other := filepath.Join(t.TempDir(), "link")
	if err := os.Link(p, other); err != nil {
		t.Skip(err)
	}
	ax.wantCode(t, 422, "not_editable", "discard", "d/f.txt", map[string]any{"baseHash": hashHex([]byte(changed))})
}

func TestApplyDiscardTrashFails(t *testing.T) {
	ax := newApplyFixture(t)
	ax.write(t, "a.txt", "two\n")
	os.RemoveAll(ax.trashDir)
	ax.wantCode(t, 503, "trash_unavailable", "discard", "a.txt", map[string]any{"baseHash": ax.hash(t, "a.txt")})
	if ax.read(t, "a.txt") != "two\n" {
		t.Error("discard without a copy changed the file")
	}
}

func TestApplyRecreateRefused(t *testing.T) {
	ax := newApplyFixture(t)
	ax.write(t, "d/x.txt", "x\n")
	ax.write(t, "ro/y.txt", "y\n")
	ax.commit(t)
	// The directory became a file.
	os.RemoveAll(filepath.Join(ax.repo, "d"))
	ax.write(t, "d", "file\n")
	ax.wantCode(t, 409, "not_directory", "discard", "d/x.txt", nil)
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		return
	}
	// A directory the server cannot write.
	ro := filepath.Join(ax.repo, "ro")
	os.Remove(filepath.Join(ro, "y.txt"))
	os.Chmod(ro, 0o555)
	t.Cleanup(func() { os.Chmod(ro, 0o755) })
	ax.wantCode(t, 403, "permission", "discard", "ro/y.txt", nil)
}

func TestApplyRestoreDiscardErrors(t *testing.T) {
	ax := newApplyFixture(t)
	ax.write(t, "d/a.txt", "one\n")
	ax.commit(t)
	discard := func() string {
		t.Helper()
		ax.write(t, "d/a.txt", "two\n")
		return ax.applyOK(t, "discard", "d/a.txt", map[string]any{"baseHash": ax.hash(t, "d/a.txt")})["trashId"].(string)
	}
	id := discard()
	// Written again between the checks and the rename.
	setFindHook(t, &applyBeforeWrite, func() { ax.write(t, "d/a.txt", "agent\n") })
	if code, b := ax.post(t, "restore", map[string]any{"trashId": id}); b["code"] != "changed" {
		t.Errorf("restore over a late write = %d %v", code, b)
	}
	setFindHook(t, &applyBeforeWrite, func() {})
	if ax.read(t, "d/a.txt") != "agent\n" {
		t.Error("restore replaced a late write")
	}
	// The directory became a file.
	ax.git(t, "checkout", "--", "d/a.txt")
	os.RemoveAll(filepath.Join(ax.repo, "d"))
	ax.write(t, "d", "file\n")
	if code, b := ax.post(t, "restore", map[string]any{"trashId": id}); b["code"] != "changed" {
		t.Errorf("restore under a file = %d %v", code, b)
	}
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		return
	}
	// A file the server cannot read.
	os.Remove(filepath.Join(ax.repo, "d"))
	ax.git(t, "checkout", "--", "d/a.txt")
	p := filepath.Join(ax.repo, "d", "a.txt")
	os.Chmod(p, 0)
	t.Cleanup(func() { os.Chmod(p, 0o644) })
	if code, _ := ax.post(t, "restore", map[string]any{"trashId": id}); code != 403 {
		t.Errorf("restore of an unreadable file = %d", code)
	}
}

func TestTrashKeepCopySweep(t *testing.T) {
	tt := newTestTrash(t)
	s := tt.trashStore
	id, err := s.keepCopy(trashRecord{Root: "/r", Path: "a", Kind: "discard", DeletedAt: s.now(), After: "x"}, []byte("kept"))
	if err != nil || !tt.has(id) || !tt.has(id+".json") {
		t.Fatalf("keepCopy = %q %v", id, err)
	}
	if fi, _ := os.Stat(filepath.Join(s.dir, id)); runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600 {
		t.Errorf("payload mode = %v", fi.Mode())
	}
	// A discard record whose payload went is dropped like a file's.
	os.Remove(filepath.Join(s.dir, id))
	tt.sweep()
	tt.clock = tt.clock.Add(s.orphanAge)
	tt.sweep()
	if tt.has(id + ".json") {
		t.Error("discard record without payload kept")
	}
	id, _ = s.keepCopy(trashRecord{Kind: "discard", DeletedAt: s.now()}, []byte("x"))
	s.removeEntry(id)
	if tt.has(id) || tt.has(id+".json") {
		t.Error("removeEntry left the entry")
	}
}

func TestApplyRootGone(t *testing.T) {
	ax := newApplyFixture(t)
	ax.write(t, "a.txt", "two\n")
	moved := ax.repo + "-moved"
	t.Cleanup(func() { os.Rename(moved, ax.repo) })
	setFindHook(t, &applyBeforeRead, func() { os.Rename(ax.repo, moved) })
	if code, _ := ax.apply(t, "discard", "a.txt", map[string]any{"baseHash": ax.hash(t, "a.txt")}); code != 404 {
		t.Errorf("discard in a root gone = %d", code)
	}
	os.Rename(moved, ax.repo)
	setFindHook(t, &applyBeforeRead, func() {})
	id := ax.applyOK(t, "discard", "a.txt", map[string]any{"baseHash": ax.hash(t, "a.txt")})["trashId"]
	setFindHook(t, &restoreBeforeLock, func() { os.Rename(ax.repo, moved) })
	if code, _ := ax.post(t, "restore", map[string]any{"trashId": id}); code != 404 {
		t.Errorf("restore in a root gone = %d", code)
	}
}

func TestApplyDiscardHunkLineBreaksOnly(t *testing.T) {
	ax := newApplyFixture(t)
	ax.git(t, "config", "core.autocrlf", "false")
	ax.write(t, "f.txt", "a\nb\n")
	ax.commit(t)
	ax.write(t, "f.txt", "a\r\nb\r\n")
	d := ax.diff(t, "f.txt", false)
	ax.wantCode(t, 409, "unsupported", "discard", "f.txt", map[string]any{"hunk": d.Hunks[0].ID})
	if ents, _ := os.ReadDir(ax.trashDir); len(ents) != 0 || ax.read(t, "f.txt") != "a\r\nb\r\n" {
		t.Errorf("trash = %v, file = %q", ents, ax.read(t, "f.txt"))
	}
}

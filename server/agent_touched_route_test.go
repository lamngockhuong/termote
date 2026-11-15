package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// touchedEdit is a Claude Code Edit call on path, and its result.
func touchedEditRows(id, path string, isErr bool) []string {
	q, _ := json.Marshal(path)
	errField := ""
	if isErr {
		errField = `,"is_error":true`
	}
	return []string{
		`{"type":"assistant","timestamp":"2026-11-10T10:00:00Z","message":{"content":[{"type":"tool_use","id":"` + id +
			`","name":"Edit","input":{"file_path":` + string(q) + `}}]}}`,
		`{"type":"user","timestamp":"2026-11-10T10:00:01Z","message":{"content":[{"type":"tool_result","tool_use_id":"` + id +
			`","content":"ok"` + errField + `}]}}`,
	}
}

func getTouched(t *testing.T, h http.Handler, req *http.Request) (int, touchedResponse, string) {
	t.Helper()
	rec := serve(h, req)
	var res touchedResponse
	if rec.Code == 200 {
		if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
			t.Fatal(err)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
			t.Errorf("Cache-Control = %q", cc)
		}
	}
	return rec.Code, res, rec.Body.String()
}

func touchedPaths(res touchedResponse) map[string]touchedJSON {
	out := map[string]touchedJSON{}
	for _, f := range res.Files {
		out[f.Path] = f
	}
	return out
}

func TestTouchedRoute(t *testing.T) {
	fx := newHistoryFixture(t)
	gitInit(t, fx.root)
	outside := realTemp(t)
	deny := filepath.Join(fx.root, "secret") // a deny dir under the root, as ~/.ssh under a home pane
	writeFile(t, filepath.Join(fx.root, "tracked.go"), "x")
	writeFile(t, filepath.Join(fx.root, ".env"), "x")
	writeFile(t, filepath.Join(fx.root, "pkg", "b.go"), "x")
	gitRun(t, fx.root, "add", ".")
	gitRun(t, fx.root, "commit", "-qm", "init")
	writeFile(t, filepath.Join(fx.root, "new.go"), "x")
	writeFile(t, filepath.Join(outside, "o.go"), "x")
	symlinked := filepath.Join(fx.root, "out-link")
	if err := os.Symlink(filepath.Join(outside, "o.go"), symlinked); err != nil {
		t.Skip("symlinks:", err)
	}

	var rows []string
	for i, p := range []string{
		filepath.Join(fx.root, "tracked.go"), filepath.Join(fx.root, ".env"), filepath.Join(fx.root, "pkg", "b.go"),
		filepath.Join(fx.root, "new.go"), filepath.Join(fx.root, "gone.go"),
		// Left out: outside, climbing out, a link leading out, the git
		// dir, a deny dir, the root itself.
		filepath.Join(outside, "o.go"), fx.root + string(filepath.Separator) + ".." + string(filepath.Separator) + "x.go",
		symlinked, filepath.Join(fx.root, ".git", "config"), filepath.Join(deny, "id_rsa"), fx.root,
	} {
		rows = append(rows, touchedEditRows("t"+string(rune('a'+i)), p, false)...)
	}
	rows = append(rows, touchedEditRows("fail", filepath.Join(fx.root, "failed.go"), true)...)
	writeClaudeSession(t, fx.claude, fx.root, histID1, claudeRows(fx.root, "main", "hi", rows...), time.Now())
	subs := filepath.Join(fx.claude, "projects", claudeProjectName(fx.root), histID1, "subagents")
	writeFile(t, filepath.Join(subs, "agent-a1.jsonl"),
		strings.Join(touchedEditRows("s1", filepath.Join(fx.root, "pkg", "sub.go"), false), "\n")+"\n")

	m := newHistoryMux(t, fx.root)
	m.sessions["0"] = AgentSession{Agent: "claude", ID: histID1, ClaudeDir: fx.claude}
	t.Setenv("CLAUDE_CONFIG_DIR", fx.claude)
	t.Setenv("CODEX_HOME", fx.codex)
	h := tasksHandler(t, m, deny)

	code, res, body := getTouched(t, h, apiRequest("GET", "/api/mux/panes/0/agent/touched", ""))
	if code != 200 {
		t.Fatalf("code = %d %s", code, body)
	}
	got := touchedPaths(res)
	if tr := got["tracked.go"]; tr.Count != 1 || len(tr.Ops) != 1 || tr.Ops[0] != "edit" || tr.LastAt != "2026-11-10T10:00:01Z" || tr.Sensitive || tr.Sub {
		t.Errorf("tracked.go = %+v", tr)
	}
	if env := got[".env"]; !env.Sensitive {
		t.Errorf(".env = %+v", env)
	}
	if s := got["pkg/sub.go"]; !s.Sub {
		t.Errorf("a subagent's file = %+v", s)
	}
	for _, p := range []string{"pkg/b.go", "new.go", "gone.go"} {
		if _, ok := got[p]; !ok {
			t.Errorf("%s missing", p)
		}
	}
	if len(res.Files) != 6 || res.Skipped != 6 || res.Truncated {
		t.Errorf("files = %v, skipped %d, truncated %v", got, res.Skipped, res.Truncated)
	}
	for _, leak := range []string{outside, "o.go", "id_rsa", ".git", "failed.go", fx.root} {
		if strings.Contains(body, leak) {
			t.Errorf("the reply holds %q: %s", leak, body)
		}
	}

	// The same session through the history; a view-only client gets the
	// tracked files it may read, by name only, in name order.
	q := "/api/mux/panes/0/agent/touched?agent=claude&session=" + histID1
	if code, hist, _ := getTouched(t, h, apiRequest("GET", q, "")); code != 200 || len(hist.Files) != 6 {
		t.Errorf("history session = %d %+v", code, hist)
	}
	code, view, body := getTouched(t, h, viewRequest("GET", q, ""))
	if code != 200 {
		t.Fatalf("view = %d %s", code, body)
	}
	if len(view.Files) != 3 || view.Files[0].Path != ".env" || view.Files[1].Path != "pkg/b.go" || view.Files[2].Path != "tracked.go" ||
		view.Skipped != 0 || !view.Files[0].Sensitive {
		t.Errorf("view = %+v", view)
	}
	for _, field := range []string{`"ops"`, `"count"`, `"lastAt"`, `"sub"`, `"running"`} {
		if strings.Contains(body, field) {
			t.Errorf("view reply holds %s: %s", field, body)
		}
	}

	for q, want := range map[string]int{
		"?agent=claude&session=" + histID2: 404,
		"?agent=gemini&session=" + histID1: 400,
	} {
		if rec := serve(h, apiRequest("GET", "/api/mux/panes/0/agent/touched"+q, "")); rec.Code != want {
			t.Errorf("%s = %d, want %d", q, rec.Code, want)
		}
	}
	if rec := serve(h, apiRequest("GET", "/api/mux/panes/1/agent/touched", "")); rec.Code != 404 {
		t.Errorf("no agent = %d", rec.Code)
	}
	m.sessions["2"] = AgentSession{Agent: "claude", ID: histID3, ClaudeDir: fx.claude}
	if code, none, _ := getTouched(t, h, apiRequest("GET", "/api/mux/panes/2/agent/touched", "")); code != 200 || len(none.Files) != 0 {
		t.Errorf("not written = %d %+v", code, none)
	}
	m.sessions["3"] = AgentSession{Agent: "claude", ID: histID3}
	if rec := serve(h, apiRequest("GET", "/api/mux/panes/3/agent/touched", "")); rec.Code != 404 {
		t.Errorf("no transcript = %d", rec.Code)
	}
	req := apiRequest("GET", "/api/mux/panes/0/agent/touched", "")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(h, req); rec.Code != 403 {
		t.Errorf("cross-site = %d", rec.Code)
	}
	if rec := serve(h, apiRequest("POST", "/api/mux/panes/0/agent/touched", "{}")); rec.Code != 405 {
		t.Errorf("POST = %d", rec.Code)
	}
}

func TestTouchedRouteCodex(t *testing.T) {
	fx := newHistoryFixture(t)
	gitInit(t, fx.root)
	now := time.Now()
	q, _ := json.Marshal(filepath.Join(fx.root, "a.txt"))
	body := codexMetaLine(histID2, fx.root, nil) + "\n" +
		`{"timestamp":"2026-11-10T10:00:00Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","status":"completed","changes":{` +
		string(q) + `:{"type":"add"}}}}}` + "\n"
	writeCodexFile(t, fx.codex, histID2, body, now)
	m := newHistoryMux(t, fx.root)
	h := historyServer(t, fx, m)
	code, res, raw := getTouched(t, h, apiRequest("GET", "/api/mux/panes/0/agent/touched?agent=codex&session="+histID2, ""))
	if code != 200 || len(res.Files) != 1 || res.Files[0].Path != "a.txt" || res.Files[0].Ops[0] != "write" {
		t.Errorf("codex = %d %s", code, raw)
	}
}

func TestTouchedRouteViewRefusals(t *testing.T) {
	fx := newHistoryFixture(t)
	m := newHistoryMux(t, fx.root)
	m.sessions["0"] = AgentSession{Agent: "claude", ID: histID1, ClaudeDir: fx.claude}
	writeClaudeSession(t, fx.claude, fx.root, histID1, claudeRows(fx.root, "main", "hi"), time.Now())
	h := historyServer(t, fx, m)
	// No git repo: a view-only client reads nothing of it.
	rec := serve(h, viewRequest("GET", "/api/mux/panes/0/agent/touched", ""))
	assertViewOnly(t, "no repo", rec)
	// The home dir.
	gitInit(t, fx.root)
	t.Setenv("HOME", fx.root)
	t.Setenv("USERPROFILE", fx.root)
	rec = serve(h, viewRequest("GET", "/api/mux/panes/0/agent/touched", ""))
	assertViewOnly(t, "home", rec)
	// A full client still reads it.
	if code, _, raw := getTouched(t, h, apiRequest("GET", "/api/mux/panes/0/agent/touched", "")); code != 200 {
		t.Errorf("full in home = %d %s", code, raw)
	}
}

func TestTouchedRouteViewListError(t *testing.T) {
	fx := newHistoryFixture(t)
	gitInit(t, fx.root)
	writeFile(t, filepath.Join(fx.root, "a.go"), "x")
	gitRun(t, fx.root, "add", ".")
	gitRun(t, fx.root, "commit", "-qm", "init")
	writeClaudeSession(t, fx.claude, fx.root, histID1, claudeRows(fx.root, "main", "hi"), time.Now())
	m := newHistoryMux(t, fx.root)
	m.sessions["0"] = AgentSession{Agent: "claude", ID: histID1, ClaudeDir: fx.claude}
	h := historyServer(t, fx, m)
	// A corrupt index: git cannot list the tracked files.
	writeFile(t, filepath.Join(fx.root, ".git", "index"), "DIRC garbage")
	rec := serve(h, viewRequest("GET", "/api/mux/panes/0/agent/touched", ""))
	if rec.Code < 500 || strings.Contains(rec.Body.String(), "index") {
		t.Errorf("view with an unreadable list = %d %s", rec.Code, rec.Body.String())
	}
	if e := (touchedViewListError{os.ErrNotExist}); e.Error() != os.ErrNotExist.Error() {
		t.Errorf("Error() = %q", e.Error())
	}
}

func TestTouchedPlaceFoldsCase(t *testing.T) {
	setPathsFold(t, true)
	root := realTemp(t)
	a := &agentAPI{files: &filesAPI{}}
	upper := strings.ToUpper(root[:len(root)-3]) + root[len(root)-3:]
	if runtime.GOOS == "windows" {
		upper = strings.ToUpper(root)
	}
	res := a.placeTouched(filesRoot{Root: root}, []touchedFile{{abs: filepath.Join(upper, "Dir", "A.go"), count: 1}}, true)
	if len(res.Files) != 1 || res.Files[0].Path != "Dir/A.go" {
		t.Errorf("folded = %+v", res)
	}
	setPathsFold(t, false)
	if runtime.GOOS == "linux" {
		if res := a.placeTouched(filesRoot{Root: root}, []touchedFile{{abs: filepath.Join(upper, "a.go")}}, true); res.Skipped != 1 {
			t.Errorf("not folded = %+v", res)
		}
	}
}

func TestTouchedPlaceGitDir(t *testing.T) {
	root := realTemp(t)
	gitDir := filepath.Join(root, "gd")
	a := &agentAPI{files: &filesAPI{}}
	res := a.placeTouched(filesRoot{Root: root, GitDir: gitDir}, []touchedFile{
		{abs: filepath.Join(gitDir, "config")}, {abs: filepath.Join(root, "ok.go")},
	}, true)
	if res.Skipped != 1 || len(res.Files) != 1 || res.Files[0].Path != "ok.go" || res.Files[0].LastAt != "" {
		t.Errorf("separate git dir = %+v", res)
	}
}

func TestTouchedResolved(t *testing.T) {
	base := realTemp(t)
	real := filepath.Join(base, "real")
	os.MkdirAll(real, 0o755)
	link := filepath.Join(base, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skip("symlinks:", err)
	}
	writeFile(t, filepath.Join(real, "here.go"), "x")
	if got := touchedResolved(filepath.Join(link, "here.go")); got != filepath.Join(real, "here.go") {
		t.Errorf("existing = %s", got)
	}
	if got := touchedResolved(filepath.Join(link, "gone.go")); got != filepath.Join(real, "gone.go") {
		t.Errorf("gone = %s", got)
	}
	nowhere := filepath.Join(base, "no", "such", "x.go")
	if got := touchedResolved(nowhere); got != nowhere {
		t.Errorf("no dir = %s", got)
	}
}

func TestTouchedPlaceLimitAndRunning(t *testing.T) {
	root := realTemp(t)
	other := realTemp(t)
	a := &agentAPI{files: &filesAPI{}}
	t0 := time.Date(2026, 11, 10, 10, 0, 0, 0, time.UTC)
	// The latest files are outside the root: the root's own still fill the list
	var files []touchedFile
	for i := range 5 {
		files = append(files, touchedFile{abs: filepath.Join(other, fmt.Sprint(i)), last: t0.Add(time.Hour)})
	}
	for i := range touchedMax + 1 {
		files = append(files, touchedFile{abs: filepath.Join(root, fmt.Sprintf("%05d", i)), count: 1, last: t0})
	}
	res := a.placeTouched(filesRoot{Root: root}, files, true)
	if len(res.Files) != touchedMax || !res.Truncated || res.Skipped != 5 {
		t.Errorf("len %d, truncated %v, skipped %d", len(res.Files), res.Truncated, res.Skipped)
	}
	// A call that never got its result: running for the live session only
	calls := []touchedFile{
		{abs: filepath.Join(root, "never.go"), running: true},
		{abs: filepath.Join(root, "again.go"), running: true, count: 1},
		{abs: filepath.Join(root, "gone.go"), count: 1, deleted: true},
	}
	live := a.placeTouched(filesRoot{Root: root}, calls, true)
	if len(live.Files) != 3 || !live.Files[0].Running || !live.Files[2].Deleted {
		t.Errorf("live = %+v", live.Files)
	}
	old := a.placeTouched(filesRoot{Root: root}, calls, false)
	if len(old.Files) != 2 || old.Files[0].Path != "again.go" || old.Files[0].Running || old.Skipped != 0 {
		t.Errorf("old session = %+v", old)
	}
}

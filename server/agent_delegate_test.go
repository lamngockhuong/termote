package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// Screens "2.1.330-delegate-*" were recorded in tmux (capture-pane -p -e,
// 200x50; "cut" at 80x12) from Claude Code 2.1.330 with each permission
// dialog open, paths sanitised. The transcripts below repeat the rows that
// recording wrote for the same calls.

func delegateScreen(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/claude/delegate/2.1.330-delegate-" + name + ".txt")
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func toolUseLine(id, name string, input map[string]any, sidechain bool) string {
	b, _ := json.Marshal(map[string]any{"type": "assistant", "isSidechain": sidechain, "timestamp": "2026-11-23T09:01:00.000Z",
		"message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "tool_use", "id": id, "name": name, "input": input}}}})
	return string(b) + "\n"
}

func toolResultLine(id string) string {
	b, _ := json.Marshal(map[string]any{"type": "user", "timestamp": "2026-11-23T09:01:01.000Z",
		"message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "tool_result", "tool_use_id": id, "content": "ok"}}}})
	return string(b) + "\n"
}

func TestPendingTools(t *testing.T) {
	dir := t.TempDir()
	s := AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: dir}
	writeTranscript(t, dir, testSessionID, toolUseLine("a", "Bash", map[string]any{"command": "ls"}, false)+toolResultLine("a")+
		toolUseLine("b", "Bash", map[string]any{"command": "pnpm test"}, false)+
		toolUseLine("c", "Bash", map[string]any{"command": "x"}, true)+"not json\n")
	got, err := pendingTools(s)
	if err != nil || len(got) != 1 || got[0].ID != "b" || got[0].Input["command"] != "pnpm test" {
		t.Fatalf("pending %+v %v", got, err)
	}
	// Only the end is read, the cut first line skipped.
	tail := delegateTailMax
	delegateTailMax = 300
	t.Cleanup(func() { delegateTailMax = tail })
	writeTranscript(t, dir, testSessionID, strings.Repeat(toolUseLine("old", "Bash", map[string]any{"command": "ls"}, false), 5)+
		toolUseLine("new", "Bash", map[string]any{"command": "go"}, false))
	if got, err := pendingTools(s); err != nil || len(got) == 0 || got[len(got)-1].ID != "new" {
		t.Errorf("tail %+v %v", got, err)
	}
	if _, err := pendingTools(AgentSession{Agent: "claude", ID: "x"}); err == nil {
		t.Error("no transcript")
	}
}

func TestDialogCommandAndPath(t *testing.T) {
	for name, want := range map[string]string{
		"bash":         "pnpm test --run",
		"bash-wrapped": "pnpm test --run --flag01 --flag02 --flag03 --flag04 --flag05 --flag06 --flag07 --flag08 --flag09 --flag10 --flag11 --flag12 --flag13 --flag14 --flag15 --flag16 --flag17 --flag18 --flag19 --flag20 --flag21 --flag22 --flag23 --flag24 --flag25 --flag26 --flag27 --flag28 --flag29 --flag30 --end",
		"touch":        "touch MARK456.txt",
	} {
		words, ok := dialogCommand(delegateScreen(t, name), "Bash command")
		if !ok || strings.Join(words, " ") != want {
			t.Errorf("%s: %q %v", name, words, ok)
		}
	}
	if _, ok := dialogCommand(delegateScreen(t, "edit"), "Bash command"); ok {
		t.Error("an edit dialog has no command")
	}
	for name, want := range map[string]string{"edit": "notes.txt", "write": "new.txt"} {
		header := map[string]string{"edit": "Edit file", "write": "Create file"}[name]
		if p, ok := dialogPath(delegateScreen(t, name), header); !ok || p != want {
			t.Errorf("%s: %q %v", name, p, ok)
		}
	}
	if _, ok := dialogPath("nothing", "Edit file"); ok {
		t.Error("no header")
	}
}

// delegateTest is a job ledger whose job's agent (w1:pa) shows a
// permission dialog, with a grant to run "pnpm test".
type delegateTest struct {
	*jobsTest
	job  string
	wt   string // the job's worktree
	keys func() [][]string
}

func newDelegateTest(t *testing.T, screen, transcript string) *delegateTest {
	t.Helper()
	shortConfirm(t)
	jt := newJobsTest(t)
	rr := newTestRoots()
	jt.agent.files = &filesAPI{git: rr.git, roots: rr}
	wt := t.TempDir()
	jt.agent.wm = &fakeWorktreeMux{list: WorktreeList{Worktrees: []Worktree{{Path: wt, Branch: "feat", Linked: true, GroupID: "w1"}}}}
	writeFile(t, filepath.Join(wt, "notes.txt"), "hello\nworld\n")
	setPaneStatus(jt.f, "blocked")
	jt.snapshot()
	id := jt.create(map[string]any{"title": "Parser", "pane": "w1:pa", "worktree": map[string]string{"source": "w1", "branch": "feat"}})["id"].(string)
	jt.f.mu.Lock()
	jt.f.screen = screen
	jt.f.onKeys = func(f *fakeWriter, keys []string) { f.setScreen(boxScreen("")) }
	jt.f.mu.Unlock()
	os.WriteFile(jt.path, []byte(jobsTranscript+transcript), 0o600)
	dt := &delegateTest{jobsTest: jt, job: id, wt: wt}
	dt.keys = func() [][]string {
		jt.f.mu.Lock()
		defer jt.f.mu.Unlock()
		return append([][]string(nil), jt.f.keys...)
	}
	return dt
}

func (dt *delegateTest) grant(kind, prefix string, minutes int) string {
	dt.t.Helper()
	code, out := dt.do("full", http.MethodPost, "/api/mux/jobs/"+dt.job+"/grants", map[string]any{"kind": kind, "prefix": prefix, "minutes": minutes})
	if code != http.StatusCreated {
		dt.t.Fatalf("grant = %d %v", code, out)
	}
	return out["grant"].(string)
}

func (dt *delegateTest) promptID() string {
	dt.t.Helper()
	code, out := dt.do("socket", http.MethodGet, "/api/mux/panes/w1:pa/agent/prompt", nil)
	p, _ := out["prompt"].(map[string]any)
	if code != http.StatusOK || p == nil || p["promptId"] == nil {
		dt.t.Fatalf("prompt = %d %v", code, out)
	}
	return p["promptId"].(string)
}

// answer answers the dialog under a grant, as termote agents answer
// --delegated does.
func (dt *delegateTest) answer() (int, map[string]any) {
	dt.t.Helper()
	return dt.do("socket", http.MethodPost, "/api/mux/panes/w1:pa/agent/answer", map[string]any{"promptId": dt.promptID(), "delegated": true})
}

func bashUse(cmd string) string {
	return toolUseLine("toolu_1", "Bash", map[string]any{"command": cmd, "description": "Run the test suite once"}, false)
}

func TestDelegatedAnswer(t *testing.T) {
	dt := newDelegateTest(t, delegateScreen(t, "bash"), bashUse("pnpm test --run"))
	// The option is in the prefix the user typed: a word after a prefix
	// is never one.
	g := dt.grant("bash", "pnpm test --run", 0)
	code, out := dt.answer()
	if code != http.StatusNoContent {
		t.Fatalf("delegated = %d %v", code, out)
	}
	// "Yes", never "don't ask again" or "switch to auto mode".
	if keys := dt.keys(); len(keys) != 1 || keys[0][0] != "1" {
		t.Errorf("keys %v", keys)
	}
	j := dt.list()[0]
	grant := j["grants"].([]any)[0].(map[string]any)
	uses := grant["uses"].([]any)
	if grant["id"] != g || len(uses) != 1 || uses[0].(map[string]any)["command"] != "pnpm test --run" {
		t.Errorf("grant %v", grant)
	}
	ev := j["events"].([]any)
	if last := ev[len(ev)-1].(map[string]any); last["kind"] != "delegated" || last["text"] != "pnpm test --run" {
		t.Errorf("events %v", ev)
	}
}

func TestDelegatedAnswerRefusals(t *testing.T) {
	edit := toolUseLine("toolu_e", "Edit", map[string]any{"file_path": "WT/notes.txt", "old_string": "world", "new_string": "there"}, false)
	for name, tc := range map[string]struct {
		screen, transcript string
		setup              func(dt *delegateTest)
		reason             string
	}{
		"command chained":          {"bash", bashUse("pnpm test; rm -rf x"), nil, "chars"},
		"command expands":          {"bash", bashUse("pnpm test $HOME"), nil, "chars"},
		"not in the table":         {"bash", bashUse("pnpm testx --run"), nil, "command"},
		"screen differs":           {"bash", bashUse("pnpm test --watch"), nil, "mismatch"},
		"background":               {"bash-background", toolUseLine("t", "Bash", map[string]any{"command": "touch BG.txt", "run_in_background": true}, false), nil, "input_keys"},
		"program":                  {"bash", bashUse("bash -c x"), nil, "program"},
		"option after the prefix":  {"bash", bashUse("pnpm test --run"), nil, "option"},
		"program not in the table": {"touch", bashUse("touch MARK456.txt"), nil, "program"},
		"two waiting": {"bash", bashUse("pnpm test --run") + toolUseLine("toolu_2", "Bash", map[string]any{"command": "pnpm test --run"}, false),
			nil, "pending_many"},
		"none waiting (parallel calls)": {"parallel", "", nil, "unparsed"},
		"cut dialog":                    {"cut", bashUse("touch CUT1.txt"), nil, "unparsed"},
		"another tool":                  {"bash", toolUseLine("t", "Write", map[string]any{"file_path": "/x"}, false), nil, "mismatch"},
		"grant revoked": {"bash", bashUse("pnpm test --run"), func(dt *delegateTest) {
			for _, g := range dt.list()[0]["grants"].([]any) {
				dt.do("full", http.MethodDelete, "/api/mux/jobs/"+dt.job+"/grants/"+g.(map[string]any)["id"].(string), nil)
			}
		}, "no_grant"},
		"grant expired": {"bash", bashUse("pnpm test --run"), func(dt *delegateTest) {
			now := dt.agent.jobs.now
			dt.agent.jobs.now = func() time.Time { return now().Add(25 * time.Hour) }
		}, "no_grant"},
		// A grant made under older rules, whose prefix the table now
		// refuses, answers nothing, though the command alone is one the
		// table takes.
		"older grant, a bare program": {"bash", bashUse("pnpm test --run"), func(dt *delegateTest) {
			for _, g := range dt.list()[0]["grants"].([]any) {
				dt.do("full", http.MethodDelete, "/api/mux/jobs/"+dt.job+"/grants/"+g.(map[string]any)["id"].(string), nil)
			}
			now := dt.agent.jobs.now()
			if _, err := dt.agent.jobs.update(dt.job, "", func(j *job) error {
				j.Grants = append(j.Grants, grant{ID: newTemplateID(), Kind: "bash", Prefix: "pnpm", Agent: *j.Agent,
					Created: now.UTC().Format(activityTimeFormat), Expires: now.Add(time.Hour).UTC().Format(time.RFC3339Nano)})
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		}, "no_grant"},
		"job done": {"bash", bashUse("pnpm test --run"), func(dt *delegateTest) {
			dt.do("socket", http.MethodPatch, "/api/mux/jobs/"+dt.job, map[string]any{"state": "done"})
		}, "no_grant"},
		"another agent in the pane (tmux restarted)": {"bash", bashUse("pnpm test --run"), func(dt *delegateTest) {
			dt.f.mu.Lock()
			dt.f.session.PID, dt.f.session.ProcStart = 99, "1"
			dt.f.mu.Unlock()
		}, "no_grant"},
		"subagent running": {"bash", bashUse("pnpm test --run"), func(dt *delegateTest) {
			subs := filepath.Join(filepath.Dir(dt.path), testSessionID, "subagents")
			os.MkdirAll(subs, 0o700)
			os.WriteFile(filepath.Join(subs, "agent-a1.jsonl"), []byte(toolUseLine("s", "Bash", map[string]any{"command": "ls"}, true)), 0o600)
		}, "subagent"},
		"edit a denied file": {"edit", strings.Replace(edit, "notes.txt", ".claude/settings.local.json", 1), nil, "mismatch"},
		"edit outside":       {"edit", strings.Replace(edit, "WT/notes.txt", "OUT/notes.txt", 1), nil, "no_grant"},
		// A path not in its clean form, though it names the file the
		// screen shows once cleaned: sub may be a symlink out of the worktree.
		"edit through ..":   {"edit", strings.Replace(edit, "WT/notes.txt", "WT/sub/../notes.txt", 1), nil, "denied_path"},
		"edit through .":    {"edit", strings.Replace(edit, "WT/notes.txt", "WT/./notes.txt", 1), nil, "denied_path"},
		"edit, two slashes": {"edit", strings.Replace(edit, "WT/notes.txt", "WT//notes.txt", 1), nil, "denied_path"},
	} {
		t.Run(name, func(t *testing.T) {
			dt := newDelegateTest(t, delegateScreen(t, tc.screen), "")
			// Paths go into JSON strings escaped (a Windows path has backslashes).
			esc := func(p string) string { b, _ := json.Marshal(p); return string(b[1 : len(b)-1]) }
			transcript := strings.ReplaceAll(tc.transcript, "OUT", esc(t.TempDir()))
			os.WriteFile(dt.path, []byte(jobsTranscript+strings.ReplaceAll(transcript, "WT", esc(dt.wt))), 0o600)
			dt.grant("bash", "pnpm test", 0)
			dt.grant("edit", "", 0)
			if tc.setup != nil {
				tc.setup(dt)
			}
			code, out := dt.answer()
			if code != http.StatusConflict || out["code"] != "delegation_out_of_scope" || out["reason"] != tc.reason {
				t.Errorf("= %d %v, want %s", code, out, tc.reason)
			}
			if keys := dt.keys(); len(keys) != 0 {
				t.Errorf("keys sent: %v", keys)
			}
		})
	}
}

func TestDelegatedEdit(t *testing.T) {
	dt := newDelegateTest(t, delegateScreen(t, "edit"), "")
	os.WriteFile(dt.path, []byte(jobsTranscript+toolUseLine("toolu_e", "Edit",
		map[string]any{"file_path": filepath.Join(dt.wt, "notes.txt"), "old_string": "world", "new_string": "there"}, false)), 0o600)
	dt.grant("edit", "", 30)
	if code, out := dt.answer(); code != http.StatusNoContent {
		t.Fatalf("edit = %d %v", code, out)
	}
	if keys := dt.keys(); len(keys) != 1 || keys[0][0] != "1" {
		t.Errorf("keys %v", keys)
	}
	// The same file as a symlink out of the worktree: refused.
	dt2 := newDelegateTest(t, delegateScreen(t, "edit"), "")
	os.Remove(filepath.Join(dt2.wt, "notes.txt"))
	if err := os.Symlink(filepath.Join(t.TempDir(), "x"), filepath.Join(dt2.wt, "notes.txt")); err != nil {
		t.Skip(err)
	}
	os.WriteFile(dt2.path, []byte(jobsTranscript+toolUseLine("toolu_e", "Edit",
		map[string]any{"file_path": filepath.Join(dt2.wt, "notes.txt")}, false)), 0o600)
	dt2.grant("edit", "", 30)
	if code, out := dt2.answer(); code != http.StatusConflict || out["reason"] != "symlink" {
		t.Errorf("symlink = %d %v", code, out)
	}
}

// A file in the folder the repository's core.hooksPath names runs at the
// user's next commit: refused, as a hook config's scripts are. The value
// the server's own git sets (-c) is not the repository's.
func TestDelegatedEditHooksPath(t *testing.T) {
	for name, tc := range map[string]struct {
		hooksPath string
		reason    string
	}{
		"the work tree's top": {".", "denied_path"},
		"an absolute path":    {"WT", "denied_path"},
		"another folder":      {"tools/hooks", ""},
	} {
		t.Run(name, func(t *testing.T) {
			dt := newDelegateTest(t, delegateScreen(t, "edit"), "")
			gitIn(t, dt.wt, "init", "-q")
			gitIn(t, dt.wt, "config", "core.hooksPath", strings.ReplaceAll(tc.hooksPath, "WT", dt.wt))
			os.WriteFile(dt.path, []byte(jobsTranscript+toolUseLine("toolu_e", "Edit",
				map[string]any{"file_path": filepath.Join(dt.wt, "notes.txt"), "old_string": "world", "new_string": "there"}, false)), 0o600)
			dt.grant("edit", "", 30)
			code, out := dt.answer()
			if tc.reason == "" {
				if code != http.StatusNoContent {
					t.Errorf("= %d %v, want answered", code, out)
				}
				return
			}
			if code != http.StatusConflict || out["reason"] != tc.reason {
				t.Errorf("= %d %v, want %s", code, out, tc.reason)
			}
			if keys := dt.keys(); len(keys) != 0 {
				t.Errorf("keys sent: %v", keys)
			}
		})
	}
}

// Only the CLI answers under a grant; it names no option.
// The key was sent but the dialog did not close in time: the answer may
// still take effect, so the use is kept and both audit lines are written,
// each saying the dialog was not seen to close.
func TestDelegatedAnswerNotConfirmed(t *testing.T) {
	dt := newDelegateTest(t, delegateScreen(t, "bash"), bashUse("pnpm test --run"))
	dt.f.mu.Lock()
	dt.f.onKeys = nil
	dt.f.mu.Unlock()
	g := dt.grant("bash", "pnpm test --run", 0)
	logs := captureLog(t)
	code, out := dt.answer()
	if code != http.StatusBadGateway || out["code"] != "answer_not_confirmed" {
		t.Fatalf("delegated = %d %v", code, out)
	}
	if keys := dt.keys(); len(keys) != 1 || keys[0][0] != "1" {
		t.Errorf("keys %v", keys)
	}
	j := dt.list()[0]
	grant := j["grants"].([]any)[0].(map[string]any)
	if uses, _ := grant["uses"].([]any); grant["id"] != g || len(uses) != 1 {
		t.Errorf("grant %v", grant)
	}
	ev := j["events"].([]any)
	if last := ev[len(ev)-1].(map[string]any); last["kind"] != "delegated" {
		t.Errorf("events %v", ev)
	}
	text := logs.String()
	for _, want := range []string{
		`audit: dialog_delegated grant="` + g + `"`,
		`audit: dialog_answer pane="w1:pa" agent="claude" dialog="Bash command" option="Yes" delegated="true" grant="` + g + `" confirmed="false" by="socket"`,
	} {
		if !strings.Contains(text, want) {
			t.Errorf("no %q in\n%s", want, text)
		}
	}
	if !regexp.MustCompile(`audit: dialog_delegated grant="` + g + `" .* command_sha256="[0-9a-f]{64}" confirmed="false" by="socket" peer_pid="0"`).MatchString(text) {
		t.Errorf("dialog_delegated without confirmed=false:\n%s", text)
	}
	if strings.Contains(text, `confirmed="true"`) {
		t.Errorf("an unconfirmed answer logged as confirmed:\n%s", text)
	}
}

// The CLI's own answer to a permission dialog is logged once its key is
// sent, whether or not the dialog was seen to close; a refused one, which
// sends no key, is not.
func TestCLIAnswerAuditedOnceSent(t *testing.T) {
	for name, tc := range map[string]struct {
		closes bool
		choice any
		code   int
		audit  string
	}{
		"closed":     {true, 1, http.StatusNoContent, `confirmed="true"`},
		"still open": {false, 1, http.StatusBadGateway, `confirmed="false"`},
		"refused":    {true, 2, http.StatusForbidden, ""},
	} {
		t.Run(name, func(t *testing.T) {
			dt := newDelegateTest(t, delegateScreen(t, "bash"), bashUse("pnpm test --run"))
			if !tc.closes {
				dt.f.mu.Lock()
				dt.f.onKeys = nil
				dt.f.mu.Unlock()
			}
			logs := captureLog(t)
			code, out := dt.do("socket", http.MethodPost, "/api/mux/panes/w1:pa/agent/answer", map[string]any{"promptId": dt.promptID(), "choice": tc.choice})
			if code != tc.code {
				t.Fatalf("= %d %v", code, out)
			}
			line := `audit: dialog_answer pane="w1:pa" agent="claude" dialog="Bash command" option="Yes" delegated="false" grant="" ` + tc.audit + ` by="socket"`
			if got := strings.Contains(logs.String(), "audit: dialog_answer"); got != (tc.audit != "") {
				t.Fatalf("audit line written %v:\n%s", got, logs.String())
			}
			if tc.audit != "" && !strings.Contains(logs.String(), line) {
				t.Errorf("no %q in\n%s", line, logs.String())
			}
		})
	}
}

func TestDelegatedOnlyFromSocket(t *testing.T) {
	dt := newDelegateTest(t, delegateScreen(t, "bash"), bashUse("pnpm test --run"))
	dt.grant("bash", "pnpm test", 0)
	id := dt.promptID()
	for name, tc := range map[string]struct {
		as   string
		body map[string]any
	}{
		"browser":     {"full", map[string]any{"promptId": id, "delegated": true}},
		"with option": {"socket", map[string]any{"promptId": id, "delegated": true, "choice": 2}},
	} {
		if code, out := dt.do(tc.as, http.MethodPost, "/api/mux/panes/w1:pa/agent/answer", tc.body); code != http.StatusBadRequest {
			t.Errorf("%s = %d %v", name, code, out)
		}
	}
	if keys := dt.keys(); len(keys) != 0 {
		t.Errorf("keys %v", keys)
	}
}

// Over the socket, Basic auth and the bridge, a permission dialog's option
// that stops it asking is never chosen; a browser still may.
func TestCLINeverChoosesAlways(t *testing.T) {
	setup := func(t *testing.T) *delegateTest {
		return newDelegateTest(t, delegateScreen(t, "bash"), bashUse("pnpm test --run"))
	}
	for _, choice := range []any{2, 3} {
		dt := setup(t)
		code, out := dt.do("socket", http.MethodPost, "/api/mux/panes/w1:pa/agent/answer", map[string]any{"promptId": dt.promptID(), "choice": choice})
		if code != http.StatusForbidden || out["code"] != "answer_always_refused" || len(dt.keys()) != 0 {
			t.Errorf("socket %v = %d %v", choice, code, out)
		}
		// Basic auth over TCP: the CLI's sign-in, held as the socket is.
		b, _ := json.Marshal(map[string]any{"promptId": dt.promptID(), "choice": choice})
		req := httptestRequest(http.MethodPost, "/api/mux/panes/w1:pa/agent/answer", b)
		req = req.WithContext(withAuth(req.Context(), authInfo{Kind: authBasic, Role: roleFull}))
		if rec := serve(dt.mux, req); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "answer_always_refused") {
			t.Errorf("basic %v = %d %s", choice, rec.Code, rec.Body)
		}
		// Another termote's CLI (or one that names no origin) over the bridge.
		for _, origin := range []string{"socket", "basic", ""} {
			req := map[string]any{"promptId": dt.promptID(), "choice": choice}
			if code, _ := dt.doMachine(req, origin); code != http.StatusForbidden {
				t.Errorf("bridge %v from %q = %d", choice, origin, code)
			}
		}
	}
	for _, choice := range []any{1, 4, "cancel"} {
		dt := setup(t)
		if code, out := dt.do("socket", http.MethodPost, "/api/mux/panes/w1:pa/agent/answer", map[string]any{"promptId": dt.promptID(), "choice": choice}); code != http.StatusNoContent {
			t.Errorf("socket %v = %d %v", choice, code, out)
		}
	}
	dt := setup(t)
	if code, out := dt.do("full", http.MethodPost, "/api/mux/panes/w1:pa/agent/answer", map[string]any{"promptId": dt.promptID(), "choice": 2}); code != http.StatusNoContent {
		t.Errorf("browser 2 = %d %v", code, out)
	}
	// A browser on another termote, through Machines, as on this one.
	for _, origin := range []string{"password", "device", "none"} {
		dt := setup(t)
		if code, out := dt.doMachine(map[string]any{"promptId": dt.promptID(), "choice": 2}, origin); code != http.StatusNoContent {
			t.Errorf("browser via a machine (%s) 2 = %d %v", origin, code, out)
		}
	}
}

func (dt *delegateTest) doMachine(body any, origin string) (int, map[string]any) {
	b, _ := json.Marshal(body)
	req := httptestRequest(http.MethodPost, "/api/mux/panes/w1:pa/agent/answer", b)
	req = req.WithContext(withAuth(req.Context(), authInfo{Kind: authMachine, Role: roleFull, OriginAuth: origin}))
	rec := serve(dt.mux, req)
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestCLIMayChoose(t *testing.T) {
	opts := func(labels ...string) AgentPrompt {
		p := AgentPrompt{Kind: "permission"}
		for i, l := range labels {
			p.Options = append(p.Options, PromptOption{Index: i + 1, Label: l})
		}
		return p
	}
	codex := opts("Yes, proceed (y)", "Yes, and don't ask again for commands that start with `ls` (p)", "No, and tell Codex what to do differently (esc)")
	opencode := opts("Yes, once", "Yes, always", "No")
	plan := opts("Yes, and auto-accept edits", "Yes, and manually approve edits", "No, keep planning")
	for _, tc := range []struct {
		p      AgentPrompt
		choice string
		want   bool
	}{
		{codex, "1", true}, {codex, "2", false}, {codex, "3", true},
		{opencode, "1", true}, {opencode, "2", false}, {opencode, "3", true},
		{plan, "1", false}, {plan, "2", false}, {plan, "3", true},
		{codex, `"cancel"`, true}, {codex, `"next"`, false}, {codex, `{"text":"x"}`, false}, {codex, "9", false},
		{opts("Nope", "Yes"), "1", false}, {opts("Nope", "Yes"), "2", false},
	} {
		if got := cliMayChoose(tc.p, json.RawMessage(tc.choice)); got != tc.want {
			t.Errorf("%v %s = %v", tc.p.Options, tc.choice, got)
		}
	}
}

func TestGrantRoutes(t *testing.T) {
	dt := newDelegateTest(t, delegateScreen(t, "bash"), "")
	path := "/api/mux/jobs/" + dt.job + "/grants"
	body := map[string]any{"kind": "bash", "prefix": "pnpm test"}
	// Never the CLI, another termote, Basic auth or a server without
	// sign-in: only a browser signed in.
	for name, ctx := range map[string]authInfo{
		"basic":   {Kind: authBasic, Role: roleFull},
		"machine": {Kind: authMachine, Role: roleFull},
	} {
		b, _ := json.Marshal(body)
		req := httptestRequest(http.MethodPost, path, b)
		req = req.WithContext(withAuth(req.Context(), ctx))
		if rec := serve(dt.mux, req); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "grant_pwa_only") {
			t.Errorf("%s = %d %s", name, rec.Code, rec.Body)
		}
	}
	for _, as := range []string{"socket", ""} {
		if code, out := dt.do(as, http.MethodPost, path, body); code != http.StatusForbidden || out["code"] != "grant_pwa_only" {
			t.Errorf("%q = %d %v", as, code, out)
		}
	}
	if code, out := dt.do("view", http.MethodPost, path, body); code != http.StatusForbidden || out["code"] != "view_only" {
		t.Errorf("view = %d %v", code, out)
	}
	for name, b := range map[string]map[string]any{
		"chained":      {"kind": "bash", "prefix": "pnpm test; rm"},
		"program":      {"kind": "bash", "prefix": "bash -c"},
		"bare npm":     {"kind": "bash", "prefix": "npm"},
		"no script":    {"kind": "bash", "prefix": "pnpm run"},
		"abbreviation": {"kind": "bash", "prefix": "npm installTest"},
		"empty":        {"kind": "bash", "prefix": " "},
		"too long":     {"kind": "bash", "prefix": strings.Repeat("a", maxGrantPrefix+1)},
		"edit, prefix": {"kind": "edit", "prefix": "x"},
		"kind":         {"kind": "all"},
		"minutes":      {"kind": "bash", "prefix": "pnpm test", "minutes": 24*60 + 1},
	} {
		code, out := dt.do("full", http.MethodPost, path, b)
		if code != http.StatusBadRequest {
			t.Errorf("%s = %d %v", name, code, out)
		}
		if b["kind"] == "bash" && name != "minutes" && out["code"] != "grant_invalid" {
			t.Errorf("%s code = %v", name, out["code"])
		}
	}
	// A device signed in full may; the grant is pinned to the agent now.
	b, _ := json.Marshal(body)
	req := httptestRequest(http.MethodPost, path, b)
	req = req.WithContext(withAuth(req.Context(), authInfo{Kind: authDevice, Role: roleFull, DeviceID: "d"}))
	if rec := serve(dt.mux, req); rec.Code != http.StatusCreated {
		t.Fatalf("device = %d %s", rec.Code, rec.Body)
	}
	g := dt.list()[0]["grants"].([]any)[0].(map[string]any)
	if g["agent"].(map[string]any)["pid"] != float64(42) || g["prefix"] != "pnpm test" || g["expires"] == "" {
		t.Errorf("grant %v", g)
	}
	// Revoked, once; an unknown one is 404.
	gid := g["id"].(string)
	if code, out := dt.do("full", http.MethodDelete, path+"/"+gid, nil); code != http.StatusOK {
		t.Errorf("revoke = %d %v", code, out)
	}
	if code, _ := dt.do("full", http.MethodDelete, path+"/nope", nil); code != http.StatusNotFound {
		t.Errorf("unknown = %d", code)
	}
	if code, _ := dt.do("socket", http.MethodDelete, path+"/"+gid, nil); code != http.StatusForbidden {
		t.Errorf("socket revoke = %d", code)
	}
	if code, _ := dt.do("full", http.MethodGet, path, nil); code != http.StatusMethodNotAllowed {
		t.Errorf("GET = %d", code)
	}
	// A job whose agent is gone gets no grant.
	dt.f.mu.Lock()
	dt.f.session.PID = 7
	dt.f.mu.Unlock()
	if code, out := dt.do("full", http.MethodPost, path, body); code != http.StatusBadRequest {
		t.Errorf("gone agent = %d %v", code, out)
	}
	// Without a worktree, no grant to edit.
	dt.f.mu.Lock()
	dt.f.session.PID = 42
	dt.f.mu.Unlock()
	id := dt.create(map[string]any{"title": "No tree", "pane": "w1:pa"})["id"].(string)
	if code, out := dt.do("full", http.MethodPost, "/api/mux/jobs/"+id+"/grants", map[string]any{"kind": "edit"}); code != http.StatusBadRequest {
		t.Errorf("edit without worktree = %d %v", code, out)
	}
	// A bash grant there holds the pane's folder; a tool's needs one.
	rg := map[string]any{"kind": "bash", "prefix": "rg"}
	if code, out := dt.do("full", http.MethodPost, "/api/mux/jobs/"+id+"/grants", rg); code != http.StatusBadRequest || out["code"] != "job_invalid" {
		t.Errorf("tool without a folder = %d %v", code, out)
	}
	dt.f.mu.Lock()
	dt.f.snap.Groups[0].Tabs[0].Panes[0].Process = &ProcessInfo{Cwd: t.TempDir()}
	dt.f.mu.Unlock()
	dt.snapshot()
	if code, out := dt.do("full", http.MethodPost, "/api/mux/jobs/"+id+"/grants", rg); code != http.StatusCreated {
		t.Fatalf("bash without worktree = %d %v", code, out)
	}
	for _, j := range dt.list() {
		if j["id"] == id {
			live, _ := j["live"].(map[string]any)
			g := j["grants"].([]any)[0].(map[string]any)
			if live == nil || live["dir"] == nil || live["dir"] == "" || g["dir"] != live["dir"] {
				t.Errorf("bash grant dir %v, pane folder %v", g["dir"], live)
			}
		}
	}
	// The GET says whether this client may give grants.
	if _, out := dt.do("full", http.MethodGet, "/api/mux/jobs", nil); out["canGrant"] != true {
		t.Errorf("full canGrant %v", out["canGrant"])
	}
	if _, out := dt.do("socket", http.MethodGet, "/api/mux/jobs", nil); out["canGrant"] != false {
		t.Errorf("socket canGrant %v", out["canGrant"])
	}
}

func TestMachineForbidsGrants(t *testing.T) {
	for p, want := range map[string]bool{
		"/api/mux/jobs/abc/grants":     true,
		"/api/mux/jobs/abc/grants/def": true,
		"/api/mux/jobs/abc":            false,
		"/api/mux/jobs":                false,
		"/api/mux/jobs/abc/event":      false,
		"/api/mux/jobs/grants":         false,
	} {
		if got := machineForbiddenPath(p); got != want {
			t.Errorf("%s = %v", p, got)
		}
	}
}

func httptestRequest(method, path string, body []byte) *http.Request {
	r := httptest.NewRequest(method, path, bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	return r
}

// A grant to edit files covers the job's worktree: none is given while the
// job's agent works in another folder (the job was moved), a command grant
// still is.
func TestGrantEditOutsideWorktree(t *testing.T) {
	dt := newDelegateTest(t, delegateScreen(t, "edit"), "")
	path := "/api/mux/jobs/" + dt.job + "/grants"
	at := func(cwd string) {
		dt.f.mu.Lock()
		dt.f.snap.Groups[0].Tabs[0].Panes[0].Process = &ProcessInfo{Name: "claude", Cwd: cwd}
		dt.f.mu.Unlock()
		dt.snapshot()
	}
	at(dt.wt)
	dt.grant("edit", "", 30)
	at(t.TempDir())
	if code, out := dt.do("full", http.MethodPost, path, map[string]any{"kind": "edit"}); code != http.StatusConflict || out["code"] != "grant_outside_worktree" {
		t.Errorf("edit outside = %d %v", code, out)
	}
	dt.grant("bash", "pnpm test", 30)
}

// A tool's grant holds the job's worktree: the call's folder, from the
// transcript, must be in it, and its words must not lead out of it.
func TestDelegatedToolPaths(t *testing.T) {
	screen := func(t *testing.T) string {
		s := delegateScreen(t, "touch")
		if !strings.Contains(s, "touch MARK456.txt") {
			t.Fatal("fixture changed")
		}
		return strings.ReplaceAll(s, "touch MARK456.txt", "cat MARK456.txt")
	}
	use := func(cwd string) string {
		b, _ := json.Marshal(map[string]any{"type": "assistant", "cwd": cwd, "timestamp": "2026-11-23T09:01:00.000Z",
			"message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "tool_use", "id": "toolu_c", "name": "Bash",
				"input": map[string]any{"command": "cat MARK456.txt"}}}}})
		return string(b) + "\n"
	}
	for name, tc := range map[string]struct {
		cwd    func(dt *delegateTest) string
		setup  func(t *testing.T, dt *delegateTest)
		reason string
	}{
		"in the worktree": {func(dt *delegateTest) string { return dt.wt }, nil, ""},
		"in a subfolder":  {func(dt *delegateTest) string { return filepath.Join(dt.wt, "sub") }, nil, ""},
		"outside it":      {func(dt *delegateTest) string { return dt.t.TempDir() }, nil, "outside"},
		"no folder (cwd)": {func(dt *delegateTest) string { return "" }, nil, "outside"},
		"a link out of it": {func(dt *delegateTest) string { return dt.wt }, func(t *testing.T, dt *delegateTest) {
			secret := filepath.Join(t.TempDir(), "secret")
			writeFile(t, secret, "x")
			if err := os.Symlink(secret, filepath.Join(dt.wt, "MARK456.txt")); err != nil {
				t.Skipf("no symlinks: %v", err)
			}
		}, "outside"},
	} {
		t.Run(name, func(t *testing.T) {
			dt := newDelegateTest(t, screen(t), "")
			os.MkdirAll(filepath.Join(dt.wt, "sub"), 0o700)
			if tc.setup != nil {
				tc.setup(t, dt)
			}
			os.WriteFile(dt.path, []byte(jobsTranscript+use(tc.cwd(dt))), 0o600)
			dt.grant("bash", "cat", 0)
			g := dt.list()[0]["grants"].([]any)[0].(map[string]any)
			if g["dir"] != dt.wt {
				t.Fatalf("grant dir %v, want the worktree %s", g["dir"], dt.wt)
			}
			code, out := dt.answer()
			if tc.reason == "" {
				if code != http.StatusNoContent {
					t.Errorf("= %d %v", code, out)
				}
				return
			}
			if code != http.StatusConflict || out["reason"] != tc.reason {
				t.Errorf("= %d %v, want %s", code, out, tc.reason)
			}
			if keys := dt.keys(); len(keys) != 0 {
				t.Errorf("keys sent: %v", keys)
			}
		})
	}
}

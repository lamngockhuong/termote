package main

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// newAsksTest is the jobs test's agent API, whose Claude Code in w1:pa is
// the orchestrator that asks.
func newAsksTest(t *testing.T) *jobsTest {
	t.Helper()
	shortConfirm(t)
	return newJobsTest(t)
}

func (jt *jobsTest) addAsk(body map[string]any) map[string]any {
	jt.t.Helper()
	if body["pane"] == nil {
		body["pane"] = "w1:pa"
	}
	code, out := jt.do("socket", http.MethodPost, "/api/mux/asks", body)
	if code != http.StatusCreated {
		jt.t.Fatalf("add = %d %v", code, out)
	}
	return out["ask"].(map[string]any)
}

func (jt *jobsTest) asks(as string) []map[string]any {
	jt.t.Helper()
	code, out := jt.do(as, http.MethodGet, "/api/mux/asks", nil)
	if code != http.StatusOK {
		jt.t.Fatalf("asks = %d %v", code, out)
	}
	var list []map[string]any
	for _, q := range out["asks"].([]any) {
		list = append(list, q.(map[string]any))
	}
	return list
}

func (jt *jobsTest) answer(id string, body map[string]any) (int, map[string]any) {
	jt.t.Helper()
	if body["updated"] == nil {
		q, _ := jt.agent.jobs.askByID(id)
		body["updated"] = q.Updated.Format(time.RFC3339Nano)
	}
	return jt.do("full", http.MethodPost, "/api/mux/asks/"+id+"/answer", body)
}

// Only termote agents adds, closes or reports a question; a view-only
// device reads how many wait, never what.
func TestAskRoutesRoles(t *testing.T) {
	jt := newAsksTest(t)
	logs := captureLog(t)
	body := map[string]any{"pane": "w1:pa", "text": "Which way?"}
	for _, as := range []string{"full", "bridge"} {
		for _, path := range []string{"/api/mux/asks", "/api/mux/asks/Q1/close", "/api/mux/asks/Q1/reported"} {
			if code, out := jt.do(as, http.MethodPost, path, body); code != http.StatusForbidden || out["code"] != "socket_only" {
				t.Errorf("%s %s = %d %v", as, path, code, out)
			}
		}
	}
	if code, _ := jt.do("view", http.MethodPost, "/api/mux/asks", body); code != http.StatusForbidden {
		t.Errorf("view-only add = %d", code)
	}
	if code, _ := jt.do("socket", http.MethodPut, "/api/mux/asks", body); code != http.StatusMethodNotAllowed {
		t.Errorf("PUT = %d", code)
	}
	if code, _ := jt.do("socket", http.MethodGet, "/api/mux/asks/Q1/close", nil); code != http.StatusMethodNotAllowed {
		t.Errorf("GET close = %d", code)
	}

	q := jt.addAsk(map[string]any{"text": "Which way?\n\x1b[31m$(rm -rf ~)‮", "choices": []string{"Left", "Right"}})
	if q["id"] != "Q1" || q["text"] != "Which way?\n[31m$(rm -rf ~)" || q["state"] != "open" || q["createdBy"] != "w1:pa" {
		t.Fatalf("added %v", q)
	}
	if l, _ := q["live"].(map[string]any); l["status"] != "running" || l["paneId"] != "w1:pa" {
		t.Errorf("live %v", q["live"])
	}
	if !regexp.MustCompile(`audit: ask_added ask="Q1" pane="w1:pa" peer_pid="0"`).MatchString(logs.String()) ||
		strings.Contains(logs.String(), "Which way") {
		t.Errorf("audit:\n%s", logs.String())
	}
	full := jt.asks("full")
	if len(full) != 1 || full[0]["text"] == nil || len(full[0]["choices"].([]any)) != 2 {
		t.Errorf("full list %v", full)
	}
	view := jt.asks("view")
	if len(view) != 1 || view[0]["id"] != "Q1" || view[0]["state"] != "open" {
		t.Fatalf("view list %v", view)
	}
	for _, k := range []string{"text", "choices", "answer", "agent", "createdBy", "live"} {
		if _, ok := view[0][k]; ok {
			t.Errorf("view-only device reads %s", k)
		}
	}
	if code, out := jt.do("view", http.MethodPost, "/api/mux/asks/Q1/answer", map[string]any{"choice": 1}); code != http.StatusForbidden {
		t.Errorf("view-only answer = %d %v", code, out)
	}
	// An answered one is no longer the view-only device's to count
	jt.agent.jobs.closeAsk("Q1", "w1:pa", "")
	if view := jt.asks("view"); len(view) != 0 {
		t.Errorf("answered for view %v", view)
	}
	// No ledger on this server
	jt.agent.jobs = nil
	for _, c := range []struct{ as, method, path string }{
		{"full", http.MethodGet, "/api/mux/asks"},
		{"socket", http.MethodPost, "/api/mux/asks"},
		{"full", http.MethodPost, "/api/mux/asks/Q1/answer"},
	} {
		if code, out := jt.do(c.as, c.method, c.path, map[string]any{"choice": 1}); code != http.StatusServiceUnavailable || out["code"] != "jobs_unavailable" {
			t.Errorf("%s %s = %d %v", c.method, c.path, code, out)
		}
	}
}

func TestAskAddRefusals(t *testing.T) {
	jt := newAsksTest(t)
	for name, c := range map[string]struct {
		body any
		code int
		want string
	}{
		"empty":     {map[string]any{"pane": "w1:pa", "text": " "}, http.StatusBadRequest, "ask_invalid"},
		"choices":   {map[string]any{"pane": "w1:pa", "text": "q", "choices": []string{"a", "a"}}, http.StatusBadRequest, "ask_invalid"},
		"job id":    {map[string]any{"pane": "w1:pa", "text": "q", "job": "../x"}, http.StatusBadRequest, "ask_invalid"},
		"no job":    {map[string]any{"pane": "w1:pa", "text": "q", "job": "abcdef0123456789"}, http.StatusBadRequest, "ask_invalid"},
		"no agent":  {map[string]any{"pane": "w9:zz", "text": "q"}, http.StatusConflict, "job_no_agent"},
		"too large": {`{"text":"` + strings.Repeat("x", askBody) + `"}`, http.StatusRequestEntityTooLarge, "too_large"},
		"not JSON":  {`{`, http.StatusBadRequest, ""},
	} {
		if code, out := jt.do("socket", http.MethodPost, "/api/mux/asks", c.body); code != c.code || (c.want != "" && out["code"] != c.want) {
			t.Errorf("%s = %d %v", name, code, out)
		}
	}
	for range maxOpenAsksPerPane {
		jt.addAsk(map[string]any{"text": "q"})
	}
	if code, out := jt.do("socket", http.MethodPost, "/api/mux/asks", map[string]any{"pane": "w1:pa", "text": "q"}); code != http.StatusConflict || out["code"] != "too_many_asks" {
		t.Errorf("21st = %d %v", code, out)
	}
	// A question of a job shows the job's title
	j := jt.create(map[string]any{"title": "Parser", "createdBy": "w1:pa"})
	jt.agent.jobs.closeAsk("Q1", "w1:pa", "")
	q := jt.addAsk(map[string]any{"text": "q", "job": j["id"]})
	if q["job"] != j["id"] || q["jobTitle"] != "Parser" {
		t.Errorf("job ask %v", q)
	}
}

func TestAskAnswerFromPWA(t *testing.T) {
	jt := newAsksTest(t)
	logs := captureLog(t)
	jt.addAsk(map[string]any{"text": "Which way?", "choices": []string{"Left", "Right"}})
	jt.addAsk(map[string]any{"text": "Name it"})

	for name, c := range map[string]struct {
		id   string
		body map[string]any
		code int
		want string
	}{
		"both":      {"Q1", map[string]any{"choice": 1, "text": "x"}, http.StatusBadRequest, "ask_invalid"},
		"neither":   {"Q1", map[string]any{}, http.StatusBadRequest, "ask_invalid"},
		"choice 3":  {"Q1", map[string]any{"choice": 3}, http.StatusBadRequest, "ask_invalid"},
		"choice 0":  {"Q1", map[string]any{"choice": 0}, http.StatusBadRequest, "ask_invalid"},
		"empty":     {"Q2", map[string]any{"text": " \x07"}, http.StatusBadRequest, "ask_invalid"},
		"too long":  {"Q2", map[string]any{"text": strings.Repeat("x", maxAskAnswer+1)}, http.StatusBadRequest, "ask_invalid"},
		"bad id":    {"q1", map[string]any{"choice": 1}, http.StatusNotFound, "ask_not_found"},
		"missing":   {"Q9", map[string]any{"choice": 1}, http.StatusNotFound, "ask_not_found"},
		"stale":     {"Q1", map[string]any{"choice": 1, "updated": "2026-01-01T00:00:00Z"}, http.StatusConflict, "ask_conflict"},
		"too large": {"Q1", map[string]any{"text": strings.Repeat("x", askBody)}, http.StatusRequestEntityTooLarge, "too_large"},
	} {
		if code, out := jt.answer(c.id, c.body); code != c.code || out["code"] != c.want {
			t.Errorf("%s = %d %v", name, code, out)
		}
	}
	if code, _ := jt.do("full", http.MethodPost, "/api/mux/asks/Q1/answer", `{`); code != http.StatusBadRequest {
		t.Errorf("not JSON = %d", code)
	}
	if code, _ := jt.do("full", http.MethodGet, "/api/mux/asks/Q1/answer", nil); code != http.StatusMethodNotAllowed {
		t.Errorf("GET = %d", code)
	}
	if len(jt.f.pasted) != 0 {
		t.Fatalf("pasted on a refusal %q", jt.f.pasted)
	}

	code, out := jt.answer("Q1", map[string]any{"choice": 2})
	if code != http.StatusOK || out["queued"] != false || out["recorded"] != true {
		t.Fatalf("choice = %d %v", code, out)
	}
	if q := out["ask"].(map[string]any); q["state"] != "answered" || q["answeredBy"] != "pwa" || q["answer"] != "Right" || q["choice"] != 2.0 {
		t.Errorf("answered %v", q)
	}
	code, out = jt.answer("Q2", map[string]any{"text": " parse-v2\t(final) "})
	if code != http.StatusOK {
		t.Fatalf("text = %d %v", code, out)
	}
	want := []string{"Answer to Q1 (choice 2): Right", "Answer to Q2: parse-v2\t(final)"}
	if strings.Join(jt.f.pasted, "|") != strings.Join(want, "|") {
		t.Errorf("pasted %q", jt.f.pasted)
	}
	if code, out := jt.answer("Q1", map[string]any{"choice": 1}); code != http.StatusConflict || out["code"] != "ask_closed" {
		t.Errorf("twice = %d %v", code, out)
	}
	text := logs.String()
	if !strings.Contains(text, `audit: ask_answered ask="Q1" by="session:s"`) || strings.Contains(text, "parse-v2") || strings.Contains(text, "Right") {
		t.Errorf("audit:\n%s", text)
	}
}

// A draft in the orchestrator's box, a dialog: refused, the question stays
// open, nothing is recorded.
func TestAskAnswerRefusedSend(t *testing.T) {
	jt := newAsksTest(t)
	jt.addAsk(map[string]any{"text": "q"})
	jt.f.mu.Lock()
	jt.f.screen = boxScreen("half typed")
	jt.f.mu.Unlock()
	if code, out := jt.answer("Q1", map[string]any{"text": "yes"}); code != http.StatusConflict || out["code"] != "input_has_draft" {
		t.Errorf("draft = %d %v", code, out)
	}
	if q, _ := jt.agent.jobs.askByID("Q1"); q.State != askOpen || len(jt.f.pasted) != 0 {
		t.Errorf("after a draft %+v %q", q, jt.f.pasted)
	}
	// The server has no agent lookup (a backend without one)
	jt.f.mu.Lock()
	jt.f.screen = boxScreen("")
	jt.f.mu.Unlock()
	loc := jt.agent.loc
	jt.agent.loc = nil
	if code, _ := jt.answer("Q1", map[string]any{"text": "yes"}); code == http.StatusOK {
		t.Error("answered without an agent lookup")
	}
	jt.agent.loc = loc
	// The backend cannot be read
	jt.f.err = errors.New("tmux gone")
	if code, _ := jt.answer("Q1", map[string]any{"text": "yes"}); code == http.StatusOK {
		t.Error("answered without a snapshot")
	}
	jt.f.err = nil
	// The session cannot be read again under the lock
	jt.f.mu.Lock()
	jt.f.nowErr = errors.New("tmux busy")
	jt.f.mu.Unlock()
	if code, out := jt.answer("Q1", map[string]any{"text": "yes"}); code == http.StatusOK || out["code"] == "ask_no_agent" {
		t.Errorf("session error = %d %v", code, out)
	}
	jt.f.mu.Lock()
	jt.f.nowErr = nil
	jt.f.mu.Unlock()
	if q, _ := jt.agent.jobs.askByID("Q1"); q.State != askOpen || len(jt.f.pasted) != 0 {
		t.Errorf("after refusals %+v %q", q, jt.f.pasted)
	}
}

// Another agent at the orchestrator's pane does not get its answers until
// the orchestrator there names itself again (any ask command repins).
func TestAskAnswerOtherAgent(t *testing.T) {
	jt := newAsksTest(t)
	jt.addAsk(map[string]any{"text": "q"})
	jt.f.mu.Lock()
	jt.f.session.PID = 4242
	jt.f.mu.Unlock()
	if code, out := jt.answer("Q1", map[string]any{"text": "yes"}); code != http.StatusConflict || out["code"] != "ask_no_agent" {
		t.Errorf("another agent = %d %v", code, out)
	}
	if l := jt.asks("full")[0]["live"].(map[string]any); l["status"] != "gone" {
		t.Errorf("live %v", l)
	}
	// The pane runs no agent the server finds
	jt.f.mu.Lock()
	jt.f.found = false
	jt.f.mu.Unlock()
	if code, out := jt.answer("Q1", map[string]any{"text": "yes"}); code == http.StatusOK {
		t.Errorf("no session = %d %v", code, out)
	}
	jt.f.mu.Lock()
	jt.f.found = true
	jt.f.mu.Unlock()
	// The pane is gone from the snapshot
	snap := jt.f.snap
	jt.f.snap = Snapshot{Backend: snap.Backend}
	if code, out := jt.answer("Q1", map[string]any{"text": "yes"}); code != http.StatusConflict || out["code"] != "ask_no_agent" {
		t.Errorf("no pane = %d %v", code, out)
	}
	jt.f.snap = snap
	if len(jt.f.pasted) != 0 {
		t.Fatalf("pasted %q", jt.f.pasted)
	}
	// ask list from the new agent's pane gives it the open asks
	if code, _ := jt.do("socket", http.MethodGet, "/api/mux/asks?pane=w1:pa", nil); code != http.StatusOK {
		t.Fatal(code)
	}
	if q, _ := jt.agent.jobs.askByID("Q1"); q.Agent.PID != 4242 {
		t.Errorf("not repinned %+v", q.Agent)
	}
	if code, out := jt.answer("Q1", map[string]any{"text": "yes"}); code != http.StatusOK {
		t.Errorf("after repin = %d %v", code, out)
	}
	// A list naming a pane without an agent still lists
	if code, out := jt.do("socket", http.MethodGet, "/api/mux/asks?pane=w9:zz", nil); code != http.StatusOK {
		t.Errorf("list from no agent = %d %v", code, out)
	}
}

func TestAskCloseAndReported(t *testing.T) {
	jt := newAsksTest(t)
	logs := captureLog(t)
	jt.addAsk(map[string]any{"text": "q1"})
	jt.addAsk(map[string]any{"text": "q2"})
	jt.addAsk(map[string]any{"text": "q3"})
	closePath := "/api/mux/asks/Q1/close"
	for name, c := range map[string]struct {
		path string
		body any
		code int
		want string
	}{
		"bad id":    {"/api/mux/asks/x/close", map[string]any{"pane": "w1:pa"}, http.StatusNotFound, "ask_not_found"},
		"long":      {closePath, map[string]any{"pane": "w1:pa", "answer": strings.Repeat("x", maxAskAnswer+1)}, http.StatusBadRequest, "ask_invalid"},
		"no agent":  {closePath, map[string]any{"pane": "w9:zz"}, http.StatusConflict, "job_no_agent"},
		"not JSON":  {closePath, `{`, http.StatusBadRequest, ""},
		"r bad id":  {"/api/mux/asks/x/reported", map[string]any{"pane": "w1:pa"}, http.StatusNotFound, "ask_not_found"},
		"r agent":   {"/api/mux/asks/Q1/reported", map[string]any{"pane": "w9:zz"}, http.StatusConflict, "job_no_agent"},
		"r open":    {"/api/mux/asks/Q1/reported", map[string]any{"pane": "w1:pa"}, http.StatusBadRequest, "ask_invalid"},
		"r missing": {"/api/mux/asks/Q9/reported", map[string]any{"pane": "w1:pa"}, http.StatusNotFound, "ask_not_found"},
	} {
		if code, out := jt.do("socket", http.MethodPost, c.path, c.body); code != c.code || (c.want != "" && out["code"] != c.want) {
			t.Errorf("%s = %d %v", name, code, out)
		}
	}
	code, out := jt.do("socket", http.MethodPost, closePath, map[string]any{"pane": "w1:pa", "answer": "left, in the tab"})
	if q := out["ask"].(map[string]any); code != http.StatusOK || q["answeredBy"] != "agent" || q["answer"] != "left, in the tab" {
		t.Errorf("close = %d %v", code, out)
	}
	code, out = jt.do("socket", http.MethodPost, closePath, map[string]any{"pane": "w1:pa"})
	if code != http.StatusConflict || out["code"] != "ask_closed" || out["ask"].(map[string]any)["answer"] != "left, in the tab" {
		t.Errorf("close twice = %d %v", code, out)
	}
	if !strings.Contains(logs.String(), `audit: ask_closed ask="Q1" pane="w1:pa" peer_pid="0"`) {
		t.Errorf("audit:\n%s", logs.String())
	}
	// Not while an answer from the PWA is on its way, nor two answers
	release, _ := jt.agent.asking.take("Q2")
	if code, out := jt.do("socket", http.MethodPost, "/api/mux/asks/Q2/close", map[string]any{"pane": "w1:pa"}); code != http.StatusConflict || out["code"] != "ask_busy" {
		t.Errorf("close while sending = %d %v", code, out)
	}
	if code, out := jt.answer("Q2", map[string]any{"text": "x"}); code != http.StatusConflict || out["code"] != "ask_busy" {
		t.Errorf("answer while sending = %d %v", code, out)
	}
	release()
	if _, ok := jt.agent.asking.take("Q2"); !ok {
		t.Error("not released")
	}
	jt.agent.asking = askReservations{}
	// Reported: an answer from the PWA, by the pane that asked
	if code, _ := jt.answer("Q2", map[string]any{"text": "x"}); code != http.StatusOK {
		t.Fatal(code)
	}
	if code, out := jt.do("socket", http.MethodPost, "/api/mux/asks/Q2/reported", map[string]any{"pane": "w1:pa"}); code != http.StatusOK || out["ok"] != true {
		t.Errorf("reported = %d %v", code, out)
	}
	if q, _ := jt.agent.jobs.askByID("Q2"); !q.Reported {
		t.Error("not reported")
	}
}

// The answer reached the orchestrator but could not be recorded (a newer
// Termote's file now): 200, recorded false; the orchestrator closes it.
func TestAskAnswerNotRecorded(t *testing.T) {
	jt := newAsksTest(t)
	captureLog(t)
	q := jt.addAsk(map[string]any{"text": "q"})
	b, _ := os.ReadFile(filepath.Join(jt.dir, jobsFile))
	os.WriteFile(filepath.Join(jt.dir, jobsFile), bytes.Replace(b, []byte(`"v":1`), []byte(`"v":2`), 1), 0o600)
	code, out := jt.do("full", http.MethodPost, "/api/mux/asks/Q1/answer", map[string]any{"text": "yes", "updated": q["updated"]})
	if code != http.StatusOK || out["recorded"] != false || out["ask"].(map[string]any)["state"] != "open" {
		t.Errorf("not recorded = %d %v", code, out)
	}
	if len(jt.f.pasted) != 1 || jt.f.pasted[0] != "Answer to Q1: yes" {
		t.Errorf("pasted %q", jt.f.pasted)
	}
	// A newer file is read: its asks are read-only
	code, out = jt.do("full", http.MethodGet, "/api/mux/asks", nil)
	if code != http.StatusOK || out["readOnly"] != true {
		t.Errorf("list = %d %v", code, out)
	}
	// The add fails at its repin, the close too
	if code, out := jt.do("socket", http.MethodPost, "/api/mux/asks", map[string]any{"pane": "w1:pa", "text": "q"}); code != http.StatusConflict || out["code"] != "newer_format" {
		t.Errorf("add to newer = %d %v", code, out)
	}
}

func TestAskMessageAndErrors(t *testing.T) {
	if askMessage("Q3", 0, "a\nb") != "Answer to Q3: a\nb" || askMessage("Q3", 2, "B") != "Answer to Q3 (choice 2): B" {
		t.Error("message")
	}
	if askAgentErr(nil) != errAskNoAgent || askAgentErr(errTargetChanged) != errAskNoAgent || askAgentErr(errAgentUnsupported) != errAskNoAgent {
		t.Error("no agent")
	}
	other := errors.New("x")
	if askAgentErr(other) != other {
		t.Error("other")
	}
}

// A cross-site read of the questions is refused.
func TestAskRoutesCrossSite(t *testing.T) {
	jt := newAsksTest(t)
	req := httptest.NewRequest(http.MethodGet, "/api/mux/asks", nil)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(jt.mux, req); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site = %d", rec.Code)
	}
}

// Another termote's Machines lists the questions and answers one from a
// browser there only: its CLI, Basic auth or an older termote that names
// no origin is refused before the question is touched.
func TestAskAnswerOverBridge(t *testing.T) {
	jt := newAsksTest(t)
	logs := captureLog(t)
	jt.addAsk(map[string]any{"text": "Which way?", "choices": []string{"Left", "Right"}})
	code, out := jt.do("bridge-view:password", http.MethodGet, "/api/mux/asks", nil)
	if code != http.StatusOK || out["readOnly"] != true {
		t.Fatalf("view list = %d %v", code, out)
	}
	for k := range out["asks"].([]any)[0].(map[string]any) {
		if k != "id" && k != "state" && k != "job" && k != "created" {
			t.Errorf("a view role over the bridge reads %s", k)
		}
	}
	answer := func(as, id string) (int, map[string]any) {
		q, _ := jt.agent.jobs.askByID(id)
		return jt.do(as, http.MethodPost, "/api/mux/asks/"+id+"/answer", map[string]any{"choice": 1, "updated": q.Updated.Format(time.RFC3339Nano)})
	}
	for _, as := range []string{"bridge-full:socket", "bridge-full:basic", "bridge-full:", "bridge"} {
		if code, out := answer(as, "Q1"); code != http.StatusForbidden || out["code"] != "ask_browser_only" {
			t.Errorf("%s answer = %d %v", as, code, out)
		}
	}
	if code, out := answer("bridge-view:password", "Q1"); code != http.StatusForbidden || out["code"] != "view_only" {
		t.Errorf("view answer = %d %v", code, out)
	}
	if len(jt.f.pasted) != 0 {
		t.Fatalf("pasted on a refusal %q", jt.f.pasted)
	}
	if q, _ := jt.agent.jobs.askByID("Q1"); q.State != askOpen {
		t.Fatalf("refused answers changed the question: %+v", q)
	}
	for i, origin := range []string{"password", "device", "none"} {
		id := "Q1"
		if i > 0 {
			id = jt.addAsk(map[string]any{"text": "Again?", "choices": []string{"Yes", "No"}})["id"].(string)
		}
		if code, out := answer("bridge-full:"+origin, id); code != http.StatusOK || out["recorded"] != true {
			t.Fatalf("%s answer = %d %v", origin, code, out)
		}
		if want := `audit: ask_answered ask="` + id + `" by="machine" via="machine:` + origin + `"`; !strings.Contains(logs.String(), want) {
			t.Errorf("no %q in\n%s", want, logs)
		}
	}
	if len(jt.f.pasted) != 3 {
		t.Errorf("pasted %q", jt.f.pasted)
	}
}

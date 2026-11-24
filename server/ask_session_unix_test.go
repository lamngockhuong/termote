//go:build !windows

package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

// A whole orchestrator session over the real server and its local socket:
// five questions, two answered in the PWA, one in a tab, the open ones the
// same after a restart, ids never given twice, each PWA answer reported
// once, the asks pruned once the jobs are done, and an answer that still
// reaches the orchestrator after it started a new session in its pane.
func TestAskSession(t *testing.T) {
	tc, dir := socketCLI(t)
	f := newAgentsFake(t, tsLine(0, "2026-11-23T09:00:00.000Z", "hello"))
	startAgentsServer(t, tc, dir, f)
	every, grace := agentsWaitEvery, agentsWaitGrace
	agentsWaitEvery, agentsWaitGrace = 20*time.Millisecond, 100*time.Millisecond
	t.Cleanup(func() { agentsWaitEvery, agentsWaitGrace = every, grace })
	// This command runs in %3 (orchestrator/api), the orchestrator.
	tc.env["TMUX"], tc.env["TMUX_PANE"] = "/tmp/tmux-1000/default,1,0", "%3"
	tc.runner.outputs["tmux display-message -p -t %3 #{window_id}\t#{session_name}"] = "\torchestrator\n"

	run := func(args ...string) (int, string) {
		t.Helper()
		tc.stdout.Reset()
		tc.stderr.Reset()
		err := tc.dispatch("agents", args)
		out := tc.stdout.String()
		if err != nil {
			out += "\nerror: " + err.Error()
		}
		return exitCode(err), out
	}
	openIDs := func(all bool) string {
		t.Helper()
		args := []string{"ask", "list", "--json"}
		if all {
			args = append(args, "--all")
		}
		code, out := run(args...)
		var l asksListing
		if code != 0 || json.Unmarshal([]byte(out), &l) != nil {
			t.Fatalf("ask list: %d %s", code, out)
		}
		var ids []string
		for _, q := range l.Asks {
			ids = append(ids, q.ID+":"+q.State)
		}
		return strings.Join(ids, " ")
	}
	// browser sends a request over TCP as a client signed in with the
	// password would (never naming a pane: nothing is repinned).
	browser := func(method, path string, body any, out any) int {
		t.Helper()
		port, _ := tc.agentsPort()
		b, _ := json.Marshal(body)
		req, _ := http.NewRequest(method, "http://127.0.0.1:"+strconv.Itoa(port)+path, bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		req.SetBasicAuth("admin", "secret")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		json.NewDecoder(resp.Body).Decode(out)
		return resp.StatusCode
	}
	answer := func(id string, body map[string]any) (int, map[string]any) {
		t.Helper()
		var l asksListing
		if code := browser(http.MethodGet, "/api/mux/asks", nil, &l); code != http.StatusOK {
			t.Fatalf("asks: %d", code)
		}
		for _, q := range l.Asks {
			if q.ID == id {
				body["updated"] = q.Updated.Format(time.RFC3339Nano)
			}
		}
		var got map[string]any
		return browser(http.MethodPost, "/api/mux/asks/"+id+"/answer", body, &got), got
	}

	// 1. A job of the orchestrator's, so the asks can be pruned with it
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"job", "add", "--json", "--title", "Parser", "--pane", "web/api"}); err != nil {
		t.Fatal(err)
	}
	var j jobView
	json.Unmarshal(tc.stdout.Bytes(), &j)
	if j.CreatedBy != "%3" {
		t.Fatalf("job %+v", j)
	}
	// 2. Five questions
	for i, args := range [][]string{
		{"--text", "Which parser?"},
		{"--text", "Keep the old API?", "--choice", "A", "--choice", "B"},
		{"--text", "Rename the module?"},
		{"--text", "Merge PR #12 now?", "--job", j.ID},
		{"--text", "What next?"},
	} {
		if code, out := run(append([]string{"ask", "add"}, args...)...); code != 0 || out != "Q"+strconv.Itoa(i+1)+"\n" {
			t.Fatalf("add %d: %d %q", i+1, code, out)
		}
	}
	// 3. Q1 and Q2 answered in the PWA: each reaches the orchestrator once
	if code, out := answer("Q1", map[string]any{"text": "the new one"}); code != http.StatusOK || out["recorded"] != true {
		t.Fatalf("answer Q1: %d %v", code, out)
	}
	if code, out := answer("Q2", map[string]any{"choice": 2}); code != http.StatusOK {
		t.Fatalf("answer Q2: %d %v", code, out)
	}
	if code, out := answer("Q1", map[string]any{"text": "again"}); code != http.StatusConflict || out["code"] != "ask_closed" {
		t.Errorf("answer Q1 twice: %d %v", code, out)
	}
	f.mu.Lock()
	pasted := strings.Join(f.pasted, "|")
	f.mu.Unlock()
	if pasted != "Answer to Q1: the new one|Answer to Q2 (choice 2): B" {
		t.Errorf("the orchestrator got %q", pasted)
	}
	// 4. Q3 answered in a tab, closed by the orchestrator
	if code, out := run("ask", "close", "Q3", "--answer", "answered in the tab"); code != 0 {
		t.Fatalf("close: %d %s", code, out)
	}
	if code, out := run("ask", "close", "Q3"); code != 0 || !strings.Contains(out, "Q3 was already answered (agent): answered in the tab") {
		t.Errorf("close twice: %d %s", code, out)
	}
	// 5. Two open, the same after a restart
	if got := openIDs(false); got != "Q4:open Q5:open" {
		t.Fatalf("open %s", got)
	}
	code, out := run("ask", "list")
	if code != 0 || !strings.Contains(out, "Q4  Parser  Merge PR #12 now?") || !strings.Contains(out, "Q5  -       What next?") {
		t.Errorf("list: %s", out)
	}
	startAgentsServer(t, tc, dir, f)
	if got := openIDs(false); got != "Q4:open Q5:open" {
		t.Fatalf("after a restart %s", got)
	}
	// 6. No id given twice
	if code, out := run("ask", "add", "--text", "One more?"); code != 0 || out != "Q6\n" {
		t.Errorf("add after restart: %d %q", code, out)
	}
	// 7. wait --mine reports the PWA's answers once
	code, out = run("wait", "--mine", "--timeout", "2s")
	if code != 0 || !strings.Contains(out, "Q1 answered in the PWA: the new one") || !strings.Contains(out, "Q2 answered in the PWA: B") {
		t.Errorf("wait --mine: %d\n%s", code, out)
	}
	code, out = run("wait", "--mine", "--timeout", "2s")
	if code != agentsExitIdle || strings.Contains(out, "answered in the PWA") || !strings.Contains(out, "open: Q4 Q5 Q6") {
		t.Errorf("wait --mine again: %d\n%s", code, out)
	}
	// 8. Every job done: the answered asks and the job's go, the open
	// ones of no job stay
	if code, out := run("job", "set", j.ID, "--state", "done"); code != 0 {
		t.Fatalf("job done: %d %s", code, out)
	}
	if got := openIDs(true); got != "Q5:open Q6:open" {
		t.Errorf("pruned %s", got)
	}
	// 9. The orchestrator starts a new session in its pane: the PWA's
	// answer waits until it names itself (any ask command), then reaches it
	f.mu.Lock()
	f.session.PID, f.session.ProcStart = 4242, "later"
	f.mu.Unlock()
	settle()
	if code, out := answer("Q6", map[string]any{"text": "ship it"}); code != http.StatusConflict || out["code"] != "ask_no_agent" {
		t.Errorf("before the repin: %d %v", code, out)
	}
	if code, out := run("ask", "list"); code != 0 || !strings.Contains(out, "Q6") {
		t.Fatalf("list from the new session: %d %s", code, out)
	}
	if code, out := answer("Q6", map[string]any{"text": "ship it"}); code != http.StatusOK {
		t.Errorf("after the repin: %d %v", code, out)
	}
	f.mu.Lock()
	last := f.pasted[len(f.pasted)-1]
	f.mu.Unlock()
	if last != "Answer to Q6: ship it" {
		t.Errorf("last message %q", last)
	}
}

package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
)

// testOpencodeChild is a subagent's session as session.list gives it
// (OpenCode 2.3.0, testdata/opencode/session-list-children.json).
func testOpencodeChild(id, parent, agent, title, outcome string, created int64) json.RawMessage {
	s := map[string]any{"id": id, "parentID": parent, "projectID": "global", "agent": agent, "cost": 0,
		"title": title, "location": map[string]any{"directory": "/work/proj"},
		"time": map[string]any{"created": created, "updated": created + 300, "busy": created + 20}}
	if outcome != "" {
		s["outcome"] = outcome
		s["time"].(map[string]any)["idle"] = created + 400
	}
	data, _ := json.Marshal(s)
	return data
}

// opencodeSubagentPane is a pane on session sesPane whose subagents are:
// ses_a (done, its child ses_g failed and ses_g's own child too deep to
// show), ses_b (running, its child ses_h interrupted), and ses_c, a
// subagent of another session.
func opencodeSubagentPane(t *testing.T) (*fakeOpencode, *agentAPI) {
	t.Helper()
	oc := newFakeOpencode(t)
	opencodeSubagentKids.forgetPrefix("")
	opencodeSubagentTails.forgetPrefix("")
	t.Cleanup(func() {
		opencodeSubagentKids.forgetPrefix("")
		opencodeSubagentTails.forgetPrefix("")
	})
	base := int64(1794712613715)
	oc.set(func() {
		oc.list = []json.RawMessage{
			testOpencodeChild("ses_h", "ses_b", "explore", "Look deeper", "interrupted", base+5000),
			testOpencodeChild("ses_gg", "ses_g", "explore", "Too deep", "succeeded", base+4000),
			testOpencodeChild("ses_g", "ses_a", "general", "Nested\n  task", "failed", base+3000),
			testOpencodeChild("ses_c", "sesOther", "explore", "Someone else's", "", base+2500),
			testOpencodeChild("ses_b", "sesPane", "general", "Write tests", "", base+2000),
			testOpencodeChild("ses_a", "sesPane", "explore", "Explore files", "succeeded", base),
		}
		oc.active = []string{"sesPane", "ses_b"}
		oc.messages["ses_a"] = testOpencodeMessages(t, "message-list-after-tool.json")
	})
	a := newAgentAPI(nil)
	return oc, a
}

func TestOpencodeSubagentTree(t *testing.T) {
	oc, a := opencodeSubagentPane(t)
	res, err := a.subagentTree(AgentSession{Agent: "opencode", ID: "sesPane"})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Nodes) != 2 || res.Truncated {
		t.Fatalf("tree = %+v", res)
	}
	first, second := res.Nodes[0], res.Nodes[1]
	if first.ID != "ses_a" || first.Type != "explore" || first.Description != "Explore files" || first.Status != "done" ||
		first.Depth != 1 || first.StartTS != "2026-11-15T03:16:53.715Z" || first.EndTS == "" ||
		first.LastTool != "shell" || first.Tokens != 1230 {
		t.Errorf("first = %+v", first)
	}
	// Its child failed; that child's own child is past the depth shown.
	if len(first.Children) != 1 || first.Children[0].ID != "ses_g" || first.Children[0].Status != "error" ||
		first.Children[0].Depth != 2 || first.Children[0].Description != "Nested task" || len(first.Children[0].Children) != 0 {
		t.Errorf("first's children = %+v", first.Children)
	}
	// Running while the service lists it as active, with no end; a session
	// with no message has no last tool.
	if second.ID != "ses_b" || second.Status != "running" || second.EndTS != "" || second.LastTool != "" ||
		len(second.Children) != 1 || second.Children[0].Status != "stopped" {
		t.Errorf("second = %+v", second)
	}
	for _, r := range oc.reqs() {
		if strings.Contains(r, "ses_c") || strings.Contains(r, "sesOther") || strings.Contains(r, "parentID=ses_gg") {
			t.Errorf("asked %s", r)
		}
	}
	// A subagent that has not changed is not read again.
	a.subagents.forgetPrefix("")
	n := len(oc.reqs())
	if _, err := a.subagentTree(AgentSession{Agent: "opencode", ID: "sesPane"}); err != nil {
		t.Fatal(err)
	}
	read := map[string]bool{}
	for _, r := range oc.reqs()[n:] {
		if strings.Contains(r, "/ses_a/message") || strings.Contains(r, "parentID=ses_a") {
			t.Errorf("read again: %s", r)
		}
		read[r] = true
	}
	// A running one is read every time, its last tool and tokens changing
	// before its session's time does.
	if !read["GET /api/session/ses_b/message?limit=10&order=desc"] || !slices.ContainsFunc(oc.reqs()[n:], func(r string) bool { return strings.HasSuffix(r, "parentID=ses_b") }) {
		t.Errorf("running subagent not read again: %v", oc.reqs()[n:])
	}
}

// Grandchildren that cannot be read leave the children shown, the tree
// marked truncated.
func TestOpencodeSubagentPartial(t *testing.T) {
	oc, a := opencodeSubagentPane(t)
	captureLogs(t)
	oc.set(func() {
		// A child of ses_a the service lists in a shape that does not
		// decode: that list fails.
		oc.list = append(oc.list, json.RawMessage(`{"id":"ses_bad","parentID":"ses_a","time":"not a time"}`))
	})
	res, err := a.subagentTree(AgentSession{Agent: "opencode", ID: "sesPane"})
	if err != nil || len(res.Nodes) != 2 || !res.Truncated || len(res.Nodes[0].Children) != 0 || len(res.Nodes[1].Children) != 1 {
		t.Errorf("partial = %+v %v", res, err)
	}
}

func TestOpencodeSubagentLimits(t *testing.T) {
	oc, a := opencodeSubagentPane(t)
	oc.set(func() {
		var list []json.RawMessage
		for i := range subagentsMaxNodes + 5 {
			list = append(list, testOpencodeChild(fmt.Sprintf("ses_n%03d", i), "sesMany", "explore", "t", "succeeded", int64(1794712613715+i)))
		}
		oc.list = list
	})
	res, err := a.subagentTree(AgentSession{Agent: "opencode", ID: "sesMany"})
	if err != nil || len(res.Nodes) != subagentsMaxNodes || !res.Truncated {
		t.Errorf("many = %d %v %v", len(res.Nodes), res.Truncated, err)
	}
	// Oldest first, as Claude Code's tree is.
	if res.Nodes[0].StartTS > res.Nodes[len(res.Nodes)-1].StartTS {
		t.Error("not oldest first")
	}
}

func TestOpencodeSubagentErrors(t *testing.T) {
	oc, a := opencodeSubagentPane(t)
	logs := captureLogs(t)
	oc.set(func() { oc.status = http.StatusInternalServerError })
	if _, err := a.subagentTree(AgentSession{Agent: "opencode", ID: "sesPane"}); err != errNoTranscript {
		t.Errorf("service error = %v", err)
	}
	if strings.Contains(logs.String(), "internal words") {
		t.Errorf("service words logged: %s", logs)
	}
	// No service: no tree, no error.
	stubOpencodeStateDir(t, t.TempDir())
	a.subagents.forgetPrefix("")
	res, err := a.subagentTree(AgentSession{Agent: "opencode", ID: "sesPane"})
	if err != nil || len(res.Nodes) != 0 {
		t.Errorf("no service = %+v %v", res, err)
	}
	// A subagent whose messages cannot be read keeps its node.
	oc2, a2 := opencodeSubagentPane(t)
	oc2.set(func() { oc2.big = 1 })
	res, err = a2.subagentTree(AgentSession{Agent: "opencode", ID: "sesPane"})
	if err != nil || len(res.Nodes) != 2 || res.Nodes[0].LastTool != "" {
		t.Errorf("unreadable tail = %+v %v", res, err)
	}
}

// The route: same-site only; a view-only client gets the same tree, as for
// Claude Code.
func TestOpencodeSubagentRoute(t *testing.T) {
	_, a := opencodeSubagentPane(t)
	a.loc = fakeOpencodeLocator{AgentSession{Agent: "opencode", ID: "sesPane"}}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/mux/panes/{id}/agent/subagents", a.handleSubagents)
	for _, req := range []*http.Request{
		apiRequest("GET", "/api/mux/panes/0/agent/subagents", ""),
		viewRequest("GET", "/api/mux/panes/0/agent/subagents", ""),
	} {
		rec := serve(mux, req)
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"id":"ses_a"`) {
			t.Errorf("GET = %d %s", rec.Code, rec.Body)
		}
	}
	req := apiRequest("GET", "/api/mux/panes/0/agent/subagents", "")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(mux, req); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site = %d", rec.Code)
	}
}

func TestOpencodeSubagentNode(t *testing.T) {
	var s opencodeChild
	json.Unmarshal(testOpencodeChild("ses_x", "ses_p", " ", "", "", 0), &s)
	n := opencodeSubagentNode(s, false, 1)
	if n.Type != "agent" || n.Status != "done" || n.StartTS != "" || n.EndTS != "" {
		t.Errorf("bare = %+v", n)
	}
}

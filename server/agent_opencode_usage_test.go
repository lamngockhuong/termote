package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// The overview of an OpenCode pane: the tokens of the last answer and its
// model, the window the service's list of models (for the session's
// directory) gives it; a model the list does not hold has no share.
func TestOpencodeOverviewUsage(t *testing.T) {
	oc := newFakeOpencode(t)
	logs := captureLogs(t)
	opencodeDirs.forgetPrefix("")
	opencodeWindows.forgetPrefix("")
	t.Cleanup(func() {
		opencodeDirs.forgetPrefix("")
		opencodeWindows.forgetPrefix("")
	})
	info := json.RawMessage(`{"data":` + string(testOpencodeSession("sesPane", "", "t", "/work/proj", 1794712651000)) + `}`)
	oc.set(func() {
		oc.messages["sesPane"] = testOpencodeMessages(t, "message-list-image.json")
		oc.sessions["sesPane"] = info
	})
	a := newAgentAPI(nil)
	a.loc = fakeOpencodeLocator{AgentSession{Agent: "opencode", ID: "sesPane", Status: "idle"}}
	sum, err := a.summarizePane("0")
	if err != nil {
		t.Fatal(err)
	}
	u := sum.usage
	if u == nil || u.ContextTokens != 1230 || u.Model != "m1" || u.ContextWindow != 200_000 ||
		u.ContextPercent == nil || *u.ContextPercent != 0.6 || !u.Exact {
		t.Fatalf("usage = %+v", u)
	}
	if strings.Join(oc.modelLocations, ",") != "/work/proj" {
		t.Errorf("models asked for %q", oc.modelLocations)
	}
	// Read once a minute, not once per overview.
	a.reads.forgetPrefix("")
	if _, err := a.summarizePane("0"); err != nil || len(oc.modelLocations) != 1 {
		t.Errorf("models read again: %v %v", oc.modelLocations, err)
	}
	// The list holds the providers' API keys: never logged, never sent.
	raw, _ := json.Marshal(overviewPane{Usage: u})
	if strings.Contains(string(raw), "redacted") || strings.Contains(logs.String(), "redacted") {
		t.Errorf("provider settings leaked: %s %s", raw, logs)
	}

	// A model the service does not list: tokens and model, no window.
	oc.set(func() {
		oc.messages["sesPane"] = []json.RawMessage{json.RawMessage(`{"id":"msg_z","type":"assistant","time":{"created":1,"completed":2},` +
			`"model":{"id":"m9","providerID":"elsewhere"},"content":[{"type":"text","text":"hi"}],` +
			`"tokens":{"input":100,"output":5,"reasoning":1,"cache":{"read":10,"write":2}}}`)}
	})
	a.reads.forgetPrefix("")
	sum, err = a.summarizePane("0")
	if u := sum.usage; err != nil || u == nil || u.ContextTokens != 118 || u.Model != "m9" || u.ContextWindow != 0 || u.ContextPercent != nil {
		t.Errorf("unknown model = %+v %v", u, err)
	}

	// No session info, no list: the service's own list, then nothing.
	opencodeWindows.forgetPrefix("")
	oc.set(func() {
		delete(oc.sessions, "sesPane")
		oc.modelList = json.RawMessage(`{"data":[{"id":"m9","providerID":"elsewhere","limit":{"context":1000}}]}`)
	})
	opencodeDirs.forgetPrefix("")
	if w := opencodeWindow("sesPane", "elsewhere", "m9"); w != 1000 || oc.modelLocations[len(oc.modelLocations)-1] != "" {
		t.Errorf("no directory = %d %q", w, oc.modelLocations)
	}
	if w := opencodeWindow("sesPane", "", "m9"); w != 0 {
		t.Errorf("no provider = %d", w)
	}
	opencodeWindows.forgetPrefix("")
	oc.set(func() { oc.modelList = json.RawMessage(`{"data":`) })
	if w := opencodeWindow("sesPane", "elsewhere", "m9"); w != 0 {
		t.Errorf("bad list = %d", w)
	}
	stubOpencodeStateDir(t, t.TempDir())
	if w := opencodeWindow("sesPane", "elsewhere", "m9"); w != 0 {
		t.Errorf("no service = %d", w)
	}
}

// The text of a message sent with images: OpenCode takes the images as
// files, so the space the composer kept beside each one's place goes.
func TestOpencodeJoinParts(t *testing.T) {
	for _, tc := range []struct {
		parts []string
		want  string
	}{
		{[]string{"look"}, "look"},
		{[]string{"  keep my spaces  "}, "  keep my spaces  "},
		{[]string{"", " test, bạn"}, "test, bạn"},
		{[]string{"look at ", " and ", " please"}, "look at and please"},
		{[]string{"a ", " ", " b"}, "a b"},
		{[]string{"tail ", ""}, "tail"},
		{[]string{"", ""}, ""},
		{[]string{"line one\n", "\nline two"}, "line one\nline two"},
		{[]string{"a\n", " ", " b"}, "a\nb"},
		{[]string{"para one\n\n", "\npara two"}, "para one\n\npara two"},
		{[]string{"a", "b"}, "a b"},
	} {
		if got := opencodeJoinParts(tc.parts); got != tc.want {
			t.Errorf("%q = %q, want %q", tc.parts, got, tc.want)
		}
	}
}

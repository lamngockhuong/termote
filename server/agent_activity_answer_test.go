package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

// activitySince reads the status changes recorded after seq, as from/to.
func activitySince(t *testing.T, mux http.Handler, after uint64) ([]string, uint64) {
	t.Helper()
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/mux/activity?after="+strconv.FormatUint(after, 10), nil))
	var page activityPage
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &page) != nil {
		t.Fatalf("activity = %d %s", rec.Code, rec.Body)
	}
	var out []string
	for _, e := range page.Events {
		out = append(out, e.From+">"+e.To)
	}
	return out, page.Latest
}

// An answer the server confirmed moves the pane out of its dialog in the
// activity, so the next read that shows it blocked (the next question,
// another tab, a new dialog) records a new dialog; a refused one does not.
func TestAnswerLeavesDialogInActivity(t *testing.T) {
	shortConfirm(t)
	next := map[string]map[string]string{
		"2.1.286-ask-wizard":       {"1": "2.1.286-ask-wizard-tab2"},
		"2.1.286-ask-wizard-mixed": {"Right": "2.1.286-ask-wizard-multi-open"},
	}
	setup := func(first string) (*fakeWriter, *http.ServeMux, uint64) {
		f := newFakeWriter()
		f.session.Status = "blocked"
		f.snap = Snapshot{Groups: []Group{{ID: "w", Name: "w", Tabs: []Tab{{ID: "w:0", Name: "api",
			Panes: []Pane{{ID: "0", Agent: &AgentInfo{Name: "claude", Status: "blocked"}}}}}}}}
		f.screen = fixtureScreen(t, first)
		on := first
		f.onKeys = func(f *fakeWriter, keys []string) {
			if to, ok := next[on][keys[0]]; ok {
				on = to
				f.setScreen(fixtureScreen(t, to))
			}
		}
		mux := agentMux(f)
		getJSON(t, mux, "/api/mux/snapshot")
		_, mark := activitySince(t, mux, 0)
		return f, mux, mark
	}
	answer := func(mux *http.ServeMux, choice any) (int, map[string]any) {
		return postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": getPrompt(t, mux, "0")["promptId"], "choice": choice})
	}
	want := func(t *testing.T, got []string, want ...string) {
		t.Helper()
		if len(got) != len(want) {
			t.Fatalf("events %v, want %v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("events %v, want %v", got, want)
			}
		}
	}

	t.Run("the next question", func(t *testing.T) {
		_, mux, mark := setup("2.1.286-ask-wizard")
		if code, body := answer(mux, 1); code != http.StatusNoContent {
			t.Fatalf("answer = %d %v", code, body)
		}
		got, _ := activitySince(t, mux, mark)
		want(t, got, "blocked>working")
		getJSON(t, mux, "/api/mux/snapshot") // still blocked: question 2
		got, _ = activitySince(t, mux, mark)
		want(t, got, "blocked>working", "working>blocked")
	})
	t.Run("another tab, by step", func(t *testing.T) {
		_, mux, mark := setup("2.1.286-ask-wizard-mixed")
		if code, body := answer(mux, map[string]int{"step": 1}); code != http.StatusNoContent {
			t.Fatalf("step = %d %v", code, body)
		}
		getJSON(t, mux, "/api/mux/snapshot")
		got, _ := activitySince(t, mux, mark)
		want(t, got, "blocked>working", "working>blocked")
	})
	t.Run("the agent works after the answer", func(t *testing.T) {
		f, mux, mark := setup("2.1.286-ask-wizard")
		if code, body := answer(mux, 1); code != http.StatusNoContent {
			t.Fatalf("answer = %d %v", code, body)
		}
		f.snap.Groups[0].Tabs[0].Panes[0].Agent.Status = "working"
		getJSON(t, mux, "/api/mux/snapshot")
		got, _ := activitySince(t, mux, mark)
		want(t, got, "blocked>working")
	})
	t.Run("a refused answer records nothing", func(t *testing.T) {
		f, mux, mark := setup("2.1.286-ask-wizard")
		id := getPrompt(t, mux, "0")["promptId"]
		f.setScreen(fixtureScreen(t, "2.1.286-ask-wizard-tab2"))
		if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": id, "choice": 1}); code != http.StatusConflict {
			t.Fatalf("answer = %d %v", code, body)
		}
		time.Sleep(agentCacheTTL)
		getJSON(t, mux, "/api/mux/snapshot")
		got, _ := activitySince(t, mux, mark)
		want(t, got)
	})
}

// leftDialog moves only a pane the tracker shows blocked, and a snapshot
// read begun before it (the dialog still on screen) is not applied.
func TestActivityLeftDialog(t *testing.T) {
	var none *activityTracker
	none.leftDialog("w1:p1")
	tr, c := newTestTracker()
	observeNow(tr, herdrLike("working", "blocked"))
	mark := tr.eventsAfter(0, true).Latest
	tr.leftDialog("w1:p1") // working: nothing to leave
	tr.leftDialog("w1:p9") // unknown
	if page := tr.eventsAfter(mark, true); len(page.Events) != 0 {
		t.Fatalf("events %+v", page.Events)
	}
	c.advance(time.Second)
	stale := tr.begin()
	tr.leftDialog("w1:p2")
	tr.observe(stale, herdrLike("working", "blocked"))
	page := tr.eventsAfter(mark, true)
	if len(page.Events) != 1 || page.Events[0].Key != "w1:p2" || page.Events[0].From != "blocked" || page.Events[0].To != "working" {
		t.Fatalf("events %+v", page.Events)
	}
	// The next read applies, with the answer as when it began working.
	if a := agentOf(observeNow(tr, herdrLike("working", "working")), "w1:p2"); a == nil || a.Since != c.at(0) {
		t.Errorf("since %+v, want the answer's time", a)
	}
}

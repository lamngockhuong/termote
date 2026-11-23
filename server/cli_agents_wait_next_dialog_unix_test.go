//go:build !windows

package main

import (
	"strconv"
	"strings"
	"testing"
	"time"
)

// The next question of a multi-question dialog, or another tab of it, is a
// new dialog for a wait: the pane shows blocked on every snapshot read before
// and after the answer, so only the answer marks that it left the dialog.
func TestAgentsWaitNextQuestion(t *testing.T) {
	shortWait(t)
	tc, f := agentsTest(t, lines(0, 1))
	next := map[string]map[string]string{
		"2.1.286-ask-wizard":               {"1": "2.1.286-ask-wizard-tab2"},
		"2.1.286-ask-wizard-tab2":          {"2": "2.1.286-ask-wizard-multi-toggled"},
		"2.1.286-ask-wizard-multi-toggled": {"Right": "2.1.286-ask-wizard-submit"},
		"2.1.286-ask-wizard-submit":        {"1": "2.1.286-ask-wizard-after-submit"},
	}
	on := "2.1.286-ask-wizard"
	f.mu.Lock()
	f.session.Status = "blocked"
	f.screen = fixtureScreen(t, on)
	f.onKeys = func(f *fakeWriter, keys []string) {
		if to, ok := next[on][keys[0]]; ok {
			on = to
			f.setScreen(fixtureScreen(t, to))
		}
	}
	f.mu.Unlock()
	// The first question, shown after the mark: a read while the agent
	// works, then the dialog.
	port, err := tc.agentsPort()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tc.agentsSnapshot(port); err != nil {
		t.Fatal(err)
	}
	first, err := tc.activityLatest(port)
	if err != nil {
		t.Fatal(err)
	}
	f.setStatus("%2", "blocked")
	if err := tc.dispatch("agents", []string{"wait", "%2", "--after", strconv.FormatUint(first, 10)}); exitCode(err) != agentsExitDialog {
		t.Fatalf("first question: %v %s", err, tc.stdout)
	}
	mark := waitMark(t, tc.stdout.String())
	// Each answer moves to another question (a choice, then a tab with
	// next), and the pane stays blocked throughout.
	for _, choice := range []string{"1", "2", "next"} {
		time.Sleep(agentCacheTTL) // the screen the prompt route read last
		if err := tc.dispatch("agents", []string{"answer", "%2", choice}); err != nil {
			t.Fatalf("answer %s on %s: %v (%s)", choice, on, err, tc.stderr)
		}
		tc.stdout.Reset()
		err := tc.dispatch("agents", []string{"wait", "%2", "--after", mark})
		if exitCode(err) != agentsExitDialog || !strings.Contains(tc.stdout.String(), "web/ui (%2) waits on a dialog") {
			t.Fatalf("after answer %s, on %s: exit %d: %s", choice, on, exitCode(err), tc.stdout)
		}
		mark = waitMark(t, tc.stdout.String())
	}
	// The last answer submits: the agent works, and no dialog is reported.
	time.Sleep(agentCacheTTL)
	if err := tc.dispatch("agents", []string{"answer", "%2", "1"}); err != nil || on != "2.1.286-ask-wizard-after-submit" {
		t.Fatalf("submit: %v on %s (%s)", err, on, tc.stderr)
	}
	f.mu.Lock()
	f.session.Status = "working"
	f.mu.Unlock()
	f.setStatus("%2", "working")
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"wait", "%2", "--after", mark, "--timeout", "300ms"}); exitCode(err) != agentsExitTimeout {
		t.Errorf("after submit: exit %d: %s", exitCode(err), tc.stdout)
	}
}

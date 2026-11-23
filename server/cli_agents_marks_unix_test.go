//go:build !windows

package main

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The trial that lost a turn: the agent in %1 ends its turn just before a
// start gives %2 work and prints its mark; one mark for both panes then
// never reports %1. Each pane waited on from its own mark reports it, and
// the next wait keeps the other pane's own mark.
func TestAgentsWaitOwnMarks(t *testing.T) {
	shortWait(t)
	tc, f := agentsTest(t, lines(0, 1))
	port, _ := tc.agentsPort()
	latest := func() string {
		t.Helper()
		m, err := tc.activityLatest(port)
		if err != nil {
			t.Fatal(err)
		}
		return strconv.FormatUint(m, 10)
	}
	record := func(pane, status string) {
		f.setStatus(pane, status)
		tc.dispatch("agents", []string{"list"}) // a snapshot read records the change
	}
	record("%1", "idle")
	record("%2", "idle")
	markA := latest() // what the send to %1 printed
	record("%1", "working")
	record("%1", "done") // %1 ends its turn...
	markC := latest()    // ...before the start of %2 prints its mark
	record("%2", "working")

	// One mark for both: %1's turn is before it, so only the timeout ends
	// the wait (what the trial saw).
	tc.stdout.Reset()
	err := tc.dispatch("agents", []string{"wait", "%1", "%2", "--after", markC, "--timeout", "100ms"})
	if out := tc.stdout.String(); exitCode(err) != agentsExitTimeout || strings.Contains(out, "(%1) is done") ||
		!strings.Contains(out, "next: termote agents wait %1@"+markC+" %2@"+markC+"\n") {
		t.Errorf("one mark: %v\n%s", err, out)
	}
	// Each pane from its own mark.
	for _, args := range [][]string{
		{"wait", "%1@" + markA, "%2@" + markC},
		{"wait", "%1@" + markA, "%2", "--after", markC},       // --after for a pane with none of its own
		{"wait", "%1@" + markC, "%2@" + markC, "%1@" + markA}, // named twice: the older mark
		{"wait", "web/api@" + markA, "%2@" + markC},           // a name with a mark
	} {
		tc.stdout.Reset()
		err := tc.dispatch("agents", args)
		out := tc.stdout.String()
		if err != nil || !strings.Contains(out, "web/api (%1) is done; read it: termote agents read %1\n") ||
			!strings.Contains(out, "next: termote agents wait %2@"+markC+"\n") {
			t.Errorf("%v: %v\n%s", args, err, out)
		}
	}
	// Both done: no pane is left, and the line says so in the same form.
	record("%2", "idle")
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"wait", "%1@" + markA, "%2@" + markC}); err != nil ||
		!strings.Contains(tc.stdout.String(), "web/ui (%2) is done") || !strings.Contains(tc.stdout.String(), "next: no pane left to wait on") {
		t.Errorf("both: %v\n%s", err, tc.stdout)
	}
	// Nothing to wait for: every pane, from the latest mark.
	tc.stdout.Reset()
	now := latest()
	if err := tc.dispatch("agents", []string{"wait", "%1@" + now, "%2@" + now}); exitCode(err) != agentsExitIdle ||
		!strings.Contains(tc.stdout.String(), "next: termote agents wait %1@"+now+" %2@"+now+"\n") {
		t.Errorf("nothing: %v\n%s", err, tc.stdout)
	}
	// A mark past the newest change (from before a restart) resets, even
	// beside a pane whose mark is older.
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"wait", "%1@999999", "%2@" + markC}); exitCode(err) != agentsExitReset ||
		!strings.Contains(tc.stdout.String(), "history was reset") {
		t.Errorf("past mark: %v\n%s", err, tc.stdout)
	}
	// A mark that is not a number is part of the name.
	if err := tc.dispatch("agents", []string{"wait", "%1@x"}); err == nil || !strings.Contains(err.Error(), `no pane is named "%1@x"`) {
		t.Errorf("not a mark: %v", err)
	}
}

func TestSplitWaitMark(t *testing.T) {
	for in, want := range map[string]struct {
		name string
		mark uint64
		ok   bool
	}{
		"%1@41":                   {"%1", 41, true},
		"w4A:p1@0":                {"w4A:p1", 0, true},
		"web/api@7":               {"web/api", 7, true},
		"a@b@9":                   {"a@b", 9, true},
		"%1":                      {"%1", 0, false},
		"%1@":                     {"%1@", 0, false},
		"@5":                      {"@5", 0, false},
		"%1@x":                    {"%1@x", 0, false},
		"%1@+5":                   {"%1@+5", 0, false},
		"%1@99999999999999999999": {"%1@99999999999999999999", 0, false},
	} {
		name, mark, ok := splitWaitMark(in)
		if name != want.name || mark != want.mark || ok != want.ok {
			t.Errorf("%q: %q %d %v", in, name, mark, ok)
		}
	}
}

// list --json carries the mark a first wait starts from, read after the
// snapshot it lists.
func TestAgentsListLatest(t *testing.T) {
	tc, f := agentsTest(t, lines(0, 1))
	f.setStatus("%1", "working")
	tc.dispatch("agents", []string{"list"})
	port, _ := tc.agentsPort()
	want, _ := tc.activityLatest(port)
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"list", "--json"}); err != nil {
		t.Fatal(err)
	}
	var l agentsListing
	if err := json.Unmarshal(tc.stdout.Bytes(), &l); err != nil || l.Latest == nil || *l.Latest != want || want == 0 || l.Self != "" {
		t.Errorf("listing: %v %s", err, tc.stdout)
	}
	// Run from %2 of this tmux: the row says so.
	tc.env["TMUX"], tc.env["TMUX_PANE"] = "/tmp/tmux-1000/default,1,0", "%2"
	tc.runner.outputs["tmux display-message -p -t %2 #{window_id}\t#{session_name}"] = "\tweb\n"
	tc.stdout.Reset()
	tc.dispatch("agents", []string{"list"})
	out := tc.stdout.String()
	if !strings.Contains(out, "A first wait starts after "+strconv.FormatUint(want, 10)) || !strings.Contains(out, "web/ui (this pane)") {
		t.Errorf("list: %s", out)
	}
	tc.stdout.Reset()
	tc.dispatch("agents", []string{"list", "--json"})
	l = agentsListing{}
	json.Unmarshal(tc.stdout.Bytes(), &l)
	if l.Self != "%2" || len(l.Agents) != 3 || l.Agents[0].Self || !l.Agents[1].Self {
		t.Errorf("self: %s", tc.stdout)
	}
}

// Claude Code busy with its answer written, waiting on a background agent:
// a wait from before it started reports that once, and the next wait from
// the mark it prints reports the turn's end.
func TestAgentsWaitBackgroundOnly(t *testing.T) {
	shortWait(t)
	tc, f := agentsTest(t, lines(0, 1))
	port, _ := tc.agentsPort()
	record := func(pane, status string) {
		f.setStatus(pane, status)
		tc.dispatch("agents", []string{"list"})
	}
	record("%2", "idle")
	m, _ := tc.activityLatest(port)
	mark := strconv.FormatUint(m, 10)
	f.mu.Lock()
	f.session.Status = "working"
	f.mu.Unlock()
	f.setScreen(fixtureScreen(t, "2.1.330-wait-background-agent"))
	record("%2", "working")
	latest, _ := tc.activityLatest(port)
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"wait", "%2@" + mark}); err != nil {
		t.Fatalf("%v %s", err, tc.stdout)
	}
	next := "%2@" + strconv.FormatUint(latest, 10)
	if out := tc.stdout.String(); !strings.Contains(out, "web/ui (%2) wrote its answer and only waits on background work (1 background agent); read it: termote agents read %2; its turn ends when that work does (next: waits on it)\n") ||
		!strings.Contains(out, "next: termote agents wait "+next+"\n") {
		t.Errorf("background:\n%s", out)
	}
	// list says so too.
	tc.stdout.Reset()
	tc.dispatch("agents", []string{"list"})
	if out := tc.stdout.String(); !strings.Contains(out, "background") || !strings.Contains(out, "web/ui still runs in the background: 1 background agent") {
		t.Errorf("list:\n%s", out)
	}
	tc.stdout.Reset()
	tc.dispatch("agents", []string{"list", "--json"})
	var l agentsListing
	json.Unmarshal(tc.stdout.Bytes(), &l)
	if l.Agents[1].Status != "working" || l.Agents[1].Background != "1 background agent" {
		t.Errorf("list --json: %s", tc.stdout)
	}
	// From the mark it printed: not again, but the turn's end.
	go func() { time.Sleep(100 * time.Millisecond); f.setStatus("%2", "done") }()
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"wait", next}); err != nil || !strings.Contains(tc.stdout.String(), "web/ui (%2) is done") {
		t.Errorf("then done: %v\n%s", err, tc.stdout)
	}
	// A turn that started before the mark is followed to its end only.
	record("%2", "working")
	m, _ = tc.activityLatest(port)
	tc.stdout.Reset()
	err := tc.dispatch("agents", []string{"wait", "%2@" + strconv.FormatUint(m, 10), "--timeout", "100ms"})
	if exitCode(err) != agentsExitTimeout || strings.Contains(tc.stdout.String(), "background work") {
		t.Errorf("started before: %v\n%s", err, tc.stdout)
	}
	// A working line on screen is a turn running.
	f.setScreen(fixtureScreen(t, "2.1.310-working"))
	time.Sleep(agentCacheTTL)
	record("%2", "idle")
	m, _ = tc.activityLatest(port)
	record("%2", "working")
	tc.stdout.Reset()
	err = tc.dispatch("agents", []string{"wait", "%2@" + strconv.FormatUint(m, 10), "--timeout", "100ms"})
	if exitCode(err) != agentsExitTimeout {
		t.Errorf("working line: %v\n%s", err, tc.stdout)
	}
}

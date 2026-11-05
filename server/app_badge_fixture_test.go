package main

import (
	"encoding/json"
	"os"
	"testing"
)

// testdata/badge-snapshot.json is the server's own snapshot JSON: the PWA
// page and its service worker count the app badge from it, and must agree
// with this count.
func TestBadgeSnapshotFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/badge-snapshot.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Expected int             `json:"expected"`
		Snapshot json.RawMessage `json:"snapshot"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	var snap Snapshot
	if err := json.Unmarshal(f.Snapshot, &snap); err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, g := range snap.Groups {
		for _, tab := range g.Tabs {
			for _, p := range tab.Panes {
				if p.Agent != nil && (p.Agent.Status == "blocked" || p.Agent.Status == "done") {
					n++
				}
			}
		}
	}
	if n != f.Expected {
		t.Errorf("count = %d, want %d", n, f.Expected)
	}
	// Its groups written back say the same: no field the server lacks.
	out, _ := json.Marshal(snap.Groups)
	var a struct {
		Groups any `json:"groups"`
	}
	var b any
	json.Unmarshal(f.Snapshot, &a)
	json.Unmarshal(out, &b)
	ja, _ := json.Marshal(a.Groups)
	jb, _ := json.Marshal(b)
	if string(ja) != string(jb) {
		t.Errorf("fixture differs from the server's JSON:\n%s\n%s", ja, jb)
	}
}

//go:build darwin || windows

package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// macOS (APFS by default) and Windows ignore case, and EvalSymlinks keeps
// the caller's case on macOS: a core.hooksPath that names the work tree in
// another case is still the folder git runs hooks from, so an edit in it is
// refused.
func TestDelegatedEditHooksPathOtherCase(t *testing.T) {
	dt := newDelegateTest(t, delegateScreen(t, "edit"), "")
	gitIn(t, dt.wt, "init", "-q")
	gitIn(t, dt.wt, "config", "core.hooksPath", strings.ToUpper(dt.wt))
	os.WriteFile(dt.path, []byte(jobsTranscript+toolUseLine("toolu_e", "Edit",
		map[string]any{"file_path": filepath.Join(dt.wt, "notes.txt"), "old_string": "world", "new_string": "there"}, false)), 0o600)
	dt.grant("edit", "", 30)
	code, out := dt.answer()
	if code != http.StatusConflict || out["reason"] != "denied_path" {
		t.Errorf("= %d %v, want denied_path", code, out)
	}
	if keys := dt.keys(); len(keys) != 0 {
		t.Errorf("keys sent: %v", keys)
	}
}

// A second workspace whose shell reports the job's worktree in another case
// works in that worktree: the finish refuses to remove it.
func TestJobFinishWorktreeSharedOtherCase(t *testing.T) {
	ft := newFinishTest(t, true)
	ft.merged()
	other := filepath.Join(filepath.Dir(ft.repo.wt), strings.ToUpper(filepath.Base(ft.repo.wt)))
	ft.f.mu.Lock()
	ft.f.snap.Groups = append(ft.f.snap.Groups, Group{ID: "w5", Tabs: []Tab{{ID: "w5:t1", Key: "k5",
		Processes: []ProcessInfo{{Name: "zsh", Cwd: other}}}}})
	ft.f.mu.Unlock()
	ft.refused("other case", map[string]any{"close": true, "removeWorktree": true}, http.StatusConflict, "finish_worktree_shared")
	if _, err := os.Stat(ft.repo.wt); err != nil {
		t.Errorf("worktree gone: %v", err)
	}
}

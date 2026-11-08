package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// samePaneDir compares two Windows paths as the files routes would see them.
func samePaneDir(a, b string) bool {
	ra, err1 := filepath.EvalSymlinks(a)
	rb, err2 := filepath.EvalSymlinks(b)
	return err1 == nil && err2 == nil && strings.EqualFold(ra, rb)
}

// A real psmux: two sessions, each numbering its own panes from %1, report
// their own directories, under keys of their own, and each pane resolves
// its own root. One directory holds '%', a space and non-ASCII characters.
func TestPsmuxPaneDirPerSession(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil || !tmuxIsPsmux {
		t.Skip("needs psmux")
	}
	ctx := context.Background()
	origSession := tmuxSession
	tmuxSession = fmt.Sprintf("termote-files-%d", os.Getpid())
	t.Cleanup(func() { tmuxSession = origSession })

	// Not t.TempDir: a killed session's shell holds its directory for a
	// moment, so the directory goes once it lets go (this cleanup runs last).
	base, err := os.MkdirTemp("", "termote-psmux-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		waitUntil(t, "session directories released", func() bool { return os.RemoveAll(base) == nil })
	})
	plain, odd := filepath.Join(base, "plain"), filepath.Join(base, "pct%20x tiếng việt 日本")
	dirs := []string{plain, odd}
	for _, d := range dirs {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	m := tmuxMux{}
	rr := newRootResolver(newGitRunner())
	keys := map[string]bool{}
	for i, dir := range dirs {
		sid, err := m.NewGroup(ctx, fmt.Sprintf("%s-%d", tmuxSession, i), dir)
		if err != nil {
			t.Fatalf("NewGroup(%q) = %v", dir, err)
		}
		t.Cleanup(func() { tmuxCmd(context.Background(), "kill-session", "-t", sid).Run() })
		// The first window's index, whatever base-index the user's config sets.
		out, err := tmuxCmd(ctx, "display-message", "-p", "-t", sid, "#{window_index}").Output()
		if err != nil {
			t.Fatalf("window index of %s: %v", sid, err)
		}
		id := sid + ":" + strings.TrimSpace(string(out))
		var got, key string
		waitUntil(t, "pane directory", func() bool {
			got, key, err = m.PaneDir(ctx, id)
			return err == nil && samePaneDir(got, dir)
		})
		if !strings.HasPrefix(key, sid+":%") || keys[key] {
			t.Errorf("PaneDir(%s) key = %q, keys so far %v", id, key, keys)
		}
		keys[key] = true
		root, err := rr.paneRoot(ctx, m, id)
		if err != nil || !samePaneDir(root.Root, dir) {
			t.Errorf("paneRoot(%s) = %+v, %v; want %q", id, root, err, dir)
		}
	}
}

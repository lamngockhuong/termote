package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// eventually waits for cond like waitFor, longer: a process start on
// Windows (a scanner looking at it first) can take seconds.
func eventually(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// checkOwnerOnly fails unless dir's DACL is protected and gives access to
// the current user alone, inherited by what is made in it.
func checkOwnerOnly(t *testing.T, dir string) {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	tu, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	if got, want := sd.String(), "D:PAI(A;OICI;FA;;;"+tu.User.Sid.String()+")"; got != want {
		t.Errorf("%s DACL = %s, want %s", dir, got, want)
	}
}

// A new checkout's parent folder is owner-only, and what git writes in it
// inherits that.
func TestGitWorktreeParentOwnerOnly(t *testing.T) {
	dir := filepath.Join(tempDirReal(t), "w", "repo")
	if err := makeWorktreeParent(dir); err != nil {
		t.Fatal(err)
	}
	checkOwnerOnly(t, dir)
	child := filepath.Join(dir, "feat-x")
	if err := os.Mkdir(child, 0o700); err != nil {
		t.Fatal(err)
	}
	sd, err := windows.GetNamedSecurityInfo(child, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	tu, _ := windows.GetCurrentProcessToken().GetTokenUser()
	if s := sd.String(); strings.Count(s, "(") != 1 || !strings.Contains(s, ";"+tu.User.Sid.String()+")") {
		t.Errorf("child DACL = %s", s)
	}
}

// A deny dir reached through a junction is refused: filepath.EvalSymlinks
// leaves a junction as it is.
func TestNewWorktreePathDeniedThroughJunction(t *testing.T) {
	d := tempDirReal(t)
	denied := filepath.Join(d, "denied")
	if err := os.Mkdir(denied, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(d, "j")
	mklinkJ(t, link, denied)
	if _, err := newWorktreePath(filepath.Join(link, "worktrees"), "repo", "y", []string{denied}); !errors.Is(err, errWorktreeCreateFailed) {
		t.Errorf("denied through a junction: %v", err)
	}
	if _, err := newWorktreePath(filepath.Join(link, "worktrees"), "repo", "y", nil); err != nil {
		t.Errorf("not denied: %v", err)
	}
}

// A remove waits for a file open in the worktree to be closed, answers
// in_use when it stays open, and leaves the folder as it was.
func TestWaitWorktreeFree(t *testing.T) {
	origWait, origPoll := worktreeFreeWait, worktreeFreePoll
	worktreeFreeWait, worktreeFreePoll = 600*time.Millisecond, 50*time.Millisecond
	t.Cleanup(func() { worktreeFreeWait, worktreeFreePoll = origWait, origPoll })
	ctx := context.Background()

	dir := filepath.Join(tempDirReal(t), "wt")
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := waitWorktreeFree(ctx, dir); err != nil {
		t.Fatalf("free folder: %v", err)
	}
	f, err := os.Create(filepath.Join(dir, "sub", "a.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if err := waitWorktreeFree(ctx, dir); err != errWorktreeInUse {
		t.Errorf("open file: %v", err)
	}
	// Closed while it waits.
	time.AfterFunc(150*time.Millisecond, func() { f.Close() })
	if err := waitWorktreeFree(ctx, dir); err != nil {
		t.Errorf("closed while waiting: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "sub", "a.txt")); err != nil {
		t.Errorf("folder changed: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Dir(dir))
	if len(entries) != 1 {
		t.Errorf("probe left behind: %v", entries)
	}

	// A process working in the folder holds it too, and so does its child
	// once the shell has gone.
	// It says ready once it works there: a probe while it starts would move
	// the folder from under it.
	cmd := exec.Command("cmd", "/c", "echo ready& ping -n 30 127.0.0.1 >nul")
	cmd.Dir = filepath.Join(dir, "sub")
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	killTree := func() { exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run(); cmd.Wait() }
	t.Cleanup(killTree)
	if line, err := bufio.NewReader(out).ReadString('\n'); err != nil || !strings.HasPrefix(line, "ready") {
		t.Fatalf("cmd: %q %v", line, err)
	}
	if err := waitWorktreeFree(ctx, dir); err != errWorktreeInUse {
		t.Errorf("process inside: %v", err)
	}
	killTree()
	eventually(t, func() bool { return waitWorktreeFree(ctx, dir) == nil })
	if err := waitWorktreeFree(ctx, filepath.Join(dir, "gone")); err != nil {
		t.Errorf("missing folder: %v", err)
	}
}

// A file still open in the worktree after its groups closed: the remove
// answers in_use and deletes nothing (not even with force), so git still has the checkout and a
// later remove takes it.
func TestGitWorktreeMuxRemoveInUse(t *testing.T) {
	origWait := worktreeFreeWait
	worktreeFreeWait = 300 * time.Millisecond
	t.Cleanup(func() { worktreeFreeWait = origWait })
	x := newGitWorktreeFixture(t, true)
	if status, code, _ := x.do(t, "POST", "/api/mux/worktrees", `{"groupId":"$main","branch":"feat/held"}`); status != 200 {
		t.Fatalf("create = %d %s", status, code)
	}
	path := filepath.Join(x.base, "feat-held")
	x.f.took()
	f, err := os.Create(filepath.Join(path, "held.txt"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	body := fmt.Sprintf(`{"force":true,"path":%q,"branch":"feat/held"}`, path)
	if status, code, _ := x.do(t, "DELETE", "/api/mux/worktrees/$1", body); status != 409 || code != "in_use" {
		t.Errorf("held file = %d %s", status, code)
	}
	if calls := x.f.took(); !slices.Equal(calls, []string{"close $1"}) {
		t.Errorf("calls %q", calls)
	}
	if _, err := os.Stat(filepath.Join(path, ".git")); err != nil {
		t.Errorf("checkout changed: %v", err)
	}
	f.Close()
	x.f.add("$again", path)
	if status, code, _ := x.do(t, "DELETE", "/api/mux/worktrees/$again", body); status != 200 {
		t.Fatalf("remove once free = %d %s", status, code)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("checkout left: %v", err)
	}
}

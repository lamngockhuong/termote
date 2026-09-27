package main

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestLogsTailAndClean(t *testing.T) {
	tc := newTestCLI(t, "linux")
	var lines []string
	for i := 1; i <= 60; i++ {
		lines = append(lines, "line "+strconv.Itoa(i))
	}
	writeFile(t, filepath.Join(tc.logDir(), "termote.log"), strings.Join(lines, "\n")+"\n")
	writeFile(t, filepath.Join(tc.logDir(), "other.log"), "other service\n")

	if code := tc.main([]string{"logs", "server", "3"}); code != 0 {
		t.Fatal(tc.stderr.String())
	}
	out := tc.stdout.String()
	if !strings.Contains(out, "line 58\nline 59\nline 60") || strings.Contains(out, "line 57") || strings.Contains(out, "other service") {
		t.Fatalf("tail output:\n%s", out)
	}
	tc.stdout.Reset()
	tc.main([]string{"logs", "clean"})
	if files := tc.logFiles("*.log"); len(files) != 0 {
		t.Fatalf("logs left after clean: %v", files)
	}
	if code := tc.main([]string{"logs", "bogus"}); code != 2 {
		t.Fatalf("unknown service code %d", code)
	}
}

// syncBuffer is a goroutine-safe writer for followLogs output.
type syncBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func TestFollowLogsPrintsAppendedLines(t *testing.T) {
	tc := newTestCLI(t, "linux")
	out := &syncBuffer{}
	tc.out = out
	log := filepath.Join(tc.logDir(), "termote.log")
	writeFile(t, log, "first\n")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { tc.followLogs(ctx, 10, 10*time.Millisecond); close(done) }()

	waitFor(t, func() bool { return strings.Contains(out.String(), "[termote] first") })
	f, _ := os.OpenFile(log, os.O_APPEND|os.O_WRONLY, 0o644)
	f.WriteString("second\nthi")
	f.Close()
	waitFor(t, func() bool { return strings.Contains(out.String(), "[termote] second") })
	if strings.Contains(out.String(), "thi") {
		t.Fatal("partial line printed before its newline")
	}
	f, _ = os.OpenFile(log, os.O_APPEND|os.O_WRONLY, 0o644)
	f.WriteString("rd\n")
	f.Close()
	waitFor(t, func() bool { return strings.Contains(out.String(), "[termote] third") })
	// A new log file is picked up too.
	writeFile(t, filepath.Join(tc.logDir(), "other.log"), "hello\n")
	waitFor(t, func() bool { return strings.Contains(out.String(), "[other] hello") })
	cancel()
	<-done
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestLinkAndUnlinkUnix(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	tc := newTestCLI(t, "linux")
	old := systemLinkPath
	systemLinkPath = filepath.Join(t.TempDir(), "bin", "termote")
	t.Cleanup(func() { systemLinkPath = old })

	if code := tc.main([]string{"link"}); code != 0 {
		t.Fatal(tc.stderr.String())
	}
	if target, err := os.Readlink(systemLinkPath); err != nil || target != tc.shimPath() {
		t.Fatalf("link -> %q, %v", target, err)
	}
	tc.stdout.Reset()
	tc.main([]string{"link"})
	if out := tc.stdout.String(); !strings.Contains(out, "Already linked") || strings.Contains(out, "Created symlink") {
		t.Fatalf("relink output %q", tc.stdout.String())
	}

	// A regular file in the way is never replaced; ~/.local/bin is used.
	os.Remove(systemLinkPath)
	writeFile(t, systemLinkPath, "user file")
	tc.main([]string{"link"})
	if b, _ := os.ReadFile(systemLinkPath); string(b) != "user file" {
		t.Fatal("regular file overwritten")
	}
	userLink := filepath.Join(tc.userBinDir(), "termote")
	if target, _ := os.Readlink(userLink); target != tc.shimPath() {
		t.Fatalf("fallback link -> %q", target)
	}

	tc.main([]string{"unlink"})
	if _, err := os.Lstat(userLink); err == nil {
		t.Fatal("symlink not removed")
	}
	if b, _ := os.ReadFile(systemLinkPath); string(b) != "user file" {
		t.Fatal("unlink removed a file that is not ours")
	}
}

func TestLinkWindowsWritesCmd(t *testing.T) {
	tc := newTestCLI(t, "windows")
	cmdFile := tc.windowsLinkFile()
	if code := tc.main([]string{"link"}); code != 0 {
		t.Fatal(tc.stderr.String())
	}
	b, err := os.ReadFile(cmdFile)
	if err != nil || !strings.Contains(string(b), `-File "`+tc.shimPath()+`" %*`) {
		t.Fatalf("cmd wrapper %q %v", b, err)
	}
	tc.main([]string{"unlink"})
	if fileExists(cmdFile) {
		t.Fatal("termote.cmd not removed")
	}
}

func TestHealth(t *testing.T) {
	tc := newTestCLI(t, "linux")
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv.Listener = ln
	srv.Start()
	defer srv.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	tc.saveConfig(savedConfig{Mode: "native", Port: port, Mux: "herdr", Password: "p"})

	if code := tc.main([]string{"health"}); code != 0 {
		t.Fatalf("code %d\n%s", code, tc.stdout.String())
	}
	out := tc.stdout.String()
	if !strings.Contains(out, "running (auth)") || !strings.Contains(out, "Backend: herdr") {
		t.Fatalf("health output:\n%s", out)
	}
	srv.Close()
	tc.stdout.Reset()
	if code := tc.main([]string{"health"}); code != 1 || !strings.Contains(tc.stdout.String(), "not running") {
		t.Fatalf("stopped server: code %d\n%s", code, tc.stdout.String())
	}
}

func TestMenu(t *testing.T) {
	tc := newTestCLI(t, "linux")
	if code := tc.main([]string{"menu"}); code != 2 {
		t.Fatalf("non-interactive menu code %d", code)
	}
	tc.interactive = true
	tc.saveConfig(savedConfig{Mode: "native", Password: "From-Menu"})
	tc.in = bufio.NewReader(strings.NewReader("x\n9\n7\n"))
	tc.stdout.Reset()
	if code := tc.main([]string{"menu"}); code != 0 || !strings.Contains(tc.stdout.String(), "Password: From-Menu") {
		t.Fatalf("code %d\n%s", code, tc.stdout.String())
	}
}

func TestMenuInstallBuildsFreshInstall(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.interactive = true
	// native, herdr, LAN yes, no-auth yes, confirm herdr no-auth, Tailscale no
	tc.in = bufio.NewReader(strings.NewReader("1\n1\n2\ny\ny\ny\nn\n"))
	tc.procs = func() ([]procInfo, error) { t.Fatal("services stopped before preflight"); return nil, nil }
	tc.main([]string{"menu"})
	// herdr is missing from PATH, so install stops in preflight, which runs
	// only once the herdr + no-auth combination passed validation.
	if !strings.Contains(tc.stderr.String(), "herdr not found") {
		t.Fatalf("stderr %q\nstdout %s", tc.stderr.String(), tc.stdout.String())
	}
}

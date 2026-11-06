//go:build !windows

package main

import (
	"bufio"
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// helperSSHMaster stands in for `ssh -M`: it listens on the control socket
// until it is killed.
func helperSSHMaster() {
	ln, err := net.Listen("unix", os.Getenv("TEST_SSH_CTL"))
	if err != nil {
		os.Exit(1)
	}
	for {
		c, err := ln.Accept()
		if err != nil {
			os.Exit(0)
		}
		c.Close()
	}
}

// fakeSSH replaces startSSH: a master is helperSSHMaster (or masterScript
// when set), -O exit succeeds, and a bridge greets and echoes. It records
// every argv.
type fakeSSH struct {
	mu           sync.Mutex
	argvs        [][]string
	masterScript string
}

func (f *fakeSSH) install(t *testing.T) {
	old := startSSH
	t.Cleanup(func() { startSSH = old })
	startSSH = func(argv []string) (*sshProc, error) {
		f.mu.Lock()
		f.argvs = append(f.argvs, argv)
		script := f.masterScript
		f.mu.Unlock()
		switch {
		case slices.Contains(argv, "-M") && script == "":
			return startHelperMaster(argv[slices.Index(argv, "-S")+1])
		case slices.Contains(argv, "-M"):
			return old(shArgv(script))
		case slices.Contains(argv, "-O"):
			return old(shArgv("exit 0"))
		}
		return old(shArgv(`printf 'TERMOTE-BRIDGE 1 x\n'; exec cat`))
	}
}

func (f *fakeSSH) count(flag string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, a := range f.argvs {
		if slices.Contains(a, flag) {
			n++
		}
	}
	return n
}

// startHelperMaster runs the test binary as a master on ctl, in an sshProc.
func startHelperMaster(ctl string) (*sshProc, error) {
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), helperEnv+"=ssh-master", "TEST_SSH_CTL="+ctl)
	cmd.SysProcAttr = observerSysProcAttr()
	in, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	p := &sshProc{cmd: cmd, stdin: in, stderr: &lockedCapped{}, waited: make(chan struct{})}
	p.stdout = bufio.NewReader(out)
	cmd.Stderr = p.stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go func() { cmd.Wait(); close(p.waited) }()
	return p, nil
}

// The first connection starts the master, later ones reuse it; a master
// that died is started again; forget and stop end it.
func TestSSHDialerMaster(t *testing.T) {
	f := &fakeSSH{}
	f.install(t)
	dir := filepath.Join(shortDir(t), "ssh")
	d := newSSHDialer(testSSHPaths, dir)
	m := testMachine("0123456789abcdef", "Box", "box")
	for i := 0; i < 3; i++ {
		c, _, err := d.dial(context.Background(), m)
		if err != nil {
			t.Fatalf("dial %d: %v", i, err)
		}
		c.Close()
	}
	if n := f.count("-M"); n != 1 {
		t.Errorf("%d masters started for 3 connections", n)
	}
	ctl := filepath.Join(dir, m.ID)
	if fi, err := os.Stat(dir); err != nil || fi.Mode().Perm() != 0o700 {
		t.Errorf("control dir: %v %v", fi, err)
	}
	d.mu.Lock()
	p := d.masters[m.ID]
	d.mu.Unlock()
	p.stop()
	c, _, err := d.dial(context.Background(), m)
	if err != nil {
		t.Fatalf("dial after the master died: %v", err)
	}
	c.Close()
	if n := f.count("-M"); n != 2 {
		t.Errorf("a dead master was not started again (%d)", n)
	}
	// A socket left at ctl (an earlier server's master) is asked to exit.
	exits := f.count("-O")
	d.forget(m.ID)
	os.WriteFile(ctl, nil, 0o600)
	if c, _, err := d.dial(context.Background(), m); err != nil {
		t.Fatalf("dial over a stale control path: %v", err)
	} else {
		c.Close()
	}
	if f.count("-O") != exits+1 {
		t.Error("the stale master was not asked to exit")
	}
	d.idle(m.ID)
	d.mu.Lock()
	n := len(d.masters)
	d.mu.Unlock()
	if n != 0 {
		t.Error("idle left the master running")
	}
	d.dial(context.Background(), m)
	d.stop()
	if len(d.masters) != 0 {
		t.Error("stop left a master")
	}
}

// A master that cannot connect names why; one that never opens its socket
// times out.
func TestSSHDialerMasterFailures(t *testing.T) {
	f := &fakeSSH{masterScript: `echo 'Permission denied (publickey).' >&2; exit 255`}
	f.install(t)
	d := newSSHDialer(testSSHPaths, filepath.Join(shortDir(t), "ssh"))
	m := testMachine("0123456789abcdef", "Box", "box")
	if _, stderr, err := d.dial(context.Background(), m); !errors.Is(err, errMachineUnauthorized) || !strings.Contains(stderr, "Permission denied") {
		t.Errorf("unauthorized master: %v %q", err, stderr)
	}
	old := masterWait
	masterWait = 100 * time.Millisecond
	t.Cleanup(func() { masterWait = old })
	f.masterScript = "exec sleep 30"
	if _, _, err := d.dial(context.Background(), m); !errors.Is(err, errMachineOffline) {
		t.Errorf("silent master: %v", err)
	}
	masterWait = 10 * time.Second
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()
	if _, _, err := d.dial(ctx, m); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled master: %v", err)
	}
}

// Without a control dir short enough, the fallback in the temp dir is used,
// else no multiplexing at all.
func TestSSHDialerControlPath(t *testing.T) {
	file := filepath.Join(shortDir(t), "f")
	os.WriteFile(file, nil, 0o600)
	d := &sshDialer{ctlDir: filepath.Join(shortDir(t), "ssh")}
	if p := d.controlPath("0123456789abcdef"); !strings.HasPrefix(p, d.ctlDir) || len(p) > maxControlPath {
		t.Errorf("control path %q", p)
	}
	d.ctlDir = "/" + strings.Repeat("d", 90)
	if p := d.controlPath("0123456789abcdef"); p != "" && !strings.HasPrefix(p, os.TempDir()) {
		t.Errorf("fallback control path %q", p)
	}
	t.Setenv("TMPDIR", "/"+strings.Repeat("t", 90))
	if p := d.controlPath("0123456789abcdef"); p != "" {
		t.Errorf("no short dir, still %q", p)
	}
	d.ctlDir = ""
	if d.controlPath("x") != "" {
		t.Error("no control dir gave a path")
	}
	t.Setenv("TMPDIR", file)
	d.ctlDir = filepath.Join(file, "ssh")
	if p := d.controlPath("0123456789abcdef"); p != "" {
		t.Errorf("unusable dirs gave %q", p)
	}
}

func TestIsMachineSSHCmdline(t *testing.T) {
	if !isMachineSSHCmdline("ssh -M -N -S /x -o HostKeyAlias=termote-0123 -- box") || isMachineSSHCmdline("ssh box") || isMachineSSHCmdline("vim HostKeyAlias=termote-") {
		t.Error("isMachineSSHCmdline")
	}
}

//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

// ptyStream runs a process on a Unix PTY.
//
// pty.Start puts the child in a new session (Setsid), so it already leads its
// own process group; Setpgid on top would make the fork fail with EPERM. The
// group is killed through -pid.
type ptyStream struct {
	f         *os.File
	cmd       *exec.Cmd
	done      chan struct{}
	code      int
	closeOnce sync.Once
}

// startTerminal starts argv on a new PTY of the given size.
func startTerminal(argv []string, size Size) (TermStream, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = terminalEnv()
	f, err := pty.StartWithAttrs(cmd, winsize(size), terminalSysProcAttr())
	if err != nil {
		return nil, err
	}
	s := &ptyStream{f: f, cmd: cmd, done: make(chan struct{})}
	go func() {
		err := cmd.Wait()
		var ee *exec.ExitError
		switch {
		case err == nil:
		case errors.As(err, &ee):
			s.code = ee.ExitCode()
		default:
			s.code = -1
		}
		close(s.done)
	}()
	return s, nil
}

func winsize(s Size) *pty.Winsize {
	return &pty.Winsize{Cols: uint16(s.Cols), Rows: uint16(s.Rows)}
}

func (s *ptyStream) Read(p []byte) (int, error)  { return s.f.Read(p) }
func (s *ptyStream) Write(p []byte) (int, error) { return s.f.Write(p) }
func (s *ptyStream) Resize(sz Size) error        { return pty.Setsize(s.f, winsize(sz)) }
func (s *ptyStream) Done() <-chan struct{}       { return s.done }
func (s *ptyStream) ExitCode() int               { return s.code }

// Close hangs up the terminal (SIGHUP, as when a terminal window closes), then kills the
// process group if it has not exited within processKillWait.
func (s *ptyStream) Close() error {
	s.closeOnce.Do(func() {
		pid := s.cmd.Process.Pid
		select {
		case <-s.done:
			// Already reaped: the pid may belong to someone else by now.
		default:
			syscall.Kill(-pid, syscall.SIGHUP)
		}
		s.f.Close()
		select {
		case <-s.done:
		case <-time.After(processKillWait):
			syscall.Kill(-pid, syscall.SIGKILL)
			<-s.done
		}
		// Background children left in the group. The kernel does not reuse a
		// pid while it still names a live process group, so this reaches
		// only those children.
		syscall.Kill(-pid, syscall.SIGKILL)
	})
	return nil
}

// terminalEnv is the server environment with TERM set for xterm.js, TMUX
// removed so `tmux attach` works when the server itself runs inside tmux, and
// no secrets.
func terminalEnv() []string {
	env := []string{"TERM=xterm-256color"}
	for _, kv := range os.Environ() {
		if hasEnvKey(kv, "TERM") || hasEnvKey(kv, "TMUX") || hasEnvKey(kv, "TMUX_PANE") || isSecretEnv(kv) {
			continue
		}
		env = append(env, kv)
	}
	return env
}

func hasEnvKey(kv, key string) bool {
	return len(kv) > len(key) && kv[len(key)] == '=' && kv[:len(key)] == key
}

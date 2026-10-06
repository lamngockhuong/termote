//go:build !windows

package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

func isTerminal(f *os.File) bool {
	_, err := unix.IoctlGetTermios(int(f.Fd()), ioctlGetTermios)
	return err == nil
}

func enableTerminalColor() bool { return true }

// readPasswordNoEcho reads one line from r with echo turned off on f.
func readPasswordNoEcho(f *os.File, r *bufio.Reader) (string, error) {
	fd := int(f.Fd())
	old, err := unix.IoctlGetTermios(fd, ioctlGetTermios)
	if err != nil {
		return "", err
	}
	noEcho := *old
	noEcho.Lflag &^= unix.ECHO
	noEcho.Lflag |= unix.ICANON | unix.ISIG
	if err := unix.IoctlSetTermios(fd, ioctlSetTermios, &noEcho); err != nil {
		return "", err
	}
	defer unix.IoctlSetTermios(fd, ioctlSetTermios, old)
	line, err := r.ReadString('\n')
	fmt.Println()
	if err != nil && line == "" {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

// listProcesses reads /proc where it exists (Linux) and `ps` elsewhere.
func listProcesses() ([]procInfo, error) {
	if isDir("/proc/self") {
		return listProcFS()
	}
	out, err := exec.Command("ps", "-axo", "pid=,command=").Output()
	if err != nil {
		return nil, err
	}
	return parsePS(string(out)), nil
}

func listProcFS() ([]procInfo, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	var out []procInfo
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		raw, err := os.ReadFile(filepath.Join("/proc", e.Name(), "cmdline"))
		if err != nil || len(raw) == 0 {
			continue
		}
		args := strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00")
		exe, _ := os.Readlink(filepath.Join("/proc", e.Name(), "exe"))
		out = append(out, procInfo{PID: pid, Cmdline: strings.Join(args, " "), Exe: strings.TrimSuffix(exe, " (deleted)")})
	}
	return out, nil
}

// parsePS parses `ps -axo pid=,command=` output.
func parsePS(s string) []procInfo {
	var out []procInfo
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		pidStr, cmd, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		pid, err := strconv.Atoi(pidStr)
		if err != nil {
			continue
		}
		out = append(out, procInfo{PID: pid, Cmdline: strings.TrimSpace(cmd)})
	}
	return out
}

// terminateProcess sends SIGTERM, then SIGKILL if the process is still alive
// after wait.
func terminateProcess(pid int, wait time.Duration) error {
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return err
	}
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		if syscall.Kill(pid, 0) != nil {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	return nil
}

// startDetached starts bin in its own session, so it outlives the CLI and
// the terminal that ran it, with stdout and stderr appended to logPath.
// The returned channel closes if the process exits while the CLI still runs.
func startDetached(bin string, args []string, dir string, env []string, logPath string) (int, <-chan struct{}, error) {
	logf, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return 0, nil, err
	}
	defer logf.Close()
	cmd := exec.Command(bin, args...)
	cmd.Dir = dir
	cmd.Env = env
	cmd.Stdout, cmd.Stderr = logf, logf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return 0, nil, err
	}
	exited := make(chan struct{})
	go func() { cmd.Wait(); close(exited) }()
	return cmd.Process.Pid, exited, nil
}

// startHiddenPowerShell is Windows only: elsewhere a running binary can be
// deleted, so uninstall never needs to remove anything late.
func startHiddenPowerShell(string) error {
	return errors.New("only available on Windows")
}

func protectCurrentUser([]byte) ([]byte, error) {
	return nil, errors.New("DPAPI is only available on Windows")
}

func unprotectCurrentUser([]byte) ([]byte, error) {
	return nil, errors.New("DPAPI is only available on Windows")
}

func restrictToOwner(string) error { return nil }

// hideConsole is for the Windows Scheduled Task; Unix has no window.
func hideConsole() {}

// readKeyRaw reads one byte from the terminal with line buffering and echo
// off, so a key acts without Enter; Ctrl-C arrives as byte 3.
func readKeyRaw(f *os.File) (byte, error) {
	fd := int(f.Fd())
	old, err := unix.IoctlGetTermios(fd, ioctlGetTermios)
	if err != nil {
		return 0, err
	}
	raw := *old
	raw.Lflag &^= unix.ECHO | unix.ICANON | unix.ISIG
	raw.Cc[unix.VMIN], raw.Cc[unix.VTIME] = 1, 0
	if err := unix.IoctlSetTermios(fd, ioctlSetTermios, &raw); err != nil {
		return 0, err
	}
	defer unix.IoctlSetTermios(fd, ioctlSetTermios, old)
	var b [1]byte
	if _, err := f.Read(b[:]); err != nil {
		return 0, err
	}
	return b[0], nil
}

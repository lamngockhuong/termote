package main

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const agentProcSupported = true

// codexProcSupported: a Codex pane is looked up as on Linux, its rollout
// found in the system handle table (procWriteFiles). Every step fails
// closed: a Codex run elevated or by another user cannot be opened, an
// unreadable command line or a rollout off a drive letter is no Codex, and
// CODEX_HOME is the server user's %USERPROFILE%\.codex only (procCodexHome).
const codexProcSupported = true

// procCmdLineMax caps the command line read: 32767 UTF-16 characters plus
// the UNICODE_STRING header.
const procCmdLineMax = 1 << 17

// procExeBase is the lower-case base name of pid's executable, without .exe.
func procExeBase(pid int) string {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n := uint32(len(buf))
	if windows.QueryFullProcessImageName(h, 0, &buf[0], &n) != nil {
		return ""
	}
	base := strings.ToLower(filepath.Base(windows.UTF16ToString(buf[:n])))
	return strings.TrimSuffix(base, ".exe")
}

// procArgs is pid's command line split as the C runtime splits it, read with
// NtQueryInformationProcess (ProcessCommandLineInformation, Windows 8.1+;
// only PROCESS_QUERY_LIMITED_INFORMATION, no memory read). nil on any error.
func procArgs(pid int) []string {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(h)
	const word = uint32(unsafe.Sizeof(uintptr(0)))
	for n := uint32(1024); n <= procCmdLineMax; {
		// []uintptr keeps the UNICODE_STRING header aligned; the length
		// passed is the buffer's own, n rounded up to whole words.
		buf := make([]uintptr, (n+word-1)/word)
		var ret uint32
		err := windows.NtQueryInformationProcess(h, windows.ProcessCommandLineInformation,
			unsafe.Pointer(&buf[0]), uint32(len(buf))*word, &ret)
		if errors.Is(err, windows.STATUS_INFO_LENGTH_MISMATCH) || errors.Is(err, windows.STATUS_BUFFER_TOO_SMALL) ||
			errors.Is(err, windows.STATUS_BUFFER_OVERFLOW) {
			n = max(n*2, ret)
			continue
		}
		if err != nil {
			return nil
		}
		line := (*windows.NTUnicodeString)(unsafe.Pointer(&buf[0])).String()
		args, err := windows.DecomposeCommandLine(line)
		if err != nil {
			return nil
		}
		return args
	}
	return nil
}

// procCodexHome is %USERPROFILE%\.codex of the user running the server, as
// procClaudeDir: another process's environment lives in its PEB, which is
// not read here, so a CODEX_HOME set only inside the pane gives no Chat view.
func procCodexHome(int) (string, bool) {
	home, err := os.UserHomeDir()
	if err != nil || !filepath.IsAbs(home) {
		return "", false
	}
	return filepath.Join(home, ".codex"), true
}

// toolhelpProcesses calls fn with the pid and parent pid of every process,
// from one Toolhelp32 snapshot.
func toolhelpProcesses(fn func(pid, ppid int)) error {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		fn(int(e.ProcessID), int(e.ParentProcessID))
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return err
	}
	return nil
}

// procAllPIDs lists every process.
func procAllPIDs() []int {
	var pids []int
	if toolhelpProcesses(func(pid, _ int) { pids = append(pids, pid) }) != nil {
		return nil
	}
	return pids
}

// procChildrenFunc takes one Toolhelp32 snapshot of every process.
func procChildrenFunc() (func(int) []int, error) {
	byParent := map[int][]int{}
	if err := toolhelpProcesses(func(pid, ppid int) { byParent[ppid] = append(byParent[ppid], pid) }); err != nil {
		return nil, err
	}
	return func(pid int) []int { return byParent[pid] }, nil
}

// procStartTime is the process creation time from GetProcessTimes, as the
// decimal FILETIME Claude Code records as procStartFt on Windows.
func procStartTime(pid int) (string, bool) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return "", false
	}
	defer windows.CloseHandle(h)
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &created, &exited, &kernel, &user); err != nil {
		return "", false
	}
	return strconv.FormatUint(uint64(created.HighDateTime)<<32|uint64(created.LowDateTime), 10), true
}

// procClaudeDir is %USERPROFILE%\.claude of the user running the server:
// another process's environment lives in its PEB, which is not read here, so
// a CLAUDE_CONFIG_DIR set only inside the pane is not followed.
func procClaudeDir(int) (string, bool) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", false
	}
	return filepath.Join(home, ".claude"), true
}

// claudePIDDomain is empty: the start time alone identifies the process.
func claudePIDDomain() string { return "" }

// fileIdentity is empty on Windows; a cursor then relies on the session id,
// the file name, the size and the line boundary check.
func fileIdentity(os.FileInfo) string { return "" }

// procForeground is true: a ConPTY has no job control to suspend Claude Code.
func procForeground(int) bool { return true }

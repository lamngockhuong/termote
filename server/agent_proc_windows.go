package main

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"unsafe"

	"golang.org/x/sys/windows"
)

const agentProcSupported = true

// procChildrenFunc takes one Toolhelp32 snapshot of every process.
func procChildrenFunc() (func(int) []int, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snap)
	byParent := map[int][]int{}
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		byParent[int(e.ParentProcessID)] = append(byParent[int(e.ParentProcessID)], int(e.ProcessID))
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
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
// the size and the line boundary check.
func fileIdentity(os.FileInfo) string { return "" }

// procForeground is true: a ConPTY has no job control to suspend Claude Code.
func procForeground(int) bool { return true }

package main

import (
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// procEnvMax caps the environment block read from another process.
const procEnvMax = 1 << 20

// processBasicInfo is PROCESS_BASIC_INFORMATION with every field a uintptr:
// the PEB address belongs to another process and must never be held as a Go
// pointer (NTSTATUS and the priority are padded to a word on 64-bit).
type processBasicInfo struct {
	exitStatus, pebBase, affinity, basePriority, uniqueID, parentID uintptr
}

// procReadWord reads one pointer-sized word at addr in the process h.
func procReadWord(h windows.Handle, addr uintptr) (uintptr, bool) {
	var w uintptr
	err := windows.ReadProcessMemory(h, addr, (*byte)(unsafe.Pointer(&w)), unsafe.Sizeof(w), nil)
	return w, err == nil
}

// procEnv is pid's environment block, read from its PEB
// (ProcessParameters.Environment and EnvironmentSize, Windows 8+). Only a
// process of the server user that is not elevated can be opened for
// reading; nil, false on any error.
func procEnv(pid int) ([]string, bool) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_INFORMATION|windows.PROCESS_VM_READ, false, uint32(pid))
	if err != nil {
		return nil, false
	}
	defer windows.CloseHandle(h)
	var pbi processBasicInfo
	if windows.NtQueryInformationProcess(h, windows.ProcessBasicInformation,
		unsafe.Pointer(&pbi), uint32(unsafe.Sizeof(pbi)), nil) != nil || pbi.pebBase == 0 {
		return nil, false
	}
	var peb windows.PEB
	var params windows.RTL_USER_PROCESS_PARAMETERS
	pp, ok := procReadWord(h, pbi.pebBase+unsafe.Offsetof(peb.ProcessParameters))
	if !ok || pp == 0 {
		return nil, false
	}
	envAddr, ok1 := procReadWord(h, pp+unsafe.Offsetof(params.Environment))
	size, ok2 := procReadWord(h, pp+unsafe.Offsetof(params.EnvironmentSize))
	if !ok1 || !ok2 || envAddr == 0 || size < 4 || size > procEnvMax {
		return nil, false
	}
	buf := make([]uint16, size/2)
	if windows.ReadProcessMemory(h, envAddr, (*byte)(unsafe.Pointer(&buf[0])), uintptr(len(buf))*2, nil) != nil {
		return nil, false
	}
	// NUL-separated entries, ended by an empty one.
	var env []string
	for len(buf) > 0 {
		i := 0
		for i < len(buf) && buf[i] != 0 {
			i++
		}
		if i == 0 {
			break
		}
		env = append(env, windows.UTF16ToString(buf[:i]))
		buf = buf[min(i+1, len(buf)):]
	}
	return env, true
}

// procEnvValue is the value of name in pid's environment, the name compared
// without case as Windows does; "" when unset or unreadable.
func procEnvValue(pid int, name string) string {
	env, _ := procEnv(pid)
	for _, kv := range env {
		// Entries such as "=C:=C:\dir" start with '=': skip the first byte.
		if i := strings.IndexByte(kv[min(1, len(kv)):], '='); i >= 0 && strings.EqualFold(kv[:i+1], name) {
			return kv[i+2:]
		}
	}
	return ""
}

// procConfigDir is the folder pid names in env (CLAUDE_CONFIG_DIR,
// CODEX_HOME), else %USERPROFILE%\<dflt> of the user running the server: a
// process whose environment cannot be read (elevated, another user) is
// looked up there as before. A value must be a path on a drive letter: a
// relative one would resolve against the server's cwd, and a UNC or device
// path would make the server open a share or a device.
func procConfigDir(pid int, env, dflt string) (string, bool) {
	if v := procEnvValue(pid, env); v != "" {
		return v, filepath.IsAbs(v) && len(filepath.VolumeName(v)) == 2
	}
	home, err := os.UserHomeDir()
	if err != nil || !filepath.IsAbs(home) {
		return "", false
	}
	return filepath.Join(home, dflt), true
}

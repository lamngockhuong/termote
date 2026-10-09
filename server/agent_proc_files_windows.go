package main

import (
	"log"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sys/windows"
)

// procFilesTimeout bounds one process's file listing: GetFileType can block
// on an exotic handle (a network redirector), and a blocked call cannot be
// cancelled.
const procFilesTimeout = 2 * time.Second

// procFilesStuck counts listings past procFilesTimeout that have not
// returned; while one is stuck no other starts.
var procFilesStuck atomic.Int32

// procFilesStuckOnce logs the first stuck listing of a run.
var procFilesStuckOnce sync.Once

// GetFinalPathNameByHandle flags: normalized name, with a drive letter.
const (
	fileNameNormalized = 0x0
	volumeNameDOS      = 0x0
)

// procWriteFiles lists the disk files pid holds open for writing or
// appending whose name passes match, each with its identity. Only handles of
// a process of this user can be duplicated (an elevated or another user's
// process is skipped); the duplicates are only inspected, never read or
// written, and always closed. Any failure lists nothing.
func procWriteFiles(pid int, match func(name string) bool) []procFile {
	if pid <= 0 || procFilesStuck.Load() > 0 {
		return nil
	}
	table, err := writeHandles.do("", queryWriteHandles)
	if err != nil || len(table[pid]) == 0 {
		return nil
	}
	refs := table[pid]
	// 0 running, 1 returned in time, 2 given up on.
	var state atomic.Int32
	done := make(chan []procFile, 1)
	go func() {
		out := dupWriteFiles(pid, refs, match)
		if !state.CompareAndSwap(0, 1) {
			procFilesStuck.Add(-1)
		}
		done <- out
	}()
	timer := time.NewTimer(procFilesTimeout)
	defer timer.Stop()
	select {
	case out := <-done:
		return out
	case <-timer.C:
		if state.CompareAndSwap(0, 2) {
			procFilesStuck.Add(1)
			procFilesStuckOnce.Do(func() {
				log.Printf("agent: listing the files of process %d took over %v; no Codex Chat view until it returns", pid, procFilesTimeout)
			})
			return nil
		}
		return <-done
	}
}

// dupWriteFiles duplicates each handle of pid into this process with only
// FILE_READ_ATTRIBUTES and keeps the disk files on a drive. The cached table
// can be a second old: a handle closed since and its value reused for a file
// opened read only would pass for a writer. So the ones kept must still allow
// writing in a table read after they were duplicated (the kernel hides the
// object addresses that would tie the two; the same window as /proc's link
// read before its fdinfo).
func dupWriteFiles(pid int, refs []handleRef, match func(string) bool) []procFile {
	proc, err := windows.OpenProcess(windows.PROCESS_DUP_HANDLE, false, uint32(pid))
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(proc)
	self := windows.CurrentProcess()
	var found []procFile
	var values []uintptr
	var held []windows.Handle
	defer func() {
		for _, h := range held {
			windows.CloseHandle(h)
		}
	}()
	for _, r := range refs {
		var h windows.Handle
		if windows.DuplicateHandle(proc, windows.Handle(r.value), self, &h, windows.FILE_READ_ATTRIBUTES, false, 0) != nil {
			continue
		}
		held = append(held, h)
		if f, ok := diskFileOf(h, match); ok {
			found, values = append(found, f), append(values, r.value)
		}
	}
	if len(found) == 0 {
		return nil
	}
	live, err := queryWriteHandles()
	if err != nil {
		return nil
	}
	var out []procFile
	for i, f := range found {
		if slices.ContainsFunc(live[pid], func(r handleRef) bool { return r.value == values[i] }) {
			out = append(out, f)
		}
	}
	return out
}

// diskFileOf reads the path and identity of a duplicated handle. Only a disk
// file gets its name read: that is what can hang on a pipe.
func diskFileOf(h windows.Handle, match func(string) bool) (procFile, bool) {
	if t, err := windows.GetFileType(h); err != nil || t != windows.FILE_TYPE_DISK {
		return procFile{}, false
	}
	path, ok := finalDrivePath(h)
	if !ok || !match(filepath.Base(path)) {
		return procFile{}, false
	}
	// Without an identity the later checks that the path still names this
	// file would be skipped: such a file is not listed.
	id := handleIdentity(h)
	return procFile{path: path, id: id}, id != ""
}

// finalDrivePath is the handle's file path on a drive letter (X:\...).
func finalDrivePath(h windows.Handle) (string, bool) {
	buf := make([]uint16, windows.MAX_PATH)
	for {
		n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), fileNameNormalized|volumeNameDOS)
		if err != nil {
			return "", false
		}
		if int(n) < len(buf) {
			return winDrivePath(windows.UTF16ToString(buf[:n]))
		}
		if int(n) > windows.MAX_LONG_PATH {
			return "", false
		}
		buf = make([]uint16, n+1)
	}
}

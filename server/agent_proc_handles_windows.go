package main

import (
	"errors"
	"log"
	"os"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The files a process holds open on Windows come from the system handle
// table (NtQuerySystemInformation, SystemExtendedHandleInformation): the one
// list that tells, per handle, the process, the object type and the access
// granted. One query serves every process (about 70 ms, 8 MiB on a desktop),
// so it is cached for a second and filtered down to the file handles that
// allow writing or appending (a 16 MiB buffer to start). Never NtQueryObject: it can hang on a pipe.

// sysHandleEntry is SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX (40 bytes on 64-bit).
type sysHandleEntry struct {
	Object                uintptr
	UniqueProcessID       uintptr
	HandleValue           uintptr
	GrantedAccess         uint32
	CreatorBackTraceIndex uint16
	ObjectTypeIndex       uint16
	HandleAttributes      uint32
	Reserved              uint32
}

// handleRef is a handle another process holds, and the access it grants.
type handleRef struct {
	value  uintptr
	access uint32
}

const (
	handleTableMin = 16 << 20
	handleTableMax = 256 << 20
	// Codex opens its rollout append-only: FILE_APPEND_DATA without
	// FILE_WRITE_DATA.
	fileWriteAccess = windows.FILE_WRITE_DATA | windows.FILE_APPEND_DATA
)

// handleTableSize is the buffer size the last query needed.
var handleTableSize = struct {
	sync.Mutex
	n int
}{n: handleTableMin}

// walkHandleTable calls fn for every handle open on the system.
func walkHandleTable(fn func(e *sysHandleEntry)) error {
	handleTableSize.Lock()
	n := handleTableSize.n
	handleTableSize.Unlock()
	for {
		// []uintptr keeps the buffer aligned for the entries; the length
		// passed is the buffer's own.
		word := int(unsafe.Sizeof(uintptr(0)))
		buf := make([]uintptr, (n+word-1)/word)
		n = len(buf) * word
		var ret uint32
		err := windows.NtQuerySystemInformation(int32(windows.SystemExtendedHandleInformation),
			unsafe.Pointer(&buf[0]), uint32(n), &ret)
		if errors.Is(err, windows.STATUS_INFO_LENGTH_MISMATCH) {
			// The table grows between two calls: ask for more than reported.
			n = max(n*2, int(ret)+1<<20)
			if n > handleTableMax {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		handleTableSize.Lock()
		handleTableSize.n = n
		handleTableSize.Unlock()
		const header = 2 * unsafe.Sizeof(uintptr(0)) // NumberOfHandles, Reserved
		size := unsafe.Sizeof(sysHandleEntry{})
		count := buf[0]
		if count > (uintptr(n)-header)/size {
			return errors.New("handle table: count past the buffer")
		}
		base := unsafe.Pointer(&buf[2])
		for i := range count {
			fn((*sysHandleEntry)(unsafe.Add(base, i*size)))
		}
		return nil
	}
}

// fileType caches the ObjectTypeIndex of File objects once read; a failed
// read is tried again after fileTypeRetry (TEMP not writable for a while).
var fileType struct {
	sync.Mutex
	idx    uint16
	ok     bool
	failed time.Time
	logged bool
}

const fileTypeRetry = time.Minute

// fileTypeIndex is the ObjectTypeIndex of File objects. It differs from one
// Windows build to another, so it is read from a file this process opens.
func fileTypeIndex() (uint16, error) {
	fileType.Lock()
	defer fileType.Unlock()
	if fileType.ok {
		return fileType.idx, nil
	}
	if time.Since(fileType.failed) < fileTypeRetry {
		return 0, errors.New("handle table: file type unknown")
	}
	idx, err := readFileTypeIndex()
	if err != nil {
		fileType.failed = time.Now()
		if !fileType.logged {
			fileType.logged = true
			log.Printf("agent: cannot read the handle table, no Codex Chat view: %v", err)
		}
		return 0, err
	}
	fileType.idx, fileType.ok = idx, true
	return idx, nil
}

func readFileTypeIndex() (uint16, error) {
	f, err := os.CreateTemp("", "termote-handle-*")
	if err != nil {
		return 0, err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	self, h := uintptr(os.Getpid()), f.Fd()
	idx, found := uint16(0), false
	err = walkHandleTable(func(e *sysHandleEntry) {
		if e.UniqueProcessID == self && e.HandleValue == h {
			idx, found = e.ObjectTypeIndex, true
		}
	})
	if err == nil && !found {
		err = errors.New("handle table: own file handle not listed")
	}
	return idx, err
}

// queryWriteHandles lists, per process, the file handles that allow writing
// or appending.
func queryWriteHandles() (map[int][]handleRef, error) {
	fileType, err := fileTypeIndex()
	if err != nil {
		return nil, err // never duplicate handles of an unknown type
	}
	out := map[int][]handleRef{}
	err = walkHandleTable(func(e *sysHandleEntry) {
		if e.ObjectTypeIndex == fileType && e.GrantedAccess&fileWriteAccess != 0 {
			pid := int(e.UniqueProcessID)
			out[pid] = append(out[pid], handleRef{e.HandleValue, e.GrantedAccess})
		}
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// writeHandles caches queryWriteHandles: a snapshot looks up every pane, and
// herdr's lookup scans every process. It only picks the handles to look at:
// a handle kept is checked again in a table read after it was duplicated.
var writeHandles = newTTLCache[map[int][]handleRef](time.Second)

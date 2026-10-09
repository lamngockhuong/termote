package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
)

// readStateFile reads one of a state store's files (push, devices), refusing
// anything but a regular file (a symlink in particular).
func readStateFile(path string) ([]byte, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", filepath.Base(path))
	}
	return os.ReadFile(path)
}

// writeStateFile writes data to a new .<prefix>-<random>.part in dir (O_EXCL,
// 0600, owner-only ACL on Windows), syncs it and renames it over path, so a
// crash never leaves half a file. With strict, an ACL that cannot be set fails
// the write; otherwise it is logged, under the store's name.
func writeStateFile(store, dir, prefix, path string, data []byte, strict bool) error {
	var id [8]byte
	rand.Read(id[:])
	part := filepath.Join(dir, "."+prefix+"-"+hex.EncodeToString(id[:])+".part")
	f, err := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if err := restrictToOwner(part); err != nil {
		if strict {
			f.Close()
			os.Remove(part)
			return fmt.Errorf("restrict permissions: %w", err)
		}
		log.Printf("%s: could not restrict permissions of %s: %v", store, filepath.Base(path), err)
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(part, path)
	}
	if err != nil {
		os.Remove(part)
	}
	return err
}

// removeStateParts deletes temporary files a crash left between write and
// rename.
func removeStateParts(dir string, re *regexp.Regexp) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if re.MatchString(e.Name()) && e.Type().IsRegular() {
			os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

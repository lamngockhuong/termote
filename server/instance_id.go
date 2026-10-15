package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// instanceFile, in the state dir, holds this server's instance id: the
// snapshot's instanceId, which the PWA keys what it keeps on the device by
// (open Files and Changes tabs, unsaved drafts), so a reload never shows one
// server's tabs or drafts for another server on the same origin. It is not a
// secret; it is never logged.
const instanceFile = "instance-id"

var (
	instanceIDRe   = regexp.MustCompile(`^[0-9a-f]{16}$`)
	instancePartRe = regexp.MustCompile(`^\.instance-[0-9a-f]{16}\.part$`)
)

// loadInstanceID reads the instance id kept in dir, or makes one (16 random
// hex digits) and keeps it there (0600) when there is none or it is not one.
// It never fails: with no dir, or one it cannot write, the id lasts until
// the server stops (the PWA then restores nothing after a restart).
func loadInstanceID(dir string) string {
	id := newInstanceID()
	if dir == "" {
		return id
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Printf("instance id: %v", err)
		return id
	}
	path := filepath.Join(dir, instanceFile)
	removeStateParts(dir, instancePartRe)
	data, err := readStateFile(path)
	if err == nil {
		if s := strings.TrimSpace(string(data)); instanceIDRe.MatchString(s) {
			return s
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		log.Printf("instance id: %v", err)
		return id
	}
	if err := writeStateFile("instance id", dir, "instance", path, []byte(id+"\n"), false); err != nil {
		log.Printf("instance id: write %s: %v", instanceFile, err)
	}
	return id
}

func newInstanceID() string {
	var b [8]byte
	rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

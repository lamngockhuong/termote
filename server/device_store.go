package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// Paired devices: each holds a long-lived token in its own cookie, signs in
// without the password, and can be listed and revoked one at a time.
const (
	deviceKeyFile  = "key.json"
	devicesFile    = "devices.json"
	maxDevices     = 50
	maxDeviceName  = 64
	deviceTokenTag = "tmd_"
	// deviceCookieMaxAge is fixed: the cookie is never issued again, and a
	// device is ended by revoking it, not by time.
	deviceCookieMaxAge = 400 * 24 * time.Hour
	// deviceTouchEvery bounds how often lastUsedAt reaches the disk.
	deviceTouchEvery = 5 * time.Minute
	// deviceReloadEvery bounds how often a lookup checks the file for a
	// change another process made (a revoke).
	deviceReloadEvery = time.Second
)

var (
	errTooManyDevices = &codedError{code: "too_many_devices", msg: "too many paired devices; revoke one first", status: http.StatusConflict}
	errUnknownDevice  = &codedError{code: "unknown_device", msg: "unknown device", status: http.StatusNotFound}
	errInvalidRole    = &codedError{code: "invalid_role", msg: "role must be full or view", status: http.StatusBadRequest}
	errInvalidName    = &codedError{code: "invalid_name", msg: "invalid device name", status: http.StatusBadRequest}

	// devicePartRe matches the store's temporary files, left behind by a crash.
	devicePartRe = regexp.MustCompile(`^\.(devices|key)-[0-9a-f]{16}\.part$`)
	deviceIDRe   = regexp.MustCompile(`^[0-9a-f]{16}$`)
)

// deviceRecord is one paired device on disk. Hash is the SHA-256 of its
// token; the token itself is never stored.
type deviceRecord struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Role       role      `json:"role"`
	Hash       string    `json:"hash"`
	Gen        string    `json:"gen"`
	CreatedAt  time.Time `json:"createdAt"`
	LastUsedAt time.Time `json:"lastUsedAt"`
}

// deviceStore keeps the paired devices in <stateDir>/devices. It exists only
// with sign-in on: without it the file is neither read nor written, so turning
// sign-in off and on again with the same password keeps every device.
//
// Records of another password (gen) are ignored, never deleted: a manual
// serve with another password on the same state dir must not end every
// device for good. Every change reads the file again and applies one
// operation, so a second process never brings back what this one removed.
type deviceStore struct {
	dir     string
	bindKey []byte
	gen     string
	// cookie is the cookie's name: it carries the store's id, since a
	// cookie is not bound to a port and two servers on one host name would
	// otherwise read and clear each other's.
	cookie string
	now    func() time.Time

	mu      sync.Mutex
	recs    []deviceRecord // the file as last read or written, every gen
	touched map[string]time.Time
	flushed time.Time
	checked time.Time // last stat of the file
	modTime time.Time
	size    int64
}

// newDeviceStore opens dir (created 0700; a symlink or, on Unix, a dir another
// user owns is refused), loads or creates key.json and loads devices.json.
func newDeviceStore(dir, user, pass string) (*deviceStore, error) {
	if dir == "" {
		return nil, errors.New("no devices state dir")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if fi, err := os.Lstat(dir); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", dir)
	}
	if err := checkPrivateDir(dir); err != nil {
		return nil, err
	}
	s := &deviceStore{dir: dir, now: time.Now, touched: map[string]time.Time{}}
	removeStateParts(dir, devicePartRe)
	if err := s.loadKey(); err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, s.bindKey)
	mac.Write([]byte(user + "\x00" + pass))
	s.gen = hex.EncodeToString(mac.Sum(nil))
	id := sha256.Sum256(s.bindKey)
	s.cookie = "termote_device_" + hex.EncodeToString(id[:4])
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reloadLocked(); err != nil {
		return nil, err
	}
	s.flushed = s.now()
	return s, nil
}

// loadKey reads key.json, or creates it when missing. A file that cannot be
// read or parsed is never replaced: a new key would end every device.
func (s *deviceStore) loadKey() error {
	path := filepath.Join(s.dir, deviceKeyFile)
	data, err := readStateFile(path)
	if errors.Is(err, os.ErrNotExist) {
		key := make([]byte, 32)
		rand.Read(key)
		data, _ := json.Marshal(struct {
			BindKey string `json:"bindKey"`
		}{b64url.EncodeToString(key)})
		if err := writeStateFile("devices", s.dir, "key", path, data, true); err != nil {
			return fmt.Errorf("write %s: %w", deviceKeyFile, err)
		}
		s.bindKey = key
		return nil
	}
	if err != nil {
		return fmt.Errorf("read %s: %w", deviceKeyFile, err)
	}
	var k struct {
		BindKey string `json:"bindKey"`
	}
	if err := json.Unmarshal(data, &k); err != nil {
		return fmt.Errorf("%s is corrupt: %w", deviceKeyFile, err)
	}
	key, err := decodeB64URL(k.BindKey)
	if err != nil || len(key) != 32 {
		return fmt.Errorf("%s is corrupt", deviceKeyFile)
	}
	s.bindKey = key
	return nil
}

// readLocked reads devices.json as it is on disk; a missing file is empty.
// A corrupt one is an error: it is never overwritten (it holds every
// device), so pairing and revoking fail until it is fixed or removed.
func (s *deviceStore) readLocked() ([]deviceRecord, os.FileInfo, error) {
	path := filepath.Join(s.dir, devicesFile)
	data, err := readStateFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("read %s: %w", devicesFile, err)
	}
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, nil, err
	}
	var recs []deviceRecord
	if err := json.Unmarshal(data, &recs); err != nil {
		return nil, nil, fmt.Errorf("%s is corrupt: %w", devicesFile, err)
	}
	return recs, fi, nil
}

// reloadLocked makes the file's records the store's.
func (s *deviceStore) reloadLocked() error {
	recs, fi, err := s.readLocked()
	if err != nil {
		return err
	}
	s.recs = recs
	s.checked = s.now()
	s.modTime, s.size = time.Time{}, 0
	if fi != nil {
		s.modTime, s.size = fi.ModTime(), fi.Size()
	}
	return nil
}

// maybeReloadLocked reads the file again when it changed since it was last
// read, checking at most every deviceReloadEvery: another process revoked a
// device. A file that cannot be read keeps what is in memory.
func (s *deviceStore) maybeReloadLocked() {
	if s.now().Sub(s.checked) < deviceReloadEvery {
		return
	}
	s.checked = s.now()
	fi, err := os.Lstat(filepath.Join(s.dir, devicesFile))
	switch {
	case errors.Is(err, os.ErrNotExist):
		if s.size == 0 && s.modTime.IsZero() {
			return
		}
	case err != nil:
		return
	case fi.ModTime().Equal(s.modTime) && fi.Size() == s.size:
		return
	}
	if err := s.reloadLocked(); err != nil {
		log.Printf("devices: %v", err)
	}
}

// changeLocked reads the file again, applies op to its records and writes
// them. On any failure nothing changes, in memory or on disk.
func (s *deviceStore) changeLocked(op func([]deviceRecord) ([]deviceRecord, error)) error {
	recs, _, err := s.readLocked()
	if err != nil {
		return err
	}
	for i := range recs {
		if t, ok := s.touched[recs[i].ID]; ok && t.After(recs[i].LastUsedAt) {
			recs[i].LastUsedAt = t
		}
	}
	next, err := op(slices.Clone(recs))
	if err != nil {
		return err
	}
	data, err := json.Marshal(next)
	if err != nil {
		return err
	}
	if err := writeStateFile("devices", s.dir, "devices", filepath.Join(s.dir, devicesFile), data, true); err != nil {
		return fmt.Errorf("write %s: %w", devicesFile, err)
	}
	clear(s.touched)
	s.flushed = s.now()
	// Written: the change happened. A failed read back keeps it in memory.
	if err := s.reloadLocked(); err != nil {
		log.Printf("devices: read back: %v", err)
		s.recs = next
	}
	return nil
}

func (s *deviceStore) live(r deviceRecord) bool { return r.Gen == s.gen }

// newDeviceToken returns a token and the hash the store keeps of it.
func newDeviceToken() (token, hash string) {
	b := make([]byte, 32)
	rand.Read(b)
	token = deviceTokenTag + base64.RawURLEncoding.EncodeToString(b)
	return token, hashDeviceToken(token)
}

func hashDeviceToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// add pairs a new device and returns its token, the only time it exists in
// the clear.
func (s *deviceStore) add(name string, r role) (string, deviceRecord, error) {
	if r != roleFull && r != roleView {
		return "", deviceRecord{}, errInvalidRole
	}
	if !validDeviceName(name) {
		return "", deviceRecord{}, errInvalidName
	}
	token, hash := newDeviceToken()
	var idb [8]byte
	rand.Read(idb[:])
	now := s.now().UTC()
	rec := deviceRecord{ID: hex.EncodeToString(idb[:]), Name: name, Role: r, Hash: hash, Gen: s.gen, CreatedAt: now, LastUsedAt: now}
	s.mu.Lock()
	defer s.mu.Unlock()
	err := s.changeLocked(func(recs []deviceRecord) ([]deviceRecord, error) {
		if countFunc(recs, s.live) >= maxDevices {
			return nil, errTooManyDevices
		}
		return append(recs, rec), nil
	})
	if err != nil {
		return "", deviceRecord{}, err
	}
	return token, rec, nil
}

func countFunc[T any](s []T, f func(T) bool) int {
	n := 0
	for _, v := range s {
		if f(v) {
			n++
		}
	}
	return n
}

// revoke removes a device of the current password.
func (s *deviceStore) revoke(id string) error {
	if !deviceIDRe.MatchString(id) {
		return errUnknownDevice
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.changeLocked(func(recs []deviceRecord) ([]deviceRecord, error) {
		i := slices.IndexFunc(recs, func(r deviceRecord) bool { return r.ID == id && s.live(r) })
		if i < 0 {
			return nil, errUnknownDevice
		}
		return slices.Delete(recs, i, i+1), nil
	})
}

// pruneStale removes the records of another password from the disk: what
// `start --fresh` asks for.
func (s *deviceStore) pruneStale() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	err := s.changeLocked(func(recs []deviceRecord) ([]deviceRecord, error) {
		kept := slices.DeleteFunc(recs, func(r deviceRecord) bool { return !s.live(r) })
		n = len(recs) - len(kept)
		return kept, nil
	})
	return n, err
}

// lookup returns the live device whose token this is, and records its use.
// stale reports a token of a device of another password: it is kept, never
// to be cleared from its browser, since the password may come back.
func (s *deviceStore) lookup(token string) (rec deviceRecord, ok, stale bool) {
	if !strings.HasPrefix(token, deviceTokenTag) {
		return deviceRecord{}, false, false
	}
	hash := []byte(hashDeviceToken(token))
	s.mu.Lock()
	defer s.mu.Unlock()
	s.maybeReloadLocked()
	found := -1
	for i, r := range s.recs {
		if subtle.ConstantTimeCompare(hash, []byte(r.Hash)) == 1 {
			if s.live(r) {
				found = i
			} else {
				stale = true
			}
		}
	}
	if found < 0 {
		return deviceRecord{}, false, stale
	}
	now := s.now().UTC()
	s.touched[s.recs[found].ID] = now
	if now.Sub(s.flushed) >= deviceTouchEvery {
		s.flushLocked()
	}
	return s.withTouchLocked(s.recs[found]), true, false
}

func (s *deviceStore) withTouchLocked(r deviceRecord) deviceRecord {
	if t, ok := s.touched[r.ID]; ok && t.After(r.LastUsedAt) {
		r.LastUsedAt = t
	}
	return r
}

// flushLocked writes the recorded uses to the disk; a failure is logged and
// retried at the next flush.
func (s *deviceStore) flushLocked() {
	if len(s.touched) == 0 {
		return
	}
	s.flushed = s.now()
	if err := s.changeLocked(func(recs []deviceRecord) ([]deviceRecord, error) { return recs, nil }); err != nil {
		log.Printf("devices: record last use: %v", err)
	}
}

// flush writes the recorded uses (on shutdown).
func (s *deviceStore) flush() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.flushLocked()
}

// alive reports whether a live device has this id. It reads memory only (the
// stream hub asks it under its lock); a revoke updates memory before the hub
// closes the device's streams.
func (s *deviceStore) alive(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.ContainsFunc(s.recs, func(r deviceRecord) bool { return r.ID == id && s.live(r) })
}

// list returns the live devices, oldest first.
func (s *deviceStore) list() []deviceRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.maybeReloadLocked()
	var out []deviceRecord
	for _, r := range s.recs {
		if s.live(r) {
			out = append(out, s.withTouchLocked(r))
		}
	}
	return out
}

// validDeviceName: 1-64 bytes of UTF-8 without control or format characters
// (bidi overrides, zero-width), nor leading or trailing space.
func validDeviceName(n string) bool {
	if n == "" || len(n) > maxDeviceName || strings.TrimSpace(n) != n || !utf8.ValidString(n) {
		return false
	}
	return !strings.ContainsFunc(n, func(r rune) bool { return unicode.IsControl(r) || unicode.Is(unicode.Cf, r) })
}

// cleanDeviceName makes a name valid by dropping what validDeviceName refuses
// and cutting it at maxDeviceName bytes; "" when nothing is left.
func cleanDeviceName(n string) string {
	n = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || r == unicode.ReplacementChar {
			return -1
		}
		return r
	}, strings.ToValidUTF8(n, ""))
	n = strings.TrimSpace(n)
	for len(n) > maxDeviceName {
		_, size := utf8.DecodeLastRuneInString(n)
		n = n[:len(n)-size]
	}
	return strings.TrimSpace(n)
}

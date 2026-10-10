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
	// device is ended by revoking it or by its validUntil, never by the
	// cookie's own age.
	deviceCookieMaxAge = 400 * 24 * time.Hour
	// minDeviceValidity and maxDeviceValidity bound the validFor a pairing
	// code may ask for (0 is no limit).
	minDeviceValidity = time.Hour
	maxDeviceValidity = 400 * 24 * time.Hour
	// pairedByPassword is the pairedBy of a device a password session, Basic
	// auth (the CLI) or a terminal paired.
	pairedByPassword = "password"
	// expiringHashTag marks the hash of a device with a validUntil. An older
	// release compares the hash as it is and never matches it, so it cannot
	// sign in a device whose limit it would ignore.
	expiringHashTag = "v2:"
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
	// errCreatorGone: the device that made a code was revoked or expired
	// before the code was used, so the code pairs nothing.
	errCreatorGone = &codedError{code: "creator_gone", msg: "this code is no longer valid", status: http.StatusConflict}

	// devicePartRe matches the store's temporary files, left behind by a crash.
	devicePartRe = regexp.MustCompile(`^\.(devices|key)-[0-9a-f]{16}\.part$`)
	deviceIDRe   = regexp.MustCompile(`^[0-9a-f]{16}$`)
)

// deviceRecord is one paired device on disk. Hash is the SHA-256 of its
// token (behind expiringHashTag when ValidUntil is set); the token itself is
// never stored. ValidUntil nil is no limit. PairedBy is pairedByPassword, the
// id of the device that paired it, or "" for a record from before it was
// kept.
type deviceRecord struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Role       role       `json:"role"`
	Hash       string     `json:"hash"`
	Gen        string     `json:"gen"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt time.Time  `json:"lastUsedAt"`
	ValidUntil *time.Time `json:"validUntil,omitempty"`
	PairedBy   string     `json:"pairedBy,omitempty"`
}

// expired reports whether r can no longer sign in at now. A tagged hash
// without a validUntil is a record an older release wrote back, dropping the
// field it does not know: it never comes back as a device without a limit.
func (r deviceRecord) expired(now time.Time) bool {
	if r.ValidUntil == nil {
		return strings.HasPrefix(r.Hash, expiringHashTag)
	}
	return !now.Before(*r.ValidUntil)
}

// deviceAddOpts is where a new device comes from and how long it is valid.
type deviceAddOpts struct {
	// PairedBy is pairedByPassword or the id of the device that made the code.
	PairedBy string
	// ValidFor counts from the pairing; 0 is no limit.
	ValidFor time.Duration
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
	// onReload, when set, is told the next validUntil (zero: none) each
	// time the records change, under mu: it must not call the store.
	onReload func(next time.Time)

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

// changedLocked tells onReload the records changed.
func (s *deviceStore) changedLocked() {
	if s.onReload != nil {
		s.onReload(s.nextExpiryLocked())
	}
}

// nextExpiryLocked is the earliest validUntil of a live device still valid,
// or zero when there is none.
func (s *deviceStore) nextExpiryLocked() time.Time {
	now := s.now()
	var next time.Time
	for _, r := range s.recs {
		if s.live(r) && r.ValidUntil != nil && !r.expired(now) && (next.IsZero() || r.ValidUntil.Before(next)) {
			next = *r.ValidUntil
		}
	}
	return next
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
		return
	}
	s.changedLocked()
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
	s.changedLocked()
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
// the clear. A device paired by another one needs that device live and
// valid in the file as read for this very write, so a revoke racing the
// pairing never leaves a device whose parent is gone; it is valid no longer
// than its parent.
func (s *deviceStore) add(name string, r role, opts deviceAddOpts) (string, deviceRecord, error) {
	if r != roleFull && r != roleView {
		return "", deviceRecord{}, errInvalidRole
	}
	if !validDeviceName(name) {
		return "", deviceRecord{}, errInvalidName
	}
	if opts.PairedBy == "" {
		opts.PairedBy = pairedByPassword
	}
	token, hash := newDeviceToken()
	var idb [8]byte
	rand.Read(idb[:])
	now := s.now().UTC()
	rec := deviceRecord{ID: hex.EncodeToString(idb[:]), Name: name, Role: r, Gen: s.gen, CreatedAt: now, LastUsedAt: now, PairedBy: opts.PairedBy}
	s.mu.Lock()
	defer s.mu.Unlock()
	err := s.changeLocked(func(recs []deviceRecord) ([]deviceRecord, error) {
		validFor := opts.ValidFor
		if opts.PairedBy != pairedByPassword {
			i := slices.IndexFunc(recs, func(p deviceRecord) bool { return p.ID == opts.PairedBy && s.live(p) })
			if i < 0 || recs[i].expired(now) {
				return nil, errCreatorGone
			}
			if p := recs[i].ValidUntil; p != nil && (validFor <= 0 || p.Sub(now) < validFor) {
				validFor = p.Sub(now)
			}
		}
		if countFunc(recs, s.live) >= maxDevices {
			return nil, errTooManyDevices
		}
		rec.Hash = hash
		if validFor > 0 {
			until := now.Add(validFor)
			rec.ValidUntil = &until
			rec.Hash = expiringHashTag + hash
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

// revoke removes a device of the current password, and only it (Log out,
// a device paired again): the devices it paired stay.
func (s *deviceStore) revoke(id string) error {
	_, err := s.remove(id, false)
	return err
}

// revokeCascade removes a device of the current password and every live
// device it paired, in one write, and returns their ids (id first). One
// level is enough: only a full device pairs, and what it pairs is view-only.
func (s *deviceStore) revokeCascade(id string) ([]string, error) {
	return s.remove(id, true)
}

func (s *deviceStore) remove(id string, cascade bool) ([]string, error) {
	if !deviceIDRe.MatchString(id) {
		return nil, errUnknownDevice
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var gone []string
	err := s.changeLocked(func(recs []deviceRecord) ([]deviceRecord, error) {
		if !slices.ContainsFunc(recs, func(r deviceRecord) bool { return r.ID == id && s.live(r) }) {
			return nil, errUnknownDevice
		}
		gone = []string{id}
		return slices.DeleteFunc(recs, func(r deviceRecord) bool {
			switch {
			case !s.live(r):
				return false
			case r.ID == id:
				return true
			case cascade && r.PairedBy == id:
				gone = append(gone, r.ID)
				return true
			}
			return false
		}), nil
	})
	if err != nil {
		return nil, err
	}
	return gone, nil
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
// to be cleared from its browser, since the password may come back. A live
// device past its validUntil is not ok, and is returned (with its id) so the
// caller can end what it holds; its cookie is cleared like a revoked one's.
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
		if subtle.ConstantTimeCompare(hash, []byte(strings.TrimPrefix(r.Hash, expiringHashTag))) == 1 {
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
	if s.recs[found].expired(s.now()) {
		return s.recs[found], false, false
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

// alive reports whether a live device still valid has this id. It reads
// memory only (the stream hub asks it under its lock); a revoke updates
// memory before the hub closes the device's streams.
func (s *deviceStore) alive(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	return slices.ContainsFunc(s.recs, func(r deviceRecord) bool { return r.ID == id && s.live(r) && !r.expired(now) })
}

// get returns the live device with this id, from memory.
func (s *deviceStore) get(id string) (deviceRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := slices.IndexFunc(s.recs, func(r deviceRecord) bool { return r.ID == id && s.live(r) })
	if i < 0 {
		return deviceRecord{}, false
	}
	return s.recs[i], true
}

// expiredNow returns the ids of the live devices that can no longer sign in
// for their validUntil.
func (s *deviceStore) expiredNow() (ids []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for _, r := range s.recs {
		if s.live(r) && r.expired(now) {
			ids = append(ids, r.ID)
		}
	}
	return ids
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

package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func newTestDeviceStore(t *testing.T, dir, pass string) *deviceStore {
	t.Helper()
	s, err := newDeviceStore(dir, "admin", pass)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestDeviceStoreAddLookupRevoke(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "devices")
	s := newTestDeviceStore(t, dir, "pw")
	token, rec, err := s.add("iPhone Safari", roleView)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(token, deviceTokenTag) || rec.Role != roleView || !deviceIDRe.MatchString(rec.ID) {
		t.Fatalf("add = %q %+v", token, rec)
	}
	got, ok, _ := s.lookup(token)
	if !ok || got.ID != rec.ID || got.Role != roleView {
		t.Fatalf("lookup = %+v %v", got, ok)
	}
	if _, ok, _ := s.lookup(token + "x"); ok {
		t.Error("a wrong token matched")
	}
	if _, ok, _ := s.lookup("not-a-token"); ok {
		t.Error("an untagged token matched")
	}
	// Only the hash is on disk, owner-only.
	data, _ := os.ReadFile(filepath.Join(dir, devicesFile))
	if strings.Contains(string(data), token) || !strings.Contains(string(data), hashDeviceToken(token)) {
		t.Errorf("devices.json holds the token or not its hash: %s", data)
	}
	if runtime.GOOS != "windows" {
		for _, f := range []string{devicesFile, deviceKeyFile} {
			if fi, err := os.Stat(filepath.Join(dir, f)); err != nil || fi.Mode().Perm() != 0o600 {
				t.Errorf("%s mode = %v, %v", f, fi.Mode().Perm(), err)
			}
		}
	}
	// A new store on the same dir (a restart) knows the device.
	s2 := newTestDeviceStore(t, dir, "pw")
	if _, ok, _ := s2.lookup(token); !ok {
		t.Error("device lost across a restart")
	}
	if s2.cookie != s.cookie || !strings.HasPrefix(s.cookie, "termote_device_") {
		t.Errorf("cookie names %q and %q", s.cookie, s2.cookie)
	}
	if err := s.revoke(rec.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.lookup(token); ok || s.alive(rec.ID) {
		t.Error("revoked device still signs in")
	}
	if err := s.revoke(rec.ID); !errors.Is(err, errUnknownDevice) {
		t.Errorf("revoke twice = %v", err)
	}
	if err := s.revoke("../x"); !errors.Is(err, errUnknownDevice) {
		t.Errorf("revoke bad id = %v", err)
	}
}

func TestDeviceStoreValidation(t *testing.T) {
	s := newTestDeviceStore(t, t.TempDir(), "pw")
	if _, _, err := s.add("x", "admin"); !errors.Is(err, errInvalidRole) {
		t.Errorf("bad role = %v", err)
	}
	for _, n := range []string{"", " pad", strings.Repeat("a", 65), "a\x00b", "a‮b", "a​b", "\xff"} {
		if _, _, err := s.add(n, roleView); !errors.Is(err, errInvalidName) {
			t.Errorf("name %q = %v", n, err)
		}
	}
	if got := cleanDeviceName("  My‮ Phone\x07  "); got != "My Phone" {
		t.Errorf("cleanDeviceName = %q", got)
	}
	if got := cleanDeviceName(strings.Repeat("é", 40)); len(got) > maxDeviceName || !validDeviceName(got) {
		t.Errorf("cut name %q (%d bytes)", got, len(got))
	}
}

func TestDeviceStoreCap(t *testing.T) {
	s := newTestDeviceStore(t, t.TempDir(), "pw")
	for i := range maxDevices {
		if _, _, err := s.add("d", roleView); err != nil {
			t.Fatalf("add %d: %v", i, err)
		}
	}
	if _, _, err := s.add("d", roleView); !errors.Is(err, errTooManyDevices) {
		t.Errorf("past the cap = %v", err)
	}
}

// Another password ignores the old devices without deleting them; only
// pruneStale (start --fresh) removes them from the disk.
func TestDeviceStoreOtherPassword(t *testing.T) {
	dir := t.TempDir()
	old := newTestDeviceStore(t, dir, "old")
	token, _, _ := old.add("d", roleFull)
	s := newTestDeviceStore(t, dir, "new")
	if _, ok, stale := s.lookup(token); ok || !stale || len(s.list()) != 0 {
		t.Fatal("a device of another password signs in, or is not known as stale")
	}
	s.add("e", roleView) // a write keeps the other password's record
	if again := newTestDeviceStore(t, dir, "old"); len(again.list()) != 1 {
		t.Error("a write under another password deleted the device")
	}
	if n, err := s.pruneStale(); err != nil || n != 1 {
		t.Errorf("pruneStale = %d, %v", n, err)
	}
	if again := newTestDeviceStore(t, dir, "old"); len(again.list()) != 0 {
		t.Error("pruned device still on disk")
	}
}

// Two processes on one store: a revoke in one is seen by the other, and a
// write by the other never brings it back.
func TestDeviceStoreTwoProcesses(t *testing.T) {
	dir := t.TempDir()
	a := newTestDeviceStore(t, dir, "pw")
	b := newTestDeviceStore(t, dir, "pw")
	token, rec, _ := a.add("d", roleView)
	clock := time.Now()
	b.now = func() time.Time { return clock }
	clock = clock.Add(2 * deviceReloadEvery)
	if _, ok, _ := b.lookup(token); !ok {
		t.Fatal("b does not see a's new device")
	}
	if err := a.revoke(rec.ID); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(2 * deviceReloadEvery)
	if _, ok, _ := b.lookup(token); ok {
		t.Error("b still signs in a device a revoked")
	}
	b.add("other", roleView)
	if _, ok, _ := newTestDeviceStore(t, dir, "pw").lookup(token); ok {
		t.Error("b's write brought the revoked device back")
	}
}

// A write that fails changes nothing, in memory or on disk.
func TestDeviceStoreWriteFailure(t *testing.T) {
	if runtime.GOOS == "windows" || os.Getuid() == 0 {
		t.Skip("needs a dir the user cannot write")
	}
	dir := t.TempDir()
	s := newTestDeviceStore(t, dir, "pw")
	token, rec, _ := s.add("d", roleView)
	os.Chmod(dir, 0o500)
	defer os.Chmod(dir, 0o700)
	if _, _, err := s.add("e", roleView); err == nil {
		t.Fatal("add into a read-only dir succeeded")
	}
	if err := s.revoke(rec.ID); err == nil {
		t.Fatal("revoke in a read-only dir succeeded")
	}
	if _, ok, _ := s.lookup(token); !ok || len(s.list()) != 1 {
		t.Error("a failed write changed the store")
	}
}

// A corrupt file is never overwritten: it holds every device.
func TestDeviceStoreCorruptFile(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, devicesFile), []byte("{nope"), 0o600)
	if _, err := newDeviceStore(dir, "admin", "pw"); err == nil {
		t.Fatal("a corrupt devices.json was accepted")
	}
	os.WriteFile(filepath.Join(dir, deviceKeyFile), []byte("{}"), 0o600)
	os.Remove(filepath.Join(dir, devicesFile))
	if _, err := newDeviceStore(dir, "admin", "pw"); err == nil {
		t.Fatal("a corrupt key.json was replaced")
	}
}

// Uses reach the disk at most every deviceTouchEvery, and on flush.
func TestDeviceStoreLastUsed(t *testing.T) {
	dir := t.TempDir()
	s := newTestDeviceStore(t, dir, "pw")
	token, rec, _ := s.add("d", roleView)
	clock := time.Now().Add(time.Minute)
	s.now = func() time.Time { return clock }
	s.lookup(token)
	if got := s.list()[0].LastUsedAt; !got.Equal(clock.UTC()) {
		t.Errorf("list LastUsedAt = %v, want %v", got, clock)
	}
	if onDisk := newTestDeviceStore(t, dir, "pw").list()[0].LastUsedAt; !onDisk.Equal(rec.LastUsedAt) {
		t.Error("a use was written at once")
	}
	s.flush()
	if onDisk := newTestDeviceStore(t, dir, "pw").list()[0].LastUsedAt; !onDisk.Equal(clock.UTC()) {
		t.Errorf("after flush LastUsedAt = %v", onDisk)
	}
}

func TestPairCodes(t *testing.T) {
	p := newPairCodes()
	clock := time.Now()
	p.now = func() time.Time { return clock }
	if p.waiting() {
		t.Error("waiting with no code")
	}
	code, exp, err := p.create(roleView, "Phone", "")
	if err != nil || len(code) != pairCodeLen+1 || code[pairCodeGroup] != '-' || !exp.Equal(clock.Add(pairCodeTTL)) {
		t.Fatalf("create = %q %v %v", code, exp, err)
	}
	if !p.waiting() {
		t.Error("not waiting with a code")
	}
	// Typed loosely: lower case, spaces, O for 0, I/L for 1.
	loose := strings.ToLower(strings.NewReplacer("0", "o", "1", "l", "-", " ").Replace(code))
	got, ok := p.redeem(loose)
	if !ok || got.role != roleView || got.name != "Phone" {
		t.Fatalf("redeem(%q) = %+v %v", loose, got, ok)
	}
	if _, ok := p.redeem(code); ok {
		t.Error("code used twice")
	}
	// Expiry.
	code, _, _ = p.create(roleFull, "", "")
	clock = clock.Add(pairCodeTTL)
	if _, ok := p.redeem(code); ok || p.waiting() {
		t.Error("expired code redeemed")
	}
	// Cap, and the codes of a revoked device go.
	for i := range maxPairCodes {
		if _, _, err := p.create(roleView, "", "dev1"); err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
	}
	if _, _, err := p.create(roleView, "", ""); !errors.Is(err, errTooManyCodes) {
		t.Errorf("past the cap = %v", err)
	}
	p.dropCreator("dev1")
	if p.waiting() {
		t.Error("codes of a revoked device kept")
	}
	if _, _, err := p.create("root", "", ""); !errors.Is(err, errInvalidRole) {
		t.Errorf("bad role = %v", err)
	}
	for _, bad := range []string{"", "ABCDE", "ABCDE-FGHJKM", "ABCDE-FGHJ!", "ABCDE-FGHJU"} {
		if _, ok := normalizePairCode(bad); ok {
			t.Errorf("normalizePairCode(%q) ok", bad)
		}
	}
}

func TestUserAgentDeviceName(t *testing.T) {
	for ua, want := range map[string]string{
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1": "iPhone Safari",
		"Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36":                                "Android Chrome",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0":                   "Windows Edge",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:121.0) Gecko/20100101 Firefox/121.0":                                 "Mac Firefox",
		"curl/8.0": "Device",
	} {
		if got := userAgentDeviceName(ua); got != want {
			t.Errorf("%q = %q, want %q", ua, got, want)
		}
	}
}

package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// clockedStore is a store whose clock the test moves.
func clockedStore(t *testing.T, dir string) (*deviceStore, *time.Time) {
	t.Helper()
	s := newTestDeviceStore(t, dir, "pw")
	clock := time.Now().UTC().Truncate(time.Second)
	s.now = func() time.Time { return clock }
	return s, &clock
}

// A record from before validUntil and pairedBy reads as no limit and an
// unknown origin, signs in, and is written back unchanged.
func TestDeviceStoreOldRecord(t *testing.T) {
	dir := t.TempDir()
	s := newTestDeviceStore(t, dir, "pw")
	token, hash := newDeviceToken()
	old := []map[string]any{{"id": "0123456789abcdef", "name": "Old", "role": "view", "hash": hash, "gen": s.gen,
		"createdAt": time.Now().UTC(), "lastUsedAt": time.Now().UTC()}}
	data, _ := json.Marshal(old)
	os.WriteFile(filepath.Join(dir, devicesFile), data, 0o600)
	s = newTestDeviceStore(t, dir, "pw")
	rec, ok, _ := s.lookup(token)
	if !ok || rec.ValidUntil != nil || rec.PairedBy != "" || rec.expired(time.Now().Add(1000*24*time.Hour)) {
		t.Fatalf("old record: ok %v %+v", ok, rec)
	}
	if _, _, err := s.add("New", roleView, deviceAddOpts{}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, devicesFile))
	if strings.Count(string(raw), "validUntil") != 0 || strings.Count(string(raw), `"pairedBy":"password"`) != 1 {
		t.Errorf("written back: %s", raw)
	}
	if v := deviceViews(s.list(), "", time.Now()); v[0].PairedBy != "unknown" || v[0].ValidUntil != nil || v[0].Expired {
		t.Errorf("old record view: %+v", v[0])
	}
}

// A device with a limit signs in until validUntil and not at it; its hash is
// tagged, so a release comparing the hash as it is never matches it, and a
// tagged hash without a validUntil (an older release wrote the file back) is
// expired.
func TestDeviceStoreExpiry(t *testing.T) {
	dir := t.TempDir()
	s, clock := clockedStore(t, dir)
	token, rec, err := s.add("Phone", roleView, deviceAddOpts{ValidFor: 7 * 24 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if rec.ValidUntil == nil || !rec.ValidUntil.Equal(clock.Add(7*24*time.Hour)) || rec.PairedBy != pairedByPassword {
		t.Fatalf("record: %+v", rec)
	}
	if !strings.HasPrefix(rec.Hash, expiringHashTag) {
		t.Fatalf("hash %q not tagged", rec.Hash)
	}
	if subtle.ConstantTimeCompare([]byte(hashDeviceToken(token)), []byte(rec.Hash)) == 1 {
		t.Error("an older release's comparison matches the tagged hash")
	}
	if _, ok, _ := s.lookup(token); !ok || !s.alive(rec.ID) {
		t.Fatal("valid device refused")
	}
	if next := s.nextExpiryLocked(); !next.Equal(*rec.ValidUntil) {
		t.Errorf("next expiry = %v", next)
	}
	*clock = *rec.ValidUntil
	got, ok, stale := s.lookup(token)
	if ok || stale || got.ID != rec.ID {
		t.Errorf("at validUntil: ok %v stale %v id %q", ok, stale, got.ID)
	}
	if s.alive(rec.ID) {
		t.Error("expired device alive")
	}
	if ids := s.expiredNow(); !slices.Equal(ids, []string{rec.ID}) || !s.nextExpiryLocked().IsZero() {
		t.Errorf("expiredNow = %v", ids)
	}
	if v := deviceViews(s.list(), "", *clock); !v[0].Expired || v[0].ValidUntil == nil {
		t.Errorf("view: %+v", v[0])
	}

	// An older release wrote the file back without validUntil.
	var recs []map[string]any
	raw, _ := os.ReadFile(filepath.Join(dir, devicesFile))
	json.Unmarshal(raw, &recs)
	delete(recs[0], "validUntil")
	raw, _ = json.Marshal(recs)
	os.WriteFile(filepath.Join(dir, devicesFile), raw, 0o600)
	s2 := newTestDeviceStore(t, dir, "pw")
	if _, ok, _ := s2.lookup(token); ok || s2.alive(rec.ID) {
		t.Error("a tagged hash without validUntil signs in")
	}
}

// A device paired by one with a limit is valid no longer than it, whatever
// the code asked; one paired by a device without a limit keeps its own.
func TestDeviceStoreChildValidity(t *testing.T) {
	s, clock := clockedStore(t, t.TempDir())
	_, parent, _ := s.add("Laptop", roleFull, deviceAddOpts{ValidFor: 48 * time.Hour})
	_, free, _ := s.add("Desk", roleFull, deviceAddOpts{})
	for _, c := range []struct {
		by   string
		ask  time.Duration
		want time.Duration
	}{
		{parent.ID, 0, 48 * time.Hour},
		{parent.ID, 30 * 24 * time.Hour, 48 * time.Hour},
		{parent.ID, 2 * time.Hour, 2 * time.Hour},
		{free.ID, 0, 0},
		{free.ID, 5 * time.Hour, 5 * time.Hour},
	} {
		_, rec, err := s.add("Phone", roleView, deviceAddOpts{PairedBy: c.by, ValidFor: c.ask})
		if err != nil {
			t.Fatal(err)
		}
		var got time.Duration
		if rec.ValidUntil != nil {
			got = rec.ValidUntil.Sub(*clock)
		}
		if got != c.want || rec.PairedBy != c.by {
			t.Errorf("by %s asking %v: %v, pairedBy %q", c.by, c.ask, got, rec.PairedBy)
		}
	}
}

// A code whose maker is gone (revoked, expired, never there) pairs nothing.
func TestDeviceStoreCreatorGone(t *testing.T) {
	s, clock := clockedStore(t, t.TempDir())
	_, parent, _ := s.add("Laptop", roleFull, deviceAddOpts{ValidFor: time.Hour})
	for _, by := range []string{"0123456789abcdef", "not an id"} {
		if _, _, err := s.add("Phone", roleView, deviceAddOpts{PairedBy: by}); !errors.Is(err, errCreatorGone) {
			t.Errorf("by %q: %v", by, err)
		}
	}
	*clock = clock.Add(time.Hour)
	if _, _, err := s.add("Phone", roleView, deviceAddOpts{PairedBy: parent.ID}); !errors.Is(err, errCreatorGone) {
		t.Errorf("by an expired device: %v", err)
	}
	if len(s.list()) != 1 {
		t.Errorf("a refused pairing wrote a device: %v", s.list())
	}
}

// Pairing and revoking the maker at the same time never leaves a device
// whose maker is gone: the maker is checked in the very write.
func TestDeviceStorePairRevokeRace(t *testing.T) {
	for i := range 20 {
		s := newTestDeviceStore(t, t.TempDir(), "pw")
		_, parent, _ := s.add("Laptop", roleFull, deviceAddOpts{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			s.add("Phone", roleView, deviceAddOpts{PairedBy: parent.ID})
		}()
		go func() {
			defer wg.Done()
			if _, err := s.revokeCascade(parent.ID); err != nil {
				t.Errorf("revoke: %v", err)
			}
		}()
		wg.Wait()
		if n := len(s.list()); n != 0 {
			t.Fatalf("round %d: %d device(s) left: %+v", i, n, s.list())
		}
	}
}

// A revoke from Devices takes the device and every live device it paired,
// one level, in one write; one of another password and others stay. Log out
// (revoke) takes only the device. A second process sees the cascade.
func TestDeviceStoreRevokeCascade(t *testing.T) {
	dir := t.TempDir()
	s := newTestDeviceStore(t, dir, "pw")
	_, a, _ := s.add("A", roleFull, deviceAddOpts{})
	tokC1, c1, _ := s.add("C1", roleView, deviceAddOpts{PairedBy: a.ID})
	_, c2, _ := s.add("C2", roleView, deviceAddOpts{PairedBy: a.ID})
	_, b, _ := s.add("B", roleFull, deviceAddOpts{})
	_, d, _ := s.add("D", roleView, deviceAddOpts{PairedBy: b.ID})
	// A device of another password stays whatever happens.
	if _, _, err := newTestDeviceStore(t, dir, "other").add("Elsewhere", roleView, deviceAddOpts{}); err != nil {
		t.Fatal(err)
	}

	other, clock := clockedStore(t, dir)
	if _, ok, _ := other.lookup(tokC1); !ok {
		t.Fatal("second process: C1 not found")
	}

	ids, err := s.revokeCascade(a.ID)
	if err != nil || !slices.Equal(ids, []string{a.ID, c1.ID, c2.ID}) {
		t.Fatalf("cascade = %v %v", ids, err)
	}
	*clock = clock.Add(2 * deviceReloadEvery) // the store was opened on the real clock
	if _, ok, _ := other.lookup(tokC1); ok {
		t.Error("second process still signs C1 in after the cascade")
	}
	if err := s.revoke(b.ID); err != nil {
		t.Fatal(err)
	}
	left := s.list()
	if len(left) != 1 || left[0].ID != d.ID || left[0].PairedBy != b.ID {
		t.Errorf("after Log out of B: %+v", left)
	}
	if v := deviceViews(left, "", time.Now()); v[0].PairedBy != b.ID || v[0].PairedByName != "" {
		t.Errorf("a device whose maker is gone: %+v", v[0])
	}
	if _, err := s.revokeCascade(a.ID); !errors.Is(err, errUnknownDevice) {
		t.Errorf("cascade twice: %v", err)
	}
	if _, err := s.revokeCascade("../x"); !errors.Is(err, errUnknownDevice) {
		t.Errorf("bad id: %v", err)
	}
}

// When the expiry timer fires, the expired device's open streams close, its
// stream tokens and waiting codes go, it is logged once, and the timer moves
// to the next limit. A lookup of an expired device ends it too, once.
func TestDeviceAuthExpiryTimer(t *testing.T) {
	logs := captureLog(t)
	s, clock := clockedStore(t, t.TempDir())
	tokens := newTokenStore(time.Minute, true)
	hub := newStreamHub(8)
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	token, soon, _ := s.add("Soon", roleFull, deviceAddOpts{ValidFor: time.Hour})
	_, later, _ := s.add("Later", roleView, deviceAddOpts{ValidFor: 2 * time.Hour})
	d := newDeviceAuth(s, tokens, hub)
	hub.alive = s.alive
	if !d.timerAt.Equal(*soon.ValidUntil) {
		t.Fatalf("timer at %v, want %v", d.timerAt, soon.ValidUntil)
	}

	ctx, cancel := context.WithCancelCause(context.Background())
	e, err := hub.add(cancel, roleFull, soon.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer hub.remove(e)
	streamTok, _ := tokens.generateFor(roleFull, soon.ID)
	if _, _, err := d.codes.create(roleView, "", soon.ID, 0); err != nil {
		t.Fatal(err)
	}

	*clock = *soon.ValidUntil
	d.checkExpiry()
	if !errors.Is(context.Cause(ctx), errDeviceRevoked) {
		t.Errorf("open stream not closed: %v", context.Cause(ctx))
	}
	if _, ok := tokens.consume(streamTok); ok {
		t.Error("stream token still valid")
	}
	if d.codes.waiting() {
		t.Error("the expired device's code still waits")
	}
	if _, err := hub.add(func(error) {}, roleFull, soon.ID); !errors.Is(err, errDeviceRevoked) {
		t.Errorf("new stream of an expired device: %v", err)
	}
	if _, _, err := d.codes.create(roleView, "", soon.ID, 0); !errors.Is(err, errCreatorGone) {
		t.Errorf("code from an expired device: %v", err)
	}
	if !d.timerAt.Equal(*later.ValidUntil) {
		t.Errorf("timer moved to %v, want %v", d.timerAt, later.ValidUntil)
	}
	d.checkExpiry()
	s.lookup(token)
	if n := strings.Count(logs.String(), `audit: device-expired id="`+soon.ID+`"`); n != 1 {
		t.Errorf("device-expired logged %d times:\n%s", n, logs)
	}

	// Revoking the last device with a limit stops the timer.
	if err := d.revoke(later.ID); err != nil {
		t.Fatal(err)
	}
	if !d.timerAt.IsZero() || d.timer != nil {
		t.Errorf("timer after the last limit went: %v", d.timerAt)
	}
}

// The timer really fires: a limit already reached closes the device's open
// stream at once.
func TestDeviceAuthTimerFires(t *testing.T) {
	captureLog(t)
	s, clock := clockedStore(t, t.TempDir())
	hub := newStreamHub(8)
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	d := newDeviceAuth(s, newTokenStore(time.Minute, true), hub)
	_, rec, _ := s.add("Soon", roleView, deviceAddOpts{ValidFor: time.Hour})
	ctx, cancel := context.WithCancelCause(context.Background())
	e, _ := hub.add(cancel, roleView, rec.ID)
	defer hub.remove(e)
	*clock = clock.Add(time.Hour)
	d.arm(*rec.ValidUntil)
	select {
	case <-ctx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the timer never fired")
	}
}

// revokeCascade ends what every revoked device holds.
func TestDeviceAuthRevokeCascadeEnds(t *testing.T) {
	s := newTestDeviceStore(t, t.TempDir(), "pw")
	tokens := newTokenStore(time.Minute, true)
	hub := newStreamHub(8)
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	d := newDeviceAuth(s, tokens, hub)
	_, a, _ := s.add("A", roleFull, deviceAddOpts{})
	_, c, _ := s.add("C", roleView, deviceAddOpts{PairedBy: a.ID})
	tok, _ := tokens.generateFor(roleView, c.ID)
	ctx, cancel := context.WithCancelCause(context.Background())
	e, _ := hub.add(cancel, roleView, c.ID)
	defer hub.remove(e)
	ids, err := d.revokeCascade(a.ID)
	if err != nil || len(ids) != 2 {
		t.Fatalf("cascade: %v %v", ids, err)
	}
	if _, ok := tokens.consume(tok); ok || context.Cause(ctx) == nil {
		t.Error("the paired device's token or stream outlived the cascade")
	}
	if _, err := d.revokeCascade(a.ID); err == nil {
		t.Error("cascade of a revoked device succeeded")
	}
	if err := d.revoke(a.ID); err == nil {
		t.Error("revoke of a revoked device succeeded")
	}
}

// pairValidity: the bounds, and a device with a limit must give one and
// gets it cut to what is left of its own.
func TestPairValidity(t *testing.T) {
	s, clock := clockedStore(t, t.TempDir())
	hub := newStreamHub(8)
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	d := newDeviceAuth(s, newTokenStore(time.Minute, true), hub)
	_, limited, _ := s.add("L", roleFull, deviceAddOpts{ValidFor: 3 * time.Hour})
	_, free, _ := s.add("F", roleFull, deviceAddOpts{})
	n := func(v int64) *int64 { return &v }
	pw := authInfo{Kind: authBasic, Role: roleFull}
	lim := authInfo{Kind: authDevice, Role: roleFull, DeviceID: limited.ID}
	for _, c := range []struct {
		a    authInfo
		secs *int64
		want time.Duration
		err  error
	}{
		{pw, nil, 0, nil},
		{pw, n(0), 0, nil},
		{pw, n(3600), time.Hour, nil},
		{pw, n(400 * 86400), maxDeviceValidity, nil},
		{pw, n(3599), 0, errInvalidValidity},
		{pw, n(400*86400 + 1), 0, errInvalidValidity},
		{pw, n(-1), 0, errInvalidValidity},
		{authInfo{Kind: authDevice, DeviceID: free.ID}, nil, 0, nil},
		{lim, nil, 0, errValidityNeeded},
		{lim, n(3600), time.Hour, nil},
		{lim, n(86400), 3 * time.Hour, nil},
		{authInfo{Kind: authDevice, DeviceID: "0123456789abcdef"}, n(3600), 0, errCreatorGone},
	} {
		got, err := d.pairValidity(c.a, c.secs)
		if got != c.want || !errors.Is(err, c.err) {
			t.Errorf("%+v %v: %v %v, want %v %v", c.a, c.secs, got, err, c.want, c.err)
		}
	}
	*clock = *limited.ValidUntil
	if _, err := d.pairValidity(lim, n(3600)); !errors.Is(err, errCreatorGone) {
		t.Errorf("expired maker: %v", err)
	}
}

// A pairing at the moment the timer fires keeps the timer the pairing set:
// the next limit is read and armed under the store's lock.
func TestDeviceAuthExpiryRacesPairing(t *testing.T) {
	captureLog(t)
	for range 20 {
		s, clock := clockedStore(t, t.TempDir())
		hub := newStreamHub(8)
		d := newDeviceAuth(s, newTokenStore(time.Minute, true), hub)
		_, a, _ := s.add("A", roleView, deviceAddOpts{ValidFor: time.Hour})
		*clock = *a.ValidUntil
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); d.checkExpiry() }()
		go func() { defer wg.Done(); s.add("B", roleView, deviceAddOpts{ValidFor: 24 * time.Hour}) }()
		wg.Wait()
		d.mu.Lock()
		at := d.timerAt
		d.mu.Unlock()
		if want := clock.Add(24 * time.Hour); !at.Equal(want) {
			t.Fatalf("timer at %v, want B's limit %v", at, want)
		}
		hub.shutdown(context.Background())
	}
}

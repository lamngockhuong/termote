package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func newTestPushStore(t *testing.T) *pushStore {
	t.Helper()
	s, err := newPushStore(filepath.Join(t.TempDir(), "push"), "admin", "secret", false)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// testClock makes s.now tick a second per call, so Created orders adds.
func testClock(s *pushStore) {
	var mu sync.Mutex
	at := time.Date(2026, 10, 7, 8, 0, 0, 0, time.UTC)
	s.now = func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		at = at.Add(time.Second)
		return at
	}
}

func fcmSub(t *testing.T, n int) pushSub {
	t.Helper()
	sub, _, _ := testPushSub(t, fmt.Sprintf("https://fcm.googleapis.com/fcm/send/dev%d", n))
	return sub
}

func readSubsFile(t *testing.T, dir string) []pushSub {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, pushSubsFile))
	if err != nil {
		t.Fatal(err)
	}
	var subs []pushSub
	if err := json.Unmarshal(data, &subs); err != nil {
		t.Fatal(err)
	}
	return subs
}

func TestPushEndpointAllowlist(t *testing.T) {
	for _, ok := range []string{
		"https://fcm.googleapis.com/fcm/send/abc:def",
		"https://fcm.googleapis.com/wp/abc",
		"https://FCM.googleapis.com/wp/abc",
		"https://fcm.googleapis.com:443/wp/abc",
		"https://updates.push.services.mozilla.com/wpush/v2/gAAA",
		"https://web.push.apple.com/QGx3",
		"https://api.push.apple.com/3/device/x",
		"https://wns2-by3p.notify.windows.com/w/?token=abc",
	} {
		if err := validEndpoint(ok); err != nil {
			t.Errorf("%s: %v", ok, err)
		}
	}
	for _, bad := range []string{
		"",
		"https://fcm.googleapis.com.evil.test/fcm/send/x",
		"https://evilfcm.googleapis.com/x",
		"https://notify.windows.com/x",
		"https://evilpush.apple.com/x",
		"https://.push.apple.com/x",
		"https://a..push.apple.com/x",
		"https://web.push.apple.com./x",
		"http://fcm.googleapis.com/fcm/send/x",
		"https://fcm.googleapis.com:8443/fcm/send/x",
		"https://user:pw@fcm.googleapis.com/fcm/send/x",
		"https://user@fcm.googleapis.com/fcm/send/x",
		"https://142.250.74.106/fcm/send/x",
		"https://[2a00:1450:4001::200a]/fcm/send/x",
		"https://localhost/x",
		"fcm.googleapis.com/fcm/send/x",
		"https:fcm.googleapis.com",
		"https://fcm.googleapis.com/" + strings.Repeat("a", pushMaxEndpoint),
	} {
		if err := validEndpoint(bad); err == nil {
			t.Errorf("%q accepted", bad)
		} else if strings.Contains(err.Error(), "/x") {
			t.Errorf("%q: error names the path: %v", bad, err)
		}
	}
}

func TestPushStoreAddCodes(t *testing.T) {
	s := newTestPushStore(t)
	var ce *codedError
	if err := s.add(pushSub{Endpoint: "https://evil.test/x"}); !errors.As(err, &ce) || ce.code != "invalid_endpoint" || ce.status != 400 {
		t.Fatalf("bad endpoint: %v", err)
	}
	good := fcmSub(t, 1)
	for name, sub := range map[string]pushSub{
		"short p256dh": {Endpoint: good.Endpoint, P256dh: b64url.EncodeToString(make([]byte, 33)), Auth: good.Auth},
		"off curve":    {Endpoint: good.Endpoint, P256dh: b64url.EncodeToString(append([]byte{4}, make([]byte, 64)...)), Auth: good.Auth},
		"not base64":   {Endpoint: good.Endpoint, P256dh: "!!", Auth: good.Auth},
		"short auth":   {Endpoint: good.Endpoint, P256dh: good.P256dh, Auth: b64url.EncodeToString(make([]byte, 15))},
	} {
		if err := s.add(sub); !errors.As(err, &ce) || ce.code != "invalid_keys" {
			t.Errorf("%s: %v", name, err)
		}
	}
	if len(s.list()) != 0 {
		t.Fatal("a refused subscription was stored")
	}
	// Padded base64url, as some browsers' conversions give, is accepted.
	good.Auth += "=="
	if err := s.add(good); err != nil {
		t.Fatal(err)
	}
}

func TestPushStoreUpsertCapReload(t *testing.T) {
	s := newTestPushStore(t)
	testClock(s)
	for i := range pushMaxSubs {
		if err := s.add(fcmSub(t, i)); err != nil {
			t.Fatal(err)
		}
	}
	// An upsert replaces the keys, keeps one entry and renews it.
	renewed := fcmSub(t, 0)
	if err := s.add(renewed); err != nil {
		t.Fatal(err)
	}
	if got := s.list(); len(got) != pushMaxSubs {
		t.Fatalf("%d entries after upsert", len(got))
	}
	// A new device evicts the least recently subscribed one: dev1.
	if err := s.add(fcmSub(t, 99)); err != nil {
		t.Fatal(err)
	}
	got := map[string]pushSub{}
	for _, sub := range s.list() {
		got[sub.Endpoint] = sub
	}
	if len(got) != pushMaxSubs {
		t.Fatalf("%d entries, want %d", len(got), pushMaxSubs)
	}
	if _, ok := got["https://fcm.googleapis.com/fcm/send/dev1"]; ok {
		t.Fatal("the oldest entry was not evicted")
	}
	if e := got["https://fcm.googleapis.com/fcm/send/dev0"]; e.P256dh != renewed.P256dh || e.Gen != s.gen {
		t.Fatalf("upsert not applied: %+v", e)
	}
	if _, ok := got["https://fcm.googleapis.com/fcm/send/dev99"]; !ok {
		t.Fatal("the new entry is missing")
	}

	if err := s.remove("https://fcm.googleapis.com/fcm/send/dev2"); err != nil {
		t.Fatal(err)
	}
	if err := s.drop("https://fcm.googleapis.com/fcm/send/dev3"); err != nil {
		t.Fatal(err)
	}
	if err := s.remove("https://fcm.googleapis.com/fcm/send/unknown"); err != nil {
		t.Fatal(err)
	}

	again, err := newPushStore(s.dir, "admin", "secret", false)
	if err != nil {
		t.Fatal(err)
	}
	if a, b := again.list(), s.list(); len(a) != pushMaxSubs-2 || fmt.Sprint(a) != fmt.Sprint(b) {
		t.Fatalf("reloaded %d entries, differs from memory", len(a))
	}
	pubA, topicA := again.keys()
	pubB, topicB := s.keys()
	if pubA != pubB || string(topicA) != string(topicB) {
		t.Fatal("keys changed on reload")
	}
}

func TestPushStoreKeys(t *testing.T) {
	s := newTestPushStore(t)
	pub, topic := s.keys()
	if len(pub) != 87 || len(topic) != 32 {
		t.Fatalf("public key %d chars, topic key %d bytes", len(pub), len(topic))
	}
	if raw := mustB64(t, pub); len(raw) != 65 || raw[0] != 4 {
		t.Fatal("public key is not an uncompressed P-256 point")
	}
	topic[0] ^= 0xff
	if _, again := s.keys(); again[0] == topic[0] {
		t.Fatal("keys returned the store's own topic key slice")
	}
}

func TestPushStoreModes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix modes")
	}
	s := newTestPushStore(t)
	if err := s.add(fcmSub(t, 1)); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(s.dir); err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode %v %v", fi.Mode(), err)
	}
	for _, name := range []string{vapidFile, pushSubsFile} {
		if fi, err := os.Stat(filepath.Join(s.dir, name)); err != nil || fi.Mode().Perm() != 0o600 {
			t.Fatalf("%s mode %v %v", name, fi.Mode(), err)
		}
	}
	entries, _ := os.ReadDir(s.dir)
	if len(entries) != 2 {
		t.Fatalf("dir holds %d entries, want vapid.json and subscriptions.json", len(entries))
	}
}

func TestPushStoreRefusesSymlinkDir(t *testing.T) {
	base := t.TempDir()
	real := filepath.Join(base, "real")
	if err := os.Mkdir(real, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "push")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlink: %v", err)
	}
	if _, err := newPushStore(link, "admin", "secret", false); err == nil {
		t.Fatal("a symlinked dir was accepted")
	}
	if _, err := os.Stat(filepath.Join(real, vapidFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a key was written through the symlink")
	}
	if _, err := newPushStore("", "admin", "secret", false); err == nil {
		t.Fatal("an empty dir was accepted")
	}
}

func TestPushStoreVapidFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "push")
	s, err := newPushStore(dir, "admin", "secret", false)
	if err != nil {
		t.Fatal(err)
	}
	var k vapidKeys
	data, _ := os.ReadFile(filepath.Join(dir, vapidFile))
	if err := json.Unmarshal(data, &k); err != nil || k.D == "" || k.TopicKey == "" || k.BindKey == "" {
		t.Fatalf("vapid.json %s %v", data, err)
	}
	pub, _ := s.keys()

	for name, content := range map[string]string{
		"not json":     "{",
		"bad scalar":   `{"d":"AAAA","topicKey":"` + k.TopicKey + `","bindKey":"` + k.BindKey + `"}`,
		"no topic key": `{"d":"` + k.D + `","bindKey":"` + k.BindKey + `"}`,
		"not base64":   `{"d":"!!","topicKey":"` + k.TopicKey + `","bindKey":"` + k.BindKey + `"}`,
	} {
		if err := os.WriteFile(filepath.Join(dir, vapidFile), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := newPushStore(dir, "admin", "secret", false); err == nil {
			t.Errorf("%s: corrupt vapid.json accepted", name)
		}
		if got, _ := os.ReadFile(filepath.Join(dir, vapidFile)); string(got) != content {
			t.Errorf("%s: corrupt vapid.json was overwritten", name)
		}
	}

	// The original file loads the same key back.
	if err := os.WriteFile(filepath.Join(dir, vapidFile), data, 0o600); err != nil {
		t.Fatal(err)
	}
	again, err := newPushStore(dir, "admin", "secret", false)
	if err != nil {
		t.Fatal(err)
	}
	if p, _ := again.keys(); p != pub {
		t.Fatal("reloaded a different key")
	}
}

func TestPushStoreCorruptSubscriptions(t *testing.T) {
	s := newTestPushStore(t)
	path := filepath.Join(s.dir, pushSubsFile)
	if err := os.WriteFile(path, []byte("[{"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A crash left a temporary file behind; it is swept.
	part := filepath.Join(s.dir, ".subscriptions-0123456789abcdef.part")
	if err := os.WriteFile(part, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	again, err := newPushStore(s.dir, "admin", "secret", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(again.list()) != 0 {
		t.Fatal("entries from a corrupt file")
	}
	if got, err := os.ReadFile(path + ".bad"); err != nil || string(got) != "[{" {
		t.Fatalf("corrupt file not kept as .bad: %q %v", got, err)
	}
	if _, err := os.Stat(part); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("stale .part not removed")
	}
	if err := again.add(fcmSub(t, 1)); err != nil {
		t.Fatal(err)
	}
	if len(readSubsFile(t, s.dir)) != 1 {
		t.Fatal("store unusable after a corrupt file")
	}
}

func TestPushStoreGenMismatchDrops(t *testing.T) {
	s := newTestPushStore(t)
	if err := s.add(fcmSub(t, 1)); err != nil {
		t.Fatal(err)
	}
	// Same credential: kept.
	if again, err := newPushStore(s.dir, "admin", "secret", false); err != nil || len(again.list()) != 1 {
		t.Fatalf("same credential lost the entry: %v", err)
	}
	// A new password (start --fresh) revokes every device, on disk too.
	fresh, err := newPushStore(s.dir, "admin", "new-secret", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(fresh.list()) != 0 || len(readSubsFile(t, s.dir)) != 0 {
		t.Fatal("an entry of the old password survived")
	}
	// Without auth the gen is fixed; a later password drops those too.
	if err := fresh.add(fcmSub(t, 2)); err != nil {
		t.Fatal(err)
	}
	noAuth, err := newPushStore(s.dir, "", "", true)
	if err != nil || len(noAuth.list()) != 0 || noAuth.gen != pushNoAuthGen {
		t.Fatalf("no-auth kept a password's entry: %v", err)
	}
	if err := noAuth.add(fcmSub(t, 3)); err != nil {
		t.Fatal(err)
	}
	if again, _ := newPushStore(s.dir, "", "", true); len(again.list()) != 1 {
		t.Fatal("no-auth entry lost")
	}
	if again, _ := newPushStore(s.dir, "admin", "new-secret", false); len(again.list()) != 0 {
		t.Fatal("no-auth entry survived a password")
	}
}

func TestPushStoreDropsBadEntriesOnLoad(t *testing.T) {
	s := newTestPushStore(t)
	good := fcmSub(t, 1)
	good.Gen, good.Created = s.gen, time.Now().UTC()
	bad := good
	bad.Endpoint = "https://evil.test/x"
	badKeys := fcmSub(t, 2)
	badKeys.Gen, badKeys.Auth = s.gen, "short"
	data, _ := json.Marshal([]pushSub{good, bad, badKeys})
	if err := os.WriteFile(filepath.Join(s.dir, pushSubsFile), data, 0o600); err != nil {
		t.Fatal(err)
	}
	again, err := newPushStore(s.dir, "admin", "secret", false)
	if err != nil {
		t.Fatal(err)
	}
	if got := again.list(); len(got) != 1 || got[0].Endpoint != good.Endpoint {
		t.Fatalf("kept %+v", got)
	}
	if len(readSubsFile(t, s.dir)) != 1 {
		t.Fatal("the cleaned list was not saved")
	}
}

func TestPushStoreSaveFailureRollsBack(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix modes")
	}
	if os.Geteuid() == 0 {
		t.Skip("root ignores modes")
	}
	s := newTestPushStore(t)
	if err := s.add(fcmSub(t, 1)); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(s.dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(s.dir, 0o700) })
	if err := s.add(fcmSub(t, 2)); err == nil {
		t.Fatal("a save into a read-only dir succeeded")
	}
	if err := s.remove("https://fcm.googleapis.com/fcm/send/dev1"); err == nil {
		t.Fatal("a remove into a read-only dir succeeded")
	}
	if got := s.list(); len(got) != 1 || got[0].Endpoint != "https://fcm.googleapis.com/fcm/send/dev1" {
		t.Fatalf("memory not rolled back: %+v", got)
	}
}

func TestPushStoreConcurrent(t *testing.T) {
	s := newTestPushStore(t)
	subs := make([]pushSub, 30)
	for i := range subs {
		subs[i] = fcmSub(t, i)
	}
	var wg sync.WaitGroup
	for i := range subs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.add(subs[i]); err != nil {
				t.Error(err)
			}
			switch i % 3 {
			case 1:
				if err := s.drop(subs[i].Endpoint); err != nil {
					t.Error(err)
				}
			case 2:
				if err := s.remove(subs[i-1].Endpoint); err != nil {
					t.Error(err)
				}
			}
			s.list()
			s.authorization(subs[i].Endpoint, time.Now())
		}()
	}
	wg.Wait()
	mem := s.list()
	disk := readSubsFile(t, s.dir)
	if len(mem) > pushMaxSubs || fmt.Sprint(mem) != fmt.Sprint(disk) {
		t.Fatalf("memory (%d) and file (%d) differ", len(mem), len(disk))
	}
	seen := map[string]bool{}
	for _, sub := range mem {
		if seen[sub.Endpoint] {
			t.Fatalf("duplicate %s", sub.Endpoint)
		}
		seen[sub.Endpoint] = true
	}
}

func TestPushStoreAuthorizationCache(t *testing.T) {
	s := newTestPushStore(t)
	now := time.Date(2026, 10, 7, 8, 0, 0, 0, time.UTC)
	a := s.authorization("https://fcm.googleapis.com/fcm/send/a", now)
	if a == "" {
		t.Fatal("no token")
	}
	if b := s.authorization("https://fcm.googleapis.com/fcm/send/b", now.Add(10*time.Hour)); b != a {
		t.Fatal("a token for the same origin was not reused")
	}
	if c := s.authorization("https://web.push.apple.com/x", now); c == a || c == "" {
		t.Fatal("another origin shares the token")
	}
	if d := s.authorization("https://fcm.googleapis.com/fcm/send/a", now.Add(11*time.Hour+time.Minute)); d == a || d == "" {
		t.Fatal("a token within an hour of expiry was reused")
	}
	if len(s.tokens) != 1 {
		t.Fatalf("%d cached tokens, the expired ones were not pruned", len(s.tokens))
	}
	if s.authorization("://bad", now) != "" {
		t.Fatal("a token for a bad endpoint")
	}
}

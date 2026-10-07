package main

import (
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// pushMaxSubs devices are kept; a new one evicts the least recently
	// subscribed, which subscribes again on its next visit.
	pushMaxSubs = 20
	// pushMaxEndpoint bytes is the longest endpoint accepted.
	pushMaxEndpoint = 2048
	// pushNoAuthGen binds subscriptions made while the server runs without
	// auth.
	pushNoAuthGen = "no-auth"
	vapidFile     = "vapid.json"
	pushSubsFile  = "subscriptions.json"
)

// pushHosts are the push services browsers use (Chrome, Firefox, Safari);
// pushHostSuffixes match whole labels before them (Apple's, Edge's WNS).
var (
	pushHosts        = map[string]bool{"fcm.googleapis.com": true, "updates.push.services.mozilla.com": true, "web.push.apple.com": true}
	pushHostSuffixes = []string{".push.apple.com", ".notify.windows.com"}
	pushHostRe       = regexp.MustCompile(`^[a-z0-9-]+(\.[a-z0-9-]+)+$`)
	// pushPartRe matches the store's temporary files, left behind by a crash.
	pushPartRe = regexp.MustCompile(`^\.(subscriptions|vapid)-[0-9a-f]{16}\.part$`)
)

var (
	errPushInvalidKeys = &codedError{"invalid_keys", "the subscription keys are not a P-256 key and a 16-byte secret", http.StatusBadRequest}
)

// pushSub is one device's push subscription. Gen ties it to the credential
// it was made with; Created is when it was last subscribed (an upsert renews
// it), the age the cap evicts by.
type pushSub struct {
	Endpoint string    `json:"endpoint"`
	P256dh   string    `json:"p256dh"`
	Auth     string    `json:"auth"`
	Gen      string    `json:"gen"`
	Created  time.Time `json:"created"`
}

// vapidKeys is vapid.json: the VAPID private scalar, the key of the Topic
// header and the key binding subscriptions to the credential, base64url.
type vapidKeys struct {
	D        string `json:"d"`
	TopicKey string `json:"topicKey"`
	BindKey  string `json:"bindKey"`
}

// vapidToken is a signed Authorization header kept until near its expiry:
// Apple asks for a JWT refreshed at most once an hour.
type vapidToken struct {
	header string
	exp    time.Time
}

// pushStore owns <stateDir>/push: the VAPID key pair and the subscriptions.
// Neither file is ever served; only the public key is.
type pushStore struct {
	dir      string
	key      *ecdsa.PrivateKey
	topicKey []byte
	bindKey  []byte
	gen      string
	now      func() time.Time

	// mu covers subs, tokens and every write of subscriptions.json.
	mu     sync.Mutex
	subs   []pushSub
	tokens map[string]vapidToken
}

// newPushStore opens dir (created 0700; a symlink or, on Unix, a dir another
// user owns is refused), loads or creates vapid.json and loads
// subscriptions.json, dropping entries not made with the current credential
// (user and pass, or noAuth) or whose endpoint is no longer accepted.
func newPushStore(dir, user, pass string, noAuth bool) (*pushStore, error) {
	if dir == "" {
		return nil, errors.New("no push state dir")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	// Lstat: a symlink to a dir is refused too.
	if fi, err := os.Lstat(dir); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", dir)
	}
	if err := checkPrivateDir(dir); err != nil {
		return nil, err
	}
	s := &pushStore{dir: dir, now: time.Now, tokens: map[string]vapidToken{}}
	s.removeParts()
	if err := s.loadKeys(); err != nil {
		return nil, err
	}
	s.gen = pushNoAuthGen
	if !noAuth {
		mac := hmac.New(sha256.New, s.bindKey)
		mac.Write([]byte(user + "\x00" + pass))
		s.gen = hex.EncodeToString(mac.Sum(nil))
	}
	if err := s.loadSubs(); err != nil {
		return nil, err
	}
	return s, nil
}

// removeParts deletes temporary files a crash left between write and rename.
func (s *pushStore) removeParts() {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if pushPartRe.MatchString(e.Name()) && e.Type().IsRegular() {
			os.Remove(filepath.Join(s.dir, e.Name()))
		}
	}
}

// loadKeys reads vapid.json, or creates it when missing. A file that cannot
// be read or parsed is never replaced: a new key would silently invalidate
// every device's subscription.
func (s *pushStore) loadKeys() error {
	path := filepath.Join(s.dir, vapidFile)
	data, err := readPushFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s.createKeys(path)
	}
	if err != nil {
		return fmt.Errorf("read %s: %w", vapidFile, err)
	}
	var k vapidKeys
	if err := json.Unmarshal(data, &k); err != nil {
		return fmt.Errorf("%s is corrupt: %w", vapidFile, err)
	}
	d, err1 := decodeB64URL(k.D)
	topic, err2 := decodeB64URL(k.TopicKey)
	bind, err3 := decodeB64URL(k.BindKey)
	if err := errors.Join(err1, err2, err3); err != nil || len(topic) != 32 || len(bind) != 32 {
		return fmt.Errorf("%s is corrupt", vapidFile)
	}
	key, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), d)
	if err != nil {
		return fmt.Errorf("%s is corrupt: %w", vapidFile, err)
	}
	s.key, s.topicKey, s.bindKey = key, topic, bind
	return nil
}

func (s *pushStore) createKeys(path string) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	d, err := key.Bytes()
	if err != nil {
		return err
	}
	topic, bind := make([]byte, 32), make([]byte, 32)
	rand.Read(topic)
	rand.Read(bind)
	data, err := json.Marshal(vapidKeys{b64url.EncodeToString(d), b64url.EncodeToString(topic), b64url.EncodeToString(bind)})
	if err != nil {
		return err
	}
	// The private key is useless to anyone else only if nobody else can read
	// it: an ACL that cannot be set disables push.
	if err := writePushFile(s.dir, "vapid", path, data, true); err != nil {
		return fmt.Errorf("write %s: %w", vapidFile, err)
	}
	s.key, s.topicKey, s.bindKey = key, topic, bind
	return nil
}

// loadSubs reads subscriptions.json. A corrupt file is kept aside as .bad and
// the store starts empty; the devices subscribe again on their next visit.
func (s *pushStore) loadSubs() error {
	path := filepath.Join(s.dir, pushSubsFile)
	data, err := readPushFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read %s: %w", pushSubsFile, err)
	}
	var subs []pushSub
	if err := json.Unmarshal(data, &subs); err != nil {
		log.Printf("push: %s is corrupt, starting without subscriptions: %v", pushSubsFile, err)
		if err := os.Rename(path, path+".bad"); err != nil {
			return fmt.Errorf("move %s aside: %w", pushSubsFile, err)
		}
		return nil
	}
	kept := make([]pushSub, 0, len(subs))
	for _, sub := range subs {
		if sub.Gen == s.gen && validEndpoint(sub.Endpoint) == nil && validSubKeys(sub.P256dh, sub.Auth) {
			kept = append(kept, sub)
		}
	}
	kept = capSubs(kept)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.subs = kept
	if len(kept) == len(subs) {
		return nil
	}
	log.Printf("push: dropped %d subscription(s) of another password or push service", len(subs)-len(kept))
	return s.saveLocked()
}

// readPushFile reads one of the store's files, refusing anything but a
// regular file (a symlink in particular).
func readPushFile(path string) ([]byte, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", filepath.Base(path))
	}
	return os.ReadFile(path)
}

// writePushFile writes data to a new .<prefix>-<random>.part (O_EXCL, 0600,
// owner-only ACL on Windows), syncs it and renames it over path, so a crash
// never leaves half a file. With strict, an ACL that cannot be set fails the
// write; otherwise it is logged.
func writePushFile(dir, prefix, path string, data []byte, strict bool) error {
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
		log.Printf("push: could not restrict permissions of %s: %v", filepath.Base(path), err)
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

// saveLocked writes subs to subscriptions.json; s.mu must be held.
func (s *pushStore) saveLocked() error {
	data, err := json.Marshal(s.subs)
	if err != nil {
		return err
	}
	return writePushFile(s.dir, "subscriptions", filepath.Join(s.dir, pushSubsFile), data, false)
}

// commitLocked makes next the subscriptions and saves them, putting the
// previous ones back when the save fails; s.mu must be held.
func (s *pushStore) commitLocked(next []pushSub) error {
	prev := s.subs
	s.subs = next
	if err := s.saveLocked(); err != nil {
		s.subs = prev
		return err
	}
	return nil
}

// validEndpoint accepts only an https URL on port 443, without userinfo, of
// a known push service named by host (never an IP literal); the endpoint
// otherwise lets a client make the server POST anywhere. Its errors name at
// most the host: the path is the device's capability.
func validEndpoint(raw string) error {
	if raw == "" || len(raw) > pushMaxEndpoint {
		return errors.New("the endpoint is empty or longer than 2048 bytes")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" {
		return errors.New("the endpoint is not a URL")
	}
	if u.Scheme != "https" {
		return errors.New("the endpoint is not https")
	}
	if u.User != nil {
		return errors.New("the endpoint carries a user name")
	}
	if p := u.Port(); p != "" && p != "443" {
		return errors.New("the endpoint is not on port 443")
	}
	host := strings.ToLower(u.Hostname())
	if _, err := netip.ParseAddr(host); err == nil || strings.HasPrefix(u.Host, "[") {
		return errors.New("the endpoint's host is an IP address")
	}
	if !pushHostRe.MatchString(host) {
		return errors.New("the endpoint's host is not a host name")
	}
	if pushHosts[host] {
		return nil
	}
	for _, suffix := range pushHostSuffixes {
		if strings.HasSuffix(host, suffix) {
			return nil
		}
	}
	return fmt.Errorf("%s is not a supported push service", host)
}

// validSubKeys reports whether p256dh is a P-256 public key (65 bytes,
// uncompressed) and auth a 16-byte secret, both base64url.
func validSubKeys(p256dh, auth string) bool {
	pub, err := decodeB64URL(p256dh)
	if err != nil || len(pub) != 65 {
		return false
	}
	if _, err := ecdh.P256().NewPublicKey(pub); err != nil {
		return false
	}
	a, err := decodeB64URL(auth)
	return err == nil && len(a) == 16
}

// capSubs keeps the pushMaxSubs most recently subscribed entries.
func capSubs(subs []pushSub) []pushSub {
	if len(subs) <= pushMaxSubs {
		return subs
	}
	sort.SliceStable(subs, func(i, j int) bool { return subs[i].Created.After(subs[j].Created) })
	return subs[:pushMaxSubs]
}

// add stores sub, or renews the entry with its endpoint, bound to the
// current credential. Its errors are codedErrors (invalid_endpoint,
// invalid_keys) except a failed save.
func (s *pushStore) add(sub pushSub) error {
	if err := validEndpoint(sub.Endpoint); err != nil {
		return &codedError{"invalid_endpoint", err.Error(), http.StatusBadRequest}
	}
	if !validSubKeys(sub.P256dh, sub.Auth) {
		return errPushInvalidKeys
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sub.Gen = s.gen
	sub.Created = s.now().UTC()
	next := make([]pushSub, 0, len(s.subs)+1)
	for _, old := range s.subs {
		if old.Endpoint != sub.Endpoint {
			next = append(next, old)
		}
	}
	next = capSubs(append(next, sub))
	return s.commitLocked(next)
}

// remove deletes the subscription with endpoint (a device unsubscribing or
// logging out); unknown endpoints are not an error.
func (s *pushStore) remove(endpoint string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := make([]pushSub, 0, len(s.subs))
	for _, sub := range s.subs {
		if sub.Endpoint != endpoint {
			next = append(next, sub)
		}
	}
	if len(next) == len(s.subs) {
		return nil
	}
	return s.commitLocked(next)
}

// drop removes a subscription its push service reported gone (404, 410).
func (s *pushStore) drop(endpoint string) error {
	return s.remove(endpoint)
}

// list returns a copy of the subscriptions.
func (s *pushStore) list() []pushSub {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]pushSub(nil), s.subs...)
}

// keys returns the VAPID public key as base64url (the PWA's
// applicationServerKey, 87 characters) and the key of the Topic header.
func (s *pushStore) keys() (publicKey string, topicKey []byte) {
	pub, err := s.key.PublicKey.Bytes()
	if err != nil {
		// Never happens: the key was parsed or generated on P-256.
		panic(err)
	}
	return b64url.EncodeToString(pub), append([]byte(nil), s.topicKey...)
}

// authorization returns vapidAuthorization for endpoint, reusing a token for
// the same origin until it has less than an hour left.
func (s *pushStore) authorization(endpoint string, now time.Time) string {
	aud, err := vapidAudience(endpoint)
	if err != nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if t, ok := s.tokens[aud]; ok && now.Before(t.exp.Add(-time.Hour)) {
		return t.header
	}
	header := vapidAuthorization(s.key, endpoint, now)
	if header == "" {
		return ""
	}
	for a, t := range s.tokens {
		if !now.Before(t.exp.Add(-time.Hour)) {
			delete(s.tokens, a)
		}
	}
	s.tokens[aud] = vapidToken{header, now.Add(vapidTTL)}
	return header
}

package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"regexp"
	"strings"
	"testing"
	"time"
)

func mustB64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := decodeB64URL(s)
	if err != nil {
		t.Fatalf("decode %q: %v", s, err)
	}
	return b
}

// The RFC 8291 Appendix A example, byte for byte.
func TestEncryptPayloadRFC8291Vector(t *testing.T) {
	asPriv, err := ecdh.P256().NewPrivateKey(mustB64(t, "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"))
	if err != nil {
		t.Fatal(err)
	}
	wantAsPub := mustB64(t, "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8")
	if !bytes.Equal(asPriv.PublicKey().Bytes(), wantAsPub) {
		t.Fatal("as_public does not match the vector")
	}
	uaPub := mustB64(t, "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")
	auth := mustB64(t, "BTBZMqHH6r4Tts7J_aSIgg")
	salt := mustB64(t, "DGv6ra1nlYgDCS1FRnbzlw")
	want := mustB64(t, "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")

	got, err := encryptPayload([]byte("When I grow up, I want to be a watermelon"), uaPub, auth, asPriv, salt)
	if err != nil {
		t.Fatal(err)
	}
	// 86-byte header + 41-byte plaintext + delimiter + 16-byte tag.
	if len(want) != 144 || !bytes.Equal(got, want) {
		t.Fatalf("body = %s (%d bytes), want the RFC vector (144 bytes)", b64url.EncodeToString(got), len(got))
	}

	// The receiving side decrypts it with ua_private.
	uaPriv, err := ecdh.P256().NewPrivateKey(mustB64(t, "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"))
	if err != nil {
		t.Fatal(err)
	}
	if plain := decryptPushForTest(t, got, uaPriv, auth); string(plain) != "When I grow up, I want to be a watermelon" {
		t.Fatalf("decrypted %q", plain)
	}
}

// decryptPushForTest is the user agent's side of RFC 8291 for one record.
func decryptPushForTest(t *testing.T, body []byte, uaPriv *ecdh.PrivateKey, auth []byte) []byte {
	t.Helper()
	if len(body) < pushHeaderLen || binary.BigEndian.Uint32(body[16:20]) != pushRecordSize || body[20] != 65 {
		t.Fatalf("bad header %x", body[:min(len(body), pushHeaderLen)])
	}
	salt, asPubRaw := body[:16], body[21:86]
	asPub, err := ecdh.P256().NewPublicKey(asPubRaw)
	if err != nil {
		t.Fatal(err)
	}
	secret, err := uaPriv.ECDH(asPub)
	if err != nil {
		t.Fatal(err)
	}
	ikm, _ := hkdf.Key(sha256.New, secret, auth, "WebPush: info\x00"+string(uaPriv.PublicKey().Bytes())+string(asPubRaw), 32)
	prk, _ := hkdf.Extract(sha256.New, ikm, salt)
	cek, _ := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	nonce, _ := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)
	block, _ := aes.NewCipher(cek)
	gcm, _ := cipher.NewGCM(block)
	rec, err := gcm.Open(nil, nonce, body[pushHeaderLen:], nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if len(rec) == 0 || rec[len(rec)-1] != 0x02 {
		t.Fatalf("record does not end with the last-record delimiter: %x", rec)
	}
	return rec[:len(rec)-1]
}

func TestEncryptPayloadRejects(t *testing.T) {
	ua, _ := ecdh.P256().GenerateKey(rand.Reader)
	as, _ := ecdh.P256().GenerateKey(rand.Reader)
	x25519, _ := ecdh.X25519().GenerateKey(rand.Reader)
	uaPub, auth, salt := ua.PublicKey().Bytes(), make([]byte, 16), make([]byte, 16)
	for name, call := range map[string]func() ([]byte, error){
		"too large": func() ([]byte, error) {
			return encryptPayload(make([]byte, pushMaxPayload+1), uaPub, auth, as, salt)
		},
		"short auth": func() ([]byte, error) { return encryptPayload(nil, uaPub, auth[:15], as, salt) },
		"short salt": func() ([]byte, error) { return encryptPayload(nil, uaPub, auth, as, salt[:8]) },
		"bad p256dh": func() ([]byte, error) { return encryptPayload(nil, uaPub[:33], auth, as, salt) },
		"not P-256":  func() ([]byte, error) { return encryptPayload(nil, uaPub, auth, x25519, salt) },
		"nil key":    func() ([]byte, error) { return encryptPayload(nil, uaPub, auth, nil, salt) },
		"off-curve ua": func() ([]byte, error) {
			return encryptPayload(nil, append([]byte{4}, make([]byte, 64)...), auth, as, salt)
		},
	} {
		if _, err := call(); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
	// The largest payload still fits one 4096-byte body.
	body, err := encryptPayload(make([]byte, pushMaxPayload), uaPub, auth, as, salt)
	if err != nil || len(body) != pushRecordSize {
		t.Fatalf("max payload: %d bytes, %v", len(body), err)
	}
}

func TestEncryptPayloadSealPushIsRandom(t *testing.T) {
	ua, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := make([]byte, 16)
	rand.Read(auth)
	a, err := sealPush([]byte(`{"kind":"done"}`), ua.PublicKey().Bytes(), auth)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := sealPush([]byte(`{"kind":"done"}`), ua.PublicKey().Bytes(), auth)
	if bytes.Equal(a[:16], b[:16]) || bytes.Equal(a[21:86], b[21:86]) {
		t.Fatal("salt or ephemeral key repeated")
	}
	if got := decryptPushForTest(t, a, ua, auth); string(got) != `{"kind":"done"}` {
		t.Fatalf("decrypted %q", got)
	}
}

func TestVapidAuthorization(t *testing.T) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_800_000_000, 0)
	h := vapidAuthorization(priv, "https://fcm.googleapis.com:443/fcm/send/abc?x=1", now)
	m := regexp.MustCompile(`^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]{87})$`).FindStringSubmatch(h)
	if m == nil {
		t.Fatalf("header %q", h)
	}
	var hdr map[string]string
	if err := json.Unmarshal(mustB64(t, m[1]), &hdr); err != nil || hdr["alg"] != "ES256" || hdr["typ"] != "JWT" {
		t.Fatalf("JWT header %v %v", hdr, err)
	}
	var claims struct {
		Aud string `json:"aud"`
		Exp int64  `json:"exp"`
		Sub string `json:"sub"`
	}
	if err := json.Unmarshal(mustB64(t, m[2]), &claims); err != nil {
		t.Fatal(err)
	}
	if claims.Aud != "https://fcm.googleapis.com" || claims.Sub != vapidSubject || claims.Exp != now.Add(12*time.Hour).Unix() {
		t.Fatalf("claims %+v", claims)
	}
	if claims.Exp > now.Add(24*time.Hour).Unix() {
		t.Fatal("exp more than 24h ahead")
	}
	sig := mustB64(t, m[3])
	if len(sig) != 64 {
		t.Fatalf("signature is %d bytes, want raw r||s", len(sig))
	}
	pub, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), mustB64(t, m[4]))
	if err != nil || !pub.Equal(&priv.PublicKey) {
		t.Fatalf("k is not the VAPID public key: %v", err)
	}
	digest := sha256.Sum256([]byte(m[1] + "." + m[2]))
	r, s := new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])
	if !ecdsa.Verify(pub, digest[:], r, s) {
		t.Fatal("signature does not verify")
	}
	if vapidAuthorization(priv, "not a url", now) != "" {
		t.Fatal("a relative endpoint got a token")
	}
}

func TestVapidAudience(t *testing.T) {
	for in, want := range map[string]string{
		"https://web.push.apple.com/QGx":          "https://web.push.apple.com",
		"https://FCM.googleapis.com:443/wp/x":     "https://fcm.googleapis.com",
		"https://127.0.0.1:8443/push":             "https://127.0.0.1:8443",
		"https://wns2-by3p.notify.windows.com/w/": "https://wns2-by3p.notify.windows.com",
	} {
		if got, err := vapidAudience(in); err != nil || got != want {
			t.Errorf("%s: %q %v, want %q", in, got, err, want)
		}
	}
}

func TestPushTopic(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	a := pushTopic(key, "%3", "blocked")
	if len(a) != 32 || !regexp.MustCompile(`^[A-Za-z0-9_-]{32}$`).MatchString(a) {
		t.Fatalf("topic %q", a)
	}
	if pushTopic(key, "%3", "blocked") != a {
		t.Fatal("topic is not stable")
	}
	if pushTopic(key, "%3", "done") == a || pushTopic(key, "%4", "blocked") == a {
		t.Fatal("topic does not depend on pane and kind")
	}
	if pushTopic(bytes.Repeat([]byte{8}, 32), "%3", "blocked") == a {
		t.Fatal("topic does not depend on the key")
	}
}

func TestPushRetryAfter(t *testing.T) {
	now := time.Date(2026, 10, 7, 8, 0, 0, 0, time.UTC)
	for in, want := range map[string]time.Duration{
		"":                              0,
		"junk":                          0,
		"-5":                            0,
		"0":                             0,
		"120":                           2 * time.Minute,
		" 30 ":                          30 * time.Second,
		"7200":                          time.Hour,
		"99999999999999999999":          0,
		"Wed, 07 Oct 2026 08:10:00 GMT": 10 * time.Minute,
		"Wed, 07 Oct 2026 07:00:00 GMT": 0,
		"Thu, 08 Oct 2026 08:00:00 GMT": time.Hour,
	} {
		if got := parseRetryAfter(in, now); got != want {
			t.Errorf("%q: %v, want %v", in, got, want)
		}
	}
}

func TestPushDialCheck(t *testing.T) {
	for _, addr := range []string{
		"127.0.0.1:443", "[::1]:443", "10.1.2.3:443", "172.16.0.1:443", "192.168.1.1:443",
		"169.254.169.254:443", "[fe80::1]:443", "100.64.0.1:443", "100.100.100.100:443",
		"100.127.255.255:443", "[fc00::1]:443", "[fd12::1]:443", "0.0.0.0:443", "[::]:443",
		"0.1.2.3:443", "224.0.0.1:443", "[ff02::1]:443", "[::ffff:127.0.0.1]:443",
		"[::ffff:8.8.8.8]:443", "not-an-address:443",
	} {
		if err := pushDialCheck("tcp", addr, nil); err == nil {
			t.Errorf("tcp %s: allowed", addr)
		}
		network := "tcp4"
		if strings.HasPrefix(addr, "[") {
			network = "tcp6"
		}
		if err := pushDialCheck(network, addr, nil); err == nil {
			t.Errorf("%s: allowed", addr)
		}
	}
	for _, addr := range []string{"142.250.74.106:443", "100.128.0.1:443", "[2a00:1450:4001::200a]:443"} {
		network := "tcp4"
		if strings.HasPrefix(addr, "[") {
			network = "tcp6"
		}
		if err := pushDialCheck(network, addr, nil); err != nil {
			t.Errorf("%s: %v", addr, err)
		}
	}
	if err := pushDialCheck("udp4", "142.250.74.106:443", nil); err == nil {
		t.Error("udp allowed")
	}
	if !blockedPushAddr(netip.Addr{}) {
		t.Error("zero address allowed")
	}
}

// pushTestServer is an httptest TLS server the push client reaches with the
// allowlist and the dial check out of the way.
func pushTestServer(t *testing.T, h http.HandlerFunc) (*httptest.Server, *http.Client) {
	t.Helper()
	srv := httptest.NewTLSServer(h)
	t.Cleanup(srv.Close)
	oldCheck, oldDial := pushEndpointCheck, pushDialControl
	pushEndpointCheck, pushDialControl = func(string) error { return nil }, nil
	t.Cleanup(func() { pushEndpointCheck, pushDialControl = oldCheck, oldDial })
	client := pushHTTPClient()
	client.Transport.(*http.Transport).TLSClientConfig = srv.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	return srv, client
}

// testPushSub is a subscription with real keys; the private key decrypts
// what was sent.
func testPushSub(t *testing.T, endpoint string) (pushSub, *ecdh.PrivateKey, []byte) {
	t.Helper()
	ua, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	rand.Read(auth)
	return pushSub{Endpoint: endpoint, P256dh: b64url.EncodeToString(ua.PublicKey().Bytes()), Auth: b64url.EncodeToString(auth)}, ua, auth
}

func TestSendPushStatuses(t *testing.T) {
	store := newTestPushStore(t)
	for _, tc := range []struct {
		status     int
		retryAfter string
		wantRetry  time.Duration
	}{
		{201, "", 0}, {404, "", 0}, {410, "", 0}, {401, "", 0}, {403, "", 0},
		{429, "90", 90 * time.Second}, {429, "86400", time.Hour}, {413, "", 0},
	} {
		var got *http.Request
		var body []byte
		srv, client := pushTestServer(t, func(w http.ResponseWriter, r *http.Request) {
			got = r
			body, _ = io.ReadAll(r.Body)
			if tc.retryAfter != "" {
				w.Header().Set("Retry-After", tc.retryAfter)
			}
			w.WriteHeader(tc.status)
			w.Write(bytes.Repeat([]byte("x"), 64<<10))
		})
		sub, ua, auth := testPushSub(t, srv.URL+"/fcm/send/abc")
		topic := pushTopic(bytes.Repeat([]byte{1}, 32), "%1", "blocked")
		status, retry, err := sendPush(context.Background(), client, store, sub, []byte(`{"paneId":"%1"}`), topic)
		if err != nil || status != tc.status || retry != tc.wantRetry {
			t.Fatalf("%d: status %d retry %v err %v", tc.status, status, retry, err)
		}
		if got.Method != http.MethodPost || got.URL.Path != "/fcm/send/abc" {
			t.Fatalf("%s %s", got.Method, got.URL)
		}
		for k, v := range map[string]string{
			"Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
			"Ttl": "3600", "Urgency": "high", "Topic": topic,
		} {
			if got.Header.Get(k) != v {
				t.Fatalf("%s = %q, want %q", k, got.Header.Get(k), v)
			}
		}
		pub, _ := store.keys()
		if a := got.Header.Get("Authorization"); !strings.HasPrefix(a, "vapid t=") || !strings.HasSuffix(a, ", k="+pub) {
			t.Fatalf("Authorization %q", a)
		}
		if plain := decryptPushForTest(t, body, ua, auth); string(plain) != `{"paneId":"%1"}` {
			t.Fatalf("payload %q", plain)
		}
	}
}

func TestSendPushChecksEndpoint(t *testing.T) {
	store := newTestPushStore(t)
	called := false
	srv := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	defer srv.Close()
	sub, _, _ := testPushSub(t, srv.URL+"/push")
	if _, _, err := sendPush(context.Background(), srv.Client(), store, sub, []byte("{}"), ""); err == nil || called {
		t.Fatalf("an endpoint off the allowlist was sent to: %v", err)
	}
	sub, _, _ = testPushSub(t, "https://fcm.googleapis.com/fcm/send/x")
	sub.P256dh = "!!"
	if _, _, err := sendPush(context.Background(), srv.Client(), store, sub, []byte("{}"), ""); err == nil {
		t.Fatal("bad p256dh sent")
	}
}

func TestPushHTTPClientRefusesLoopback(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(201) }))
	defer srv.Close()
	client := pushHTTPClient()
	client.Transport.(*http.Transport).TLSClientConfig = srv.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	resp, err := client.Post(srv.URL, "application/octet-stream", nil)
	if err == nil {
		resp.Body.Close()
		t.Fatal("dialled a loopback address")
	}
	if !strings.Contains(err.Error(), "non-public address") {
		t.Fatalf("err = %v", err)
	}
}

func TestPushHTTPClientNoRedirectNoProxy(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	followed := false
	var srv *httptest.Server
	srv, client := pushTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/next" {
			followed = true
			return
		}
		http.Redirect(w, r, srv.URL+"/next", http.StatusTemporaryRedirect)
	})
	store := newTestPushStore(t)
	sub, _, _ := testPushSub(t, srv.URL+"/push")
	status, _, err := sendPush(context.Background(), client, store, sub, []byte("{}"), "")
	if err != nil || status != http.StatusTemporaryRedirect || followed {
		t.Fatalf("status %d err %v followed %v", status, err, followed)
	}
	if client.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("the push client uses a proxy")
	}
}

func TestSendPushContextTimeout(t *testing.T) {
	release := make(chan struct{})
	srv, client := pushTestServer(t, func(http.ResponseWriter, *http.Request) { <-release })
	defer close(release)
	store := newTestPushStore(t)
	sub, _, _ := testPushSub(t, srv.URL+"/push")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, _, err := sendPush(ctx, client, store, sub, []byte("{}"), ""); err == nil {
		t.Fatal("no error past the deadline")
	}
}

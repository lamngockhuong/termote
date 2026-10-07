package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Web Push (RFC 8030) with aes128gcm payload encryption (RFC 8291) and VAPID
// (RFC 8292), built on the standard library alone.
const (
	// vapidSubject is the JWT's sub: push services contact it about abuse.
	vapidSubject = "https://termote.ohnice.app"
	// vapidTTL is how long a JWT stays valid; Apple refuses more than 24h.
	vapidTTL = 12 * time.Hour
	// pushTTL is how long a push service keeps an undelivered message, in
	// seconds: a stale "needs you" alert has no value.
	pushTTL = "3600"
	// pushRecordSize is the rs of the single aes128gcm record; the header and
	// the sealed record together stay under it, as push services require.
	pushRecordSize = 4096
	// pushHeaderLen is salt (16) + rs (4) + idlen (1) + keyid (65).
	pushHeaderLen = 16 + 4 + 1 + 65
	// pushMaxPayload is the largest plaintext one record carries: the body
	// is header + plaintext + delimiter + GCM tag.
	pushMaxPayload = pushRecordSize - pushHeaderLen - 1 - 16
	// pushMaxResponse bytes of a push service's reply are read, then dropped.
	pushMaxResponse = 4 << 10
	// pushMaxRetryAfter caps a push service's Retry-After.
	pushMaxRetryAfter = time.Hour
)

var b64url = base64.RawURLEncoding

// decodeB64URL decodes base64url with or without padding, as browsers and
// libraries differ.
func decodeB64URL(s string) ([]byte, error) {
	return b64url.DecodeString(strings.TrimRight(s, "="))
}

// encryptPayload seals plain for the subscription keys uaPub (p256dh, a
// 65-byte uncompressed P-256 point) and auth (16 bytes), with the ephemeral
// key asPriv and the 16-byte salt, into one aes128gcm record (RFC 8291 §3-4).
// The returned body is the 86-byte header followed by the sealed record.
func encryptPayload(plain, uaPub, auth []byte, asPriv *ecdh.PrivateKey, salt []byte) ([]byte, error) {
	if len(plain) > pushMaxPayload {
		return nil, fmt.Errorf("push payload is %d bytes, at most %d fit", len(plain), pushMaxPayload)
	}
	if len(auth) != 16 {
		return nil, errors.New("push auth secret is not 16 bytes")
	}
	if len(salt) != 16 {
		return nil, errors.New("push salt is not 16 bytes")
	}
	if asPriv == nil || asPriv.Curve() != ecdh.P256() {
		return nil, errors.New("push key is not a P-256 key")
	}
	ua, err := ecdh.P256().NewPublicKey(uaPub)
	if err != nil {
		return nil, fmt.Errorf("push p256dh: %w", err)
	}
	secret, err := asPriv.ECDH(ua)
	if err != nil {
		return nil, err
	}
	asPub := asPriv.PublicKey().Bytes()
	keyInfo := "WebPush: info\x00" + string(uaPub) + string(asPub)
	ikm, err := hkdf.Key(sha256.New, secret, auth, keyInfo, 32)
	if err != nil {
		return nil, err
	}
	prk, err := hkdf.Extract(sha256.New, ikm, salt)
	if err != nil {
		return nil, err
	}
	cek, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	if err != nil {
		return nil, err
	}
	nonce, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	body := make([]byte, 0, pushHeaderLen+len(plain)+1+gcm.Overhead())
	body = append(body, salt...)
	body = binary.BigEndian.AppendUint32(body, pushRecordSize)
	body = append(body, byte(len(asPub)))
	body = append(body, asPub...)
	// 0x02 marks the last (and only) record; no padding follows. The record
	// sequence number is 0, so the nonce is used as it is.
	record := append(append(make([]byte, 0, len(plain)+1), plain...), 0x02)
	return gcm.Seal(body, nonce, record, nil), nil
}

// sealPush is encryptPayload with a new ephemeral key and salt, as every
// message needs.
func sealPush(plain, uaPub, auth []byte) ([]byte, error) {
	asPriv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	salt := make([]byte, 16)
	rand.Read(salt) // never fails: crypto/rand crashes the program instead
	return encryptPayload(plain, uaPub, auth, asPriv, salt)
}

// vapidAudience is the origin of a push endpoint, the JWT's aud.
func vapidAudience(endpoint string) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", errors.New("push endpoint is not an absolute URL")
	}
	host := strings.ToLower(u.Host)
	if u.Port() == "443" && u.Scheme == "https" {
		host = strings.ToLower(u.Hostname())
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
	}
	return u.Scheme + "://" + host, nil
}

// vapidAuthorization returns the Authorization header for endpoint: an ES256
// JWT (aud = the endpoint's origin, exp = now+12h, sub = vapidSubject) and
// the public key, both base64url. It returns "" when the endpoint is not an
// absolute URL or the key cannot sign.
func vapidAuthorization(priv *ecdsa.PrivateKey, endpoint string, now time.Time) string {
	aud, err := vapidAudience(endpoint)
	if err != nil {
		return ""
	}
	pub, err := priv.PublicKey.Bytes()
	if err != nil {
		return ""
	}
	claims, err := json.Marshal(struct {
		Aud string `json:"aud"`
		Exp int64  `json:"exp"`
		Sub string `json:"sub"`
	}{aud, now.Add(vapidTTL).Unix(), vapidSubject})
	if err != nil {
		return ""
	}
	input := b64url.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`)) + "." + b64url.EncodeToString(claims)
	digest := sha256.Sum256([]byte(input))
	r, s, err := ecdsa.Sign(rand.Reader, priv, digest[:])
	if err != nil {
		return ""
	}
	// A JWT carries the raw r||s form, 32 bytes each, not ASN.1.
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return "vapid t=" + input + "." + b64url.EncodeToString(sig) + ", k=" + b64url.EncodeToString(pub)
}

// pushTopic is the Topic header of a pane's event: a pending message with the
// same topic replaces the older one while the device is offline. It is keyed
// with a random topicKey, so the push service learns neither the pane id nor
// the kind; 24 bytes give the 32 base64url characters the header allows.
func pushTopic(topicKey []byte, paneID, kind string) string {
	mac := hmac.New(sha256.New, topicKey)
	mac.Write([]byte(paneID + "|" + kind))
	return b64url.EncodeToString(mac.Sum(nil)[:24])
}

// pushEndpointCheck is validEndpoint; tests swap it to reach an httptest
// server.
var pushEndpointCheck = validEndpoint

// sendPush encrypts payload for sub, signs the request with the store's
// VAPID key and POSTs it to the subscription's endpoint, which is checked
// against the allowlist again first. It returns the push service's status
// and, when given, its Retry-After (at most an hour); the caller decides what
// a status means for the subscription. ctx bounds the whole request.
func sendPush(ctx context.Context, client *http.Client, s *pushStore, sub pushSub, payload []byte, topic string) (status int, retryAfter time.Duration, err error) {
	if err := pushEndpointCheck(sub.Endpoint); err != nil {
		return 0, 0, err
	}
	uaPub, err := decodeB64URL(sub.P256dh)
	if err != nil {
		return 0, 0, errors.New("push p256dh is not base64url")
	}
	auth, err := decodeB64URL(sub.Auth)
	if err != nil {
		return 0, 0, errors.New("push auth is not base64url")
	}
	body, err := sealPush(payload, uaPub, auth)
	if err != nil {
		return 0, 0, err
	}
	authz := s.authorization(sub.Endpoint, time.Now())
	if authz == "" {
		return 0, 0, errors.New("push: could not sign the VAPID token")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, sub.Endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, 0, err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("TTL", pushTTL)
	// high for every kind, so the header does not tell which one it is.
	req.Header.Set("Urgency", "high")
	if topic != "" {
		req.Header.Set("Topic", topic)
	}
	req.Header.Set("Authorization", authz)
	resp, err := client.Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, pushMaxResponse))
	return resp.StatusCode, parseRetryAfter(resp.Header.Get("Retry-After"), time.Now()), nil
}

// parseRetryAfter reads a Retry-After value, seconds or an HTTP date, capped
// at pushMaxRetryAfter; 0 when absent, invalid or past.
func parseRetryAfter(v string, now time.Time) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	var d time.Duration
	if secs, err := strconv.ParseInt(v, 10, 64); err == nil {
		if secs <= 0 {
			return 0
		}
		if secs > int64(pushMaxRetryAfter/time.Second) {
			return pushMaxRetryAfter
		}
		d = time.Duration(secs) * time.Second
	} else if t, err := http.ParseTime(v); err == nil {
		d = t.Sub(now)
	} else {
		return 0
	}
	return max(0, min(d, pushMaxRetryAfter))
}

// cgnatPrefix (100.64.0.0/10) and thisNetPrefix (0.0.0.0/8) are not covered
// by netip's own predicates.
var (
	cgnatPrefix   = netip.MustParsePrefix("100.64.0.0/10")
	thisNetPrefix = netip.MustParsePrefix("0.0.0.0/8")
)

// blockedPushAddr reports whether a push request must not go to addr: any
// loopback, private, link-local, CGNAT, unique-local, unspecified or
// multicast address, and any IPv4-mapped IPv6 one.
func blockedPushAddr(addr netip.Addr) bool {
	if !addr.IsValid() || addr.Is4In6() {
		return true
	}
	return addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast() ||
		addr.IsLinkLocalMulticast() || addr.IsInterfaceLocalMulticast() || addr.IsMulticast() ||
		addr.IsUnspecified() || cgnatPrefix.Contains(addr) || thisNetPrefix.Contains(addr)
}

// pushDialCheck is net.Dialer.Control for push requests: it runs on the
// address actually dialled, after DNS resolution, so a rebinding answer
// cannot reach a local or private host.
func pushDialCheck(network, address string, _ syscall.RawConn) error {
	if network != "tcp4" && network != "tcp6" {
		return fmt.Errorf("push: refusing to dial over %s", network)
	}
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return fmt.Errorf("push: refusing to dial %q", address)
	}
	if blockedPushAddr(ap.Addr()) {
		return fmt.Errorf("push: refusing to dial a non-public address %s", ap.Addr())
	}
	return nil
}

// pushDialControl is the dial check pushHTTPClient installs; tests clear it
// to reach an httptest server on loopback.
var pushDialControl = pushDialCheck

// pushHTTPClient is the client push requests go through: no proxy (the IP
// check must see the real peer), no redirects (the allowlist names the only
// hosts a push may reach), and the dial check above. It has no overall
// timeout; each request's ctx bounds it.
func pushHTTPClient() *http.Client {
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second, Control: pushDialControl}
	return &http.Client{
		Transport: &http.Transport{
			Proxy:               nil,
			DialContext:         dialer.DialContext,
			ForceAttemptHTTP2:   true,
			TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12},
			TLSHandshakeTimeout: 5 * time.Second,
			MaxIdleConns:        8,
			IdleConnTimeout:     90 * time.Second,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

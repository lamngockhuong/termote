package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// A token is single use across browsers: the second browser that posts it
// gets the expired page, no cookie, and no second session is made.
func TestLoginLinkTokenSingleUseAcrossBrowsers(t *testing.T) {
	h, _ := newSigninServer(t, false)
	token := newLink(t, h)
	a := postLink(h, url.Values{"t": {token}, "hash": {"#/s/main/0"}}, nil)
	if a.Code != http.StatusOK || sessionCookieOf(a) == nil {
		t.Fatalf("first browser: %d", a.Code)
	}
	b := postLink(h, url.Values{"t": {token}, "hash": {"#/s/main/0"}}, func(r *http.Request) {
		r.Header.Set("User-Agent", "Other browser")
	})
	if b.Code != http.StatusUnauthorized || sessionCookieOf(b) != nil || !strings.Contains(b.Body.String(), "sign-in link has expired") {
		t.Errorf("second browser: %d %s", b.Code, b.Body)
	}
	list := listSignins(t, h, asDevice("GET", "/api/mux/signins", "", sessionCookieOf(a)))
	if len(list) != 1 || list[0].Via != sessionViaLink {
		t.Errorf("sessions after two browsers: %+v", list)
	}
}

// The CLI runs six times quickly: the first token is pushed out by the cap,
// the five newer ones each sign a browser in.
func TestLoginLinkCapOverHTTP(t *testing.T) {
	h, _ := newSigninServer(t, false)
	var tokens []string
	for range maxLoginLinks + 1 {
		tokens = append(tokens, newLink(t, h))
	}
	if rec := postLink(h, url.Values{"t": {tokens[0]}}, nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("oldest of six: %d, want 401", rec.Code)
	}
	for i, tok := range tokens[1:] {
		if rec := postLink(h, url.Values{"t": {tok}}, nil); rec.Code != http.StatusOK {
			t.Errorf("token %d of the last five: %d", i+2, rec.Code)
		}
	}
	// A refused link does not lock the password sign-in either.
	if c := signIn(t, h, "Password"); c == nil {
		t.Error("password sign-in after the cap")
	}
}

// The deep link the CLI writes (encodeURIComponent escapes, Herdr-style ids
// with a colon, and a view) reaches the browser unchanged in the meta
// refresh and the Continue link.
func TestLoginLinkHashEscapesRoundTrip(t *testing.T) {
	h, _ := newSigninServer(t, false)
	for _, hash := range []string{
		"#/s/w1/w1%3At1",
		"#/s/w1/w1%3At1/w1%3Ap2?view=chat",
		"#/s/main/0?view=files",
	} {
		rec := postLink(h, url.Values{"t": {newLink(t, h)}, "hash": {hash}}, nil)
		body := rec.Body.String()
		want := "/" + hash
		if rec.Code != http.StatusOK || !strings.Contains(body, `content="0;url=`+want+`"`) || !strings.Contains(body, `href="`+want+`"`) {
			t.Errorf("hash %q: %d\n%s", hash, rec.Code, body)
		}
	}
}

// A body past the 8 KB form limit is refused before the token is read, so
// the token still works for the browser that sends a sane request.
func TestLoginLinkBodyOverLimit(t *testing.T) {
	h, _ := newSigninServer(t, false)
	token := newLink(t, h)
	rec := postLink(h, url.Values{"t": {token}, "pad": {strings.Repeat("a", maxLoginBody+1)}}, nil)
	if rec.Code != http.StatusBadRequest || sessionCookieOf(rec) != nil {
		t.Fatalf("oversized body: %d", rec.Code)
	}
	if rec := postLink(h, url.Values{"t": {token}}, nil); rec.Code != http.StatusOK {
		t.Errorf("token spent by an oversized body: %d", rec.Code)
	}
}

// A view-only device cannot make a link: the write role check comes first.
func TestLoginLinksRefusesViewDevice(t *testing.T) {
	h, _ := newSigninServer(t, true)
	c := pairDevice(t, h, "view")
	rec := serve(h, asDevice("POST", loginLinksRoute, "{}", c))
	if body := decodeBody(t, rec); rec.Code != http.StatusForbidden || body["code"] != "view_only" {
		t.Errorf("view device: %d %v", rec.Code, body)
	}
}

// A session signed in by a link lists as via=link and is revoked like any
// other: its open terminal closes and its cookie stops working.
func TestLinkSessionRevocableAndClosesStream(t *testing.T) {
	h, attached := newSigninServer(t, false)
	srv := httptest.NewServer(h)
	defer srv.Close()
	owner := signIn(t, h, "Owner")
	rec := postLink(h, url.Values{"t": {newLink(t, h)}, "hash": {"#/s/main/0"}}, nil)
	linked := sessionCookieOf(rec)
	if rec.Code != http.StatusOK || linked == nil {
		t.Fatalf("link sign-in: %d", rec.Code)
	}
	ws := openSessionStream(t, srv, linked, attached)

	var id string
	for _, s := range listSignins(t, h, asDevice("GET", "/api/mux/signins", "", owner)) {
		if s.Via == sessionViaLink {
			id = s.ID
		}
	}
	if id == "" {
		t.Fatal("link session not listed")
	}
	if rec := serve(h, asDevice("DELETE", "/api/mux/signins/"+id, "", owner)); rec.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", rec.Code, rec.Body)
	}
	wantSignedOutClose(t, ws)
	if code := signedInCode(h, linked); code != http.StatusUnauthorized {
		t.Errorf("revoked link session: %d", code)
	}
}

// A token an unauthenticated POST sends with a foreign Origin is refused
// before it is read: a token is never spent by another site.
func TestLoginLinkForeignOriginKeepsToken(t *testing.T) {
	h, _ := newSigninServer(t, false)
	token := newLink(t, h)
	rec := postLink(h, url.Values{"t": {token}}, func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") })
	if rec.Code != http.StatusForbidden {
		t.Fatalf("foreign origin: %d", rec.Code)
	}
	if rec := postLink(h, url.Values{"t": {token}}, nil); rec.Code != http.StatusOK {
		t.Errorf("token spent by a foreign origin: %d", rec.Code)
	}
}

// Two browsers posting the same token at once: exactly one redeems it.
func TestLoginLinkConcurrentRedeemOnce(t *testing.T) {
	s := newLoginLinkStore()
	token, err := s.generate()
	if err != nil {
		t.Fatal(err)
	}
	var wins atomic.Int32
	var wg sync.WaitGroup
	for range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, ok := s.consume(token); ok {
				wins.Add(1)
			}
		}()
	}
	wg.Wait()
	if wins.Load() != 1 {
		t.Errorf("token redeemed %d times", wins.Load())
	}
}

// The deep link is kept up to maxLinkHash bytes including the #, and only
// its own characters: a second # (which encodeURIComponent never leaves)
// is dropped.
func TestSafeLinkHashBounds(t *testing.T) {
	exact := "#" + strings.Repeat("a", maxLinkHash-1)
	if got := safeLinkHash(exact); got != exact {
		t.Errorf("exact-size link dropped")
	}
	for _, bad := range []string{exact + "a", "#/s/a#b", "#/s/a\nb", "#/s/a+b"} {
		if got := safeLinkHash(bad); got != "" {
			t.Errorf("safeLinkHash(%q) = %q, want dropped", bad, got)
		}
	}
}

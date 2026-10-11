package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"slices"
	"time"
)

// How a password session signed in.
const (
	sessionViaForm  = "form"
	sessionViaBasic = "basic"
)

const (
	// sessionTouchEvery bounds how often a session's lastUsedAt moves: a
	// browser polls every few seconds.
	sessionTouchEvery = time.Minute
	// maxSessionUA caps the User-Agent kept for a session, in bytes.
	maxSessionUA = 200
)

// sessionMeta is what the sign-in list shows of a session. Its fields are
// written under the session store's lock only.
type sessionMeta struct {
	id         string
	createdAt  time.Time
	lastUsedAt time.Time
	via        string
	ip         string
	userAgent  string
}

// sessionID names a session in the list and the logs: the first 16 hex of
// its token's SHA-256, never the token.
func sessionID(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:8])
}

// cleanUserAgent keeps a User-Agent safe to list: no control, bidi or
// zero-width characters, at most maxSessionUA bytes.
func cleanUserAgent(ua string) string {
	return capBytes(stripUnsafeRunes(ua), maxSessionUA)
}

// sessionAuth holds the password sessions (cookie termote_session, in
// memory, sessionTTL) and what a revoke ends besides the cookie: the
// session's stream tokens and open streams.
type sessionAuth struct {
	store  *tokenStore
	tokens *tokenStore // stream tokens
	hub    *streamHub
	now    func() time.Time
}

func newSessionAuth(tokens *tokenStore, hub *streamHub) *sessionAuth {
	store := newTokenStore(sessionTTL, false)
	store.max = maxSessions
	s := &sessionAuth{store: store, tokens: tokens, hub: hub, now: time.Now}
	if hub != nil {
		hub.sessionAlive = s.alive
	}
	return s
}

// start makes a session for r and returns its token.
func (s *sessionAuth) start(r *http.Request, via string) (string, error) {
	now := s.now()
	token, err := s.store.generateGrant(roleFull, "", "")
	if err != nil {
		return "", err
	}
	meta := &sessionMeta{id: sessionID(token), createdAt: now, lastUsedAt: now, via: via,
		ip: requestIP(r), userAgent: cleanUserAgent(r.UserAgent())}
	s.store.mu.Lock()
	if ti, ok := s.store.tokens[token]; ok {
		ti.session = meta
		s.store.tokens[token] = ti
	}
	s.store.mu.Unlock()
	return token, nil
}

// lookup returns the id of the session token names, or ok false, and moves
// its lastUsedAt at most each sessionTouchEvery.
func (s *sessionAuth) lookup(token string) (id string, ok bool) {
	ti, ok := s.store.check(token)
	if !ok || ti.session == nil {
		return "", false
	}
	now := s.now()
	s.store.mu.Lock()
	if now.Sub(ti.session.lastUsedAt) >= sessionTouchEvery {
		ti.session.lastUsedAt = now
	}
	s.store.mu.Unlock()
	return ti.session.id, true
}

// alive reports whether session id still exists (not revoked, expired or
// pushed out).
func (s *sessionAuth) alive(id string) bool {
	now := s.now()
	s.store.mu.RLock()
	defer s.store.mu.RUnlock()
	for _, ti := range s.store.tokens {
		if ti.session != nil && ti.session.id == id && !now.After(ti.exp) {
			return true
		}
	}
	return false
}

// signinView is one session as GET /api/mux/signins lists it.
type signinView struct {
	ID         string    `json:"id"`
	CreatedAt  time.Time `json:"createdAt"`
	LastUsedAt time.Time `json:"lastUsedAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
	Via        string    `json:"via"`
	IP         string    `json:"ip"`
	UserAgent  string    `json:"userAgent"`
	Current    bool      `json:"current"`
}

// list returns the live sessions, the most recently used first; current is
// the caller's session id ("" for none).
func (s *sessionAuth) list(current string) []signinView {
	now := s.now()
	out := []signinView{}
	s.store.mu.RLock()
	for _, ti := range s.store.tokens {
		m := ti.session
		if m == nil || now.After(ti.exp) {
			continue
		}
		out = append(out, signinView{ID: m.id, CreatedAt: m.createdAt.UTC(), LastUsedAt: m.lastUsedAt.UTC(),
			ExpiresAt: ti.exp.UTC(), Via: m.via, IP: m.ip, UserAgent: m.userAgent, Current: m.id == current})
	}
	s.store.mu.RUnlock()
	slices.SortFunc(out, func(a, b signinView) int {
		if c := b.LastUsedAt.Compare(a.LastUsedAt); c != 0 {
			return c
		}
		return b.CreatedAt.Compare(a.CreatedAt)
	})
	return out
}

// revoke ends session id: removed from the store first, then its stream
// tokens and open streams. It reports whether the session existed.
func (s *sessionAuth) revoke(id string) bool {
	ids := s.remove(func(m *sessionMeta) bool { return m.id == id })
	s.end(ids)
	return len(ids) > 0
}

// revokeOthers ends every session but keep ("" ends them all) and returns
// the ids ended.
func (s *sessionAuth) revokeOthers(keep string) []string {
	ids := s.remove(func(m *sessionMeta) bool { return m.id != keep })
	s.end(ids)
	return ids
}

// revokeToken ends the session token names (Log out), if any.
func (s *sessionAuth) revokeToken(token string) {
	s.revoke(sessionID(token))
}

// remove deletes the sessions match picks and returns their ids, sorted.
// The hub asks alive under its own lock, and the sessions are gone before
// end takes it: a stream that was opening is closed either way.
func (s *sessionAuth) remove(match func(*sessionMeta) bool) []string {
	ids := []string{}
	s.store.mu.Lock()
	for k, ti := range s.store.tokens {
		if ti.session != nil && match(ti.session) {
			delete(s.store.tokens, k)
			ids = append(ids, ti.session.id)
		}
	}
	s.store.mu.Unlock()
	slices.Sort(ids)
	return ids
}

// end drops the stream tokens of the sessions ids and closes their streams
// (one still opening is refused by the hub's sessionAlive check).
func (s *sessionAuth) end(ids []string) {
	for _, id := range ids {
		if s.tokens != nil {
			s.tokens.revokeSession(id)
		}
		if s.hub != nil {
			s.hub.closeSession(id)
		}
	}
}

package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"sync"
	"time"
)

// An agent's proposal of PWA settings (termote settings propose): the
// newest one only, in memory, for settingsProposalTTL. Each device shows it
// and the user applies it there; the server never learns a device's
// settings.
const (
	settingsProposalTTL = 15 * time.Minute
	// settingsPushEvery: at most one push for proposals in this time, so an
	// agent fixing its proposal and sending it again does not ring the
	// phone each time.
	settingsPushEvery = 5 * time.Minute
)

type settingsProposal struct {
	ID        string
	Values    map[string]json.RawMessage
	CreatedAt time.Time
	ExpiresAt time.Time
}

// settingsProposalRef is what the snapshot says of the proposal.
type settingsProposalRef struct {
	ID        string `json:"id"`
	ExpiresAt string `json:"expiresAt"`
}

type settingsProposals struct {
	mu       sync.Mutex
	now      func() time.Time
	current  *settingsProposal
	lastPush time.Time
	// notify is told of a new proposal, at most once per settingsPushEvery
	// (the push watcher; nil without Web Push).
	notify func()
}

func newSettingsProposals() *settingsProposals {
	return &settingsProposals{now: time.Now}
}

// put keeps values as the proposal, in place of any before it.
func (s *settingsProposals) put(values map[string]json.RawMessage) settingsProposal {
	b := make([]byte, 8)
	rand.Read(b)
	// Round(0): the expiry is compared on the wall clock, which goes on
	// while the machine sleeps, as the PWA's does.
	now := s.now().Round(0)
	p := settingsProposal{ID: hex.EncodeToString(b), Values: values, CreatedAt: now, ExpiresAt: now.Add(settingsProposalTTL)}
	s.mu.Lock()
	s.current = &p
	notify := s.notify != nil && (s.lastPush.IsZero() || now.Sub(s.lastPush) >= settingsPushEvery)
	if notify {
		s.lastPush = now
	}
	fn := s.notify
	s.mu.Unlock()
	if notify {
		fn()
	}
	return p
}

// get is the proposal, or nil when there is none or it expired.
func (s *settingsProposals) get() *settingsProposal {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current == nil {
		return nil
	}
	if !s.now().Round(0).Before(s.current.ExpiresAt) {
		s.current = nil
		return nil
	}
	p := *s.current
	return &p
}

// ref is the snapshot's settingsProposal, nil without a proposal.
func (s *settingsProposals) ref() *settingsProposalRef {
	p := s.get()
	if p == nil {
		return nil
	}
	return &settingsProposalRef{ID: p.ID, ExpiresAt: p.ExpiresAt.UTC().Format(time.RFC3339)}
}

func (s *settingsProposals) setNotify(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.notify = fn
}

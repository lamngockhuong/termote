package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Pairing codes: short, single-use, held in memory only. A device created by
// one goes to the store; the code itself is never stored in the clear.
const (
	pairCodeLen   = 10 // Crockford base32: 50 bits
	pairCodeTTL   = 5 * time.Minute
	maxPairCodes  = 5
	pairAlphabet  = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	pairCodeGroup = 5 // shown as XXXXX-XXXXX
)

var errTooManyCodes = &codedError{code: "too_many_codes", msg: "too many pairing codes waiting; use one or wait 5 minutes", status: http.StatusConflict}

// pendingPair is what a code pairs: the role, the name its maker gave (may
// be empty), the device that made it ("" for a password session or the
// CLI), whose revoke drops the code, and how long the new device is valid
// once paired (0: no limit).
type pendingPair struct {
	role     role
	name     string
	creator  string
	validFor time.Duration
	exp      time.Time
}

type pairCodes struct {
	mu    sync.Mutex
	codes map[string]pendingPair // hash of the normalized code → pending
	now   func() time.Time
	// alive, when set, reports whether a device can still make codes. It
	// is asked under mu, and a revoke marks the device gone before
	// dropCreator takes mu, so a code made while its maker is revoked is
	// either refused or dropped.
	alive func(id string) bool
}

func newPairCodes() *pairCodes {
	return &pairCodes{codes: map[string]pendingPair{}, now: time.Now}
}

func hashPairCode(code string) string {
	h := sha256.Sum256([]byte(code))
	return hex.EncodeToString(h[:])
}

// sweepLocked forgets expired codes.
func (p *pairCodes) sweepLocked() {
	now := p.now()
	for k, v := range p.codes {
		if !now.Before(v.exp) {
			delete(p.codes, k)
		}
	}
}

// create makes a code for a device of role r named name (checked by the
// caller), valid for validFor once paired, and returns it as shown
// (XXXXX-XXXXX) with its expiry.
func (p *pairCodes) create(r role, name, creator string, validFor time.Duration) (string, time.Time, error) {
	if r != roleFull && r != roleView {
		return "", time.Time{}, errInvalidRole
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if creator != "" && p.alive != nil && !p.alive(creator) {
		return "", time.Time{}, errCreatorGone
	}
	p.sweepLocked()
	if len(p.codes) >= maxPairCodes {
		return "", time.Time{}, errTooManyCodes
	}
	b := make([]byte, pairCodeLen)
	rand.Read(b)
	code := make([]byte, pairCodeLen)
	for i, v := range b {
		code[i] = pairAlphabet[v&31]
	}
	exp := p.now().Add(pairCodeTTL)
	p.codes[hashPairCode(string(code))] = pendingPair{role: r, name: name, creator: creator, validFor: validFor, exp: exp}
	return string(code[:pairCodeGroup]) + "-" + string(code[pairCodeGroup:]), exp, nil
}

// waiting reports whether any code can be redeemed: without one, a guess is
// answered at once and not counted as a failed attempt.
func (p *pairCodes) waiting() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sweepLocked()
	return len(p.codes) > 0
}

// redeem uses a code once: it is gone whether or not the pairing then
// succeeds.
func (p *pairCodes) redeem(code string) (pendingPair, bool) {
	code, ok := normalizePairCode(code)
	if !ok {
		return pendingPair{}, false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sweepLocked()
	k := hashPairCode(code)
	v, ok := p.codes[k]
	if ok {
		delete(p.codes, k)
	}
	return v, ok
}

// dropCreator forgets the codes a device made (it was revoked).
func (p *pairCodes) dropCreator(id string) {
	if id == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for k, v := range p.codes {
		if v.creator == id {
			delete(p.codes, k)
		}
	}
}

// normalizePairCode reads a typed code: dashes and spaces dropped, upper
// case, O read as 0 and I or L as 1 (Crockford). Anything else is no code.
func normalizePairCode(s string) (string, bool) {
	var b strings.Builder
	for _, r := range strings.ToUpper(s) {
		switch {
		case r == '-' || r == ' ':
			continue
		case r == 'O':
			r = '0'
		case r == 'I' || r == 'L':
			r = '1'
		}
		if !strings.ContainsRune(pairAlphabet, r) {
			return "", false
		}
		b.WriteRune(r)
		if b.Len() > pairCodeLen {
			return "", false
		}
	}
	return b.String(), b.Len() == pairCodeLen
}

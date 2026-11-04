import { describe, expect, it } from 'vitest'
import type { FileDiff } from '../hooks/use-mux-api'
import { HEAD_FILES } from './fixtures/changes'
import { FILES } from './fixtures/files'
import { ACME_ROOT } from './fixtures/workspace'
import { diffHunks } from './line-diff'

// git's own diffs of the demo repo (video/capture/demo-env.sh), less the
// hunk ids the demo does not give
const GIT: Record<string, Omit<FileDiff, 'root'>> = {
  'auth/login.go': {
    path: 'auth/login.go',
    truncated: false,
    hunks: [
      {
        header: '@@ -2,9 +2,14 @@ package auth',
        lines: [
          { kind: 'ctx', old: 2, 'new': 2, text: '' },
          { kind: 'ctx', old: 3, 'new': 3, text: 'import (' },
          { kind: 'ctx', old: 4, 'new': 4, text: '\t"encoding/json"' },
          { kind: 'add', 'new': 5, text: '\t"net"' },
          { kind: 'ctx', old: 5, 'new': 6, text: '\t"net/http"' },
          { kind: 'add', 'new': 7, text: '\t"time"' },
          { kind: 'ctx', old: 6, 'new': 8, text: ')' },
          { kind: 'ctx', old: 7, 'new': 9, text: '' },
          {
            kind: 'add',
            'new': 10,
            text: '// Five attempts a minute per client address.',
          },
          {
            kind: 'add',
            'new': 11,
            text: 'var attempts = newLimiter(5, time.Minute)',
          },
          { kind: 'add', 'new': 12, text: '' },
          { kind: 'ctx', old: 8, 'new': 13, text: 'type credentials struct {' },
          {
            kind: 'ctx',
            old: 9,
            'new': 14,
            text: '\tUser     string `json:"user"`',
          },
          {
            kind: 'ctx',
            old: 10,
            'new': 15,
            text: '\tPassword string `json:"password"`',
          },
        ],
        id: '083ab1f9ef40e19155c5926889cecc26dc613a4754ccebf9bbadfe0f3a97eb24',
      },
      {
        header: '@@ -12,6 +17,11 @@ type credentials struct {',
        lines: [
          { kind: 'ctx', old: 12, 'new': 17, text: '' },
          {
            kind: 'ctx',
            old: 13,
            'new': 18,
            text: "// Login checks a user's password and starts a session.",
          },
          {
            kind: 'ctx',
            old: 14,
            'new': 19,
            text: 'func Login(w http.ResponseWriter, r *http.Request) {',
          },
          {
            kind: 'add',
            'new': 20,
            text: '\taddr, _, _ := net.SplitHostPort(r.RemoteAddr)',
          },
          { kind: 'add', 'new': 21, text: '\tif !attempts.allow(addr) {' },
          {
            kind: 'add',
            'new': 22,
            text: '\t\thttp.Error(w, "too many attempts", http.StatusTooManyRequests)',
          },
          { kind: 'add', 'new': 23, text: '\t\treturn' },
          { kind: 'add', 'new': 24, text: '\t}' },
          { kind: 'ctx', old: 15, 'new': 25, text: '\tvar c credentials' },
          {
            kind: 'ctx',
            old: 16,
            'new': 26,
            text: '\tif err := json.NewDecoder(r.Body).Decode(&c); err != nil {',
          },
          {
            kind: 'ctx',
            old: 17,
            'new': 27,
            text: '\t\thttp.Error(w, "bad request", http.StatusBadRequest)',
          },
        ],
        id: '4e7a0238516c3f7b42f70ab9236815a4bae912180e8129c4eb03455e4a3fa9b4',
      },
    ],
    worktreeHash:
      'e70821e1a96a99060a3e5d618b9c212937e70a444c3862328fcf89b053c283f2',
  },
  'auth/login_test.go': {
    path: 'auth/login_test.go',
    truncated: false,
    hunks: [
      {
        header: '@@ -5,6 +5,7 @@ import (',
        lines: [
          { kind: 'ctx', old: 5, 'new': 5, text: '\t"net/http/httptest"' },
          { kind: 'ctx', old: 6, 'new': 6, text: '\t"strings"' },
          { kind: 'ctx', old: 7, 'new': 7, text: '\t"testing"' },
          { kind: 'add', 'new': 8, text: '\t"time"' },
          { kind: 'ctx', old: 8, 'new': 9, text: ')' },
          { kind: 'ctx', old: 9, 'new': 10, text: '' },
          {
            kind: 'ctx',
            old: 10,
            'new': 11,
            text: 'func TestLoginRejectsWrongPassword(t *testing.T) {',
          },
        ],
        id: '385ee84e5351731ced23f94ec3feaf7ab5028f22a6d6e2f67e89adfab79c9f1d',
      },
      {
        header:
          '@@ -15,3 +16,15 @@ func TestLoginRejectsWrongPassword(t *testing.T) {',
        lines: [
          {
            kind: 'ctx',
            old: 15,
            'new': 16,
            text: '\t\tt.Fatalf("got %d", w.Code)',
          },
          { kind: 'ctx', old: 16, 'new': 17, text: '\t}' },
          { kind: 'ctx', old: 17, 'new': 18, text: '}' },
          { kind: 'add', 'new': 19, text: '' },
          {
            kind: 'add',
            'new': 20,
            text: 'func TestLoginLimitsAttempts(t *testing.T) {',
          },
          {
            kind: 'add',
            'new': 21,
            text: '\tattempts = newLimiter(5, time.Minute)',
          },
          { kind: 'add', 'new': 22, text: '\tfor i := 0; i < 6; i++ {' },
          {
            kind: 'add',
            'new': 23,
            text: '\t\tr := httptest.NewRequest("POST", "/login", strings.NewReader(`{"user":"demo","password":"x"}`))',
          },
          { kind: 'add', 'new': 24, text: '\t\tw := httptest.NewRecorder()' },
          { kind: 'add', 'new': 25, text: '\t\tLogin(w, r)' },
          {
            kind: 'add',
            'new': 26,
            text: '\t\tif i == 5 && w.Code != http.StatusTooManyRequests {',
          },
          {
            kind: 'add',
            'new': 27,
            text: '\t\t\tt.Fatalf("6th attempt: got %d", w.Code)',
          },
          { kind: 'add', 'new': 28, text: '\t\t}' },
          { kind: 'add', 'new': 29, text: '\t}' },
          { kind: 'add', 'new': 30, text: '}' },
        ],
        id: '04777e6d58249cb70ceeb3549aeb6069ae544e7018e602904ab2c3b16b82dc24',
      },
    ],
    worktreeHash:
      '2586f66faa6a167d5b39151941f739fe6a823b651214f7dc32444c272486ac1e',
  },
  'auth/ratelimit.go': {
    path: 'auth/ratelimit.go',
    truncated: false,
    hunks: [
      {
        header: '@@ -0,0 +1,37 @@',
        lines: [
          { kind: 'add', 'new': 1, text: 'package auth' },
          { kind: 'add', 'new': 2, text: '' },
          { kind: 'add', 'new': 3, text: 'import (' },
          { kind: 'add', 'new': 4, text: '\t"sync"' },
          { kind: 'add', 'new': 5, text: '\t"time"' },
          { kind: 'add', 'new': 6, text: ')' },
          { kind: 'add', 'new': 7, text: '' },
          {
            kind: 'add',
            'new': 8,
            text: '// limiter allows max attempts per window for each client address.',
          },
          { kind: 'add', 'new': 9, text: 'type limiter struct {' },
          { kind: 'add', 'new': 10, text: '\tmu     sync.Mutex' },
          { kind: 'add', 'new': 11, text: '\tmax    int' },
          { kind: 'add', 'new': 12, text: '\twindow time.Duration' },
          { kind: 'add', 'new': 13, text: '\thits   map[string][]time.Time' },
          { kind: 'add', 'new': 14, text: '}' },
          { kind: 'add', 'new': 15, text: '' },
          {
            kind: 'add',
            'new': 16,
            text: 'func newLimiter(max int, window time.Duration) *limiter {',
          },
          {
            kind: 'add',
            'new': 17,
            text: '\treturn &limiter{max: max, window: window, hits: map[string][]time.Time{}}',
          },
          { kind: 'add', 'new': 18, text: '}' },
          { kind: 'add', 'new': 19, text: '' },
          {
            kind: 'add',
            'new': 20,
            text: '// allow records an attempt from addr and reports whether it is within the limit.',
          },
          {
            kind: 'add',
            'new': 21,
            text: 'func (l *limiter) allow(addr string) bool {',
          },
          { kind: 'add', 'new': 22, text: '\tl.mu.Lock()' },
          { kind: 'add', 'new': 23, text: '\tdefer l.mu.Unlock()' },
          { kind: 'add', 'new': 24, text: '\tnow := time.Now()' },
          { kind: 'add', 'new': 25, text: '\tkept := l.hits[addr][:0]' },
          {
            kind: 'add',
            'new': 26,
            text: '\tfor _, t := range l.hits[addr] {',
          },
          { kind: 'add', 'new': 27, text: '\t\tif now.Sub(t) < l.window {' },
          { kind: 'add', 'new': 28, text: '\t\t\tkept = append(kept, t)' },
          { kind: 'add', 'new': 29, text: '\t\t}' },
          { kind: 'add', 'new': 30, text: '\t}' },
          { kind: 'add', 'new': 31, text: '\tif len(kept) >= l.max {' },
          { kind: 'add', 'new': 32, text: '\t\tl.hits[addr] = kept' },
          { kind: 'add', 'new': 33, text: '\t\treturn false' },
          { kind: 'add', 'new': 34, text: '\t}' },
          {
            kind: 'add',
            'new': 35,
            text: '\tl.hits[addr] = append(kept, now)',
          },
          { kind: 'add', 'new': 36, text: '\treturn true' },
          { kind: 'add', 'new': 37, text: '}' },
        ],
      },
    ],
  },
}
describe('diffHunks', () => {
  for (const path of Object.keys(GIT)) {
    it(`matches git for ${path}`, () => {
      const old = HEAD_FILES[path] ?? ''
      const hunks = diffHunks(old, FILES[`${ACME_ROOT}/${path}`])
      expect(hunks).toEqual(
        GIT[path].hunks?.map(({ header, lines }) => ({ header, lines })),
      )
    })
  }

  it('has no hunk for equal texts', () => {
    expect(diffHunks('a\nb\n', 'a\nb\n')).toEqual([])
  })

  it('removes a whole file', () => {
    expect(diffHunks('a\nb\n', '')).toEqual([
      {
        header: '@@ -1,2 +0,0 @@',
        lines: [
          { kind: 'del', old: 1, text: 'a' },
          { kind: 'del', old: 2, text: 'b' },
        ],
      },
    ])
  })

  it('marks a last line without a newline', () => {
    const [h] = diffHunks('a\n', 'a\nb')
    expect(h.lines.at(-1)).toEqual({
      kind: 'add',
      new: 2,
      text: 'b',
      noNewline: true,
    })
  })

  it('tells a last line that gained its newline', () => {
    expect(diffHunks('a\nb', 'a\nb\n')).toEqual([
      {
        header: '@@ -1,2 +1,2 @@',
        lines: [
          { kind: 'ctx', old: 1, new: 1, text: 'a' },
          { kind: 'del', old: 2, text: 'b', noNewline: true },
          { kind: 'add', new: 2, text: 'b' },
        ],
      },
    ])
  })

  it('splits changes far apart into hunks', () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n') + '\n'
    const changed = old.replace('l1\n', 'x\n').replace('l18\n', 'y\n')
    const hunks = diffHunks(old, changed)
    expect(hunks.map((h) => h.header)).toEqual([
      '@@ -1,5 +1,5 @@',
      '@@ -16,5 +16,5 @@ l14',
    ])
  })
})

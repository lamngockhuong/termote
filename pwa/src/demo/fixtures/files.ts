// The demo workspace's files, as video/capture/demo-env.sh writes them:
// acme-api, a small Go API with the agent's edits uncommitted, and web.
// Keyed by absolute path; the in-memory store (../state.ts) starts from it.
import { ACME_ROOT, WEB_ROOT } from './workspace'

export const FILES: Record<string, string> = {
  [`${ACME_ROOT}/.claude/commands/review.md`]:
    '---\ndescription: Review the uncommitted changes\n---\nReview the diff.\n',
  [`${ACME_ROOT}/.claude/commands/ship.md`]:
    '---\ndescription: Run the tests, commit and open a pull request\n---\nShip it.\n',
  [`${ACME_ROOT}/Makefile`]:
    'run:\n\tgo run .\n\nlint:\n\tgo vet ./...\n\nmigrate:\n\t@echo "migrations: up to date"\n',
  [`${ACME_ROOT}/README.md`]:
    '# acme-api\n\nA small HTTP API: sign-in, sessions and rate limiting.\n\n## How a sign-in flows\n\n```mermaid\nflowchart TD\n    C[Client] -->|POST /login| L{Rate limit}\n    L -->|over 5/min| R[429 Too Many Requests]\n    L -->|ok| P[Check password]\n    P -->|wrong| U[401]\n    P -->|right| S[Start session]\n```\n\n## Run\n\n```sh\ngo run .\ngo test ./...\n```\n',
  [`${ACME_ROOT}/auth/login.go`]:
    'package auth\n\nimport (\n\t"encoding/json"\n\t"net"\n\t"net/http"\n\t"time"\n)\n\n// Five attempts a minute per client address.\nvar attempts = newLimiter(5, time.Minute)\n\ntype credentials struct {\n\tUser     string `json:"user"`\n\tPassword string `json:"password"`\n}\n\n// Login checks a user\'s password and starts a session.\nfunc Login(w http.ResponseWriter, r *http.Request) {\n\taddr, _, _ := net.SplitHostPort(r.RemoteAddr)\n\tif !attempts.allow(addr) {\n\t\thttp.Error(w, "too many attempts", http.StatusTooManyRequests)\n\t\treturn\n\t}\n\tvar c credentials\n\tif err := json.NewDecoder(r.Body).Decode(&c); err != nil {\n\t\thttp.Error(w, "bad request", http.StatusBadRequest)\n\t\treturn\n\t}\n\tif !checkPassword(c.User, c.Password) {\n\t\thttp.Error(w, "unauthorized", http.StatusUnauthorized)\n\t\treturn\n\t}\n\tstartSession(w, c.User)\n}\n\nfunc checkPassword(user, password string) bool { return user == "demo" && password == "demo" }\n\nfunc startSession(w http.ResponseWriter, user string) {\n\thttp.SetCookie(w, &http.Cookie{Name: "session", Value: user, HttpOnly: true})\n}\n',
  [`${ACME_ROOT}/auth/login_test.go`]:
    'package auth\n\nimport (\n\t"net/http"\n\t"net/http/httptest"\n\t"strings"\n\t"testing"\n\t"time"\n)\n\nfunc TestLoginRejectsWrongPassword(t *testing.T) {\n\tr := httptest.NewRequest("POST", "/login", strings.NewReader(`{"user":"demo","password":"x"}`))\n\tw := httptest.NewRecorder()\n\tLogin(w, r)\n\tif w.Code != http.StatusUnauthorized {\n\t\tt.Fatalf("got %d", w.Code)\n\t}\n}\n\nfunc TestLoginLimitsAttempts(t *testing.T) {\n\tattempts = newLimiter(5, time.Minute)\n\tfor i := 0; i < 6; i++ {\n\t\tr := httptest.NewRequest("POST", "/login", strings.NewReader(`{"user":"demo","password":"x"}`))\n\t\tw := httptest.NewRecorder()\n\t\tLogin(w, r)\n\t\tif i == 5 && w.Code != http.StatusTooManyRequests {\n\t\t\tt.Fatalf("6th attempt: got %d", w.Code)\n\t\t}\n\t}\n}\n',
  [`${ACME_ROOT}/auth/ratelimit.go`]:
    'package auth\n\nimport (\n\t"sync"\n\t"time"\n)\n\n// limiter allows max attempts per window for each client address.\ntype limiter struct {\n\tmu     sync.Mutex\n\tmax    int\n\twindow time.Duration\n\thits   map[string][]time.Time\n}\n\nfunc newLimiter(max int, window time.Duration) *limiter {\n\treturn &limiter{max: max, window: window, hits: map[string][]time.Time{}}\n}\n\n// allow records an attempt from addr and reports whether it is within the limit.\nfunc (l *limiter) allow(addr string) bool {\n\tl.mu.Lock()\n\tdefer l.mu.Unlock()\n\tnow := time.Now()\n\tkept := l.hits[addr][:0]\n\tfor _, t := range l.hits[addr] {\n\t\tif now.Sub(t) < l.window {\n\t\t\tkept = append(kept, t)\n\t\t}\n\t}\n\tif len(kept) >= l.max {\n\t\tl.hits[addr] = kept\n\t\treturn false\n\t}\n\tl.hits[addr] = append(kept, now)\n\treturn true\n}\n',
  [`${ACME_ROOT}/go.mod`]: 'module acme-api\n\ngo 1.26\n',
  [`${ACME_ROOT}/main.go`]:
    'package main\n\nimport (\n\t"log"\n\t"net/http"\n\n\t"acme-api/auth"\n)\n\nfunc main() {\n\tmux := http.NewServeMux()\n\tmux.HandleFunc("POST /login", auth.Login)\n\tlog.Println("listening on :8080")\n\tlog.Fatal(http.ListenAndServe(":8080", mux))\n}\n',
  [`${WEB_ROOT}/package.json`]:
    '{\n  "name": "web",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "dev": "vite",\n    "build": "vite build",\n    "test": "vitest run"\n  }\n}\n',
  [`${WEB_ROOT}/README.md`]:
    '# web\n\nThe sign-in page of acme-api.\n\n```sh\npnpm dev\n```\n',
  [`${WEB_ROOT}/src/login-form.tsx`]:
    'export function LoginForm({ error }: { error?: string }) {\n  return (\n    <form method="post" action="/login">\n      <input name="user" autoComplete="username" />\n      <input name="password" type="password" autoComplete="current-password" />\n      {error && <p role="alert">{error}</p>}\n      <button type="submit">Sign in</button>\n    </form>\n  )\n}\n',
}

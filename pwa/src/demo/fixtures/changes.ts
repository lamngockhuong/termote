// acme-api's git history: its one commit, as the server answered for the
// demo repo, and the committed text of the files the agent has changed since
// (the rest are as in ./files.ts).
import type { CommitInfo } from '../../hooks/use-mux-api'

export const LAST_COMMIT: CommitInfo = {
  hash: '1523727971343629dabea05781a55ad6e3095141',
  parents: [],
  author: 'Dev',
  time: 1793777270,
  message: 'feat: sign-in endpoint',
  files: [
    { path: '.claude/commands/review.md', status: 'A', sensitive: false },
    { path: '.claude/commands/ship.md', status: 'A', sensitive: false },
    { path: 'Makefile', status: 'A', sensitive: false },
    { path: 'README.md', status: 'A', sensitive: false },
    { path: 'auth/login.go', status: 'A', sensitive: false },
    { path: 'auth/login_test.go', status: 'A', sensitive: false },
    { path: 'go.mod', status: 'A', sensitive: false },
    { path: 'main.go', status: 'A', sensitive: false },
  ],
  truncated: false,
}

// The committed text of the files the agent changed, which a discard puts
// back and the last commit's diff shows
export const HEAD_FILES: Record<string, string> = {
  'auth/login.go':
    'package auth\n\nimport (\n\t"encoding/json"\n\t"net/http"\n)\n\ntype credentials struct {\n\tUser     string `json:"user"`\n\tPassword string `json:"password"`\n}\n\n// Login checks a user\'s password and starts a session.\nfunc Login(w http.ResponseWriter, r *http.Request) {\n\tvar c credentials\n\tif err := json.NewDecoder(r.Body).Decode(&c); err != nil {\n\t\thttp.Error(w, "bad request", http.StatusBadRequest)\n\t\treturn\n\t}\n\tif !checkPassword(c.User, c.Password) {\n\t\thttp.Error(w, "unauthorized", http.StatusUnauthorized)\n\t\treturn\n\t}\n\tstartSession(w, c.User)\n}\n\nfunc checkPassword(user, password string) bool { return user == "demo" && password == "demo" }\n\nfunc startSession(w http.ResponseWriter, user string) {\n\thttp.SetCookie(w, &http.Cookie{Name: "session", Value: user, HttpOnly: true})\n}\n',
  'auth/login_test.go':
    'package auth\n\nimport (\n\t"net/http"\n\t"net/http/httptest"\n\t"strings"\n\t"testing"\n)\n\nfunc TestLoginRejectsWrongPassword(t *testing.T) {\n\tr := httptest.NewRequest("POST", "/login", strings.NewReader(`{"user":"demo","password":"x"}`))\n\tw := httptest.NewRecorder()\n\tLogin(w, r)\n\tif w.Code != http.StatusUnauthorized {\n\t\tt.Fatalf("got %d", w.Code)\n\t}\n}\n',
}

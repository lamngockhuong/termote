// What the panes without Claude Code show (video/capture/demo-env.sh): the
// dev server's log, the shell that ran the tests, the infra status. ANSI
// text; the fake stream (../fake-stream.ts) turns \n into \r\n.

// The prompt of every shell, naming no real user or host
export const prompt = (dir: string) =>
  `\x1b[32mdev@laptop\x1b[0m:\x1b[34m${dir}\x1b[0m$ `

export const SHELL_SCREEN = `${prompt('~/acme-api')}git status --short && git --no-pager diff --stat && go test -v ./auth/...
 M auth/login.go
 M auth/login_test.go
?? auth/ratelimit.go
 auth/login.go      | 10 ++++++++++
 auth/login_test.go | 13 +++++++++++++
 2 files changed, 23 insertions(+)
=== RUN   TestLoginRejectsWrongPassword
--- PASS: TestLoginRejectsWrongPassword (0.00s)
=== RUN   TestLoginLimitsAttempts
--- PASS: TestLoginLimitsAttempts (0.00s)
PASS
ok  \tacme-api/auth\t0.41s
${prompt('~/acme-api')}`

export const INFRA_SCREEN = `${prompt('~')}printf 'staging: 3/3 healthy\\nproduction: 6/6 healthy\\n'
staging: 3/3 healthy
production: 6/6 healthy
${prompt('~')}`

export const API_LOG_HEAD =
  '\x1b[2m$ go run .\x1b[0m\n2026/10/11 09:00:01 listening on :8080\n'

const REQUESTS = [
  'POST /login 200',
  'GET /me 200',
  'POST /login 401',
  'POST /login 429',
  'GET /health 200',
]

// The dev server's nth request line
export function apiLogLine(n: number): string {
  const mm = String(Math.floor(n / 60) % 60).padStart(2, '0')
  const ss = String(n % 60).padStart(2, '0')
  return `2026/10/11 09:${mm}:${ss} ${REQUESTS[n % REQUESTS.length]} ${3 + (n % 17)}ms\n`
}

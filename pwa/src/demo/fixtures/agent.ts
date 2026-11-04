// Claude Code's conversation in acme-api (video/capture/demo-env.sh), and
// what the agent does with the next message: work, ask to run the tests,
// then report them passing.
import type {
  AgentActivity,
  AgentCommand,
  AgentPrompt,
  TranscriptEntry,
} from '../../hooks/use-mux-api'

export const ACME_TRANSCRIPT: TranscriptEntry[] = [
  {
    id: 'demo-seed-0001',
    ts: '2026-10-11T09:00:01Z',
    role: 'user',
    parts: [
      {
        kind: 'text',
        text: 'Add rate limiting to the login endpoint: 5 tries a minute per IP',
      },
    ],
  },
  {
    id: 'demo-seed-0002',
    ts: '2026-10-11T09:00:02Z',
    role: 'assistant',
    parts: [
      { kind: 'text', text: "I'll read the login handler first." },
      {
        kind: 'tool',
        tool: 'Read',
        toolId: 't1',
        input: '/home/dev/acme-api/auth/login.go',
        result: '33 lines',
      },
    ],
  },
  {
    id: 'demo-seed-0004',
    ts: '2026-10-11T09:00:04Z',
    role: 'assistant',
    parts: [
      {
        kind: 'text',
        text: 'Adding a small per-address limiter and checking it before the password.',
      },
      {
        kind: 'tool',
        tool: 'Write',
        toolId: 't2',
        input: '/home/dev/acme-api/auth/ratelimit.go',
        result: 'File created',
        detail: {
          edits: [
            {
              'new':
                'package auth\n\nimport (\n\t"sync"\n\t"time"\n)\n\n// limiter allows max attempts per window for each client address.\ntype limiter struct {\n\tmu     sync.Mutex\n\tmax    int\n\twindow time.Duration\n\thits   map[string][]time.Time\n}\n\nfunc newLimiter(max int, window time.Duration) *limiter {\n\treturn &limiter{max: max, window: window, hits: map[string][]time.Time{}}\n}\n\n// allow records an attempt from addr and reports whether it is within the limit.\nfunc (l *limiter) allow(addr string) bool {\n\tl.mu.Lock()\n\tdefer l.mu.Unlock()\n\tnow := time.Now()\n\tkept := l.hits[addr][:0]\n\tfor _, t := range l.hits[addr] {\n\t\tif now.Sub(t) < l.window {\n\t\t\tkept = append(kept, t)\n\t\t}\n\t}\n\tif len(kept) >= l.max {\n\t\tl.hits[addr] = kept\n\t\treturn false\n\t}\n\tl.hits[addr] = append(kept, now)\n\treturn true\n}\n',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'demo-seed-0006',
    ts: '2026-10-11T09:00:06Z',
    role: 'assistant',
    parts: [
      {
        kind: 'tool',
        tool: 'Edit',
        toolId: 't3',
        input: '/home/dev/acme-api/auth/login.go',
        result: 'File updated',
        detail: {
          edits: [
            {
              old: 'func Login(w http.ResponseWriter, r *http.Request) {\n\tvar c credentials',
              'new':
                'func Login(w http.ResponseWriter, r *http.Request) {\n\taddr, _, _ := net.SplitHostPort(r.RemoteAddr)\n\tif !attempts.allow(addr) {\n\t\thttp.Error(w, "too many attempts", http.StatusTooManyRequests)\n\t\treturn\n\t}\n\tvar c credentials',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'demo-seed-0008',
    ts: '2026-10-11T09:00:08Z',
    role: 'assistant',
    parts: [
      {
        kind: 'text',
        text: 'Login is now **rate limited**:\n\n- 5 attempts a minute per client address (`auth/ratelimit.go`)\n- the 6th gets `429 Too Many Requests`\n- a test covers it in `auth/login_test.go`\n\nWant me to run the tests?',
      },
    ],
  },
]

export const REPLY_TOOL: TranscriptEntry = {
  id: '6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4-0002',
  ts: '2026-11-04T07:34:00Z',
  role: 'assistant',
  parts: [
    {
      kind: 'tool',
      tool: 'Bash',
      toolId: 'toolu_touch',
      input: 'go test ./auth/...',
      detail: {
        // i18n-ignore: what Claude Code wrote, as the server reads it
        description: 'Run the tests of the auth package',
        command: 'go test ./auth/...',
      },
    },
  ],
}

export const REPLY_TEXT: TranscriptEntry = {
  id: '6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4-0004',
  ts: '2026-11-04T07:34:10Z',
  role: 'assistant',
  parts: [{ kind: 'text', text: 'ok  acme-api/auth  0.41s: both tests pass.' }],
}

export const REPLY_PROMPT: AgentPrompt = {
  promptId: 'beadcfb40cc67c6fc5607a778d5dd236',
  kind: 'permission',
  // i18n-ignore: what Claude Code wrote, as the server reads it
  title: 'Bash command',
  body: 'Run the tests of the auth package\ngo test ./auth/...\nDo you want to proceed?',
  options: [
    // i18n-ignore: what Claude Code wrote, as the server reads it
    { index: 1, label: 'Yes' },
    // i18n-ignore: what Claude Code wrote, as the server reads it
    { index: 2, label: "Yes, and don't ask again for go test in this project" },
    // i18n-ignore: what Claude Code wrote, as the server reads it
    { index: 3, label: 'No' },
  ],
}

// The answer when the user says no to running the tests
export const REPLY_DECLINED = 'OK, I left the tests alone.'

// The project's own commands (.claude/commands)
export const ACME_COMMANDS: AgentCommand[] = [
  {
    name: 'review',
    // i18n-ignore: a command's description as the project wrote it
    description: 'Review the uncommitted changes',
    source: 'project',
    kind: 'command',
  },
  {
    name: 'ship',
    // i18n-ignore: a command's description as the project wrote it
    description: 'Run the tests, commit and open a pull request',
    source: 'project',
    kind: 'command',
  },
]

// The web workspace's Claude Code, in the middle of a turn
export const WEB_TRANSCRIPT: TranscriptEntry[] = [
  {
    id: 'web-0001',
    ts: '2026-10-11T09:02:01Z',
    role: 'user',
    parts: [
      {
        kind: 'text',
        text: 'Show the "too many attempts" error on the sign-in form',
      },
    ],
  },
  {
    id: 'web-0002',
    ts: '2026-10-11T09:02:03Z',
    role: 'assistant',
    parts: [
      { kind: 'text', text: 'Reading the form first.' },
      {
        kind: 'tool',
        tool: 'Read',
        toolId: 'w1',
        input: '/home/dev/web/src/login-form.tsx',
        result: '11 lines',
      },
    ],
  },
]

// The working line the web agent's screen shows
export const WEB_ACTIVITY: AgentActivity = {
  // i18n-ignore: what Claude Code wrote, as the server reads it
  label: 'Incubating',
  elapsed: 42,
  phase: 'thinking',
  detail: 'thinking',
  tokens: '3.1k',
}

import idle from '../../../server/testdata/claude/screens/2.1.286-idle-after-turn.txt?raw'
import permission from '../../../server/testdata/claude/screens/2.1.286-permission-bash.txt?raw'
import webWorking from '../../../server/testdata/claude/screens/2.1.310-working.txt?raw'
import thinking from '../../../server/testdata/claude/screens/2.1.312-working-thinking.txt?raw'
import {
  API_LOG_HEAD,
  apiLogLine,
  INFRA_SCREEN,
  prompt,
  SHELL_SCREEN,
} from './fixtures/terminal'
import { DEMO_HOME, SCREEN } from './fixtures/workspace'
import { type DemoState, findPane, paneRoot } from './state'

// What each pane's terminal shows. Claude Code's are the screens recorded
// from it for the server's tests (server/testdata/claude/screens), the same
// ones tests/fixtures/fake-claude.sh draws, rewritten as
// video/capture/demo-env.sh does to name the demo repo.

const REWRITES: [RegExp, string][] = [
  [/\/…\/00000000-0000-4000-8000-000000000000\/scratchpad\/lab/g, '~/acme-api'],
  [/\/tmp\/lab/g, '~/acme-api'],
  [/^.*Your login expires in 2 days.*$/gm, ''],
  [
    /Run this exact shell command with the Bash tool: touch scratch-one\.txt/g,
    'Run the auth tests',
  ],
  [/Creating a file named scratch-one\.txt/g, 'Running the auth tests'],
  [
    /Create a file named scratch-one\.txt/g,
    'Run the tests of the auth package',
  ],
  [/touch scratch-one\.txt/g, 'go test ./auth/...'],
  [/Đã tạo file .*scratch-one\.txt.*\./g, 'All auth tests pass.'],
  [
    /Viết một bài thơ 30 dòng về mùa thu, không dùng công cụ nào\./g,
    'Yes, run the auth tests',
  ],
  // Option 2 of the permission dialog, two rows in the recording
  [
    /Yes, and always allow access to[\s\S]*?from this project/g,
    "Yes, and don't ask again for \x1b[1mgo test\x1b[0m in this project",
  ],
  // The web workspace's agent
  [
    /Run the shell command: sleep 25\. Then reply with just: done/g,
    'Show the "too many attempts" error on the sign-in form',
  ],
]

export function rewrite(screen: string): string {
  return REWRITES.reduce((s, [re, to]) => s.replace(re, to), screen)
}

// Claude Code in acme-api, played in a loop: done, then working on the
// next message, asking to run the tests, and done again
export const CLAUDE_STORY: { screen: string; ms: number }[] = [
  { screen: rewrite(idle), ms: 6000 },
  { screen: rewrite(thinking), ms: 4000 },
  { screen: rewrite(permission), ms: 6000 },
]

const WEB_SCREEN = rewrite(webWorking).replaceAll('~/acme-api', '~/web')

// How often the dev server logs a request
export const LOG_MS = 1500

// The terminal of paneId at step (each played screen, or logged request),
// as ANSI text
export function screenAt(state: DemoState, paneId: string, step = 0): string {
  switch (paneId) {
    case 'w1:p1':
      return CLAUDE_STORY[step % CLAUDE_STORY.length].screen
    case 'w1:p2': {
      const n = 12 + step
      const lines = Array.from({ length: SCREEN.rows - 3 }, (_, i) =>
        n - i < 0 ? '' : apiLogLine(n - i),
      )
        .reverse()
        .join('')
      return API_LOG_HEAD + lines
    }
    case 'w1:p3':
      return SHELL_SCREEN
    case 'w2:p1':
      return WEB_SCREEN
    case 'w3:p1':
      return INFRA_SCREEN
  }
  const made = state.screens.get(paneId)
  if (made !== undefined) return made
  const ref = findPane(state, paneId)
  const root = ref ? paneRoot(ref) : DEMO_HOME
  return prompt(root.replace(DEMO_HOME, '~'))
}

// How long the screen at step stays before the next, or null for one that
// does not change
export function stepMs(paneId: string, step: number): number | null {
  if (paneId === 'w1:p1') return CLAUDE_STORY[step % CLAUDE_STORY.length].ms
  return paneId === 'w1:p2' ? LOG_MS : null
}

// The pane's screen as plain text (/panes/{id}/text)
export function plainScreen(state: DemoState, paneId: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
  const ansi = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g
  return screenAt(state, paneId).replace(ansi, '').trimEnd()
}

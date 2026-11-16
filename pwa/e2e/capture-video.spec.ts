import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, expect, type Page, type TestInfo, test } from './fixtures'
import { demoHostStats } from '../src/demo/fixtures/system'
import { WELCOME_VERSION } from '../src/utils/welcome'
import { FakeOpencode, type Json } from './fake-opencode'

// Screens of the intro video (video/), taken against the demo server that
// video/capture/demo-env.sh starts; see video/README.md for the commands.
// DEMO_MUX=herdr (the default) takes most screens, DEMO_MUX=tmux the
// desktop on tmux (shown beside Herdr's) and the phone's terminal, since tmux
// sizes the window to the phone (a headless Herdr's pane keeps its own width,
// so its text is drawn tiny); tmux also needs TMUX_SOCKET. The title starts with "Capture screenshots", which CI's run
// leaves out.
const mux = process.env.DEMO_MUX === 'tmux' ? 'tmux' : 'herdr'
const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, '../../video/public/ui')
mkdirSync(outDir, { recursive: true })

const phone = (testInfo: TestInfo) => ({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  httpCredentials: testInfo.project.use.httpCredentials,
})

const desktop = (testInfo: TestInfo) => ({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 2,
  httpCredentials: testInfo.project.use.httpCredentials,
})

type Tab = 'claude' | 'shell'

// The demo's workspace acme-api on Herdr: tab claude (pane w1:p1, the dev
// server's log beside it in w1:p2), tab shell (w1:p3). On tmux, session
// acme-api: windows 0 shell, 1 api, 2 claude; the terminal stream shows the
// session's active window, so it is made active before the page opens on it.
const link = (tab: Tab, view?: string) => {
  const query = view ? `?view=${view}` : ''
  if (mux === 'herdr') {
    return tab === 'claude' ? `/#/s/w1/w1:t1/w1:p1${query}` : `/#/s/w1/w1:t2/w1:p3${query}`
  }
  const index = tab === 'claude' ? 2 : 0
  execFileSync('tmux', ['-S', process.env.TMUX_SOCKET as string, 'select-window', '-t', `=acme-api:=${index}`])
  return `/#/s/acme-api/${index}${query}`
}

type UiStyle = 'neutral' | 'terminal' | 'native'
type Theme = 'light' | 'dark'

// The video alternates the light and the dark theme scene by scene: dark is
// open()'s default, these screens are taken light
const LIGHT = { theme: 'light' } as const

// The page opens signed in, past the welcome screen, in the given interface
// style, theme and language. Reduced motion makes every transition end at once, so a
// screen is taken in its final state rather than halfway through one.
async function open(
  browser: Browser,
  context: ReturnType<typeof phone> | ReturnType<typeof desktop>,
  path: string,
  {
    style = 'neutral',
    theme = 'dark',
    language = 'en',
    settings = {},
  }: {
    style?: UiStyle
    theme?: Theme
    language?: 'en' | 'vi'
    // More of termote-settings: sidebarLayout, toolbarPosition, showCost
    settings?: Record<string, unknown>
  } = {},
): Promise<Page> {
  const ctx = await browser.newContext({ ...context, colorScheme: theme, reducedMotion: 'reduce' })
  await ctx.addInitScript(
    ([uiStyle, colorTheme, version, lang, more]) => {
      localStorage.setItem('termote-theme', colorTheme)
      localStorage.setItem(
        'termote-settings',
        // The DOM renderer: the steps read the screen from .xterm-rows
        JSON.stringify({
          uiStyle,
          welcomeSeenVersion: version,
          language: lang,
          languageNoticeSeen: true,
          gpuRenderer: false,
          ...more,
        }),
      )
    },
    [style, theme, WELCOME_VERSION, language, settings] as const,
  )
  // The host's numbers are the demo page's laptop (pwa/src/demo), never
  // those of the computer taking the captures
  await ctx.route('**/api/mux/system**', (route) => route.fulfill({ json: demoHostStats(Date.now()) }))
  const page = await ctx.newPage()
  // A browser page gets the sign-in form, never a Basic challenge
  await page.goto('/login')
  await page.getByLabel('Username').fill(process.env.TERMOTE_USER || 'admin')
  await page.getByLabel('Password').fill(process.env.TERMOTE_PASS ?? '')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((u) => !u.pathname.startsWith('/login'))
  await page.goto(path)
  return page
}

async function waitTerminal(page: Page) {
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
  await page.waitForFunction(
    () => (document.querySelector('.xterm-rows') as HTMLElement | null)?.innerText.trim(),
    undefined,
    { timeout: 15000 },
  )
}

// The sessions sheet names what each pane runs: the shell tab's go test,
// started with the demo, is waited out so every capture reads bash there
async function openSessions(page: Page) {
  await page.getByRole('button', { name: 'Open sessions menu' }).click()
  await expect(page.getByRole('button', { name: 'New workspace' })).toBeVisible()
  await expect(page.getByText('go', { exact: true })).toHaveCount(0, { timeout: 30000 })
}

// Waits for the page to stop changing: fonts and images loaded, every finite
// animation finished, and the terminal's text (which redraws as it fits the pane) the
// same on two reads in a row
async function settled(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)))
    const finite = document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY)
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)))
  })
  let last: string | undefined
  await expect
    .poll(
      async () => {
        const text = await page.evaluate(
          () => (document.querySelector('.xterm-rows') as HTMLElement | null)?.innerText ?? '',
        )
        const same = text === last
        last = text
        return same
      },
      { intervals: [250], timeout: 10000 },
    )
    .toBe(true)
}

async function shot(page: Page, name: string) {
  await settled(page)
  // Nothing of the computer taking them: a tmux status line, a prompt or a
  // path naming this host fails the capture
  const text = await page.evaluate(() => document.body.innerText)
  expect(text.toLowerCase(), `${name} shows this host's name`).not.toContain(hostname().toLowerCase())
  await page.screenshot({ path: join(outDir, `${name}.png`) })
}

test.describe('Capture screenshots for the intro video', () => {
  test.skip(!process.env.DEMO_MUX, 'needs the demo server (video/capture/demo-env.sh)')
  test.describe.configure({ mode: 'serial' })

  test('desktop on tmux', async ({ browser }, testInfo) => {
    test.skip(mux !== 'tmux', 'the only tmux screen')
    const page = await open(browser, desktop(testInfo), link('claude', 'chat'))
    await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('rate limited', {
      timeout: 15000,
    })
    await shot(page, 'desktop-tmux')
    await page.context().close()
  })

  // The terminal on a phone
  test('phone terminal on tmux', async ({ browser }, testInfo) => {
    test.skip(mux !== 'tmux', 'tmux fits the window to the phone')
    const page = await open(browser, phone(testInfo), link('shell'))
    await waitTerminal(page)
    await expect(page.locator('.xterm-rows')).toContainText('dev@laptop', { timeout: 15000 })
    await shot(page, 'phone-terminal')
    await page.context().close()
  })

  // The Chat view's working line, on tmux: the row shows while the agent's
  // status is working, which tmux reads from the stand-in's session file. A
  // headless Herdr never sees the stand-in work, as it reads the lifecycle of
  // a Claude Code with a session id off the screen only (Herdr 0.9.5). Last on
  // tmux, since the turn changes the conversation desktop-tmux shows.
  test('phone chat working on tmux', async ({ browser }, testInfo) => {
    test.skip(mux !== 'tmux', 'tmux reads the working status from the session file')
    const page = await open(browser, phone(testInfo), link('claude', 'chat'), LIGHT)
    await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('rate limited', {
      timeout: 15000,
    })
    await page.getByRole('textbox', { name: 'Message to Claude Code' }).fill('Yes, run the auth tests')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    // The stand-in works a few seconds before it asks. Its recorded working
    // line is wider than the phone's window, so the row names the agent only
    await expect(page.getByRole('status').filter({ hasText: 'Claude Code is working…' })).toBeAttached({
      timeout: 15000,
    })
    // A few seconds into the turn, as the row counts them
    await expect(page.getByText(/· [3-6]s/)).toBeVisible({ timeout: 10000 })
    await shot(page, 'phone-chat-working')
    await page.context().close()
  })

  test.describe('on Herdr', () => {
    test.skip(mux !== 'herdr', 'every other screen is taken on Herdr')

    test('phone sessions', async ({ browser }, testInfo) => {
      const page = await open(browser, phone(testInfo), link('claude'))
      await waitTerminal(page)
      await openSessions(page)
      await shot(page, 'phone-sessions')
      await page.context().close()
    })

    // The README's picture of the interface styles: each one light and dark,
    // on the sessions sheet over the Chat view. That screen carries the most
    // of what a style changes (accent colour, button shape, the selected
    // row, the filter control, grouped rows, the sheet's handle, the
    // terminal style's monospace), where the terminal itself looks the same
    // in all three.
    test('phone sessions in each style and theme', async ({ browser }, testInfo) => {
      for (const style of ['neutral', 'terminal', 'native'] as const) {
        for (const theme of ['light', 'dark'] as const) {
          const page = await open(browser, phone(testInfo), link('claude', 'chat'), { style, theme })
          await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('rate limited', {
            timeout: 15000,
          })
          await openSessions(page)
          await shot(page, `phone-style-${style}-${theme}`)
          await page.context().close()
        }
      }
    })

    test('phone chat', async ({ browser }, testInfo) => {
      const page = await open(browser, phone(testInfo), link('claude', 'chat'), LIGHT)
      const conversation = page.getByRole('region', { name: 'Conversation' })
      await expect(conversation).toContainText('rate limited', { timeout: 15000 })
      await shot(page, 'phone-chat')

      const composer = page.getByRole('textbox', { name: 'Message to Claude Code' })
      await composer.fill('/')
      await shot(page, 'phone-chat-commands')

      await composer.fill('Yes, run the auth tests')
      await shot(page, 'phone-chat-typed')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      const card = page.getByRole('alertdialog', { name: 'Bash command' })
      await expect(card).toBeVisible({ timeout: 15000 })
      await shot(page, 'phone-chat-permission')
      await card.getByRole('button', { name: /^1\.\s*Yes$/ }).click()
      await expect(conversation).toContainText('both tests pass', { timeout: 15000 })
      // The composer comes back once the agent is idle again
      await expect(composer).toBeVisible({ timeout: 15000 })
      await shot(page, 'phone-chat-done')
      await page.context().close()
    })

    test('phone files and changes', async ({ browser }, testInfo) => {
      const page = await open(browser, phone(testInfo), link('claude', 'files'), LIGHT)
      await page.getByRole('treeitem', { name: 'README.md' }).click({ timeout: 15000 })
      await expect(page.getByTestId('mermaid-block').locator('img').first()).toBeVisible({ timeout: 20000 })
      await shot(page, 'phone-files')

      await page.goto(link('claude', 'changes'))
      const changes = page.getByRole('region', { name: 'Changes' })
      await expect(changes).toContainText('login.go', { timeout: 15000 })
      await shot(page, 'phone-changes')
      await changes.getByRole('button', { name: /login\.go/ }).first().click()
      await expect(page.getByText('attempts.allow(addr)').first()).toBeVisible({ timeout: 15000 })
      await shot(page, 'phone-diff')
      await page.context().close()
    })

    test('phone pair a device', async ({ browser }, testInfo) => {
      const page = await open(browser, phone(testInfo), link('shell'))
      await waitTerminal(page)
      await page.getByRole('button', { name: 'More' }).click()
      await page.getByRole('menuitem', { name: 'Settings' }).click()
      // A phone opens Settings at the list of groups
      await page.getByRole('button', { name: 'Devices' }).click()
      await page.getByRole('button', { name: 'Pair a device' }).click()
      await page.getByPlaceholder('Phone').fill('Tablet')
      await page.getByRole('button', { name: 'Make code' }).click()
      await expect(page.getByLabel('Pairing code')).toBeVisible({ timeout: 10000 })
      await shot(page, 'phone-pair')
      await page.context().close()
    })

    test('desktop terminal', async ({ browser }, testInfo) => {
      const page = await open(browser, desktop(testInfo), link('claude'))
      await waitTerminal(page)
      await shot(page, 'desktop-terminal')
      await page.context().close()
    })

    test('desktop chat with changes', async ({ browser }, testInfo) => {
      const page = await open(browser, desktop(testInfo), link('claude', 'chat'))
      await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('rate limited', {
        timeout: 15000,
      })
      await page.getByRole('group', { name: 'Side panel' }).getByRole('button', { name: 'Changes' }).click()
      const changes = page.getByRole('complementary', { name: 'Changes' })
      await changes.getByRole('region', { name: 'Changes' }).getByRole('button', { name: /:\s*login\.go/ }).click()
      await expect(changes.getByText('attempts.allow(addr)').first()).toBeVisible({ timeout: 15000 })
      await shot(page, 'desktop-chat-changes')
      await page.context().close()
    })

    test('desktop files', async ({ browser }, testInfo) => {
      const page = await open(browser, desktop(testInfo), link('claude', 'files'), LIGHT)
      await page.getByRole('treeitem', { name: 'README.md' }).click({ timeout: 15000 })
      await expect(page.getByTestId('mermaid-block').locator('img').first()).toBeVisible({ timeout: 20000 })
      await shot(page, 'desktop-files')
      await page.context().close()
    })

    // The header's Pane menu over the tab's two panes side by side, then the
    // agent's pane zoomed; zoomed back after, as Herdr keeps it
    test('desktop pane menu', async ({ browser }, testInfo) => {
      const page = await open(browser, desktop(testInfo), link('claude'))
      await waitTerminal(page)
      const menu = page.getByRole('button', { name: 'Pane', exact: true })
      await menu.click()
      await expect(page.getByRole('menuitem', { name: 'Split right', exact: true })).toBeVisible()
      await shot(page, 'desktop-pane-menu')
      await page.getByRole('menuitem', { name: 'Zoom', exact: true }).click()
      // The dev server's log beside it (w1:p2) is hidden while the agent's pane is zoomed
      const log = page.locator('[data-pane-id="w1:p2"]')
      await expect(log).toBeHidden({ timeout: 15000 })
      await shot(page, 'desktop-pane-zoom')
      await menu.click()
      await page.getByRole('menuitem', { name: 'Zoom', exact: true }).click()
      await expect(log).toBeVisible({ timeout: 15000 })
      await page.context().close()
    })

    // The repo's Go tasks (from go.mod) and its make targets
    test('phone tasks', async ({ browser }, testInfo) => {
      const page = await open(browser, phone(testInfo), link('claude', 'tasks'), LIGHT)
      const view = page.getByTestId('tasks-view')
      await expect(view.getByText('migrate', { exact: true })).toBeVisible({ timeout: 15000 })
      await shot(page, 'phone-tasks')
      await page.context().close()
    })

    // phone-sessions in Vietnamese: the sheet is mostly the app's own words
    test('phone sessions in Vietnamese', async ({ browser }, testInfo) => {
      const page = await open(browser, phone(testInfo), link('claude'), { language: 'vi' })
      await expect(page.locator('html')).toHaveAttribute('lang', 'vi')
      await waitTerminal(page)
      await page.getByRole('button', { name: 'Mở danh sách phiên' }).click()
      await expect(page.getByText('deploy', { exact: true })).toBeVisible()
      await expect(page.getByText('go', { exact: true })).toHaveCount(0, { timeout: 30000 })
      await shot(page, 'phone-sessions-vi')
      await page.context().close()
    })

    // The pane's session history: the folder's earlier Claude Code sessions
    // (video/capture/demo-env.sh dates two of them days back), the tokens
    // each used and their estimated cost, then an earlier one picked
    test('phone session history', async ({ browser }, testInfo) => {
      const page = await open(browser, phone(testInfo), link('claude', 'chat'), {
        ...LIGHT,
        settings: { showCost: true },
      })
      await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('rate limited', {
        timeout: 15000,
      })
      await page.getByRole('button', { name: 'Session history' }).click()
      const sheet = page.getByRole('dialog', { name: 'Session history' })
      await expect(sheet.getByText('The login test is flaky on CI', { exact: false })).toBeVisible({
        timeout: 15000,
      })
      await expect(sheet.getByRole('region', { name: 'Agent tokens' })).toContainText('tokens', {
        timeout: 15000,
      })
      await shot(page, 'phone-history')
      await sheet.getByText('Add a /health endpoint', { exact: false }).click()
      await expect(sheet.getByTestId('session-usage')).toContainText('~$', { timeout: 15000 })
      await shot(page, 'phone-history-session')
      await page.context().close()
    })

    // The second machine (build-server, another Termote reached through its
    // bridge socket) in the sidebar, then its own sessions
    test('desktop machine', async ({ browser }, testInfo) => {
      const page = await open(browser, desktop(testInfo), link('claude'))
      await waitTerminal(page)
      const machines = page.getByRole('region', { name: 'Machines' })
      await expect(machines.getByRole('img', { name: 'Online' })).toBeVisible({ timeout: 30000 })
      await machines.getByRole('button', { name: /^build-server/ }).click()
      await expect(page).toHaveURL(/\?machine=[0-9a-f]{16}/)
      await waitTerminal(page)
      await expect(page.locator('.xterm-rows')).toContainText('epoch 14/20', { timeout: 15000 })
      await shot(page, 'desktop-machine')
      await page.context().close()
    })

    // The host's CPU, load, memory and disks, from the header's chip
    test('desktop host', async ({ browser }, testInfo) => {
      const page = await open(browser, desktop(testInfo), link('claude'))
      await waitTerminal(page)
      await page.getByRole('button', { name: /^Host: .*Open the host details$/ }).click()
      const sheet = page.getByRole('dialog', { name: 'Host' })
      await expect(sheet.getByRole('img', { name: /^Memory/ })).toBeVisible({ timeout: 15000 })
      await shot(page, 'desktop-host')
      await page.context().close()
    })

    // Who last changed each line of auth/login.go (two authors, and the
    // agent's lines not committed yet), then one commit's details
    test('desktop blame', async ({ browser }, testInfo) => {
      const page = await open(browser, desktop(testInfo), link('claude', 'files'))
      const panel = page.getByRole('complementary', { name: 'Files' })
      await panel.getByRole('treeitem', { name: 'auth' }).click({ timeout: 15000 })
      await panel.getByRole('treeitem', { name: 'login.go' }).click()
      await expect(panel.getByTestId('code-block')).toContainText('invalid JSON body', { timeout: 15000 })
      await panel.getByRole('button', { name: 'Blame' }).click()
      await expect(panel.getByText('Alex Kim').first()).toBeVisible({ timeout: 15000 })
      await shot(page, 'desktop-blame')
      // The blame cell of the line Alex Kim changed
      const line = panel.locator('[data-testid="code-block"] [data-line]').filter({ hasText: 'invalid JSON body' })
      await line.locator('> div > :first-child').click()
      const details = page.getByRole('dialog', { name: 'Commit details' })
      await expect(details).toContainText('bad sign-in request')
      await shot(page, 'desktop-blame-commit')
      await page.context().close()
    })

    // A right click on a file in Files
    test('desktop context menu', async ({ browser }, testInfo) => {
      const page = await open(browser, desktop(testInfo), link('claude', 'files'), LIGHT)
      const panel = page.getByRole('complementary', { name: 'Files' })
      // On the tree: opening a file would hide it
      const row = panel.getByRole('treeitem', { name: 'main.go' })
      await row.click({ button: 'right', timeout: 15000 })
      await expect(page.getByRole('menuitem', { name: 'Copy relative path' })).toBeVisible()
      await shot(page, 'desktop-context-menu')
      await page.context().close()
    })

    // The compact sidebar (a line per workspace, the running agents on top)
    // with the toolbar on a bar at the right
    test('desktop compact', async ({ browser }, testInfo) => {
      const page = await open(browser, desktop(testInfo), link('claude', 'chat'), {
        ...LIGHT,
        settings: { sidebarLayout: 'compact', toolbarPosition: 'right' },
      })
      await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('rate limited', {
        timeout: 15000,
      })
      await expect(page.getByRole('region', { name: 'Running agents' })).toBeVisible()
      await shot(page, 'desktop-compact')
      await page.context().close()
    })

    // Settings carried to another browser: saved to a file or copied
    test('phone settings export', async ({ browser }, testInfo) => {
      const page = await open(browser, phone(testInfo), link('shell'))
      await waitTerminal(page)
      await page.getByRole('button', { name: 'More' }).click()
      await page.getByRole('menuitem', { name: 'Settings' }).click()
      await page.getByRole('button', { name: 'Export & import' }).click()
      await expect(page.getByRole('button', { name: 'Save to a file' })).toBeVisible()
      await shot(page, 'phone-settings-export')
      await page.context().close()
    })

    // OpenCode in workspace mobile (w4), against the stand-in service
    // (fake-opencode.ts) holding a demo conversation: the Chat view, its slash
    // commands, and a shell command waiting for permission. The service writes
    // its service.json into the demo server's XDG_STATE_HOME (TERMOTE_E2E_STATE).
    test.describe('OpenCode', () => {
      const oc = new FakeOpencode()
      const SESSION = 'ses_demo_mobile'
      const dir = process.env.TERMOTE_E2E_STATE ? join(dirname(process.env.TERMOTE_E2E_STATE), 'mobile') : ''
      const herdr = (...args: string[]) =>
        execFileSync('herdr', args, {
          env: {
            ...process.env,
            HERDR_SOCKET_PATH: `/tmp/termote-demo-${process.getuid?.()}-${process.env.TERMOTE_PORT}.sock`,
          },
        })
      const report = (state: string) =>
        herdr('pane', 'report-agent', '--source', 'termote-demo', '--seq', `${Date.now()}000000`,
          '--agent', 'opencode', '--state', state, 'w4:p1')

      test.beforeAll(async () => {
        test.skip(!process.env.TERMOTE_E2E_STATE, 'needs TERMOTE_E2E_STATE, the demo server\'s XDG_STATE_HOME')
        await oc.start(process.env.TERMOTE_E2E_STATE as string)
        const t0 = Date.now() - 6 * 60_000
        const model = { id: 'claude-sonnet-5-5', providerID: 'anthropic' }
        const tokens = (input: number, output: number) => ({
          input, output, reasoning: 0, cache: { read: input * 6, write: 0 },
        })
        let at = t0
        const next = (s: number) => (at += s * 1000)
        const user = (text: string): Json => ({ id: oc.nextId(), time: { created: next(20) }, text, type: 'user' })
        const reply = (content: Json[], cost: number, done = true): Json => {
          const created = next(4)
          return {
            id: oc.nextId(), type: 'assistant', agent: 'build', model,
            time: done ? { created, completed: next(30) } : { created },
            content, ...(done ? { finish: 'stop', cost, tokens: tokens(9000, 700) } : {}),
          }
        }
        const tool = (id: string, name: string, input: Json, output: string, status = 'completed'): Json => ({
          type: 'tool', id, name, executed: false,
          state: status === 'completed'
            ? { status, input, content: [{ type: 'text', text: output }], metadata: { status, truncated: false } }
            : { status, input, metadata: {} },
          time: { created: at, ran: at + 200, ...(status === 'completed' ? { completed: at + 900 } : {}) },
        })
        const msgs: Json[] = [
          user('Cache the feed so the app works offline'),
          reply([
            { type: 'text', text: "I'll look at how the feed is fetched first." },
            tool('call_1', 'read', { filePath: `${dir}/src/feed.ts` }, '42 lines'),
          ], 0.021),
          reply([
            { type: 'text', text: 'The feed is now **cached offline**:\n\n- the last 50 posts are kept in IndexedDB (`src/feed-cache.ts`)\n- the app shows them at once, then refreshes\n- a banner says when you are offline' },
          ], 0.034),
          user('Great, run the tests'),
          reply([tool('call_2', 'shell', { command: 'npm test', description: 'Run the test suite' }, '', 'running')], 0, false),
        ]
        oc.messages.set(SESSION, msgs)
        const session: Json = {
          id: SESSION, projectID: 'global', model, title: 'Offline feed', outcome: undefined,
          cost: 0.055, tokens: tokens(18000, 1400),
          time: { created: t0, updated: at, busy: at },
          location: { directory: dir },
        }
        oc.sessions.set(SESSION, session)
        oc.list = [session]
        oc.permissions.set(SESSION, [{
          id: 'per_demo1', sessionID: SESSION, action: 'shell', resources: ['npm test'], save: ['npm *'],
          source: { type: 'tool', messageID: msgs[msgs.length - 1].id, id: 'call_2' },
        }])
        oc.active.add(SESSION)
        report('blocked')
      })

      test.afterAll(async () => {
        report('idle')
        await oc.stop()
      })

      test('phone opencode chat', async ({ browser }, testInfo) => {
        const page = await open(browser, phone(testInfo), '/#/s/w4/w4:t1/w4:p1?view=chat')
        const conversation = page.getByRole('region', { name: 'Conversation' })
        await expect(conversation).toContainText('cached offline', { timeout: 20000 })
        const card = page.getByRole('alertdialog', { name: 'Allow shell?' })
        await expect(card).toBeVisible({ timeout: 20000 })
        await shot(page, 'phone-opencode-permission')
        await page.context().close()
      })
    })

    // A worktree of acme-api on a new branch: the dialog, then its workspace
    test('desktop worktree', async ({ browser }, testInfo) => {
      const page = await open(browser, desktop(testInfo), link('claude'), LIGHT)
      await waitTerminal(page)
      await page.getByRole('button', { name: /^Actions for .+ acme-api$/ }).click()
      await page.getByRole('menuitem', { name: 'New worktree' }).click()
      await page.getByLabel('Branch (new, or one to check out)').fill('feat/oauth-login')
      await shot(page, 'desktop-worktree-new')
      await page.getByRole('button', { name: 'Create' }).click()
      await expect(page.locator('aside section').filter({ has: page.getByTitle('feat/oauth-login', { exact: true }) }))
        .toBeVisible({ timeout: 30000 })
      await waitTerminal(page)
      await shot(page, 'desktop-worktree')
      await page.context().close()
    })

    // A file sent from the phone, then deleted and found in the trash. Last,
    // since the upload would show in every later capture's Changes
    test('phone upload and trash', async ({ browser }, testInfo) => {
      const page = await open(browser, phone(testInfo), link('claude', 'files'), LIGHT)
      await expect(page.getByRole('treeitem', { name: 'README.md' })).toBeVisible({ timeout: 15000 })
      await page.getByTestId('upload-input').setInputFiles({
        name: 'api-spec.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4\n%%EOF\n'),
      })
      await expect(page.getByRole('treeitem', { name: 'api-spec.pdf' })).toBeVisible()
      await expect(page.getByText('Uploaded api-spec.pdf')).toBeVisible()
      await shot(page, 'phone-files-upload')

      const row = page.getByRole('treeitem', { name: 'api-spec.pdf' })
      await row.getByRole('button', { name: 'Actions for api-spec.pdf' }).click()
      await page.getByRole('menuitem', { name: /^Delete/ }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(page.getByText('Deleted api-spec.pdf', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Trash' }).click()
      const items = page.getByRole('dialog', { name: 'Trash' }).getByRole('list', { name: 'Deleted items' })
      await expect(items.getByText('api-spec.pdf', { exact: true })).toBeVisible()
      await shot(page, 'phone-files-trash')
      await page.context().close()
    })
  })
})

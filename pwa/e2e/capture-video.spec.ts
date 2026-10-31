import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, expect, type Page, type TestInfo, test } from './fixtures'
import { WELCOME_VERSION } from '../src/utils/welcome'

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

// The page opens signed in, past the welcome screen, in the given interface
// style and theme. Reduced motion makes every transition end at once, so a
// screen is taken in its final state rather than halfway through one.
async function open(
  browser: Browser,
  context: ReturnType<typeof phone> | ReturnType<typeof desktop>,
  path: string,
  { style = 'neutral', theme = 'dark' }: { style?: UiStyle; theme?: Theme } = {},
): Promise<Page> {
  const ctx = await browser.newContext({ ...context, colorScheme: theme, reducedMotion: 'reduce' })
  await ctx.addInitScript(
    ([uiStyle, colorTheme, version]) => {
      localStorage.setItem('termote-theme', colorTheme)
      localStorage.setItem('termote-settings', JSON.stringify({ uiStyle, welcomeSeenVersion: version }))
    },
    [style, theme, WELCOME_VERSION] as const,
  )
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
      const page = await open(browser, phone(testInfo), link('claude', 'chat'))
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
      const page = await open(browser, phone(testInfo), link('claude', 'files'))
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
      const page = await open(browser, desktop(testInfo), link('claude', 'files'))
      await page.getByRole('treeitem', { name: 'README.md' }).click({ timeout: 15000 })
      await expect(page.getByTestId('mermaid-block').locator('img').first()).toBeVisible({ timeout: 20000 })
      await shot(page, 'desktop-files')
      await page.context().close()
    })
  })
})

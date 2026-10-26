import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, expect, type Page, type TestInfo, test } from './fixtures'

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
  colorScheme: 'dark' as const,
  httpCredentials: testInfo.project.use.httpCredentials,
})

const desktop = (testInfo: TestInfo) => ({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'dark' as const,
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

async function open(
  browser: Browser,
  context: ReturnType<typeof phone> | ReturnType<typeof desktop>,
  path: string,
  uiStyle: 'neutral' | 'terminal' | 'native' = 'neutral',
): Promise<Page> {
  const ctx = await browser.newContext(context)
  await ctx.addInitScript((style) => {
    localStorage.setItem('termote-theme', 'dark')
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ uiStyle: style, hasSeenGestureHints: true }),
    )
  }, uiStyle)
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
  await page.waitForTimeout(800)
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(outDir, `${name}.png`) })

test.describe('Capture screenshots for the intro video', () => {
  test.skip(!process.env.DEMO_MUX, 'needs the demo server (video/capture/demo-env.sh)')
  test.describe.configure({ mode: 'serial' })

  test('desktop on tmux', async ({ browser }, testInfo) => {
    test.skip(mux !== 'tmux', 'the only tmux screen')
    const page = await open(browser, desktop(testInfo), link('claude', 'chat'))
    await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('rate limited', {
      timeout: 15000,
    })
    await page.waitForTimeout(1000)
    await shot(page, 'desktop-tmux')
    await page.context().close()
  })

  // The terminal on a phone, in each interface style (the README's picture of
  // them; neutral is the video's)
  test('phone terminal on tmux', async ({ browser }, testInfo) => {
    test.skip(mux !== 'tmux', 'tmux fits the window to the phone')
    for (const style of ['neutral', 'terminal', 'native'] as const) {
      const page = await open(browser, phone(testInfo), link('shell'), style)
      await waitTerminal(page)
      await expect(page.locator('.xterm-rows')).toContainText('dev@laptop', { timeout: 15000 })
      await page.waitForTimeout(500)
      await shot(page, style === 'neutral' ? 'phone-terminal' : `phone-style-${style}`)
      await page.context().close()
    }
  })

  test.describe('on Herdr', () => {
    test.skip(mux !== 'herdr', 'every other screen is taken on Herdr')

    test('phone sessions', async ({ browser }, testInfo) => {
      const page = await open(browser, phone(testInfo), link('claude'))
      await waitTerminal(page)
      await page.getByRole('button', { name: 'Open sessions menu' }).click()
      await page.waitForTimeout(500)
      await shot(page, 'phone-sessions')
      await page.context().close()
    })

    test('phone chat', async ({ browser }, testInfo) => {
      const page = await open(browser, phone(testInfo), link('claude', 'chat'))
      const conversation = page.getByRole('region', { name: 'Conversation' })
      await expect(conversation).toContainText('rate limited', { timeout: 15000 })
      await page.waitForTimeout(800)
      await shot(page, 'phone-chat')

      const composer = page.getByRole('textbox', { name: 'Message to Claude Code' })
      await composer.fill('/')
      await page.waitForTimeout(800)
      await shot(page, 'phone-chat-commands')

      await composer.fill('Yes, run the auth tests')
      await page.waitForTimeout(300)
      await shot(page, 'phone-chat-typed')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      const card = page.getByRole('alertdialog', { name: 'Bash command' })
      await expect(card).toBeVisible({ timeout: 15000 })
      await page.waitForTimeout(800)
      await shot(page, 'phone-chat-permission')
      await card.getByRole('button', { name: /^1\.\s*Yes$/ }).click()
      await expect(conversation).toContainText('both tests pass', { timeout: 15000 })
      // The composer comes back once the agent is idle again
      await expect(composer).toBeVisible({ timeout: 15000 })
      await page.waitForTimeout(800)
      await shot(page, 'phone-chat-done')
      await page.context().close()
    })

    test('phone files and changes', async ({ browser }, testInfo) => {
      const page = await open(browser, phone(testInfo), link('claude', 'files'))
      await page.getByRole('treeitem', { name: 'README.md' }).click({ timeout: 15000 })
      await page.locator('img[alt*="Mermaid" i], [data-testid="mermaid-block"] img').first()
        .waitFor({ timeout: 20000 }).catch(() => {})
      await page.waitForTimeout(1500)
      await shot(page, 'phone-files')

      await page.goto(link('claude', 'changes'))
      const changes = page.getByRole('region', { name: 'Changes' })
      await expect(changes).toContainText('login.go', { timeout: 15000 })
      await page.waitForTimeout(500)
      await shot(page, 'phone-changes')
      await changes.getByRole('button', { name: /login\.go/ }).first().click()
      await page.waitForTimeout(1500)
      await shot(page, 'phone-diff')
      await page.context().close()
    })

    test('phone pair a device', async ({ browser }, testInfo) => {
      const page = await open(browser, phone(testInfo), link('shell'))
      await waitTerminal(page)
      await page.getByRole('button', { name: 'More' }).click()
      await page.getByRole('menuitem', { name: 'Settings' }).click()
      // A phone shows every settings group on one page, without the side list
      await page.getByRole('button', { name: 'Pair a device' }).click()
      await page.getByPlaceholder('Phone').fill('Tablet')
      await page.getByRole('button', { name: 'Make code' }).click()
      await expect(page.getByLabel('Pairing code')).toBeVisible({ timeout: 10000 })
      await page.waitForTimeout(500)
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
      await page.waitForTimeout(1500)
      await shot(page, 'desktop-chat-changes')
      await page.context().close()
    })

    test('desktop files', async ({ browser }, testInfo) => {
      const page = await open(browser, desktop(testInfo), link('claude', 'files'))
      await page.getByRole('treeitem', { name: 'README.md' }).click({ timeout: 15000 })
      await page.waitForTimeout(2500)
      await shot(page, 'desktop-files')
      await page.context().close()
    })
  })
})

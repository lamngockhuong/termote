import { type APIRequestContext, type Browser, expect, type Page, test } from './fixtures'

// Settings > Signed-in browsers, against a server with sign-in on: the e2e
// CI job's second server (TERMOTE_PASS, its own port), as devices.spec.ts.
// Without TERMOTE_E2E_AUTH=1 the spec skips.
const enabled = process.env.TERMOTE_E2E_AUTH === '1'
const user = process.env.TERMOTE_USER || 'admin'
const pass = process.env.TERMOTE_PASS ?? ''

interface Signin {
  id: string
  via: string
  userAgent: string
  current: boolean
}

// The sign-ins as the CLI reads them: Basic auth, which makes no session.
async function signins(request: APIRequestContext): Promise<Signin[]> {
  const res = await request.get('/api/mux/signins')
  expect(res.status(), await res.text()).toBe(200)
  return ((await res.json()) as { sessions: Signin[] }).sessions
}

// A browser named by its User-Agent: the list shows the first word of one
// it does not know (`tag`), so each test finds its own rows.
async function browserNamed(
  browser: Browser,
  baseURL: string | undefined,
  tag: string,
  basic = false,
): Promise<Page> {
  const context = await browser.newContext({
    baseURL,
    userAgent: `${tag}/1.0`,
    // Sent on every request, page loads included, as a browser opening a
    // user:pass@ link does (httpCredentials waits for a challenge, which a
    // page load never gets: it gets the sign-in form).
    ...(basic
      ? { extraHTTPHeaders: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` } }
      : {}),
  })
  // The first-visit gesture tour would cover the page on a phone
  await context.addInitScript(() => {
    localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true }))
  })
  return context.newPage()
}

// Signs page in on the server's sign-in form and waits for the terminal.
async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill(user)
  await page.getByLabel('Password').fill(pass)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 15000 })
}

async function openSignins(page: Page) {
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await page
    .getByRole('navigation', { name: 'Settings groups' })
    .getByRole('button', { name: 'Signed-in browsers' })
    .click()
  return page.getByRole('list', { name: 'Signed-in browsers' })
}

const tagOf = (name: string) => `e2e${name}${Math.random().toString(36).slice(2, 8)}`

test.describe('signed-in browsers', () => {
  test.skip(!enabled, 'needs TERMOTE_E2E_AUTH=1 and a server with sign-in on (TERMOTE_PASS)')

  const opened: Page[] = []
  test.afterEach(async () => {
    for (const p of opened.splice(0)) await p.context().close()
  })

  test('signing another browser out sends it to the sign-in page', async ({ browser, baseURL }) => {
    const mine = tagOf('mine')
    const other = tagOf('other')
    const a = await browserNamed(browser, baseURL, mine)
    const b = await browserNamed(browser, baseURL, other)
    opened.push(a, b)
    await signIn(a)
    await signIn(b)

    const list = await openSignins(a)
    await expect(list.getByRole('listitem').filter({ hasText: mine })).toContainText('This browser')
    await expect(list.getByRole('listitem').filter({ hasText: other })).not.toContainText('This browser')
    await a.getByRole('button', { name: `Sign out ${other}`, exact: true }).click()
    await a.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(a.getByRole('status').filter({ hasText: 'Signed out' })).toHaveText(`Signed out ${other}`)
    await expect(list.getByRole('listitem').filter({ hasText: other })).toHaveCount(0)

    // The next read of the other browser is refused: its page signs in again.
    await expect(b).toHaveURL(/\/login/, { timeout: 20000 })
    // This one stays signed in.
    expect((await a.request.get('/api/mux/snapshot')).status()).toBe(200)
  })

  test('Sign out all others keeps only this browser', async ({ browser, baseURL, request }) => {
    const mine = tagOf('keep')
    const a = await browserNamed(browser, baseURL, mine)
    const b = await browserNamed(browser, baseURL, tagOf('b'))
    const c = await browserNamed(browser, baseURL, tagOf('c'))
    opened.push(a, b, c)
    for (const p of [a, b, c]) await signIn(p)

    await openSignins(a)
    await a.getByRole('button', { name: 'Sign out all others' }).click()
    await a.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(a.getByRole('status').filter({ hasText: 'Signed out' })).toContainText('other browser')
    await expect(b).toHaveURL(/\/login/, { timeout: 20000 })
    await expect(c).toHaveURL(/\/login/, { timeout: 20000 })

    const left = await signins(request)
    expect(left.map((s) => s.userAgent)).toEqual([`${mine}/1.0`])
    expect((await a.request.get('/api/mux/snapshot')).status()).toBe(200)
  })

  test('a browser signed in with Basic auth is listed, the CLI never is', async ({
    browser,
    baseURL,
    request,
  }) => {
    const tag = tagOf('basic')
    const page = await browserNamed(browser, baseURL, tag, true)
    opened.push(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 15000 })

    const before = await signins(request)
    const mine = before.find((s) => s.userAgent === `${tag}/1.0`)
    expect(mine?.via).toBe('basic')
    // The reads above went with Basic auth and no browser headers.
    expect(await signins(request)).toHaveLength(before.length)

    // Signed out from the CLI's side; a client sending the password on every
    // request signs in again, which the Settings note says.
    const del = await request.delete(`/api/mux/signins/${mine?.id}`, {
      headers: { 'Content-Type': 'application/json' },
    })
    expect(del.status()).toBe(200)
    expect((await signins(request)).some((s) => s.id === mine?.id)).toBe(false)
  })
})

import { execFileSync } from 'node:child_process'
import { type APIRequestContext, type Browser, expect, type Page, test } from './fixtures'

// Pairing a device and the view-only role, against a server with sign-in on:
// the e2e CI job starts a second server with a password (TERMOTE_PASS) on its
// own port, tmux socket and session for this spec alone. Without
// TERMOTE_E2E_AUTH=1 the spec skips, so the no-auth run never reaches it;
// with it, a server that cannot pair fails the spec instead of skipping.
const enabled = process.env.TERMOTE_E2E_AUTH === '1'
const socket = process.env.TMUX_SOCKET
const session = process.env.TMUX_SESSION || 'main'

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

// The server's current window of the session, and what it shows
const currentWindow = () => tmux('display-message', '-p', '-t', `=${session}:`, '#{window_index}')
const screen = () => tmux('capture-pane', '-p', '-J', '-t', `=${session}:`)

interface Code {
  code: string
  url: string
}

// A code made the way the CLI makes one: Basic auth, JSON, no Origin.
async function makeCode(request: APIRequestContext, role: 'view' | 'full', name: string) {
  const res = await request.post('/api/mux/devices/pair', { data: { role, name } })
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()) as Code
}

async function deviceId(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.get('/api/mux/devices')
  expect(res.status()).toBe(200)
  const { devices } = (await res.json()) as { devices: { id: string; name: string }[] }
  const id = devices.find((d) => d.name === name)?.id
  expect(id, `device ${name} listed`).toBeTruthy()
  return id as string
}

// A browser that never had the password: no Basic credentials, no cookie.
async function stranger(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const context = await browser.newContext({ baseURL })
  // The first-visit gesture tour would cover the page on a phone
  await context.addInitScript(() => {
    localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true }))
  })
  return context.newPage()
}

// Pairs a new browser with code, from the link the QR code carries.
async function pairStranger(browser: Browser, baseURL: string | undefined, code: string) {
  const page = await stranger(browser, baseURL)
  await page.goto(`/pair?code=${encodeURIComponent(code)}`)
  await page.getByRole('button', { name: 'Pair' }).click()
  await expect(page).toHaveURL(/\/(#.*)?$/)
  return page
}

// A same-site JSON write from page's browser (its device cookie).
const writeAs = (page: Page, baseURL: string | undefined, path: string, data: object) =>
  page.request.post(path, { data, headers: { Origin: baseURL as string } })

test.describe('paired devices and the view-only role', () => {
  test.skip(!enabled, 'needs TERMOTE_E2E_AUTH=1 and a server with sign-in on (TERMOTE_PASS)')

  const made: string[] = []
  test.afterEach(async ({ request }) => {
    for (const name of made.splice(0)) {
      const res = await request.get('/api/mux/devices')
      const { devices } = (await res.json()) as { devices: { id: string; name: string }[] }
      for (const d of devices.filter((d) => d.name === name)) {
        await request.delete(`/api/mux/devices/${d.id}`, {
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }
  })

  test('the sign-in page links to pairing', async ({ browser, baseURL }) => {
    const page = await stranger(browser, baseURL)
    await page.goto('/login')
    await page.getByRole('link', { name: 'Have a pairing code?' }).click()
    await expect(page).toHaveURL(/\/pair$/)
    await expect(page.getByRole('heading', { name: 'Pair this device' })).toBeVisible()
    // Where an app page an older service worker served at /pair sends the
    // browser: the pairing form, with the code
    await page.goto(`/login?next=${encodeURIComponent('/pair?code=ABCDE-FGHJK')}`)
    await expect(page.getByLabel('Pairing code')).toHaveValue('ABCDE-FGHJK')
    await page.context().close()
  })

  test('a view-only device watches, changes nothing, and is revoked', async ({
    browser,
    baseURL,
    request,
  }) => {
    expect(socket, 'TMUX_SOCKET of the server under test').toBeTruthy()
    const snap = await (await request.get('/api/mux/snapshot')).json()
    expect(snap.caps.devices, 'the server can pair devices').toBe(true)

    const name = `e2e-viewer-${Math.random().toString(36).slice(2, 8)}`
    made.push(name)
    const { code } = await makeCode(request, 'view', name)

    // Paired from the link the QR code carries, without the password.
    const page = await stranger(browser, baseURL)
    await page.goto(`/pair?code=${encodeURIComponent(code)}`)
    await expect(page.getByLabel('Pairing code')).toHaveValue(code)
    await page.getByRole('button', { name: 'Pair' }).click()
    await expect(page).toHaveURL(/\/(#.*)?$/)
    await expect(page.getByText('View only: you can watch this terminal but not type')).toBeVisible({
      timeout: 15000,
    })
    await page.waitForSelector('[aria-label="Connected"]', { timeout: 15000 })

    // Nothing that would change the server is offered.
    await expect(page.getByRole('button', { name: 'Add session' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add new session' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0)

    // Typing reaches no pane, and the server's window stays where it was.
    const window = currentWindow()
    await page.locator('[data-testid="terminal-view"] .xterm').click()
    await page.keyboard.type('echo e2e-view-$((6*7))')
    await page.keyboard.press('Enter')
    // Long enough for a typed key to reach the pane and be echoed
    await page.waitForTimeout(1500)
    expect(screen()).not.toContain('e2e-view-')
    expect(currentWindow()).toBe(window)

    // The server refuses a write sent anyway.
    const write = await page.request.post('/api/mux/tabs', { data: { name: 'e2e-view' } })
    expect(write.status()).toBe(403)
    expect((await write.json()).code).toBe('view_only')

    // Revoked from a full client: the next poll sends the device to sign in.
    const del = await request.delete(`/api/mux/devices/${await deviceId(request, name)}`, {
      headers: { 'Content-Type': 'application/json' },
    })
    expect(del.status()).toBe(200)
    await expect(page).toHaveURL(/\/login/, { timeout: 20000 })
    await page.context().close()
  })

  test('a browser already signed in is never paired', async ({ browser, baseURL, request }) => {
    const name = `e2e-signed-in-${Math.random().toString(36).slice(2, 8)}`
    made.push(name)
    const { code } = await makeCode(request, 'view', name)

    // Signed in with the password, on the server's sign-in form (a browser
    // page load gets the form, never a Basic challenge)
    const page = await stranger(browser, baseURL)
    await page.goto('/login')
    await page.getByLabel('Username').fill(process.env.TERMOTE_USER || 'admin')
    await page.getByLabel('Password').fill(process.env.TERMOTE_PASS ?? '')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
    await page.goto(`/pair?code=${encodeURIComponent(code)}`)
    await page.getByRole('button', { name: 'Pair' }).click()
    await expect(page.getByText(/already signed in/i)).toBeVisible()

    // The code was not spent: no device of that name exists.
    const res = await request.get('/api/mux/devices')
    const { devices } = (await res.json()) as { devices: { name: string }[] }
    expect(devices.map((d) => d.name)).not.toContain(name)
    await page.context().close()
  })

  test('a paired full device pairs view devices only, which go when it is revoked', async ({
    browser,
    baseURL,
    request,
  }) => {
    const tag = Math.random().toString(36).slice(2, 8)
    const fullName = `e2e-full-${tag}`
    const childName = `e2e-child-${tag}`
    made.push(fullName, childName)
    // The password (Basic auth, as the CLI) pairs a full device.
    const full = await pairStranger(browser, baseURL, (await makeCode(request, 'full', fullName)).code)
    await full.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 15000 })

    // Its Pair a device offers view only and says where full devices come from.
    await full.getByRole('button', { name: 'More' }).click()
    await full.getByRole('menuitem', { name: 'Settings' }).click()
    await full
      .getByRole('navigation', { name: 'Settings groups' })
      .getByRole('button', { name: 'Devices' })
      .click()
    await full.getByRole('button', { name: 'Pair a device' }).click()
    await expect(full.getByText('termote pair --role full')).toBeVisible()
    await expect(full.getByRole('radiogroup', { name: 'Role' })).toHaveCount(0)
    await expect(full.getByLabel('Stays signed in for')).toHaveValue(String(30 * 86400))
    await full.getByRole('button', { name: 'Cancel' }).click()

    // The server refuses a full code to it all the same.
    const refused = await writeAs(full, baseURL, '/api/mux/devices/pair', { role: 'full' })
    expect(refused.status()).toBe(403)
    expect((await refused.json()).code).toBe('full_needs_password')

    const res = await writeAs(full, baseURL, '/api/mux/devices/pair', {
      role: 'view',
      name: childName,
      validFor: 86400,
    })
    expect(res.status(), await res.text()).toBe(200)
    const child = await pairStranger(browser, baseURL, ((await res.json()) as Code).code)
    await expect(child.getByText('View only: you can watch this terminal but not type')).toBeVisible({
      timeout: 15000,
    })

    // Revoking the full device takes its child: the child is sent to sign in.
    const fullId = await deviceId(request, fullName)
    const childId = await deviceId(request, childName)
    const del = await request.delete(`/api/mux/devices/${fullId}`, {
      headers: { 'Content-Type': 'application/json' },
    })
    expect(del.status()).toBe(200)
    expect((await del.json()).revoked).toEqual([fullId, childId])
    await expect(child).toHaveURL(/\/login/, { timeout: 20000 })
    await full.context().close()
    await child.context().close()
  })

  test('logging out a full device leaves the devices it paired', async ({ browser, baseURL, request }) => {
    const tag = Math.random().toString(36).slice(2, 8)
    const fullName = `e2e-full-${tag}`
    const childName = `e2e-child-${tag}`
    made.push(fullName, childName)
    const full = await pairStranger(browser, baseURL, (await makeCode(request, 'full', fullName)).code)
    const res = await writeAs(full, baseURL, '/api/mux/devices/pair', { role: 'view', name: childName })
    const child = await pairStranger(browser, baseURL, ((await res.json()) as Code).code)
    const fullId = await deviceId(request, fullName)

    const out = await writeAs(full, baseURL, '/api/mux/logout', {})
    expect(out.status()).toBe(204)
    expect((await child.request.get('/api/mux/snapshot')).status()).toBe(200)
    const { devices } = (await (await request.get('/api/mux/devices')).json()) as {
      devices: { name: string; pairedBy: string; pairedByName?: string }[]
    }
    const kept = devices.find((d) => d.name === childName)
    expect(kept?.pairedBy).toBe(fullId)
    expect(kept?.pairedByName).toBeUndefined()
    await full.context().close()
    await child.context().close()
  })
})

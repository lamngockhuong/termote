import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from './fixtures'

// `termote url --open` against a server with sign-in on: the CLI's sign-in
// link file, opened in a browser without a session, must land in the app
// without passing through /login (the session cookie is SameSite=Strict and
// the file's POST is cross-site, so a 303 would lose it). Without
// TERMOTE_E2E_AUTH=1 the spec skips, as signins.spec.ts.
const enabled = process.env.TERMOTE_E2E_AUTH === '1'
const user = process.env.TERMOTE_USER || 'admin'
const pass = process.env.TERMOTE_PASS ?? ''

// The file the CLI writes (server/cli_login_link.go), for token and hash.
function linkFile(dir: string, action: string, token: string, hash: string): string {
  const path = join(dir, 'login-0123456789abcdef.html')
  writeFileSync(
    path,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Termote</title></head>
<body><form method="post" action="${action}"><input type="hidden" name="t" value="${token}"><input type="hidden" name="hash" value="${hash}">
<p>Signing in to Termote... <button type="submit">Continue</button></p></form><script>document.forms[0].submit()</script></body></html>`,
    { mode: 0o600 },
  )
  return path
}

test.describe('sign-in link from the CLI', () => {
  test.skip(!enabled, 'needs TERMOTE_E2E_AUTH=1 and a server with sign-in on (TERMOTE_PASS)')

  let dir = ''
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'termote-link-'))
  })
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('opens the app signed in at the deep link, once', async ({ browser, baseURL, request }) => {
    const res = await request.post('/api/mux/login-links', {
      data: {},
      headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` },
    })
    expect(res.status(), await res.text()).toBe(200)
    const { token } = (await res.json()) as { token: string }
    const file = pathToFileURL(linkFile(dir, `${baseURL}/login/link`, token, '#/s/main/0')).href

    // A browser with no session and no credentials.
    const context = await browser.newContext({ baseURL, httpCredentials: undefined })
    await context.addInitScript(() => {
      localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true }))
    })
    const page = await context.newPage()
    const visited: string[] = []
    page.on('request', (r) => {
      if (r.isNavigationRequest()) visited.push(new URL(r.url()).pathname)
    })
    await page.goto(file)
    await expect(page).toHaveURL(`${baseURL}/#/s/main/0`, { timeout: 15000 })
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 15000 })
    expect(visited.filter((p) => p === '/login')).toEqual([])
    expect((await page.request.get('/api/mux/snapshot')).status()).toBe(200)

    // The same file again: the token is spent.
    const again = await context.newPage()
    await again.goto(file)
    await expect(again.getByRole('alert')).toHaveText(/sign-in link has expired/)
    await context.close()
  })
})

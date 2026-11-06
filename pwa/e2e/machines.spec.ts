import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, type Page, test } from './fixtures'
import { deviceId, makeCode, pairStranger } from './pairing'

// Machines: this server reaching another termote over its bridge. The
// e2e-machines CI job starts a second, native server (a saved config, its
// own HOME and XDG dirs, tmux on its own socket) and this one with
// TERMOTE_E2E_MACHINE_BRIDGE naming that server's bridge socket, so no sshd
// is needed: the ssh argv is checked by the Go tests. Without
// TERMOTE_E2E_MACHINE=1 the spec skips. TERMOTE_E2E_MACHINE_HOME is the
// machine's HOME: what a terminal or the Files view there shows proves the
// page works on that machine, not on this one.
const enabled = process.env.TERMOTE_E2E_MACHINE === '1'
const machineHome = process.env.TERMOTE_E2E_MACHINE_HOME ?? ''
const LABEL = 'Remote box'
const user = process.env.TERMOTE_USER || 'admin'
const pass = process.env.TERMOTE_PASS ?? ''

test.skip(!enabled || !path.isAbsolute(machineHome), 'needs TERMOTE_E2E_MACHINE=1 and TERMOTE_E2E_MACHINE_HOME')

const rows = (page: Page) => page.locator('[data-testid="terminal-view"] .xterm-rows')

// Signs the page in on the server's sign-in form (Basic credentials reach
// the API, not the page).
async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill(user)
  await page.getByLabel('Password').fill(pass)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 15000 })
}

// Opens the machine from the sidebar and waits for its terminal; a paired
// device (signed: false) is signed in already.
async function openMachine(page: Page, signed = false) {
  if (!signed) await signIn(page)
  else await page.goto('/')
  const machines = page.getByRole('region', { name: 'Machines' })
  await expect(machines.getByRole('img', { name: 'Online' })).toBeVisible({ timeout: 20000 })
  await machines.getByRole('button', { name: new RegExp(`^${LABEL}`) }).click()
  await expect(page).toHaveURL(/\?machine=[0-9a-f]{16}/)
  await expect(page).toHaveTitle(`${LABEL} — Termote`)
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 20000 })
}

test.describe('machines', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
  })

  test('lists the machine with its status, and nothing of its host', async ({ page, request }) => {
    const res = await request.get('/api/mux/machines')
    expect(res.ok()).toBe(true)
    const body = await res.text()
    expect(body).toContain(`"label":"${LABEL}"`)
    expect(body).not.toContain(machineHome)
    await signIn(page)
    const machines = page.getByRole('region', { name: 'Machines' })
    await expect(machines.getByRole('button', { name: 'This machine' })).toHaveAttribute('aria-current', 'true')
    await expect(machines.getByRole('img', { name: 'Online' })).toBeVisible({ timeout: 20000 })
  })

  test("types into the machine's terminal and reads its files", async ({ page }) => {
    const proof = `machine-proof-${Date.now()}.txt`
    mkdirSync(machineHome, { recursive: true })
    writeFileSync(path.join(machineHome, proof), 'on the machine\n')

    await openMachine(page)
    await page.waitForSelector('[aria-label="Connected"]', { timeout: 20000 })
    await page.locator('[data-testid="terminal-view"] .xterm').click()
    // The shell there runs with the machine's HOME
    await page.keyboard.type('printf "home=%s\\n" "$HOME"')
    await page.keyboard.press('Enter')
    await expect(rows(page)).toContainText(`home=${machineHome}`, { timeout: 15000 })

    await page.keyboard.type(`cd ~ && ls ${proof}`)
    await page.keyboard.press('Enter')
    await expect(rows(page)).toContainText(proof, { timeout: 15000 })

    // The Files routes read the machine's disk: the pane's folder there
    // holds the file written into its HOME
    const listed = await page.evaluate(async (name) => {
      const base = `/api/machines/${new URLSearchParams(window.location.search).get('machine')}/mux`
      const snap = await (await fetch(`${base}/snapshot`)).json()
      const pane = snap.groups[0].tabs[0].panes[0].id
      const res = await fetch(`${base}/panes/${encodeURIComponent(pane)}/files/tree?path=`)
      return (await res.text()).includes(name)
    }, proof)
    expect(listed).toBe(true)

    // Back to this machine from the sidebar
    await page
      .getByRole('region', { name: 'Machines' })
      .getByRole('button', { name: 'This machine' })
      .click()
    await expect(page).not.toHaveURL(/machine=/)
  })

  test('a view-only device here only watches the machine', async ({ browser, baseURL, page, request }) => {
    const name = `e2e-machine-viewer-${Date.now()}`
    const { code } = await makeCode(request, 'view', name)
    const viewer = await pairStranger(browser, baseURL, code)
    try {
      await viewer.setViewportSize({ width: 1280, height: 800 })
      await openMachine(viewer, true)
      await expect(viewer.getByText('View only: you can watch this terminal but not type')).toBeVisible({
        timeout: 20000,
      })
      // A write through the proxy is refused at the edge
      const status = await viewer.evaluate(async () => {
        const id = new URLSearchParams(window.location.search).get('machine')
        const res = await fetch(`/api/machines/${id}/mux/tabs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
        return res.status
      })
      expect(status).toBe(403)

      // The full browser types; the viewer sees it
      await openMachine(page)
      await page.waitForSelector('[aria-label="Connected"]', { timeout: 20000 })
      const word = `watched-${Date.now()}`
      await page.locator('[data-testid="terminal-view"] .xterm').click()
      await page.keyboard.type(`echo ${word}`)
      await page.keyboard.press('Enter')
      await expect(rows(viewer)).toContainText(word, { timeout: 20000 })
    } finally {
      await viewer.context().close()
      const id = await deviceId(request, name)
      await request.delete(`/api/mux/devices/${id}`, { headers: { 'Content-Type': 'application/json' } })
    }
  })
})

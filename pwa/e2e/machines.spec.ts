import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { APIRequestContext } from '@playwright/test'
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
// The machine's own address (no sign-in there): reading its ledger directly
// proves a change through Machines landed on it, not on this server.
const machineURL = process.env.TERMOTE_E2E_MACHINE_URL ?? ''
const SAME = { 'Sec-Fetch-Site': 'same-origin' }

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

interface LedgerJob {
  id: string
  title: string
  state: string
  updated: string
  createdBy?: string
}

async function ledger(request: APIRequestContext, base: string): Promise<LedgerJob[]> {
  const res = await request.get(`${base}/api/mux/jobs?all=1`, { headers: SAME })
  expect(res.ok()).toBe(true)
  return ((await res.json()) as { jobs: LedgerJob[] }).jobs
}

// Removes the jobs this run made on the machine, whatever a test left.
async function cleanMachine(request: APIRequestContext, tag: string) {
  for (const j of await ledger(request, machineURL)) {
    if (!j.title.endsWith(tag)) continue
    await request.delete(`${machineURL}/api/mux/jobs/${j.id}?updated=${encodeURIComponent(j.updated)}`, {
      headers: SAME,
    })
  }
}

// Opens the Plan tab of the Overview of the machine open in page.
async function openPlan(page: Page) {
  await page.goto(`${page.url().split('#')[0]}#/overview`)
  await page.getByRole('tab', { name: /^Plan/ }).click()
}

const planRegion = (page: Page) => page.getByRole('region', { name: 'Plan' })

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

  test.describe("the machine's Plan", () => {
    const tag = `${Date.now()}`
    test.skip(!machineURL, 'needs TERMOTE_E2E_MACHINE_URL')
    test.afterEach(async ({ request }) => cleanMachine(request, tag))

    test("the Plan tab reads and changes the machine's jobs", async ({ page, request }) => {
      await openMachine(page)
      await openPlan(page)
      const title = `machine-job-${tag}`
      await planRegion(page).getByRole('button', { name: 'New job' }).click()
      const sheet = page.getByRole('dialog', { name: 'New job' })
      await sheet.getByRole('textbox', { name: 'Title' }).fill(title)
      await sheet.getByRole('button', { name: 'Add' }).click()
      await expect(sheet).toBeHidden()
      const card = planRegion(page).getByRole('article', { name: title })
      await expect(card).toContainText('To do')
      // On the machine, made by the user's browser; not on this server
      expect((await ledger(request, machineURL)).find((j) => j.title === title)).toMatchObject({ createdBy: 'pwa' })
      expect((await ledger(request, '')).some((j) => j.title === title)).toBe(false)

      await card.getByRole('button', { name: title }).click()
      const panel = page.getByRole('complementary', { name: title }).or(page.getByRole('dialog', { name: title }))
      await panel.getByRole('button', { name: `Edit ${title}` }).click()
      let edit = page.getByRole('dialog', { name: `Edit ${title}` })
      await edit.getByRole('combobox', { name: 'State' }).selectOption('review')
      await edit.getByRole('button', { name: 'Save' }).click()
      await expect(edit).toBeHidden()
      await expect(card).toContainText('Review')
      await expect
        .poll(async () => (await ledger(request, machineURL)).find((j) => j.title === title)?.state)
        .toBe('review')

      await panel.getByRole('button', { name: `Edit ${title}` }).click()
      edit = page.getByRole('dialog', { name: `Edit ${title}` })
      await edit.getByRole('button', { name: 'Delete' }).click()
      await page.getByRole('dialog', { name: `Delete ${title}?` }).getByRole('button', { name: 'Delete' }).click()
      await expect(card).toHaveCount(0)
      await expect.poll(async () => (await ledger(request, machineURL)).some((j) => j.title === title)).toBe(false)
    })

    test('grants, history and adding a question stay on the machine', async ({ page, request }) => {
      const title = `machine-kept-${tag}`
      const made = await request.post(`${machineURL}/api/mux/jobs`, {
        headers: { ...SAME, 'Content-Type': 'application/json' },
        data: { title },
      })
      expect(made.status()).toBe(201)
      const { job } = (await made.json()) as { job: LedgerJob }
      await openMachine(page)
      const answers = await page.evaluate(async (id) => {
        const base = `/api/machines/${new URLSearchParams(window.location.search).get('machine')}/mux`
        const post = async (path: string, body: object) => {
          const res = await fetch(`${base}/${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          return { status: res.status, code: ((await res.json()) as { code?: string }).code }
        }
        const asks = await fetch(`${base}/asks`)
        return {
          grants: await post(`jobs/${id}/grants`, { kind: 'bash', prefix: 'ls', minutes: 5 }),
          event: await post(`jobs/${id}/event`, { kind: 'sent', text: 'x' }),
          addAsk: await post('asks', { pane: 'x', text: 'q' }),
          asks: { status: asks.status, body: await asks.json() },
        }
      }, job.id)
      expect(answers.grants).toEqual({ status: 404, code: 'machine_route_forbidden' })
      expect(answers.event).toEqual({ status: 404, code: 'machine_route_forbidden' })
      expect(answers.addAsk).toEqual({ status: 404, code: 'machine_route_forbidden' })
      expect(answers.asks.status).toBe(200)
      expect(Array.isArray(answers.asks.body.asks)).toBe(true)
    })

    test('a view-only device here reads the brief of the machine\'s jobs', async ({
      browser,
      baseURL,
      request,
    }) => {
      const title = `machine-brief-${tag}`
      const made = await request.post(`${machineURL}/api/mux/jobs`, {
        headers: { ...SAME, 'Content-Type': 'application/json' },
        data: { title, prompt: 'secret prompt', note: 'secret note' },
      })
      expect(made.status()).toBe(201)
      const name = `e2e-machine-plan-viewer-${Date.now()}`
      const { code } = await makeCode(request, 'view', name)
      const viewer = await pairStranger(browser, baseURL, code)
      try {
        await viewer.setViewportSize({ width: 1280, height: 800 })
        await openMachine(viewer, true)
        const read = await viewer.evaluate(async () => {
          const base = `/api/machines/${new URLSearchParams(window.location.search).get('machine')}/mux`
          const list = await (await fetch(`${base}/jobs?all=1`)).json()
          const asks = await (await fetch(`${base}/asks`)).json()
          const add = await fetch(`${base}/jobs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"title":"no"}',
          })
          return { list, asks, add: add.status }
        })
        expect(read.add).toBe(403)
        expect(read.list.readOnly).toBe(true)
        expect(read.asks.readOnly).toBe(true)
        const allowed = new Set(['id', 'title', 'state', 'branch', 'live', 'updated', 'ciSummary'])
        const mine = (read.list.jobs as Record<string, unknown>[]).find((j) => j.title === title)
        expect(mine).toBeTruthy()
        for (const j of read.list.jobs as Record<string, unknown>[])
          expect(Object.keys(j).filter((k) => !allowed.has(k))).toEqual([])
        expect(JSON.stringify(read.list)).not.toContain('secret')

        await openPlan(viewer)
        await expect(planRegion(viewer).getByText(title)).toBeVisible({ timeout: 15000 })
        await expect(planRegion(viewer).getByRole('button', { name: 'New job' })).toHaveCount(0)
      } finally {
        await viewer.context().close()
        const id = await deviceId(request, name)
        await request.delete(`/api/mux/devices/${id}`, { headers: { 'Content-Type': 'application/json' } })
      }
    })
  })
})

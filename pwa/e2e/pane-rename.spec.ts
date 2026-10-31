import { createConnection } from 'node:net'
import type { APIRequestContext } from '@playwright/test'
import { expect, type Page, test } from './fixtures'

// Naming a pane from the Pane menu against a real backend: the name shows
// in the sidebar row of a one-pane tab, stays after a reload (the backend
// keeps it), shows in the pane strip once the tab is split, and clearing it
// gives the pane its own label back. On Herdr, metadata a plugin reports
// over the socket shows as text chips. TERMOTE_E2E_HERDR=1 (the e2e-herdr
// job) is Herdr on HERDR_SOCKET_PATH, TERMOTE_E2E_ZELLIJ=1 (the e2e-zellij
// job) is Zellij on ZELLIJ_SOCKET_DIR, else tmux on TMUX_SOCKET (the E2E
// job). Without that socket the spec skips, so a developer's own Herdr,
// Zellij or tmux is never touched; with it, a server on another backend, or
// one without caps.renamePane, is a failure.
const herdr = process.env.TERMOTE_E2E_HERDR === '1'
const zellij = process.env.TERMOTE_E2E_ZELLIJ === '1'
const backend = herdr ? 'herdr' : zellij ? 'zellij' : 'tmux'
const SOCKET_VAR = {
  tmux: 'TMUX_SOCKET',
  herdr: 'HERDR_SOCKET_PATH',
  zellij: 'ZELLIJ_SOCKET_DIR',
}[backend]
const socket = process.env[SOCKET_VAR] ?? ''

// The group a backend's spec makes its tab in, as pane-layout.spec.ts
const GROUP = { tmux: 'e2e', herdr: 'e2e-repo', zellij: 'main' }[backend]

interface Pane {
  id: string
  name?: string
  meta?: { key: string; value: string }[]
}
interface Snapshot {
  backend: string
  caps: { renamePane?: boolean }
  groups: {
    id: string
    name: string
    meta?: { key: string; value: string }[]
    tabs: { id: string; panes?: Pane[] }[]
  }[]
}

const snapshot = async (request: APIRequestContext): Promise<Snapshot> =>
  (await request.get('/api/mux/snapshot')).json()

const WRITE_HEADERS = {
  'Content-Type': 'application/json',
  'Sec-Fetch-Site': 'same-origin',
}

const panesOf = async (request: APIRequestContext, tabId: string) =>
  (await snapshot(request)).groups
    .flatMap((g) => g.tabs)
    .find((t) => t.id === tabId)?.panes ?? []

// One Herdr RPC on the job's socket: a JSON line out, one line back. The
// 0.9.5 CLI cannot parse report-metadata's --source, so the method is called
// as a plugin would.
function herdrCall(method: string, params: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socket)
    let reply = ''
    conn.on('connect', () =>
      conn.write(`${JSON.stringify({ id: 'e2e', method, params })}\n`),
    )
    conn.on('data', (b) => {
      reply += b.toString()
      if (!reply.includes('\n')) return
      conn.end()
      const res = JSON.parse(reply)
      if (res.error) reject(new Error(`${method}: ${res.error.code}`))
      else resolve(res.result)
    })
    conn.on('error', reject)
  })
}

async function connected(page: Page) {
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', {
    timeout: 15000,
  })
  await expect(
    page.getByRole('button', { name: 'Connected' }).first(),
  ).toBeAttached({ timeout: 20000 })
}

const strip = (page: Page) => page.getByRole('group', { name: 'Panes' })
const onlyPane = (page: Page) => page.locator('[data-only-pane]')
// The strip's button of the pane named build (not its close button)
const named = (page: Page) =>
  strip(page).locator('button[aria-pressed]', { hasText: 'build' })

async function renameShownPane(page: Page, name: string) {
  await page.getByRole('button', { name: 'Pane', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Rename pane' }).click()
  const box = page.getByRole('textbox', { name: 'Name' })
  await box.fill(name)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(box).toBeHidden()
}

test.describe(`Pane names on ${backend}`, () => {
  test.skip(!socket, `needs ${SOCKET_VAR}, the ${backend} socket of the server under test`)
  test.describe.configure({ timeout: 90000 })

  let groupId = ''
  let tabId = ''
  let paneId = ''

  test.beforeEach(async ({ request }) => {
    const snap = await snapshot(request)
    expect(snap.backend, `the server under test runs ${backend}`).toBe(backend)
    expect(snap.caps.renamePane, 'caps.renamePane').toBe(true)
    const group = snap.groups.find((g) => g.name === GROUP)
    expect(group, `the ${GROUP} group`).toBeTruthy()
    groupId = group!.id
  })

  // A failed test leaves no name behind: a named pane outranks its agent's
  // name in every other spec
  test.afterEach(async ({ request }) => {
    if (paneId) {
      await request.patch(`/api/mux/panes/${encodeURIComponent(paneId)}`, {
        headers: WRITE_HEADERS,
        data: { name: '' },
      })
    }
    if (tabId) {
      await request.delete(`/api/mux/tabs/${encodeURIComponent(tabId)}`, {
        headers: WRITE_HEADERS,
      })
    }
    paneId = ''
    tabId = ''
  })

  // A tab of its own, shown on the page
  async function openTab(page: Page, request: APIRequestContext) {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('e2e-opened')) return
      sessionStorage.setItem('e2e-opened', '1')
      localStorage.clear()
    })
    // The page first: on Zellij its stream is the client a new tab needs
    await page.goto('/')
    await connected(page)
    const res = await request.post('/api/mux/tabs', {
      headers: WRITE_HEADERS,
      data: {
        groupId,
        name: `e2e-name-${Math.random().toString(36).slice(2, 8)}`,
      },
    })
    expect(res.ok()).toBe(true)
    tabId = (await res.json()).id
    await expect
      .poll(async () => (await panesOf(request, tabId)).length, {
        timeout: 15000,
      })
      .toBe(1)
    paneId = (await panesOf(request, tabId))[0].id
    await page.goto(
      `/#/s/${encodeURIComponent(groupId)}/${encodeURIComponent(tabId)}`,
    )
    await page.reload()
    await connected(page)
  }

  test('name a pane, keep it through a reload and a split, then clear it', async ({
    page,
    request,
  }) => {
    await openTab(page, request)

    // A one-pane tab: the name under the tab's name in the sidebar
    await renameShownPane(page, 'build')
    await expect(onlyPane(page)).toHaveText('build', { timeout: 15000 })
    await expect
      .poll(async () => (await panesOf(request, tabId))[0]?.name)
      .toBe('build')

    // Kept by the backend, not the page
    await page.reload()
    await connected(page)
    await expect(onlyPane(page)).toHaveText('build', { timeout: 15000 })

    // Split past the UI: the pane shown stays the named one, which the
    // strip now labels by its name
    const split = await request.post(
      `/api/mux/panes/${encodeURIComponent(paneId)}/split`,
      { headers: WRITE_HEADERS, data: { direction: 'right' } },
    )
    expect(split.ok()).toBe(true)
    await expect(strip(page).locator('button[aria-pressed]')).toHaveCount(2, {
      timeout: 15000,
    })
    await expect(
      named(page),
    ).toBeVisible()
    await expect(onlyPane(page)).toHaveCount(0)

    // Cleared: the pane has its own label again. Picked first, where the
    // page may have moved to the new pane
    await named(page).click()
    await expect(
      named(page),
    ).toHaveAttribute('aria-pressed', 'true')
    await renameShownPane(page, '')
    await expect
      .poll(async () =>
        (await panesOf(request, tabId)).find((p) => p.id === paneId)?.name,
      )
      .toBeUndefined()
    await expect(named(page)).toHaveCount(
      0,
      { timeout: 15000 },
    )
  })

  test('Herdr metadata shows as text chips', async ({ page, request }) => {
    test.skip(!herdr, 'metadata comes from Herdr only')
    await openTab(page, request)
    const source = `e2e-${Math.random().toString(36).slice(2, 8)}`
    await herdrCall('workspace.report_metadata', {
      workspace_id: groupId,
      source,
      tokens: { env: '<b>dev</b>' },
    })
    await herdrCall('pane.report_metadata', {
      pane_id: paneId,
      source,
      tokens: { pr: '<i>42</i>' },
    })
    try {
      // Within a poll of the event, never markup
      await expect(page.getByText('env: <b>dev</b>')).toBeVisible({
        timeout: 15000,
      })
      await expect(onlyPane(page)).toHaveText('pr: <i>42</i>', {
        timeout: 15000,
      })
      await expect(page.locator('[data-meta-chips] b, [data-meta-chips] i')).toHaveCount(0)
      await expect(
        page.locator('[data-meta-chips]').filter({ hasText: 'env:' }),
      ).toHaveAttribute('title', /^Reported by a Herdr plugin\n/)
    } finally {
      await herdrCall('workspace.report_metadata', {
        workspace_id: groupId,
        source,
        tokens: { env: null },
      })
    }
  })
})

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { APIRequestContext } from '@playwright/test'
import { expect, type Page, test } from './fixtures'
import { deviceId, makeCode, pairStranger } from './pairing'

// The herdr-core backend (--mux hc) from the PWA, against a core of its own:
// the e2e-hc CI job starts hc on HC_SOCKET with its own HC_SESSION, HOME and
// XDG dirs, then the server with TERMOTE_MUX=hc and sign-in on. Without
// TERMOTE_E2E_HC=1 the spec skips, so a developer's own core is never
// touched; with it, a server on another backend is a failure. The hc CLI, on
// that socket only, sets up what herdr-app would have (labelled terminals,
// herdr-app's document) and reads what the snapshot does not show.
const enabled = process.env.TERMOTE_E2E_HC === '1'
const user = process.env.TERMOTE_USER || 'admin'
const pass = process.env.TERMOTE_PASS ?? ''
const socket = process.env.HC_SOCKET ?? ''
const dir = process.env.TERMOTE_E2E_HC_DIR ?? ''

// Whether the core under test is one of its own: HC_SOCKET inside
// TERMOTE_E2E_HC_DIR, itself inside a temporary directory. Anything else
// could be a core someone uses, whose layout the spec would overwrite.
function isolatedCore(): boolean {
  if (!path.isAbsolute(socket) || !path.isAbsolute(dir)) return false
  const inside = (parent: string, child: string) => {
    const rel = path.relative(parent, child)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }
  try {
    const real = realpathSync(dir)
    const roots = [tmpdir(), process.env.RUNNER_TEMP, '/tmp'].filter((r): r is string => !!r)
    return (
      inside(dir, socket) &&
      roots.some((r) => {
        try {
          return inside(realpathSync(r), real)
        } catch {
          return false
        }
      })
    )
  } catch {
    return false
  }
}
const isolated = isolatedCore()

const hcEnv = () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HC_SOCKET: socket,
    HC_SESSION: process.env.HC_SESSION ?? 'e2e',
    XDG_RUNTIME_DIR: dir,
    XDG_STATE_HOME: `${dir}/state`,
    XDG_CONFIG_HOME: `${dir}/config`,
  }
  // Run from inside an hc terminal, the CLI would act as that terminal
  delete env.HC_TERMINAL_ID
  return env
}
const hc = (...args: string[]) =>
  execFileSync('hc', [...args, '--json'], { encoding: 'utf-8', env: hcEnv(), stdio: ['ignore', 'pipe', 'pipe'] })

// Plain JSON-RPC lines through `hc connect`: hello, then each call
function rpc(...calls: { method: string; params: unknown }[]) {
  const lines = [{ method: 'hello', params: { generation: 1 } }, ...calls].map((c, id) =>
    JSON.stringify({ jsonrpc: '2.0', id, ...c }),
  )
  const out = execFileSync('hc', ['connect'], { encoding: 'utf-8', env: hcEnv(), input: `${lines.join('\n')}\n` })
  const replies = out
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  for (const r of replies) if (r.error) throw new Error(`hc ${JSON.stringify(r.error)}`)
  return replies
}

interface HcTerminal {
  address: string
  state: string
  labels?: Record<string, string>
}
const terminal = (t: string): HcTerminal & { cols: number; rows: number; turn: number } =>
  JSON.parse(hc('get', t))
// The live terminals labelled key=value (hc ls prints no labels: each one
// is read with hc get)
const liveWith = (key: string, value: string): HcTerminal[] =>
  (JSON.parse(hc('ls')).terminals as HcTerminal[])
    .map((t) => terminal(t.address))
    .filter((t) => t.state === 'live' && t.labels?.[key] === value)

// A shell in space and tab, as herdr-app starts one
function runShell(space: string, tab: string): string {
  const out = hc(
    'run',
    '--bg',
    '--keep',
    '--no-parent',
    '--label',
    `herdr.space=${space}`,
    '--label',
    `herdr.tab=${tab}`,
    '--label',
    'termote.e2e=1',
  )
  return (JSON.parse(out) as HcTerminal).address
}

const hexId = (prefix: string) =>
  prefix +
  Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')
const marker = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`
// Echoes a marker so that only the output holds it, not the command line
const echo = (word: string) => `echo ${word.replace('-', '""-')}`

interface Snapshot {
  backend: string
  caps: { paneStream?: boolean; renameGroup?: boolean }
  groups: {
    id: string
    name: string
    tabs: {
      id: string
      name: string
      layout?: unknown
      panes: { id: string; agent?: { name: string; status: string } }[]
    }[]
  }[]
}
const snapshot = async (request: APIRequestContext): Promise<Snapshot> =>
  (await request.get('/api/mux/snapshot')).json()
const groupOf = async (request: APIRequestContext, id: string) => (await snapshot(request)).groups.find((g) => g.id === id)
const tabOf = async (request: APIRequestContext, id: string) =>
  (await snapshot(request)).groups.flatMap((g) => g.tabs).find((t) => t.id === id)

// A write sent past the UI (a same-site JSON request)
const WRITE_HEADERS = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }

const layoutPane = (page: Page, id: string) => page.locator(`[data-pane-id="${id}"]`)
const screenText = (page: Page, id: string) => layoutPane(page, id).locator('.xterm-rows')
const strip = (page: Page) => page.getByRole('group', { name: 'Panes' })

async function connected(page: Page) {
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 15000 })
  await expect(page.getByRole('button', { name: 'Connected' }).first()).toBeAttached({ timeout: 20000 })
}

// Signs the page in on the server's sign-in form (Basic credentials reach
// the API, not the page), then opens group and tab
async function openTab(page: Page, group: string, tab: string) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-opened')) return
    sessionStorage.setItem('e2e-opened', '1')
    localStorage.clear()
  })
  await page.goto('/login')
  await page.getByLabel('Username').fill(user)
  await page.getByLabel('Password').fill(pass)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 15000 })
  await page.goto(`/#/s/${encodeURIComponent(group)}/${encodeURIComponent(tab)}`)
  await connected(page)
}

async function typeIn(page: Page, pane: string, command: string) {
  await layoutPane(page, pane).locator('.xterm').click()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

async function paneAction(page: Page, item: string) {
  await page.getByRole('button', { name: 'Pane', exact: true }).click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

test.describe('herdr-core from the PWA', () => {
  test.skip(!enabled, 'needs TERMOTE_E2E_HC=1: a herdr-core of its own (the e2e-hc job)')
  test.describe.configure({ timeout: 90000 })

  // A space as herdr-app keeps one: two shells in one tab, b left of a in
  // herdr-app's document
  const space = hexId('sp')
  const tab = hexId('tb')
  let a = ''
  let b = ''
  const madeTabs: string[] = []

  // herdr-app's document before the spec wrote its own, put back after
  let savedDoc: unknown = null

  test.beforeAll(() => {
    expect(socket, 'HC_SOCKET').not.toBe('')
    expect(dir, 'TERMOTE_E2E_HC_DIR').not.toBe('')
    expect(isolated, 'HC_SOCKET inside TERMOTE_E2E_HC_DIR, inside a temporary directory').toBe(true)
    expect(pass, 'TERMOTE_PASS: the server runs with sign-in on').not.toBe('')
    // A worker started again after a failure runs this again: what an
    // earlier one left goes first
    for (const t of liveWith('termote.e2e', '1')) hc('kill', t.address)
    a = runShell(space, tab)
    b = runShell(space, tab)
    const [, got] = rpc({ method: 'doc.get', params: { name: 'herdr-app' } })
    savedDoc = got.result.value
    const block = (id: string, t: string) => ({ id, type: 'block', content: { terminal: t }, size: { weight: 0.5 } })
    rpc({
      method: 'doc.set',
      params: {
        name: 'herdr-app',
        version: got.result.version,
        value: {
          spaces: [
            {
              id: space,
              name: 'e2e-space',
              folder: '',
              tabs: [{ id: tab, name: 'e2e-tab', root: { id: tab, type: 'row', children: [block('p1', b), block('p2', a)] } }],
            },
          ],
        },
      },
    })
  })

  test.afterAll(() => {
    if (!enabled || !isolated) return
    for (const t of liveWith('termote.e2e', '1')) hc('kill', t.address)
    const [, got] = rpc({ method: 'doc.get', params: { name: 'herdr-app' } })
    rpc({ method: 'doc.set', params: { name: 'herdr-app', version: got.result.version, value: savedDoc } })
  })

  test.beforeEach(async ({ request }) => {
    const snap = await snapshot(request)
    // The job runs herdr-core: another backend is a failure, not a skip
    expect(snap.backend, 'the server under test runs hc').toBe('hc')
    expect(snap.caps.paneStream, 'caps.paneStream').toBe(true)
  })

  test.afterEach(async ({ request }) => {
    for (const id of madeTabs.splice(0)) {
      await request.delete(`/api/mux/tabs/${encodeURIComponent(id)}`, { headers: WRITE_HEADERS })
    }
  })

  test("herdr-app's document: the space, its split tab side by side, typing keeps the size", async ({
    page,
    request,
  }) => {
    await expect
      .poll(async () => {
        const g = await groupOf(request, space)
        return g && { name: g.name, tabs: g.tabs.map((t) => ({ name: t.name, panes: t.panes.map((p) => p.id) })) }
      })
      .toEqual({ name: 'e2e-space', tabs: [{ name: 'e2e-tab', panes: [b, a] }] })
    expect((await tabOf(request, tab))?.layout, 'the tab layout').toBeTruthy()

    await page.setViewportSize({ width: 1280, height: 800 })
    await openTab(page, space, tab)
    await expect(page.locator('aside section[aria-label="e2e-space"]')).toBeVisible()
    await expect(layoutPane(page, b)).toBeVisible({ timeout: 15000 })
    await expect(layoutPane(page, a)).toBeVisible()
    const [left, right] = [(await layoutPane(page, b).boundingBox())!, (await layoutPane(page, a).boundingBox())!]
    expect(right.x).toBeGreaterThan(left.x + left.width / 2)

    // Typed from the page: on screen, and the desktop's size is left alone
    const before = terminal(a)
    const word = marker('hc-typed')
    await typeIn(page, a, echo(word))
    await expect(screenText(page, a)).toContainText(word, { timeout: 15000 })
    await expect(screenText(page, b)).not.toContainText(word)
    const after = terminal(a)
    expect({ cols: after.cols, rows: after.rows }).toEqual({ cols: before.cols, rows: before.rows })
    // An agent reporting through OSC 7501 shows as Claude Code
    await typeIn(page, a, String.raw`printf '\033]7501;state=working:app=claude-code\033\\'`)
    await expect
      .poll(async () => (await tabOf(request, tab))?.panes.find((p) => p.id === a)?.agent, { timeout: 15000 })
      .toEqual(expect.objectContaining({ name: 'claude', status: 'working' }))
    // The turn ends while the page looks at the pane: herdr.seen takes it,
    // so the desktop does not show it as done and unread
    await typeIn(page, a, String.raw`printf '\033]7501;state=done:app=claude-code\033\\'`)
    await expect.poll(() => terminal(a).turn, { timeout: 15000 }).toBeGreaterThan(0)
    await expect.poll(() => terminal(a).labels?.['herdr.seen'], { timeout: 15000 }).toBe(String(terminal(a).turn))
  })

  test("a new tab and a split from the page carry herdr-app's labels, then close", async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openTab(page, space, tab)
    const res = await request.post('/api/mux/tabs', { headers: WRITE_HEADERS, data: { groupId: space, name: 'x' } })
    expect(res.ok(), await res.text()).toBe(true)
    const newTab: string = (await res.json()).id
    madeTabs.push(newTab)
    await expect.poll(async () => (await tabOf(request, newTab))?.panes.length, { timeout: 15000 }).toBe(1)
    const [first] = (await tabOf(request, newTab))!.panes
    expect(liveWith('herdr.tab', newTab).map((t) => [t.address, t.labels?.['herdr.space']])).toEqual([
      [first.id, space],
    ])

    await page.goto(`/#/s/${encodeURIComponent(space)}/${encodeURIComponent(newTab)}`)
    await page.reload()
    await connected(page)
    await paneAction(page, 'Split right')
    await expect.poll(async () => (await tabOf(request, newTab))?.panes.length, { timeout: 15000 }).toBe(2)
    await expect(strip(page).locator('button[aria-pressed]')).toHaveCount(2, { timeout: 15000 })
    const added = (await tabOf(request, newTab))!.panes.find((p) => p.id !== first.id)!
    expect(
      liveWith('herdr.tab', newTab)
        .map((t) => t.address)
        .sort(),
    ).toEqual([first.id, added.id].sort())

    // The pane shown closes after the confirmation: its terminal is killed
    await strip(page).locator(`button[aria-pressed="false"]`).click()
    await expect(strip(page).locator('button[aria-pressed="false"]')).toHaveCount(1)
    const shown = (await strip(page).locator('button[aria-pressed="true"]').getAttribute('data-pane-id')) ?? ''
    await paneAction(page, 'Close pane')
    await page.getByRole('dialog', { name: 'Close pane?' }).getByRole('button', { name: 'Close pane' }).click()
    await expect.poll(async () => (await tabOf(request, newTab))?.panes.length, { timeout: 15000 }).toBe(1)
    await expect.poll(() => liveWith('herdr.tab', newTab).length, { timeout: 15000 }).toBe(1)
    if (shown) expect(liveWith('herdr.tab', newTab).map((t) => t.address)).not.toContain(shown)
    await expect(strip(page)).toHaveCount(0)
  })

  // A view-only device shows one pane at a time (no layout view): the
  // tab's first, b
  test('a view-only device watches the pane and types nothing', async ({ browser, baseURL, page, request }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openTab(page, space, tab)
    const name = marker('e2e-hc-viewer')
    const { code } = await makeCode(request, 'view', name)
    const viewer = await pairStranger(browser, baseURL, code)
    try {
      await viewer.setViewportSize({ width: 1280, height: 800 })
      await viewer.goto(`/#/s/${encodeURIComponent(space)}/${encodeURIComponent(tab)}`)
      await expect(viewer.getByText('View only: you can watch this terminal but not type')).toBeVisible({
        timeout: 20000,
      })
      const viewed = viewer.locator('[data-testid="terminal-view"] .xterm-rows')
      await expect(viewed).toHaveText(/\S/, { timeout: 20000 })

      const word = marker('hc-watched')
      await typeIn(page, b, echo(word))
      await expect(viewed).toContainText(word, { timeout: 15000 })

      const ignored = marker('hc-ignored')
      await viewer.locator('[data-testid="terminal-view"] .xterm').click()
      await viewer.keyboard.type(echo(ignored))
      await viewer.keyboard.press('Enter')
      // Typed after the viewer's keys: once it shows on both, keys the
      // viewer could send would have shown before it
      const after = marker('hc-after')
      await typeIn(page, b, echo(after))
      await expect(viewed).toContainText(after, { timeout: 15000 })
      await expect(screenText(page, b)).not.toContainText(ignored.replace('-', '""-'))
      await expect(viewed).not.toContainText(ignored)
    } finally {
      await viewer.context().close()
      const id = await deviceId(request, name)
      await request.delete(`/api/mux/devices/${id}`, { headers: { 'Content-Type': 'application/json' } })
    }
  })
})

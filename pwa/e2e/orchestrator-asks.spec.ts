import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// The orchestrator's questions in the Plan ("Waiting on you") against a real
// server: the stand-in Claude Code (tests/fixtures/fake-claude.sh) in a tmux
// window of the server under test is the orchestrator. Only termote agents
// adds a question, over the server's local socket, so the spec posts there
// itself (<TERMOTE_E2E_STATE>/termote/run/<port>.sock, the server's own
// XDG_STATE_HOME) naming the stand-in's pane; the answers go through the
// PWA, as do the dismissals. Only a native server (a saved config) opens that socket, so the spec
// runs only with TERMOTE_E2E_ASKS=1: CI sets it in the machines job, against
// that job's native server. The server's other answers are
// the Go tests'.
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'
const stateDir = process.env.TERMOTE_E2E_STATE
const fakeClaude = path.resolve(import.meta.dirname, '../../tests/fixtures/fake-claude.sh')
const tag = `${Date.now()}`

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })

// Every transcript line the stand-in wrote under dir.
function transcriptText(dir: string): string {
  let out = ''
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      out += readFileSync(path.join(e.parentPath, e.name), 'utf-8')
    }
  }
  return out
}

interface SocketReply {
  status: number
  body: { ask?: { id: string }; asks?: { id: string; state: string; answeredBy?: string }[]; code?: string }
}

// A POST (a GET without body) over the server's local socket, as termote
// agents makes it.
function overSocket(port: string, route: string, body?: unknown): Promise<SocketReply> {
  const data = body === undefined ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: path.join(stateDir as string, 'termote', 'run', `${port}.sock`),
        path: route,
        method: body === undefined ? 'GET' : 'POST',
        headers: { Host: 'termote.local-socket', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let text = ''
        res.setEncoding('utf-8')
        res.on('data', (c) => {
          text += c
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }))
      },
    )
    req.on('error', reject)
    req.end(data)
  })
}

const waiting = (page: Page) => page.getByRole('region', { name: 'Waiting on you' })

async function openPlan(page: Page) {
  await page.goto('/#/overview')
  await expect(page.getByRole('region', { name: 'Agents' })).toBeVisible({ timeout: 15000 })
  await page.getByRole('tab', { name: /^Plan/ }).click()
}

test.describe('orchestrator questions', () => {
  test.skip(
    process.env.TERMOTE_E2E_ASKS !== '1' || !socket || !stateDir || process.platform !== 'linux',
    'needs TERMOTE_E2E_ASKS=1, TMUX_SOCKET and TERMOTE_E2E_STATE of a native server under test (Linux, tmux)',
  )
  test.describe.configure({ mode: 'serial' })

  let port = ''
  let windowId = ''
  let pane = ''
  let claudeDir = ''
  let cwd = ''
  const asked: string[] = []

  // ask adds a question from the stand-in's pane, once the server sees its
  // agent (a few seconds after it starts).
  async function ask(text: string, choices: string[] = []): Promise<string> {
    let reply: SocketReply = { status: 0, body: {} }
    await expect(async () => {
      reply = await overSocket(port, '/api/mux/asks', { pane, text, choices })
      expect(reply.body.code).not.toBe('job_no_agent')
    }).toPass({ timeout: 20_000 })
    expect(reply.status).toBe(201)
    const id = reply.body.ask?.id as string
    asked.push(id)
    return id
  }

  test.beforeAll(async ({ playwright }, testInfo) => {
    port = new URL(testInfo.project.use.baseURL as string).port
    // The first snapshot also makes the server's tmux session
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    expect((await api.get('/api/mux/snapshot')).ok()).toBe(true)
    await api.dispose()
    claudeDir = mkdtempSync(path.join(tmpdir(), 'termote-e2e-claude-'))
    cwd = mkdtempSync(path.join(tmpdir(), 'termote-e2e-cwd-'))
    windowId = tmux(
      'new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', `fake-asks-${tag}`, '-c', cwd,
      'env', `CLAUDE_CONFIG_DIR=${claudeDir}`, 'bash', fakeClaude,
    ).trim()
    tmux('select-window', '-t', windowId)
    pane = tmux('display-message', '-p', '-t', windowId, '#{pane_id}').trim()
  })

  test.afterAll(async () => {
    for (const id of asked) {
      await overSocket(port, `/api/mux/asks/${id}/close`, { pane }).catch(() => undefined)
    }
    try {
      if (windowId) tmux('kill-window', '-t', windowId)
    } catch {
      // Already gone
    }
    for (const dir of [claudeDir, cwd]) {
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test('a choice reaches the orchestrator and the question goes', async ({ page }) => {
    test.setTimeout(60_000)
    const id = await ask(`Which parser? ${tag}`, ['Alpha', 'Beta'])
    await openPlan(page)
    const card = waiting(page).getByRole('article', { name: id })
    await expect(card).toContainText(`Which parser? ${tag}`)
    await card.getByRole('button', { name: 'Beta' }).click()
    await expect(card).toHaveCount(0)
    await expect.poll(() => transcriptText(claudeDir), { timeout: 15_000 }).toContain(`Answer to ${id} (choice 2): Beta`)
  })

  test('an answer in words reaches the orchestrator', async ({ page }) => {
    test.setTimeout(60_000)
    const id = await ask(`Name the module ${tag}`)
    await openPlan(page)
    const card = waiting(page).getByRole('article', { name: id })
    await card.getByRole('textbox', { name: `Your answer to ${id}` }).fill('parse-v2')
    await card.getByRole('button', { name: `Send the answer to ${id}` }).click()
    await expect(card).toHaveCount(0)
    await expect.poll(() => transcriptText(claudeDir), { timeout: 15_000 }).toContain(`Answer to ${id}: parse-v2`)
  })

  test('a draft in the orchestrator box is never replaced', async ({ page }) => {
    test.setTimeout(60_000)
    const id = await ask(`Keep the old API? ${tag}`)
    tmux('set-buffer', '-b', 'e2e-asks', 'half typed')
    tmux('paste-buffer', '-p', '-d', '-b', 'e2e-asks', '-t', pane)
    await openPlan(page)
    const card = waiting(page).getByRole('article', { name: id })
    await card.getByRole('textbox', { name: `Your answer to ${id}` }).fill('yes')
    await card.getByRole('button', { name: `Send the answer to ${id}` }).click()
    await expect(card.getByRole('alert')).toHaveText("The terminal's input box already holds text; send or clear it there")
    await expect(card).toBeVisible()
    expect(transcriptText(claudeDir)).not.toContain(`Answer to ${id}`)
    // Ctrl+C clears the stand-in's box
    tmux('send-keys', '-t', pane, 'C-c')
  })

  test('a dismissal asks first, then takes the question off without typing', async ({ page }) => {
    test.setTimeout(60_000)
    const id = await ask(`Rename the package? ${tag}`, ['Yes', 'No'])
    await openPlan(page)
    const card = waiting(page).getByRole('article', { name: id })
    await expect(card).toContainText(`Rename the package? ${tag}`)
    // Cancelled: the question stays, its answer offered again
    await card.getByRole('button', { name: `Dismiss ${id}` }).click()
    const confirm = card.getByRole('group', { name: `Dismiss ${id}` })
    await expect(confirm).toContainText(`Dismiss ${id}? The orchestrator is told you chose not to answer it.`)
    await expect(card.getByRole('button', { name: 'Yes' })).toBeDisabled()
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(confirm).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Yes' })).toBeEnabled()
    // Confirmed: the card goes and a note says so
    await card.getByRole('button', { name: `Dismiss ${id}` }).click()
    await confirm.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await expect(card).toHaveCount(0)
    await expect(waiting(page).getByRole('status')).toHaveText(`${id} dismissed`)
    // The server keeps it dismissed, for wait --mine to report
    const list = await overSocket(port, '/api/mux/asks')
    expect(list.body.asks?.find((q) => q.id === id)).toMatchObject({ state: 'dismissed', answeredBy: 'pwa' })
    // Nothing reached the orchestrator's input box
    expect(transcriptText(claudeDir)).not.toContain(`Answer to ${id}`)
    expect(tmux('capture-pane', '-p', '-t', pane)).not.toContain(id)
  })

  test('text that looks like markup shows as it is', async ({ page }) => {
    const id = await ask(`<b>bold?</b> <img src=x onerror=alert(1)> ${tag}`)
    await openPlan(page)
    const card = waiting(page).getByRole('article', { name: id })
    await expect(card).toContainText('<b>bold?</b> <img src=x onerror=alert(1)>')
    await expect(card.locator('b, img')).toHaveCount(0)
  })

  test('a view-only device sees how many wait, never what', async ({ page }) => {
    await page.route('**/api/mux/snapshot*', async (route) => {
      const res = await route.fetch()
      const snap = await res.json()
      await route.fulfill({ response: res, json: { ...snap, caps: { ...snap.caps, role: 'view' } } })
    })
    // What the server answers a view-only device
    await page.route(/\/api\/mux\/asks(?:[/?]|$)/, (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ asks: [{ id: 'Q900', state: 'open', created: new Date().toISOString() }], readOnly: true }),
      }),
    )
    await openPlan(page)
    const region = waiting(page)
    await expect(region).toContainText('1 question waits on a device with full access')
    await expect(region).toContainText('Q900')
    await expect(region.getByRole('button')).toHaveCount(0)
    await expect(region.getByRole('textbox')).toHaveCount(0)
  })
})

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
  watchViolations,
} from './fixtures'
import { makeCode, pairStranger } from './pairing'

// Prompt templates: made in Settings, filled and inserted into the Chat's
// draft (never sent), exported and imported, and shared with a paired
// device that may only read them. Every template made here carries tag, and
// only those are changed or removed. Run it against an isolated server
// (its own HOME and XDG dirs): Export writes every template of the server
// to the browser's download folder.
const tag = `${Date.now()}`
const auth = process.env.TERMOTE_E2E_AUTH === '1'
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'
const fakeClaude = path.resolve(import.meta.dirname, '../../tests/fixtures/fake-claude.sh')

interface Template {
  id: string
  name: string
  text: string
  updated: string
}

const list = async (request: APIRequestContext): Promise<Template[]> => {
  const res = await request.get('/api/mux/templates')
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()).templates
}

// Removes every template this run made
async function cleanUp(request: APIRequestContext) {
  for (const t of await list(request)) {
    if (!t.name.includes(tag)) continue
    const res = await request.delete(`/api/mux/templates/${t.id}?updated=${encodeURIComponent(t.updated)}`, {
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status(), `delete ${t.name}: ${await res.text()}`).toBe(200)
  }
}

async function make(request: APIRequestContext, name: string, text: string) {
  const res = await request.post('/api/mux/templates', { data: { name, text } })
  expect(res.status(), await res.text()).toBe(201)
}

const openTemplatesGroup = async (page: Page) => {
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await page
    .getByRole('navigation', { name: 'Settings groups' })
    .getByRole('button', { name: 'Prompt templates' })
    .click()
  return page.getByRole('list', { name: 'Prompt templates' })
}

test.describe('prompt templates', () => {
  test.skip(auth, 'runs on the server without sign-in; the paired devices below run with it')
  test.skip(!socket || process.platform !== 'linux', 'needs TMUX_SOCKET of the server under test (Linux)')
  test.describe.configure({ mode: 'serial' })

  let windowName = ''
  let windowId = ''
  let claudeDir = ''
  let cwd = ''
  const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })

  test.beforeAll(async ({ request }) => {
    // The server makes its tmux session on the first snapshot
    expect((await request.get('/api/mux/snapshot')).ok()).toBe(true)
    await cleanUp(request)
    windowName = `fake-claude-tpl-${tag}`
    claudeDir = mkdtempSync(path.join(tmpdir(), 'termote-e2e-claude-'))
    // A repository on a branch of its own, for {{branch}}
    cwd = mkdtempSync(path.join(tmpdir(), 'termote-e2e-tpl-'))
    execFileSync('git', ['init', '-q', '-b', 'e2e-branch', cwd])
    windowId = tmux(
      'new-window', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', windowName, '-c', cwd,
      'env', `CLAUDE_CONFIG_DIR=${claudeDir}`, 'bash', fakeClaude,
    ).trim()
  })

  test.afterAll(async ({ request }) => {
    await cleanUp(request)
    try {
      if (windowId) tmux('kill-window', '-t', windowId)
    } catch {
      // Already gone
    }
    for (const dir of [claudeDir, cwd]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  test('are made, renamed and deleted in Settings', async ({ page }) => {
    await page.goto('/')
    const rows = await openTemplatesGroup(page)
    await page.getByRole('button', { name: 'New template' }).click()
    const editor = page.getByRole('dialog', { name: 'New prompt template' })
    await editor.getByLabel('Name', { exact: true }).fill(`Review-${tag}`)
    await editor.getByLabel('Text', { exact: true }).fill('Review {{file}} on {{branch}}: {{input}}')
    await editor.getByRole('button', { name: 'Save' }).click()
    await expect(editor).toBeHidden()
    await expect(rows).toContainText(`Review-${tag}`)

    await page.getByRole('button', { name: `Edit Review-${tag}` }).click()
    const edit = page.getByRole('dialog', { name: `Edit Review-${tag}` })
    await edit.getByLabel('Name', { exact: true }).fill(`Renamed-${tag}`)
    await edit.getByRole('button', { name: 'Save' }).click()
    await expect(rows).toContainText(`Renamed-${tag}`)
    await expect(rows).not.toContainText(`Review-${tag}`)

    await page.getByRole('button', { name: `Delete Renamed-${tag}` }).click()
    await page.getByRole('dialog', { name: `Delete Renamed-${tag}?` }).getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByText(`Deleted Renamed-${tag}`)).toBeVisible()
    expect((await list(page.request)).some((t) => t.name.includes(`Renamed-${tag}`))).toBe(false)
  })

  test('are filled in and put in the Chat draft, never sent', async ({ page, request }) => {
    test.setTimeout(60000)
    await make(request, `E2E zebra ${tag}`, 'Check {{branch}}: {{input}}')
    const sent: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/agent/message')) sent.push(r.url())
    })
    await page.goto('/')
    await page.getByRole('tab', { name: new RegExp(windowName) }).click()
    await page.getByRole('tablist', { name: 'View' }).getByRole('tab', { name: 'Chat' }).click({ timeout: 15000 })
    const composer = page.getByRole('textbox', { name: 'Message to Claude Code' })

    // The Templates button, its picker, then the fill dialog
    await page.getByRole('button', { name: 'Templates', exact: true }).click()
    await page.getByRole('combobox', { name: 'Search templates' }).fill('zebra')
    await page.getByRole('option', { name: new RegExp(`E2E zebra ${tag}`) }).click()
    const fill = page.getByRole('dialog', { name: `Insert E2E zebra ${tag}` })
    await expect(fill.getByLabel(/Branch/)).toHaveValue('e2e-branch', { timeout: 15000 })
    await expect(fill.getByLabel(/Your text/)).toBeFocused()
    await fill.getByLabel(/Your text/).fill('be brief')
    await expect(fill.getByTestId('template-preview')).toHaveText('Check e2e-branch: be brief')
    await page.keyboard.press('Control+Enter')
    await expect(fill).toBeHidden()
    await expect(composer).toHaveValue('Check e2e-branch: be brief')
    // The box takes the focus once the dialog is gone
    await expect(composer).toBeFocused()

    // From the / list: an arrow goes to it, Enter fills it in
    await composer.fill('/zeb')
    await expect(page.getByRole('group', { name: 'Templates' })).toContainText(`E2E zebra ${tag}`)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    const again = page.getByRole('dialog', { name: `Insert E2E zebra ${tag}` })
    // The branch is read again: Insert before it lands would leave it empty
    await expect(again.getByLabel(/Branch/)).toHaveValue('e2e-branch', { timeout: 15000 })
    await again.getByLabel(/Your text/).fill('second')
    await again.getByRole('button', { name: 'Insert' }).click()
    await expect(composer).toHaveValue('Check e2e-branch: second')
    await expect(composer).toBeFocused()
    expect(sent).toEqual([])
  })

  test('are exported, and imported back with every name listed', async ({ page, request }) => {
    await make(request, `Export-${tag}`, 'exported {{input}}')
    await page.goto('/')
    await openTemplatesGroup(page)
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export' }).click()
    const file = await (await download).path()
    const exported = JSON.parse(readFileSync(file, 'utf-8')) as { v: number; templates: { name: string; text: string }[] }
    expect(exported.v).toBe(1)
    // Only this run's, one of them under a new name
    const mine = exported.templates.filter((t) => t.name.includes(tag))
    expect(mine.map((t) => t.name).sort()).toEqual([`E2E zebra ${tag}`, `Export-${tag}`])
    const back = mine.map((t) => (t.name === `Export-${tag}` ? { ...t, name: `Imported-${tag}` } : t))
    const dir = mkdtempSync(path.join(tmpdir(), 'termote-e2e-import-'))
    try {
      const json = path.join(dir, 'templates.json')
      writeFileSync(json, JSON.stringify({ v: 1, templates: back }))

      const chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: 'Import…' }).click()
      await (await chooser).setFiles(json)
      const confirm = page.getByRole('dialog', { name: 'Import templates?' })
      await expect(confirm.getByRole('list', { name: 'New', exact: true })).toHaveText(`Imported-${tag}`)
      await expect(confirm.getByRole('list', { name: 'Replaces the existing template' })).toHaveText(
        `E2E zebra ${tag}`,
      )
      await confirm.getByRole('button', { name: 'Import' }).click()
      await expect(page.getByText('Imported: 1 added, 1 replaced')).toBeVisible()
      const names = (await list(request)).map((t) => t.name)
      expect(names).toContain(`Imported-${tag}`)
      expect(names).toContain(`Export-${tag}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// A template made from a paired full device shows on a paired view-only
// one, which cannot change them. The e2e job's server with sign-in.
test.describe('prompt templates on paired devices', () => {
  test.skip(!auth, 'needs TERMOTE_E2E_AUTH=1 and a server with sign-in on (TERMOTE_PASS)')

  const devices: string[] = []
  test.afterAll(async ({ request }) => {
    await cleanUp(request)
    const res = await request.get('/api/mux/devices')
    const { devices: all } = (await res.json()) as { devices: { id: string; name: string }[] }
    for (const d of all.filter((d) => devices.includes(d.name)))
      await request.delete(`/api/mux/devices/${d.id}`, { headers: { 'Content-Type': 'application/json' } })
  })

  test('a full device makes one; a view-only device reads it and changes nothing', async ({
    browser,
    baseURL,
    request,
  }) => {
    test.setTimeout(60000)
    const snap = await (await request.get('/api/mux/snapshot')).json()
    expect(snap.caps.templates, 'the server keeps templates').toBe(true)
    devices.push(`e2e-tpl-full-${tag}`, `e2e-tpl-view-${tag}`)
    const violations: string[][] = []
    const pages: Page[] = []
    // As the fixtures do for page: watch the policy, and no release check
    // (GitHub) from either device
    const watch = async (p: Page) => {
      pages.push(p)
      violations.push(await watchViolations(p))
      await p.addInitScript(() =>
        localStorage.setItem(
          'termote-update-check',
          JSON.stringify({ version: '1.0.0', url: '', checkedAt: Date.now() }),
        ),
      )
    }
    try {
      const full = await pairStranger(browser, baseURL, (await makeCode(request, 'full', devices[0])).code, watch)
      const made = await full.request.post('/api/mux/templates', {
        data: { name: `Shared-${tag}`, text: 'shared {{input}}' },
        headers: { Origin: baseURL as string },
      })
      expect(made.status(), await made.text()).toBe(201)

      const view = await pairStranger(browser, baseURL, (await makeCode(request, 'view', devices[1])).code, watch)
      await view.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 15000 })
      const rows = await openTemplatesGroup(view)
      await expect(rows).toContainText(`Shared-${tag}`)
      await expect(view.getByText(/view only: the templates can be read/)).toBeVisible()
      for (const name of ['New template', 'Import…', `Edit Shared-${tag}`, `Delete Shared-${tag}`])
        await expect(view.getByRole('button', { name })).toHaveCount(0)
      await expect(view.getByRole('button', { name: 'Export' })).toBeEnabled()

      const refused = await view.request.post('/api/mux/templates', {
        data: { name: `Refused-${tag}`, text: 'x' },
        headers: { Origin: baseURL as string },
      })
      expect(refused.status()).toBe(403)
      expect((await refused.json()).code).toBe('view_only')
      expect(violations.flat(), 'Content-Security-Policy violations').toEqual([])
    } finally {
      for (const p of pages) await p.context().close()
    }
  })
})

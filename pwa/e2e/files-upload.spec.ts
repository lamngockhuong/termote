import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type APIRequestContext, expect, type Locator, type Page, test } from './fixtures'
import { makeCode, pairStranger } from './pairing'

// Uploading files from the device into Files: the Upload button, a drop on a
// folder or on an empty root, a paste in the tree, a numbered name when the
// name is taken, the ask before a folder that may hold secrets (with a body
// large enough that a refusal sent early would reach the page as a reset),
// and no Upload button for a view-only device.

const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'
const auth = process.env.TERMOTE_E2E_AUTH === '1'

const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' })

// ~1 MiB of every byte value, NUL included, starting like a PDF
const SAMPLE = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.from(Array.from({ length: 1 << 20 }, (_, i) => i % 256)),
])

// A tmux window in dir, and the link that opens it, with its pane's id
async function openWindow(api: APIRequestContext, dir: string, prefix: string) {
  const name = `${prefix}-${Date.now()}`
  const id = tmux('new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', name, '-c', dir, 'bash').trim()
  type Tab = { id: string; name: string; panes: { id: string }[] }
  let tab: Tab | undefined
  let group: { id: string } | undefined
  await expect(async () => {
    const s = await (await api.get('/api/mux/snapshot')).json()
    group = s.groups.find((g: { tabs: Tab[] }) => g.tabs.some((t) => t.name === name))
    tab = (group as { tabs: Tab[] } | undefined)?.tabs.find((t) => t.name === name)
    expect(tab).toBeDefined()
  }).toPass()
  return {
    windowId: id,
    paneId: (tab as Tab).panes[0].id,
    link: `/#/s/${encodeURIComponent((group as { id: string }).id)}/${encodeURIComponent((tab as Tab).id)}`,
  }
}

// Drops files made in the page on target, as a file manager does. True when
// the page took the drop (its default, the browser opening the file, was
// prevented)
async function dropFiles(target: Locator, files: { name: string; size: number }[]) {
  return target.evaluate((el, list) => {
    const dt = new DataTransfer()
    for (const f of list) dt.items.add(new File([new Uint8Array(f.size).fill(7)], f.name))
    for (const type of ['dragenter', 'dragover'])
      el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
    return !el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, files)
}

// The upload temps left in dir: none once an upload ended
const temps = (dir: string) => readdirSync(dir).filter((n) => n.startsWith('.termote-upload-'))

test.describe('uploading files into Files', () => {
  test.skip(auth, 'runs on the server without sign-in')
  test.skip(!socket || process.platform !== 'linux', 'needs TMUX_SOCKET of the server under test (Linux)')
  test.describe.configure({ mode: 'serial' })

  let api: APIRequestContext
  let repo = ''
  let empty = ''
  const windows: string[] = []
  let link = ''
  let emptyLink = ''
  let paneId = ''

  test.beforeAll(async ({ playwright }, testInfo) => {
    api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    const snap = await (await api.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps.files, 'the backend reports no pane directory')

    repo = mkdtempSync(path.join(tmpdir(), 'termote-e2e-upload-'))
    git(repo, 'init', '-q', '-b', 'main')
    mkdirSync(path.join(repo, 'sub'))
    writeFileSync(path.join(repo, 'sub/keep.txt'), 'keep\n')
    writeFileSync(path.join(repo, 'README.md'), '# Upload\n')
    // A folder that may hold secrets: an upload into it is asked about
    mkdirSync(path.join(repo, '.ssh'))
    writeFileSync(path.join(repo, '.ssh/known_hosts'), '\n')
    empty = mkdtempSync(path.join(tmpdir(), 'termote-e2e-empty-'))

    const w = await openWindow(api, repo, 'upload')
    const e = await openWindow(api, empty, 'upload-empty')
    windows.push(w.windowId, e.windowId)
    link = w.link
    paneId = w.paneId
    emptyLink = e.link
  })

  test.afterAll(async () => {
    for (const id of windows) {
      try {
        tmux('kill-window', '-t', id)
      } catch {
        // Already gone
      }
    }
    for (const dir of [repo, empty]) if (dir) rmSync(dir, { recursive: true, force: true })
    await api?.dispose()
  })

  async function openFiles(page: Page, at = link) {
    await page.setViewportSize({ width: 1400, height: 900 })
    await page.goto(`${at}?view=files`)
    const panel = page.getByRole('complementary', { name: 'Files' })
    await expect(panel.getByRole('button', { name: 'Upload files' })).toBeVisible()
    return panel
  }

  test('the Upload button saves the bytes as they are; a second upload gets a number', async ({ page }) => {
    const panel = await openFiles(page)
    const input = panel.getByTestId('upload-input')
    await input.setInputFiles({ name: 'sample.pdf', mimeType: 'application/pdf', buffer: SAMPLE })
    await expect(panel.getByRole('treeitem', { name: 'sample.pdf' })).toBeVisible()
    await expect(page.getByText('Uploaded sample.pdf')).toBeVisible()
    expect(readFileSync(path.join(repo, 'sample.pdf')).equals(SAMPLE)).toBe(true)

    // What files/download sends back is the same bytes
    const tree = await (await api.get(`/api/mux/panes/${encodeURIComponent(paneId)}/files/tree?path=`)).json()
    const res = await api.get(
      `/api/mux/panes/${encodeURIComponent(paneId)}/files/download?root=${encodeURIComponent(tree.root)}&path=sample.pdf`,
    )
    expect(res.status()).toBe(200)
    expect((await res.body()).equals(SAMPLE)).toBe(true)

    await input.setInputFiles({ name: 'sample.pdf', mimeType: 'application/pdf', buffer: SAMPLE })
    await expect(page.getByText('Saved as sample (2).pdf')).toBeVisible()
    await expect(panel.getByRole('treeitem', { name: 'sample (2).pdf' })).toBeVisible()
    await expect(panel.getByRole('treeitem', { name: 'sample.pdf' })).toBeVisible()
    expect(readFileSync(path.join(repo, 'sample (2).pdf')).equals(SAMPLE)).toBe(true)
    // Nothing left behind but the two files
    expect(temps(repo)).toEqual([])
  })

  test('a drop on a folder puts the file in it', async ({ page }) => {
    const panel = await openFiles(page)
    expect(await dropFiles(panel.getByRole('treeitem', { name: 'sub' }), [{ name: 'dropped.bin', size: 2048 }])).toBe(true)
    await expect(page.getByText('Uploaded dropped.bin')).toBeVisible()
    await expect(panel.getByRole('treeitem', { name: 'dropped.bin' })).toBeVisible()
    expect(readFileSync(path.join(repo, 'sub/dropped.bin')).length).toBe(2048)
  })

  test('a drop on an empty root puts the file there', async ({ page }) => {
    const panel = await openFiles(page, emptyLink)
    await expect(panel.getByText('This directory is empty')).toBeVisible()
    await dropFiles(panel.getByText('This directory is empty'), [{ name: 'first.txt', size: 5 }])
    await expect(panel.getByRole('treeitem', { name: 'first.txt' })).toBeVisible()
    expect(existsSync(path.join(empty, 'first.txt'))).toBe(true)
  })

  test('a paste of files in the tree puts them in the focused folder', async ({ page }) => {
    const panel = await openFiles(page)
    const sub = panel.getByRole('treeitem', { name: 'sub' })
    await sub.click()
    await sub.evaluate((el) => {
      const dt = new DataTransfer()
      dt.items.add(new File(['pasted'], 'pasted.txt', { type: 'text/plain' }))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    await expect(page.getByText('Uploaded pasted.txt')).toBeVisible()
    expect(readFileSync(path.join(repo, 'sub/pasted.txt'), 'utf-8')).toBe('pasted')
  })

  test('a large file into a folder that may hold secrets is asked about, not lost to a reset', async ({ page }) => {
    const panel = await openFiles(page)
    await dropFiles(panel.getByRole('treeitem', { name: '.ssh' }), [{ name: 'big.bin', size: 5 << 20 }])
    const ask = page.getByRole('dialog', { name: 'Upload where secrets may be?' })
    await expect(ask).toBeVisible()
    await expect(ask).toContainText('big.bin goes to .ssh')
    await expect(page.getByText('network error')).toHaveCount(0)
    await ask.getByRole('button', { name: 'Upload' }).click()
    await expect(page.getByText('Uploaded big.bin')).toBeVisible({ timeout: 20000 })
    expect(readFileSync(path.join(repo, '.ssh/big.bin')).length).toBe(5 << 20)
    expect(temps(path.join(repo, '.ssh'))).toEqual([])
  })

  test('a drop on a file being edited uploads it beside the file, never into the text', async ({ page }) => {
    const panel = await openFiles(page)
    await panel.getByRole('treeitem', { name: 'README.md' }).click()
    await panel.getByRole('button', { name: 'Edit', exact: true }).click()
    const box = panel.getByRole('textbox', { name: 'Text of README.md' })
    await expect(box).toContainText('# Upload')
    expect(await dropFiles(box, [{ name: 'notes.txt', size: 4 }])).toBe(true)
    await expect(page.getByText('Saved to notes.txt')).toBeVisible()
    expect(readFileSync(path.join(repo, 'notes.txt')).length).toBe(4)
    // The text is as it was: the file's bytes went up, not into it
    await expect(box).toHaveText('# Upload')
    expect(readFileSync(path.join(repo, 'README.md'), 'utf-8')).toBe('# Upload\n')
  })
})

test.describe('uploading from a view-only device', () => {
  test.skip(!auth, 'needs TERMOTE_E2E_AUTH=1 and a server with sign-in on (TERMOTE_PASS)')
  test.skip(!socket || process.platform !== 'linux', 'needs TMUX_SOCKET of the server under test (Linux)')
  const name = `e2e-upload-view-${Date.now()}`

  let api: APIRequestContext
  let repo = ''
  let windowId = ''
  let link = ''

  test.beforeAll(async ({ playwright }, testInfo) => {
    api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    // A view-only device reads the tracked files of a repository only
    repo = mkdtempSync(path.join(tmpdir(), 'termote-e2e-upload-view-'))
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'e2e@example.com')
    git(repo, 'config', 'user.name', 'e2e')
    writeFileSync(path.join(repo, 'tracked.txt'), 'x\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    const w = await openWindow(api, repo, 'upload-view')
    windowId = w.windowId
    link = w.link
  })

  test.afterAll(async () => {
    // The paired device goes with the test
    const res = await api.get('/api/mux/devices')
    const { devices } = (await res.json()) as { devices: { id: string; name: string }[] }
    for (const d of devices.filter((d) => d.name === name))
      await api.delete(`/api/mux/devices/${d.id}`, { headers: { 'Content-Type': 'application/json' } })
    try {
      if (windowId) tmux('kill-window', '-t', windowId)
    } catch {
      // Already gone
    }
    if (repo) rmSync(repo, { recursive: true, force: true })
    await api?.dispose()
  })

  test('sees no Upload button, and a drop never opens the file', async ({ browser, baseURL, request }) => {
    // A view-only page never selects a window and is shown the session's
    // current one: the link's window, made current before the page reads
    // its first snapshot, or it shows another window when the link opens
    tmux('select-window', '-t', windowId)
    const viewer = await pairStranger(browser, baseURL, (await makeCode(request, 'view', name)).code)
    try {
      await viewer.setViewportSize({ width: 1400, height: 900 })
      await viewer.goto(`${link}?view=files`)
      const panel = viewer.getByRole('complementary', { name: 'Files' })
      const row = panel.getByRole('treeitem', { name: 'tracked.txt' })
      // A newly paired page may reconnect once before the tree is read
      await expect(row).toBeVisible({ timeout: 15000 })
      await expect(panel.getByRole('button', { name: 'Upload files' })).toHaveCount(0)
      // The page takes the drop, so the browser never opens the file
      expect(await dropFiles(row, [{ name: 'nope.txt', size: 3 }])).toBe(true)
      await expect(viewer.getByText('A view-only device cannot upload')).toBeVisible()
      expect(existsSync(path.join(repo, 'nope.txt'))).toBe(false)
    } finally {
      await viewer.context().close()
    }
  })
})

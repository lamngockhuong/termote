import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, type Page, test } from './fixtures'

// Files and Changes against a pane whose directory is a throwaway git repo,
// in a window of the server's tmux. Like the Chat view test it needs the
// socket and session the server under test uses (TMUX_SOCKET, TMUX_SESSION).
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' })

// A 4×3 red PNG, then a 5×3 blue one (another size: git would take a file
// of the same size written in the same second as unchanged), and an SVG. The
// image views read them through files/raw as blob: URLs (an SVG as a data:
// URL, so it never becomes a document of this origin), which the page's CSP
// must allow
const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGO4o6EBRww4OQAa3g4RLYR9sQAAAABJRU5ErkJggg=='
const BLUE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAUAAAADCAIAAADUVFKvAAAAEElEQVR4nGPQ0LiDjBgI8AGbkxGVdkTjRAAAAABJRU5ErkJggg=='
// Only a viewBox, no width or height: it has no size of its own and must
// still fill the view rather than collapse
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 10"><rect width="16" height="10" fill="red"/></svg>\n'

// The width the browser decoded: 0 while loading or when it failed
const decodedWidth = (img: Locator) =>
  img.evaluate((el) => (el as HTMLImageElement).naturalWidth)

// The page has nothing wider than the screen: only code frames scroll sideways
const noPageScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

test.describe('files and changes views', () => {
  test.skip(
    !socket || process.platform !== 'linux',
    'needs TMUX_SOCKET of the server under test (Linux)',
  )
  test.describe.configure({ mode: 'serial' })

  let repo = ''
  let windowId = ''
  let link = ''

  test.beforeAll(async ({ playwright }, testInfo) => {
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    const snap = await (await api.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps.files, 'the backend reports no pane directory')

    repo = mkdtempSync(path.join(tmpdir(), 'termote-e2e-repo-'))
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'e2e@example.com')
    git(repo, 'config', 'user.name', 'e2e')
    mkdirSync(path.join(repo, 'src'))
    writeFileSync(
      path.join(repo, 'src/app.ts'),
      'export function add(a: number, b: number) {\n  return a + b\n}\n',
    )
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')

    const name = `files-${Date.now()}`
    windowId = tmux(
      'new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', name, '-c', repo, 'bash',
    ).trim()
    // A link straight to the window: no tab to click on mobile
    let tab: { id: string } | undefined
    let group: { id: string } | undefined
    await expect(async () => {
      const s = await (await api.get('/api/mux/snapshot')).json()
      group = s.groups.find((g: { tabs: { name: string }[] }) => g.tabs.some((t) => t.name === name))
      tab = group?.tabs.find((t: { name: string }) => t.name === name) as { id: string } | undefined
      expect(tab).toBeDefined()
    }).toPass()
    link = `/#/s/${encodeURIComponent(group!.id)}/${encodeURIComponent(tab!.id)}`
    await api.dispose()
  })

  test.afterAll(() => {
    try {
      if (windowId) tmux('kill-window', '-t', windowId)
    } catch {
      // Already gone
    }
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  test('desktop: Files and Changes open next to the terminal', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=files`)

    const panel = page.getByRole('complementary', { name: 'Files' })
    await expect(panel).toBeVisible()
    await expect(page.locator('#view-panel-terminal')).toBeVisible()
    await expect(
      page.getByRole('group', { name: 'Side panel' }).getByRole('button', { name: 'Files' }),
    ).toHaveAttribute('aria-pressed', 'true')

    await panel.getByRole('treeitem', { name: 'src' }).click()
    await panel.getByRole('treeitem', { name: 'app.ts' }).click()
    const code = panel.getByTestId('code-block')
    await expect(code).toContainText('return a + b')
    // Highlighted by the worker: tokens carry a colour
    await expect(code.locator('span[style*="color"]').first()).toBeVisible({ timeout: 10000 })

    // A change to the file and a new one show in Changes
    writeFileSync(
      path.join(repo, 'src/app.ts'),
      'export function add(a: number, b: number) {\n  return b + a\n}\n',
    )
    writeFileSync(path.join(repo, 'notes.txt'), 'hello\n')
    await page.getByRole('group', { name: 'Side panel' }).getByRole('button', { name: 'Changes' }).click()
    const changes = page.getByRole('complementary', { name: 'Changes' })
    await expect(changes.getByRole('region', { name: 'Untracked' })).toContainText('notes.txt')
    await changes.getByRole('region', { name: 'Changes' }).getByRole('button', { name: /app\.ts/ }).click()
    await expect(changes.locator('[data-kind="add"]')).toContainText('return b + a')
    await expect(changes.locator('[data-kind="del"]')).toContainText('return a + b')
  })

  test('a sensitive file is shown only after saying so', async ({ page }) => {
    writeFileSync(path.join(repo, '.env'), 'TOKEN=e2e-secret\n')
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=files`)
    const panel = page.getByRole('complementary', { name: 'Files' })
    const env = panel.getByRole('treeitem', { name: /^\.env/ })
    await expect(env).toContainText('Sensitive')
    await env.click()
    await expect(page.getByText('This file may contain secrets. Show its contents?')).toBeVisible()
    await expect(panel.getByTestId('code-block')).toHaveCount(0)
    await page.getByRole('button', { name: 'Show', exact: true }).click()
    await expect(panel.getByTestId('code-block')).toContainText('TOKEN=e2e-secret')
  })

  test('mobile: both are views of the view menu and fit the screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 })
    // The first-visit gesture tour would cover the view
    await page.addInitScript(() =>
      localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true })),
    )
    await page.goto(`${link}?view=files`)
    await expect(page.getByRole('button', { name: 'View: Files' })).toBeVisible()
    await page.getByRole('treeitem', { name: 'src' }).click()
    await page.getByRole('treeitem', { name: 'app.ts' }).click()
    await expect(page.getByTestId('code-block')).toContainText('return b + a')
    expect(await noPageScroll(page)).toBe(true)

    await page.getByRole('button', { name: 'View: Files' }).click()
    await page.getByRole('menuitemradio', { name: 'Changes' }).click()
    await page.getByRole('region', { name: 'Changes' }).getByRole('button', { name: /app\.ts/ }).click()
    await expect(page.locator('[data-kind="add"]')).toBeVisible()
    expect(await noPageScroll(page)).toBe(true)
  })

  test('images: Files shows one, Changes shows before and after', async ({ page }) => {
    writeFileSync(path.join(repo, 'logo.png'), Buffer.from(RED_PNG, 'base64'))
    git(repo, 'add', 'logo.png')
    git(repo, 'commit', '-q', '-m', 'logo')
    writeFileSync(path.join(repo, 'logo.png'), Buffer.from(BLUE_PNG, 'base64'))
    // The server keeps a root's git status for 2s (filesRootTTL), and the
    // previous test just read it: the first read must see logo.png
    await page.waitForTimeout(2500)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=files`)

    const panel = page.getByRole('complementary', { name: 'Files' })
    await panel.getByRole('treeitem', { name: 'logo.png' }).click()
    const img = panel.locator('img[src^="blob:"]')
    await expect(img).toHaveCount(1)
    await expect.poll(() => decodedWidth(img)).toBe(5)
    await expect(panel.getByText('5×3 ·')).toBeVisible()

    await page.getByRole('group', { name: 'Side panel' }).getByRole('button', { name: 'Changes' }).click()
    const changes = page.getByRole('complementary', { name: 'Changes' })
    await changes.getByRole('region', { name: 'Changes' }).getByRole('button', { name: /logo\.png/ }).click()
    await expect(changes.getByText('Before · Index')).toBeVisible()
    await expect(changes.getByText('After · Working tree')).toBeVisible()
    const sides = changes.locator('img[src^="blob:"]')
    await expect(sides).toHaveCount(2)
    await expect.poll(() => decodedWidth(sides.first())).toBe(4)
    await expect.poll(() => decodedWidth(sides.last())).toBe(5)
  })

  test('an SVG shows as text until Image is picked', async ({ page }) => {
    writeFileSync(path.join(repo, 'icon.svg'), SVG)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=files`)

    const panel = page.getByRole('complementary', { name: 'Files' })
    await panel.getByRole('treeitem', { name: 'icon.svg' }).click()
    await expect(panel.getByTestId('code-block')).toContainText('<svg')
    await panel.getByRole('button', { name: 'Image', exact: true }).click()
    const img = panel.locator('img[src^="data:image/svg+xml;base64,"]')
    await expect(img).toHaveCount(1)
    await expect(panel.locator('img[src^="blob:"]')).toHaveCount(0)
    await expect.poll(() => decodedWidth(img)).toBeGreaterThan(0)
    await expect.poll(async () => (await img.boundingBox())?.width ?? 0).toBeGreaterThan(100)
  })

  test('edits a CRLF Markdown file, keeping every other byte', async ({ page }) => {
    mkdirSync(path.join(repo, 'docs'), { recursive: true })
    const rec = path.join(repo, 'docs/rec.md')
    writeFileSync(rec, '---\r\nstatus: review\r\n---\r\n# Record\r\n\r\nBody\r\n')
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=files`)
    const panel = page.getByRole('complementary', { name: 'Files' })
    await panel.getByRole('treeitem', { name: 'docs' }).click()
    await panel.getByRole('treeitem', { name: 'rec.md' }).click()
    await panel.getByRole('button', { name: 'Edit', exact: true }).click()
    // The source, not the preview, with "\n" line breaks
    const box = panel.getByRole('textbox', { name: 'Text of docs/rec.md' })
    await expect(box).toHaveValue('---\nstatus: review\n---\n# Record\n\nBody\n')
    await box.fill('---\nstatus: approved\n---\n# Record\n\nBody\n')
    await panel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    await expect(box).toHaveCount(0)
    expect(readFileSync(rec, 'utf-8')).toBe('---\r\nstatus: approved\r\n---\r\n# Record\r\n\r\nBody\r\n')
  })

  test('a save after the host changed the file is a conflict, never an overwrite', async ({ page }) => {
    const f = path.join(repo, 'race.txt')
    writeFileSync(f, 'one\n')
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=files`)
    const panel = page.getByRole('complementary', { name: 'Files' })
    await panel.getByRole('treeitem', { name: 'race.txt' }).click()
    await panel.getByRole('button', { name: 'Edit', exact: true }).click()
    const box = panel.getByRole('textbox', { name: 'Text of race.txt' })
    await box.fill('mine\n')
    writeFileSync(f, 'agent\n')
    await panel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(panel.getByText('The file changed on the host since you opened it')).toBeVisible()
    await expect(box).toHaveValue('mine\n')
    expect(readFileSync(f, 'utf-8')).toBe('agent\n')
    await panel.getByRole('button', { name: 'Reload' }).click()
    await expect(panel.getByTestId('code-block')).toContainText('agent')
  })

  test('no Edit for mixed line breaks or a symlink', async ({ page }) => {
    writeFileSync(path.join(repo, 'mixed.txt'), 'a\r\nb\n')
    symlinkSync('race.txt', path.join(repo, 'alias.txt'))
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=files`)
    const panel = page.getByRole('complementary', { name: 'Files' })
    for (const name of ['mixed.txt', 'alias.txt']) {
      await panel.getByRole('treeitem', { name }).click()
      await expect(panel.getByTestId('code-block')).toBeVisible()
      await expect(panel.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
      await panel.getByRole('button', { name: 'Back to files' }).click()
    }
  })

  test('Changes: an edit updates the diff; one back to the index leaves the list', async ({ page }) => {
    const app = path.join(repo, 'src/app.ts')
    const original = git(repo, 'show', 'HEAD:src/app.ts')
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=changes`)
    const changes = page.getByRole('complementary', { name: 'Changes' })
    const row = changes.getByRole('region', { name: 'Changes' }).getByRole('button', { name: /app\.ts/ })
    await row.click()
    await changes.getByRole('button', { name: 'Edit', exact: true }).click()
    const box = changes.getByRole('textbox', { name: 'Text of src/app.ts' })
    await box.fill(original.replace('a + b', 'a * b'))
    await changes.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(changes.locator('[data-kind="add"]')).toContainText('return a * b', { timeout: 10000 })

    await changes.getByRole('button', { name: 'Edit', exact: true }).click()
    await box.fill(original)
    await changes.getByRole('button', { name: 'Save', exact: true }).click()
    // git status is cached 2s on the server and polled every 5s here
    await expect(page.getByText('No changes left in app.ts')).toBeVisible({ timeout: 15000 })
    // Back on the list, where app.ts is no longer changed
    await expect(changes.getByRole('button', { name: /app\.ts/ })).toHaveCount(0)
    await expect(changes.getByRole('region', { name: 'Untracked' })).toBeVisible()
    expect(readFileSync(app, 'utf-8')).toBe(original)
  })

  test('mobile: Edit and the text box fit the screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 })
    await page.addInitScript(() =>
      localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true })),
    )
    const f = path.join(repo, 'phone.txt')
    writeFileSync(f, 'from the desk\n')
    await page.goto(`${link}?view=files`)
    await page.getByRole('treeitem', { name: 'phone.txt' }).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    const box = page.getByRole('textbox', { name: 'Text of phone.txt' })
    await expect(box).toBeVisible()
    expect(await noPageScroll(page)).toBe(true)
    await box.fill('from the phone\n')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    expect(readFileSync(f, 'utf-8')).toBe('from the phone\n')
  })

  test('creates a file, its directories too, and opens it to edit', async ({ page }) => {
    const made = path.join(repo, 'e2e-new')
    try {
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto(`${link}?view=files`)
      const panel = page.getByRole('complementary', { name: 'Files' })
      const dialog = page.getByRole('dialog', { name: 'New file' })
      const create = async (p: string) => {
        await panel.getByRole('button', { name: 'New file' }).click()
        await dialog.getByRole('textbox').fill(p)
        await dialog.getByRole('button', { name: 'Create' }).click()
      }

      await create('e2e-new/dir/note.md')
      const box = panel.getByRole('textbox', { name: 'Text of e2e-new/dir/note.md' })
      await expect(box).toHaveValue('')
      expect(readFileSync(path.join(made, 'dir/note.md'), 'utf-8')).toBe('')
      await box.fill('# Note\n')
      await panel.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByText('Saved', { exact: true })).toBeVisible()
      expect(readFileSync(path.join(made, 'dir/note.md'), 'utf-8')).toBe('# Note\n')
      // Back: the tree is open down to it
      await panel.getByRole('button', { name: 'Back to files' }).click()
      await expect(panel.getByRole('treeitem', { name: 'note.md' })).toBeVisible()

      // The same name again: refused, with the way to open it
      await create('e2e-new/dir/note.md')
      await expect(dialog.getByRole('alert')).toContainText('already exists')
      await dialog.getByRole('button', { name: 'Open it' }).click()
      await expect(box).toHaveValue('# Note\n')
      expect(readFileSync(path.join(made, 'dir/note.md'), 'utf-8')).toBe('# Note\n')
      await panel.getByRole('button', { name: 'Cancel editing' }).click()
      await panel.getByRole('button', { name: 'Back to files' }).click()

      // A name that usually holds secrets: asked once, then no Show
      await create('e2e-new/.env.local')
      const ask = page.getByRole('dialog', { name: 'Create this file?' })
      await ask.getByRole('button', { name: 'Create' }).click()
      await expect(panel.getByRole('textbox', { name: 'Text of e2e-new/.env.local' })).toBeVisible()
      await expect(page.getByText('This file may contain secrets. Show its contents?')).toHaveCount(0)
      expect(existsSync(path.join(made, '.env.local'))).toBe(true)
    } finally {
      // The Changes tests must never see it as untracked
      rmSync(made, { recursive: true, force: true })
    }
  })

  // CSV files go under csv/ and are removed by the test that wrote them: the
  // Changes tests must never see them as untracked
  const csvDir = () => path.join(repo, 'csv')
  const openCsv = async (page: Page, name: string, width = 1280) => {
    await page.setViewportSize({ width, height: 800 })
    await page.addInitScript(() =>
      localStorage.setItem(
        'termote-settings',
        JSON.stringify({ hasSeenGestureHints: true, tablePreview: true }),
      ),
    )
    // The app follows the window tmux has active: the test's window was
    // made with -d, and a test longer than a snapshot poll would lose it
    tmux('select-window', '-t', windowId)
    await page.goto(`${link}?view=files`)
    await page.getByRole('treeitem', { name: 'csv' }).click()
    await page.getByRole('treeitem', { name }).click()
  }

  test('a CSV opens as a table; filtering and Source change nothing on disk', async ({ page }) => {
    const f = path.join(csvDir(), 'people.csv')
    const text = '\uFEFFname,note\nAn,"a, b"\nBình,"two\nlines"\nCuong,x\n'
    try {
      mkdirSync(csvDir(), { recursive: true })
      writeFileSync(f, text)
      await openCsv(page, 'people.csv')
      const panel = page.getByRole('complementary', { name: 'Files' })
      const grid = panel.getByRole('grid')
      await expect(grid).toHaveAttribute('aria-busy', 'false')
      // The BOM never shows in the first header
      await expect(grid.getByRole('columnheader', { name: 'name', exact: true })).toBeVisible()
      await expect(grid.getByRole('gridcell', { name: 'a, b' })).toBeVisible()
      // A quoted line break stays in its cell
      await expect(grid.getByRole('gridcell', { name: 'two↵lines' })).toBeVisible()
      await expect(panel.getByText('3 / 3 rows')).toBeVisible()

      await panel.getByRole('searchbox', { name: 'Filter rows' }).fill('cuong')
      await expect(panel.getByText('1 / 3 rows')).toBeVisible()
      await expect(grid.getByRole('row')).toHaveCount(2)
      await grid.getByRole('button', { name: 'note' }).click()
      expect(readFileSync(f, 'utf-8')).toBe(text)

      // Source is remembered: the file opens as source again
      await panel.getByRole('button', { name: 'Preview' }).click()
      await expect(panel.getByTestId('code-block')).toContainText('Cuong,x')
      await panel.getByRole('button', { name: 'Back to files' }).click()
      await panel.getByRole('treeitem', { name: 'people.csv' }).click()
      await expect(panel.getByTestId('code-block')).toBeVisible()
      await panel.getByRole('button', { name: 'Preview' }).click()
      await expect(panel.getByRole('grid')).toBeVisible()
      expect(readFileSync(f, 'utf-8')).toBe(text)
    } finally {
      rmSync(csvDir(), { recursive: true, force: true })
    }
  })

  test('mobile: a CSV shows one record at a time and fits the screen', async ({ page }) => {
    try {
      mkdirSync(csvDir(), { recursive: true })
      writeFileSync(
        path.join(csvDir(), 'wide.csv'),
        `${Array.from({ length: 12 }, (_, i) => `column ${i}`).join(',')}\n${Array.from({ length: 12 }, (_, i) => `value ${i}`).join(',')}\nsecond,row\n`,
      )
      await openCsv(page, 'wide.csv', 375)
      await expect(page.getByRole('grid')).toBeVisible()
      expect(await noPageScroll(page)).toBe(true)
      await page.getByRole('button', { name: 'Records' }).click()
      await expect(page.getByText('Record 1 / 2 · row 2')).toBeVisible()
      await expect(page.getByRole('term').first()).toHaveText('column 0')
      await page.getByRole('button', { name: 'Next record' }).click()
      await expect(page.getByText('Record 2 / 2 · row 3')).toBeVisible()
      await page.getByRole('button', { name: 'Previous record' }).click()
      await page.getByRole('button', { name: 'value 11' }).click()
      await expect(page.getByRole('dialog', { name: /Row 2 · column 11/ })).toBeVisible()
      expect(await noPageScroll(page)).toBe(true)
      // Editing: a tapped value opens its own sheet, which fits too
      await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
      await page.getByRole('button', { name: 'Edit' }).click()
      await page.getByRole('button', { name: 'value 3', exact: true }).click()
      const sheet = page.getByRole('dialog', { name: /Row 2 · column 3/ })
      await sheet.getByRole('textbox', { name: 'Value' }).fill('three')
      await sheet.getByRole('button', { name: 'Apply' }).click()
      await expect(page.getByRole('button', { name: 'three', exact: true })).toBeVisible()
      expect(await noPageScroll(page)).toBe(true)
    } finally {
      rmSync(csvDir(), { recursive: true, force: true })
    }
  })

  // Edits a cell of the table open in the Files panel
  const setCell = async (page: Page, shown: string, value: string) => {
    const panel = page.getByRole('complementary', { name: 'Files' })
    await panel.getByRole('grid').getByRole('gridcell', { name: shown, exact: true }).click()
    const sheet = page.getByRole('dialog')
    await sheet.getByRole('textbox', { name: 'Value' }).fill(value)
    await sheet.getByRole('button', { name: 'Apply' }).click()
    await expect(sheet).toHaveCount(0)
  }

  test('editing a cell saves only its bytes, keeping CRLF and the BOM', async ({ page }) => {
    const f = path.join(csvDir(), 'semi.csv')
    const text = '\uFEFFname;price\r\npear;2\r\nplum;"3"\r\n'
    try {
      mkdirSync(csvDir(), { recursive: true })
      writeFileSync(f, text)
      const before = readFileSync(f)
      await openCsv(page, 'semi.csv')
      const panel = page.getByRole('complementary', { name: 'Files' })
      await expect(panel.getByRole('grid')).toHaveAttribute('aria-busy', 'false')
      await panel.getByRole('button', { name: 'Edit' }).click()
      await setCell(page, '2', '2;5')
      // A quoted cell stays quoted
      await setCell(page, '3', '4')
      await panel.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByText('Saved', { exact: true })).toBeVisible()
      const after = readFileSync(f)
      const prefix = Buffer.from('\uFEFFname;price\r\npear;')
      expect(after.subarray(0, prefix.length)).toEqual(before.subarray(0, prefix.length))
      expect(after.toString('utf-8')).toBe('\uFEFFname;price\r\npear;"2;5"\r\nplum;"4"\r\n')
    } finally {
      rmSync(csvDir(), { recursive: true, force: true })
    }
  })

  test('a file changed meanwhile: each edit goes back on its own row', async ({ page }) => {
    const f = path.join(csvDir(), 'agent.csv')
    try {
      mkdirSync(csvDir(), { recursive: true })
      writeFileSync(f, 'name,price\npear,2\nplum,3\nfig,4\n')
      await openCsv(page, 'agent.csv')
      const panel = page.getByRole('complementary', { name: 'Files' })
      await expect(panel.getByRole('grid')).toHaveAttribute('aria-busy', 'false')
      await panel.getByRole('button', { name: 'Edit' }).click()
      await setCell(page, '2', '9')
      await setCell(page, '4', '8')
      // The agent puts a row above pear, with pear's price at pear's old
      // index, and deletes fig
      writeFileSync(f, 'name,price\nkiwi,2\npear,2\nplum,3\n')
      await panel.getByRole('button', { name: 'Save' }).click()
      await expect(panel.getByText('The file changed on the host since you opened it')).toBeVisible()
      // Nothing was written over the agent's file
      expect(readFileSync(f, 'utf-8')).toBe('name,price\nkiwi,2\npear,2\nplum,3\n')
      await panel.getByRole('button', { name: 'Reload and reapply' }).click()
      await expect(panel.getByText(/Not applied to the new file/)).toContainText(
        'Row 4, column price: its row is no longer in the file',
      )
      await panel.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByText('Saved', { exact: true })).toBeVisible()
      expect(readFileSync(f, 'utf-8')).toBe('name,price\nkiwi,2\npear,9\nplum,3\n')
    } finally {
      rmSync(csvDir(), { recursive: true, force: true })
    }
  })

  test.describe('table columns, wraps and row numbers', () => {
    // A long note in row 1, a three-line one in row 2, then short rows
    const notes = (rows: number) =>
      `id,note\n1,${'long note '.repeat(8).trim()}\n2,"one\ntwo\nthree\nfour"\n${Array.from(
        { length: rows },
        (_, i) => `${i + 3},n${i}`,
      ).join('\n')}\n`
    const widthOf = (header: Locator) => header.evaluate((el) => el.getBoundingClientRect().width)

    test('a drag widens one column and never sorts; keys step and fit it', async ({ page }) => {
      try {
        mkdirSync(csvDir(), { recursive: true })
        writeFileSync(path.join(csvDir(), 'notes.csv'), notes(5))
        await openCsv(page, 'notes.csv')
        const panel = page.getByRole('complementary', { name: 'Files' })
        const grid = panel.getByRole('grid')
        await expect(grid).toHaveAttribute('aria-busy', 'false')
        const id = grid.getByRole('columnheader', { name: 'id', exact: true })
        const note = grid.getByRole('columnheader', { name: 'note', exact: true })
        const idWidth = await widthOf(id)
        const noteWidth = await widthOf(note)
        const handle = grid.getByRole('separator', { name: 'Resize column note' })
        const box = (await handle.boundingBox()) as { x: number; y: number; width: number; height: number }
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.down()
        await page.mouse.move(box.x + 100, box.y + box.height / 2, { steps: 5 })
        await page.mouse.move(box.x + 200, box.y + box.height / 2, { steps: 5 })
        await page.mouse.up()
        await expect.poll(() => widthOf(note)).toBeGreaterThan(noteWidth + 150)
        expect(await widthOf(id)).toBe(idWidth)
        // The release over the header was no click on its sort button
        for (const h of [id, note]) await expect(h).toHaveAttribute('aria-sort', 'none')

        // Keys: a step of 2ch, then Enter fits the values (at most 120ch)
        await handle.focus()
        const now = Number(await handle.getAttribute('aria-valuenow'))
        for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
        await expect(handle).toHaveAttribute('aria-valuenow', String(Math.min(120, now + 6)))
        await page.keyboard.press('Enter')
        await expect(handle).toHaveAttribute('aria-valuenow', String('long note '.repeat(8).trim().length))

        // Columns menu: Fit columns, then Reset widths; a drag closes it
        await panel.getByRole('button', { name: 'Columns' }).click()
        await page.getByRole('menuitem', { name: 'Reset widths' }).click()
        await expect(handle).toHaveAttribute('aria-valuenow', '32')
        await panel.getByRole('button', { name: 'Columns' }).click()
        await page.getByRole('menuitem', { name: 'Fit columns' }).click()
        await expect(handle).toHaveAttribute('aria-valuenow', '79')
        await panel.getByRole('button', { name: 'Columns' }).click()
        await expect(page.getByRole('menu')).toBeVisible()
        const idHandle = await grid.getByRole('separator', { name: 'Resize column id' }).boundingBox()
        if (!idHandle) throw new Error('no handle')
        await page.mouse.move(idHandle.x + idHandle.width / 2, idHandle.y + 5)
        await page.mouse.down()
        await page.mouse.move(idHandle.x + 40, idHandle.y + 5, { steps: 3 })
        await page.mouse.up()
        await expect(page.getByRole('menu')).toHaveCount(0)
      } finally {
        rmSync(csvDir(), { recursive: true, force: true })
      }
    })

    test('a wrapped column shows three lines in taller rows, paging still exact', async ({ page }) => {
      try {
        mkdirSync(csvDir(), { recursive: true })
        writeFileSync(path.join(csvDir(), 'wrap.csv'), notes(3000))
        await openCsv(page, 'wrap.csv')
        const panel = page.getByRole('complementary', { name: 'Files' })
        const grid = panel.getByRole('grid')
        await expect(grid).toHaveAttribute('aria-busy', 'false')
        const row = (n: number) => grid.getByRole('row').filter({ has: page.getByRole('rowheader', { name: `Row ${n}`, exact: true }) })
        const height = (n: number) => row(n).evaluate((el) => el.getBoundingClientRect().height)
        expect(await height(2)).toBe(32)
        await panel.getByRole('button', { name: 'Columns' }).click()
        await page.getByRole('menuitemcheckbox', { name: '2 · note' }).click()
        await page.keyboard.press('Escape')
        expect(await height(2)).toBe(61)
        const cell = row(3).getByRole('gridcell').nth(1)
        await expect(cell).toContainText('one↵')
        // Four lines are clipped to the row, never drawn over the next one
        expect(await cell.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(61)
        // Paging to the last row
        await grid.getByRole('gridcell', { name: '1', exact: true }).focus()
        for (let i = 0; i < 400; i++) await page.keyboard.press('PageDown')
        await expect(page.locator(':focus')).toHaveAttribute('data-pos', '3001')
        await expect(grid.getByRole('rowheader', { name: 'Row 3003' })).toBeInViewport()
        // The whole value is in the sheet
        await page.keyboard.press('PageUp')
        await grid.evaluate((el) => {
          el.scrollTop = 0
        })
        await row(3).getByRole('gridcell').nth(1).click()
        await expect(page.getByRole('dialog').locator('pre')).toHaveText('one\ntwo\nthree\nfour')
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await panel.getByRole('button', { name: 'Columns' }).click()
        await page.getByRole('menuitemcheckbox', { name: '2 · note' }).click()
        await page.keyboard.press('Escape')
        expect(await height(2)).toBe(32)
      } finally {
        rmSync(csvDir(), { recursive: true, force: true })
      }
    })

    test('a row number opens its record; back on the grid, it is where it was', async ({ page }) => {
      try {
        mkdirSync(csvDir(), { recursive: true })
        writeFileSync(path.join(csvDir(), 'rec.csv'), notes(400))
        await openCsv(page, 'rec.csv')
        const panel = page.getByRole('complementary', { name: 'Files' })
        const grid = panel.getByRole('grid')
        await expect(grid).toHaveAttribute('aria-busy', 'false')
        await panel.getByRole('button', { name: 'Open row 3 as a record' }).click()
        await expect(panel.getByText('Record 2 / 402 · row 3')).toBeVisible()
        await panel.getByRole('button', { name: 'Records', exact: true }).click()
        await grid.evaluate((el) => {
          el.scrollTop = 32 * 200
        })
        await expect(grid.getByRole('rowheader', { name: 'Row 205' })).toBeVisible()
        const top = await grid.evaluate((el) => el.scrollTop)
        await panel.getByRole('button', { name: 'Open row 205 as a record' }).click()
        await expect(panel.getByText('Record 204 / 402 · row 205')).toBeVisible()
        await panel.getByRole('button', { name: 'Records', exact: true }).click()
        await expect(grid).toBeVisible()
        expect(await grid.evaluate((el) => el.scrollTop)).toBe(top)
      } finally {
        rmSync(csvDir(), { recursive: true, force: true })
      }
    })

    test('a tab shown again keeps its widths, wraps and first row', async ({ page }) => {
      try {
        mkdirSync(csvDir(), { recursive: true })
        writeFileSync(path.join(csvDir(), 'one.csv'), notes(1000))
        writeFileSync(path.join(csvDir(), 'two.csv'), 'a,b\n1,2\n')
        await openCsv(page, 'one.csv')
        const panel = page.getByRole('complementary', { name: 'Files' })
        const bar = panel.getByRole('tablist', { name: 'Open files' })
        const grid = panel.getByRole('grid')
        await expect(grid).toHaveAttribute('aria-busy', 'false')
        await bar.getByRole('tab', { name: /^one\.csv/ }).dblclick()
        const handle = grid.getByRole('separator', { name: 'Resize column note' })
        await handle.focus()
        await page.keyboard.press('End')
        await panel.getByRole('button', { name: 'Columns' }).click()
        await page.getByRole('menuitemcheckbox', { name: '2 · note' }).click()
        await page.keyboard.press('Escape')
        await grid.evaluate((el) => {
          el.scrollTop = 61 * 500
        })
        await expect(grid.getByRole('rowheader', { name: 'Row 502' })).toBeVisible()
        await bar.getByRole('tab', { name: 'Files' }).click()
        await panel.getByRole('treeitem', { name: 'two.csv' }).click()
        await expect(panel.getByRole('grid').getByRole('columnheader', { name: 'a', exact: true })).toBeVisible()
        await bar.getByRole('tab', { name: 'one.csv', exact: true }).click()
        await expect(handle).toHaveAttribute('aria-valuenow', '120')
        const again = panel.getByRole('grid')
        await expect(again.getByRole('rowheader', { name: 'Row 502' })).toBeInViewport()
        expect(await again.evaluate((el) => el.scrollTop)).toBe(61 * 500)
        const first = again.getByRole('row').nth(1)
        expect(await first.evaluate((el) => el.getBoundingClientRect().height)).toBe(61)
      } finally {
        rmSync(csvDir(), { recursive: true, force: true })
      }
    })

    test.describe('on a phone', () => {
      test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

      test('a double tap on a handle fits its column, the page never scrolling', async ({ page }) => {
        try {
          mkdirSync(csvDir(), { recursive: true })
          writeFileSync(path.join(csvDir(), 'tap.csv'), notes(5))
          await openCsv(page, 'tap.csv', 390)
          const grid = page.getByRole('grid')
          await expect(grid).toHaveAttribute('aria-busy', 'false')
          expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
          const handle = grid.getByRole('separator', { name: 'Resize column note' })
          await expect(handle).toHaveAttribute('aria-valuenow', '32')
          const box = (await handle.boundingBox()) as { x: number; y: number; width: number; height: number }
          const x = box.x + box.width / 2
          const y = box.y + box.height / 2
          await page.touchscreen.tap(x, y)
          await page.touchscreen.tap(x, y)
          await expect(handle).toHaveAttribute('aria-valuenow', '79')
          // The column grew under the finger: its click sorts nothing
          await expect(grid.getByRole('columnheader', { name: 'note', exact: true })).toHaveAttribute('aria-sort', 'none')
          expect(await noPageScroll(page)).toBe(true)
          // A tap on a row number opens its record
          await page.getByRole('button', { name: 'Open row 4 as a record' }).tap()
          await expect(page.getByText('Record 3 / 7 · row 4')).toBeVisible()
          expect(await noPageScroll(page)).toBe(true)
        } finally {
          rmSync(csvDir(), { recursive: true, force: true })
        }
      })
    })
  })

  test.describe('open files as tabs', () => {
    const tabsDir = () => path.join(repo, 'e2e-tabs')
    // A file longer than a few screens, to scroll in
    const long = (name: string) =>
      Array.from({ length: 300 }, (_, i) => `${name} line ${i + 1}`).join('\n') + '\n'

    test.beforeEach(() => {
      mkdirSync(tabsDir(), { recursive: true })
      writeFileSync(path.join(tabsDir(), 'alpha.txt'), long('alpha'))
      writeFileSync(path.join(tabsDir(), 'beta.txt'), long('beta'))
      writeFileSync(path.join(tabsDir(), 'notes.md'), '# Notes\n\n[alpha](alpha.txt)\n')
      for (let i = 0; i < 11; i++) writeFileSync(path.join(tabsDir(), `f${i}.txt`), `f${i}\n`)
    })
    test.afterEach(() => rmSync(tabsDir(), { recursive: true, force: true }))

    async function openPanel(page: Page) {
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto(`${link}?view=files`)
      const panel = page.getByRole('complementary', { name: 'Files' })
      await panel.getByRole('treeitem', { name: 'e2e-tabs' }).click()
      const bar = panel.getByRole('tablist', { name: 'Open files' })
      return { panel, bar }
    }

    test('desktop: preview and pinned tabs keep their scroll and drafts', async ({ page }) => {
      const { panel, bar } = await openPanel(page)
      // A single click opens the preview tab; another replaces it
      await panel.getByRole('treeitem', { name: 'beta.txt' }).click()
      await expect(bar.getByRole('tab', { name: 'beta.txt (preview)' })).toBeVisible()
      await bar.getByRole('tab', { name: 'Files' }).click()
      await panel.getByRole('treeitem', { name: 'alpha.txt' }).click()
      await expect(bar.getByRole('tab')).toHaveText(['Files', 'alpha.txt (preview)'])
      // A double click on the tab keeps it
      await bar.getByRole('tab', { name: /^alpha\.txt/ }).dblclick()
      await expect(bar.getByRole('tab', { name: 'alpha.txt', exact: true })).toBeVisible()

      const code = panel.getByTestId('code-block')
      await expect(code).toContainText('alpha line 300')
      await code.evaluate((el) => {
        el.scrollTop = 1500
      })
      // Where it really stopped (a fractional device pixel ratio rounds it)
      const left = await code.evaluate((el) => el.scrollTop)
      expect(left).toBeGreaterThan(1000)
      await bar.getByRole('tab', { name: 'Files' }).click()
      await panel.getByRole('treeitem', { name: 'beta.txt' }).dblclick()
      await expect(bar.getByRole('tab')).toHaveText(['Files', 'alpha.txt', 'beta.txt'])
      await panel.getByRole('button', { name: 'Edit', exact: true }).click()
      const box = panel.getByRole('textbox', { name: 'Text of e2e-tabs/beta.txt' })
      await box.fill('draft of beta\n')
      await expect(bar.getByRole('tab', { name: 'beta.txt (unsaved changes)' })).toBeVisible()

      // Back to alpha.txt: where it was left
      await bar.getByRole('tab', { name: 'alpha.txt', exact: true }).click()
      await expect(code).toContainText('alpha line 1')
      await expect.poll(() => code.evaluate((el, at) => Math.abs(el.scrollTop - at), left)).toBeLessThan(2)
      // And beta.txt's draft is still there
      await bar.getByRole('tab', { name: /^beta\.txt/ }).click()
      await expect(box).toHaveValue('draft of beta\n')

      // Closing it asks first; Cancel keeps it
      await panel.getByLabel('Close beta.txt', { exact: true }).click()
      const ask = page.getByRole('dialog', { name: 'Discard changes?' })
      await ask.getByRole('button', { name: 'Cancel' }).click()
      await expect(box).toHaveValue('draft of beta\n')
      await panel.getByLabel('Close beta.txt', { exact: true }).click()
      await ask.getByRole('button', { name: 'Discard' }).click()
      await expect(bar.getByRole('tab')).toHaveText(['Files', 'alpha.txt'])
      expect(readFileSync(path.join(tabsDir(), 'beta.txt'), 'utf-8')).toBe(long('beta'))
    })

    test('desktop: Ctrl+click opens a link in a new tab', async ({ page }) => {
      const { panel, bar } = await openPanel(page)
      await panel.getByRole('treeitem', { name: 'notes.md' }).click()
      await panel.getByRole('button', { name: 'alpha', exact: true }).click({ modifiers: ['ControlOrMeta'] })
      await expect(panel.getByTestId('code-block')).toContainText('alpha line 1')
      await expect(bar.getByRole('tab')).toHaveText(['Files', 'notes.md (preview)', 'alpha.txt'])
      // A plain click goes on in the same tab, and Back returns
      await bar.getByRole('tab', { name: /^notes\.md/ }).click()
      await panel.getByRole('button', { name: 'alpha', exact: true }).click()
      await expect(bar.getByRole('tab', { name: 'alpha.txt', exact: true })).toHaveAttribute('aria-selected', 'true')
    })

    test('desktop: past 10 tabs the least used clean one closes, never one with changes', async ({ page }) => {
      const { panel, bar } = await openPanel(page)
      await panel.getByRole('treeitem', { name: 'f0.txt' }).dblclick()
      await panel.getByRole('button', { name: 'Edit', exact: true }).click()
      await panel.getByRole('textbox', { name: 'Text of e2e-tabs/f0.txt' }).fill('changed\n')
      for (let i = 1; i <= 10; i++) {
        await bar.getByRole('tab', { name: 'Files' }).click()
        await panel.getByRole('treeitem', { name: `f${i}.txt` }).dblclick()
        await expect(bar.getByRole('tab', { name: `f${i}.txt`, exact: true })).toBeVisible()
      }
      // 11 opened: f1 went, f0 (unsaved) stayed
      await expect(bar.getByRole('tab')).toHaveCount(11)
      await expect(bar.getByRole('tab', { name: /^f1\.txt/ })).toHaveCount(0)
      await expect(bar.getByRole('tab', { name: 'f0.txt (unsaved changes)' })).toBeVisible()
    })

    test('mobile: a sheet of open files instead of a tab bar', async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 800 })
      await page.addInitScript(() =>
        localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true })),
      )
      await page.goto(`${link}?view=files`)
      await page.getByRole('treeitem', { name: 'e2e-tabs' }).click()
      await page.getByRole('treeitem', { name: 'alpha.txt' }).click()
      await expect(page.getByTestId('code-block')).toContainText('alpha line 1')
      await expect(page.getByRole('tablist', { name: 'Open files' })).toHaveCount(0)
      await page.getByRole('button', { name: 'Back to files' }).click()
      await page.getByRole('treeitem', { name: 'beta.txt' }).click()
      await expect(page.getByTestId('code-block')).toContainText('beta line 1')
      // The preview tab was replaced: keep it, then open another
      // On a phone the file's other buttons are in its More actions menu
      await page.getByRole('button', { name: 'More actions' }).click()
      await page.getByRole('menuitem', { name: 'Keep open' }).click()
      await page.getByRole('button', { name: 'Back to files' }).click()
      await page.getByRole('treeitem', { name: 'alpha.txt' }).click()
      await page.getByRole('button', { name: 'Open files (2)' }).click()
      const sheet = page.getByRole('dialog', { name: 'Open files' })
      expect(await noPageScroll(page)).toBe(true)
      await sheet.getByRole('button', { name: /^beta\.txt/ }).click()
      await expect(page.getByTestId('code-block')).toContainText('beta line 1')
      await page.getByRole('button', { name: 'Open files (2)' }).click()
      await sheet.getByRole('button', { name: 'Close beta.txt' }).click()
      await sheet.getByRole('button', { name: 'Files' }).click()
      await expect(page.getByRole('button', { name: 'Open files (1)' })).toBeVisible()
      expect(await noPageScroll(page)).toBe(true)
    })
  })

  test.describe('Changes as tabs', () => {
    const dir = () => path.join(repo, 'e2e-ctabs')
    const lines = (name: string, n = 300) =>
      Array.from({ length: n }, (_, i) => `${name} line ${i + 1}`).join('\n') + '\n'

    // Two committed files changed in the working tree (every line of
    // long.txt, so its diff is several screens long) and one.txt also
    // staged, so it has both sides
    test.beforeEach(() => {
      mkdirSync(dir(), { recursive: true })
      writeFileSync(path.join(dir(), 'long.txt'), lines('old'))
      writeFileSync(path.join(dir(), 'one.txt'), 'one\n')
      git(repo, 'add', 'e2e-ctabs')
      git(repo, 'commit', '-q', '-m', 'tabs')
      writeFileSync(path.join(dir(), 'long.txt'), lines('new'))
      writeFileSync(path.join(dir(), 'one.txt'), 'one staged\n')
      git(repo, 'add', 'e2e-ctabs/one.txt')
      writeFileSync(path.join(dir(), 'one.txt'), 'one staged and more\n')
      // The repo's window already current: the link's select and the first
      // stream (opened for the window current at load) then agree, so no
      // snapshot moves the page to another window while these tests run
      tmux('select-window', '-t', windowId)
    })
    test.afterEach(() => {
      git(repo, 'rm', '-rqf', 'e2e-ctabs')
      git(repo, 'commit', '-q', '-m', 'tabs done')
      rmSync(dir(), { recursive: true, force: true })
    })

    test('desktop: each side its own tab, keeping its editor, draft and scroll', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto(`${link}?view=changes`)
      const changes = page.getByRole('complementary', { name: 'Changes' })
      const bar = changes.getByRole('tablist', { name: 'Open files' })
      const list = (group: string, name: RegExp) =>
        changes.getByRole('region', { name: group }).getByRole('button', { name })

      // A single click opens the preview tab, a double click on it keeps it
      await list('Changes', /long\.txt/).click()
      const diff = changes.getByTestId('diff')
      await expect(diff).toContainText('new line 300')
      await expect(bar.getByRole('tab')).toHaveText(['Changes', 'long.txt (preview)'])
      await bar.getByRole('tab', { name: /^long\.txt/ }).dblclick()
      await diff.evaluate((el) => {
        el.scrollTop = 2000
      })
      const left = await diff.evaluate((el) => el.scrollTop)
      expect(left).toBeGreaterThan(1000)

      // The staged and the unstaged side of one.txt are two tabs
      await bar.getByRole('tab', { name: 'Changes' }).click()
      await list('Staged', /one\.txt/).dblclick()
      await expect(changes.getByText('Staged', { exact: true })).toBeVisible()
      await bar.getByRole('tab', { name: 'Changes' }).click()
      await list('Changes', /one\.txt/).dblclick()
      await expect(bar.getByRole('tab')).toHaveText(['Changes', 'long.txt', 'one.txt (staged)', 'one.txt'])

      // Edit in that tab, leave it, come back: the editor and its draft
      await changes.getByRole('button', { name: 'Edit', exact: true }).click()
      const box = changes.getByRole('textbox', { name: 'Text of e2e-ctabs/one.txt' })
      await box.fill('draft of one\n')
      await expect(bar.getByRole('tab', { name: 'one.txt (unsaved changes)' })).toBeVisible()
      await bar.getByRole('tab', { name: 'long.txt', exact: true }).click()
      await expect.poll(() => diff.evaluate((el, at) => Math.abs(el.scrollTop - at), left)).toBeLessThan(2)
      await bar.getByRole('tab', { name: /^one\.txt \(unsaved/ }).click()
      await expect(box).toHaveValue('draft of one\n')

      // Closing it asks first; nothing is written
      await changes.getByLabel('Close one.txt', { exact: true }).click()
      await page.getByRole('dialog', { name: 'Discard changes?' }).getByRole('button', { name: 'Discard' }).click()
      await expect(bar.getByRole('tab')).toHaveText(['Changes', 'long.txt', 'one.txt (staged)'])
      expect(readFileSync(path.join(dir(), 'one.txt'), 'utf-8')).toBe('one staged and more\n')

      // A side git no longer lists closes its tab
      git(repo, 'add', 'e2e-ctabs/long.txt')
      await expect(page.getByText('No changes left in long.txt')).toBeVisible({ timeout: 15000 })
      await expect(bar.getByRole('tab')).toHaveText(['Changes', 'one.txt (staged)'])
    })

    test('mobile: a sheet of the open diffs instead of a tab bar', async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 800 })
      await page.addInitScript(() =>
        localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true })),
      )
      await page.goto(`${link}?view=changes`)
      const list = (group: string, name: RegExp) =>
        page.getByRole('region', { name: group }).getByRole('button', { name })
      await list('Changes', /long\.txt/).click()
      await expect(page.getByTestId('diff')).toContainText('new line 1')
      await expect(page.getByRole('tablist', { name: 'Open files' })).toHaveCount(0)
      expect(await noPageScroll(page)).toBe(true)

      // Keep it from the sheet, then open another side beside it
      await page.getByRole('button', { name: 'Open files (1)' }).click()
      const sheet = page.getByRole('dialog', { name: 'Open files' })
      await sheet.getByRole('button', { name: 'Keep long.txt open' }).click()
      await sheet.getByRole('button', { name: 'Changes' }).click()
      await list('Staged', /one\.txt/).click()
      await expect(page.getByTestId('diff')).toContainText('one staged')
      await page.getByRole('button', { name: 'Open files (2)' }).click()
      expect(await noPageScroll(page)).toBe(true)
      await sheet.getByRole('button', { name: /^long\.txt/ }).click()
      await expect(page.getByTestId('diff')).toContainText('new line 1')
      await page.getByRole('button', { name: 'Open files (2)' }).click()
      await sheet.getByRole('button', { name: 'Close one.txt (staged)' }).click()
      await sheet.getByRole('button', { name: 'Changes' }).click()
      await expect(page.getByRole('button', { name: 'Open files (1)' })).toBeVisible()
      expect(await noPageScroll(page)).toBe(true)
    })
  })

  test.describe('a 1 MiB CSV', () => {
    test.setTimeout(60000)

    test('is parsed in the worker and scrolls to its last row', async ({ page }) => {
      const rows: string[] = ['id,name,value']
      let size = 0
      for (let i = 1; size < 1000 * 1024; i++) {
        const line = `${i},"name ${i}, x",${i * 3}`
        rows.push(line)
        size += line.length + 1
      }
      const last = rows.length - 1
      try {
        mkdirSync(csvDir(), { recursive: true })
        writeFileSync(path.join(csvDir(), 'big.csv'), `${rows.join('\n')}\n`)
        const worker = page.waitForRequest(/csv-parse-worker/)
        await openCsv(page, 'big.csv')
        // Past 256 KiB the table is read by its worker
        await worker
        const grid = page.getByRole('grid')
        await expect(grid).toHaveAttribute('aria-busy', 'false', { timeout: 20000 })
        await expect(page.getByText(`${last} / ${last} rows`)).toBeVisible()
        await grid.evaluate((el) => {
          el.scrollTop = el.scrollHeight
        })
        await expect(grid.getByRole('rowheader', { name: `Row ${last + 1}` })).toBeVisible()
        // Only the rows in view are in the page
        expect(await grid.getByRole('row').count()).toBeLessThan(80)
      } finally {
        rmSync(csvDir(), { recursive: true, force: true })
      }
    })
  })

  test.describe('Mermaid diagrams', () => {
    const dir = () => path.join(repo, 'e2e-mermaid')
    const fence = (src: string) => `\`\`\`mermaid\n${src}\n\`\`\`\n`
    const FLOW = 'flowchart LR\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]'
    const SEQUENCE = 'sequenceDiagram\n  Alice->>Bob: Hi\n  Bob-->>Alice: Hello'
    const GANTT =
      'gantt\n  dateFormat YYYY-MM-DD\n  section A\n  One :a1, 2026-01-01, 30d\n  Two :after a1, 20d'
    const CLASS = 'classDiagram\n  Animal <|-- Duck\n  Animal : +int age'
    // Paths a hostile diagram tries to load; none may be requested
    const LEAK = '/e2e-mermaid-leak'

    test.beforeEach(() => mkdirSync(dir(), { recursive: true }))
    test.afterEach(() => rmSync(dir(), { recursive: true, force: true }))

    async function open(page: Page, name: string) {
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto(`${link}?view=files`)
      const panel = page.getByRole('complementary', { name: 'Files' })
      await panel.getByRole('treeitem', { name: 'e2e-mermaid' }).click()
      await panel.getByRole('treeitem', { name }).click()
      await expect(panel.getByTestId('markdown-preview')).toBeVisible()
      return panel
    }

    const diagrams = (panel: Locator) => panel.locator('img[src^="data:image/svg+xml"]')
    // The SVG of a diagram's data: URL
    const svgOf = async (img: Locator) => {
      const src = (await img.getAttribute('src')) as string
      return decodeURIComponent(src.slice(src.indexOf(',') + 1))
    }
    // Nodes Mermaid made, anywhere in the document (the Copy icon is an <svg>
    // too, so never count those)
    const mermaidNodes = (page: Page) =>
      page.evaluate(
        () =>
          document.querySelectorAll(
            '[id^="termote-mmd"], [id^="dtermote-mmd"], [id^="itermote-mmd"], svg[aria-roledescription], #cy, .mermaidTooltip',
          ).length +
          Array.from(document.body.children).filter((el) => el.tagName.toLowerCase() === 'svg').length,
      )

    test('renders each kind as an image, leaving nothing of Mermaid in the page', async ({ page }) => {
      writeFileSync(
        path.join(dir(), 'diagram.md'),
        `# Diagrams\n\n${[FLOW, SEQUENCE, GANTT, CLASS].map(fence).join('\n')}`,
      )
      const panel = await open(page, 'diagram.md')
      const imgs = diagrams(panel)
      await expect(imgs).toHaveCount(4, { timeout: 15000 })
      for (let i = 0; i < 4; i++) {
        const img = imgs.nth(i)
        await expect(img).toHaveAttribute('alt', `Mermaid diagram ${i + 1}`)
        // Parsed as XML by the <img>: 0 when it is not valid
        await expect.poll(() => decodedWidth(img)).toBeGreaterThan(0)
        expect(await svgOf(img)).not.toContain('foreignObject')
      }
      // The stage is 1200px wide: a Gantt chart takes its width from it
      expect(await decodedWidth(imgs.nth(2))).toBeGreaterThan(600)
      expect(await mermaidNodes(page)).toBe(0)
    })

    test('a hostile diagram runs nothing, loads nothing and changes no locked setting', async ({ page }) => {
      const dialogs: string[] = []
      page.on('dialog', (d) => {
        dialogs.push(d.message())
        void d.dismiss()
      })
      const requests: string[] = []
      page.on('request', (r) => requests.push(r.url()))
      writeFileSync(
        path.join(dir(), 'evil.md'),
        [
          '# Evil',
          fence(
            [
              'flowchart LR',
              '  A["<img src=x onerror=alert(1)>"] --> B["<script>alert(2)</script>"]',
              '  click A href "javascript:alert(3)"',
              '  click B call alert(4)',
            ].join('\n'),
          ),
          fence(
            `%%{init: {"htmlLabels": true, "securityLevel": "loose", "layout": "elk", "themeCSS": "svg{background:url(${LEAK}/css)}"}}%%\nflowchart LR\n  X --> Y`,
          ),
          fence(
            `---\nconfig:\n  htmlLabels: true\n  themeCSS: "svg{background:url(${LEAK}/front)}"\n---\nflowchart LR\n  P --> Q`,
          ),
          fence(`flowchart LR\n  I@{ img: "${LEAK}/img", h: 60 }`),
          // A no-break space: HTML-serialized as &nbsp;, no entity in XML
          fence('flowchart LR\n  N["no break"] --> M'),
          '## After',
        ].join('\n'),
      )
      const panel = await open(page, 'evil.md')
      const imgs = diagrams(panel)
      await expect(imgs).toHaveCount(4, { timeout: 15000 })
      await expect(panel.getByText('Diagrams with images or icons are not rendered')).toBeVisible()
      await expect(panel.getByRole('heading', { name: 'After' })).toBeVisible()
      for (let i = 0; i < 4; i++) {
        await expect.poll(() => decodedWidth(imgs.nth(i))).toBeGreaterThan(0)
        const svg = await svgOf(imgs.nth(i))
        expect(svg).not.toContain('foreignObject')
        expect(svg).not.toContain(LEAK)
        expect(svg).not.toMatch(/javascript:/i)
        expect(
          await page.evaluate((text) => {
            const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
            return doc.querySelectorAll('script, img, [onerror], [onclick]').length
          }, svg),
        ).toBe(0)
      }
      // A click on a diagram goes nowhere
      const url = page.url()
      await imgs.first().click()
      expect(page.url()).toBe(url)
      expect(dialogs).toEqual([])
      expect(requests.filter((u) => u.includes(LEAK))).toEqual([])
      expect(requests.filter((u) => !u.startsWith(new URL(url).origin))).toEqual([])
      expect(await mermaidNodes(page)).toBe(0)
    })

    // Mermaid draws $$...$$ through KaTeX only for HTML labels, which the
    // locked config turns off: the workspace's KaTeX override never reaches a
    // diagram, and a label with math stays its source text
    test('a label with math renders as its text, without KaTeX', async ({ page }) => {
      const requests: string[] = []
      page.on('request', (r) => requests.push(r.url()))
      writeFileSync(path.join(dir(), 'math.md'), `# Math\n\n${fence('flowchart LR\n  A["$$x^2$$"] --> B')}`)
      const panel = await open(page, 'math.md')
      const img = diagrams(panel)
      await expect(img).toHaveCount(1, { timeout: 15000 })
      await expect.poll(() => decodedWidth(img)).toBeGreaterThan(0)
      const svg = await svgOf(img)
      expect(svg).toContain('>$$x^2$$</tspan>')
      expect(svg).not.toContain('<math')
      expect(svg).not.toContain('foreignObject')
      expect(requests.filter((u) => /katex/i.test(u))).toEqual([])
      expect(await mermaidNodes(page)).toBe(0)
    })

    test('a broken diagram falls back to its source; the rest of the file renders', async ({ page }) => {
      writeFileSync(
        path.join(dir(), 'broken.md'),
        `# Broken\n\n${fence('flowchart LR\n  A -->')}\n## After\n\nText after.\n`,
      )
      const panel = await open(page, 'broken.md')
      await expect(panel.getByText('Not a valid Mermaid diagram')).toBeVisible({ timeout: 15000 })
      await expect(panel.getByTestId('fenced-code')).toContainText('A -->')
      await expect(panel.getByRole('heading', { name: 'After' })).toBeVisible()
      expect(await mermaidNodes(page)).toBe(0)
    })

    test('Mermaid loads only for a file with a diagram', async ({ page }) => {
      // Scripts only: the directory's own name is in the API URLs
      const requests: string[] = []
      page.on('request', (r) => {
        if (new URL(r.url()).pathname.startsWith('/assets/')) requests.push(r.url())
      })
      writeFileSync(path.join(dir(), 'plain.md'), '# Plain\n\n```ts\nconst a = 1\n```\n')
      writeFileSync(path.join(dir(), 'diagram.md'), `# D\n\n${fence(FLOW)}`)
      const panel = await open(page, 'plain.md')
      await expect(panel.getByTestId('fenced-code')).toContainText('const a = 1')
      expect(requests.filter((u) => /mermaid/i.test(u))).toEqual([])

      await page.getByRole('tablist', { name: 'Open files' }).getByRole('tab', { name: 'Files' }).click()
      await panel.getByRole('treeitem', { name: 'diagram.md' }).click()
      await expect(diagrams(panel)).toHaveCount(1, { timeout: 15000 })
      expect(requests.filter((u) => /mermaid/i.test(u)).length).toBeGreaterThan(0)
    })

    test('follows the theme; Show source and Copy work', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      writeFileSync(path.join(dir(), 'theme.md'), `# T\n\n${fence(FLOW)}`)
      const panel = await open(page, 'theme.md')
      const pick = async (name: 'Light' | 'Dark') => {
        // Picking a theme leaves the menu open
        if (!(await page.getByRole('menu', { name: 'More' }).isVisible())) {
          await page.getByRole('button', { name: 'More' }).click()
        }
        await page.getByRole('menuitemradio', { name }).click()
      }
      await pick('Light')
      const img = diagrams(panel)
      await expect(img).toHaveCount(1, { timeout: 15000 })
      // The default theme fills nodes with #ECECFF; the dark one does not
      await expect.poll(async () => (await svgOf(img)).toLowerCase()).toContain('#ececff')
      await pick('Dark')
      await expect.poll(async () => (await svgOf(img)).toLowerCase()).not.toContain('#ececff')
      await page.keyboard.press('Escape')

      const toggle = panel.getByRole('button', { name: 'Show source' })
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-pressed', 'true')
      await expect(img).toHaveCount(0)
      await expect(panel.getByTestId('fenced-code')).toContainText('A[Start] --> B{Ok?}')
      await toggle.click()
      await expect(img).toHaveCount(1)
      await panel.getByRole('button', { name: 'Copy code' }).click()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(FLOW)
    })

    test('a sequence diagram near the size cap renders in time', async ({ page }) => {
      const lines = ['sequenceDiagram']
      for (let i = 0; lines.join('\n').length < 48_000; i++) lines.push(`  P${i % 8}->>P${(i + 1) % 8}: message ${i}`)
      writeFileSync(path.join(dir(), 'big.md'), `# Big\n\n${fence(lines.join('\n'))}`)
      const panel = await open(page, 'big.md')
      // Mermaid runs on the main thread: 8 s for a diagram this large (a
      // flowchart of 400 edges took 3 s, a 5 KB one under 1 s)
      await expect(panel.getByText('Rendering diagram…').or(diagrams(panel))).toBeVisible()
      const started = Date.now()
      await expect(diagrams(panel)).toHaveCount(1, { timeout: 15000 })
      expect(Date.now() - started).toBeLessThan(8000)
    })

    test('a tab shown again has its diagrams at once and keeps its scroll', async ({ page }) => {
      const filler = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n')
      writeFileSync(
        path.join(dir(), 'long.md'),
        `# Long\n\n${fence(FLOW)}\n${filler}\n\n${fence(SEQUENCE)}\n${filler}\n`,
      )
      writeFileSync(path.join(dir(), 'other.txt'), 'other\n')
      const panel = await open(page, 'long.md')
      const bar = page.getByRole('tablist', { name: 'Open files' })
      await bar.getByRole('tab', { name: /^long\.md/ }).dblclick()
      const preview = panel.getByTestId('markdown-preview')
      await expect(diagrams(panel).first()).toBeVisible({ timeout: 15000 })
      await preview.evaluate((el) => {
        el.scrollTop = el.scrollHeight / 2
      })
      await expect(diagrams(panel)).toHaveCount(2, { timeout: 15000 })
      const left = await preview.evaluate((el) => el.scrollTop)

      await bar.getByRole('tab', { name: 'Files' }).click()
      await panel.getByRole('treeitem', { name: 'other.txt' }).click()
      await bar.getByRole('tab', { name: 'long.md', exact: true }).click()
      // From the cache: both images are in the first render
      await expect(diagrams(panel)).toHaveCount(2)
      await expect(panel.getByText('Rendering diagram…')).toHaveCount(0)
      await expect.poll(() => preview.evaluate((el, at) => Math.abs(el.scrollTop - at), left)).toBeLessThan(2)
    })
  })

  test.describe('full-screen viewer', () => {
    const dir = () => path.join(repo, 'e2e-viewer')
    const FLOW = 'flowchart LR\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]'
    test.beforeEach(() => {
      mkdirSync(dir(), { recursive: true })
      const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n')
      writeFileSync(path.join(dir(), 'diagram.md'), `${filler}\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n\n${filler}\n`)
      writeFileSync(path.join(dir(), 'red.png'), Buffer.from(RED_PNG, 'base64'))
    })
    test.afterEach(() => rmSync(dir(), { recursive: true, force: true }))

    async function openFile(page: Page, name: string) {
      await page.goto(`${link}?view=files`)
      const panel = page.getByRole('complementary', { name: 'Files' })
      await panel.getByRole('treeitem', { name: 'e2e-viewer' }).click()
      await panel.getByRole('treeitem', { name }).click()
      return panel
    }

    test('desktop: a diagram opens full screen; keys and buttons zoom; Escape and Back close', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 })
      const panel = await openFile(page, 'diagram.md')
      const preview = panel.getByTestId('markdown-preview')
      const open = panel.getByRole('button', { name: 'Open Mermaid diagram 1 full screen' })
      // Drawn only once it nears the screen
      await panel.getByTestId('mermaid-block').scrollIntoViewIfNeeded()
      await expect(open).toBeVisible({ timeout: 15000 })
      const scrolled = await preview.evaluate((el) => el.scrollTop)
      const url = page.url()

      await open.click()
      const viewer = page.getByRole('dialog', { name: 'Mermaid diagram 1' })
      await expect(viewer).toBeVisible()
      await expect(viewer.getByText('100%')).toBeVisible()
      await page.keyboard.press('+')
      await viewer.getByRole('button', { name: 'Zoom in' }).click()
      await expect(viewer.getByText('156%')).toBeVisible()
      await page.keyboard.press('0')
      await expect(viewer.getByText('100%')).toBeVisible()
      // The wheel zooms too, and scrolls nothing behind
      await viewer.getByTestId('viewer-stage').hover()
      await page.mouse.wheel(0, -300)
      await expect(viewer.getByText('100%')).toBeHidden()

      await page.keyboard.press('Escape')
      await expect(viewer).toBeHidden()
      await expect(open).toBeFocused()
      expect(page.url()).toBe(url)

      await open.click()
      await expect(viewer).toBeVisible()
      await page.goBack()
      await expect(viewer).toBeHidden()
      expect(page.url()).toBe(url)
      await expect(preview).toBeVisible()
      expect(Math.abs((await preview.evaluate((el) => el.scrollTop)) - scrolled)).toBeLessThan(2)
    })

    test('desktop: an image in Files and a side in Changes open full screen', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 })
      const panel = await openFile(page, 'red.png')
      const open = panel.getByRole('button', { name: /^Open e2e-viewer\/red\.png full screen$/ })
      await expect(open).toBeEnabled()
      await open.click()
      const viewer = page.getByRole('dialog', { name: 'e2e-viewer/red.png' })
      await expect(viewer.locator('img[src^="blob:"]')).toBeVisible()
      await viewer.getByRole('button', { name: 'Close' }).click()
      await expect(viewer).toBeHidden()

      // A changed image: each side opens on its own
      git(repo, 'add', 'e2e-viewer/red.png')
      git(repo, 'commit', '-q', '-m', 'red')
      writeFileSync(path.join(dir(), 'red.png'), Buffer.from(BLUE_PNG, 'base64'))
      await page.waitForTimeout(2500)
      await page.getByRole('group', { name: 'Side panel' }).getByRole('button', { name: 'Changes' }).click()
      const changes = page.getByRole('complementary', { name: 'Changes' })
      await changes.getByRole('region', { name: 'Changes' }).getByRole('button', { name: /red\.png/ }).click()
      const after = changes.getByRole('button', { name: /^Open e2e-viewer\/red\.png \(After · Working tree\) full screen$/ })
      await expect(after).toBeEnabled()
      await after.click()
      const side = page.getByRole('dialog', { name: 'e2e-viewer/red.png (After · Working tree)' })
      await expect(side).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(side).toBeHidden()
      git(repo, 'rm', '-q', '--cached', 'e2e-viewer/red.png')
      git(repo, 'commit', '-q', '-m', 'drop red')
    })

    test.describe('phone', () => {
      test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

      test('a tap opens the viewer; a double tap zooms; the stage takes every touch', async ({ page }) => {
        // The first-visit gesture tour would cover the view
        await page.addInitScript(() =>
          localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true })),
        )
        await page.goto(`${link}?view=files`)
        await page.getByRole('treeitem', { name: 'e2e-viewer' }).tap()
        await page.getByRole('treeitem', { name: 'diagram.md' }).tap()
        const open = page.getByRole('button', { name: 'Open Mermaid diagram 1 full screen' })
        await page.getByTestId('mermaid-block').scrollIntoViewIfNeeded()
        await expect(open).toBeVisible({ timeout: 15000 })
        await open.tap()
        const viewer = page.getByRole('dialog', { name: 'Mermaid diagram 1' })
        await expect(viewer).toBeVisible()
        const stage = viewer.getByTestId('viewer-stage')
        expect(await stage.evaluate((el) => getComputedStyle(el).touchAction)).toBe('none')
        const box = (await stage.boundingBox())!
        const x = box.x + box.width / 2
        const y = box.y + box.height / 2
        await page.touchscreen.tap(x, y)
        await page.touchscreen.tap(x, y)
        await expect(viewer.getByText('200%')).toBeVisible()
        expect(await noPageScroll(page)).toBe(true)
        await viewer.getByRole('button', { name: 'Close' }).tap()
        await expect(viewer).toBeHidden()
      })
    })
  })
})

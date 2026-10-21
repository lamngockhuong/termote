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
    // Reload drops the text: asked first
    await panel.getByRole('button', { name: 'Reload' }).click()
    await page.getByRole('dialog', { name: 'Discard changes?' }).getByRole('button', { name: 'Discard' }).click()
    await expect(panel.getByTestId('code-block')).toContainText('agent')
  })

  test.describe('kept on the device', () => {
    // What the PWA keeps on the device for the panes (tabs, drafts, views)
    // The page loaded again on the window: tmux shows every client its
    // session's current window, which another test may have changed
    const reopen = async (page: Page) => {
      tmux('select-window', '-t', windowId)
      await page.reload()
      await page.goto(`${link}?view=files`)
    }
    const kept = (page: Page) =>
      page.evaluate(() =>
        Object.keys(localStorage)
          .filter((k) => /^termote-(files-tabs|changes-tabs|file-drafts|pane-view):/.test(k))
          .map((k) => `${k}=${localStorage.getItem(k)}`)
          .join('\n'),
      )

    test('tabs open again as they were left, after a reload', async ({ page }) => {
      mkdirSync(path.join(repo, 'keep'), { recursive: true })
      writeFileSync(path.join(repo, 'keep/one.ts'), Array.from({ length: 200 }, (_, i) => `// ${i}`).join('\n'))
      writeFileSync(path.join(repo, 'keep/two.ts'), 'export const two = 2\n')
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto(`${link}?view=files`)
      const panel = page.getByRole('complementary', { name: 'Files' })
      await panel.getByRole('treeitem', { name: 'keep' }).click()
      await panel.getByRole('treeitem', { name: 'one.ts' }).click()
      await panel.getByRole('button', { name: 'Keep open' }).click()
      await expect(panel.getByTestId('code-block')).toContainText('// 0')
      await panel.getByRole('tab', { name: 'Files', exact: true }).click()
      await panel.getByRole('treeitem', { name: 'two.ts' }).click()
      await expect(panel.getByTestId('code-block')).toContainText('two = 2')
      // Written within half a second
      await expect.poll(() => kept(page)).toContain('two.ts')

      await reopen(page)
      const again = page.getByRole('complementary', { name: 'Files' })
      const bar = again.getByRole('tablist', { name: 'Open files' })
      await expect(bar.getByRole('tab', { name: /^one\.ts/ })).toBeVisible()
      await expect(bar.getByRole('tab', { name: /^two\.ts/ })).toHaveAttribute('aria-selected', 'true')
      await expect(again.getByTestId('code-block')).toContainText('two = 2')
    })

    test('an unsaved edit comes back when the app opens again, and saves', async ({ browser, page }, testInfo) => {
      const f = path.join(repo, 'keep/notes.md')
      writeFileSync(f, '# Notes\n')
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto(`${link}?view=files`)
      const panel = page.getByRole('complementary', { name: 'Files' })
      await panel.getByRole('treeitem', { name: 'keep' }).click()
      await panel.getByRole('treeitem', { name: 'notes.md' }).click()
      await panel.getByRole('button', { name: 'Edit', exact: true }).click()
      await panel.getByRole('textbox', { name: 'Text of keep/notes.md' }).fill('# Notes\n\nunsaved line\n')
      await expect.poll(() => kept(page)).toContain('unsaved line')
      // The tab is written within half a second (at once when the page hides)
      await expect.poll(() => kept(page)).toMatch(/termote-files-tabs:[^\n]*notes\.md/)
      // The app closed (the OS killed it) and opened again: a new context
      // with the same storage
      const storageState = await page.context().storageState()
      await page.context().close()
      const context = await browser.newContext({
        storageState,
        httpCredentials: testInfo.project.use.httpCredentials,
      })
      try {
        const reopened = await context.newPage()
        await reopened.setViewportSize({ width: 1280, height: 800 })
        await reopened.goto(`${link}?view=files`)
        const p2 = reopened.getByRole('complementary', { name: 'Files' })
        const box = p2.getByRole('textbox', { name: 'Text of keep/notes.md' })
        await expect(box).toHaveValue('# Notes\n\nunsaved line\n')
        await p2.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(reopened.getByText('Saved', { exact: true })).toBeVisible()
        expect(readFileSync(f, 'utf-8')).toBe('# Notes\n\nunsaved line\n')
        // Saved: nothing of it is kept any more
        expect(await kept(reopened)).not.toContain('unsaved line')
      } finally {
        await context.close()
      }
    })

    test('a kept edit of a file changed on the host is a conflict; Reload asks', async ({ page }) => {
      const f = path.join(repo, 'keep/clash.txt')
      writeFileSync(f, 'one\n')
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto(`${link}?view=files`)
      const panel = page.getByRole('complementary', { name: 'Files' })
      await panel.getByRole('treeitem', { name: 'keep' }).click()
      await panel.getByRole('treeitem', { name: 'clash.txt' }).click()
      await panel.getByRole('button', { name: 'Edit', exact: true }).click()
      await panel.getByRole('textbox', { name: 'Text of keep/clash.txt' }).fill('mine\n')
      await expect.poll(() => kept(page)).toContain('mine')
      writeFileSync(f, 'agent\n')
      await reopen(page)
      const again = page.getByRole('complementary', { name: 'Files' })
      await expect(again.getByText('The file changed on the host since you opened it')).toBeVisible()
      await expect(again.getByRole('textbox', { name: 'Text of keep/clash.txt' })).toHaveValue('mine\n')
      expect(readFileSync(f, 'utf-8')).toBe('agent\n')
      await again.getByRole('button', { name: 'Reload' }).click()
      const ask = page.getByRole('dialog', { name: 'Discard changes?' })
      await expect(ask).toBeVisible()
      await ask.getByRole('button', { name: 'Discard' }).click()
      await expect(again.getByTestId('code-block')).toContainText('agent')
    })

    test('a sensitive file shown and edited is never kept on the device', async ({ page }) => {
      writeFileSync(path.join(repo, '.env'), 'TOKEN=e2e-secret\n')
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto(`${link}?view=files`)
      const panel = page.getByRole('complementary', { name: 'Files' })
      await panel.getByRole('treeitem', { name: /^\.env/ }).click()
      await page.getByRole('button', { name: 'Show', exact: true }).click()
      await panel.getByRole('button', { name: 'Edit', exact: true }).click()
      await panel.getByRole('textbox', { name: 'Text of .env' }).fill('TOKEN=typed-e2e\n')
      // Leaving still asks: the text is only in memory
      let asked = false
      page.on('dialog', (d) => {
        asked = d.type() === 'beforeunload'
        return d.accept()
      })
      await page.waitForTimeout(700)
      const before = await kept(page)
      expect(before).not.toContain('typed-e2e')
      expect(before).not.toContain('.env')
      await reopen(page)
      expect(asked).toBe(true)
      const after = await kept(page)
      expect(after).not.toContain('typed-e2e')
      expect(after).not.toContain('.env')
      await expect(
        page.getByRole('complementary', { name: 'Files' }).getByRole('tab', { name: /^\.env/ }),
      ).toHaveCount(0)
    })
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

  test('desktop: renames and moves a file; its tab and draft follow; Undo', async ({ page }) => {
    const dir = path.join(repo, 'e2e-rename')
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'draft.md'), 'one\n')
      writeFileSync(path.join(dir, 'taken.md'), 'taken\n')
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto(`${link}?view=files`)
      const panel = page.getByRole('complementary', { name: 'Files' })
      const dialog = page.getByRole('dialog', { name: 'Rename' })
      const rowMenu = async (name: string) => {
        const row = panel.getByRole('treeitem', { name })
        await row.hover()
        await row.getByRole('button', { name: `Actions for ${name}` }).click()
        await page.getByRole('menuitem', { name: 'Rename' }).click()
      }
      const renameTo = async (p: string) => {
        await dialog.getByRole('textbox').fill(p)
        await dialog.getByRole('button', { name: 'Rename' }).click()
      }
      await panel.getByRole('treeitem', { name: 'e2e-rename' }).click()

      // Unsaved changes, then a move from the tree: Save writes the new path
      await panel.getByRole('treeitem', { name: 'draft.md' }).click()
      await panel.getByRole('button', { name: 'Edit', exact: true }).click()
      await panel.getByRole('textbox', { name: 'Text of e2e-rename/draft.md' }).fill('two\n')
      // The tree, the editor kept in its tab
      await panel.getByRole('tab', { name: 'Files', exact: true }).click()
      await rowMenu('draft.md')
      // The base name is selected without its extension
      await expect(dialog.getByRole('textbox')).toHaveValue('e2e-rename/draft.md')
      await renameTo('e2e-rename/sub/moved.md')
      await expect(page.getByText('Moved moved.md to e2e-rename/sub')).toBeVisible()
      expect(existsSync(path.join(dir, 'draft.md'))).toBe(false)
      expect(readFileSync(path.join(dir, 'sub/moved.md'), 'utf-8')).toBe('one\n')
      await page.getByRole('tab', { name: /moved\.md/ }).click()
      const box = panel.getByRole('textbox', { name: 'Text of e2e-rename/sub/moved.md' })
      await expect(box).toHaveValue('two\n')
      await panel.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByText('Saved', { exact: true })).toBeVisible()
      expect(readFileSync(path.join(dir, 'sub/moved.md'), 'utf-8')).toBe('two\n')
      expect(existsSync(path.join(dir, 'draft.md'))).toBe(false)

      // From the header: a name taken is refused, with the way to open it
      await panel.getByRole('button', { name: 'Rename' }).click()
      await renameTo('e2e-rename/taken.md')
      await expect(dialog.getByRole('alert')).toContainText('already exists')
      expect(readFileSync(path.join(dir, 'taken.md'), 'utf-8')).toBe('taken\n')
      await dialog.getByRole('button', { name: 'Cancel' }).click()

      // A rename in place, then Undo puts the old name back
      await panel.getByRole('button', { name: 'Rename' }).click()
      await renameTo('e2e-rename/sub/final.md')
      const toast = page.getByText('Renamed moved.md to final.md')
      await expect(toast).toBeVisible()
      expect(existsSync(path.join(dir, 'sub/final.md'))).toBe(true)
      await expect(panel.getByRole('textbox', { name: /final\.md/ }).or(panel.getByText('two'))).toBeVisible()
      await page.getByRole('button', { name: 'Undo' }).click()
      await expect(page.getByText('Renamed back to moved.md')).toBeVisible()
      expect(existsSync(path.join(dir, 'sub/final.md'))).toBe(false)
      expect(readFileSync(path.join(dir, 'sub/moved.md'), 'utf-8')).toBe('two\n')
      await expect(page.getByRole('tab', { name: /moved\.md/ })).toBeVisible()
    } finally {
      // The Changes tests must never see it as untracked
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('mobile: a finger resting on a row offers Rename; the box fits the screen', async ({ page }) => {
    const dir = path.join(repo, 'e2e-rename-phone')
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'a.txt'), 'a\n')
      await page.setViewportSize({ width: 375, height: 800 })
      await page.addInitScript(() =>
        localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true })),
      )
      await page.goto(`${link}?view=files`)
      await page.getByRole('treeitem', { name: 'e2e-rename-phone' }).click()
      const row = page.getByRole('treeitem', { name: 'a.txt' })
      const box = await row.boundingBox()
      const at = { pointerType: 'touch', isPrimary: true, clientX: box!.x + 20, clientY: box!.y + 10 }
      await row.dispatchEvent('pointerdown', at)
      await page.waitForTimeout(700)
      await row.dispatchEvent('pointerup', at)
      await page.getByRole('menuitem', { name: 'Rename' }).click()
      const dialog = page.getByRole('dialog', { name: 'Rename' })
      await expect(dialog.getByRole('textbox')).toBeVisible()
      expect(await noPageScroll(page)).toBe(true)
      await dialog.getByRole('textbox').fill('e2e-rename-phone/b.txt')
      await dialog.getByRole('button', { name: 'Rename' }).click()
      await expect(page.getByText('Renamed a.txt to b.txt')).toBeVisible()
      expect(readFileSync(path.join(dir, 'b.txt'), 'utf-8')).toBe('a\n')
      await expect(page.getByRole('treeitem', { name: 'b.txt' })).toBeVisible()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('downloads a file byte for byte, from the tree and the header', async ({ page }) => {
    const dir = path.join(repo, 'e2e-download')
    // Every byte value, under a name a browser would render: it must be saved
    const bytes = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256))
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'page.html'), bytes)
      writeFileSync(path.join(dir, '.env'), 'TOKEN=e2e-download\n')
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto(`${link}?view=files`)
      const panel = page.getByRole('complementary', { name: 'Files' })
      // Nothing navigated to the file: the page is still the app (the app
      // itself drops ?view from the address once it has read it)
      const stillApp = async () => {
        expect(new URL(page.url()).pathname).toBe('/')
        await expect(panel).toBeVisible()
      }
      // Rows inside e2e-download only: the repo's top folder can hold a .env
      // of another test
      const rowMenu = async (name: string | RegExp) => {
        const row = panel.getByRole('treeitem', { name }).and(page.locator('[aria-level="2"]'))
        await row.hover()
        await row.getByRole('button', { name: /^Actions for / }).click()
        await page.getByRole('menuitem', { name: 'Download' }).click()
      }
      const saved = async (start: () => Promise<void>, name: string | RegExp) => {
        const [download] = await Promise.all([page.waitForEvent('download'), start()])
        expect(download.suggestedFilename()).toMatch(name)
        return readFileSync((await download.path()) as string)
      }
      await panel.getByRole('treeitem', { name: 'e2e-download' }).click()

      expect(await saved(() => rowMenu('page.html'), 'page.html')).toEqual(bytes)
      await stillApp()

      // Opened (not previewable), then from the header
      await panel.getByRole('treeitem', { name: 'page.html' }).click()
      await expect(panel.getByText(/Not previewable/)).toBeVisible()
      expect(
        await saved(() => panel.getByRole('button', { name: 'Download' }).click(), 'page.html'),
      ).toEqual(bytes)
      await stillApp()

      // A sensitive name asks first: Cancel starts nothing
      await panel.getByRole('tab', { name: 'Files', exact: true }).click()
      const ask = page.getByRole('dialog', { name: 'Download a file that may contain secrets?' })
      let downloads = 0
      page.on('download', () => downloads++)
      await rowMenu(/^\.env/)
      await ask.getByRole('button', { name: 'Cancel' }).click()
      await page.waitForTimeout(500)
      expect(downloads).toBe(0)
      await rowMenu(/^\.env/)
      expect(
        // Chromium drops a name's leading dot (it would save a hidden file)
        (await saved(() => ask.getByRole('button', { name: 'Download' }).click(), /^\.?env$/)).toString(),
      ).toBe('TOKEN=e2e-download\n')
    } finally {
      // The Changes tests must never see it as untracked
      rmSync(dir, { recursive: true, force: true })
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

  // Edits a cell of the table open in the Files panel, where it is (a
  // mouse is a fine pointer)
  const setCell = async (page: Page, shown: string, value: string) => {
    const grid = page.getByRole('complementary', { name: 'Files' }).getByRole('grid')
    await grid.getByRole('gridcell', { name: shown, exact: true }).dblclick()
    const field = grid.getByRole('textbox', { name: /^Edit / })
    await field.fill(value)
    await field.press('Enter')
    await expect(field).toHaveCount(0)
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

  test('spreadsheet keys: Home and End move, a key typed edits, Delete clears', async ({ page }) => {
    const f = path.join(csvDir(), 'keys.csv')
    try {
      mkdirSync(csvDir(), { recursive: true })
      writeFileSync(f, 'name,price,note\npear,2,ripe\nplum,3,\nfig,4,dry\n')
      await openCsv(page, 'keys.csv')
      const panel = page.getByRole('complementary', { name: 'Files' })
      const grid = panel.getByRole('grid')
      await expect(grid).toHaveAttribute('aria-busy', 'false')
      const cell = (name: string) => grid.getByRole('gridcell', { name, exact: true })
      // A click on the table viewed puts the focus on the cell, nothing more
      await cell('2').click()
      await expect(cell('2')).toBeFocused()
      // Outlined, though focus-visible draws nothing for a click
      await expect(cell('2')).toHaveCSS('outline-style', 'solid')
      await expect(grid.getByRole('textbox')).toHaveCount(0)
      await page.keyboard.press('End')
      await expect(cell('ripe')).toBeFocused()
      await page.keyboard.press('Home')
      await expect(cell('pear')).toBeFocused()
      await page.keyboard.press('Control+End')
      await expect(cell('dry')).toBeFocused()
      await page.keyboard.press('Control+Home')
      await expect(cell('pear')).toBeFocused()
      // A key typed replaces the value; Enter sets it
      await page.keyboard.press('ArrowRight')
      await page.keyboard.type('x')
      await expect(grid.getByRole('textbox', { name: 'Edit price, row 2' })).toHaveValue('x')
      await page.keyboard.press('Enter')
      await expect(cell('x')).toBeFocused()
      // Delete clears a cell, one Ctrl+Z brings it back
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Delete')
      await expect(cell('ripe')).toHaveCount(0)
      await page.keyboard.press('Control+z')
      await expect(cell('ripe')).toBeVisible()
      await page.keyboard.press('Control+End')
      await page.keyboard.press('Backspace')
      await expect(cell('dry')).toHaveCount(0)
      await panel.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByText('Saved', { exact: true })).toBeVisible()
      expect(readFileSync(f, 'utf-8')).toBe('name,price,note\npear,x,ripe\nplum,3,\nfig,4,\n')
    } finally {
      rmSync(csvDir(), { recursive: true, force: true })
    }
  })

  test('columns added, renamed and deleted save only their bytes, undo, and are reapplied', async ({ page }) => {
    const f = path.join(csvDir(), 'cols.csv')
    const text = 'name,price,note\r\npear,2,"ripe, sweet"\r\nplum,3,\r\n'
    try {
      mkdirSync(csvDir(), { recursive: true })
      writeFileSync(f, text)
      await openCsv(page, 'cols.csv')
      const panel = page.getByRole('complementary', { name: 'Files' })
      const grid = panel.getByRole('grid')
      await expect(grid).toHaveAttribute('aria-busy', 'false')
      await panel.getByRole('button', { name: 'Edit' }).click()
      const header = (name: string) => grid.getByRole('columnheader', { name, exact: true })
      const names = () => grid.getByRole('columnheader').evaluateAll((hs) => hs.slice(1).map((h) => h.getAttribute('aria-label')))
      // A column after name, its name typed at once
      await header('name').click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Insert column right' }).click()
      const nameBox = grid.getByRole('textbox', { name: /^Rename column/ })
      await expect(nameBox).toBeFocused()
      await nameBox.fill('Result')
      await nameBox.press('Enter')
      await expect.poll(names).toEqual(['name', 'Result', 'price', 'note'])
      // Fill a cell of it
      await grid.locator('[data-pos="0"][data-col="1"]').dblclick()
      const cellBox = grid.getByRole('textbox', { name: 'Edit Result, row 2' })
      await cellBox.fill('ok')
      await cellBox.press('Enter')
      // Delete price, after being told what goes with it
      await header('price').click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Delete column' }).click()
      await expect(page.getByRole('dialog')).toContainText('2 cells with a value go with it.')
      await page.getByRole('dialog').getByRole('button', { name: 'Delete column' }).click()
      await expect.poll(names).toEqual(['name', 'Result', 'note'])
      // Four steps back, then forward again
      for (let i = 0; i < 4; i++) await page.keyboard.press('Control+z')
      await expect.poll(names).toEqual(['name', 'price', 'note'])
      for (let i = 0; i < 4; i++) await page.keyboard.press('Control+Shift+z')
      await expect.poll(names).toEqual(['name', 'Result', 'note'])
      // The agent adds a row at the top meanwhile
      writeFileSync(f, 'name,price,note\r\nkiwi,1,\r\npear,2,"ripe, sweet"\r\nplum,3,\r\n')
      await panel.getByRole('button', { name: 'Save' }).click()
      await expect(panel.getByText('The file changed on the host since you opened it')).toBeVisible()
      await panel.getByRole('button', { name: 'Reload and reapply' }).click()
      await expect(panel.getByText(/Not applied/)).toHaveCount(0)
      await panel.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByText('Saved', { exact: true })).toBeVisible()
      // One more delimiter where the column went in, the deleted cells gone,
      // quotes and CRLF kept
      expect(readFileSync(f, 'utf-8')).toBe('name,Result,note\r\nkiwi,,\r\npear,ok,"ripe, sweet"\r\nplum,,\r\n')
    } finally {
      rmSync(csvDir(), { recursive: true, force: true })
    }
  })

  test('a range copies as tabs; a block pastes as one edit, only its cells saved', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const f = path.join(csvDir(), 'paste.csv')
    const text = 'name,price,note\npear,2,"ripe\nsweet"\nplum,3,\nfig,4,dry\n'
    try {
      mkdirSync(csvDir(), { recursive: true })
      writeFileSync(f, text)
      await openCsv(page, 'paste.csv')
      const panel = page.getByRole('complementary', { name: 'Files' })
      const grid = panel.getByRole('grid')
      await expect(grid).toHaveAttribute('aria-busy', 'false')
      const cell = (pos: number, col: number) => grid.locator(`[data-pos="${pos}"][data-col="${col}"]`)
      // 2 rows × 3 columns with Shift and the arrows, while only viewing
      await cell(0, 0).focus()
      await page.keyboard.press('Shift+ArrowRight')
      await page.keyboard.press('Shift+ArrowRight')
      await page.keyboard.press('Shift+ArrowDown')
      await expect(grid.locator('[aria-selected="true"]')).toHaveCount(6)
      await page.keyboard.press('Control+c')
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('pear\t2\t"ripe\nsweet"\nplum\t3\t')
      await page.keyboard.press('Escape')
      await expect(grid.locator('[aria-selected="true"]')).toHaveCount(0)
      // A 2×2 block from a spreadsheet, pasted on price of plum
      await panel.getByRole('button', { name: 'Edit' }).click()
      await page.evaluate(() => navigator.clipboard.writeText('5\tnew\r\n6\t\r\n'))
      // A click only selects the cell, so the block pastes there
      await cell(1, 1).click()
      await expect(grid.getByRole('textbox')).toHaveCount(0)
      await page.keyboard.press('Control+v')
      await expect(cell(1, 2)).toHaveText('new')
      await expect(cell(2, 1)).toHaveText('6')
      await expect(cell(2, 2)).toHaveText('')
      // One Ctrl+Z takes the block back, Ctrl+Shift+Z brings it again
      await page.keyboard.press('Control+z')
      await expect(cell(1, 2)).toHaveText('')
      await page.keyboard.press('Control+Shift+z')
      await expect(cell(1, 2)).toHaveText('new')
      await panel.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByText('Saved', { exact: true })).toBeVisible()
      expect(readFileSync(f, 'utf-8')).toBe('name,price,note\npear,2,"ripe\nsweet"\nplum,5,new\nfig,6,\n')
    } finally {
      rmSync(csvDir(), { recursive: true, force: true })
    }
  })

  test('find in a table: every row stays, Enter and F3 go round, a regex finds', async ({ page }) => {
    const f = path.join(csvDir(), 'find.csv')
    // beta on rows of id 10, 150 and 290; bat on 200
    const words = Array.from(
      { length: 300 },
      (_, i) => `${i},${[10, 150, 290].includes(i) ? 'beta' : i === 200 ? 'bat' : `w${i}`}`,
    )
    const text = `id,word\n${words.join('\n')}\n`
    try {
      mkdirSync(csvDir(), { recursive: true })
      writeFileSync(f, text)
      await openCsv(page, 'find.csv')
      const panel = page.getByRole('complementary', { name: 'Files' })
      const grid = panel.getByRole('grid')
      await expect(grid).toHaveAttribute('aria-busy', 'false')
      // data-pos is the place in the rows shown: id i is at i
      const word = (pos: number) => grid.locator(`[data-pos="${pos}"][data-col="1"]`)
      await grid.getByRole('gridcell', { name: 'w0', exact: true }).focus()
      await page.keyboard.press('Control+f')
      const box = panel.getByRole('textbox', { name: 'Find' })
      await expect(box).toBeFocused()
      await box.fill('beta')
      await expect(panel.getByText('1 of 3')).toBeVisible()
      await expect(word(10)).toHaveClass(/from-accent\/15/)
      await expect(panel.getByText('300 / 300 rows')).toBeVisible()
      // Enter scrolls to the second, the focus left in find
      await page.keyboard.press('Enter')
      await expect(panel.getByText('2 of 3')).toBeVisible()
      await expect(word(150)).toBeInViewport()
      await expect(box).toBeFocused()
      await page.keyboard.press('Shift+F3')
      await expect(panel.getByText('1 of 3')).toBeVisible()
      await expect(word(10)).toBeInViewport()
      await panel.getByRole('button', { name: 'Regular expression' }).click()
      await box.fill('^b.t')
      await expect(panel.getByText('1 of 4')).toBeVisible()
      await expect(panel.getByText('300 / 300 rows')).toBeVisible()
      // Escape: back on the current match
      await box.press('Escape')
      await expect(box).toHaveCount(0)
      await expect(word(10)).toBeFocused()
      // F3 on the grid, find closed: on to the next match, given the focus
      await page.keyboard.press('F3')
      await expect(word(150)).toBeFocused()
      expect(readFileSync(f, 'utf-8')).toBe(text)
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
        await page.getByRole('group', { name: 'Wrap' }).getByRole('menuitemcheckbox', { name: '2 · note' }).click()
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
        // The whole value is in the cell's field (a click starts editing)
        await page.keyboard.press('PageUp')
        await grid.evaluate((el) => {
          el.scrollTop = 0
        })
        await row(3).getByRole('gridcell').nth(1).dblclick()
        await expect(grid.getByRole('textbox', { name: 'Edit note, row 3' })).toHaveValue('one\ntwo\nthree\nfour')
        await page.keyboard.press('Escape')
        await expect(grid.getByRole('textbox', { name: /^Edit / })).toHaveCount(0)
        await panel.getByRole('button', { name: 'Cancel editing' }).click()
        await panel.getByRole('button', { name: 'Columns' }).click()
        await page.getByRole('group', { name: 'Wrap' }).getByRole('menuitemcheckbox', { name: '2 · note' }).click()
        await page.keyboard.press('Escape')
        expect(await height(2)).toBe(32)
      } finally {
        rmSync(csvDir(), { recursive: true, force: true })
      }
    })

    test('a wrapped cell shows the lines chosen; a click edits a cell where it is', async ({ page }) => {
      const f = path.join(csvDir(), 'lines.csv')
      const lines = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i}`).join('\n')
      const text = `id,note,tag\n1,"${lines(6, 'six')}",a\n2,"${lines(12, 'twelve')}",b\n`
      try {
        mkdirSync(csvDir(), { recursive: true })
        writeFileSync(f, text)
        await openCsv(page, 'lines.csv')
        const panel = page.getByRole('complementary', { name: 'Files' })
        const grid = panel.getByRole('grid')
        await expect(grid).toHaveAttribute('aria-busy', 'false')
        const row = (n: number) => grid.getByRole('row').filter({ has: page.getByRole('rowheader', { name: `Row ${n}`, exact: true }) })
        const height = (n: number) => row(n).evaluate((el) => el.getBoundingClientRect().height)
        // Lines of a wrapped note drawn, and whether more are cut off
        const drawn = (n: number) =>
          row(n)
            .getByRole('gridcell')
            .nth(1)
            .locator('span')
            .evaluate((el) => ({ lines: Math.round(el.clientHeight / 16), cut: el.scrollHeight > el.clientHeight }))
        const choose = async (item: string, role: 'menuitemcheckbox' | 'menuitemradio') => {
          await panel.getByRole('button', { name: 'Columns' }).click()
          // A column is named in Show and in Wrap: this is Wrap's
          await (role === 'menuitemcheckbox' ? page.getByRole('group', { name: 'Wrap' }) : page).getByRole(role, { name: item }).click()
          await page.keyboard.press('Escape')
        }
        await choose('2 · note', 'menuitemcheckbox')
        expect(await drawn(2)).toEqual({ lines: 3, cut: true })
        await choose('6 lines', 'menuitemradio')
        expect(await height(2)).toBe(109)
        expect(await drawn(2)).toEqual({ lines: 6, cut: false })
        await choose('10 lines', 'menuitemradio')
        expect(await height(2)).toBe(173)
        expect(await drawn(3)).toEqual({ lines: 10, cut: true })
        expect(readFileSync(f, 'utf-8')).toBe(text)

        // A click on a cell of the table viewed edits it where it is, the
        // field as tall as its lines (12 of 16px, 6px padding), over the
        // rows below
        const field = (name: string) => grid.getByRole('textbox', { name })
        await row(3).getByRole('gridcell').nth(1).dblclick()
        await expect(field('Edit note, row 3')).toBeFocused()
        expect(await field('Edit note, row 3').evaluate((el) => el.getBoundingClientRect().height)).toBe(204)
        await page.keyboard.press('Escape')
        await row(2).getByRole('gridcell').nth(2).dblclick()
        await expect(field('Edit tag, row 2')).toBeFocused()
        await expect(field('Edit tag, row 2')).toHaveValue('a')
        // The last column's field grows leftward: the table gets no wider
        expect(await field('Edit tag, row 2').evaluate((el) => (el.closest('[role="gridcell"]') as Element).getBoundingClientRect().right - el.getBoundingClientRect().right)).toBe(0)
        expect(await grid.evaluate((el) => el.scrollLeft)).toBe(0)
        await page.keyboard.type('x')
        await page.keyboard.press('Enter')
        await expect(grid.getByRole('gridcell', { name: 'x', exact: true })).toBeFocused()
        await expect(panel.getByRole('button', { name: 'Save' })).toBeEnabled()
        await page.keyboard.press('Control+z')
        await expect(grid.getByRole('gridcell', { name: 'a', exact: true })).toBeFocused()
        // F2 edits the cell in focus; Escape drops what was typed
        await page.keyboard.press('F2')
        await page.keyboard.type('zzz')
        await page.keyboard.press('Escape')
        await expect(grid.getByRole('gridcell', { name: 'a', exact: true })).toBeFocused()
        // Shift+Enter breaks the line; Tab sets it and goes on, past the
        // row's end onto the next one
        await page.keyboard.press('Enter')
        await page.keyboard.type('p')
        await page.keyboard.press('Shift+Enter')
        await page.keyboard.type('q')
        await page.keyboard.press('Tab')
        await expect(field('Edit id, row 3')).toBeFocused()
        // A click elsewhere sets the value and keeps the focus there
        await page.keyboard.type('3')
        const filter = panel.getByRole('searchbox', { name: 'Filter rows' })
        await filter.click()
        await expect(filter).toBeFocused()
        await expect(grid.getByRole('gridcell', { name: '3', exact: true })).toBeVisible()
        await page.waitForTimeout(100)
        await expect(filter).toBeFocused()
        // ⤢ goes on in the sheet, with the row's actions
        await row(3).getByRole('gridcell').nth(2).dblclick()
        await field('Edit tag, row 3').fill('c')
        await grid.getByRole('button', { name: 'Open in sheet' }).click()
        const sheet = page.getByRole('dialog', { name: /Row 3 · tag/ })
        await expect(sheet.getByRole('textbox', { name: 'Value' })).toHaveValue('c')
        await expect(sheet.getByRole('button', { name: 'Add row below' })).toBeVisible()
        await expect(sheet.getByRole('button', { name: 'Delete row' })).toBeVisible()
        await sheet.getByRole('button', { name: 'Cancel' }).click()
        // Ctrl+S in a field sets it and saves the file
        await row(3).getByRole('gridcell').nth(0).dblclick()
        await page.keyboard.press('Control+s')
        await expect(page.getByText('Saved', { exact: true })).toBeVisible()
        expect(readFileSync(f, 'utf-8')).toBe(text.replace(',a\n', ',"p\nq"\n').replace('\n2,', '\n3,'))
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
        await page.getByRole('group', { name: 'Wrap' }).getByRole('menuitemcheckbox', { name: '2 · note' }).click()
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

    test('a pinned first column stays next to the row numbers, and its tab keeps it', async ({ page }) => {
      const head = Array.from({ length: 30 }, (_, i) => `col${i}`).join(',')
      const row = (n: number) => Array.from({ length: 30 }, (_, i) => `r${n}c${i}`).join(',')
      try {
        mkdirSync(csvDir(), { recursive: true })
        writeFileSync(path.join(csvDir(), 'wide.csv'), `${head}\n${row(1)}\n${row(2)}\n`)
        writeFileSync(path.join(csvDir(), 'two.csv'), 'a,b\n1,2\n')
        await openCsv(page, 'wide.csv')
        const panel = page.getByRole('complementary', { name: 'Files' })
        const bar = panel.getByRole('tablist', { name: 'Open files' })
        const grid = panel.getByRole('grid')
        await expect(grid).toHaveAttribute('aria-busy', 'false')
        await bar.getByRole('tab', { name: /^wide\.csv/ }).dblclick()
        await panel.getByRole('button', { name: 'Columns' }).click()
        await page.getByRole('menuitemcheckbox', { name: 'Pin first column' }).click()
        await page.keyboard.press('Escape')
        // Scrolled to the far right, the first column sits next to the row
        // numbers, its header too
        const scrolledRight = async () => {
          const g = panel.getByRole('grid')
          await g.evaluate((el) => {
            el.scrollLeft = el.scrollWidth
          })
          const number = (await g.getByRole('rowheader', { name: 'Row 2', exact: true }).boundingBox())!
          const cell = (await g.getByRole('gridcell', { name: 'r1c0', exact: true }).boundingBox())!
          const header = (await g.getByRole('columnheader', { name: 'col0', exact: true }).boundingBox())!
          expect(await g.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
          expect(Math.round(cell.x)).toBe(Math.round(number.x + number.width))
          expect(Math.round(header.x)).toBe(Math.round(cell.x))
          await expect(g.getByRole('gridcell', { name: 'r1c29', exact: true })).toBeInViewport()
        }
        await scrolledRight()
        await bar.getByRole('tab', { name: 'Files' }).click()
        await panel.getByRole('treeitem', { name: 'two.csv' }).click()
        await expect(panel.getByRole('grid').getByRole('columnheader', { name: 'a', exact: true })).toBeVisible()
        await bar.getByRole('tab', { name: 'wide.csv', exact: true }).click()
        await panel.getByRole('button', { name: 'Columns' }).click()
        await expect(page.getByRole('menuitemcheckbox', { name: 'Pin first column' })).toHaveAttribute('aria-checked', 'true')
        await page.keyboard.press('Escape')
        await scrolledRight()
        // Keys back to a column scrolled under the pinned one bring it out
        // from under it: the cell is what shows at its own centre
        const g = panel.getByRole('grid')
        await g.getByRole('gridcell', { name: 'r1c29', exact: true }).focus()
        await page.keyboard.press('Home')
        await expect(g.getByRole('gridcell', { name: 'r1c0', exact: true })).toBeFocused()
        await page.keyboard.press('ArrowRight')
        const c1 = g.getByRole('gridcell', { name: 'r1c1', exact: true })
        await expect(c1).toBeFocused()
        await expect
          .poll(() =>
            c1.evaluate((el) => {
              const r = el.getBoundingClientRect()
              return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
            }),
          )
          .toBe(true)
      } finally {
        rmSync(csvDir(), { recursive: true, force: true })
      }
    })

    test('hidden columns leave the grid and Records, are still filtered on, and come back', async ({ page }) => {
      const f = path.join(csvDir(), 'hide.csv')
      const text = 'name,secret,city,note\npear,alpha,Huế,ripe\nplum,beta,Hà Nội,dry\n'
      try {
        mkdirSync(csvDir(), { recursive: true })
        writeFileSync(f, text)
        await openCsv(page, 'hide.csv')
        const panel = page.getByRole('complementary', { name: 'Files' })
        const grid = panel.getByRole('grid')
        await expect(grid).toHaveAttribute('aria-busy', 'false')
        const show = page.getByRole('group', { name: 'Show' })
        await panel.getByRole('button', { name: 'Columns' }).click()
        await show.getByRole('menuitemcheckbox', { name: '2 · secret' }).click()
        await show.getByRole('menuitemcheckbox', { name: '4 · note' }).click()
        await page.keyboard.press('Escape')
        await expect(grid.getByRole('columnheader', { name: 'secret', exact: true })).toHaveCount(0)
        await expect(grid.getByRole('columnheader', { name: 'note', exact: true })).toHaveCount(0)
        await expect(grid.getByRole('columnheader', { name: 'city', exact: true })).toBeVisible()
        // The filter still matches a value only a hidden column has
        await panel.getByRole('searchbox', { name: 'Filter rows' }).fill('beta')
        await expect(panel.getByText('1 / 2 rows · 2 columns hidden')).toBeVisible()
        await expect(grid.getByRole('gridcell', { name: 'plum', exact: true })).toBeVisible()
        await panel.getByRole('searchbox', { name: 'Filter rows' }).fill('')
        // Keys go past the hidden column
        await grid.getByRole('gridcell', { name: 'pear', exact: true }).focus()
        await page.keyboard.press('ArrowRight')
        await expect(grid.getByRole('gridcell', { name: 'Huế', exact: true })).toBeFocused()
        await panel.getByRole('button', { name: 'Records' }).click()
        await expect(page.getByText('Record 1 / 2 · row 2 · 2 columns hidden')).toBeVisible()
        await expect(page.getByRole('term')).toHaveText(['name', 'city'])
        await panel.getByRole('button', { name: 'Records' }).click()
        await panel.getByRole('button', { name: 'Columns' }).click()
        await page.getByRole('menuitem', { name: 'Show all' }).click()
        await page.keyboard.press('Escape')
        await expect(grid.getByRole('columnheader', { name: 'secret', exact: true })).toBeVisible()
        // Another header row shows every column again
        await panel.getByRole('button', { name: 'Columns' }).click()
        await show.getByRole('menuitemcheckbox', { name: '3 · city' }).click()
        await page.keyboard.press('Escape')
        await expect(grid.getByRole('columnheader', { name: 'city', exact: true })).toHaveCount(0)
        await panel.getByRole('button', { name: 'Header row' }).click()
        await expect(grid.getByRole('columnheader', { name: 'Column 3', exact: true })).toBeVisible()
        expect(readFileSync(f, 'utf-8')).toBe(text)
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
          // A tap on a cell shows it in its sheet: no field, no editing
          await grid.getByRole('gridcell', { name: 'n0', exact: true }).tap()
          await expect(page.getByRole('dialog', { name: /Row 4 · note/ })).toBeVisible()
          await expect(page.getByRole('textbox', { name: /^Edit / })).toHaveCount(0)
          await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0)
          await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
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

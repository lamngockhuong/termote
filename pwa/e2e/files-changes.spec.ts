import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
// image views read them through files/raw as blob: URLs, which the page's
// CSP must allow
const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGO4o6EBRww4OQAa3g4RLYR9sQAAAABJRU5ErkJggg=='
const BLUE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAUAAAADCAIAAADUVFKvAAAAEElEQVR4nGPQ0LiDjBgI8AGbkxGVdkTjRAAAAABJRU5ErkJggg=='
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>\n'

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
    const img = panel.locator('img[src^="blob:"]')
    await expect(img).toHaveCount(1)
    await expect.poll(() => decodedWidth(img)).toBe(8)
  })
})

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { en } from '../src/i18n/messages/en'
import { vi } from '../src/i18n/messages/vi'
import { expect, type Page, test } from './fixtures'

// The whole app in Vietnamese, as a Vietnamese browser opens it on Auto: the
// welcome screen, the tour, Settings, the Usage Guide, then Files, Changes,
// Chat and Tasks on a pane running a stand-in Claude Code in a git repo. On
// each screen no English message is left: no text, label or title equal to
// an English message that Vietnamese words differently.

const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'
const fakeClaude = path.resolve(import.meta.dirname, '../../tests/fixtures/fake-claude.sh')

const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' })

const V = vi as Record<string, string>
// The English messages Vietnamese words differently, whole: a message with a
// placeholder or a tag never shows as it is written, and one Vietnamese also
// uses (for another key) is no sign of English left
const VIETNAMESE = new Set(Object.values(V))
const ENGLISH = [
  ...new Set(
    Object.entries(en as Record<string, string>)
      .filter(([k, text]) => V[k] !== text && !VIETNAMESE.has(text) && !/[{<]/.test(text) && /\p{L}{2}/u.test(text))
      .map(([, text]) => text),
  ),
]

// Each text, label, title and placeholder on screen equal to an English
// message; the terminal, the agent's conversation and a file's content are
// what the pane holds, not the app's words
async function englishLeft(page: Page): Promise<string[]> {
  const shown = await page.evaluate(() => {
    const skip = (el: Element | null) =>
      !!el?.closest('.xterm, [data-testid="terminal-view"], [role="log"], .cm-editor, pre, code')
    const out: string[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement
      const text = n.textContent?.trim()
      if (!text || !el || skip(el) || !el.checkVisibility()) continue
      out.push(text)
    }
    for (const el of document.querySelectorAll('[aria-label], [title], [placeholder], [alt]')) {
      if (skip(el)) continue
      for (const a of ['aria-label', 'title', 'placeholder', 'alt']) {
        const v = el.getAttribute(a)?.trim()
        if (v) out.push(v)
      }
    }
    return out
  })
  const english = new Set(ENGLISH)
  return [...new Set(shown.filter((s) => english.has(s)))]
}

async function expectVietnamese(page: Page, where: string) {
  expect(await englishLeft(page), `English left in ${where}`).toEqual([])
}

const welcome = (page: Page) => page.getByTestId('welcome')

// An item of the More menu, named in the app's language
async function openMenu(page: Page, item: string, words: Record<string, string> = V) {
  await page.getByRole('button', { name: words['shell.menu.more'] }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

for (const device of ['phone', 'desktop'] as const) {
  const viewport = device === 'phone' ? { width: 390, height: 844 } : { width: 1280, height: 800 }
  const touch = device === 'phone' ? { isMobile: true, hasTouch: true } : {}

  test.describe(`${device} in Vietnamese: welcome, tour, Settings, Usage Guide`, () => {
    test.use({ locale: 'vi-VN', viewport, ...touch, firstRunSeen: false })

    test('speaks Vietnamese throughout', async ({ page }) => {
      await page.goto('/')
      await expect(welcome(page)).toBeVisible({ timeout: 10000 })
      await expect(page.locator('html')).toHaveAttribute('lang', 'vi')
      await expect(welcome(page)).toContainText(V['welcome.setup'])
      await expectVietnamese(page, 'the welcome screen')
      // The push worker reads the same language
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const res = await caches.match('/__locale', { cacheName: 'termote-prefs' })
            return res ? res.text() : null
          }),
        )
        .toBe('vi')
      // Picked by the browser, not by the device: no banner about it
      await expect(page.getByText(V['shell.languageNotice.body'])).toHaveCount(0)

      await welcome(page).getByRole('button', { name: V['welcome.tour'] }).click()
      const tour = page.getByTestId('tour')
      await expect(tour).toBeVisible()
      for (let step = 0; step < 6; step++) {
        await expectVietnamese(page, `tour step ${step + 1}`)
        const done = tour.getByRole('button', { name: V['common.done'] })
        if (await done.isVisible()) {
          await done.click()
          break
        }
        await tour.getByRole('button', { name: V['common.next'] }).click()
      }
      await expect(tour).toBeHidden()

      await openMenu(page, V['common.settings'])
      const settings = page.getByRole('dialog', { name: V['common.settings'] })
      await expect(settings).toBeVisible()
      const rail = settings.getByRole('navigation', { name: V['settings.groups'] })
      if (await rail.isVisible()) {
        // Desktop shows one group at a time
        for (const group of await rail.getByRole('button').all()) {
          await group.click()
          await expectVietnamese(page, `Settings › ${await group.textContent()}`)
        }
        await rail.getByRole('button', { name: V['settings.group.appearance'] }).click()
      } else {
        await expectVietnamese(page, 'Settings')
      }
      await expect(settings.getByRole('radiogroup', { name: V['settings.language'] })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(settings).toBeHidden()

      await openMenu(page, V['shell.menu.help'])
      const guide = page.getByRole('dialog', { name: V['help.title'] })
      await expect(guide).toBeVisible()
      for (const tab of await guide.getByRole('radio').all()) {
        await tab.click()
        await expectVietnamese(page, `Usage Guide › ${await tab.textContent()}`)
      }
    })
  })
}

test.describe('Language', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('a device that picked Vietnamese before is told once, and goes back to English', async ({ page }) => {
    // What the welcome screen's EN | VI saved before the whole app spoke it
    await page.addInitScript(() => {
      if (!localStorage.getItem('termote-settings')) {
        localStorage.setItem('termote-settings', JSON.stringify({ language: 'vi' }))
      }
    })
    await page.goto('/')
    const banner = page.getByRole('status').filter({ hasText: V['shell.languageNotice.body'] })
    await expect(banner).toBeVisible({ timeout: 10000 })
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi')
    await banner.getByRole('button', { name: V['shell.languageNotice.english'] }).click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.getByText(V['shell.languageNotice.body'])).toHaveCount(0)
    await expect(page.getByRole('button', { name: en['shell.menu.more'] })).toBeVisible()
    await page.reload()
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
    await expect(page.getByText(en['shell.languageNotice.body'])).toHaveCount(0)
    await expect(page.getByText(V['shell.languageNotice.body'])).toHaveCount(0)
  })

  test('Settings › Language applies at once', async ({ page }) => {
    await page.goto('/')
    await openMenu(page, en['common.settings'], en)
    const settings = page.getByRole('dialog', { name: en['common.settings'] })
    await expect(settings).toBeVisible()
    // The check above finds the English it is there to find
    expect(await englishLeft(page)).toContain(en['settings.language'])
    await settings
      .getByRole('radiogroup', { name: en['settings.language'] })
      .getByRole('radio', { name: V['common.vietnamese'] })
      .click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi')
    await expect(page.getByRole('dialog', { name: V['common.settings'] })).toBeVisible()
    await expect(page.getByRole('radiogroup', { name: V['settings.language'] })).toBeVisible()
    await expect(page.getByText(V['shell.languageNotice.body'])).toHaveCount(0)
    await page.getByRole('radio', { name: V['settings.languageAuto'] }).click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  })
})

test.describe('the views in Vietnamese', () => {
  test.skip(!socket || process.platform !== 'linux', 'needs TMUX_SOCKET of the server under test (Linux)')
  test.describe.configure({ mode: 'serial' })
  test.use({ locale: 'vi-VN' })

  let repo = ''
  let claudeDir = ''
  let windowId = ''
  let link = ''

  test.beforeAll(async ({ playwright }, testInfo) => {
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    const snap = await (await api.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps.files || !snap.caps.tasks, 'the backend reports no pane directory')

    // A repo with a script for Tasks and a change for Changes
    repo = mkdtempSync(path.join(tmpdir(), 'termote-e2e-vi-'))
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'e2e@example.com')
    git(repo, 'config', 'user.name', 'e2e')
    writeFileSync(path.join(repo, 'package.json'), '{"scripts":{"hello":"echo hi"}}\n')
    writeFileSync(path.join(repo, 'notes.txt'), 'one\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    writeFileSync(path.join(repo, 'notes.txt'), 'one\ntwo\n')
    claudeDir = mkdtempSync(path.join(tmpdir(), 'termote-e2e-claude-'))

    const name = `vi-${Date.now()}`
    windowId = tmux(
      'new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', name, '-c', repo,
      'env', `CLAUDE_CONFIG_DIR=${claudeDir}`, 'bash', fakeClaude,
    ).trim()
    // A link straight to the window (no tab to click on a phone), once the
    // server sees the agent in it, so Chat is offered
    type Tab = { id: string; name: string; panes: { agent?: unknown }[] }
    await expect(async () => {
      const s = await (await api.get('/api/mux/snapshot')).json()
      const group = s.groups.find((g: { tabs: Tab[] }) => g.tabs.some((t) => t.name === name))
      const tab: Tab | undefined = group?.tabs.find((t: Tab) => t.name === name)
      expect(tab?.panes.some((p) => p.agent)).toBe(true)
      link = `#/s/${encodeURIComponent(group.id)}/${encodeURIComponent(tab!.id)}`
    }).toPass({ timeout: 20000 })
    await api.dispose()
  })

  test.afterAll(() => {
    try {
      if (windowId) tmux('kill-window', '-t', windowId)
    } catch {
      // Already gone
    }
    for (const dir of [repo, claudeDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  // Something each view shows once the server answered: the repo's files,
  // its change, the agent's conversation, the package's script
  const LOADED = { files: 'package.json', changes: 'notes.txt', chat: 'Fix the build please', tasks: 'hello' }

  for (const device of ['phone', 'desktop'] as const) {
    test(`${device}: Files, Changes, Chat and Tasks`, async ({ page }) => {
      await page.setViewportSize(device === 'phone' ? { width: 390, height: 844 } : { width: 1280, height: 800 })
      let load = 0
      for (const view of ['files', 'changes', 'chat', 'tasks'] as const) {
        // A query, so the page loads again rather than only following the hash
        await page.goto(`/?r=${++load}${link}?view=${view}`)
        await expect(page.locator('html')).toHaveAttribute('lang', 'vi')
        const name = V[`common.${view}`]
        // Desktop shows Files and Changes in the side panel
        const shown =
          device === 'desktop' && (view === 'files' || view === 'changes')
            ? page.getByRole('complementary', { name })
            : page.locator(`#view-panel-${view}`)
        await expect(shown).toBeVisible({ timeout: 15000 })
        // What the view reads from the server is in
        await expect(shown.getByText(LOADED[view]).first()).toBeVisible({ timeout: 15000 })
        await expectVietnamese(page, view)
      }
    })
  }
})

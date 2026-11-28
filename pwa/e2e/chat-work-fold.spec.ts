import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'

// A run of steps in the Chat view while the agent works and once it is done,
// against the stand-in Claude Code (tests/fixtures/fake-claude.sh): "work"
// runs four commands two seconds apart, the third failing; "steps then
// permission" runs two commands, then waits on the Bash permission dialog. It needs the
// socket and session of the server under test (TMUX_SOCKET, TMUX_SESSION);
// Linux only, like the stand-in.
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'
const fakeClaude = path.resolve(
  import.meta.dirname,
  '../../tests/fixtures/fake-claude.sh',
)

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], {
    encoding: 'utf-8',
  })

test.describe('chat view runs of work', () => {
  test.skip(
    !socket || process.platform !== 'linux',
    'needs TMUX_SOCKET of the server under test (Linux)',
  )
  test.describe.configure({ mode: 'serial' })
  // Short enough that the conversation scrolls
  test.use({ viewport: { width: 1000, height: 560 } })

  let windowId = ''
  let link = ''
  const dirs: string[] = []

  test.beforeAll(async ({ playwright }, testInfo) => {
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    expect((await api.get('/api/mux/snapshot')).ok()).toBe(true)
    const name = `fake-claude-work-${Date.now()}`
    const claudeDir = mkdtempSync(path.join(tmpdir(), 'termote-e2e-claude-'))
    const cwd = mkdtempSync(path.join(tmpdir(), 'termote-e2e-cwd-'))
    dirs.push(claudeDir, cwd)
    windowId = tmux(
      'new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', name, '-c', cwd,
      'env', `CLAUDE_CONFIG_DIR=${claudeDir}`, 'bash', fakeClaude,
    ).trim()
    await expect(async () => {
      const s = await (await api.get('/api/mux/snapshot')).json()
      const group = s.groups.find((g: { tabs: { name: string }[] }) => g.tabs.some((t) => t.name === name))
      const tab = group?.tabs.find((t: { name: string }) => t.name === name)
      expect(tab?.panes?.[0]?.agent).toBeTruthy()
      link = `/#/s/${encodeURIComponent(group.id)}/${encodeURIComponent(tab.id)}?view=chat`
    }).toPass({ timeout: 15000 })
    await api.dispose()
  })

  test.afterAll(() => {
    try {
      if (windowId) tmux('kill-window', '-t', windowId)
    } catch {
      // Already gone
    }
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  const conversationOf = (page: Page) => page.getByRole('region', { name: 'Conversation' })
  // The header of the newest run
  const runOf = (page: Page) =>
    conversationOf(page).getByRole('button', { name: /^(Working|Worked|Needs you)/ }).last()

  // Sends "work" and waits for the run it makes to be working
  async function work(page: Page) {
    await page.goto(link)
    const conversation = conversationOf(page)
    await expect(conversation).toContainText('Fix the build please', { timeout: 15000 })
    await page.getByRole('textbox', { name: 'Message to Claude Code' }).fill('work')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(runOf(page)).toHaveAccessibleName(/^Working… · \d+s · \d+ commands/, { timeout: 20000 })
  }

  const done = (run: Locator) =>
    expect(run).toHaveAccessibleName(/^Worked for \d+s · 4 commands · 1 failed$/, { timeout: 20000 })

  const atBottom = (list: Locator) =>
    list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 2)

  test('works counting the seconds, then folds at the bottom', async ({ page }) => {
    await work(page)
    const run = runOf(page)
    // The time goes on a second at a time
    const seconds = async () => Number(/· (\d+)s ·/.exec((await run.getAttribute('aria-label')) ?? '')?.[1])
    const first = await seconds()
    await expect.poll(seconds, { timeout: 5000 }).toBeGreaterThan(first)
    // Each step is a line
    await expect(conversationOf(page).getByRole('button', { name: 'Ran step-1' })).toBeVisible()

    await done(run)
    await expect(run).toHaveAttribute('aria-expanded', 'false')
    await expect(conversationOf(page).getByRole('button', { name: 'Ran step-1' })).toHaveCount(0)
    // The count of failures shows whole, never cut with the summary
    const failed = run.getByText('· 1 failed')
    await expect(failed).toBeVisible()
    await expect(failed).toHaveCSS('flex-shrink', '0')
    // Folded, the list stays at its bottom on the answer
    await expect(conversationOf(page).getByText('Worked through four steps.').last()).toBeInViewport()
    expect(await atBottom(conversationOf(page))).toBe(true)
  })

  test('each step is a line, and a tap on it shows its card', async ({ page }) => {
    await page.goto(link)
    const run = runOf(page)
    await done(run)
    await run.click()
    const failedStep = conversationOf(page).getByRole('button', { name: 'Ran step-3 failed' })
    await expect(failedStep).toBeVisible()
    await expect(failedStep.getByText('failed', { exact: true })).toHaveCSS('flex-shrink', '0')
    await expect(conversationOf(page).locator('[data-tool="Bash"]').filter({ hasText: 'step-3' })).toHaveCount(0)
    await failedStep.click()
    await expect(failedStep).toHaveAttribute('aria-expanded', 'true')
    await expect(conversationOf(page).locator('[data-tool="Bash"]').filter({ hasText: 'step-3' })).toBeVisible()
  })

  test('read above when the turn ends, the run stays open until the bottom', async ({ page }) => {
    await work(page)
    const list = conversationOf(page)
    await list.evaluate((el) => {
      el.scrollTop = 0
    })
    await expect.poll(() => atBottom(list)).toBe(false)
    const run = runOf(page)
    await done(run)
    // Still open on its steps for the reader above
    await expect(list.getByRole('button', { name: 'Ran step-4' })).toHaveCount(1)
    await page.waitForTimeout(500)
    await expect(list.getByRole('button', { name: 'Ran step-4' })).toHaveCount(1)
    // Back at the bottom, it folds
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await expect(list.getByRole('button', { name: 'Ran step-4' })).toHaveCount(0)
    await expect(run).toHaveAttribute('aria-expanded', 'false')
  })

  test('a run waiting on a permission says it needs the reader, its time stopped', async ({ page }) => {
    await page.goto(link)
    const conversation = conversationOf(page)
    await expect(conversation).toContainText('Fix the build please', { timeout: 15000 })
    await page.getByRole('textbox', { name: 'Message to Claude Code' }).fill('steps then permission')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const card = page.getByRole('alertdialog', { name: 'Bash command' })
    await expect(card).toBeVisible({ timeout: 15000 })
    const run = runOf(page)
    await expect(run).toHaveAccessibleName(/^Needs you · 3 commands$/)
    await expect(run.getByText(/· \d+s/)).toHaveCount(0)
    // Answered, the turn ends and the run folds
    await card.getByRole('button', { name: /^1\.\s*Yes$/ }).click()
    await expect(conversation).toContainText('Created scratch-one.txt.')
    await expect(run).toHaveAccessibleName(/^Worked for \d+s · 3 commands$/)
    await expect(run).toHaveAttribute('aria-expanded', 'false')
  })

  test('a run the reader clicked in stays open once done', async ({ page }) => {
    await work(page)
    const step = conversationOf(page).getByRole('button', { name: 'Ran step-1' })
    await step.click()
    await expect(step).toHaveAttribute('aria-expanded', 'true')
    const run = runOf(page)
    await done(run)
    await expect(step).toBeVisible()
    await expect(conversationOf(page).getByRole('button', { name: 'Ran step-4' })).toBeVisible()
  })
})

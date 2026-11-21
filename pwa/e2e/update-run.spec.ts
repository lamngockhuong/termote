import { execFileSync } from 'node:child_process'
import { expect, type Page, test } from './fixtures'

// Settings' Run in a new tab for the update. The server under test is no
// installed release, and its real update must never run here: health is
// rewritten to report one, and the run route is answered by the test, which
// checks the page only names the task.

const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'
const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })

const waitForTerminal = (page: Page) =>
  page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })

const openUpdates = async (page: Page) => {
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await page
    .getByRole('navigation', { name: 'Settings groups' })
    .getByRole('button', { name: 'Updates' })
    .click()
  return page.getByRole('dialog', { name: 'Settings' })
}

test.describe('run the update in a new tab', () => {
  let runs: unknown[] = []
  let answer: (tabId: string) => { status: number; json: unknown } | Promise<{ status: number; json: unknown }>

  test.beforeEach(async ({ page, request }) => {
    const snap = await (await request.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps?.tasks, 'the server runs no tasks')
    const tabId: string = snap.groups[0].tabs[0].id
    runs = []
    // A newer release, as a check made a moment ago left it
    await page.addInitScript(() => {
      localStorage.setItem(
        'termote-update-check',
        JSON.stringify({
          version: '99.0.0',
          url: 'https://github.com/lamngockhuong/termote/releases/tag/v99.0.0',
          checkedAt: Date.now(),
        }),
      )
    })
    await page.route('https://api.github.com/**', (route) => route.fulfill({ json: [] }))
    await page.route(/\/api\/mux\/health(\?|$)/, async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      await route.fulfill({ response: res, json: { ...body, install: 'release' } })
    })
    await page.route(/\/api\/mux\/panes\/[^/]+\/tasks\/run$/, async (route) => {
      runs.push(route.request().postDataJSON())
      const { status, json } = await answer(tabId)
      await route.fulfill({ status, json })
    })
    await page.goto('/')
    await waitForTerminal(page)
  })

  test('names the task only, closes Settings and shows the new tab', async ({ page }) => {
    test.skip(!socket || process.platform !== 'linux', 'needs TMUX_SOCKET of the server under test (Linux)')
    // The run's tab, as the server would open it: not read by the page yet
    const name = `update-${Date.now()}`
    let window = ''
    answer = async () => {
      window = tmux('new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', name).trim()
      const snap = await (await page.request.get('/api/mux/snapshot')).json()
      const tab = snap.groups
        .flatMap((g: { tabs: { id: string; name: string }[] }) => g.tabs)
        .find((t: { name: string }) => t.name === name)
      return {
        status: 200,
        json: { runId: 'a'.repeat(16), tabId: tab.id, paneId: '', nonce: 'b'.repeat(16), reused: false },
      }
    }
    try {
      const dialog = await openUpdates(page)
      await expect(dialog.getByText('termote update', { exact: true })).toBeVisible()
      await dialog.getByRole('button', { name: 'Run in a new tab' }).click()
      await expect(dialog).toBeHidden()
      await expect(page.getByText(/Updating in tab task:termote:update/)).toBeVisible()
      await expect(
        page.getByRole('tablist', { name: 'Sessions' }).getByRole('tab', { name: new RegExp(name) }),
      ).toHaveAttribute('aria-selected', 'true')
      expect(runs).toEqual([{ kind: 'termote', name: 'update', root: '' }])
    } finally {
      if (window) tmux('kill-window', '-t', window)
    }
  })

  test('shows the running update when one already runs', async ({ page }) => {
    answer = (tabId) => ({
      status: 409,
      json: { error: 'the task is running', code: 'task_running', runId: 'a'.repeat(16), tabId },
    })
    const dialog = await openUpdates(page)
    await dialog.getByRole('button', { name: 'Run in a new tab' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText('An update is already running')).toBeVisible()
  })

  test('says why an install cannot update itself', async ({ page }) => {
    answer = () => ({
      status: 409,
      json: { error: 'this install cannot update itself from here', code: 'update_unsupported' },
    })
    const dialog = await openUpdates(page)
    await dialog.getByRole('button', { name: 'Run in a new tab' }).click()
    // In Settings, which stays open: a toast would show under it
    await expect(dialog.getByRole('alert')).toHaveText(
      'Could not start the update: This install cannot update itself from here',
    )
  })
})

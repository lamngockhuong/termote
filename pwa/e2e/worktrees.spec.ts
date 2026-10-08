import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from './fixtures'

// Git worktree workspaces from the PWA, against a Herdr of their own: the
// e2e-herdr CI job starts a headless Herdr on its own socket, a throwaway
// repo (TERMOTE_E2E_REPO, with a branch e2e-base) and a workspace labelled
// e2e-repo in it. Without TERMOTE_E2E_HERDR=1 the spec skips, so a run
// against a developer's own Herdr never touches it.
const enabled = process.env.TERMOTE_E2E_HERDR === '1'
const repo = process.env.TERMOTE_E2E_REPO ?? ''
const SOURCE = 'e2e-repo'

const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

// Every worktree's path and branch, as git lists them
function worktrees(): { path: string; branch: string }[] {
  return git('worktree', 'list', '--porcelain')
    .split('\n\n')
    .map((block) => ({
      path: block.match(/^worktree (.*)$/m)?.[1] ?? '',
      branch: block.match(/^branch refs\/heads\/(.*)$/m)?.[1] ?? '',
    }))
}
const pathOf = (branch: string) =>
  worktrees().find((w) => w.branch === branch)?.path ?? ''

// Branches this test made (or checked out), removed after it
const made: string[] = []
const fresh = () => {
  const name = `e2e-wt-${Math.random().toString(36).slice(2, 8)}`
  made.push(name)
  return name
}

async function open(page: Page) {
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true }))
  })
  await page.reload()
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
}

const menuOf = (page: Page, name: string) =>
  page.getByRole('button', { name: `Actions for workspace ${name}` })

// The sidebar section of the workspace showing branch
const sectionOf = (page: Page, branch: string) =>
  page.locator('aside section').filter({ has: page.getByTitle(branch, { exact: true }) })

async function createWorktree(page: Page, branch: string) {
  await menuOf(page, SOURCE).click()
  await page.getByRole('menuitem', { name: 'New worktree' }).click()
  await page.getByLabel('Branch (new, or one to check out)').fill(branch)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(sectionOf(page, branch)).toBeVisible({ timeout: 30000 })
}

// Opens the Remove confirmation of the workspace showing branch
async function askRemove(page: Page, branch: string) {
  const name = await sectionOf(page, branch).getAttribute('aria-label')
  await menuOf(page, name ?? branch).click()
  await page.getByRole('menuitem', { name: 'Remove worktree' }).click()
}

test.describe('Herdr worktrees from the PWA', () => {
  test.skip(!enabled, 'needs TERMOTE_E2E_HERDR=1: a Herdr of its own (the e2e-herdr job)')

  test.beforeEach(async ({ request }) => {
    expect(repo, 'TERMOTE_E2E_REPO').not.toBe('')
    const snap = await (await request.get('/api/mux/snapshot')).json()
    // The job runs Herdr 0.9.3: a missing cap is a failure, not a skip
    expect(snap.caps.worktrees, 'caps.worktrees').toBe(true)
  })

  test.afterEach(async ({ request }) => {
    const snap = await (await request.get('/api/mux/snapshot')).json()
    for (const branch of made.splice(0)) {
      const path = pathOf(branch)
      const group = snap.groups.find(
        (g: { worktree?: { branch?: string } }) => g.worktree?.branch === branch,
      )
      if (group && path) {
        await request.delete(`/api/mux/worktrees/${group.id}`, {
          data: { force: true, path, branch },
        })
      }
      try {
        if (path) git('worktree', 'remove', '--force', path)
      } catch {
        // Removed by the test or the API above
      }
      git('worktree', 'prune')
      if (branch !== 'e2e-base') {
        try {
          git('branch', '-D', branch)
        } catch {
          // Never made
        }
      }
    }
  })

  test('create a worktree and remove it clean', async ({ page }) => {
    await open(page)
    const branch = fresh()
    await createWorktree(page, branch)

    // Herdr made the checkout; the new workspace is the one on screen
    const path = pathOf(branch)
    expect(path).not.toBe('')
    await expect(sectionOf(page, branch).locator('[aria-current="true"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="terminal-view"] .xterm')).toBeVisible()

    await askRemove(page, branch)
    const dialog = page.getByRole('dialog', { name: `Remove worktree "${branch}"?` })
    await expect(dialog).toContainText(path)
    await dialog.getByRole('button', { name: 'Remove worktree' }).click()

    await expect(sectionOf(page, branch)).toHaveCount(0, { timeout: 30000 })
    expect(worktrees().map((w) => w.path)).not.toContain(path)
    // The branch is kept
    expect(git('branch', '--list', branch)).toContain(branch)
  })

  test('an existing branch is checked out without a base', async ({ page }) => {
    await open(page)
    made.push('e2e-base')
    await menuOf(page, SOURCE).click()
    await page.getByRole('menuitem', { name: 'New worktree' }).click()
    await page.getByLabel('Branch (new, or one to check out)').fill('e2e-base')
    await expect(page.getByText('Checks out the existing branch; base is not used')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Base:/ })).toHaveCount(0)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(sectionOf(page, 'e2e-base')).toBeVisible({ timeout: 30000 })
    expect(git('-C', pathOf('e2e-base'), 'branch', '--show-current')).toBe('e2e-base')
  })

  test('a dirty worktree is removed only after a second confirmation', async ({ page }) => {
    await open(page)
    const branch = fresh()
    await createWorktree(page, branch)
    const path = pathOf(branch)
    const file = join(path, 'untracked.txt')
    writeFileSync(file, 'work in progress\n')

    await askRemove(page, branch)
    await page.getByRole('dialog').getByRole('button', { name: 'Remove worktree' }).click()
    const second = page.getByRole('dialog', { name: `Remove worktree "${branch}" anyway?` })
    await expect(second).toContainText('uncommitted or untracked changes')
    await second.getByRole('button', { name: 'Cancel' }).click()
    expect(existsSync(file)).toBe(true)

    await askRemove(page, branch)
    await page.getByRole('dialog').getByRole('button', { name: 'Remove worktree' }).click()
    await page
      .getByRole('dialog', { name: `Remove worktree "${branch}" anyway?` })
      .getByRole('button', { name: 'Remove anyway' })
      .click()
    await expect(sectionOf(page, branch)).toHaveCount(0, { timeout: 30000 })
    expect(existsSync(path)).toBe(false)
  })

  test('an invalid name is pointed out and nothing is sent', async ({ page }) => {
    await open(page)
    const posts: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/mux/worktrees')) posts.push(r.url())
    })
    await menuOf(page, SOURCE).click()
    await page.getByRole('menuitem', { name: 'New worktree' }).click()
    const field = page.getByLabel('Branch (new, or one to check out)')
    for (const bad of ['-x', 'a‮b']) {
      await field.fill(bad)
      await page.getByRole('button', { name: 'Create' }).click()
      await expect(page.getByRole('alert')).toHaveText('Not a valid branch name')
    }
    expect(posts).toEqual([])
  })
})

import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { expect, type Page, test } from './fixtures'

// Git worktrees from the PWA, on any backend that has them, against a server
// of its own: a throwaway repo (TERMOTE_E2E_REPO, with a branch e2e-base)
// under a temporary directory, and a group named e2e-repo working in it
// (made here when the server has none: on herdr-core a space takes its
// folder's name, so the repo's folder is e2e-repo). CI runs it on Herdr
// (e2e-herdr, which makes the workspace itself), tmux (e2e) and herdr-core
// (e2e-hc), each with its own HOME, where tmux and herdr-core put the new
// checkouts. Without TERMOTE_E2E_WORKTREES=1 (or TERMOTE_E2E_HERDR=1) the
// spec skips, so a run against a developer's own server never touches it.
const enabled =
  process.env.TERMOTE_E2E_WORKTREES === '1' || process.env.TERMOTE_E2E_HERDR === '1'
const repo = process.env.TERMOTE_E2E_REPO ?? ''
const SOURCE = 'e2e-repo'

// The repo must be under a temporary directory (the system's or the CI
// runner's): never a developer's own checkout.
function underTemp(path: string): boolean {
  const roots = [tmpdir(), process.env.RUNNER_TEMP ?? ''].filter(Boolean)
  const real = realpathSync(path)
  return roots.some((root) => {
    const rel = relative(realpathSync(root), real)
    return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/')
  })
}

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

// With sign-in on (TERMOTE_PASS, the e2e-hc job) the page signs in on the
// server's form: Basic credentials reach the API, not the page.
const pass = process.env.TERMOTE_PASS ?? ''

async function open(page: Page) {
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.clear()
  })
  if (pass) {
    await page.goto('/login')
    await page.getByLabel('Username').fill(process.env.TERMOTE_USER || 'admin')
    await page.getByLabel('Password').fill(pass)
    await page.getByRole('button', { name: 'Sign in' }).click()
  } else {
    await page.reload()
  }
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 15000 })
}

// The group's menu: "Actions for <noun> <name>", the noun the backend's
// (workspace, tmux session)
const menuOf = (page: Page, name: string) =>
  page.getByRole('button', {
    name: new RegExp(`^Actions for .+ ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  })

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

// Switches this page to the compact sidebar, as Settings would, and reloads
async function compactSidebar(page: Page) {
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('termote-settings') ?? '{}')
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ ...saved, sidebarLayout: 'compact' }),
    )
  })
  await page.reload()
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 15000 })
}

test.describe('Worktrees from the PWA', () => {
  test.skip(
    !enabled,
    'needs TERMOTE_E2E_WORKTREES=1: a server of its own and a throwaway repo (the e2e, e2e-hc and e2e-herdr jobs)',
  )

  test.beforeEach(async ({ request }) => {
    expect(repo, 'TERMOTE_E2E_REPO').not.toBe('')
    expect(underTemp(repo), 'TERMOTE_E2E_REPO is under a temporary directory').toBe(true)
    let snap = await (await request.get('/api/mux/snapshot')).json()
    // Every job runs a backend with worktrees: a missing cap is a failure,
    // not a skip
    expect(snap.caps.worktrees, 'caps.worktrees').toBe(true)
    if (!snap.groups.some((g: { name: string }) => g.name === SOURCE)) {
      const made = await request.post('/api/mux/groups', { data: { name: SOURCE, cwd: repo } })
      expect(made.ok(), await made.text()).toBe(true)
      // The group's folder is read in the background (tmux, herdr-core)
      await expect
        .poll(async () => {
          snap = await (await request.get('/api/mux/snapshot')).json()
          return snap.groups.some((g: { name: string }) => g.name === SOURCE)
        })
        .toBe(true)
    }
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

    // The checkout was made; the new group is the one on screen
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

  test('the compact sidebar draws a worktree on one line, under its checkout', async ({
    page,
    request,
  }) => {
    await open(page)
    const branch = fresh()
    await createWorktree(page, branch)
    await compactSidebar(page)
    const snap = await (await request.get('/api/mux/snapshot')).json()
    const group = snap.groups.find(
      (g: { worktree?: { branch?: string } }) => g.worktree?.branch === branch,
    )
    const aside = page.getByRole('complementary')
    await expect(aside.getByRole('button', { name: new RegExp(`^${SOURCE}, \\d+ tabs?`) })).toBeVisible()
    // Its checkout (e2e-repo) is open: indented under it, named by its branch
    expect(group.worktree.parent, 'the worktree names its checkout').toBeTruthy()
    const row = aside.getByRole('button', { name: new RegExp(`^${branch}, \\d+ tabs?`) })
    await expect(row).toBeVisible()
    await expect(row.locator('xpath=..')).toHaveClass(/ml-3/)
    // Its tabs are in the header's bar, not under it
    await expect(page.getByRole('tablist', { name: 'Sessions' })).toBeVisible()
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

  test('Open worktree on one already open goes to its group', async ({ page, request }) => {
    await open(page)
    const branch = fresh()
    await createWorktree(page, branch)
    // The dialog shows a worktree with a group by going to that group
    const opens: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/api/mux/worktrees/open')) opens.push(r.url())
    })
    await menuOf(page, SOURCE).click()
    await page.getByRole('menuitem', { name: 'Open worktree' }).click()
    // The entry reads its branch, its folder's name and "open"
    const item = page
      .getByRole('dialog', { name: 'Open worktree' })
      .getByRole('button', { name: new RegExp(`^${branch}.* open$`) })
    await expect(item).toBeVisible({ timeout: 15000 })
    await item.click()
    await expect(sectionOf(page, branch)).toHaveCount(1)
    await expect(sectionOf(page, branch).locator('[aria-current="true"]')).toHaveCount(1)
    expect(opens).toEqual([])

    // The server answers the same: the group showing it, no new one
    const snap = await (await request.get('/api/mux/snapshot')).json()
    const source = snap.groups.find((g: { name: string }) => g.name === SOURCE)
    const shown = snap.groups.filter(
      (g: { worktree?: { branch?: string } }) => g.worktree?.branch === branch,
    )
    expect(shown).toHaveLength(1)
    const res = await request.post('/api/mux/worktrees/open', {
      data: { groupId: source.id, branch },
    })
    expect(await res.json()).toMatchObject({ ok: true, id: shown[0].id, alreadyOpen: true })
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

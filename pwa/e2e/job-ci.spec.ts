import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// A job's pull requests against the real server and the stand-in gh
// (pwa/e2e/bin/gh, first on the server's PATH in CI, answering from the
// files this spec writes in TERMOTE_E2E_GH_DIR) and the stand-in Claude
// Code (tests/fixtures/fake-claude.sh) in a throwaway repository whose
// origin is on github.com. It never reaches GitHub, and skips unless
// TERMOTE_E2E_GH=1 says the server runs with that gh.
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'
const ghDir = process.env.TERMOTE_E2E_GH_DIR ?? ''
const fakeClaude = path.resolve(
  import.meta.dirname,
  '../../tests/fixtures/fake-claude.sh',
)
const BRANCH = 'e2e-ci'
const TITLE = `CI job ${Date.now()}`

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], {
    encoding: 'utf-8',
  })

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' })

// The pull request the stand-in gh lists for the branch
function setPR(state: 'OPEN' | 'MERGED', failed: boolean) {
  const pr = {
    number: 7,
    state,
    isDraft: false,
    url: 'https://github.com/e2e/repo/pull/7',
    headRefOid: 'a'.repeat(40),
    headRepository: { name: 'repo' },
    headRepositoryOwner: { login: 'e2e' },
    createdAt: '2999-01-01T00:00:00Z',
    statusCheckRollup: [
      {
        __typename: 'CheckRun',
        name: 'lint',
        status: 'COMPLETED',
        conclusion: failed ? 'FAILURE' : 'SUCCESS',
        detailsUrl: 'https://github.com/e2e/repo/actions/runs/99/job/1',
      },
    ],
  }
  writeFileSync(path.join(ghDir, `prs-${BRANCH}.json`), JSON.stringify([pr]))
}

function transcriptText(dir: string): string {
  let out = ''
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      out += readFileSync(path.join(e.parentPath, e.name), 'utf-8')
    }
  }
  return out
}

async function openDetails(page: Page) {
  await page.goto('/#/overview')
  await expect(page.getByRole('region', { name: 'Agents' })).toBeVisible({
    timeout: 15_000,
  })
  await page.getByRole('tab', { name: /^Plan/ }).click()
  const card = page
    .getByRole('region', { name: 'Plan' })
    .getByRole('article', { name: TITLE })
  await card.getByRole('button', { name: TITLE }).click()
  const panel = page
    .getByRole('complementary', { name: TITLE })
    .or(page.getByRole('dialog', { name: TITLE }))
  await expect(panel).toBeVisible()
  return { card, panel }
}

test.describe('job pull requests', () => {
  test.skip(
    process.env.TERMOTE_E2E_GH !== '1' ||
      !ghDir ||
      !socket ||
      process.platform !== 'linux',
    'needs the stand-in gh on the server PATH (TERMOTE_E2E_GH=1, TERMOTE_E2E_GH_DIR) and TMUX_SOCKET',
  )

  let windowId = ''
  let claudeDir = ''
  let repo = ''
  let jobId = ''

  test.beforeAll(async ({ playwright }, testInfo) => {
    mkdirSync(ghDir, { recursive: true })
    claudeDir = mkdtempSync(path.join(tmpdir(), 'termote-e2e-ci-claude-'))
    repo = mkdtempSync(path.join(tmpdir(), 'termote-e2e-ci-repo-'))
    git(repo, 'init', '-q', '-b', BRANCH)
    git(repo, 'remote', 'add', 'origin', 'https://github.com/e2e/repo.git')
    setPR('OPEN', true)
    windowId = tmux(
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{window_id}',
      '-t',
      `${tmuxSession}:`,
      '-n',
      `ci-${Date.now()}`,
      '-c',
      repo,
      'env',
      `CLAUDE_CONFIG_DIR=${claudeDir}`,
      'bash',
      fakeClaude,
    ).trim()
    // Wide enough for the message on one line
    tmux('resize-window', '-t', windowId, '-x', '240', '-y', '40')
    const paneId = tmux('display-message', '-p', '-t', windowId, '#{pane_id}').trim()
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    // The server sees the stand-in's session a moment after it starts
    await expect(async () => {
      const res = await api.post('/api/mux/jobs', {
        data: { title: TITLE, pane: paneId },
      })
      expect(res.status()).toBe(201)
      jobId = (await res.json()).job.id
    }).toPass({ timeout: 20_000 })
    await api.dispose()
  })

  test.afterAll(async ({ playwright }, testInfo) => {
    try {
      if (windowId) tmux('kill-window', '-t', windowId)
    } catch {
      // Already gone
    }
    if (jobId) {
      const api = await playwright.request.newContext({
        baseURL: testInfo.project.use.baseURL,
        httpCredentials: testInfo.project.use.httpCredentials,
      })
      const list = await (await api.get('/api/mux/jobs?all=1')).json()
      const j = list.jobs.find((x: { id: string }) => x.id === jobId)
      if (j)
        await api.delete(
          `/api/mux/jobs/${jobId}?updated=${encodeURIComponent(j.updated)}`,
        )
      await api.dispose()
    }
    for (const dir of [claudeDir, repo]) {
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
    rmSync(path.join(ghDir, `prs-${BRANCH}.json`), { force: true })
  })

  test('shows the failed checks, sends them to the agent, offers done once merged', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 390, height: 844 })
    const { card, panel } = await openDetails(page)
    const section = panel.getByTestId('job-ci')
    // Read at once rather than at the poller's next turn
    await section.getByRole('button', { name: 'Check again' }).click()
    await expect(section.getByTestId('job-pr')).toContainText('checks failed', {
      timeout: 30_000,
    })
    await expect(section.getByTestId('job-pr')).toContainText('lint')
    await expect(
      section.getByRole('link', { name: 'Open pull request #7' }),
    ).toHaveAttribute('href', 'https://github.com/e2e/repo/pull/7')

    await section
      .getByRole('button', { name: 'Send the failed checks to the agent' })
      .click()
    await expect(section.getByRole('status')).toContainText(
      /Sent to the agent|reads them when it is done/,
      { timeout: 30_000 },
    )
    await expect
      .poll(() => transcriptText(claudeDir), { timeout: 20_000 })
      .toContain(
        'CI failed on PR #7: \\"lint\\". Read the failures with gh pr checks 7 and gh run view 99 --log-failed, fix them and push.',
      )

    // Every pull request merged: the card says so and the job can be done
    // A refresh within 10 s of the last read gets that read: pressed again
    // until a new one shows the merge
    setPR('MERGED', false)
    await expect(async () => {
      await section.getByRole('button', { name: 'Check again' }).click()
      await expect(
        section.getByText(/Every pull request is merged/),
      ).toBeVisible({ timeout: 3_000 })
    }).toPass({ timeout: 40_000 })
    await expect(
      card.getByRole('img', { name: 'Pull requests #7: all merged' }),
    ).toBeAttached()
    await section.getByRole('button', { name: 'Set done' }).click()
    await expect(panel.getByText('Done', { exact: true }).first()).toBeVisible()
  })
})

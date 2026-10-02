import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, type Page, test } from '@playwright/test'

// The read-only Chat view against a stand-in Codex (tests/fixtures/fake-codex.sh)
// in a window of the server's tmux, next to a window that only holds the same
// rollout open for reading, under an executable also named codex: only the
// fd's access mode tells the two apart. Like chat-view.spec.ts it needs the socket and session of the
// server under test (TMUX_SOCKET, TMUX_SESSION); Linux only, like the stand-in.
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'
const fakeCodex = path.resolve(
  import.meta.dirname,
  '../../tests/fixtures/fake-codex.sh',
)

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], {
    encoding: 'utf-8',
  })

// Rollouts under <CODEX_HOME>/sessions/YYYY/MM/DD
function findRollout(dir: string): string | undefined {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      const found = findRollout(p)
      if (found) return found
    } else if (/^rollout-.*\.jsonl$/.test(e.name)) {
      return p
    }
  }
  return undefined
}

const viewTab = (page: Page, name: string) =>
  page.getByRole('tablist', { name: 'View' }).getByRole('tab', { name })

test.describe('chat view of a Codex pane', () => {
  test.skip(
    !socket || process.platform !== 'linux',
    'needs TMUX_SOCKET of the server under test (Linux)',
  )
  test.describe.configure({ mode: 'serial' })

  let codexWindow = ''
  let readerWindow = ''
  let tmp = ''
  const windowIds: string[] = []

  const newWindow = (name: string, ...command: string[]) => {
    const id = tmux(
      'new-window',
      '-P',
      '-F',
      '#{window_id}',
      '-t',
      `${tmuxSession}:`,
      '-n',
      name,
      '-c',
      tmp,
      ...command,
    ).trim()
    windowIds.push(id)
  }

  test.beforeAll(async ({ playwright }, testInfo) => {
    // The server creates its tmux session on the first snapshot
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    expect((await api.get('/api/mux/snapshot')).ok()).toBe(true)
    await api.dispose()

    const run = Date.now()
    codexWindow = `fake-codex-${run}`
    readerWindow = `read-rollout-${run}`
    tmp = mkdtempSync(path.join(tmpdir(), 'termote-e2e-codex-'))
    const home = path.join(tmp, 'codex-home')
    mkdirSync(home)
    // termote takes a process for Codex by its executable's name
    const bin = path.join(tmp, 'bin')
    mkdirSync(bin)
    const exe = path.join(bin, 'codex')
    const which = (name: string) =>
      execFileSync('bash', ['-c', `command -v ${name}`], {
        encoding: 'utf-8',
      }).trim()
    copyFileSync(which('bash'), exe)
    execFileSync('chmod', ['+x', exe])
    newWindow(codexWindow, 'env', `CODEX_HOME=${home}`, exe, fakeCodex)

    // A process that only reads the rollout is not the Codex writing it
    let rollout: string | undefined
    await expect
      .poll(() => {
        rollout = findRollout(home)
        return rollout
      })
      .toBeTruthy()
    newWindow(
      readerWindow,
      'env',
      `CODEX_HOME=${home}`,
      exe,
      '-c',
      'exec 4<"$1"; while :; do sleep 1; done',
      'reader',
      rollout as string,
    )
  })

  test.afterAll(() => {
    for (const id of windowIds) {
      try {
        tmux('kill-window', '-t', id)
      } catch {
        // Already gone
      }
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
  })

  test('reads the conversation, without a way to write to it', async ({
    page,
  }) => {
    // The Chat view of Codex never asks for a dialog, commands, or a send
    const writes: string[] = []
    page.on('request', (r) => {
      if (/\/agent\/(prompt|commands|message|answer)/.test(r.url()))
        writes.push(r.url())
    })
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.getByRole('tab', { name: new RegExp(codexWindow) }).click()

    // Offered once the server reports Codex in the pane
    await viewTab(page, 'Chat').click({ timeout: 15000 })
    const conversation = page.getByRole('region', { name: 'Conversation' })
    await expect(conversation).toContainText('Count the files please')
    await expect(conversation.locator('strong')).toHaveText('2')
    await expect(page.getByText('Codex ·', { exact: false })).toBeVisible()

    // No composer: a bar that leads to the terminal
    await expect(page.getByText('Read only', { exact: true })).toBeVisible()
    await expect(page.getByRole('textbox', { name: /Message to/ })).toHaveCount(0)

    // A line typed in the terminal shows up in the Chat view
    await page.getByRole('button', { name: 'Open terminal' }).click()
    await expect(viewTab(page, 'Terminal')).toHaveAttribute(
      'aria-selected',
      'true',
    )
    // Typed once the stand-in shows its prompt
    await expect
      .poll(() => tmux('capture-pane', '-p', '-t', windowIds[0]))
      .toContain('›')
    await page.locator('[data-testid="terminal-view"] .xterm').click()
    await page.keyboard.type('hello from e2e')
    await page.keyboard.press('Enter')
    await viewTab(page, 'Chat').click()
    await expect(conversation).toContainText('You said: hello from e2e')

    expect(writes).toEqual([])
  })

  test('a pane that only reads the rollout has no Chat view', async ({
    page,
  }) => {
    await page.goto('/')
    await page.getByRole('tab', { name: new RegExp(codexWindow) }).click()
    // The snapshot that names Codex in its pane has been read
    await expect(viewTab(page, 'Chat')).toBeVisible({ timeout: 15000 })
    await page.getByRole('tab', { name: new RegExp(readerWindow) }).click()
    await expect(
      page.getByRole('tab', { name: new RegExp(readerWindow) }),
    ).toHaveAttribute('aria-selected', 'true')
    await expect(viewTab(page, 'Chat')).toHaveCount(0)
  })
})

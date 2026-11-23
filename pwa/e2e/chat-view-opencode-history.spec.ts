import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, type Page, test } from './fixtures'
import { FakeOpencode, fixture, fixtureList, fixtureMessages, type Json, shiftTimes } from './fake-opencode'
import {
  installOpencode,
  killWindows,
  openPane,
  skipReason,
  stateDir,
  tmux,
  tmuxSession,
  unsupported,
  waitForAgent,
} from './opencode-pane'

// The sessions of an OpenCode pane's folder against a stand-in service
// (fake-opencode.ts) with recordings of OpenCode 2.3.0: the files the
// pane's session changed (one still being written, one its subagent
// edited) and the ones an old session changed, the tokens and cost of
// each and of the folder, and the old session resumed in a new tab. The
// new tab's shell finds the stand-in TUI first on its PATH.
const LIVE = 'ses_e2eLive'
const OLD = 'ses_e2eOld'
// The subagent's id in the recording
const KID = 'ses_e20064f4dffeUwnxcB4L7CS4BE'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' })
const created = (m: Json) => (m.time as { created: number }).created

// A recording moved so its last message is at
function movedTo(msgs: Json[], at: number): Json[] {
  return shiftTimes(msgs, at - Math.max(...msgs.map(created)))
}

// A session as session.get and session.list give it
function sessionOf(id: string, dir: string, title: string, updated: number, extra: Json = {}): Json {
  const cost = fixture('session-get-cost.json').data as Json
  return {
    ...cost,
    id,
    title,
    location: { directory: dir },
    time: { created: updated - 600_000, updated, busy: updated - 60_000, idle: updated },
    ...extra,
  }
}

async function openHistory(page: Page) {
  await page.locator('body').press('Control+Shift+P')
  const input = page.getByRole('dialog').getByRole('combobox')
  await input.fill('>Session history')
  await input.press('Enter')
  return page.getByRole('dialog', { name: 'Session history' })
}

test.describe('sessions of an OpenCode pane', () => {
  test.skip(unsupported, skipReason)
  test.describe.configure({ mode: 'serial' })

  const oc = new FakeOpencode()
  let repo = ''
  let tmp = ''
  let windowName = ''
  let link = ''
  let oldCommand = ''
  // The pane's session ran today on this machine's clock
  let sameDay = true
  const windows: string[] = []

  test.beforeAll(async ({ playwright }, testInfo) => {
    testInfo.setTimeout(90_000)
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    const snap = await (await api.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps.files, 'the backend reports no pane directory')

    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'termote-e2e-opencode-bin-')))
    const { exe, shims } = installOpencode(tmp)
    repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'termote-e2e-opencode-repo-')))
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'e2e@example.com')
    git(repo, 'config', 'user.name', 'e2e')
    writeFileSync(path.join(repo, 'base.txt'), 'base\n')
    writeFileSync(path.join(repo, 'a.txt'), 'hello\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    // What the recorded tool calls left in the folder
    writeFileSync(path.join(repo, 'a.txt'), 'hello world\n')
    writeFileSync(path.join(repo, 'new.txt'), 'new\n')
    writeFileSync(path.join(repo, 'deny2.txt'), 'two\n')
    mkdirSync(path.join(repo, 'sub'))
    writeFileSync(path.join(repo, 'sub', 'b.txt'), 'b\n')
    // A change the agent did not make
    writeFileSync(path.join(repo, 'base.txt'), 'changed by hand\n')

    await oc.start(stateDir as string)
    const now = Date.now()
    sameDay = new Date(now - 180_000).toDateString() === new Date(now).toDateString()
    // The pane's session: the recorded edits and writes, a write still
    // waiting for its permission, then a request with a cost
    const live = movedTo(fixtureMessages('message-list-touched.json', repo), now - 120_000)
    const pending = live.pop() as Json
    live.push(...movedTo(fixtureMessages('message-list-assistant-cost.json'), now - 90_000), {
      ...pending,
      time: { created: now - 60_000 },
    })
    oc.messages.set(LIVE, live)
    const liveInfo = sessionOf(LIVE, repo, 'Touch the files', now - 60_000, {
      time: { created: now - 600_000, updated: now - 60_000, busy: now - 60_000 },
    })
    oc.sessions.set(LIVE, liveInfo)
    oc.active.add(LIVE)
    const recordedKid = fixtureList('session-list-touched-children.json', repo)[0]
    const kidUpdated = (recordedKid.time as { updated: number }).updated
    const kid = { ...shiftTimes(recordedKid, now - 100_000 - kidUpdated), parentID: LIVE }
    oc.sessions.set(KID, kid)
    oc.messages.set(KID, movedTo(fixtureMessages('message-list-touched-subagent.json', repo), now - 100_000))
    // An old session of the folder: a patch of a gpt- model
    const oldAt = now - 3 * 3600_000
    oc.messages.set(OLD, movedTo(fixtureMessages('message-list-patch.json', repo), oldAt))
    const oldInfo = sessionOf(OLD, repo, 'Patch the sources', oldAt, {
      cost: 1.25,
      tokens: { input: 40_000, output: 2000, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    oc.sessions.set(OLD, oldInfo)
    // Another folder's session is not listed
    const other = sessionOf('ses_e2eElsewhere', tmp, 'Elsewhere', now - 30_000)
    oc.sessions.set('ses_e2eElsewhere', other)
    oc.messages.set('ses_e2eElsewhere', [])
    oc.list = [other, liveInfo, kid, oldInfo]

    // New tabs start a bash without profile or rc files, the stand-in
    // first on its PATH
    const line = tmux('show-environment', '-g', 'PATH').trim()
    const pathNow = line.startsWith('PATH=') ? line.slice(5) : (process.env.PATH ?? '')
    oldCommand = tmux('show-options', '-gv', 'default-command').trim()
    const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
    tmux('set-option', '-g', 'default-command', `env PATH=${q(`${shims}:${pathNow}`)} bash --noprofile --norc`)

    windowName = `opencode-hist-${now}`
    windows.push(openPane(exe, windowName, repo, LIVE))
    await waitForAgent(api, windowName, 'working')
    const s = await (await api.get('/api/mux/snapshot')).json()
    const group = s.groups.find((g: { tabs: { name: string }[] }) => g.tabs.some((t) => t.name === windowName))
    const tab = group.tabs.find((t: { name: string }) => t.name === windowName)
    link = `/#/s/${encodeURIComponent(group.id)}/${encodeURIComponent(tab.id)}`
    await api.dispose()
  })

  test.afterAll(async () => {
    try {
      tmux('set-option', '-g', 'default-command', oldCommand)
    } catch {
      // The server's tmux is gone
    }
    // Every window opened in the repo: the pane's and the resumed one
    try {
      for (const w of tmux('list-windows', '-a', '-F', '#{window_id} #{pane_current_path}').split('\n')) {
        const [id, dir] = w.split(' ')
        if (id && dir === repo && !windows.includes(id)) windows.push(id)
      }
    } catch {
      // Already gone
    }
    killWindows(windows)
    await oc.stop()
    for (const dir of [repo, tmp]) {
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test('Changes lists what the session and its subagent changed', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=changes`)
    const changes = page.getByRole('complementary', { name: 'Changes' })
    const mode = changes.getByRole('radio', { name: 'Changed by this session' })
    await expect(mode).toBeVisible({ timeout: 20_000 })
    await mode.click()
    const list = changes.getByRole('region', { name: 'Files this session changed' })
    await expect(list.getByRole('button')).toHaveCount(5, { timeout: 20_000 })
    await expect(list.getByRole('button', { name: 'Modified: a.txt' })).toBeVisible()
    await expect(list.getByRole('button', { name: 'Untracked: new.txt' })).toBeVisible()
    // Edited by its subagent
    await expect(list.getByRole('button', { name: /^Untracked: b\.txt sub\/ subagent$/ })).toBeVisible()
    // A write still waiting for its permission
    await expect(list.getByRole('button', { name: /^deny3\.txt editing/ })).toBeVisible()
    // Neither a write the user declined nor a change made by hand
    await expect(list).not.toContainText('deny.txt ')
    await expect(list).not.toContainText('base.txt')

    await list.getByRole('button', { name: 'Modified: a.txt' }).click()
    await expect(changes.locator('[data-kind="add"]')).toContainText('hello world')
  })

  test("shows the tokens and cost of the session and the machine's totals", async ({ page }) => {
    await page.goto('/#/overview')
    const card = page.locator('[data-status]', {
      has: page.getByRole('button', { name: new RegExp(`, (.* / )?${windowName}$`) }),
    })
    await expect(card).toBeVisible({ timeout: 20_000 })
    // session.get's tokens and cost of the session, its subagent's apart
    await expect(card.getByTestId('session-usage')).toContainText(
      'Tokens used by this session: 5.2k tokens · <$0.01',
      { timeout: 20_000 },
    )
    await expect(card.getByTestId('session-usage')).toContainText('incl. subagents 2.8k tokens')
    // The requests of every OpenCode session, in 7 days and today (unless
    // they ran before this device's midnight), behind the header's tokens
    await page.getByRole('button', { name: /^Tokens today/ }).click({ timeout: 30_000 })
    const strip = page.getByRole('region', { name: 'Agent tokens' })
    const row = strip.locator('[data-agent="opencode"]')
    await expect(row).toContainText(/7 days \d+(\.\d)?k tokens · <\$0\.01/, { timeout: 30_000 })
    if (sameDay) await expect(row).toContainText(/Today \d+(\.\d)?k tokens · <\$0\.01/)
  })

  test('lists the folder sessions and resumes an old one in a new tab', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto(link)
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 15000 })
    const sheet = await openHistory(page)
    // The folder's root sessions, newest first; another folder's and the
    // subagent's are not listed
    const rows = sheet.locator('[data-history-id]')
    await expect(rows).toHaveCount(2, { timeout: 15000 })
    await expect(rows.nth(0)).toContainText('Touch the files')
    await expect(rows.nth(0)).toContainText('Running')
    await expect(rows.nth(1)).toContainText('Patch the sources')
    // The model of each one's last answer
    await expect(rows.nth(0)).toContainText('fake/m1')
    await expect(rows.nth(1)).toContainText('fake/gpt-5-fake')
    // The folder's totals: the old session alone is 42k tokens
    await expect(sheet.getByRole('region', { name: 'Agent tokens' }).locator('[data-agent="opencode"]')).toContainText(
      /7 days \d+(\.\d)?k tokens/,
    )

    // The old session: its conversation, tokens and cost, and the files it
    // changed
    await sheet.locator(`[data-history-id="${OLD}"]`).click()
    await expect(sheet.getByRole('region', { name: 'Conversation' })).toContainText('hello')
    await expect(sheet.getByTestId('session-usage')).toHaveText('Tokens used by this session: 42k tokens · ~$1.25')
    await sheet.getByRole('button', { name: 'Files changed' }).click()
    const files = sheet.getByRole('region', { name: 'Files this session changed' })
    await expect(files.getByRole('button', { name: /added\.txt/ })).toBeVisible({ timeout: 20_000 })
    await expect(files.getByRole('button', { name: /moved\.txt/ })).toBeVisible()
    await expect(files.getByRole('button', { name: /gone\.txt src\/ deleted/ })).toBeDisabled()

    // Resumed: the new tab runs `opencode --session <id>` in the folder,
    // and its Chat view reads that session
    const before = tmux('list-windows', '-t', `${tmuxSession}:`).split('\n').length
    await sheet.getByRole('button', { name: 'Resume in a new tab' }).click()
    await expect(sheet).toBeHidden()
    await expect
      .poll(() => tmux('list-windows', '-t', `${tmuxSession}:`).split('\n').length, { timeout: 15_000 })
      .toBeGreaterThan(before)
    const conversation = page.getByRole('region', { name: 'Conversation' })
    await expect(conversation).toContainText('Done after tool.', { timeout: 20_000 })
    await expect(page.getByRole('textbox', { name: 'Message to OpenCode' })).toBeVisible()

    // Running in that tab now: the history opens it, not a second copy
    const again = await openHistory(page)
    const row = again.locator(`[data-history-id="${OLD}"]`)
    await expect(row).toContainText('Running', { timeout: 15_000 })
    await row.click()
    await expect(again.getByRole('button', { name: 'Resume in a new tab' })).toHaveCount(0)
    await expect(again.getByRole('button', { name: 'Open the running tab' })).toBeVisible()
  })
})

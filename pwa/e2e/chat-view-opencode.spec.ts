import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, type Page, test } from './fixtures'
import {
  FakeOpencode,
  fixture,
  fixtureList,
  fixtureMessages,
  type Json,
  shiftTimes,
  withSession,
} from './fake-opencode'
import {
  installOpencode,
  killWindows,
  openPane,
  skipReason,
  stateDir,
  unsupported,
  waitForAgent,
} from './opencode-pane'

// The Chat view of an OpenCode pane against a stand-in service
// (fake-opencode.ts) with recordings of OpenCode 2.3.0: what a session
// shows (its messages, an image, a running subagent, its context), and
// what is written to it (the answer to a permission and to a form, the
// cancel of a form, a message while a turn runs, a command, a skill),
// checked on the requests the service received.
const CHAT = 'ses_e2eChat'
const KID = 'ses_e2eKid'
// The subagent's id in the recording
const RECORDED_KID = 'ses_e22caccceffe0hL76lTTiemGdN'

const viewTab = (page: Page, name: string) =>
  page.getByRole('tablist', { name: 'View' }).getByRole('tab', { name })

const created = (m: Json) => (m.time as { created: number }).created

// Recordings laid one after the other, the last a minute ago
function inSequence(groups: Json[][]): Json[] {
  const out: Json[] = []
  let at = Date.now() - 60_000 - groups.length * 20_000
  for (const g of groups) {
    at += 20_000
    const last = Math.max(...g.map(created))
    out.push(...shiftTimes(g, at - last))
  }
  return out.sort((a, b) => created(a) - created(b))
}

test.describe('chat view of an OpenCode pane', () => {
  test.skip(unsupported, skipReason)
  test.describe.configure({ mode: 'serial' })

  const oc = new FakeOpencode()
  let tmp = ''
  let windowName = ''
  const windows: string[] = []

  const open = async (page: Page) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.getByRole('tab', { name: new RegExp(windowName) }).click()
    await viewTab(page, 'Chat').click({ timeout: 15000 })
    return page.getByRole('region', { name: 'Conversation' })
  }

  test.beforeAll(async ({ playwright }, testInfo) => {
    testInfo.setTimeout(90_000)
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    expect((await api.get('/api/mux/snapshot')).ok()).toBe(true)

    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'termote-e2e-opencode-')))
    const { exe } = installOpencode(tmp)
    await oc.start(stateDir as string)

    // An image pasted, then a subagent run, then a shell command waiting
    // for permission
    const msgs = inSequence([
      fixtureMessages('message-list-image.json'),
      fixtureMessages('message-list-subagent.json'),
      fixtureMessages('message-list-permission-pending.json'),
    ]).map((m) => {
      const text = typeof m.text === 'string' ? m.text.replaceAll(RECORDED_KID, KID) : m.text
      const metadata = m.metadata as Json | undefined
      return metadata?.childID ? { ...m, text, metadata: { ...metadata, childID: KID } } : { ...m, text }
    })
    oc.messages.set(CHAT, msgs)
    const session: Json = {
      ...(fixture('session-get-cost.json').data as Json),
      id: CHAT,
      location: { directory: tmp },
      time: { created: Date.now() - 300_000, updated: Date.now() - 60_000, busy: Date.now() - 60_000 },
    }
    oc.sessions.set(CHAT, session)
    // The subagent runs still
    const kid: Json = {
      ...fixtureList('session-list-children.json')[0],
      id: KID,
      parentID: CHAT,
      outcome: undefined,
      location: { directory: tmp },
      time: { created: Date.now() - 90_000, updated: Date.now() - 80_000, busy: Date.now() - 90_000 },
    }
    oc.list = [session, kid]
    oc.sessions.set(KID, kid)
    oc.messages.set(KID, [
      { id: oc.nextId(), time: { created: Date.now() - 90_000 }, text: 'Explore the files', type: 'user' },
    ])
    oc.permissions.set(CHAT, withSession(fixtureList('permission-list.json'), CHAT))
    oc.active.add(CHAT)
    oc.active.add(KID)

    windowName = `opencode-${Date.now()}`
    windows.push(openPane(exe, windowName, tmp, CHAT))
    await waitForAgent(api, windowName, 'blocked')
    await api.dispose()
  })

  test.afterAll(async () => {
    killWindows(windows)
    await oc.stop()
    if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
  })

  test('shows the session, its image and subagent, and answers its permission once', async ({ page }) => {
    const conversation = await open(page)
    // The sidebar names the agent and its state
    const row = page
      .getByRole('complementary')
      .getByRole('button', { name: new RegExp(`^${windowName} opencode`) })
    await expect(row.getByRole('img', { name: 'Agent blocked' })).toBeVisible()
    await expect(page.locator('header').getByText('OpenCode', { exact: true })).toBeVisible()

    await expect(conversation).toContainText('look at this')
    await expect(conversation).toContainText('Done after tool.')
    await expect(conversation).toContainText('PERM please')
    // The context the last request filled, of the model's window
    await expect(page.getByRole('button', { name: /^Agent usage: context \d+%/ })).toBeVisible()

    // The pasted image opens from its chip, read from the service then
    await conversation.getByRole('button', { name: '[image]' }).click()
    const viewer = page.getByRole('dialog').filter({ has: page.locator('img') })
    await expect
      .poll(() => viewer.locator('img').first().evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)
    expect(oc.requests.some((r) => r.method === 'GET' && /^\/api\/session\/ses_e2eChat\/message\/msg_/.test(r.path))).toBe(
      true,
    )
    await page.keyboard.press('Escape')
    await expect(viewer).toBeHidden()

    // The subagent still running shows under the conversation
    await expect(page.getByRole('status').filter({ hasText: '1 subagent running' })).toBeVisible({
      timeout: 15000,
    })
    const subagents = page.getByRole('list', { name: 'Subagents' })
    await expect(subagents).toContainText(/explore\s*· running/)
    await expect(subagents).toContainText('Explore files')

    // The permission card, worded in the app's language
    const card = page.getByRole('alertdialog', { name: 'Allow shell?' })
    await expect(card).toContainText('touch spike-file.txt')
    await card.getByRole('button', { name: /^1\.\s*Yes, once$/ }).click()
    await expect(card).toBeHidden()
    const replies = oc.writes('/reply')
    expect(replies).toHaveLength(1)
    expect(replies[0].path).toMatch(/^\/api\/session\/ses_e2eChat\/permission\/per_\w+\/reply$/)
    expect(JSON.parse(replies[0].body)).toEqual({ decision: 'once' })
    await expect(row.getByRole('img', { name: 'Agent working' })).toBeVisible({ timeout: 15000 })
  })

  test('answers a form of two questions, and cancels one', async ({ page }) => {
    oc.active.delete(KID)
    oc.forms.set(CHAT, withSession(fixtureList('form-list-question-multi.json'), CHAT))
    await open(page)
    const card = page.getByRole('alertdialog', { name: 'Questions' })
    await expect(card).toBeVisible({ timeout: 15000 })
    // One choice of a question, and two of the next, one typed
    await card.getByRole('radio', { name: 'Blue cool' }).check()
    const sizes = card.getByRole('group', { name: /^Sizes/ })
    await sizes.getByRole('checkbox', { name: 'S small' }).check()
    await sizes.getByRole('textbox', { name: 'Other answer' }).fill('XL')
    await sizes.getByRole('button', { name: 'Add' }).click()
    await card.getByRole('button', { name: 'Send' }).click()
    await expect(card).toBeHidden()
    const answers = oc.writes('/reply').filter((r) => r.path.includes('/form/'))
    expect(answers).toHaveLength(1)
    expect(answers[0].path).toMatch(/^\/api\/session\/ses_e2eChat\/form\/frm_\w+\/reply$/)
    expect(JSON.parse(answers[0].body)).toEqual({ answer: { q0: 'Blue', q1: ['S', 'XL'] } })

    // A form cancelled is deleted
    oc.forms.set(CHAT, withSession(fixtureList('form-list.json'), CHAT))
    const next = page.getByRole('alertdialog', { name: 'Questions' })
    await expect(next.getByRole('radio', { name: 'Red warm' })).toBeVisible({ timeout: 15000 })
    await expect(next.getByRole('group', { name: /^Sizes/ })).toHaveCount(0)
    await next.getByRole('button', { name: 'Cancel' }).click()
    await expect(next).toBeHidden()
    const deletes = oc.requests.filter((r) => r.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(deletes[0].path).toMatch(/^\/api\/session\/ses_e2eChat\/form\/frm_\w+$/)
  })

  test('shows a retry while a turn runs, and queues a message sent then', async ({ page }) => {
    // A turn the provider refused, OpenCode trying it again
    oc.messages.get(CHAT)?.push(...inSequence([fixtureMessages('message-list-retry.json')]))
    const conversation = await open(page)
    await expect(conversation).toContainText('FAIL please')
    const working = page.getByRole('status').filter({ hasText: /Retrying \(attempt 4\)/ })
    await expect(working).toContainText("Rate limited: you've used today's free messages")

    const composer = page.getByRole('textbox', { name: 'Message to OpenCode' })
    const send = page.getByRole('button', { name: 'Send', exact: true })
    await composer.fill('after this one')
    const sent = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/agent\/message$/.test(new URL(r.url()).pathname),
    )
    await send.click()
    // Taken into OpenCode's queue: answered 202
    expect((await sent).status()).toBe(202)
    await expect(page.locator('span', { hasText: 'Queued: OpenCode reads it when it is ready.' })).toBeVisible()
    const prompts = oc.writes('/prompt')
    expect(prompts).toHaveLength(1)
    expect(JSON.parse(prompts[0].body)).toEqual({ text: 'after this one', delivery: 'queue' })

    // The turn ends; a message then gets its answer
    oc.settle(CHAT)
    oc.messages.get(CHAT)?.push(oc.answer('Gave up.'))
    await expect(conversation).toContainText('Gave up.', { timeout: 15000 })
    await expect(working).toHaveCount(0)
    await composer.fill('hello from e2e')
    await send.click()
    await expect(conversation).toContainText('You said: hello from e2e')
  })

  test('runs a command after "/" and attaches a skill after "@"', async ({ page }) => {
    const conversation = await open(page)
    const composer = page.getByRole('textbox', { name: 'Message to OpenCode' })
    const send = page.getByRole('button', { name: 'Send', exact: true })

    // "/" lists the service's commands for the session's folder
    await composer.fill('/spike')
    const commands = page.getByRole('listbox', { name: 'Commands' })
    const command = commands.getByRole('option', { name: /\/spike-cmd/ })
    await expect(command).toContainText('A spike command')
    const listed = oc.requests.filter((r) => r.path === '/api/command')
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.every((r) => r.query.get('location[directory]') === tmp)).toBe(true)
    await command.click()
    await composer.press('End')
    await composer.pressSequentially('now')
    await send.click()
    await expect(conversation).toContainText('Ran /spike-cmd')
    const ran = oc.writes('/command')
    expect(ran).toHaveLength(1)
    expect(JSON.parse(ran[0].body)).toEqual({ name: 'spike-cmd', text: 'now', delivery: 'queue' })

    // "@" lists its skills; a pick goes with the message
    await composer.fill('use @user')
    const skills = page.getByRole('listbox', { name: 'Skills' })
    const skill = skills.getByRole('option', { name: /@user-skill/ })
    await expect(skill).toContainText('A user skill')
    await skill.click()
    await expect(composer).toHaveValue('use @user-skill ')
    await composer.pressSequentially('please')
    await send.click()
    await expect(conversation).toContainText('You said: use @user-skill please')
    const prompt = oc.writes('/prompt').at(-1)
    expect(JSON.parse(prompt?.body ?? '{}')).toMatchObject({
      text: 'use @user-skill please',
      skills: [{ id: 'user-skill', mention: { start: 4, end: 15, text: '@user-skill' } }],
    })
  })
})

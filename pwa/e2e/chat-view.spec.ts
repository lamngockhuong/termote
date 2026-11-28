import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'

// A 1x1 PNG, attached in the composer.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

// The Chat view against a stand-in Claude Code (tests/fixtures/fake-claude.sh)
// running in a window of the server's tmux. It needs the socket and session
// the server under test uses (TMUX_SOCKET, TMUX_SESSION), so it never opens
// a window in someone's own tmux; Linux only, like the stand-in.
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

test.describe('chat view', () => {
  test.skip(
    !socket || process.platform !== 'linux',
    'needs TMUX_SOCKET of the server under test (Linux)',
  )
  test.describe.configure({ mode: 'serial' })

  // A name of its own per run, so the tab to pick is never ambiguous
  let windowName = ''
  let claudeDir = ''
  let cwd = ''
  let windowId = ''

  test.beforeAll(async ({ playwright }, testInfo) => {
    // The server creates its tmux session on the first snapshot; before that
    // the socket has no server to open a window in.
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    expect((await api.get('/api/mux/snapshot')).ok()).toBe(true)
    await api.dispose()

    windowName = `fake-claude-${Date.now()}`
    claudeDir = mkdtempSync(path.join(tmpdir(), 'termote-e2e-claude-'))
    cwd = mkdtempSync(path.join(tmpdir(), 'termote-e2e-cwd-'))
    // A project command and a user skill for the composer's suggestions
    mkdirSync(path.join(cwd, '.claude/commands/e2e'), { recursive: true })
    writeFileSync(
      path.join(cwd, '.claude/commands/e2e/deploy.md'),
      '---\ndescription: Deploy from e2e\n---\nNever shown',
    )
    mkdirSync(path.join(claudeDir, 'skills/e2e-helper'), { recursive: true })
    writeFileSync(
      path.join(claudeDir, 'skills/e2e-helper/SKILL.md'),
      '---\ndescription: Helps in e2e\n---\n',
    )
    windowId = tmux(
      'new-window',
      '-P',
      '-F',
      '#{window_id}',
      '-t',
      `${tmuxSession}:`,
      '-n',
      windowName,
      '-c',
      cwd,
      'env',
      `CLAUDE_CONFIG_DIR=${claudeDir}`,
      'bash',
      fakeClaude,
    ).trim()
  })

  test.afterAll(() => {
    try {
      if (windowId) tmux('kill-window', '-t', windowId)
    } catch {
      // Already gone
    }
    // The stand-in writes its session file once more as it exits
    for (const dir of [claudeDir, cwd]) {
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test('reads, sends and answers through the Chat view', async ({ page }) => {
    // One conversation through every kind of dialog: longer than the default.
    // It takes 40-50 s on a dev machine, so a slower CI runner ran past 60 s
    test.setTimeout(120000)
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.getByRole('tab', { name: new RegExp(windowName) }).click()

    // The switcher is offered once the server reports Claude Code in the pane
    const chatTab = page
      .getByRole('tablist', { name: 'View' })
      .getByRole('tab', { name: 'Chat' })
    await chatTab.click({ timeout: 15000 })

    // History from the transcript, markdown rendered
    const conversation = page.getByRole('region', { name: 'Conversation' })
    await expect(conversation).toContainText('Fix the build please')
    await expect(conversation.locator('strong')).toHaveText('fixed')

    // A Mermaid block is drawn as its image, opens full screen and saves
    // under a chat name; other code is framed with its language
    const block = conversation.getByTestId('mermaid-block')
    const img = block.locator('img[src^="data:image/svg+xml"]')
    await expect(img).toHaveAttribute('alt', 'Mermaid diagram 1', { timeout: 15000 })
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    const sh = conversation.getByTestId('fenced-code').filter({ hasText: 'npm test' })
    await expect(sh).toContainText('sh')
    await expect(sh.locator('code span[style*="color"]').first()).toBeVisible()
    const download = page.waitForEvent('download')
    await block.getByRole('button', { name: 'Download diagram as SVG' }).click()
    expect((await download).suggestedFilename()).toBe('chat-mermaid-1.svg')
    await block.getByRole('button', { name: 'Open Mermaid diagram 1 full screen' }).click()
    const viewer = page.getByRole('dialog', { name: 'Mermaid diagram 1' })
    await expect(viewer.getByRole('button', { name: 'Download diagram as SVG' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(viewer).toBeHidden()

    // A message of two lines arrives as one turn
    const composer = page.getByRole('textbox', {
      name: 'Message to Claude Code',
    })
    const send = page.getByRole('button', { name: 'Send', exact: true })
    await composer.fill('hello from e2e\nsecond line')
    await send.click()
    await expect(conversation).toContainText('You said: hello from e2e')
    await expect(conversation).toContainText('second line')

    // While a turn runs, the agent's working line shows under the
    // conversation, and goes with the answer
    await composer.fill('think slow please')
    await send.click()
    const working = page.getByRole('status').filter({ hasText: 'Incubating… Thinking' })
    await expect(working).toBeAttached()
    await expect(conversation.getByText('Incubating…', { exact: true })).toBeVisible()
    // The stand-in works 5s, then the transcript is read within 2s
    await expect(conversation).toContainText('Done thinking.', { timeout: 15_000 })
    await expect(working).toHaveCount(0)

    // An image attached in the composer goes where the caret is, as its
    // token in the text, and reaches the agent there as the agent's own
    // token; the transcript shows the image part
    await composer.fill('what is in it?')
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Attach image' }).click()
    await (await chooser).setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: PNG })
    await expect(page.getByRole('img', { name: 'Attachment 1, ready' })).toBeVisible()
    await expect(composer).toHaveValue('what is in it? [Image #1]')
    await send.click()
    await expect(conversation).toContainText('You said: what is in it? [Image #1] (images: 1)')
    await expect(conversation).toContainText('[image #1]')
    await expect(page.getByRole('list', { name: 'Attached images' })).toBeHidden()

    // A permission dialog becomes a card whose buttons answer it
    await composer.fill('ask permission please')
    await send.click()
    const card = page.getByRole('alertdialog', { name: 'Bash command' })
    await expect(card).toBeVisible()
    await card.getByRole('button', { name: /^1\.\s*Yes$/ }).click()
    await expect(conversation).toContainText('Created scratch-one.txt.')
    await expect(card).toBeHidden()

    // A wizard of single-choice questions is answered one card per tab
    await composer.fill('place an order')
    await send.click()
    const size = page.getByRole('alertdialog', { name: 'What size do you want?' })
    await expect(
      size.getByRole('list', { name: 'Questions' }).locator('[aria-current="step"]'),
    ).toHaveText('Size')
    await size.getByRole('button', { name: /^1\.\s*Small/ }).click()
    const drink = page.getByRole('alertdialog', { name: 'Which drink do you prefer?' })
    await expect(drink.getByRole('list', { name: 'Questions' })).toContainText('Size (answered)')
    await drink.getByRole('button', { name: /^2\.\s*Coffee/ }).click()
    const review = page.getByRole('alertdialog', { name: 'Review your answers' })
    await expect(review).toContainText('Ready to submit your answers?')
    await review.getByRole('button', { name: /^1\.\s*Submit answers/ }).click()
    await expect(conversation).toContainText('Ordered: a small coffee.')
    await expect(review).toBeHidden()

    // Tabs are reached from the steps; a multiSelect tab toggles and moves on
    await composer.fill('choose extras')
    await send.click()
    const sizeTab = page.getByRole('alertdialog', { name: 'What size would you prefer?' })
    await sizeTab
      .getByRole('list', { name: 'Questions' })
      .getByRole('button', { name: 'Extras' })
      .click()
    const extras = page.getByRole('alertdialog', { name: 'Which extras would you like?' })
    const milk = extras.getByRole('button', { name: /^2\.\s*Milk/ })
    await expect(milk).toHaveAttribute('aria-pressed', 'false')
    await milk.click()
    await expect(milk).toHaveAttribute('aria-pressed', 'true')
    await extras.getByRole('button', { name: 'Next', exact: true }).click()
    const drinkTab = page.getByRole('alertdialog', { name: 'What would you like to drink?' })
    await expect(drinkTab.getByRole('list', { name: 'Questions' })).toContainText('Extras (answered)')
    await drinkTab
      .getByRole('list', { name: 'Questions' })
      .getByRole('button', { name: 'Submit' })
      .click()
    const partial = page.getByRole('alertdialog', { name: 'Review your answers' })
    await expect(partial).toContainText('You have not answered all questions')
    await partial.getByRole('button', { name: /^1\.\s*Submit answers/ }).click()
    await expect(conversation).toContainText('Ordered extras: milk.')

    // Options with previews: one tap moves the pointer and picks the option
    await composer.fill('pick a layout')
    await send.click()
    const layout = page.getByRole('alertdialog', { name: 'Layout' })
    await layout.getByRole('button', { name: /^2\.\s*Row$/ }).click()
    await expect(conversation).toContainText('Layout: Row.')
    await expect(layout).toBeHidden()

    // An answer of one's own, typed into the question's free-text option
    await composer.fill('pick a color')
    await send.click()
    const color = page.getByRole('alertdialog', { name: 'Color Theme' })
    await color.getByRole('button', { name: /^4\.\s*Other…$/ }).click()
    await color.getByRole('textbox', { name: 'Your answer' }).fill('Tím nhạt')
    await color.getByRole('button', { name: 'Send' }).click()
    await expect(conversation).toContainText('Theme: Tím nhạt.')
    await expect(color).toBeHidden()

    // "/" suggests the built-ins and the project's and user's commands; a
    // pick is typed in for its arguments, never sent on its own
    await composer.fill('/e2e')
    const commands = page.getByRole('listbox', { name: 'Commands' })
    const deploy = commands.getByRole('option', { name: /\/e2e:deploy/ })
    await expect(deploy).toContainText('Deploy from e2e')
    await expect(deploy).toContainText('project')
    await expect(commands.getByRole('option', { name: /\/e2e-helper/ })).toContainText('skill')
    await expect(commands).not.toContainText('Never shown')
    await deploy.click()
    await expect(composer).toHaveValue('/e2e:deploy ')
    await expect(commands).toBeHidden()
    await composer.press('End')
    await composer.pressSequentially('now')
    await send.click()
    await expect(conversation).toContainText('You said: /e2e:deploy now')

    // /exit is confirmed first
    await composer.fill('/exi')
    await composer.press('Enter')
    const confirmExit = page.getByRole('dialog', { name: 'Exit Claude Code?' })
    await expect(confirmExit).toBeVisible()
    await confirmExit.getByRole('button', { name: 'Cancel' }).click()
    await expect(confirmExit).toBeHidden()

    // A command that opens an interactive screen is sent, then the terminal shows
    await composer.fill('/mode')
    await expect(commands.getByRole('option').first()).toContainText('opens in Terminal')
    await composer.press('Enter')
    await expect(
      page
        .getByRole('tablist', { name: 'View' })
        .getByRole('tab', { name: 'Terminal' }),
    ).toHaveAttribute('aria-selected', 'true')
    await chatTab.click()
    await expect(conversation).toContainText('You said: /model')

    // A single multiSelect question has toggles too, and the way to the terminal
    await composer.fill('pick toppings')
    await send.click()
    const question = page.getByRole('alertdialog', { name: 'Which toppings do you want?' })
    await expect(question.getByRole('button', { name: /^1\.\s*Cheese/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await question.getByRole('button', { name: 'Open terminal' }).click()
    await expect(
      page
        .getByRole('tablist', { name: 'View' })
        .getByRole('tab', { name: 'Terminal' }),
    ).toHaveAttribute('aria-selected', 'true')
  })
})

// Quoting text selected in the conversation into the composer, against a
// stand-in of its own: "questions" makes it run a five-line command (folded
// to three) and ask two numbered questions, then one more. Chromium only
// (playwright.config.ts): iOS Safari and Android Chrome are checked by hand.
test.describe('chat view quotes', () => {
  test.skip(
    !socket || process.platform !== 'linux',
    'needs TMUX_SOCKET of the server under test (Linux)',
  )
  test.describe.configure({ mode: 'serial' })

  let windowId = ''
  let link = ''
  const dirs: string[] = []

  test.beforeAll(async ({ playwright }, testInfo) => {
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    expect((await api.get('/api/mux/snapshot')).ok()).toBe(true)
    const name = `fake-claude-quote-${Date.now()}`
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

  const quoteButton = (page: Page) => page.getByRole('button', { name: 'Quote selected text' })
  const composerOf = (page: Page) => page.getByRole('textbox', { name: 'Message to Claude Code' })

  // Drags the mouse over el, from its first character to its end
  async function drag(page: Page, el: Locator) {
    const box = await el.boundingBox()
    if (!box) throw new Error('not on screen')
    await page.mouse.move(box.x + 1, box.y + 4)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 1, box.y + box.height - 4, { steps: 8 })
    await page.mouse.up()
  }

  test('quotes the questions selected, each in turn, the caret under each', async ({ page }) => {
    await page.goto(link)
    const conversation = page.getByRole('region', { name: 'Conversation' })
    await expect(conversation).toContainText('Fix the build please', { timeout: 15000 })
    // Nothing selected: no button
    await expect(quoteButton(page)).toHaveCount(0)

    const composer = composerOf(page)
    await composer.fill('questions')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const list = conversation.locator('ol').filter({ hasText: 'Which port' })
    await expect(list).toBeVisible()
    await expect(conversation).toContainText('Should the logs be kept?')

    await drag(page, list)
    await quoteButton(page).click()
    await expect(composer).toHaveValue('> 1. Which port should it listen on?\n> 2. Which user runs it?\n\n')
    await expect(composer).toBeFocused()
    expect(await composer.evaluate((el: HTMLTextAreaElement) => el.selectionStart === el.value.length)).toBe(true)
    await expect(quoteButton(page)).toHaveCount(0)

    await page.keyboard.type('7680')
    await drag(page, conversation.getByText('Should the logs be kept?'))
    await quoteButton(page).click()
    await expect(composer).toHaveValue(
      '> 1. Which port should it listen on?\n> 2. Which user runs it?\n\n7680\n\n> Should the logs be kept?\n\n',
    )
    await composer.fill('')
  })

  test('a folded command gives only the lines it shows', async ({ page }) => {
    await page.goto(link)
    const conversation = page.getByRole('region', { name: 'Conversation' })
    await expect(conversation).toContainText('Should the logs be kept?', { timeout: 15000 })
    // The run of the "questions" command, then its line, opened (a run seen
    // working is open already)
    const command = conversation.locator('pre').filter({ hasText: 'echo hidden-five' })
    const run = conversation.getByRole('button', { name: /^Worked.* · 1 command$/ }).last()
    if ((await run.getAttribute('aria-expanded')) === 'false') await run.click()
    const line = conversation.getByRole('button', { name: 'Print five lines' }).last()
    if ((await line.getAttribute('aria-expanded')) === 'false') await line.click()
    await expect(command).toBeVisible()
    await expect(conversation.getByText('Show all 5 lines')).toBeVisible()
    // From the command to the end of the questions
    await page.evaluate(() => {
      const pres = [...document.querySelectorAll('pre')]
      const pre = pres.find((p) => p.textContent?.includes('echo hidden-five')) as HTMLElement
      const ol = [...document.querySelectorAll('ol')].find((o) => o.textContent?.includes('Which port')) as HTMLElement
      const r = document.createRange()
      r.setStart(pre, 0)
      r.setEnd(ol, ol.childNodes.length)
      const sel = document.getSelection() as Selection
      sel.removeAllRanges()
      sel.addRange(r)
    })
    await quoteButton(page).click()
    const value = await composerOf(page).inputValue()
    expect(value).toContain('> echo one\n> echo two\n> echo three\n> …\n')
    expect(value).toContain('> 2. Which user runs it?')
    expect(value).not.toContain('hidden-five')
    expect(value).not.toContain('echo four')
    expect(value).not.toContain('Show all')
    await composerOf(page).fill('')
  })

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

    test('a tap quotes the selection kept after the page lost it', async ({ page }) => {
      await page.goto(link)
      const conversation = page.getByRole('region', { name: 'Conversation' })
      const asked = conversation.getByText('Should the logs be kept?')
      await expect(asked).toBeVisible({ timeout: 15000 })
      await asked.selectText()
      await expect(quoteButton(page)).toBeVisible()
      // A tap on a phone can drop the selection before the button's click
      await page.evaluate(() => document.getSelection()?.removeAllRanges())
      await quoteButton(page).tap()
      await expect(composerOf(page)).toHaveValue('> Should the logs be kept?\n\n')
      await expect(quoteButton(page)).toHaveCount(0)
      // A touch in the conversation forgets a selection
      await asked.selectText()
      await expect(quoteButton(page)).toBeVisible()
      await conversation.tap({ position: { x: 5, y: 5 } })
      await expect(quoteButton(page)).toHaveCount(0)
    })
  })
})

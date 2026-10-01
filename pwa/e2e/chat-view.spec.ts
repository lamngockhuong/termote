import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'

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
    // One conversation through every kind of dialog: longer than the default
    test.setTimeout(60000)
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

    // A message of two lines arrives as one turn
    const composer = page.getByRole('textbox', {
      name: 'Message to Claude Code',
    })
    const send = page.getByRole('button', { name: 'Send', exact: true })
    await composer.fill('hello from e2e\nsecond line')
    await send.click()
    await expect(conversation).toContainText('You said: hello from e2e')
    await expect(conversation).toContainText('second line')

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

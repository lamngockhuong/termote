import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, type Page, test } from './fixtures'
import { docx, p, workbook } from './fixtures/docs/office'

// The roadmap's acceptance: one working day on one project, desktop, no
// other editor. Open → search → edit with highlighting → review the agent's diff
// (keep/drop hunks, comment, send) → commit and push from the terminal → run
// the tests, send the failure, rerun → read PDF/xlsx/docx/Shift-JIS specs →
// a Place outside the pane → a prompt template into the agent's draft.
// Nothing is intercepted: the agent is tests/fixtures/fake-claude.sh and what
// it received is read from its transcript.
const tag = `${Date.now()}`
const socket = process.env.TMUX_SOCKET as string
const tmuxSession = process.env.TMUX_SESSION || 'main'
const placeDir = process.env.TERMOTE_E2E_PLACES as string
const fakeClaude = path.resolve(import.meta.dirname, '../../tests/fixtures/fake-claude.sh')
const docs = path.resolve(import.meta.dirname, 'fixtures/docs')

const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf-8' })
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' })

const CALC_COMMITTED = `export function add(a, b) {
  return a + b
}

export function sub(a, b) {
  return a - b
}

export function mul(a, b) {
  return a * b
}

export function div(a, b) {
  return a / b
}

export function mod(a, b) {
  return a % b
}
`
// The agent's edit: a good hunk (add takes numbers only) and a bad one (mul
// doubles its result)
const CALC_AGENT = CALC_COMMITTED.replace('  return a + b\n', '  // numbers only\n  return Number(a) + Number(b)\n').replace(
  '  return a * b\n',
  '  return a * b * 2\n',
)

async function typeInEditor(box: Locator, text: string) {
  await box.click()
  await box.page().keyboard.press('ControlOrMeta+A')
  await box.page().keyboard.insertText(text)
}

const files = (page: Page) => page.getByRole('complementary', { name: 'Files' })
const changes = (page: Page) => page.getByRole('complementary', { name: 'Changes' })

// Every user turn the fake agent recorded
function agentInbox(claudeDir: string): string {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) walk(f)
      else if (f.endsWith('.jsonl')) out.push(readFileSync(f, 'utf-8'))
    }
  }
  walk(path.join(claudeDir, 'projects'))
  return out.join('\n')
}

test.describe('acceptance: a working day without another editor', () => {
  test.skip(!socket || !placeDir, 'needs TMUX_SOCKET and TERMOTE_E2E_PLACES')
  test.skip(process.platform !== 'linux', 'the fake agent reads /proc (Linux)')
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  let repo = ''
  let remote = ''
  let claudeDir = ''
  let link = ''
  const windows: string[] = []
  const repoWindow = `acc-repo-${tag}`
  const agentWindow = `acc-agent-${tag}`

  test.beforeAll(async ({ request }) => {
    const snap = await (await request.get('/api/mux/snapshot')).json()
    expect(snap.caps.files).toBe(true)
    expect(snap.caps.tasks).toBe(true)
    expect(snap.caps.agentChat).toBe(true)
    expect(snap.caps.places).toBe(true)

    remote = mkdtempSync(path.join(tmpdir(), 'termote-acc-remote-'))
    git(remote, 'init', '-q', '--bare', '-b', 'main')
    repo = mkdtempSync(path.join(tmpdir(), 'termote-acc-repo-'))
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'acc@example.com')
    git(repo, 'config', 'user.name', 'acc')
    git(repo, 'remote', 'add', 'origin', remote)
    mkdirSync(path.join(repo, 'src'))
    mkdirSync(path.join(repo, 'docs'))
    writeFileSync(path.join(repo, 'src/calc.js'), CALC_COMMITTED)
    writeFileSync(
      path.join(repo, 'src/format.js'),
      `// TODO-ACCEPT-${tag}: round to cents\nexport function money(n) {\n  return '$' + n\n}\n`,
    )
    writeFileSync(
      path.join(repo, 'test.mjs'),
      `import assert from 'node:assert'\nimport { add, mul } from './src/calc.js'\nassert.equal(add(2, 3), 5)\nassert.equal(mul(2, 3), 6, 'mul-${tag} is wrong')\nconsole.log('all green')\n`,
    )
    writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ type: 'module', scripts: { test: 'node test.mjs' } }, null, 2),
    )
    writeFileSync(path.join(repo, 'README.md'), `# Calc\n\nNotes for TODO-ACCEPT-${tag}.\n`)
    copyFileSync(path.join(docs, 'pages.pdf'), path.join(repo, 'docs/spec.pdf'))
    writeFileSync(path.join(repo, 'docs/cases.xlsx'), Buffer.from(workbook()))
    writeFileSync(
      path.join(repo, 'docs/memo.docx'),
      Buffer.from(docx(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Release memo</w:t></w:r></w:p>${p('Ship on Friday')}`)),
    )
    // 仕様書です in Shift-JIS (kana in it: kanji alone is never guessed)
    writeFileSync(
      path.join(repo, 'docs/legacy.txt'),
      Buffer.from([0x8e, 0x64, 0x97, 0x6c, 0x8f, 0x91, 0x82, 0xc5, 0x82, 0xb7, 0x0a]),
    )
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    git(repo, 'push', '-q', 'origin', 'main')
    // The agent has been at work
    writeFileSync(path.join(repo, 'src/calc.js'), CALC_AGENT)

    writeFileSync(path.join(placeDir, 'meeting.md'), '# Meeting notes\n\nAsk BrSE about TC-001.\n')

    claudeDir = mkdtempSync(path.join(tmpdir(), 'termote-acc-claude-'))
    windows.push(
      tmux('new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', repoWindow, '-c', repo, 'bash').trim(),
      tmux(
        'new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', agentWindow, '-c', repo,
        'env', `CLAUDE_CONFIG_DIR=${claudeDir}`, 'bash', fakeClaude,
      ).trim(),
    )
    // The size a desktop browser gives a pane: the fake agent lets the
    // terminal wrap a long line (Claude Code indents its own wraps), which
    // the input-box reader cannot follow in 80 columns
    tmux('resize-window', '-t', windows[1], '-x', '220', '-y', '50')
    await expect(async () => {
      const s = await (await request.get('/api/mux/snapshot')).json()
      const tabs = s.groups.flatMap((g: { id: string; tabs: { id: string; name: string; panes: { agent?: unknown }[] }[] }) =>
        g.tabs.map((t) => ({ ...t, group: g.id })),
      )
      const r = tabs.find((t: { name: string }) => t.name === repoWindow)
      const a = tabs.find((t: { name: string }) => t.name === agentWindow)
      expect(r).toBeDefined()
      expect(a?.panes[0].agent).toBeDefined()
      link = `/#/s/${encodeURIComponent(r.group)}/${encodeURIComponent(r.id)}`
    }).toPass({ timeout: 30_000 })
  })

  test.afterAll(async ({ request }) => {
    // Each window on its own: one gone already leaves the rest to close
    let lines: string[] = []
    try {
      lines = tmux('list-windows', '-a', '-F', '#{window_id} #{pane_current_path}').split('\n')
    } catch {
      // The server's tmux is gone
    }
    for (const line of lines) {
      const [id, dir] = line.split(' ')
      if (!id || !(windows.includes(id) || dir === repo)) continue
      try {
        tmux('kill-window', '-t', id)
      } catch {
        // Already gone
      }
    }
    for (const d of [repo, remote, claudeDir]) if (d) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
    rmSync(path.join(placeDir, 'meeting.md'), { force: true })
    const res = await request.get('/api/mux/templates')
    const { templates } = (await res.json()) as { templates: { id: string; name: string; updated: string }[] }
    for (const t of templates.filter((t) => t.name.includes(tag))) {
      const del = await request.delete(`/api/mux/templates/${t.id}?updated=${encodeURIComponent(t.updated)}`, {
        headers: { 'Content-Type': 'application/json' },
      })
      expect(del.status(), `delete ${t.name}: ${await del.text()}`).toBe(200)
    }
  })

  test.beforeEach(async ({ page }) => {
    // A desktop user who widened the side panel once (Markdown sits beside
    // its preview from 768px of the viewer)
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.addInitScript(() => {
      if (!localStorage.getItem('termote-settings'))
        localStorage.setItem('termote-settings', JSON.stringify({ sidePanelWidth: 1000, hasSeenGestureHints: true }))
    })
    tmux('select-window', '-t', windows[0])
  })

  test('1. open the project, quick-open a file, search a string across the repo', async ({ page }) => {
    await page.goto(`${link}?view=files`)
    await expect(files(page).getByRole('treeitem', { name: 'src' })).toBeVisible()

    // Quick open from outside the terminal
    await page.getByRole('button', { name: 'Command palette' }).focus()
    await page.keyboard.press('Control+P')
    const palette = page.getByRole('dialog', { name: /palette|Go to file/i })
    await expect(palette).toBeVisible()
    await page.keyboard.type('format')
    await expect(palette.getByRole('option', { name: /^format\.js/ })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(files(page).getByTestId('code-block')).toContainText('export function money')

    // Search across the repo
    await files(page).getByRole('button', { name: 'Back to files' }).click()
    await files(page).getByRole('radio', { name: 'Search' }).click()
    await files(page).getByRole('searchbox', { name: 'Search file contents' }).fill(`TODO-ACCEPT-${tag}`)
    await expect(files(page).getByText('2 lines in 2 files')).toBeVisible()
    const results = files(page).getByRole('list', { name: 'Search results' })
    await results.getByRole('button', { name: /^1\s*\/\/ TODO-ACCEPT/ }).click()
    await expect(files(page).getByTestId('code-block').locator('[data-line="1"]')).toHaveClass(/bg-accent/)
  })

  test('2. edit a file with highlighting, and Markdown beside its preview', async ({ page }) => {
    await page.goto(`${link}?view=files`)
    await files(page).getByRole('treeitem', { name: 'src' }).click()
    await files(page).getByRole('treeitem', { name: 'format.js' }).click()
    await files(page).getByRole('button', { name: 'Edit', exact: true }).click()
    const box = files(page).getByRole('textbox', { name: 'Text of src/format.js' })
    await expect(box.locator('.cm-line').first()).toBeVisible()
    await typeInEditor(box, "export function money(n) {\n  return '$' + n.toFixed(2)\n}\n")
    // Syntax highlighting in the editor: tokens carry their own class
    await expect(box.locator('.cm-line span[class]').first()).toBeVisible()
    await page.keyboard.press('ControlOrMeta+s')
    await expect(box).toHaveCount(0)
    expect(readFileSync(path.join(repo, 'src/format.js'), 'utf-8')).toContain('n.toFixed(2)')

    await files(page).getByRole('button', { name: 'Back to files' }).click()
    await files(page).getByRole('treeitem', { name: 'README.md' }).click()
    await files(page).getByRole('button', { name: 'Edit', exact: true }).click()
    const md = files(page).getByRole('textbox', { name: 'Text of README.md' })
    await typeInEditor(md, '# Calc\n\n## Release plan\n\nShip on Friday.\n')
    await expect(files(page).getByTestId('markdown-preview').getByRole('heading', { name: 'Release plan' })).toBeVisible()
    await files(page).getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    expect(readFileSync(path.join(repo, 'README.md'), 'utf-8')).toContain('## Release plan')
  })

  test('3. review the agent diff: keep one hunk, drop one, comment and send', async ({ page }) => {
    await page.goto(`${link}?view=changes`)
    const panel = changes(page)
    await panel.getByRole('region', { name: 'Changes' }).getByRole('button', { name: /:\s*calc\.js/ }).click()
    await expect(panel.getByTestId('diff')).toBeVisible()
    await expect(panel.locator('[data-kind="add"]').filter({ hasText: 'a * b * 2' })).toBeVisible()

    // Keep the first hunk
    await panel.getByRole('button', { name: 'Stage change 1' }).click()
    await expect.poll(() => git(repo, 'diff', '--cached', '--name-only')).toBe('src/calc.js\n')
    // Drop the bad one, once the diff shows it alone: the list is read again
    // after a stage, and a Discard on the diff before would aim at the hunk
    // just staged
    const discard = panel.getByRole('button', { name: /^Discard change \d+$/ })
    await expect(discard).toHaveCount(1)
    await expect(panel.locator('[data-kind="add"]').filter({ hasText: 'Number(a)' })).toHaveCount(0)
    await discard.click()
    await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click()
    await expect.poll(() => readFileSync(path.join(repo, 'src/calc.js'), 'utf-8')).not.toContain('a * b * 2')
    expect(git(repo, 'diff', '--cached')).toContain('+  return Number(a) + Number(b)')

    // Its last unstaged hunk gone, the panel is back on the list by itself;
    // comment on the kept hunk, in the staged diff
    await expect(panel.getByRole('region', { name: 'Staged' })).toBeVisible()
    await panel.getByRole('region', { name: 'Staged' }).getByRole('button', { name: /:\s*calc\.js/ }).click()
    await panel.getByRole('button', { name: /^Line \d+$/ }).first().click()
    await panel.getByRole('button', { name: 'Comment', exact: true }).click()
    const sheet = page.getByRole('dialog', { name: 'Add a comment' })
    await sheet.getByRole('textbox', { name: 'Comment' }).fill(`Explain Number() here ${tag}`)
    await sheet.getByRole('button', { name: 'Add' }).click()
    await panel.getByRole('button', { name: /^Review, / }).click()
    await page.getByRole('dialog', { name: 'Review (1)' }).getByRole('button', { name: 'Send to…' }).click()
    await page.getByRole('dialog', { name: 'Send to which agent?' }).getByRole('button', { name: new RegExp(agentWindow) }).click()
    await expect(page.getByText('Sent to Claude Code')).toBeVisible({ timeout: 20_000 })
    // The agent got it
    await expect.poll(() => agentInbox(claudeDir), { timeout: 20_000 }).toContain(`Explain Number() here ${tag}`)
  })

  test('4. commit and push from the terminal', async ({ page }) => {
    await page.goto(link)
    // Keys typed before the stream opens are dropped: wait for the prompt
    await expect(page.locator('[data-testid="terminal-view"] .xterm-rows')).toHaveText(/\S/, { timeout: 15_000 })
    await page.locator('[data-testid="terminal-view"] .xterm-helper-textarea').focus()
    await page.keyboard.type(`git commit -q -m "calc: numbers only ${tag}" && git push -q origin main`)
    await page.keyboard.press('Enter')
    await expect.poll(() => git(remote, 'log', '-1', '--format=%s', 'main').trim(), { timeout: 20_000 }).toBe(`calc: numbers only ${tag}`)
  })

  test('5. run the tests, send the failure to the agent, fix, rerun green', async ({ page }) => {
    // The bug the agent left in mul, for the run to catch
    writeFileSync(path.join(repo, 'src/calc.js'), CALC_AGENT)
    await page.goto(link)
    await page.getByRole('tablist', { name: 'View' }).getByRole('tab', { name: 'Tasks' }).click({ timeout: 15_000 })
    const view = page.getByTestId('tasks-view')
    const row = view.getByTestId('task-row').filter({ has: page.getByText('test', { exact: true }) })
    await row.getByRole('button', { name: 'Run test' }).click()
    await expect(row.getByTestId('task-run-state')).toHaveText(/^exit [1-9]\d*$/, { timeout: 45_000 })

    await row.getByRole('button', { name: 'Send the output of test to an agent' }).click()
    await page.getByRole('dialog', { name: 'Send to which agent?' }).getByRole('button', { name: new RegExp(agentWindow) }).click()
    await expect(page.getByText('Sent to Claude Code')).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => agentInbox(claudeDir), { timeout: 20_000 }).toContain(`mul-${tag} is wrong`)

    // The agent's fix, then the same task again
    writeFileSync(path.join(repo, 'src/calc.js'), CALC_AGENT.replace('a * b * 2', 'a * b'))
    await row.getByRole('button', { name: 'Run test' }).click()
    await expect(row.getByTestId('task-run-state')).toHaveText('exit 0', { timeout: 45_000 })
  })

  test('6. read the specs: PDF, xlsx, docx, Shift-JIS', async ({ page }) => {
    await page.goto(`${link}?view=files`)
    const panel = files(page)
    await panel.getByRole('treeitem', { name: 'docs' }).click()

    await panel.getByRole('treeitem', { name: 'spec.pdf' }).click()
    await expect(panel.getByRole('toolbar', { name: 'PDF' }).getByText('Page 1 of 3')).toBeVisible({ timeout: 20_000 })
    await expect(panel.locator('.textLayer').first()).toContainText('Page one of the spec')

    await panel.getByRole('button', { name: 'Back to files' }).click()
    await panel.getByRole('treeitem', { name: 'cases.xlsx' }).click()
    await expect(panel.getByRole('grid')).toContainText('TC-001', { timeout: 20_000 })

    await panel.getByRole('button', { name: 'Back to files' }).click()
    await panel.getByRole('treeitem', { name: 'memo.docx' }).click()
    await expect(panel.getByRole('heading', { name: 'Release memo' })).toBeVisible({ timeout: 20_000 })

    await panel.getByRole('button', { name: 'Back to files' }).click()
    await panel.getByRole('treeitem', { name: 'legacy.txt' }).click()
    await expect(panel.getByTestId('code-block')).toContainText('仕様書です')
    await expect(panel.getByRole('button', { name: 'Encoding: Shift-JIS' })).toBeVisible()
  })

  test('7. a Place outside the pane, searched like the repo', async ({ page, request }) => {
    const listed = await (await request.get('/api/mux/files/places', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).json()
    const place = listed.places[0] as { name: string; path: string }
    await page.goto(`${link}?view=files`)
    const panel = files(page)
    await panel.getByRole('button', { name: 'Places', exact: true }).click()
    await page.getByRole('menuitemradio', { name: place.name }).click()
    await expect(panel.getByTestId('pane-root')).toHaveAttribute('title', place.path)
    await panel.getByRole('radio', { name: 'Search' }).click()
    await panel.getByRole('searchbox', { name: 'Search file contents' }).fill('TC-001')
    // meeting.md was written outside Termote, and the server keeps a root's
    // file list for a while: Refresh after a search reads the files again
    await expect(panel.getByRole('status')).toHaveText(/match|line/)
    await panel.getByRole('button', { name: 'Refresh' }).click()
    await expect(panel.getByText('1 line in 1 file')).toBeVisible()
  })

  test('8. a prompt template goes into the agent draft', async ({ page, request }) => {
    const made = await request.post('/api/mux/templates', {
      data: { name: `Acc ${tag}`, text: 'Write tests for {{file}}' },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(made.status(), await made.text()).toBe(201)
    tmux('select-window', '-t', windows[1])
    await page.goto('/')
    await page.getByRole('tab', { name: new RegExp(agentWindow) }).click()
    await page.getByRole('tablist', { name: 'View' }).getByRole('tab', { name: 'Chat' }).click({ timeout: 15_000 })
    const composer = page.getByRole('textbox', { name: 'Message to Claude Code' })
    await expect(composer).toBeVisible()
    await page.getByRole('button', { name: 'Templates', exact: true }).click()
    // The full name, as shown, space and all
    await page.getByRole('combobox', { name: 'Search templates' }).fill(`Acc ${tag}`)
    await page.getByRole('option', { name: new RegExp(`Acc ${tag}`) }).click()
    const fill = page.getByRole('dialog', { name: `Insert Acc ${tag}` })
    await fill.getByRole('textbox').first().fill('src/calc.js')
    await fill.getByRole('button', { name: 'Insert' }).click()
    await expect(composer).toHaveValue('Write tests for src/calc.js')
  })
})

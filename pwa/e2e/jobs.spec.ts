import type { APIRequestContext, Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'

// The overview's Plan against a real server: a job added and moved to
// review through the ledger's own routes. A grant needs a running agent and
// a browser signed in with the password, which CI's server does not have,
// so the grant test answers /api/mux/jobs itself (the server's answers are
// the Go tests'); the view-only one makes the snapshot say role "view".

const tag = `${Date.now()}`
const JOBS = /\/api\/mux\/jobs(?:[/?]|$)/

async function open(page: Page) {
  await page.goto('/#/overview')
  await expect(page.getByRole('region', { name: 'Agents' })).toBeVisible({ timeout: 15000 })
  await page.getByRole('tab', { name: /^Plan/ }).click()
}

const plan = (page: Page) => page.getByRole('region', { name: 'Plan' })

// A job's details, opened from its card: beside the columns on a wide
// screen, a sheet on a narrow one
async function details(page: Page, title: string) {
  const panel = page.getByRole('complementary', { name: title })
    .or(page.getByRole('dialog', { name: title }))
  // A card that is open already closes on a tap
  if (!(await panel.isVisible())) {
    await plan(page).getByRole('article', { name: title }).getByRole('button', { name: title }).click()
  }
  await expect(panel).toBeVisible()
  return panel
}

interface ListedJob {
  id: string
  title: string
  updated: string
}

async function listJobs(request: APIRequestContext): Promise<ListedJob[] | null> {
  const res = await request.get('/api/mux/jobs?all=1')
  if (!res.ok()) return null
  return ((await res.json()) as { jobs: ListedJob[] }).jobs
}

// Removes a job as read; a state-changing route takes JSON only
async function removeJob(request: APIRequestContext, j: ListedJob) {
  const res = await request.delete(`/api/mux/jobs/${j.id}?updated=${encodeURIComponent(j.updated)}`, {
    headers: { 'Content-Type': 'application/json' },
  })
  expect(res.ok(), `remove ${j.title}`).toBe(true)
}

test.describe('the Plan, on the server', () => {
  test.afterEach(async ({ request }) => {
    for (const j of (await listJobs(request)) ?? []) {
      if (!j.title.endsWith(tag)) continue
      await removeJob(request, j)
    }
  })

  test('adds a job and moves it to review', async ({ page, request }) => {
    test.skip((await listJobs(request)) === null, 'the server keeps no job ledger')
    await open(page)
    const title = `e2e job ${tag}`
    await plan(page).getByRole('button', { name: 'New job' }).click()
    const sheet = page.getByRole('dialog', { name: 'New job' })
    await sheet.getByRole('textbox', { name: 'Title' }).fill(title)
    await sheet.getByRole('button', { name: 'Add' }).click()
    await expect(sheet).toBeHidden()
    const card = plan(page).getByRole('article', { name: title })
    await expect(card).toContainText('To do')

    await (await details(page, title)).getByRole('button', { name: `Edit ${title}` }).click()
    const edit = page.getByRole('dialog', { name: `Edit ${title}` })
    await edit.getByRole('combobox', { name: 'State' }).selectOption('review')
    await edit.getByRole('button', { name: 'Save' }).click()
    await expect(edit).toBeHidden()
    await expect(card).toContainText('Review')
    const listed = (await listJobs(request))?.find((j) => j.title === title)
    expect(listed, 'saved on the server').toMatchObject({ state: 'review' })
  })

  test('orders the jobs and follows what each waits on', async ({ page, request }) => {
    test.skip((await listJobs(request)) === null, 'the server keeps no job ledger')
    const add = async (title: string) => {
      const res = await request.post('/api/mux/jobs', { data: { title } })
      expect(res.status()).toBe(201)
      return ((await res.json()) as { job: ListedJob }).job
    }
    const a = await add(`e2e first ${tag}`)
    await add(`e2e second ${tag}`)
    const b = `e2e second ${tag}`
    await open(page)
    // Both to do, so one column: the Plan's cards in order
    const titles = () => plan(page).getByRole('article').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))

    // High priority: first in To do
    await (await details(page, b)).getByRole('button', { name: `Edit ${b}` }).click()
    let edit = page.getByRole('dialog', { name: `Edit ${b}` })
    await edit.getByRole('radio', { name: 'High' }).click()
    await edit.getByRole('button', { name: 'Save' }).click()
    await expect(edit).toBeHidden()
    await expect.poll(async () => (await titles()).filter((t) => t === b || t === a.title)).toEqual([b, a.title])
    await expect(plan(page).getByRole('article', { name: b })).toContainText('High priority')

    // B waits on A; A cannot then wait on B
    await (await details(page, b)).getByRole('button', { name: `Edit ${b}` }).click()
    edit = page.getByRole('dialog', { name: `Edit ${b}` })
    await edit.getByRole('group', { name: 'Waits on' }).getByRole('checkbox', { name: a.title }).check()
    await edit.getByRole('button', { name: 'Save' }).click()
    await expect(edit).toBeHidden()
    const card = plan(page).getByRole('article', { name: b })
    await expect(card).toContainText('Waits on 1 job')
    await (await details(page, a.title)).getByRole('button', { name: `Edit ${a.title}` }).click()
    edit = page.getByRole('dialog', { name: `Edit ${a.title}` })
    await expect(edit.getByRole('group', { name: 'Waits on' }).getByRole('checkbox', { name: b })).toBeDisabled()

    // A done: B waits on nothing; A removed: B's history says so
    await edit.getByRole('combobox', { name: 'State' }).selectOption('done')
    await edit.getByRole('button', { name: 'Save' }).click()
    await expect(edit).toBeHidden()
    await expect(card).not.toContainText('Waits on')
    await removeJob(request, (await listJobs(request))?.find((j) => j.id === a.id) as ListedJob)
    await page.reload()
    await page.getByRole('tab', { name: /^Plan/ }).click()
    await expect(await details(page, b)).toContainText('A job it waited on left the plan')
  })

  test('sets a workspace and filters the Plan by it', async ({ page, request }) => {
    test.skip((await listJobs(request)) === null, 'the server keeps no job ledger')
    const snap = (await (await request.get('/api/mux/snapshot')).json()) as { groups: { id: string; name: string }[] }
    const ws = snap.groups[0]
    test.skip(!ws, 'the server shows no workspace')
    const title = `e2e workspace ${tag}`
    const other = `e2e elsewhere ${tag}`
    await request.post('/api/mux/jobs', { data: { title } })
    await request.post('/api/mux/jobs', { data: { title: other } })
    await open(page)
    await (await details(page, title)).getByRole('button', { name: `Edit ${title}` }).click()
    const edit = page.getByRole('dialog', { name: `Edit ${title}` })
    await edit.getByRole('combobox', { name: 'Workspace' }).selectOption(ws.id)
    await edit.getByRole('button', { name: 'Save' }).click()
    await expect(edit).toBeHidden()
    await expect(plan(page).getByRole('article', { name: title })).toContainText(ws.name || ws.id)

    const filter = plan(page).getByRole('combobox', { name: 'Workspace shown' })
    await filter.selectOption(`ws:${ws.id}`)
    await expect(plan(page).getByRole('article', { name: title })).toBeVisible()
    await expect(plan(page).getByRole('article', { name: other })).toHaveCount(0)
    // Remembered by this browser
    await page.reload()
    await page.getByRole('tab', { name: /^Plan/ }).click()
    await expect(plan(page).getByRole('combobox', { name: 'Workspace shown' })).toHaveValue(`ws:${ws.id}`)
    await expect(plan(page).getByRole('article', { name: other })).toHaveCount(0)
  })

  test('tells how long a finished job is kept', async ({ page, request }) => {
    test.skip((await listJobs(request)) === null, 'the server keeps no job ledger')
    const res = await request.get('/api/mux/jobs?all=1')
    expect(await res.json()).toMatchObject({ finishedKeepSeconds: 2592000, jobsMax: 200 })
    const made = await request.post('/api/mux/jobs', { data: { title: `e2e finished ${tag}` } })
    expect(made.ok()).toBe(true)
    const { job } = (await made.json()) as { job: ListedJob }
    const done = await request.patch(`/api/mux/jobs/${job.id}`, { data: { state: 'done', updated: job.updated } })
    expect(done.ok()).toBe(true)

    await open(page)
    const group = plan(page).getByRole('button', { name: /^Finished · / })
    await group.click()
    await expect(plan(page).getByText(
      'A finished job not changed for 30 days is removed at the next change to the plan; changing a job keeps it. When the plan holds 200 jobs, the oldest finished one is removed first to make room.',
    )).toBeVisible()
    // Just finished: far from its keep time, so no row says it goes
    const row = plan(page).getByRole('row', { name: new RegExp(`e2e finished ${tag}`) })
    await expect(row).toBeVisible()
    await expect(row).not.toContainText('may be removed')
  })
})

// A ledger of one job whose agent runs, as a full client signed in with the
// password reads it
function fakeLedger(page: Page) {
  const now = Date.now()
  const agent = { key: 'k', paneId: '%e2e', kind: 'claude', ref: 'e2e:claude' }
  const job = {
    id: '0123456789abcdef',
    title: `e2e grant ${tag}`,
    state: 'active',
    createdBy: 'pwa',
    agent,
    live: { status: 'working', paneId: '%e2e', ref: 'e2e:claude' },
    grants: [] as Record<string, unknown>[],
    created: new Date(now).toISOString(),
    updated: new Date(now).toISOString(),
  }
  const sent: { method: string; path: string; body: unknown }[] = []
  const answer = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  return {
    sent,
    install: () =>
      page.route(JOBS, async (route) => {
        const req = route.request()
        const path = new URL(req.url()).pathname
        const body = req.postData() ? JSON.parse(req.postData() as string) : undefined
        sent.push({ method: req.method(), path, body })
        if (req.method() === 'GET') {
          return answer(route, {
            jobs: [job],
            readOnly: false,
            serverNow: new Date().toISOString(),
            canGrant: true,
            ciAvailable: true,
            jobFields: ['priority', 'after', 'workspace'],
          })
        }
        if (req.method() === 'POST' && path.endsWith('/grants')) {
          job.grants.push({
            id: 'fedcba9876543210',
            job: job.id,
            agent,
            kind: body.kind,
            prefix: body.prefix,
            created: new Date().toISOString(),
            expires: new Date(Date.now() + body.minutes * 60_000).toISOString(),
          })
          return answer(route, { job, grant: 'fedcba9876543210' }, 201)
        }
        if (req.method() === 'DELETE' && path.includes('/grants/')) {
          for (const g of job.grants) g.revoked = new Date().toISOString()
          return answer(route, { job })
        }
        return answer(route, { code: 'unknown', error: 'not in this test' }, 500)
      }),
  }
}

test.describe('the Plan, answered here', () => {
  test('keeps the workspace of a job with an agent, and its order only noted', async ({ page }) => {
    const ledger = fakeLedger(page)
    await ledger.install()
    await open(page)
    const title = `e2e grant ${tag}`
    await (await details(page, title)).getByRole('button', { name: `Edit ${title}` }).click()
    const edit = page.getByRole('dialog', { name: `Edit ${title}` })
    const ws = edit.getByRole('combobox', { name: 'Workspace' })
    await expect(ws).toBeDisabled()
    await expect(edit.getByText('Set when the job started')).toBeVisible()
  })

  test('gives a grant to run a typed prefix, and ends it', async ({ page }) => {
    const ledger = fakeLedger(page)
    await ledger.install()
    await open(page)
    const title = `e2e grant ${tag}`
    await (await details(page, title)).getByRole('button', { name: `Grants of ${title}` }).click()
    const sheet = page.getByRole('dialog', { name: `Grants of ${title}` })
    await expect(sheet.getByText('No grant is in force')).toBeVisible()
    const prefix = sheet.getByRole('textbox', { name: 'Command prefix' })
    // Nothing is filled in from what the agent asked
    await expect(prefix).toHaveValue('')
    await prefix.fill('pnpm test; rm -rf /')
    await expect(sheet.getByRole('alert')).toContainText('no quotes')
    await prefix.fill('pnpm test')
    await expect(sheet.getByRole('alert')).toHaveCount(0)
    await sheet.getByRole('combobox', { name: 'For' }).selectOption('60')
    await sheet.getByRole('button', { name: 'Give the grant' }).click()
    await expect(sheet.getByText('The grant is in force')).toBeVisible()
    expect(ledger.sent.find((s) => s.method === 'POST')).toEqual({
      method: 'POST',
      path: '/api/mux/jobs/0123456789abcdef/grants',
      body: { kind: 'bash', prefix: 'pnpm test', minutes: 60 },
    })
    await expect(sheet.getByText('Run: pnpm test')).toBeVisible()
    await expect(sheet.getByText('Pinned to the agent in pane e2e:claude').first()).toBeVisible()

    await sheet.getByRole('button', { name: 'End the grant Run: pnpm test' }).click()
    const confirm = page.getByRole('dialog', { name: 'End this grant?' })
    await confirm.getByRole('button', { name: 'End' }).click()
    await expect(sheet.getByText('No grant is in force')).toBeVisible()
    expect(ledger.sent.some((s) => s.method === 'DELETE')).toBe(true)
  })

  test('gives a grant to send failed checks, which names no command', async ({ page }) => {
    const ledger = fakeLedger(page)
    await ledger.install()
    await open(page)
    const title = `e2e grant ${tag}`
    await (await details(page, title)).getByRole('button', { name: `Grants of ${title}` }).click()
    const sheet = page.getByRole('dialog', { name: `Grants of ${title}` })
    await sheet.getByRole('radio', { name: 'Send failed checks' }).click()
    await expect(sheet.getByText(/up to 3 times/)).toBeVisible()
    await expect(sheet.getByRole('textbox', { name: 'Command prefix' })).toHaveCount(0)
    await sheet.getByRole('button', { name: 'Give the grant' }).click()
    await expect(sheet.getByText('The grant is in force')).toBeVisible()
    expect(ledger.sent.find((s) => s.method === 'POST')).toEqual({
      method: 'POST',
      path: '/api/mux/jobs/0123456789abcdef/grants',
      body: { kind: 'ci', minutes: 1440 },
    })
    await expect(sheet.getByText('Send failed checks to the agent')).toBeVisible()
    await expect(sheet.getByText(/sent 0 of 3 times/)).toBeVisible()
  })

  test('a view-only device reads the jobs and changes nothing', async ({ page }) => {
    await page.route('**/api/mux/snapshot*', async (route) => {
      const res = await route.fetch()
      const snap = await res.json()
      await route.fulfill({ response: res, json: { ...snap, caps: { ...snap.caps, role: 'view' } } })
    })
    await page.route(JOBS, (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          jobs: [
            {
              id: '0123456789abcdef',
              title: `e2e view ${tag}`,
              state: 'review',
              branch: 'feat/e2e',
              live: { status: 'idle', paneId: '%e2e', ref: 'e2e:claude' },
              updated: new Date().toISOString(),
              priority: 'high',
              after: ['fedcba9876543210'],
              waitsOn: ['fedcba9876543210'],
              workspace: 'e2e-ws',
            },
          ],
          readOnly: true,
          jobFields: ['priority', 'after', 'workspace'],
          serverNow: new Date().toISOString(),
        }),
      }),
    )
    await open(page)
    const card = plan(page).getByRole('article', { name: `e2e view ${tag}` })
    await expect(card).toContainText('feat/e2e')
    await expect(card).toContainText('High priority')
    await expect(card).toContainText('Waits on 1 job')
    await expect(card).toContainText('e2e-ws')
    await expect(plan(page).getByRole('button', { name: 'New job' })).toHaveCount(0)
    await expect(card.getByRole('button')).toHaveCount(0)
  })
})

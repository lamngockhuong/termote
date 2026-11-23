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
}

const plan = (page: Page) => page.getByRole('region', { name: 'Plan' })

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

test.describe('the Plan, on the server', () => {
  test.afterEach(async ({ request }) => {
    for (const j of (await listJobs(request)) ?? []) {
      if (!j.title.endsWith(tag)) continue
      await request.delete(`/api/mux/jobs/${j.id}?updated=${encodeURIComponent(j.updated)}`)
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

    await card.getByRole('button', { name: `Edit ${title}` }).click()
    const edit = page.getByRole('dialog', { name: `Edit ${title}` })
    await edit.getByRole('combobox', { name: 'State' }).selectOption('review')
    await edit.getByRole('button', { name: 'Save' }).click()
    await expect(edit).toBeHidden()
    await expect(card).toContainText('Review')
    const listed = (await listJobs(request))?.find((j) => j.title === title)
    expect(listed, 'saved on the server').toMatchObject({ state: 'review' })
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
          return answer(route, { jobs: [job], readOnly: false, serverNow: new Date().toISOString(), canGrant: true })
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
  test('gives a grant to run a typed prefix, and ends it', async ({ page }) => {
    const ledger = fakeLedger(page)
    await ledger.install()
    await open(page)
    const title = `e2e grant ${tag}`
    await plan(page).getByRole('button', { name: `Grants of ${title}` }).click()
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
            },
          ],
          readOnly: true,
          serverNow: new Date().toISOString(),
        }),
      }),
    )
    await open(page)
    const card = plan(page).getByRole('article', { name: `e2e view ${tag}` })
    await expect(card).toContainText('feat/e2e')
    await expect(plan(page).getByRole('button', { name: 'New job' })).toHaveCount(0)
    await expect(card.getByRole('button')).toHaveCount(0)
  })
})

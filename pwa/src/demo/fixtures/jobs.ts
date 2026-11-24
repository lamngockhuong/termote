// The demo's plan: jobs an orchestrator handed out, one running in web's
// Claude Code with a grant to run its tests, one done in acme-api's with its
// turn not read yet (high priority), one waiting for the user's review whose
// pull request's docs check failed, and three to do: the release notes,
// which wait on that review, the announcement (low priority, no workspace),
// which waits on the notes, and a search box for web, ready to start.
import type { Job } from '../../hooks/use-mux-api'
import { ACME_ROOT, DEMO_HOME } from './workspace'

// A job as the demo's server keeps it; live is worked out on each read.
// unread: the agent's last turn ended and the orchestrator has not read it
export type DemoJob = Omit<Job, 'live'> & { unread?: boolean }

const agent = (paneId: string, ref: string, groupId: string) => ({
  key: paneId,
  paneId,
  kind: 'claude',
  groupId,
  ref,
})

// The jobs at now (ms)
export function demoJobs(now: number): DemoJob[] {
  const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
  return [
    {
      id: 'a0b1c2d3e4f50617',
      // i18n-ignore: demo data, as an agent wrote it
      title: 'Dark mode for the settings page',
      prompt:
        'Add a dark theme to the settings page, following the design tokens. Run pnpm test before you stop.',
      state: 'active',
      createdBy: 'claude',
      workspace: 'w2',
      agent: agent('w2:p1', 'web:claude', 'w2'),
      worktree: {
        branch: 'feat/dark-settings',
        base: 'main',
        dir: `${DEMO_HOME}/web-dark-settings`,
        groupId: 'w2',
      },
      grants: [
        {
          id: 'b1c2d3e4f5061728',
          job: 'a0b1c2d3e4f50617',
          agent: agent('w2:p1', 'web:claude', 'w2'),
          kind: 'bash',
          prefix: 'pnpm test',
          created: at(20),
          expires: new Date(now + 4 * 3_600_000).toISOString(),
          uses: [{ at: at(6), command: 'pnpm test -- settings' }],
        },
      ],
      events: [
        { at: at(25), kind: 'created' },
        { at: at(24), kind: 'started', text: 'web:claude' },
        { at: at(20), kind: 'grant', text: 'run pnpm test' },
        { at: at(6), kind: 'delegated', text: 'pnpm test -- settings' },
      ],
      created: at(25),
      updated: at(6),
    },
    {
      id: 'c2d3e4f506172839',
      // i18n-ignore: demo data, as an agent wrote it
      title: 'Rate limit the login endpoint',
      prompt: 'Add a per-IP rate limit to POST /login, with table tests.',
      state: 'active',
      createdBy: 'claude',
      priority: 'high',
      workspace: 'w1',
      agent: agent('w1:p1', 'acme-api:claude', 'w1'),
      unread: true,
      diff: { commits: 1, files: 2, head: '3f2a9c1', at: at(4) },
      events: [
        { at: at(40), kind: 'created' },
        { at: at(39), kind: 'started', text: 'acme-api:claude' },
        { at: at(4), kind: 'diff', text: '1 commit, 2 files' },
      ],
      created: at(40),
      updated: at(4),
    },
    {
      id: 'd3e4f5061728394a',
      // i18n-ignore: demo data, as an agent wrote it
      title: 'Update the API docs for v2',
      note: 'Check the examples against a running server.',
      state: 'review',
      createdBy: 'claude',
      workspace: 'w1',
      diff: { commits: 3, files: 5, head: '9b8c7d6', at: at(90) },
      // Its pull request, whose docs check failed
      ci: {
        repo: 'github.com/acme/api',
        push: 'github.com/acme/api',
        prs: [
          {
            number: 128,
            repo: 'github.com/acme/api',
            state: 'open',
            checks: 'fail',
            failing: ['docs-links'],
            failRun: 7351,
            head: '9b8c7d6e5f40',
            url: 'https://github.com/acme/api/pull/128',
          },
        ],
        notified: 'fail:128@9b8c7d6e5f40',
      },
      worktree: {
        branch: 'docs/api-v2',
        base: 'main',
        dir: `${ACME_ROOT}-docs`,
        groupId: 'w1',
      },
      events: [
        { at: at(180), kind: 'created' },
        { at: at(90), kind: 'state', text: 'review' },
      ],
      created: at(180),
      updated: at(90),
    },
    {
      id: 'e4f5061728394a5b',
      // i18n-ignore: demo data, as an agent wrote it
      title: 'Write the v2 release notes',
      prompt: 'Summarise the v2 API changes for the changelog.',
      state: 'todo',
      createdBy: 'claude',
      workspace: 'w1',
      after: ['d3e4f5061728394a'],
      events: [{ at: at(60), kind: 'created' }],
      created: at(60),
      updated: at(60),
    },
    {
      id: 'f5061728394a5b6c',
      // i18n-ignore: demo data, as an agent wrote it
      title: 'Announce v2 on the blog',
      state: 'todo',
      createdBy: 'pwa',
      priority: 'low',
      after: ['e4f5061728394a5b'],
      events: [{ at: at(50), kind: 'created' }],
      created: at(50),
      updated: at(50),
    },
    {
      id: '061728394a5b6c7d',
      // i18n-ignore: demo data, as an agent wrote it
      title: 'Search box for the settings page',
      prompt: 'Add a search field that filters the settings sections.',
      state: 'todo',
      createdBy: 'claude',
      workspace: 'w2',
      events: [{ at: at(30), kind: 'created' }],
      created: at(30),
      updated: at(30),
    },
  ]
}

// The Herdr machine of the intro video (video/capture/demo-env.sh): workspace
// acme-api (tab claude with Claude Code and the dev server log beside it, tab
// shell), workspace web (another Claude Code, working) and infra.
import type { MuxGroup, MuxSnapshot } from '../../hooks/use-mux-api'

export const DEMO_HOME = '/home/dev'
export const ACME_ROOT = `${DEMO_HOME}/acme-api`
export const WEB_ROOT = `${DEMO_HOME}/web`

// What a full client of a Herdr server without sign-in may do, less what
// the demo cannot show: uploads, push, worktrees, starting an agent, Places,
// devices and sign-ins.
export const DEMO_CAPS: MuxSnapshot['caps'] = {
  clientSideSelect: true,
  copyMode: false,
  scroll: true,
  paneText: true,
  driveSize: false,
  agentChat: true,
  files: true,
  uploads: false,
  trash: true,
  places: false,
  auth: false,
  groups: true,
  renameGroup: true,
  renameTab: true,
  push: false,
  agentStart: false,
  worktrees: false,
  agentStartCodex: false,
  reorderTabs: true,
  paneLayout: true,
  paneStream: true,
  renamePane: true,
  reorderGroups: true,
  devices: false,
  signins: false,
  templates: true,
  recentGroups: true,
  tasks: true,
  userTasks: true,
}

// The size a pane's terminal is drawn at: the recorded Claude Code screens
// are 100 columns by 41 rows
export const SCREEN = { cols: 100, rows: 41 }
const TAB_COLS = 160

const full = (id: string) => ({
  cols: TAB_COLS,
  rows: SCREEN.rows,
  zoomed: false,
  panes: [{ id, x: 0, y: 0, cols: TAB_COLS, rows: SCREEN.rows }],
})

// The groups as the snapshot lists them; since: when each agent's status
// began, minutes before now
export function demoGroups(now: number): MuxGroup[] {
  const ago = (minutes: number) =>
    new Date(now - minutes * 60_000).toISOString()
  return [
    {
      id: 'w1',
      name: 'acme-api',
      tabs: [
        {
          id: 'w1:t1',
          key: 'w1:t1',
          name: 'claude',
          active: true,
          panes: [
            {
              id: 'w1:p1',
              active: true,
              agent: { name: 'claude', status: 'idle', since: ago(3) },
              process: { name: 'claude', cwd: ACME_ROOT },
            },
            {
              id: 'w1:p2',
              active: false,
              // i18n-ignore: the terminal title the program set
              title: 'api',
              process: { name: 'go', cwd: ACME_ROOT },
            },
          ],
          layout: {
            cols: TAB_COLS,
            rows: SCREEN.rows,
            zoomed: false,
            panes: [
              { id: 'w1:p1', x: 0, y: 0, cols: SCREEN.cols, rows: SCREEN.rows },
              {
                id: 'w1:p2',
                x: SCREEN.cols,
                y: 0,
                cols: TAB_COLS - SCREEN.cols,
                rows: SCREEN.rows,
              },
            ],
          },
        },
        {
          id: 'w1:t2',
          key: 'w1:t2',
          name: 'shell',
          active: false,
          panes: [
            {
              id: 'w1:p3',
              active: true,
              process: { name: 'bash', cwd: ACME_ROOT },
            },
          ],
          layout: full('w1:p3'),
        },
      ],
    },
    {
      id: 'w2',
      name: 'web',
      tabs: [
        {
          id: 'w2:t1',
          key: 'w2:t1',
          name: 'claude',
          active: true,
          panes: [
            {
              id: 'w2:p1',
              active: true,
              agent: { name: 'claude', status: 'working', since: ago(1) },
              process: { name: 'claude', cwd: WEB_ROOT },
            },
          ],
          layout: full('w2:p1'),
        },
      ],
    },
    {
      id: 'w3',
      name: 'infra',
      tabs: [
        {
          id: 'w3:t1',
          key: 'w3:t1',
          name: 'deploy',
          active: true,
          panes: [
            {
              id: 'w3:p1',
              active: true,
              process: { name: 'bash', cwd: DEMO_HOME },
            },
          ],
          layout: full('w3:p1'),
        },
      ],
    },
  ]
}

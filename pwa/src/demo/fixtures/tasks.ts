// What the Tasks view finds in each root: acme-api's Makefile and Go tasks,
// web's package.json scripts (as the server reads them from those files).
import type { PaneTasks } from '../../hooks/use-mux-api'
import { ACME_ROOT, WEB_ROOT } from './workspace'

type FoundTasks = Omit<PaneTasks, 'root' | 'userTasks' | 'runs'>

const NONE: FoundTasks = {
  packageManager: '',
  scripts: [],
  makefile: '',
  makeTargets: [],
  toolGroups: [],
  skipped: 0,
  tooLarge: [],
  unreadable: [],
}

export const TASKS: Record<string, FoundTasks> = {
  [ACME_ROOT]: {
    ...NONE,
    makefile: 'Makefile',
    makeTargets: [{ name: 'run' }, { name: 'lint' }, { name: 'migrate' }],
    toolGroups: [
      {
        tool: 'go',
        // i18n-ignore: the tool name the server reports
        label: 'Go',
        file: 'go.mod',
        tasks: [
          { name: 'build', command: 'go build ./...' },
          { name: 'test', command: 'go test ./...' },
          { name: 'vet', command: 'go vet ./...' },
          { name: 'run', command: 'go run .' },
        ],
      },
    ],
  },
  [WEB_ROOT]: {
    ...NONE,
    packageManager: 'pnpm',
    scripts: [
      { name: 'dev', command: 'vite' },
      { name: 'build', command: 'vite build' },
      { name: 'test', command: 'vitest run' },
    ],
  },
}

export const NO_TASKS = NONE

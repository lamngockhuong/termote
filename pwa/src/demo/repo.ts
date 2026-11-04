import type { ChangeEntry, DiffHunk } from '../hooks/use-mux-api'
import { diffHunks } from './line-diff'
import { type DemoState, REPO_ROOT } from './state'

// acme-api's git state, worked out from the demo's files: HEAD (one
// commit), the index and the working tree, compared path by path as git
// status does.

// The working tree's file at path under the repo, if it exists
export const worktreeText = (state: DemoState, path: string) =>
  state.files.get(`${REPO_ROOT}/${path}`)

function side(from?: string, to?: string): string {
  if (from === to) return ''
  if (from === undefined) return 'A'
  if (to === undefined) return 'D'
  return 'M'
}

export function gitStatus(state: DemoState): ChangeEntry[] {
  const paths = new Set([...state.head.keys(), ...state.index.keys()])
  for (const abs of state.files.keys())
    if (abs.startsWith(`${REPO_ROOT}/`))
      paths.add(abs.slice(REPO_ROOT.length + 1))
  const out: ChangeEntry[] = []
  for (const path of [...paths].sort()) {
    const head = state.head.get(path)
    const index = state.index.get(path)
    const work = worktreeText(state, path)
    const staged = side(head, index)
    // Not in the index: untracked
    const unstaged =
      index === undefined ? (work === undefined ? '' : '?') : side(index, work)
    if (staged || unstaged)
      out.push({
        path,
        staged: unstaged === '?' ? '' : staged,
        unstaged,
        sensitive: false,
      })
  }
  return out
}

// The diff of one side of a status entry: the index against HEAD (staged),
// or the working tree against the index
export function entryDiff(
  state: DemoState,
  path: string,
  staged: boolean,
): DiffHunk[] {
  const index = state.index.get(path)
  const [from, to] = staged
    ? [state.head.get(path), index]
    : [index, worktreeText(state, path)]
  return diffHunks(from ?? '', to ?? '')
}

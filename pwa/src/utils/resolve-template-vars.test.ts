import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordSelection, resetPaneSelections } from './pane-selection'
import { fetchBranch, knownTemplateValues } from './resolve-template-vars'

const state = vi.hoisted(() => ({
  files: null as unknown,
  changes: null as unknown,
}))
vi.mock('../hooks/use-files', () => ({
  peekFilesState: () => state.files,
  activeTab: (s: { tabs: { id: string }[]; activeId: string | null }) =>
    s.tabs.find((t) => t.id === s.activeId),
}))
vi.mock('../hooks/use-git-changes', () => ({
  peekGitChanges: () => state.changes,
}))
const fetchGitChanges = vi.hoisted(() => vi.fn())
vi.mock('../hooks/use-mux-api', () => ({ fetchGitChanges }))

const empty = { value: '', source: '' }

describe('knownTemplateValues', () => {
  beforeEach(() => {
    state.files = null
    state.changes = null
    resetPaneSelections()
  })

  it('is empty when the app holds nothing for the pane', () => {
    expect(knownTemplateValues('1')).toEqual({
      file: empty,
      selection: empty,
      branch: empty,
      input: empty,
    })
  })

  it('takes the file shown, the selection and the branch', () => {
    state.files = {
      root: '/r',
      tabs: [{ id: 't', path: 'src/a.ts' }],
      activeId: 't',
    }
    state.changes = { branch: 'main' }
    recordSelection('1', 'kept', 'src/b.ts')
    expect(knownTemplateValues('1', { worktreeBranch: 'wt' })).toEqual({
      file: { value: 'src/a.ts', source: 'the file shown' },
      selection: { value: 'kept', source: 'src/b.ts' },
      branch: { value: 'main', source: 'git' },
      input: empty,
    })
    // The terminal's selection now comes first
    expect(
      knownTemplateValues('1', { terminalText: 'live' }).selection,
    ).toEqual({ value: 'live', source: 'the terminal' })
  })

  it('the tree shown is no file; a detached HEAD no branch', () => {
    state.files = { tabs: [{ id: 't', path: 'a' }], activeId: null }
    state.changes = { branch: '(detached)' }
    const v = knownTemplateValues('1', { worktreeBranch: 'wt' })
    expect(v.file).toEqual(empty)
    expect(v.branch).toEqual({ value: 'wt', source: 'the worktree' })
    expect(
      knownTemplateValues('1', { worktreeBranch: '(detached)' }).branch,
    ).toEqual(empty)
  })
})

describe('fetchBranch', () => {
  beforeEach(() => fetchGitChanges.mockReset())

  it("reads git status under the Files view's root", async () => {
    state.files = { root: '/r', tabs: [], activeId: null }
    fetchGitChanges.mockResolvedValueOnce({ branch: 'dev' })
    expect(await fetchBranch('1')).toBe('dev')
    expect(fetchGitChanges).toHaveBeenCalledWith('1', '/r')
    state.files = null
    fetchGitChanges.mockResolvedValueOnce({ branch: '(detached)' })
    expect(await fetchBranch('1')).toBe('')
    expect(fetchGitChanges).toHaveBeenLastCalledWith('1', undefined)
    fetchGitChanges.mockResolvedValueOnce({ isRepo: false })
    expect(await fetchBranch('1')).toBe('')
    fetchGitChanges.mockRejectedValueOnce(new Error('x'))
    expect(await fetchBranch('1')).toBe('')
  })
})

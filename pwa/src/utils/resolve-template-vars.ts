import { activeTab, peekFilesState } from '../hooks/use-files'
import { peekGitChanges } from '../hooks/use-git-changes'
import { fetchGitChanges } from '../hooks/use-mux-api'
import { paneSelection } from './pane-selection'
import type { TemplateVariable } from './prompt-templates'

// The values a template's variables start with in the fill dialog, read
// from what the app already holds for the pane; the user can change each.

export interface VariableValue {
  value: string
  // Where it came from, shown under its field ('' when nothing was found):
  // the key of a view's line (chat.fill.from.*) or a file's path
  source: string
}

export type TemplateValues = Partial<Record<TemplateVariable, VariableValue>>

const none: VariableValue = { value: '', source: '' }

// git names a detached HEAD "(detached)": no branch to name
const branchName = (b: string | undefined) => (b && b !== '(detached)' ? b : '')

// What is known now, without asking the server: the file shown in the
// pane's Files view, the selection (terminalText: what the terminal has
// selected now, before the latest one kept), the branch from the Changes
// view or the Herdr worktree group. {{input}} starts empty.
export function knownTemplateValues(
  paneId: string,
  ctx: { terminalText?: string; worktreeBranch?: string } = {},
): Required<TemplateValues> {
  const file = peekFilesState(paneId)
  const tab = file && activeTab(file)
  const kept = paneSelection(paneId)
  const changes = branchName(peekGitChanges(paneId)?.branch)
  const worktree = branchName(ctx.worktreeBranch)
  return {
    file: tab ? { value: tab.path, source: 'chat.fill.from.file' } : none,
    selection: ctx.terminalText
      ? { value: ctx.terminalText, source: 'chat.fill.from.terminal' }
      : kept
        ? { value: kept.text, source: kept.source }
        : none,
    branch: changes
      ? { value: changes, source: 'chat.fill.from.git' }
      : worktree
        ? { value: worktree, source: 'chat.fill.from.worktree' }
        : none,
    input: none,
  }
}

// The pane's branch from the server (git status), when nothing the app
// holds names it; '' for a detached HEAD, no repository, or a failure.
export async function fetchBranch(paneId: string): Promise<string> {
  try {
    const root = peekFilesState(paneId)?.root
    return branchName((await fetchGitChanges(paneId, root)).branch)
  } catch {
    return ''
  }
}

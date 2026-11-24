import { describe, expect, it } from 'vitest'
import {
  ORCHESTRATOR_DOCS_URL,
  PLUGIN_COMMANDS,
  SKILL_COMMANDS,
} from './orchestrator-setup'

// The orchestrator pages of the website, by their path under the docs
const DOCS = import.meta.glob<string>(
  [
    '../../../website/src/content/docs/usage/orchestrator.mdx',
    '../../../website/src/content/docs/vi/usage/orchestrator.mdx',
  ],
  { query: '?raw', import: 'default', eager: true },
)
const docsPage = (path: string) =>
  DOCS[`../../../website/src/content/docs${path.replace(/\/$/, '')}.mdx`]

// The setup sheet copies these lines: the plugin ones are not termote's, so
// the Go test cannot check them, and they must say what the guide says.
describe('the orchestrator setup', () => {
  it.each([
    ...SKILL_COMMANDS,
    ...PLUGIN_COMMANDS.claude,
    ...PLUGIN_COMMANDS.codex,
  ])('is in the guide: %s', (line) => {
    for (const locale of ['en', 'vi'] as const) {
      const page = docsPage(new URL(ORCHESTRATOR_DOCS_URL[locale]).pathname)
      expect(page).toContain(line)
    }
  })

  it.each(['en', 'vi'] as const)('links a page of the guide in %s', (l) => {
    const url = new URL(ORCHESTRATOR_DOCS_URL[l])
    expect(url.origin).toBe('https://termote.ohnice.app')
    expect(docsPage(url.pathname)).toContain('termote-orchestrator')
  })
})

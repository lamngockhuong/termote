// What the Plan's setup sheet tells to type: kept out of the messages so
// server/orchestrator_setup_pwa_test.go can check each termote command and
// flag against `termote help`, and orchestrator-setup.test.ts each line
// against the orchestrator docs page they come from.

export const ORCHESTRATOR_DOCS_URL = {
  en: 'https://termote.ohnice.app/usage/orchestrator/',
  vi: 'https://termote.ohnice.app/vi/usage/orchestrator/',
}

// Installs the skill the termote binary carries, then says whether it matches
export const SKILL_COMMANDS = [
  'termote skills install',
  'termote skills status',
]

// The same skill from the termote-plugins marketplace
export const PLUGIN_COMMANDS = {
  claude: [
    '/plugin marketplace add lamngockhuong/termote-plugins',
    '/plugin install termote@termote',
  ],
  codex: [
    'codex plugin marketplace add lamngockhuong/termote-plugins',
    'codex plugin add termote@termote',
  ],
}

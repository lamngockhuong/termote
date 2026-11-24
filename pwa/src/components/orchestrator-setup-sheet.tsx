import { useT } from '../i18n/i18n-context'
import {
  ORCHESTRATOR_DOCS_URL,
  PLUGIN_COMMANDS,
  SKILL_COMMANDS,
} from '../utils/orchestrator-setup'
import { CopyButton } from './chat-copy-button'
import { FOCUS_RING } from './ui/button'
import { Sheet } from './ui/sheet'

// One line to type, with a button copying it
function Command({ text }: { text: string }) {
  const { t } = useT()
  return (
    <li className="flex items-center gap-1 rounded-control border border-border bg-surface-raised py-0.5 pr-0.5 pl-2.5">
      <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-fg">
        {text}
      </code>
      <CopyButton
        text={() => text}
        label={t('jobs.setup.copy', { command: text })}
      />
    </li>
  )
}

function Commands({ lines }: { lines: readonly string[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {lines.map((line) => (
        <Command key={line} text={line} />
      ))}
    </ul>
  )
}

// How the Plan fills itself: install the termote-orchestrator skill, from
// termote or as a plugin, and ask an agent. Static: the server cannot see
// a skill installed as a plugin, so the sheet never says what is there.
export function OrchestratorSetupSheet({
  isOpen,
  onClose,
}: {
  isOpen: boolean
  onClose: () => void
}) {
  const { t, locale } = useT()
  return (
    <Sheet isOpen={isOpen} onClose={onClose} title={t('jobs.setup.title')}>
      <div className="flex flex-col gap-4 p-4 text-[13px] text-fg-muted">
        <p className="m-0">{t('jobs.setup.intro')}</p>
        <section className="flex flex-col gap-2">
          <h3 className="m-0 font-medium text-fg">
            {t('jobs.setup.fromTermote')}
          </h3>
          <Commands lines={SKILL_COMMANDS} />
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="m-0 font-medium text-fg">
            {t('jobs.setup.asPlugin')}
          </h3>
          <h4 className="m-0 text-[12px] text-fg-subtle">
            {t('jobs.setup.claude')}
          </h4>
          <Commands lines={PLUGIN_COMMANDS.claude} />
          <h4 className="m-0 text-[12px] text-fg-subtle">
            {t('jobs.setup.codex')}
          </h4>
          <Commands lines={PLUGIN_COMMANDS.codex} />
        </section>
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[12px]">
          <li>{t('jobs.setup.oneWay')}</li>
          <li>{t('jobs.setup.where')}</li>
          <li>{t('jobs.setup.native')}</li>
        </ul>
        <a
          href={ORCHESTRATOR_DOCS_URL[locale]}
          target="_blank"
          rel="noopener noreferrer"
          className={`self-start text-accent hover:underline ${FOCUS_RING}`}
        >
          {t('jobs.setup.docs')}
        </a>
      </div>
    </Sheet>
  )
}

import { ArrowUpRight, ChevronRight } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import { APP_INFO } from '../utils/app-info'
import { BrandMark } from './brand-mark'
import { BuyMeACoffeeIcon, GithubSponsorsIcon, MomoIcon } from './sponsor-icons'
import { FOCUS_RING } from './ui/button'
import { Sheet } from './ui/sheet'

interface Props {
  isOpen: boolean
  onClose: () => void
  // Opens Settings at its Updates group; without it the row is not shown
  onCheckUpdates?: () => void
}

// The frame of a Settings group, so About reads as the same family of lists:
// full width in Terminal, a card in Neutral and Native. overflow-hidden keeps
// a hovered row inside the rounded corners.
const LIST =
  'm-0 list-none overflow-hidden divide-y divide-border border-y border-border p-0 ui-terminal:-mx-4 ui-native:rounded-panel ui-native:border-0 ui-neutral:rounded-panel ui-neutral:border'

// Type and Native fill of a Settings row (SettingRow)
const ROW = `flex w-full min-h-10 items-center justify-between gap-3 px-4 py-2 text-left text-[15px] text-fg hover:bg-surface-raised ui-terminal:font-label ui-terminal:text-[13px] ui-native:bg-surface-raised ui-native:hover:bg-surface pointer-coarse:min-h-touch ${FOCUS_RING} focus-visible:-outline-offset-2`

// The ↗ only shows it to sighted users
const NEW_TAB = <span className="sr-only"> (opens in a new tab)</span>

const LINKS = [
  { label: 'GitHub', href: APP_INFO.repository },
  { label: 'Changelog', href: APP_INFO.links.changelog },
  { label: 'Report an issue', href: APP_INFO.links.issues },
]

// Brand colours of the sponsor services as a light tint; the text stays
// readable on it in both themes.
const SPONSOR_LINK = `flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-control px-2 text-sm transition-colors pointer-coarse:h-touch ${FOCUS_RING}`

function ExternalLink({
  href,
  children,
}: {
  href: string
  children: ReactNode
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={ROW}>
      <span>
        {children}
        {NEW_TAB}
      </span>
      <ArrowUpRight
        size={16}
        aria-hidden="true"
        className="shrink-0 text-fg-subtle"
      />
    </a>
  )
}

export function AboutModal({ isOpen, onClose, onCheckUpdates }: Props) {
  const supportId = useId()
  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      title={`About ${APP_INFO.displayName}`}
    >
      <div className="flex flex-col gap-5 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="flex flex-col items-center gap-1 pt-2 text-center">
          <BrandMark className="mb-1 size-12 text-fg" />
          <p className="m-0 text-xl font-semibold text-fg ui-terminal:font-label">
            {APP_INFO.displayName}
          </p>
          <p className="m-0 font-label text-xs text-fg-subtle">
            v{APP_INFO.version} · {APP_INFO.license}
          </p>
          <p className="m-0 mt-2 max-w-xs text-sm text-fg-muted">
            {APP_INFO.description}
          </p>
        </div>

        <ul className={LIST}>
          <li>
            <a
              href={APP_INFO.author.url}
              target="_blank"
              rel="noopener noreferrer"
              className={ROW}
            >
              <span className="text-fg-muted">Author</span>
              <span className="flex min-w-0 items-center gap-1 text-accent">
                <span className="truncate">
                  {APP_INFO.author.name}
                  {NEW_TAB}
                </span>
                <ArrowUpRight
                  size={16}
                  aria-hidden="true"
                  className="shrink-0"
                />
              </span>
            </a>
          </li>
          {onCheckUpdates && (
            <li>
              <button type="button" onClick={onCheckUpdates} className={ROW}>
                Check for updates
                <ChevronRight
                  size={16}
                  aria-hidden="true"
                  className="shrink-0 text-fg-subtle"
                />
              </button>
            </li>
          )}
        </ul>

        <ul className={LIST}>
          {LINKS.map((link) => (
            <li key={link.label}>
              <ExternalLink href={link.href}>{link.label}</ExternalLink>
            </li>
          ))}
        </ul>

        <section aria-labelledby={supportId}>
          <h3
            id={supportId}
            className="m-0 mb-2 flex items-center gap-1.5 px-1 font-label text-[11px] font-semibold uppercase tracking-wider text-fg-subtle"
          >
            <GithubSponsorsIcon size={12} className="text-danger" />
            Support this project
          </h3>
          <div className="grid grid-cols-3 gap-2">
            <a
              href={APP_INFO.sponsor.momo}
              target="_blank"
              rel="noopener noreferrer"
              className={`${SPONSOR_LINK} bg-[#A50064]/[0.07] text-[#A50064] hover:bg-[#A50064]/15 dark:bg-[#A50064]/15 dark:text-[#d64b9a] dark:hover:bg-[#A50064]/25`}
              title="MoMo"
            >
              <MomoIcon size={16} /> MoMo
              {NEW_TAB}
            </a>
            <a
              href={APP_INFO.sponsor.github}
              target="_blank"
              rel="noopener noreferrer"
              className={`${SPONSOR_LINK} bg-[#db61a2]/[0.07] text-[#b02f77] hover:bg-[#db61a2]/15 dark:bg-[#db61a2]/15 dark:text-[#ea8fbe] dark:hover:bg-[#db61a2]/25`}
              title="GitHub Sponsors"
            >
              <GithubSponsorsIcon size={16} /> Sponsor
              {NEW_TAB}
            </a>
            <a
              href={APP_INFO.sponsor.buyMeACoffee}
              target="_blank"
              rel="noopener noreferrer"
              className={`${SPONSOR_LINK} bg-[#FFDD00]/15 text-[#7a6500] hover:bg-[#FFDD00]/25 dark:bg-[#FFDD00]/10 dark:text-[#FFDD00] dark:hover:bg-[#FFDD00]/20`}
              title="Buy Me a Coffee"
            >
              <BuyMeACoffeeIcon size={16} /> Coffee
              {NEW_TAB}
            </a>
          </div>
        </section>
      </div>
    </Sheet>
  )
}

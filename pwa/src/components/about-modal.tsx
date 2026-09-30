import { APP_INFO } from '../utils/app-info'
import { BuyMeACoffeeIcon, GithubSponsorsIcon, MomoIcon } from './sponsor-icons'
import { FOCUS_RING } from './ui/button'
import { Sheet } from './ui/sheet'

interface Props {
  isOpen: boolean
  onClose: () => void
}

const LINK_BUTTON = `inline-flex h-9 items-center rounded-control border border-border bg-surface px-3 text-sm text-fg hover:border-border-strong hover:bg-surface-raised pointer-coarse:h-touch ${FOCUS_RING}`

// Brand colors of the sponsor services; the text stays readable on the tint.
const SPONSOR_LINK = `inline-flex h-9 items-center gap-1.5 rounded-control px-3 text-sm transition-colors pointer-coarse:h-touch ${FOCUS_RING}`

export function AboutModal({ isOpen, onClose }: Props) {
  return (
    <Sheet isOpen={isOpen} onClose={onClose} title={`About ${APP_INFO.name}`}>
      <div className="space-y-4 p-4">
        <p className="m-0 text-fg-muted">{APP_INFO.description}</p>

        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="text-fg-subtle">Version</div>
          <div className="text-fg">{APP_INFO.version}</div>

          <div className="text-fg-subtle">Author</div>
          <a
            href={APP_INFO.author.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`text-accent hover:underline ${FOCUS_RING}`}
          >
            {APP_INFO.author.name}
          </a>

          <div className="text-fg-subtle">License</div>
          <div className="text-fg">{APP_INFO.license}</div>
        </div>

        {/* Links */}
        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          <a
            href={APP_INFO.repository}
            target="_blank"
            rel="noopener noreferrer"
            className={LINK_BUTTON}
          >
            GitHub
          </a>
          <a
            href={APP_INFO.links.changelog}
            target="_blank"
            rel="noopener noreferrer"
            className={LINK_BUTTON}
          >
            Changelog
          </a>
          <a
            href={APP_INFO.links.issues}
            target="_blank"
            rel="noopener noreferrer"
            className={LINK_BUTTON}
          >
            Report Issue
          </a>
        </div>

        {/* Sponsor */}
        <div className="border-t border-border pt-4">
          <p className="m-0 mb-3 flex items-center gap-1 text-sm text-fg-subtle">
            <GithubSponsorsIcon size={14} className="text-danger" /> Support
            this project
          </p>
          <div className="flex flex-wrap gap-2">
            <a
              href={APP_INFO.sponsor.momo}
              target="_blank"
              rel="noopener noreferrer"
              className={`${SPONSOR_LINK} bg-[#A50064]/10 text-[#A50064] hover:bg-[#A50064]/20 dark:bg-[#A50064]/20 dark:text-[#d64b9a] dark:hover:bg-[#A50064]/30`}
              title="MoMo"
            >
              <MomoIcon size={16} /> MoMo
            </a>
            <a
              href={APP_INFO.sponsor.github}
              target="_blank"
              rel="noopener noreferrer"
              className={`${SPONSOR_LINK} bg-[#db61a2]/10 text-[#b02f77] hover:bg-[#db61a2]/20 dark:bg-[#db61a2]/20 dark:text-[#ea8fbe] dark:hover:bg-[#db61a2]/30`}
              title="GitHub Sponsors"
            >
              <GithubSponsorsIcon size={16} /> Sponsor
            </a>
            <a
              href={APP_INFO.sponsor.buyMeACoffee}
              target="_blank"
              rel="noopener noreferrer"
              className={`${SPONSOR_LINK} bg-[#FFDD00]/20 text-[#7a6500] hover:bg-[#FFDD00]/30 dark:bg-[#FFDD00]/15 dark:text-[#FFDD00] dark:hover:bg-[#FFDD00]/25`}
              title="Buy Me a Coffee"
            >
              <BuyMeACoffeeIcon size={16} /> Coffee
            </a>
          </div>
        </div>
      </div>
    </Sheet>
  )
}

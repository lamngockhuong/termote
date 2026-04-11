import { useEffect, useRef } from 'react'
import { APP_INFO } from '../utils/app-info'
import { BuyMeACoffeeIcon, GithubSponsorsIcon, MomoIcon } from './sponsor-icons'

interface Props {
  isOpen: boolean
  onClose: () => void
}

export function AboutModal({ isOpen, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (isOpen) {
      dialog.showModal()
    } else {
      dialog.close()
    }
  }, [isOpen])

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose()
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [onClose, isOpen])

  if (!isOpen) return null

  return (
    <dialog
      ref={dialogRef}
      className="fixed inset-0 z-50 m-auto w-[90vw] max-w-md rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 p-0 backdrop:bg-black/50 shadow-xl"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-zinc-900 dark:text-white">
            About {APP_INFO.name}
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="space-y-4">
          <p className="text-zinc-600 dark:text-zinc-300">
            {APP_INFO.description}
          </p>

          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-zinc-500 dark:text-zinc-400">Version</div>
            <div className="text-zinc-900 dark:text-zinc-100">
              {APP_INFO.version}
            </div>

            <div className="text-zinc-500 dark:text-zinc-400">Author</div>
            <a
              href={APP_INFO.author.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              {APP_INFO.author.name}
            </a>

            <div className="text-zinc-500 dark:text-zinc-400">License</div>
            <div className="text-zinc-900 dark:text-zinc-100">
              {APP_INFO.license}
            </div>
          </div>

          {/* Links */}
          <div className="flex flex-wrap gap-2 pt-4 border-t border-zinc-200 dark:border-zinc-700">
            <a
              href={APP_INFO.repository}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-2 text-sm rounded-lg bg-zinc-100 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-600 transition-colors"
            >
              GitHub
            </a>
            <a
              href={APP_INFO.links.changelog}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-2 text-sm rounded-lg bg-zinc-100 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-600 transition-colors"
            >
              Changelog
            </a>
            <a
              href={APP_INFO.links.issues}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-2 text-sm rounded-lg bg-zinc-100 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-600 transition-colors"
            >
              Report Issue
            </a>
          </div>

          {/* Sponsor */}
          <div className="pt-4 border-t border-zinc-200 dark:border-zinc-700">
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3 flex items-center gap-1">
              <GithubSponsorsIcon size={14} className="text-red-500" /> Support
              this project
            </p>
            <div className="flex flex-wrap gap-2">
              <a
                href={APP_INFO.sponsor.momo}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-2 text-sm rounded-lg bg-[#A50064]/10 text-[#A50064] dark:bg-[#A50064]/20 dark:text-[#d64b9a] hover:bg-[#A50064]/20 dark:hover:bg-[#A50064]/30 transition-colors flex items-center gap-1.5"
                title="MoMo"
              >
                <MomoIcon size={16} /> MoMo
              </a>
              <a
                href={APP_INFO.sponsor.github}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-2 text-sm rounded-lg bg-[#db61a2]/10 text-[#db61a2] dark:bg-[#db61a2]/20 dark:text-[#ea8fbe] hover:bg-[#db61a2]/20 dark:hover:bg-[#db61a2]/30 transition-colors flex items-center gap-1.5"
                title="GitHub Sponsors"
              >
                <GithubSponsorsIcon size={16} /> Sponsor
              </a>
              <a
                href={APP_INFO.sponsor.buyMeACoffee}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-2 text-sm rounded-lg bg-[#FFDD00]/20 text-[#a38600] dark:bg-[#FFDD00]/15 dark:text-[#FFDD00] hover:bg-[#FFDD00]/30 dark:hover:bg-[#FFDD00]/25 transition-colors flex items-center gap-1.5"
                title="Buy Me a Coffee"
              >
                <BuyMeACoffeeIcon size={16} /> Coffee
              </a>
            </div>
          </div>
        </div>
      </div>
    </dialog>
  )
}

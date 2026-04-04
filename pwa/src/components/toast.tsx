import { useEffect } from 'react'

interface Props {
  message: string
  onClose: () => void
  duration?: number
}

export function Toast({ message, onClose, duration = 4000 }: Props) {
  useEffect(() => {
    const timer = setTimeout(onClose, duration)
    return () => clearTimeout(timer)
  }, [onClose, duration])

  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-bottom-4 duration-200">
      <div className="bg-zinc-800 dark:bg-zinc-700 text-white text-sm px-4 py-3 rounded-xl shadow-lg max-w-[85vw]">
        {message}
      </div>
    </div>
  )
}

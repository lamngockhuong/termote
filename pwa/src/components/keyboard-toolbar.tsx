import { useState, useCallback } from 'react'

interface Props {
  onKey: (key: string) => void
  onCtrlKey: (key: string) => void
}

const KEYS = [
  { label: 'Tab', key: 'Tab' },
  { label: 'Esc', key: 'Escape' },
  { label: 'Ctrl', key: 'Control', isModifier: true },
  { label: '↑', key: 'ArrowUp' },
  { label: '↓', key: 'ArrowDown' },
  { label: '←', key: 'ArrowLeft' },
  { label: '→', key: 'ArrowRight' },
]

const CTRL_COMBOS = [
  { label: 'C', combo: 'c' },
  { label: 'D', combo: 'd' },
  { label: 'Z', combo: 'z' },
  { label: 'L', combo: 'l' },
  { label: 'A', combo: 'a' },
  { label: 'E', combo: 'e' },
]

export function KeyboardToolbar({ onKey, onCtrlKey }: Props) {
  const [ctrlActive, setCtrlActive] = useState(false)

  const handleKey = useCallback(
    (key: string, isModifier?: boolean) => {
      if (isModifier) {
        setCtrlActive((prev) => !prev)
      } else if (ctrlActive) {
        onCtrlKey(key.toLowerCase())
        setCtrlActive(false)
      } else {
        onKey(key)
      }
    },
    [ctrlActive, onKey, onCtrlKey]
  )

  return (
    <div className="flex items-center gap-1 px-2 py-2 bg-zinc-800 border-t border-zinc-700 overflow-x-auto pb-safe">
      {KEYS.map(({ label, key, isModifier }) => (
        <button
          key={key}
          onClick={() => handleKey(key, isModifier)}
          className={`px-3 py-2 rounded text-sm font-mono min-w-[40px]
            ${isModifier && ctrlActive ? 'bg-blue-600' : 'bg-zinc-700'}
            active:bg-zinc-600 touch-manipulation transition-colors`}
        >
          {label}
        </button>
      ))}

      {ctrlActive && (
        <div className="flex gap-1 ml-2 pl-2 border-l border-zinc-600">
          {CTRL_COMBOS.map(({ label, combo }) => (
            <button
              key={combo}
              onClick={() => handleKey(combo)}
              className="px-3 py-2 rounded text-sm font-mono bg-blue-700 active:bg-blue-600 touch-manipulation"
            >
              ^{label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

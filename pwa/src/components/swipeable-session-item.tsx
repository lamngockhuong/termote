import { Pencil, Trash2 } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import type { Session } from '../types/session'

interface Props {
  session: Session
  isActive: boolean
  onSelect: () => void
  onEdit: () => void
  onRemove: () => void
  canRemove: boolean
  canEdit: boolean
}

const ACTION_WIDTH = 70
const SWIPE_THRESHOLD = 25

export function SwipeableSessionItem({
  session,
  isActive,
  onSelect,
  onEdit,
  onRemove,
  canRemove,
  canEdit,
}: Props) {
  const [offsetX, setOffsetX] = useState(0)
  const [isAnimating, setIsAnimating] = useState(false)
  const touchStartRef = useRef({ x: 0, y: 0, time: 0 })
  const startOffsetRef = useRef(0)
  const isDraggingRef = useRef(false)

  const maxLeft = canRemove ? -ACTION_WIDTH : 0
  const maxRight = canEdit ? ACTION_WIDTH : 0

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0]
      touchStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
      }
      startOffsetRef.current = offsetX
      isDraggingRef.current = false
      setIsAnimating(false)
    },
    [offsetX],
  )

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0]
      const deltaX = touch.clientX - touchStartRef.current.x
      const deltaY = touch.clientY - touchStartRef.current.y

      // Determine if horizontal swipe (only on first significant movement)
      if (!isDraggingRef.current && Math.abs(deltaX) > 10) {
        // If more horizontal than vertical, start dragging
        if (Math.abs(deltaX) > Math.abs(deltaY)) {
          isDraggingRef.current = true
        }
      }

      if (isDraggingRef.current) {
        e.preventDefault() // Prevent scroll when swiping horizontally
        const newOffset = startOffsetRef.current + deltaX
        const clampedOffset = Math.max(
          maxLeft * 1.2,
          Math.min(maxRight * 1.2, newOffset),
        )
        setOffsetX(clampedOffset)
      }
    },
    [maxLeft, maxRight],
  )

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.changedTouches[0]
      const deltaX = touch.clientX - touchStartRef.current.x
      const deltaTime = Date.now() - touchStartRef.current.time
      const velocity = deltaX / deltaTime // px/ms

      setIsAnimating(true)

      if (isDraggingRef.current) {
        // Determine final position
        let finalOffset = 0

        if (velocity < -0.3 && canRemove) {
          finalOffset = maxLeft
        } else if (velocity > 0.3 && canEdit) {
          finalOffset = maxRight
          /* v8 ignore start */
        } else if (offsetX < -SWIPE_THRESHOLD && canRemove) {
          finalOffset = maxLeft
        } else if (offsetX > SWIPE_THRESHOLD && canEdit) {
          finalOffset = maxRight
        }
        /* v8 ignore stop */

        setOffsetX(finalOffset)
      } else {
        // It was a tap
        if (Math.abs(deltaX) < 10) {
          if (offsetX !== 0) {
            setOffsetX(0)
          } else {
            onSelect()
          }
        }
      }

      isDraggingRef.current = false
    },
    [offsetX, maxLeft, maxRight, canRemove, canEdit, onSelect],
  )

  const handleEdit = () => {
    setIsAnimating(true)
    setOffsetX(0)
    setTimeout(onEdit, 100)
  }

  const handleRemove = () => {
    setIsAnimating(true)
    setOffsetX(0)
    setTimeout(onRemove, 100)
  }

  return (
    <div className="relative overflow-hidden isolate">
      {/* Action buttons layer */}
      <div className="absolute inset-0 flex justify-between z-0">
        {canEdit && (
          <button
            onClick={handleEdit}
            className="w-[70px] h-full bg-blue-500 flex items-center justify-center text-white active:bg-blue-600"
          >
            <Pencil size={20} />
          </button>
        )}
        <div className="flex-1" />
        {canRemove && (
          <button
            onClick={handleRemove}
            className="w-[70px] h-full bg-red-500 flex items-center justify-center text-white active:bg-red-600"
          >
            <Trash2 size={20} />
          </button>
        )}
      </div>

      {/* Main content */}
      <div
        className={`relative z-10 bg-zinc-50 dark:bg-zinc-800 ${
          isActive
            ? 'bg-zinc-200 dark:bg-zinc-700 border-l-2 border-blue-500'
            : ''
        }`}
        style={{
          transform: `translateX(${offsetX}px)`,
          transition: isAnimating ? 'transform 200ms ease-out' : 'none',
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div className="p-3 text-left text-zinc-900 dark:text-zinc-50 select-none flex items-center min-w-0">
          <span className="text-xl shrink-0">{session.icon}</span>
          <span className="ml-2 text-sm truncate">{session.name}</span>
        </div>
      </div>
    </div>
  )
}

import { useCallback, useState } from 'react'
import { type LinePick, pickLine } from '../utils/line-range'
import { useMediaQuery } from './use-media-query'

// The lines picked by their gutter numbers: a press picks one line, Shift
// (or, on a touch screen, any press once a line is picked) extends it
export function useLinePick() {
  const coarse = useMediaQuery('(pointer: coarse)')
  const [pick, setPick] = useState<LinePick | null>(null)
  const press = useCallback(
    (group: number, line: number, shift: boolean) =>
      setPick((p) => pickLine(p, group, line, shift || (coarse && !!p))),
    [coarse],
  )
  const clear = useCallback(() => setPick(null), [])
  return { pick, press, clear }
}

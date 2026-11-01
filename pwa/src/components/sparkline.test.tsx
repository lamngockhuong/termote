import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Sparkline, sparkPoints, sparkRuns } from './sparkline'

describe('sparkPoints', () => {
  it('draws fewer values than slots from the right', () => {
    const pts = sparkPoints([0, 100], 180)
    expect(pts).toEqual([
      [178, 40],
      [179, 0],
    ])
  })

  it('clamps values and keeps gaps', () => {
    expect(sparkPoints([150, null, -5], 3)).toEqual([[0, 0], null, [179, 40]])
  })

  it('keeps only the last slots values', () => {
    const values = Array.from({ length: 200 }, (_, i) => i % 100)
    const pts = sparkPoints(values, 180)
    expect(pts).toHaveLength(180)
    expect(pts[0]?.[0]).toBe(0)
    expect(pts[179]?.[0]).toBe(179)
  })
})

describe('sparkRuns', () => {
  it('splits at gaps and gives a lone point a dash', () => {
    const runs = sparkRuns([[0, 1], [1, 2], null, [5, 3]])
    expect(runs).toEqual(['0,1 1,2', '4,3 5,3'])
  })

  it('is empty without values', () => {
    expect(sparkRuns([])).toEqual([])
    expect(sparkRuns([null, null])).toEqual([])
  })
})

describe('Sparkline', () => {
  it('is an image named by its label, one polyline per run', () => {
    const { container } = render(
      <Sparkline values={[10, 20, null, 30]} slots={180} label="CPU line" />,
    )
    expect(screen.getByRole('img', { name: 'CPU line' })).toBeTruthy()
    expect(container.querySelectorAll('polyline')).toHaveLength(2)
  })

  it('draws a full history in one line', () => {
    const values = Array.from({ length: 180 }, (_, i) => i / 2)
    const { container } = render(
      <Sparkline values={values} slots={180} label="RAM" />,
    )
    const lines = container.querySelectorAll('polyline')
    expect(lines).toHaveLength(1)
    expect(lines[0].getAttribute('points')?.split(' ')).toHaveLength(180)
  })

  it('draws nothing but the base line when empty', () => {
    const { container } = render(
      <Sparkline values={[]} slots={180} label="empty" />,
    )
    expect(container.querySelectorAll('polyline')).toHaveLength(0)
  })
})

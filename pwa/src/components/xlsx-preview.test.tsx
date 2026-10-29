import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { DOC_TIMEOUT } from '../utils/document-worker-client'
import type { XlsxReply } from '../utils/xlsx-worker'
import XlsxPreview from './xlsx-preview'

// Stands in for the module worker: ready at once, answers what the test says
class FakeWorker {
  static all: FakeWorker[] = []
  onmessage?: (e: MessageEvent) => void
  onerror?: () => void
  onmessageerror?: () => void
  posted: {
    id: number
    req: { type: string; name?: string; buf?: ArrayBuffer }
  }[] = []
  terminated = false
  constructor(readonly url: URL) {
    FakeWorker.all.push(this)
    queueMicrotask(() => this.send({ ready: true }))
  }
  postMessage(msg: FakeWorker['posted'][number]) {
    this.posted.push(msg)
  }
  send(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data }))
  }
  terminate() {
    this.terminated = true
  }
}

const last = () => FakeWorker.all[FakeWorker.all.length - 1]

// Answers the last request sent to the last worker
async function answer(reply: XlsxReply) {
  const w = last()
  await act(async () => w.send({ id: w.posted[w.posted.length - 1].id, reply }))
}

const sheets = (...names: string[]) =>
  names.map((name) => ({ name, hidden: name.startsWith('hidden') }))

const tsv = (text: string, over = {}) => ({
  text,
  rows: text.split('\n').length - 1,
  truncated: false,
  columnsCut: false,
  ...over,
})

function show(over: Record<string, unknown> = {}) {
  const props = {
    blob: new Blob(['PK']),
    path: 'cases.xlsx',
    onRetry: vi.fn(),
    onDownload: vi.fn(),
    notify: vi.fn(),
    ...over,
  }
  return { props, ...render(<XlsxPreview {...props} />) }
}

// Lets the bytes be read and the worker say it is ready
const settle = () => act(async () => {})

beforeAll(() => import('./table-preview'))
beforeEach(() => {
  FakeWorker.all = []
  vi.stubGlobal('Worker', FakeWorker)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('XlsxPreview', () => {
  it('opens the file in its worker, then reads the first sheet shown', async () => {
    show()
    expect(screen.getByText('Opening…')).toBeDefined()
    await settle()
    const w = last()
    expect(w.url.href).toContain('xlsx-worker')
    expect(w.posted[0].req.type).toBe('open')
    expect(w.posted[0].req.buf?.byteLength).toBe(2)
    await answer({
      type: 'open',
      sheets: sheets('hidden 1', 'Cases', 'Notes', 'hidden 2'),
    })
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Cases',
      'Notes',
    ])
    expect(screen.getByText('2 hidden sheets')).toBeDefined()
    expect(screen.getByText('Reading the sheet…')).toBeDefined()
    expect(w.posted[1].req).toEqual({ type: 'sheet', name: 'Cases' })
    await answer({
      type: 'sheet',
      tsv: tsv('Case\tResult\n2\t4\n'),
      totalRows: 2,
    })
    expect(await screen.findByText('Result')).toBeDefined()
    expect(screen.queryByRole('banner')).toBeNull()
  })

  it('reads another sheet when its tab is picked, each once', async () => {
    show()
    await settle()
    await answer({ type: 'open', sheets: sheets('A', 'B', 'hidden') })
    expect(screen.getByText('1 hidden sheet')).toBeDefined()
    await answer({ type: 'sheet', tsv: tsv('a\n'), totalRows: 1 })
    // A layout change is kept for the sheet
    fireEvent.click(await screen.findByRole('button', { name: 'Header row' }))
    fireEvent.click(screen.getByRole('tab', { name: 'B' }))
    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await answer({ type: 'sheet', tsv: tsv('b\n'), totalRows: 1 })
    fireEvent.click(screen.getByRole('tab', { name: 'A' }))
    fireEvent.click(screen.getByRole('tab', { name: 'B' }))
    expect(last().posted.map((p) => p.req.name ?? p.req.type)).toEqual([
      'open',
      'A',
      'B',
    ])
  })

  it('moves between tabs with the arrow keys, Home and End', async () => {
    show()
    await settle()
    await answer({ type: 'open', sheets: sheets('A', 'B', 'C') })
    const tab = (n: string) => screen.getByRole('tab', { name: n })
    const list = screen.getByRole('tablist')
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tab('B'))
    fireEvent.keyDown(list, { key: 'End' })
    expect(tab('C')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tab('A'))
    fireEvent.keyDown(list, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(tab('C'))
    fireEvent.keyDown(list, { key: 'Home' })
    expect(document.activeElement).toBe(tab('A'))
    fireEvent.keyDown(list, { key: 'x' })
    expect(tab('A')).toHaveAttribute('tabindex', '0')
  })

  it('says a sheet was cut, with Download for the full one', async () => {
    const { props } = show()
    await settle()
    await answer({ type: 'open', sheets: sheets('Big', 'Wide') })
    await answer({
      type: 'sheet',
      tsv: tsv('a\nb\n', { truncated: true }),
      totalRows: 50000,
    })
    expect(
      screen.getByText(
        'Showing the first 2 rows of 50000: download for the full sheet',
      ),
    ).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(props.onDownload).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: 'Wide' }))
    await answer({
      type: 'sheet',
      tsv: tsv('a\n', { columnsCut: true }),
      totalRows: 1,
    })
    expect(
      screen.getByText(
        'Showing the first 200 columns: download for the full sheet',
      ),
    ).toBeDefined()
  })

  it('says columns were cut without Download for a view-only device', async () => {
    show({ onDownload: undefined })
    await settle()
    await answer({ type: 'open', sheets: sheets('Wide') })
    await answer({
      type: 'sheet',
      tsv: tsv('a\n', { columnsCut: true }),
      totalRows: 1,
    })
    expect(screen.getByText('Showing the first 200 columns')).toBeDefined()
  })

  it('says a sheet was cut without Download for a view-only device', async () => {
    show({ onDownload: undefined })
    await settle()
    await answer({ type: 'open', sheets: sheets('Big') })
    await answer({
      type: 'sheet',
      tsv: tsv('a\n', { truncated: true }),
      totalRows: 9,
    })
    expect(screen.getByText('Showing the first 1 rows of 9')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
  })

  it('says why a file cannot be read', async () => {
    show()
    await settle()
    await answer({ type: 'error', code: 'too_big' })
    expect(screen.getByText('Too large to preview once unpacked')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('takes an unexpected answer to open as a failure', async () => {
    show()
    await settle()
    await answer({ type: 'sheet', tsv: tsv(''), totalRows: 0 })
    expect(screen.getByText(/could not be read/)).toBeDefined()
  })

  it('says why a sheet cannot be read, keeping its tabs', async () => {
    show()
    await settle()
    await answer({ type: 'open', sheets: sheets('A', 'B') })
    await answer({ type: 'error', code: 'failed' })
    expect(screen.getByText(/could not be read/)).toBeDefined()
    fireEvent.click(screen.getByRole('tab', { name: 'B' }))
    await answer({ type: 'open', sheets: [] })
    expect(screen.getAllByText(/could not be read/)).toHaveLength(1)
    expect(screen.getAllByRole('tab')).toHaveLength(2)
  })

  it('says when every sheet is hidden', async () => {
    show()
    await settle()
    await answer({ type: 'open', sheets: sheets('hidden') })
    expect(screen.getByText('Every sheet is hidden')).toBeDefined()
  })

  it('opens the file again from its bytes after the worker took too long', async () => {
    vi.useFakeTimers()
    const { props } = show()
    await settle()
    await answer({ type: 'open', sheets: sheets('A') })
    await act(async () => vi.advanceTimersByTime(DOC_TIMEOUT))
    expect(screen.getByText('Took too long to open')).toBeDefined()
    expect(FakeWorker.all[0].terminated).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()
    // A new worker, from the same bytes: the server is not asked again
    expect(FakeWorker.all).toHaveLength(2)
    expect(props.onRetry).not.toHaveBeenCalled()
    await answer({ type: 'open', sheets: sheets('A') })
    expect(last().posted[1].req).toEqual({ type: 'sheet', name: 'A' })
  })

  it('ends its worker when closed, dropping late answers', async () => {
    const { unmount } = show()
    await settle()
    await answer({ type: 'open', sheets: sheets('A') })
    const w = last()
    unmount()
    expect(w.terminated).toBe(true)
  })

  it('drops the answer of a file replaced since', async () => {
    const { rerender, props } = show()
    await settle()
    await answer({ type: 'open', sheets: sheets('A') })
    const first = last()
    const id = first.posted[1].id
    rerender(<XlsxPreview {...props} blob={new Blob(['PK2'])} />)
    // Too late: the first worker was ended with its file
    await act(async () =>
      first.send({
        id,
        reply: { type: 'sheet', tsv: tsv('old\n'), totalRows: 1 },
      }),
    )
    await settle()
    expect(first.terminated).toBe(true)
    expect(screen.getByText('Opening…')).toBeDefined()
  })

  it('tells a worker that broke while opening', async () => {
    show()
    await settle()
    await act(async () => last().onerror?.())
    expect(screen.getByText('The viewer stopped')).toBeDefined()
  })
})

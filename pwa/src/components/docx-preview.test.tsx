import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOC_TIMEOUT } from '../utils/document-worker-client'
import type { DocChild } from '../utils/docx-sanitize'
import type { DocxReply } from '../utils/docx-worker'
import DocxPreview, { renderDocTree } from './docx-preview'

// Stands in for the module worker: ready at once, answers what the test says
class FakeWorker {
  static all: FakeWorker[] = []
  onmessage?: (e: MessageEvent) => void
  onerror?: () => void
  onmessageerror?: () => void
  posted: { id: number; req: { type: string; buf: ArrayBuffer } }[] = []
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

async function answer(reply: DocxReply) {
  const w = last()
  await act(async () => w.send({ id: w.posted[0].id, reply }))
}

const PNG = 'data:image/png;base64,iVBORw0KGgo='

const doc = (tree: DocChild[], over = {}): DocxReply => ({
  type: 'doc',
  tree,
  truncated: false,
  imagesOmitted: 0,
  ...over,
})

function show(over: Record<string, unknown> = {}) {
  const props = {
    blob: new Blob(['PK']),
    path: 'memo.docx',
    onRetry: vi.fn(),
    onDownload: vi.fn(),
    notify: vi.fn(),
    ...over,
  }
  return { props, ...render(<DocxPreview {...props} />) }
}

const settle = () => act(async () => {})

beforeEach(() => {
  FakeWorker.all = []
  vi.stubGlobal('Worker', FakeWorker)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('DocxPreview', () => {
  it('converts the file in its worker and shows the document', async () => {
    show()
    expect(screen.getByText('Opening…')).toBeDefined()
    await settle()
    expect(last().url.href).toContain('docx-worker')
    expect(last().posted[0].req.type).toBe('convert')
    expect(last().posted[0].req.buf.byteLength).toBe(2)
    await answer(
      doc([
        { t: 'h1', c: ['Spec'] },
        {
          t: 'table',
          c: [
            {
              t: 'tr',
              c: [
                { t: 'td', a: { colspan: 2, rowspan: 3 }, c: ['m'] },
                { t: 'th', c: ['h'] },
              ],
            },
          ],
        },
        {
          t: 'p',
          c: [
            'a',
            { t: 'br' },
            { t: 'a', a: { href: 'https://example.com/' }, c: ['link'] },
          ],
        },
        { t: 'img', a: { src: PNG, alt: 'logo' } },
        { t: 'img', a: { src: PNG } },
      ]),
    )
    expect(
      screen.getByRole('heading', { level: 1, name: 'Spec' }),
    ).toBeDefined()
    const cell = screen.getByRole('cell', { name: 'm' })
    expect(cell).toHaveAttribute('colspan', '2')
    expect(cell).toHaveAttribute('rowspan', '3')
    expect(cell.closest('div')).toHaveClass('overflow-x-auto')
    const link = screen.getByRole('link', { name: 'link' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow')
    expect(screen.getByRole('img', { name: 'logo' })).toHaveAttribute(
      'src',
      PNG,
    )
    expect(screen.queryByRole('banner')).toBeNull()
  })

  it('never changes the location hash when a link is clicked', async () => {
    window.location.hash = '#files'
    show()
    await settle()
    await answer(
      doc([{ t: 'a', a: { href: 'https://example.com/' }, c: ['out'] }]),
    )
    const link = screen.getByRole('link', { name: 'out' })
    link.addEventListener('click', (e) => e.preventDefault())
    fireEvent.click(link)
    expect(window.location.hash).toBe('#files')
  })

  it('says what was cut, with Download', async () => {
    const { props } = show()
    await settle()
    await answer(
      doc([{ t: 'p', c: ['x'] }], { truncated: true, imagesOmitted: 2 }),
    )
    expect(
      screen.getByText('Too long to show in full; 2 images not shown'),
    ).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(props.onDownload).toHaveBeenCalled()
  })

  it('says one image was not shown, without Download for a view-only device', async () => {
    show({ onDownload: undefined })
    await settle()
    await answer(doc([], { imagesOmitted: 1 }))
    expect(screen.getByText('1 image not shown')).toBeDefined()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says why a file cannot be read', async () => {
    show()
    await settle()
    await answer({ type: 'error', code: 'corrupt' })
    expect(screen.getByText(/could not be read/)).toBeDefined()
  })

  it('converts again from its bytes after the worker took too long', async () => {
    vi.useFakeTimers()
    const { props } = show()
    await settle()
    await act(async () => vi.advanceTimersByTime(DOC_TIMEOUT))
    expect(screen.getByText('Took too long to open')).toBeDefined()
    expect(FakeWorker.all[0].terminated).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()
    expect(FakeWorker.all).toHaveLength(2)
    expect(props.onRetry).not.toHaveBeenCalled()
  })

  it('ends its worker when closed, dropping its answer', async () => {
    const { unmount } = show()
    await settle()
    const w = last()
    unmount()
    expect(w.terminated).toBe(true)
  })
})

describe('renderDocTree', () => {
  function html(tree: DocChild[]) {
    const { container } = render(<div>{renderDocTree(tree)}</div>)
    return (container.firstChild as HTMLElement).innerHTML
  }

  it('checks every tag and attribute again', () => {
    expect(
      html([
        { t: 'script' as never, c: ['alert(1)'] },
        { t: 'a', a: { href: 'javascript:alert(1)' }, c: ['text only'] },
        { t: 'a', c: ['no href'] },
        { t: 'a', a: { href: 'vbscript:x' } },
        { t: 'img', a: { src: 'https://x/y.png' } },
        { t: 'img' },
        { t: 'td', a: { colspan: 1, rowspan: 1e9 } },
        { t: 'th', a: { colspan: 1.5, rowspan: 1000 } },
        { t: 'p' },
      ]),
    ).toBe(
      'text onlyno href[image omitted][image omitted]<td></td><th rowspan="1000"></th><p></p>',
    )
  })
})

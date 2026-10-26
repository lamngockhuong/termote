import { describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { docx, image, PNG, p } from '../../e2e/fixtures/docs/office'
import type { DocChild } from './docx-sanitize'
import { DOCX_MAX_IMAGES, handleDocx } from './docx-worker'

// The worker's global scope, in place of the page's before the module loads
const scope = vi.hoisted(() => {
  const posted: unknown[] = []
  const s = {
    posted,
    onmessage: null as ((e: MessageEvent) => Promise<void>) | null,
    postMessage: (msg: unknown) => posted.push(msg),
    // A worker has it: jszip's setImmediate does not take posted messages
    importScripts: () => {},
  }
  ;(globalThis as { self: unknown }).self = s
  return s
})

async function convert(buf: ArrayBuffer) {
  return (await handleDocx({ type: 'convert', buf })).reply
}

const text = (tree: DocChild[]): string =>
  tree.map((n) => (typeof n === 'string' ? n : text(n.c ?? []))).join('')

describe('docx worker', () => {
  it('serves requests in its scope once loaded', async () => {
    expect(scope.posted).toEqual([{ ready: true }])
    await scope.onmessage?.(
      new MessageEvent('message', {
        data: { id: 1, req: { type: 'convert', buf: new ArrayBuffer(4) } },
      }),
    )
    expect(scope.posted[1]).toEqual({
      id: 1,
      reply: { type: 'error', code: 'corrupt' },
    })
  })

  it('converts headings, tables, links and images to allowed nodes', async () => {
    const r = await convert(
      docx(
        `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Spec &amp; &lt;notes&gt;</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${p('merged')}</w:tc></w:tr><w:tr><w:tc>${p('a')}</w:tc><w:tc>${p('b')}</w:tc></w:tr></w:tbl>
<w:p><w:hyperlink r:id="rBad"><w:r><w:t>bad</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> </w:t></w:r><w:hyperlink w:anchor="top"><w:r><w:t>anchor</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> </w:t></w:r><w:hyperlink r:id="rGood"><w:r><w:t>good</w:t></w:r></w:hyperlink></w:p>
${image('rImg0')}${image('rImg1')}`,
        { 'image1.png': PNG, 'image2.emf': new Uint8Array([1, 2, 3]) },
      ),
    )
    if (r.type !== 'doc') throw new Error(JSON.stringify(r))
    expect(r.truncated).toBe(false)
    expect(r.imagesOmitted).toBe(1)
    expect(r.tree[0]).toEqual({ t: 'h1', c: ['Spec & <notes>'] })
    expect(r.tree[1]).toMatchObject({
      t: 'table',
      c: [
        { t: 'tr', c: [{ t: 'td', a: { colspan: 2 } }] },
        { t: 'tr', c: [{ t: 'td' }, { t: 'td' }] },
      ],
    })
    expect(r.tree[2]).toEqual({
      t: 'p',
      c: [
        'bad',
        ' ',
        'anchor',
        ' ',
        { t: 'a', a: { href: 'https://example.com/spec' }, c: ['good'] },
      ],
    })
    expect(r.tree[3]).toEqual({
      t: 'p',
      c: [
        {
          t: 'img',
          a: {
            src: expect.stringMatching(/^data:image\/png;base64,iVBOR/),
            alt: 'pic',
          },
        },
      ],
    })
    expect(text([r.tree[4]])).toBe('[image omitted]')
  })

  it('omits images past the limit', async () => {
    const big = new Uint8Array(DOCX_MAX_IMAGES - 10)
    big.set(PNG)
    const r = await convert(
      docx(`${image('rImg0')}${image('rImg1')}`, {
        'big.png': big,
        'small.png': PNG,
      }),
    )
    expect(r).toMatchObject({ type: 'doc', imagesOmitted: 1 })
  }, 30000)

  it('fails a zip that is no Word document, without its error', async () => {
    const cfb = XLSX.CFB.utils.cfb_new({ fileType: 'zip' } as never)
    XLSX.CFB.utils.cfb_add(cfb, 'readme.txt', new TextEncoder().encode('hi'))
    // CFB writes a plain array of bytes
    const zip = new Uint8Array(
      XLSX.CFB.write(cfb, { type: 'array', fileType: 'zip' }),
    ).buffer
    expect(await convert(zip)).toEqual({
      type: 'error',
      code: 'failed',
    })
  })
})

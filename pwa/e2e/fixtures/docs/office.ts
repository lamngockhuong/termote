// Office files for the document preview tests (unit and E2E), written in
// code: a .docx laid out part by part as Word saves one, and workbooks
// through SheetJS.
import * as XLSX from 'xlsx'

// A 1×1 PNG
export const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
)

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const PIC =
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'

export const image = (rel: string) =>
  `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="p" descr="pic"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${rel}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`

// A .docx of body (WordprocessingML) and media, as a zip of its parts
export function docx(
  body: string,
  media: Record<string, Uint8Array> = {},
): ArrayBuffer {
  const cfb = XLSX.CFB.utils.cfb_new({ fileType: 'zip' } as never)
  const add = (name: string, data: string | Uint8Array) =>
    XLSX.CFB.utils.cfb_add(
      cfb,
      name,
      typeof data === 'string' ? new TextEncoder().encode(data) : data,
    )
  add(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="emf" ContentType="image/x-emf"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
  )
  add(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  )
  add(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rBad" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>
<Relationship Id="rGood" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/spec" TargetMode="External"/>
${Object.keys(media)
  .map(
    (name, i) =>
      `<Relationship Id="rImg${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`,
  )
  .join('')}</Relationships>`,
  )
  add(
    'word/styles.xml',
    `<?xml version="1.0"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
  )
  add(
    'word/document.xml',
    `<?xml version="1.0"?><w:document ${W} ${PIC}><w:body>${body}</w:body></w:document>`,
  )
  for (const [name, data] of Object.entries(media))
    add(`word/media/${name}`, data)
  return new Uint8Array(XLSX.CFB.write(cfb, { type: 'array', fileType: 'zip' }))
    .buffer
}

export const p = (text: string) =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`


// A workbook as Excel saves one: two sheets, a formula with its value, a
// hidden third sheet
export function workbook(): ArrayBuffer {
  const wb = XLSX.utils.book_new()
  const cases = XLSX.utils.aoa_to_sheet([
    ['Case', 'Input', 'Expected'],
    ['TC-001', 21, null],
  ])
  cases.C2 = { t: 'n', v: 42, f: 'B2*2' }
  XLSX.utils.book_append_sheet(wb, cases, 'Cases')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Owner', 'QA team']]), 'Notes')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['hidden']]), 'Secret')
  wb.Workbook = { Sheets: [{}, {}, { Hidden: 1 }] }
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
}

// One sheet whose cells make more than 1 MiB of text
export function bigWorkbook(rows = 30_000): ArrayBuffer {
  const wb = XLSX.utils.book_new()
  const data = Array.from({ length: rows }, (_, i) => [`row ${i}`, 'x'.repeat(40)])
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), 'Big')
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
}

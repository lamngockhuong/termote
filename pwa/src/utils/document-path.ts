// Files shown as a document preview (files/document): a PDF, an Excel
// workbook or a Word document. The name only picks the view: the server
// checks the file's bytes.
export type DocumentKind = 'pdf' | 'xlsx' | 'docx'

export function isDocumentPath(path: string): DocumentKind | undefined {
  const m = /\.(pdf|xlsx|docx)$/i.exec(path)
  return m ? (m[1].toLowerCase() as DocumentKind) : undefined
}

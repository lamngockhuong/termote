# Document preview fixtures

Files for `e2e/document-preview.spec.ts` and the viewers' unit tests.

| File           | What it checks                                                            |
| -------------- | ------------------------------------------------------------------------- |
| `pages.pdf`    | Three pages of Helvetica text; "zebra" only on page 3 (find, lazy pages)  |
| `japanese.pdf` | CJK text through the `UniJIS-UCS2-H` character map (`cMapUrl`)            |
| `jpx.pdf`      | A red JPEG 2000 image, decoded by pdf.js's JS fallback (`useWasm: false`) |
| `office.ts`    | Builds a `.docx` part by part and workbooks through SheetJS, at test time |

The PDFs are written by `make-pdfs.py` (JPEG 2000 needs Pillow built with OpenJPEG):

```sh
python3 make-pdfs.py pwa/e2e/fixtures/docs
```

The spec also writes, into its throwaway repo, a password-protected workbook (an OLE compound
file header) and a sparse 31 MiB PDF, neither kept here.

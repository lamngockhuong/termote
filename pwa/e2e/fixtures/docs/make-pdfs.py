"""Writes the PDF fixtures of the document preview tests.

    python3 make_pdfs.py <out dir>

pages.pdf: three pages of Helvetica text (a standard font pdf.js fetches);
japanese.pdf: CJK text through the UniJIS-UCS2-H character map (fetched);
jpx.pdf: a JPEG 2000 image (decoded by pdf.js's fallback without WebAssembly),
which needs Pillow built with OpenJPEG.
"""

import io
import sys
from pathlib import Path


def pdf(objects):
    """A PDF of objects (bytes each, numbered from 1, the catalog first)."""
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


def stream(data, extra=b""):
    return b"<< /Length %d %s>>\nstream\n" % (len(data), extra) + data + b"\nendstream"


def pages_pdf():
    texts = [b"Page one of the spec", b"Page two: requirements", b"Page three holds the zebra crossing"]
    n = len(texts)
    # 1 catalog, 2 pages, 3 font, then a page and its contents for each
    kids = b" ".join(b"%d 0 R" % (4 + 2 * i) for i in range(n))
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [%s] /Count %d >>" % (kids, n),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for i, t in enumerate(texts):
        objs.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>" % (5 + 2 * i)
        )
        objs.append(stream(b"BT /F1 24 Tf 72 700 Td (%s) Tj ET" % t))
    return pdf(objs)


def japanese_pdf():
    # 日本語のテスト in UCS-2 big endian
    text = "日本語のテスト".encode("utf-16-be").hex().upper().encode()
    return pdf([
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>",
        b"<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPro-Regular "
        b"/Encoding /UniJIS-UCS2-H /DescendantFonts [5 0 R] >>",
        b"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPro-Regular "
        b"/CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> "
        b"/FontDescriptor 7 0 R >>",
        stream(b"BT /F1 32 Tf 72 700 Td <%s> Tj ET" % text),
        b"<< /Type /FontDescriptor /FontName /KozMinPro-Regular /Flags 6 "
        b"/FontBBox [0 -120 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 "
        b"/CapHeight 740 /StemV 80 >>",
    ])


def jpx_pdf():
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (64, 64), (200, 30, 30)).save(buf, "JPEG2000")
    jpx = buf.getvalue()
    return pdf([
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
        stream(jpx, b"/Type /XObject /Subtype /Image /Width 64 /Height 64 /Filter /JPXDecode "),
        stream(b"q 400 0 0 400 100 300 cm /Im1 Do Q"),
    ])


if __name__ == "__main__":
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    (out / "pages.pdf").write_bytes(pages_pdf())
    (out / "japanese.pdf").write_bytes(japanese_pdf())
    (out / "jpx.pdf").write_bytes(jpx_pdf())

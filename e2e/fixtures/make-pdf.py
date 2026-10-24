"""Writes a one-page PDF whose only text is 'PDF SECRET 77'."""
import sys

stream = b"BT /F1 32 Tf 40 100 Td (PDF SECRET 77) Tj ET"
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]
out = bytearray(b"%PDF-1.4\n")
offsets = []
for number, body in enumerate(objects, 1):
    offsets.append(len(out))
    out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
xref = len(out)
out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
for offset in offsets:
    out += b"%010d 00000 n \n" % offset
out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
open(sys.argv[1], "wb").write(out)

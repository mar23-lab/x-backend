// pdf-extraction.test.ts · P1.2 (260629) — guards the unpdf in-isolate PDF text-extraction integration
// that documents.ts uses so a customer's uploaded PDF becomes answerable by the chief-of-staff (Plane C).
// Self-contained: builds a real born-digital PDF in-test (no fixture file) and runs the EXACT unpdf API the
// route uses (getDocumentProxy + extractText). A regression in the unpdf wiring or a bundler break fails here.

import { describe, it, expect } from 'vitest';

/** Build a minimal, valid, born-digital PDF containing `text` (Helvetica). pdf.js parses it. */
function minimalPdf(text: string): Uint8Array {
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => { pdf += `${String(off).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

describe('unpdf PDF text extraction (P1.2 · documents.ts integration)', () => {
  it('extracts the real text from a born-digital PDF (the chief-of-staff can answer FROM it)', async () => {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(minimalPdf('Hello Xlooop PDF grounding works'));
    const { text } = await extractText(pdf, { mergePages: true });
    const joined = Array.isArray(text) ? text.join('\n') : String(text || '');
    expect(joined).toContain('Hello Xlooop PDF grounding works');
  });

  it('a non-PDF / garbage buffer rejects (route catches it → extracted_text stays null, never fabricated)', async () => {
    const { getDocumentProxy } = await import('unpdf');
    await expect(getDocumentProxy(new TextEncoder().encode('this is not a pdf'))).rejects.toBeTruthy();
  });
});

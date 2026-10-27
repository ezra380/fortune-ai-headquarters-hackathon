import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream, type PDFPage } from 'pdf-lib';

// Reads the words back out of a PDF this package wrote, page by page, so a test can check what a person would
// read. pdf-lib draws standard-font text as hex strings (<48656c6c6f> Tj), one per line of the layout.

function contentOf(page: PDFPage): string {
  const entry = page.node.Contents();
  const streams = entry instanceof PDFArray ? entry.asArray().map((ref) => page.doc.context.lookup(ref)) : [entry];
  return streams
    .map((stream) => (stream instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1') : ''))
    .join('\n');
}

export async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map((page) => {
    const hex = [...contentOf(page).matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)];
    return hex.map((m) => Buffer.from(m[1]!, 'hex').toString('latin1')).join(' ');
  });
}

export const pdfText = async (bytes: Uint8Array): Promise<string> => (await pdfPages(bytes)).join(' ');


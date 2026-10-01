import * as pdfjs from './vendor/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', import.meta.url).href;
const MAX_PDF_BYTES = 10_000_000;
const MAX_TEXT_CHARS = 50_000;

function assertPdf(blob) {
  if (!(blob instanceof Blob) || blob.type !== 'application/pdf' || !blob.size || blob.size > MAX_PDF_BYTES)
    throw new Error('Per estrarre il testo serve un PDF privato valido da massimo 10 MB.');
}

/** Read an embedded text layer in this browser; PDF page numbers remain auditable. */
export async function extractPdfText(blob, { maxPages = 24 } = {}) {
  assertPdf(blob);
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), useSystemFonts: true });
  try {
    const document = await task.promise;
    const total = Math.min(document.numPages, maxPages);
    const pages = [];
    let length = 0;
    for (let number = 1; number <= total; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map((item) => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
      if (text) { pages.push({ page: number, source: `pagina ${number} del PDF`, text: text.slice(0, MAX_TEXT_CHARS - length) }); length += text.length; }
      if (length >= MAX_TEXT_CHARS) break;
    }
    return { text: pages.map((item) => `[PDF pagina ${item.page}] ${item.text}`).join('\n'), pages,
      pageCount: document.numPages, needsOcr: pages.length === 0,
      warnings: [...(document.numPages > total ? [`Analizzate solo ${total} di ${document.numPages} pagine.`] : []),
        ...(pages.length === 0 ? ['PDF senza testo selezionabile: serve OCR o trascrizione manuale, non dedurre dati.'] : []),
        ...(length >= MAX_TEXT_CHARS ? ['Testo troncato a 50.000 caratteri.'] : [])] };
  } finally { await task.destroy().catch(() => {}); }
}

/** Render scanned pages locally for an explicit, reviewed image-OCR request. No network. */
export async function rasterizePdfPages(blob, { maxPages = 8, maxWidth = 1400 } = {}) {
  assertPdf(blob);
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), useSystemFonts: true });
  try {
    const pdfDocument = await task.promise;
    const rendered = [];
    for (let number = 1; number <= Math.min(pdfDocument.numPages, maxPages); number += 1) {
      const page = await pdfDocument.getPage(number);
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, maxWidth / natural.width) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Canvas OCR non disponibile.');
      await page.render({ canvasContext: context, viewport }).promise;
      const image = await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Pagina non leggibile.')), 'image/png'));
      if (image.size > 3_000_000) throw new Error(`Pagina ${number}: immagine OCR troppo grande.`);
      rendered.push({ page: number, mime: 'image/png', bytes: new Uint8Array(await image.arrayBuffer()) });
      canvas.width = 0; canvas.height = 0;
    }
    return { pages: rendered, totalPages: pdfDocument.numPages,
      warnings: pdfDocument.numPages > rendered.length ? ['Pagine rimanenti non inviate: seleziona un secondo lotto per la revisione.'] : [] };
  } finally { await task.destroy().catch(() => {}); }
}

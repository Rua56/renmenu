import * as pdfjs from './vendor/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', import.meta.url).href;

/** Local, read-only PDF rendering. The source bytes never leave this browser tab. */
export async function mountPdfPreview(blob, container) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data: bytes, useSystemFonts: true });
  const pdfDocument = await loadingTask.promise;
  let pageNumber = 1;
  let zoom = 1;
  let rendering = null;
  let disposed = false;

  const panel = document.createElement('div');
  panel.className = 'pdf-preview-panel';
  const controls = document.createElement('div');
  controls.className = 'pdf-preview-controls';
  const previous = document.createElement('button');
  const next = document.createElement('button');
  const smaller = document.createElement('button');
  const larger = document.createElement('button');
  const indicator = document.createElement('output');
  for (const [button, label] of [[previous, 'Pagina precedente'], [next, 'Pagina successiva'],
    [smaller, 'Riduci zoom PDF'], [larger, 'Aumenta zoom PDF']]) {
    button.type = 'button'; button.className = 'button secondary small-button';
    button.textContent = label; controls.append(button);
  }
  indicator.setAttribute('role', 'status');
  controls.insertBefore(indicator, smaller);
  panel.append(controls);
  const canvasArea = document.createElement('div');
  canvasArea.className = 'pdf-preview-canvas-area';
  const canvas = document.createElement('canvas');
  canvas.className = 'pdf-preview-canvas';
  canvas.setAttribute('aria-label', 'Pagina PDF privata');
  canvasArea.append(canvas); panel.append(canvasArea);
  container.replaceChildren(panel);

  async function paint() {
    if (disposed) return;
    if (rendering) { rendering.cancel(); try { await rendering.promise; } catch (_) { /* cancel precedente */ } rendering = null; }
    if (disposed) return;
    const page = await pdfDocument.getPage(pageNumber);
    const width = page.getViewport({ scale: 1 }).width;
    const fit = Math.min(1.5, Math.max(.2, (canvasArea.clientWidth - 20) / width));
    const viewport = page.getViewport({ scale: fit * zoom });
    const pixels = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(viewport.width * pixels);
    canvas.height = Math.floor(viewport.height * pixels);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const context = canvas.getContext('2d', { alpha: false });
    rendering = page.render({ canvasContext: context, viewport,
      transform: pixels === 1 ? null : [pixels, 0, 0, pixels, 0, 0] });
    try { await rendering.promise; } catch (error) { if (error.name !== 'RenderingCancelledException') throw error; }
    finally { rendering = null; }
    if (!disposed) {
      indicator.textContent = `Pagina ${pageNumber} di ${pdfDocument.numPages} · ${Math.round(zoom * 100)}%`;
      previous.disabled = pageNumber === 1; next.disabled = pageNumber === pdfDocument.numPages;
      smaller.disabled = zoom <= .65; larger.disabled = zoom >= 2;
    }
  }
  previous.addEventListener('click', () => { pageNumber = Math.max(1, pageNumber - 1); paint().catch(console.error); });
  next.addEventListener('click', () => { pageNumber = Math.min(pdfDocument.numPages, pageNumber + 1); paint().catch(console.error); });
  smaller.addEventListener('click', () => { zoom = Math.max(.65, Math.round((zoom - .25) * 100) / 100); paint().catch(console.error); });
  larger.addEventListener('click', () => { zoom = Math.min(2, Math.round((zoom + .25) * 100) / 100); paint().catch(console.error); });
  await paint();
  return { destroy() { disposed = true; rendering?.cancel(); loadingTask.destroy().catch(() => {}); } };
}

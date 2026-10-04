// Foto pubbliche dei menu Premium: GET /jarvis-hook/media/<sha256>.<jpg|webp|png> (fuori da
// Cloudflare Access, come gli altri ingressi pubblici di Jarvis).
// Si serve SOLO una foto confermata da Riccardo in Revisione (media_items.status='confermata'):
// l'originale del cliente resta privato in R2; qui c'è solo la copia ridotta che ha scelto lui.
// Serve all'anteprima del menu su renmenu.pages.dev prima della pubblicazione.
import { PUBLIC_FILE } from './media.js';

const TYPES = { jpg: 'image/jpeg', webp: 'image/webp', png: 'image/png' };
const notFound = () => new Response('Non trovato.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });

export async function serveMedia(request, env, file) {
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') return notFound();
  const match = PUBLIC_FILE.exec(String(file || ''));
  if (!match || !env?.DB?.prepare || !env?.BUCKET?.get) return notFound();
  const key = `public/media/${match[1]}.${match[2]}`;
  let row = null;
  try { row = await env.DB.prepare("SELECT id FROM media_items WHERE public_sha=? AND public_key=? AND status='confermata' LIMIT 1").bind(match[1], key).first(); }
  catch { row = null; }
  if (!row) return notFound();
  const object = await env.BUCKET.get(key);
  if (!object) return notFound();
  return new Response(method === 'HEAD' ? null : object.body, { headers: {
    'Content-Type': TYPES[match[2]], 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'X-Robots-Tag': 'noindex'
  } });
}

import { verifyOwner } from './_lib/auth.js';

const privateHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:"
};

export async function onRequest(context) {
  const path = new URL(context.request.url).pathname;
  if (!/^\/control-room(?:\/|$)/.test(path)) return context.next();
  if (!await verifyOwner(context.request, context.env)) {
    return new Response('Area riservata. Accesso negato.', {
      status: 403,
      headers: { ...privateHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
  const response = await context.next();
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(privateHeaders)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

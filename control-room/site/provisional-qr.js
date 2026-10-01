import qrcode from './vendor/qrcode.mjs';

const STAGING_ORIGIN = 'https://renmenu-jarvis-stage.pages.dev';
const isPrivatePreviewHost = (host) => host === 'localhost' || host === '127.0.0.1'
  || /^renmenu-jarvis-stage(?:-[a-z0-9]{4,})?\.pages\.dev$/.test(host)
  || /^[a-z0-9-]+\.renmenu-jarvis-stage\.pages\.dev$/.test(host);

/** An owner-only preview, never the live customer /menu/?m= URL. */
export function provisionalTarget(slug, pageOrigin = globalThis.location?.origin || STAGING_ORIGIN) {
  if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64)
    throw new Error('Menu ID non valido per il QR provvisorio.');
  const origin = new URL(pageOrigin);
  if (!isPrivatePreviewHost(origin.hostname) || (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))))
    throw new Error('Anteprima disponibile soltanto su staging privato o in locale.');
  return new URL(`/control-room/preview/?m=${encodeURIComponent(slug)}&draft=1`, origin).href;
}

export function provisionalQrSvg(slug, pageOrigin) {
  const code = qrcode(0, 'M');
  code.addData(provisionalTarget(slug, pageOrigin));
  code.make();
  return code.createSvgTag(4, 4, 'QR di anteprima privata', 'QR provvisorio RenMenu');
}

import qrcode from './vendor/qrcode.mjs';

// This route is intentionally NOT included in the public build. It does not open
// /menu/?m= and therefore cannot be confused with a customer's existing live QR.
export function provisionalTarget(slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64)
    throw new Error('Menu ID non valido per il QR provvisorio.');
  return `https://renmenu.pages.dev/control-room/preview/?m=${encodeURIComponent(slug)}&draft=1`;
}

export function provisionalQrSvg(slug) {
  const code = qrcode(0, 'M');
  code.addData(provisionalTarget(slug));
  code.make();
  // Fixed plain-text labels, no client-controlled SVG attributes. The URL is in
  // the QR matrix, never in HTML attributes or an external QR-generation API.
  return code.createSvgTag(4, 4, 'QR di anteprima non attiva', 'QR provvisorio RenMenu');
}

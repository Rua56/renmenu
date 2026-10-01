import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { provisionalQrSvg, provisionalTarget } from '../site/provisional-qr.js';

describe('QR provvisorio, senza rete', () => {
  it('codifica una destinazione preview non attiva e non un menu pubblico', () => {
    const target = provisionalTarget('ristorante-di-prova');
    assert.equal(target, 'https://renmenu-jarvis-stage.pages.dev/control-room/preview/?m=ristorante-di-prova&draft=1');
    assert.doesNotMatch(target, /\/menu\/\?m=/);
    assert.throws(() => provisionalTarget('ristorante-di-prova', 'https://renmenu.pages.dev'), /staging privato/);
    const svg = provisionalQrSvg('ristorante-di-prova');
    assert.match(svg, /^<svg[\s>]/);
    assert.match(svg, /<path|<rect/);
    assert.equal(svg, provisionalQrSvg('ristorante-di-prova'));
  });
  it('rifiuta slug con script, URL e caratteri di controllo', () => {
    for (const slug of ['https://example.com', '../publico', '<script>', '', 'a\nb', 'a_b'])
      assert.throws(() => provisionalQrSvg(slug), /Menu ID non valido/);
  });
});

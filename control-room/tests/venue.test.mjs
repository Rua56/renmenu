import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { venueFromSource } from '../cloudflare/functions/_lib/menu.js';
import { classifyRequest } from '../cloudflare/functions/_lib/autopilot.js';

describe('Nome del locale scritto come i clienti veri', () => {
  it('riconosce etichette e frasi esplicite', () => {
    const cases = [['nome del locale: Antoine I love You', 'Antoine I love You'], ['Locale: Osteria Viva', 'Osteria Viva'],
      ['Il locale si chiama Trattoria al Ponte.', 'Trattoria al Ponte'], ['il nostro ristorante si chiama «Al Cjasal» e vorrei', 'Al Cjasal'],
      ['Il nome del locale è Bar Centrale.', 'Bar Centrale'], ['- Nome del ristorante: Da Gigi', 'Da Gigi']];
    for (const [text, venue] of cases) assert.equal(venueFromSource(text), venue, text);
  });
  it('non inventa: niente prezzi, piatti o nomi generici', () => {
    for (const text of ['Bar — 5', 'nome del ristorante: 12', 'Frico — 12', 'Ho un bar e vorrei un menu', 'Nome: Mario']) assert.equal(venueFromSource(text), '', text);
  });
  it('l’email vera di Riccardo diventa un nuovo menu Standard', () => {
    const r = classifyRequest('Richiesta email da verificare', 'Oggetto ricevuto: Richiesta email da verificare\n\nbuongiorno vorrei un abbonamento Standard.\nnome del locale: Antoine I love You');
    assert.equal(r.category, 'nuovo_standard');
    assert.equal(r.venue, 'Antoine I love You');
  });
});

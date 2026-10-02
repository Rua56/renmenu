import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractMenuFromText, venueFromSource } from '../cloudflare/functions/_lib/menu.js';
import { reviewIssues } from '../site/editorial.js';
import { planIssues, planWarnings } from '../site/service-rules.js';
import { planWarnings as serverPlanWarnings } from '../cloudflare/functions/_lib/service-rules.js';

describe('Feedback del pilota Gmail', () => {
  it('la riga "Locale:" non diventa una riga incerta e il nome si legge solo da righe esplicite', () => {
    const source = 'Locale: Trattoria Prova Gorizia\n# Primi\nGnocchi — 10,50';
    assert.equal(venueFromSource(source), 'Trattoria Prova Gorizia');
    assert.equal(venueFromSource('Vorrei un menu per il mio locale, grazie'), '');
    const result = extractMenuFromText('Trattoria Prova Gorizia', source);
    assert.equal(result.uncertain.length, 0);
    assert.equal(result.provenance.find((e) => e.path === 'sezioni.0.nome.it').source, 'riga 2');
  });
  it('i messaggi delle evidenze usano le etichette italiane', () => {
    const menu = { id: 'prova', nome: 'Prova', lingue: ['it'], sezioni: [{ nome: { it: 'Primi' }, voci: [{ nome: { it: 'Gnocchi' }, prezzo: '10,50' }] }] };
    const { issues } = reviewIssues(menu, { prices: true, allergens: true, languages: true, clientApproval: true, fieldEvidence: {} }, 'standard');
    assert.equal(issues.some((i) => i.startsWith('Evidenza prezzi:')), true);
    assert.equal(issues.some((i) => /^(prices|allergens|languages):/.test(i)), false);
  });
  it('Standard senza inglese: avviso non bloccante', () => {
    const it = { lingue: ['it'] };
    assert.equal(planWarnings(it, 'standard').length, 1);
    assert.match(planWarnings(it, 'standard')[0], /EN/);
    assert.deepEqual(planIssues(it, 'standard', {}), []);
    assert.deepEqual(planWarnings({ lingue: ['it', 'en'] }, 'standard'), []);
    assert.deepEqual(planWarnings(it, 'annuale'), []);
    assert.deepEqual(planWarnings(it, 'da_definire'), []);
    assert.deepEqual(serverPlanWarnings(it, 'standard'), planWarnings(it, 'standard'));
  });
});

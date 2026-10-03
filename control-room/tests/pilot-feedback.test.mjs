import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractMenuFromText, venueFromSource } from '../cloudflare/functions/_lib/menu.js';
import { reviewIssues, suggestedEvidence } from '../site/editorial.js';
import { suggestedEvidence as serverSuggested } from '../cloudflare/functions/_lib/editorial.js';
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
  it('titoli di sezione anche senza spazio dopo #', () => {
    const result = extractMenuFromText('Prova', '# Antipasti\nFrico — 7,00\n#Secondi\nGubana — 5,50');
    assert.deepEqual(result.menu.sezioni.map((s) => s.nome.it), ['Antipasti', 'Secondi']);
    assert.equal(result.uncertain.length, 0);
  });
  it('Jarvis propone le evidenze solo da fatti registrati', () => {
    const extraction = extractMenuFromText('Osteria Prova', 'Oggetto ricevuto: TEST\n\n# Antipasti\nFrico croccante — 7,00\nGubana — 5,50');
    const request = { subject: 'TEST PILOTA 2', sourceChannel: 'email', createdAt: '2026-10-02T12:44:13Z' };
    const draft = { menu: extraction.menu, provenance: extraction.provenance };
    const proposal = suggestedEvidence(draft, request);
    assert.equal(proposal.prices, 'Email «TEST PILOTA 2» del 02/10/2026: riga 4 Frico croccante 7,00; riga 5 Gubana 5,50.');
    assert.match(proposal.allergens, /non indica allergeni/);
    assert.match(proposal.languages, /Inglese non fornito/);
    assert.equal('clientApprovalEvidence' in proposal, false, 'mai approvazione scritta inventata');
    assert.deepEqual(serverSuggested(draft, request), proposal);
    // Bozza modificata a mano: provenienza azzerata, nessuna proposta su prezzi e allergeni.
    const edited = suggestedEvidence({ menu: extraction.menu, provenance: [] }, request);
    assert.equal(edited.prices, '');
    assert.equal(edited.allergens, '');
    assert.match(edited.notes.prices, /verifica i prezzi/);
    // Prezzo cambiato dopo la generazione: la provenienza non combacia, nessuna proposta.
    const changed = structuredClone(extraction.menu); changed.sezioni[0].voci[0].prezzo = '8,00';
    assert.equal(suggestedEvidence({ menu: changed, provenance: extraction.provenance }, request).prices, '');
    // Le evidenze proposte superano i controlli di lunghezza del server.
    const checks = { prices: true, allergens: true, languages: true, clientApproval: false, allergenOmissionConfirmed: true,
      fieldEvidence: { prices: proposal.prices, allergens: proposal.allergens, languages: proposal.languages } };
    assert.equal(reviewIssues(extraction.menu, checks, 'standard').issues.some((i) => i.startsWith('Evidenza')), false);
  });
});

describe('Pilota 6: nome del locale come nome proprio', () => {
  it('una stringa semplice non conta come traduzione mancante; i piatti sì', async () => {
    const { criticalFields } = await import('../cloudflare/functions/_lib/editorial.js');
    const menu = { id: 'x', nome: 'Osteria Prova Carso', lingue: ['it', 'en'],
      sezioni: [{ nome: { it: 'Primi', en: 'First courses' }, voci: [{ nome: { it: 'Jota', en: 'Jota' }, prezzo: '9,00' }] }] };
    assert.deepEqual(criticalFields(menu).translationsMissing, []);
    menu.sezioni[0].voci[0].nome = { it: 'Jota' };
    assert.deepEqual(criticalFields(menu).translationsMissing, ['sezioni.0.voci.0.nome.en']);
    assert.deepEqual(criticalFields({ ...menu, nome: { it: 'Osteria' }, sezioni: [] }).translationsMissing, ['nome.en']);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { criticalFields as serverFields, reviewIssues as serverReview } from '../cloudflare/functions/_lib/editorial.js';
import { criticalFields as demoFields, reviewIssues as demoReview } from '../site/editorial.js';
import { validateMenu as editorValidate } from '../site/model.js';

const menu = () => ({ id: 'locale-di-prova', nome: { it: 'Locale di prova' }, lingue: ['it'],
  sezioni: [{ nome: { it: 'Primi' }, voci: [{ nome: { it: 'Gnocchi' }, prezzo: '12,00' }] }] });
const checks = () => ({ prices: true, allergens: true, languages: true, clientApproval: true,
  fieldEvidence: {
    prices: 'Listino fittizio del cliente, riga Gnocchi 12,00.',
    allergens: 'Cliente fittizio autorizza espressamente omissione allergeni dal menu demo.',
    languages: 'Il documento del locale demo contiene i nomi in italiano.'
  }, allergenOmissionConfirmed: true,
  clientApprovalEvidence: 'Approvazione scritta del locale demo nel messaggio di prova.' });

describe('Gate editoriale, parità demo/API', () => {
  it('non scambia gli allergeni assenti per allergeni confermati', () => {
    const draft = menu();
    assert.equal(serverFields(draft).allergensMissing.length, 1);
    assert.deepEqual(serverFields(draft), demoFields(draft));
    assert.ok(editorValidate(draft).warnings.some((warning) => warning.message.includes('ALLERGENI NON CONFERMATI DAL LOCALE')));
    const incomplete = checks(); incomplete.allergenOmissionConfirmed = false;
    assert.match(serverReview(draft, incomplete).issues.join(' '), /ALLERGENI NON CONFERMATI/);
    assert.deepEqual(serverReview(draft, incomplete), demoReview(draft, incomplete));
    assert.deepEqual(serverReview(draft, checks()).issues, []);
    draft.sezioni[0].voci[0].allergeni = [];
    assert.equal(serverFields(draft).allergensMissing.length, 1);
    assert.match(serverReview(draft, incomplete).issues.join(' '), /ALLERGENI NON CONFERMATI/);
    assert.deepEqual(serverReview(draft, checks()), demoReview(draft, checks()));
  });
  it('blocca importi mancanti, traduzioni dichiarate ma assenti e riferimenti generici', () => {
    const withoutPrice = menu(); withoutPrice.sezioni[0].voci[0].prezzo = '';
    assert.match(serverReview(withoutPrice, checks()).issues.join(' '), /prezzi non attestati/);
    const missingLanguage = menu(); missingLanguage.lingue.push('en');
    assert.match(serverReview(missingLanguage, checks()).issues.join(' '), /traduzione dichiarata/);
    const noSource = checks(); noSource.fieldEvidence.prices = 'ok';
    assert.match(serverReview(menu(), noSource).issues.join(' '), /riferimento scritto/);
    assert.deepEqual(serverReview(withoutPrice, checks()), demoReview(withoutPrice, checks()));
    assert.deepEqual(serverReview(missingLanguage, checks()), demoReview(missingLanguage, checks()));
  });
});

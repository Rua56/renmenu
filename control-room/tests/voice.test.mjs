import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { configureVoice, interpretVoice, speak, voiceSettings } from '../site/voice.js';

describe('Voce originale RenMenu', () => {
  it('resta spenta di default e non riproduce audio senza consenso', () => {
    assert.equal(voiceSettings().enabled, false);
    assert.throws(() => speak('Testo mock'), /Attiva prima/);
    configureVoice({ rate: 9, volume: -1 });
    assert.equal(voiceSettings().rate, 1.4);
    assert.equal(voiceSettings().volume, 0);
  });
  it('non pubblica, invia, chiama o modifica da un comando parlato', () => {
    const context = { requests: [{ subject: 'Prezzo da controllare', status: 'in_attesa' }], client: { name: 'Locale sintetico' }, draft: { menu: { sezioni: [{ voci: [{ nome: 'Zuppa' }] }] } } };
    assert.equal(interpretVoice('Non pubblicare ancora', context).target, null);
    const publish = interpretVoice('Pubblica il menù', context);
    assert.equal(publish.target, 'approvazioni');
    assert.match(publish.reply, /Nessuna pubblicazione, invio o chiamata è partita/);
    assert.equal(interpretVoice('Mandami un promemoria', context).target, 'notifiche');
    const open = interpretVoice('Apri Locale sintetico', { ...context, clients: [{ id: 'c1', name: 'Locale sintetico' }], requests: [{ id: 'r1', clientId: 'c1', subject: 'Prezzo da controllare' }] });
    assert.deepEqual({ target: open.target, requestId: open.requestId }, { target: 'richieste', requestId: 'r1' });
    assert.match(interpretVoice('Cosa devo fare oggi?', context).reply, /Prezzo da controllare/);
    assert.equal(interpretVoice('Modifica il prezzo', context).target, 'revisione');
  });
  it('risponde contestualmente su pratiche, materiali, dubbi e azioni senza eseguire operazioni', () => {
    const context = {
      selectedRequestId: 'r1',
      clients: [{ id: 'c1', name: 'Locale sintetico' }],
      requests: [{ id: 'r1', clientId: 'c1', subject: 'Listino da verificare', status: 'in_attesa', sourceText: 'Piatto — 9,00', nextStep: 'Verifica fonte' }],
      materials: [{ requestId: 'r1', filename: 'listino.pdf', mime: 'application/pdf' }],
      draft: { provenance: [{ path: 'sezioni.0.voci.1.prezzo', status: 'da_verificare' }], menu: { sezioni: [{ voci: [{ nome: 'Piatto', prezzo: '9,00' }] }] } },
      audit: [{ requestId: 'r1', summary: 'Bozza salvata senza invio.' }],
      notifications: []
    };
    assert.equal(interpretVoice('Quali pratiche aperte ci sono?', context).target, 'richieste');
    assert.equal(interpretVoice('Riassumi i materiali', context).target, 'materiali');
    assert.equal(interpretVoice('Quali dubbi mancano?', context).target, 'builder');
    const action = interpretVoice('Qual è l’ultima azione?', context);
    assert.equal(action.target, 'registro');
    assert.match(action.reply, /non ho eseguito nuove azioni/i);
  });

});

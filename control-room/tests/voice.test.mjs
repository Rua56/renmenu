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
});

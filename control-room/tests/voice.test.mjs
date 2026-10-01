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

describe('Proposte vocali verificabili', () => {
  const context = {
    selectedRequestId: 'r1',
    clients: [{ id: 'c1', name: 'Trattoria di prova' }],
    requests: [{ id: 'r1', clientId: 'c1', subject: 'Menu pranzo', status: 'in_revisione', sourceText: 'Primi\nPasta — 11,00', nextStep: 'Verificare listino', revision: 4 }],
    materials: [{ id: 'm1', requestId: 'r1', filename: 'listino.pdf', mime: 'application/pdf' }],
    analyses: [{ materialId: 'm1', requestId: 'r1', sourceSha256: 'a'.repeat(64), sourceText: 'Pasta — 11,00', status: 'needs_review' }],
    draft: { menu: { sezioni: [{ nome: { it: 'Primi' }, voci: [{ nome: { it: 'Pasta' }, prezzo: '11,00' }] }] } }
  };

  it('prepara proposte correggibili per prezzo, sezione, voce e messaggio senza mutare lo stato', () => {
    const price = interpretVoice('Modifica il prezzo della Pasta a 12,50', context);
    assert.deepEqual({ target: price.target, kind: price.proposal?.kind, destination: price.proposal?.target }, { target: 'voce', kind: 'price', destination: 'revisione' });
    assert.match(price.proposal.text, /Pasta.*12,50/);
    assert.match(price.reply, /Non ho modificato, salvato, inviato, pubblicato o approvato nulla/);

    const section = interpretVoice('Aggiungi sezione Dolci stagionali', context);
    assert.equal(section.proposal?.kind, 'section');
    assert.match(section.proposal.text, /dolci stagionali/i);

    const item = interpretVoice('Aggiungi voce Tiramisù nella sezione Dolci a 6,00', context);
    assert.equal(item.proposal?.kind, 'item');
    assert.match(item.proposal.text, /tiramisù.*dolci.*6,00/i);

    const message = interpretVoice('Prepara una bozza messaggio: puoi confermare il prezzo?', context);
    assert.deepEqual({ target: message.target, kind: message.proposal?.kind, destination: message.proposal?.target }, { target: 'voce', kind: 'message', destination: 'notifiche' });
    assert.match(message.reply, /Non ho modificato/);
  });

  it('riassume esclusivamente il contesto corrente indicando le fonti', () => {
    const summary = interpretVoice('Riassumi la pratica e il contesto', context);
    assert.equal(summary.target, 'richieste');
    assert.match(summary.reply, /Menu pranzo/);
    assert.match(summary.reply, /listino\.pdf/);
    assert.match(summary.reply, /aaaaaaaaaaaa/);
    assert.match(summary.reply, /non una convalida/i);
  });
});

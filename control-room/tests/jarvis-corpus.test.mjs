/* Frasi vere dette da Riccardo a Jarvis il 6 ottobre 2026 (pratica Al Chiostro Bistrot), con il risultato atteso.
 * Ogni errore trovato sul campo diventa una riga qui: così non si ripresenta. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHours } from '../cloudflare/functions/_lib/hours.js';
import { guessIntent } from '../cloudflare/functions/_lib/understanding.js';
import { applyOps, validateOps } from '../cloudflare/functions/_lib/draft-edit.js';

const base = () => ({ id: 'al-chiostro-bistrot', nome: 'Al Chiostro Bistrot', lingue: ['it', 'en'], sezioni: [{ nome: { it: 'dolci' }, voci: [{ nome: { it: 'Chiostromisù' }, prezzo: '6,00' }] }] });

test('orari: le frasi vere di Riccardo diventano una riga ordinata', () => {
  const casi = [
    ['Mercoledì chiuso, da giovedì a martedì aperti dalle 12 alle 15 e dalle 19 alle 22', '12:00–15:00 e 19:00–22:00 · Chiuso il mercoledì'],
    ['mercoledì chiuso, tutti gli altri giorni dalle 12 alle 15 e dalle 19 alle 22', '12:00–15:00 e 19:00–22:00 · Chiuso il mercoledì'],
    ['Orari di chiostro bistrot\nLunedì 12.00-15.00 19.00-22.00\nMartedì 12.00-15.00 19.00-22.00\nMercoledì chiuso\nGiovedì 12.00-15.00 19.00-22.00\nVenerdì 12.00-15.00 19.00-22.00\nSabato 12.00-15.00 19.00-22.00\nDomenica 12.00-15.00 19.00-22.00', '12:00–15:00 e 19:00–22:00 · Chiuso il mercoledì']
  ];
  for (const [frase, atteso] of casi) assert.equal(normalizeHours({ text: frase, utterance: frase })?.it, atteso, frase);
});

test('dati del locale detti con un valore: correzione della bozza', () => {
  for (const frase of ['Il coperto è 3 euro a persona', 'L’instagram è alchiostro.bistro', 'Il numero di telefono è 0481227207'])
    assert.equal(guessIntent(frase, {}).intent, 'aggiorna_menu', frase);
});

test('«Le bevande sono: bibite 5€ calice di vino 6€ caffè 1€»: una sola sezione Bevande', () => {
  const frase = 'Le bevande del chiostro bistrot sono: bibite 5€ calice di vino 6€ caffè 1€';
  const raw = [['bibite', '5,00'], ['calice di vino', '6,00'], ['caffè', '1,00']].map(([nome, prezzo]) => ({ tipo: 'aggiungi', nome, prezzo, sezione: 'bevande' }));
  const { ops, problems } = validateOps(raw, base(), frase);
  assert.deepEqual(problems, []);
  const { menu } = applyOps(base(), [], ops, 'Riccardo');
  assert.deepEqual(menu.sezioni.map((s) => s.nome.it), ['dolci', 'Bevande']);
  assert.equal(menu.sezioni[1].voci.length, 3);
});

test('«Manca il coperto a 3 euro»: campo coperto, nessuna sezione', () => {
  const { ops, problems } = validateOps([{ tipo: 'aggiungi', nome: 'Coperto', prezzo: '3,00', sezione: 'Coperto' }], base(), 'Manca il coperto a 3 euro');
  assert.deepEqual(problems, []);
  const { menu } = applyOps(base(), [], ops, 'Riccardo');
  assert.equal(menu.coperto, '3,00'); assert.equal(menu.sezioni.length, 1);
});

test('«Rimuovi bibite caffe e calice di vino»: le sezioni rimaste vuote spariscono', () => {
  const m = { ...base(), sezioni: [...base().sezioni, { nome: { it: 'Bevande' }, voci: [{ nome: { it: 'Bibite' }, prezzo: '5,00' }, { nome: { it: 'Calice di vino' }, prezzo: '6,00' }, { nome: { it: 'Caffè' }, prezzo: '1,00' }] }] };
  const raw = [0, 1, 2].map((vi) => ({ tipo: 'rimuovi', si: 1, vi }));
  const { ops, problems } = validateOps(raw, m, 'Per la pratica al chiostro bistrot rimuovi bibite caffe e calice di vino');
  assert.deepEqual(problems, []);
  assert.deepEqual(applyOps(m, [], ops, 'Riccardo').menu.sezioni.map((s) => s.nome.it), ['dolci']);
});

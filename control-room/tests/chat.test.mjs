import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_MODEL, chat, chatText } from '../cloudflare/functions/_lib/voice.js';

test('conversazione: legge i diversi formati di risposta del modello', () => {
  assert.equal(chatText({ response: 'ciao' }), 'ciao');
  assert.equal(chatText({ choices: [{ message: { content: 'ciao' } }] }), 'ciao');
  assert.equal(chatText({ output: [{ type: 'reasoning', content: [{ text: 'pensa' }] }, { type: 'message', content: [{ type: 'output_text', text: 'ciao' }] }] }), 'ciao');
});

test('conversazione: usa GPT-OSS, ripulisce il markdown e ripiega sul modello di riserva', async () => {
  const seen = [];
  const ai = { run: async (model, body) => { seen.push({ model, body }); if (model === CHAT_MODEL) return { choices: [{ message: { content: '**Certo**, Riccardo.\n- prima idea' } }] }; return { response: 'riserva' }; } };
  const out = await chat(ai, { utterance: 'ciao', context: 'DATI', history: [{ who: 'Riccardo', text: 'prima' }, { who: 'Jarvis', text: 'risposta' }] });
  assert.deepEqual(out, { ok: true, text: 'Certo, Riccardo.\nprima idea', model: CHAT_MODEL });
  assert.deepEqual(seen[0].body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  const fallback = await chat({ run: async (model) => { if (model === CHAT_MODEL) throw new Error('quota'); return { response: 'riserva' }; } }, { utterance: 'ciao' });
  assert.equal(fallback.text, 'riserva');
});

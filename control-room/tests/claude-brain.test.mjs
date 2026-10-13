import test from 'node:test';
import assert from 'node:assert/strict';
import { chat, understand } from '../cloudflare/functions/_lib/voice.js';

const claudeSays = (reply, status = 200) => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body), headers: options.headers });
    if (status !== 200) return Response.json({ type: 'error', error: { type: 'overloaded_error' } }, { status });
    return Response.json({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }] });
  };
  return { calls, fetchImpl };
};
const freeModel = (response) => ({ run: async () => ({ response }) });

test('cervello: con la chiave capisce Claude, con lo schema e senza dati di contatto in più', async () => {
  const { calls, fetchImpl } = claudeSays({ intent: 'aggiorna_menu', locale: 'Al Bakaro', risposta: '', dettaglio: '', urgente: false });
  const out = await understand(freeModel({ intent: 'non_chiaro', locale: '', risposta: '' }), 'al bakaro il frico ora 14', 'DATI', { claude: { env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl } });
  assert.equal(out.intent, 'aggiorna_menu');
  assert.equal(out.locale, 'Al Bakaro');
  assert.equal(out.engine, 'claude');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].body.output_config.format.type, 'json_schema');
  assert.equal(calls[0].body.output_config.format.schema.additionalProperties, false);
  assert.equal(calls[0].body.output_config.effort, 'low');
  assert.match(calls[0].body.messages[0].content, /COMANDO DI RICCARDO:\nal bakaro il frico ora 14/);
});

test('cervello: se Claude non risponde usa il modello gratuito e lo annota', async () => {
  const { fetchImpl } = claudeSays({}, 529);
  const out = await understand(freeModel({ intent: 'stato', locale: '', risposta: '', dettaglio: 'breve' }), 'come siamo messi?', 'DATI', { claude: { env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl } });
  assert.equal(out.intent, 'stato');
  assert.equal(out.engine, 'cloudflare');
  assert.match(out.why, /Claude: Claude ha risposto 529/);
  const none = await understand(null, 'ciao', 'DATI', { claude: { env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl } });
  assert.equal(none.intent, 'non_chiaro');
});

test('cervello: senza chiave nessuna chiamata a Claude', async () => {
  const { calls, fetchImpl } = claudeSays({});
  const out = await understand(freeModel({ intent: 'risposta', locale: '', risposta: 'Ciao' }), 'ciao', 'DATI', { claude: { env: {}, fetchImpl } });
  assert.equal(out.engine, 'cloudflare');
  assert.equal(calls.length, 0);
});

test('conversazione: Claude riceve la storia a turni alternati, iniziando da Riccardo', async () => {
  const { calls, fetchImpl } = claudeSays('Buongiorno Riccardo. **Tutto** tranquillo.');
  const history = [{ who: 'Jarvis', text: 'Buongiorno.' }, { who: 'Riccardo', text: 'ciao' }, { who: 'Riccardo', text: 'ci sei?' }, { who: 'Jarvis', text: 'Sempre.' }];
  const out = await chat(null, { utterance: 'novità?', context: 'DATI', history }, { claude: { env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl } });
  assert.equal(out.ok, true);
  assert.equal(out.engine, 'claude');
  assert.equal(out.text, 'Buongiorno Riccardo. Tutto tranquillo.');
  const turns = calls[0].body.messages;
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'user']);
  assert.equal(turns[0].content, 'ciao\nci sei?');
  assert.match(calls[0].body.system, /DATI DELLA CONTROL ROOM:\nDATI/);
  assert.equal(calls[0].body.output_config.format, undefined);
});

test('conversazione: se Claude fallisce risponde il modello gratuito', async () => {
  const { fetchImpl } = claudeSays('', 500);
  const out = await chat(freeModel('Eccomi.'), { utterance: 'ciao', context: '' }, { claude: { env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl } });
  assert.equal(out.ok, true);
  assert.equal(out.text, 'Eccomi.');
  assert.notEqual(out.engine, 'claude');
});

test('claude: un 400 sul fallback riprova senza fallback; senza credito lo dice chiaramente', async () => {
  const { askClaude } = await import('../cloudflare/functions/_lib/claude.js');
  const seen = [];
  const fallbackRejected = async (url, options) => {
    const body = JSON.parse(options.body);
    seen.push({ fallbacks: body.fallbacks, beta: options.headers['anthropic-beta'] });
    if (body.fallbacks) return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: not available' } }, { status: 400 });
    return Response.json({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ciao.' }] });
  };
  const out = await askClaude({ ANTHROPIC_API_KEY: 'k' }, { system: 's', messages: [{ role: 'user', content: 'ciao' }] }, { fetchImpl: fallbackRejected });
  assert.equal(out.text, 'Ciao.');
  assert.deepEqual(seen, [{ fallbacks: 'default', beta: 'server-side-fallback-2026-07-01' }, { fallbacks: undefined, beta: undefined }]);
  const broke = async () => Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } }, { status: 400 });
  assert.match((await askClaude({ ANTHROPIC_API_KEY: 'k' }, { system: 's', messages: [] }, { fetchImpl: broke })).error, /non ha credito: va caricato in console\.anthropic\.com/);
  const other = async () => Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'messages: field required' } }, { status: 400 });
  assert.equal((await askClaude({ ANTHROPIC_API_KEY: 'k' }, { system: 's', messages: [] }, { fetchImpl: other })).error, 'Claude ha risposto 400 (invalid_request_error: messages: field required)');
});

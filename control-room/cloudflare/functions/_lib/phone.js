// «Jarvis ti chiama»: telefonata vera a Riccardo con un agente vocale di ElevenLabs (voce di Jarvis)
// su un numero Twilio importato da Riccardo in ElevenLabs (Agents → Phone Numbers). La chiamata la fa
// ElevenLabs con le credenziali Twilio salvate lì: Jarvis usa solo la chiave ElevenLabs già impostata
// per la voce. Servizio a pagamento (minuti Twilio e ElevenLabs): parte solo quando Riccardo lo chiede.
const API = 'https://api.elevenlabs.io/v1/convai';
export const AGENT_NAME = 'Jarvis · RenMenu';
export const PHONE_RX = /^\+\d{8,15}$/;

export const AGENT_PROMPT = [
  'Sei Jarvis, l’assistente di RenMenu (menu digitali con QR per ristoranti e bar di Gorizia), e stai parlando al telefono con Riccardo, il titolare.',
  'Parli in italiano, con frasi brevi e naturali, tono calmo e un po’ ironico, come il Jarvis di Tony Stark. Dai del tu a Riccardo.',
  'Ecco la situazione di RenMenu in questo momento (dati veri dalla Control Room):\n{{situazione}}',
  'Motivo della chiamata: {{motivo}}',
  'Rispondi solo con ciò che sai dalla situazione. Se Riccardo ti chiede di fare qualcosa (pubblicare, modificare un menu, scrivere a un cliente), digli che glielo prepari su Telegram, dove lo conferma lui: al telefono non esegui azioni.',
  'Non leggere link, codici o numeri lunghi. Quando Riccardo saluta, saluta e chiudi.'
].join('\n\n');

/** Numero in formato internazionale (+39…), da quello scritto da Riccardo. null se non valido. */
export function phoneNumber(said) {
  let raw = String(said || '').replace(/[\s.()/-]/g, '');
  if (/^00\d/.test(raw)) raw = `+${raw.slice(2)}`;
  if (/^3\d{8,9}$/.test(raw)) raw = `+39${raw}`; // cellulare italiano scritto senza prefisso
  return PHONE_RX.test(raw) ? raw : null;
}

async function call(fetchImpl, key, path, { method = 'GET', body } = {}) {
  const response = await fetchImpl(`${API}${path}`, {
    method, headers: { 'xi-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined
  });
  let data = null; try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const detail = data?.detail?.message || data?.detail?.status || (typeof data?.detail === 'string' ? data.detail : '') || data?.message || '';
    throw Object.assign(new Error(`ElevenLabs ${response.status}${detail ? `: ${String(detail).slice(0, 160)}` : ''}`), { status: response.status });
  }
  return data;
}

/** Agente «Jarvis» con la voce scelta: lo crea la prima volta, poi riusa l'id salvato. */
export async function ensureAgent(fetchImpl, key, { agentId = '', voiceId = '' } = {}) {
  if (agentId) return agentId;
  const created = await call(fetchImpl, key, '/agents/create', { method: 'POST', body: {
    name: AGENT_NAME,
    conversation_config: {
      agent: { prompt: { prompt: AGENT_PROMPT }, first_message: 'Ciao Riccardo, sono Jarvis. {{motivo}}', language: 'it' },
      tts: { model_id: 'eleven_flash_v2_5', ...(/^[A-Za-z0-9]{10,40}$/.test(voiceId) ? { voice_id: voiceId } : {}) }
    }
  } });
  if (!created?.agent_id) throw new Error('ElevenLabs non ha restituito l’agente.');
  return created.agent_id;
}

/** Numero Twilio importato in ElevenLabs (il primo). null se Riccardo non l'ha ancora importato. */
export async function twilioNumber(fetchImpl, key) {
  const list = await call(fetchImpl, key, '/phone-numbers');
  const numbers = Array.isArray(list) ? list : Array.isArray(list?.phone_numbers) ? list.phone_numbers : [];
  const found = numbers.find((n) => String(n.provider || '').toLowerCase() === 'twilio') || null;
  return found?.phone_number_id ? { id: found.phone_number_id, number: found.phone_number || '' } : null;
}

/** Fa partire la chiamata. Restituisce { conversationId, callSid }. */
export async function callOwner(fetchImpl, key, { agentId, phoneNumberId, to, situation, reason }) {
  const out = await call(fetchImpl, key, '/twilio/outbound-call', { method: 'POST', body: {
    agent_id: agentId, agent_phone_number_id: phoneNumberId, to_number: to,
    conversation_initiation_client_data: { dynamic_variables: {
      situazione: String(situation || 'Nessuna novità.').slice(0, 3000),
      motivo: String(reason || 'Mi hai chiesto di chiamarti: dimmi pure.').slice(0, 300)
    } }
  } });
  if (out && out.success === false) throw new Error(`ElevenLabs: ${String(out.message || 'chiamata non partita').slice(0, 160)}`);
  return { conversationId: out?.conversation_id || null, callSid: out?.callSid || null };
}

/** Com'è andata una telefonata (registro delle conversazioni di ElevenLabs), in poche parole per Riccardo. */
export async function callOutcome(fetchImpl, key, conversationId) {
  const data = await call(fetchImpl, key, `/conversations/${encodeURIComponent(conversationId)}`);
  const meta = data?.metadata || {};
  const turns = Array.isArray(data?.transcript) ? data.transcript.length : 0;
  const parts = [`stato «${data?.status || 'sconosciuto'}»`, `${turns} battute`];
  if (meta.call_duration_secs !== undefined) parts.push(`${meta.call_duration_secs} secondi`);
  if (meta.termination_reason) parts.push(`chiusura: ${String(meta.termination_reason).slice(0, 200)}`);
  const error = meta.error?.reason || meta.error?.message || (typeof meta.error === 'string' ? meta.error : '');
  if (error) parts.push(`errore: ${String(error).slice(0, 200)}`);
  if (data?.analysis?.call_successful) parts.push(`esito: ${data.analysis.call_successful}`);
  return parts.join(', ');
}

// ——— Dialogo dal vivo nella Control Room ———
// Un secondo agente ElevenLabs, solo per la Control Room: Riccardo parla e Jarvis risponde subito, come al
// telefono, ma dal browser. L'agente ha tre strumenti che esegue la pagina: chiedere al Jarvis vero (lo
// stesso cervello di Telegram, con i suoi pulsanti), aprire un elenco a schermo, chiudere il dialogo.
// Consuma minuti ElevenLabs: parte solo quando Riccardo tocca «Dal vivo» e dura al massimo 10 minuti.
export const LIVE_AGENT_NAME = 'Jarvis · Control Room';
export const LIVE_PROMPT = [
  'Sei Jarvis, l’assistente di RenMenu (menu digitali con QR per ristoranti e bar di Gorizia). Stai parlando dal vivo con Riccardo, il titolare, nella sua Control Room.',
  'Parli in italiano, con frasi brevi e naturali, tono calmo e un po’ ironico, come il Jarvis di Tony Stark. Dai del tu a Riccardo.',
  'Situazione di RenMenu all’inizio del dialogo (dati veri):\n{{situazione}}',
  'Per tutto ciò che va oltre la situazione (dettagli di una pratica, modifiche a un menu, anteprime, QR, pubblicazioni, messaggi ai clienti, impostazioni) usa lo strumento chiedi_a_jarvis con la richiesta di Riccardo detta in modo chiaro: risponde il Jarvis vero e tu riferisci la risposta in breve. Se la risposta parla di pulsanti, di’ a Riccardo che li trova sullo schermo: pubblicare e scrivere ai clienti restano sempre un suo tocco.',
  'Quando Riccardo chiede di vedere un elenco (pratiche aperte o chiuse, locali, menu online, modifiche, attività) o i numeri e i grafici della settimana usa lo strumento mostra.',
  'Quando Riccardo saluta o dice basta, saluta in una frase e usa lo strumento chiudi.',
  'Non leggere link, codici o numeri lunghi. Non inventare dati.'
].join('\n\n');
const LIVE_TOOLS = [
  { name: 'chiedi_a_jarvis', description: 'Passa una richiesta di Riccardo al Jarvis di RenMenu (lo stesso di Telegram) e restituisce la sua risposta. Da usare per ogni domanda o azione su pratiche, menu, locali, bozze, anteprime, QR e impostazioni.', field: 'richiesta', about: 'La richiesta di Riccardo, in italiano, chiara e completa.' },
  { name: 'mostra', description: 'Apre a schermo un elenco: pratiche aperte, chiuse o da decidere, locali registrati, menu online, modifiche, attività recenti, anche di un locale o di un periodo, oppure i grafici dei numeri («i numeri della settimana»).', field: 'cosa', about: 'Cosa mostrare, per esempio «pratiche chiuse di questa settimana».' },
  { name: 'chiudi', description: 'Chiude il dialogo dal vivo quando Riccardo saluta o dice basta.', field: '', about: '' }
];
function toolConfig(tool) {
  return {
    type: 'client', name: tool.name, description: tool.description,
    expects_response: tool.name !== 'chiudi', response_timeout_secs: 60,
    parameters: tool.field ? { type: 'object', properties: { [tool.field]: { type: 'string', description: tool.about } }, required: [tool.field] } : { type: 'object', properties: {}, required: [] }
  };
}

/** Agente del dialogo dal vivo: lo crea la prima volta (con i suoi strumenti), poi riusa l'id salvato. */
export async function ensureLiveAgent(fetchImpl, key, { agentId = '', voiceId = '' } = {}) {
  if (agentId) return agentId;
  const config = (prompt) => ({
    name: LIVE_AGENT_NAME,
    conversation_config: {
      agent: { prompt: { prompt: LIVE_PROMPT, ...prompt }, first_message: 'Eccomi, Riccardo. Dimmi.', language: 'it' },
      tts: { model_id: 'eleven_flash_v2_5', agent_output_audio_format: 'pcm_16000', ...(/^[A-Za-z0-9]{10,40}$/.test(voiceId) ? { voice_id: voiceId } : {}) },
      asr: { user_input_audio_format: 'pcm_16000' },
      turn: { silence_end_call_timeout: 60 },
      conversation: { max_duration_seconds: 600 }
    },
    platform_settings: { auth: { enable_auth: true } }
  });
  // Strumenti come oggetti a sé (il modo attuale di ElevenLabs); se non va, dentro l'agente (il modo vecchio).
  let created = null;
  try {
    const ids = [];
    for (const tool of LIVE_TOOLS) {
      const out = await call(fetchImpl, key, '/tools', { method: 'POST', body: { tool_config: toolConfig(tool) } });
      if (!out?.id) throw new Error('ElevenLabs non ha restituito lo strumento.');
      ids.push(out.id);
    }
    created = await call(fetchImpl, key, '/agents/create', { method: 'POST', body: config({ tool_ids: ids }) });
  } catch (error) {
    if (error?.status === 401) throw error;
    created = await call(fetchImpl, key, '/agents/create', { method: 'POST', body: config({ tools: LIVE_TOOLS.map(toolConfig) }) });
  }
  if (!created?.agent_id) throw new Error('ElevenLabs non ha restituito l’agente.');
  return created.agent_id;
}

/** Indirizzo firmato (vale pochi minuti) con cui la pagina apre il dialogo con l'agente. */
export async function liveSignedUrl(fetchImpl, key, agentId) {
  const out = await call(fetchImpl, key, `/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`);
  const url = String(out?.signed_url || '');
  if (!url.startsWith('wss://api.elevenlabs.io/')) throw new Error('ElevenLabs non ha restituito l’indirizzo del dialogo.');
  return url;
}

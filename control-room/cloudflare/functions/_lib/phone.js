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

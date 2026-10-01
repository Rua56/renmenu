import { extractMenuFromText } from './menu.js';
import { prepareMockGitHubProposal } from './github.js';

// Config keys are names only; no credentials are ever read by the phase-A adapters.
const unsupported = (provider) => {
  throw Object.assign(new Error(`${provider}: modalità live non implementata. Nessuna azione esterna eseguita.`), { status: 501 });
};
export function integrations(env = {}) {
  for (const [key, name] of [['AI_PROVIDER', 'AI'], ['WHATSAPP_PROVIDER', 'WhatsApp'], ['CALL_PROVIDER', 'Chiamate'], ['GITHUB_PROVIDER', 'GitHub']]) {
    if (env[key] && env[key] !== 'mock' && env[key] !== 'disabled') unsupported(name);
  }
  return {
    ai: { mode: 'mock', extract: (venue, source, slug) => extractMenuFromText(venue, source, slug), classify: classifyIntent },
    github: { mode: 'mock', prepare: prepareMockGitHubProposal, createBranch: () => unsupported('GitHub'), createPr: () => unsupported('GitHub'), merge: () => unsupported('GitHub') },
    whatsapp: { mode: 'mock', classify: classifyIntent, prepareReply: draftReply, send: () => unsupported('WhatsApp') },
    calls: { mode: 'mock', prepareNotice: (message) => ({ mode: 'mock', message, recipient: 'owner-only', sent: false }), start: () => unsupported('Chiamate') }
  };
}

export function classifyIntent(source) {
  const body = String(source || '').toLowerCase();
  const requestType = /qr\b/.test(body) ? 'qr' : /traduz|inglese|tedesco|lingua/.test(body) ? 'traduzione' :
    /prezzo|€|euro/.test(body) ? 'prezzo' : /modific|aggiorn/.test(body) ? 'aggiornamento' :
    /men[ùu]|listino/.test(body) ? 'nuovo' : 'altro';
  return { request_type: requestType, urgency: /urgente|oggi stesso|entro oggi/.test(body) ? 'importante' : 'normale',
    locale_name: null, contact_name: null, contact_channel: 'manuale', summary: String(source || '').slice(0, 200),
    requested_action: requestType, missing_information: ['Confermare fonte e dati critici con il locale'],
    confidence: 0.3, requires_human_review: true };
}

export function draftReply(request) {
  const venue = request?.subject || 'il locale';
  return { channel: 'whatsapp', purpose: 'Richiedere conferma dei dati mancanti',
    message: `Buongiorno, grazie per il materiale di ${venue}. Prima di completare il menù potete confermare i prezzi e fornirci gli allergeni ufficiali?`,
    variables_used: ['subject'], requires_approval: true, warnings: ['BOZZA — non inviata. Verificare il testo e il destinatario prima dell’approvazione.'] };
}

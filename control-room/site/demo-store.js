import { cloneDemo } from './demo-data.js';
import { extractMenuFromText, menuDiff, slugify, validateMenu } from './model.js';
import { reviewIssues } from './editorial.js';
import { resolveCategory, draftBlocker } from './service-rules.js';

const STORE_KEY = 'renmenu-control-room-demo-v1';
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 12;
const allowedMime = /^(text\/|application\/pdf$|image\/|audio\/)/;
const REQUEST_KINDS = new Set(['nuovo', 'aggiornamento', 'prezzo', 'traduzione', 'qr', 'commerciale', 'altro']);
const SOURCE_CHANNELS = new Set(['manuale', 'email', 'whatsapp', 'telefono', 'instagram', 'altro']);
const PLANS = new Set(['standard', 'annuale', 'premium', 'da_definire']);
const REQUEST_STATUSES = new Set(['nuova', 'materiale_ricevuto', 'in_analisi', 'dati_da_confermare', 'bozza_pronta', 'in_revisione', 'in_attesa', 'approvata', 'pronta_pubblicazione', 'archiviata', 'chiusa']);
let volatileState = null;

const clone = (value) => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const uid = () => (globalThis.crypto?.randomUUID?.() || `demo-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const actionError = (message, status = 422) => Object.assign(new Error(message), { status });
const find = (list, id, label) => {
  const value = list.find((entry) => entry.id === id);
  if (!value) throw actionError(`${label} non trovato.`, 404);
  return value;
};
const requireRevision = (entity, revision) => {
  if (Number(revision) !== Number(entity.revision)) throw actionError('Versione non aggiornata: ricarica prima di salvare.', 409);
};

function readRaw() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) { /* Storage bloccato: la demo resta nella sessione corrente. */ }
  return volatileState || cloneDemo();
}
function writeRaw(state) {
  volatileState = clone(state);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* modalità volatile compatibile offline */ }
  return clone(state);
}
function appendAudit(state, requestId, action, summary) {
  state.audit.unshift({ id: uid(), requestId: requestId || null, action, summary, createdAt: now() });
}
function updateRequestTimestamp(request) {
  request.updatedAt = now();
  request.lastActionAt = request.updatedAt;
  request.revision += 1;
}

export function loadDemoState() {
  return clone(readRaw());
}

export function resetDemoState() {
  return writeRaw(cloneDemo());
}

export async function performDemoAction(type, payload = {}) {
  const state = readRaw();
  let result = {};
  switch (type) {
    case 'createClient': {
      const name = String(payload.name || '').trim();
      if (name.length < 2) throw actionError('Inserisci un nome di almeno 2 caratteri.');
      const plan = payload.plan || 'da_definire';
      if (!PLANS.has(plan)) throw actionError('Piano non ammesso.');
      const client = { id: uid(), name, plan, revision: 1, createdAt: now(), updatedAt: now(), tags: ['demo'] };
      ['email', 'phone', 'contactName', 'contactRole', 'paymentStatus', 'menuId', 'menuUrl', 'internalNotes', 'trialEndsAt', 'renewalAt'].forEach((key) => {
        if (String(payload[key] || '').trim()) client[key] = String(payload[key]).trim();
      });
      state.clients.unshift(client);
      appendAudit(state, null, type, `Cliente demo creato: ${name}.`);
      result = { client };
      break;
    }
    case 'updateClient': {
      const client = find(state.clients, payload.id, 'Cliente');
      requireRevision(client, payload.revision);
      const patch = payload.patch || {};
      ['name', 'email', 'phone', 'plan', 'contactName', 'contactRole', 'paymentStatus', 'menuId', 'menuUrl', 'internalNotes', 'trialEndsAt', 'renewalAt'].forEach((key) => {
        if (key in patch && typeof patch[key] === 'string') client[key] = patch[key].trim();
      });
      if (!client.name || client.name.length < 2) throw actionError('Il nome del cliente deve avere almeno 2 caratteri.');
      if (!PLANS.has(client.plan)) throw actionError('Piano non ammesso.');
      client.updatedAt = now();
      client.revision += 1;
      appendAudit(state, null, type, `Scheda cliente demo aggiornata: ${client.name}.`);
      result = { client };
      break;
    }
    case 'createRequest': {
      const client = find(state.clients, payload.clientId, 'Cliente');
      const subject = String(payload.subject || '').trim();
      const sourceText = String(payload.sourceText || '').trim();
      if (!subject) throw actionError('L’oggetto è obbligatorio; puoi caricare un file anche senza testo.');
      const sourceChannel = SOURCE_CHANNELS.has(payload.sourceChannel) ? payload.sourceChannel : 'manuale';
      let resolved;
      try { resolved = resolveCategory({ category: payload.category, kind: REQUEST_KINDS.has(payload.kind) ? payload.kind : 'nuovo', plan: PLANS.has(payload.plan) ? payload.plan : 'da_definire' }); }
      catch (error) { throw actionError(error.message); }
      const { kind, category } = resolved;
      const request = {
        id: uid(), clientId: client.id, subject, sourceText,
        sourceChannel, kind, category, status: 'nuova', revision: 1,
        plan: resolved.plan, internalNotes: String(payload.internalNotes || '').trim(),
        nextStep: String(payload.nextStep || 'Genera una bozza prudente.').trim(), followUpAt: String(payload.followUpAt || '').trim(),
        lastActionAt: now(), createdAt: now(), updatedAt: now()
      };
      ['contactName', 'contactRole', 'contactInfo', 'menuId', 'publicUrl'].forEach((key) => {
        if (String(payload[key] || '').trim()) request[key] = String(payload[key]).trim();
      });
      state.requests.unshift(request);
      appendAudit(state, request.id, type, `Pratica demo creata per ${client.name}.`);
      result = { request };
      break;
    }
    case 'updateRequest': {
      const request = find(state.requests, payload.id, 'Pratica');
      requireRevision(request, payload.revision);
      if (['completata', 'archiviata', 'chiusa'].includes(request.status)) throw actionError('Pratica chiusa: non modificabile.', 409);
      if (['pr_simulata', 'pubblicazione_simulata'].includes(state.drafts.find((item) => item.requestId === request.id)?.status)) throw actionError('Proposta già preparata: crea una nuova pratica.', 409);
      const previousSource = request.sourceText;
      const patch = payload.patch || {};
      if ('status' in patch && ['approvata', 'pronta_pubblicazione'].includes(request.status)) throw actionError('Stato approvato: modifica la fonte per ricominciare.', 409);
      if ('status' in patch && ['approvata', 'pronta_pubblicazione'].includes(patch.status)) throw actionError('Stato approvativo non impostabile manualmente.');
      ['subject', 'sourceText', 'sourceChannel', 'kind', 'status', 'plan', 'contactName', 'contactRole', 'contactInfo', 'internalNotes', 'menuId', 'publicUrl', 'nextStep', 'followUpAt'].forEach((key) => {
        if (key in patch && typeof patch[key] === 'string' && patch[key].trim()) request[key] = patch[key].trim();
      });
      if ('category' in patch || request.category) {
        const wanted = 'category' in patch ? patch.category
          : (String(request.category).startsWith('nuovo_') && request.plan !== 'da_definire' ? `nuovo_${request.plan}` : request.category);
        try { Object.assign(request, resolveCategory({ category: wanted, kind: request.kind, plan: request.plan })); }
        catch (error) { throw actionError(error.message); }
      }
      if (!SOURCE_CHANNELS.has(request.sourceChannel)) throw actionError('Canale sorgente non ammesso dal contratto.');
      if (!REQUEST_KINDS.has(request.kind)) throw actionError('Tipo pratica non ammesso dal contratto.');
      if (!PLANS.has(request.plan) || !REQUEST_STATUSES.has(request.status)) throw actionError('Piano o stato non valido.');
      if (patch.sourceText !== undefined && request.sourceText !== previousSource) {
        const draft = state.drafts.find((item) => item.requestId === request.id);
        if (draft && !['pr_simulata', 'pubblicazione_simulata'].includes(draft.status)) {
          draft.checks = { prices: false, allergens: false, languages: false, clientApproval: false };
          draft.status = 'revisione'; draft.revision += 1;
        }
        request.status = 'in_revisione';
      }
      updateRequestTimestamp(request);
      appendAudit(state, request.id, type, 'Pratica demo aggiornata.');
      result = { request };
      break;
    }
    case 'generateDraft': {
      const request = find(state.requests, payload.requestId, 'Pratica');
      const client = find(state.clients, request.clientId, 'Cliente');
      if (state.drafts.some((item) => item.requestId === request.id)) throw actionError('La bozza esiste già: usa Revisione.', 409);
      const planBlock = draftBlocker(request.plan);
      if (planBlock) throw actionError(planBlock);
      const slug = request.menuId || (request.kind !== 'nuovo' ? client.menuId : slugify(client.name));
      if (request.kind !== 'nuovo' && !request.menuId && !client.menuId) throw actionError('Per aggiornare un QR esistente serve l’ID menù già online.');
      const extraction = extractMenuFromText(request.sourceText, { name: client.name, slug });
      if (!extraction.provenance.some((entry) => entry.path.endsWith('.prezzo') && entry.status === 'confermato'))
        throw actionError('Nessun piatto con prezzo leggibile: aggiungi materiale o trascrivi la fonte.');
      const draft = { id: uid(), requestId: request.id, status: 'bozza', revision: 0, checks: { prices: false, allergens: false, languages: false, clientApproval: false }, versions: [] };
      state.drafts.unshift(draft);
      draft.menu = extraction.menu;
      draft.slug = extraction.menu.id;
      draft.provenance = extraction.provenance;
      draft.status = 'bozza';
      draft.revision += 1;
      draft.checks = { prices: false, allergens: false, languages: false, clientApproval: false };
      request.status = 'in_revisione';
      updateRequestTimestamp(request);
      appendAudit(state, request.id, type, 'Bozza demo estratta dal testo; nessun dato è stato inferito.');
      result = { draft: clone(draft), extraction };
      break;
    }
    case 'saveDraft': {
      const draft = find(state.drafts, payload.id, 'Bozza');
      requireRevision(draft, payload.revision);
      if (['pr_simulata', 'pubblicazione_simulata'].includes(draft.status)) throw actionError('Bozza già chiusa: apri una nuova pratica.', 409);
      const check = validateMenu(payload.menu);
      if (!check.valid) throw actionError(`Menu non salvato: ${check.errors[0].message}`);
      const slug = String(payload.slug || payload.menu?.id || draft.slug).trim();
      const request = find(state.requests, draft.requestId, 'Pratica');
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug !== payload.menu?.id) throw actionError('ID JSON e slug non corrispondono.');
      if ((request.kind !== 'nuovo' || request.menuId) && slug !== draft.slug) throw actionError('Non cambiare il Menu ID di un QR già distribuito.');
      draft.versions.unshift({ revision: draft.revision, at: now(), summary: 'Salvataggio editoriale demo.', menu: clone(draft.menu) });
      draft.menu = clone(payload.menu);
      draft.menu.id = slug;
      draft.slug = slug;
      draft.provenance = []; // Riferimenti automatici alla vecchia versione non attestano modifiche manuali.
      draft.revision += 1;
      draft.status = 'revisione';
      draft.checks = { prices: false, allergens: false, languages: false, clientApproval: false };
      request.status = 'in_revisione';
      updateRequestTimestamp(request);
      appendAudit(state, request.id, type, 'Bozza demo salvata; checklist azzerata per nuova revisione.');
      result = { draft: clone(draft), validation: check };
      break;
    }
    case 'reviewDraft': {
      const draft = find(state.drafts, payload.id, 'Bozza');
      requireRevision(draft, payload.revision);
      if (['pr_simulata', 'pubblicazione_simulata'].includes(draft.status)) throw actionError('Revisione già chiusa.', 409);
      const checks = payload.checks || {};
      const keys = ['prices', 'allergens', 'languages', 'clientApproval'];
      if (!keys.every((key) => typeof checks[key] === 'boolean')) throw actionError('Completa i quattro controlli con valori booleani.');
      if (!validateMenu(draft.menu).valid) throw actionError('Correggi gli errori del menù prima di registrare la checklist.');
      draft.approvalEvidence = String(payload.approvalEvidence || '').trim().slice(0, 500);
      draft.checks = { ...Object.fromEntries(keys.map((key) => [key, checks[key]])),
        fieldEvidence: Object.fromEntries(['prices', 'allergens', 'languages'].map((key) => [key,
          checks[key] ? String(payload.fieldEvidence?.[key] || '').trim().slice(0, 500) : ''])),
        allergenOmissionConfirmed: checks.allergens && payload.allergenOmissionConfirmed === true,
        clientApprovalEvidence: checks.clientApproval ? draft.approvalEvidence : '',
        creativeApproval: payload.creativeApproval === true,
        creativeApprovalEvidence: payload.creativeApproval === true ? String(payload.creativeApprovalEvidence || '').trim().slice(0, 500) : '' };
      if (keys.every((key) => draft.checks[key])) {
        const evaluation = reviewIssues(draft.menu, draft.checks, find(state.requests, draft.requestId, 'Pratica').plan);
        if (evaluation.issues.length) throw actionError(evaluation.issues[0]);
      }
      draft.revision += 1;
      draft.status = keys.every((key) => checks[key]) ? 'pronta_pr' : 'revisione';
      const request = find(state.requests, draft.requestId, 'Pratica');
      request.status = draft.status === 'pronta_pr' ? 'approvata' : 'in_revisione';
      updateRequestTimestamp(request);
      appendAudit(state, request.id, type, `Checklist demo aggiornata (${keys.filter((key) => checks[key]).length}/4).`);
      result = { draft: clone(draft) };
      break;
    }
    case 'preparePr': {
      const draft = find(state.drafts, payload.id, 'Bozza');
      requireRevision(draft, payload.revision);
      if (payload.confirmation !== 'CONFERMO PR DI PROVA') throw actionError('Scrivi esattamente “CONFERMO PR DI PROVA”.');
      if (draft.status !== 'pronta_pr' || reviewIssues(draft.menu, draft.checks, find(state.requests, draft.requestId, 'Pratica').plan).issues.length)
        throw actionError('Servono fonti, revisione e approvazione scritta prima della PR di prova.');
      const snapshot = state.publicMenuSnapshots?.[draft.slug];
      const proposal = { id: uid(), draftId: draft.id, requestId: draft.requestId, kind: 'pr_simulata',
        status: 'pronta', createdAt: now(), diff: snapshot ? menuDiff(snapshot.menu, draft.menu) : null,
        diffSource: snapshot?.source || 'nessun confronto con il menu live' };
      state.proposals.unshift(proposal);
      draft.status = 'pr_simulata';
      draft.revision += 1;
      const request = find(state.requests, draft.requestId, 'Pratica');
      request.status = 'pronta_pubblicazione'; updateRequestTimestamp(request);
      appendAudit(state, draft.requestId, type, 'PR di prova preparata: nessun repository è stato modificato.');
      result = { proposal };
      break;
    }
    case 'simulatePublish': {
      const draft = find(state.drafts, payload.id, 'Bozza');
      requireRevision(draft, payload.revision);
      if (payload.confirmation !== 'CONFERMO PUBBLICAZIONE SIMULATA') throw actionError('Scrivi esattamente “CONFERMO PUBBLICAZIONE SIMULATA”.');
      if (draft.status !== 'pr_simulata' || !state.proposals.some((proposal) => proposal.draftId === draft.id && proposal.status === 'pronta')) throw actionError('Prepara prima una PR simulata.');
      draft.status = 'pubblicazione_simulata';
      draft.revision += 1;
      const request = find(state.requests, draft.requestId, 'Pratica');
      request.status = 'completata';
      updateRequestTimestamp(request);
      appendAudit(state, request.id, type, 'Pubblicazione simulata registrata: nessun menu o QR reale è stato pubblicato.');
      result = { draft: clone(draft) };
      break;
    }
    case 'addNotification': {
      if (payload.requestId) find(state.requests, payload.requestId, 'Pratica');
      const subject = String(payload.subject || '').trim();
      const body = String(payload.body || '').trim();
      if (!subject || !body) throw actionError('Oggetto e testo della notifica sono obbligatori.');
      const priority = ['normale', 'importante', 'urgente'].includes(payload.priority) ? payload.priority : 'normale';
      const dueAt = String(payload.dueAt || '').trim() || null;
      const channel = String(payload.channel || 'in_app');
      if (!['in_app', 'email', 'whatsapp', 'telefono'].includes(channel)) throw actionError('Canale di notifica non supportato.');
      const notification = { id: uid(), requestId: payload.requestId || null, channel, subject, body, priority, dueAt, readAt: null, status: 'mock', createdAt: now() };
      state.notifications.unshift(notification);
      appendAudit(state, notification.requestId, type, `Notifica demo creata: ${subject}.`);
      result = { notification };
      break;
    }
    case 'markNotificationRead': {
      const notification = find(state.notifications, payload.id, 'Notifica');
      notification.readAt = payload.read ? now() : null;
      appendAudit(state, notification.requestId, type, `Notifica demo segnata ${payload.read ? 'letta' : 'non letta'}: ${notification.subject}.`);
      result = { notification };
      break;
    }
    case 'sendMessage': {
      const request = find(state.requests, payload.requestId, 'Pratica');
      const body = String(payload.body || '').trim();
      if (!body) throw actionError('Il testo del messaggio è obbligatorio.');
      const channel = String(payload.channel || 'email');
      if (!['email', 'whatsapp', 'in_app', 'telefono'].includes(channel)) throw actionError('Canale messaggio non supportato.');
      const message = { id: uid(), requestId: request.id, channel, body, status: 'bozza_mock', createdAt: now() };
      state.messages.unshift(message);
      appendAudit(state, request.id, type, 'Bozza messaggio salvata; nessun invio esterno eseguito.');
      result = { message };
      break;
    }
    case 'logVoice': {
      if (payload.requestId) find(state.requests, payload.requestId, 'Pratica');
      const transcript = String(payload.transcript || '').trim();
      if (!transcript) throw actionError('Inserisci un comando testuale di prova.');
      appendAudit(state, payload.requestId || null, type, `Voce demo trascritta: “${transcript.slice(0, 120)}”. Nessuna conferma è stata aggirata.`);
      result = { transcript, requiresScreenConfirmation: true };
      break;
    }
    case 'mockIncomingWhatsapp': {
      const from = String(payload.from || '').replace(/\D/g, '');
      const client = state.clients.find((item) => String(item.phone || '').replace(/\D/g, '') === from && from.length >= 7);
      if (!client) throw actionError('Numero non collegato a un cliente demo.');
      const body = String(payload.body || '').trim();
      if (!body) throw actionError('Messaggio di prova obbligatorio.');
      const request = { id: uid(), clientId: client.id, subject: `WhatsApp demo · ${client.name}`, sourceText: body, sourceChannel: 'whatsapp', kind: /qr\b/i.test(body) ? 'qr' : /modific|aggiorn/i.test(body) ? 'aggiornamento' : 'nuovo', status: 'nuova', plan: client.plan, revision: 1, nextStep: 'Analizza il messaggio ricevuto in simulazione.', createdAt: now(), updatedAt: now() };
      state.requests.unshift(request);
      state.messages.unshift({ id: uid(), requestId: request.id, channel: 'whatsapp', body, status: 'bozza_mock', createdAt: now() });
      appendAudit(state, request.id, 'whatsapp.incoming.mock', 'Messaggio WhatsApp in ingresso simulato: nessun webhook reale.');
      result = { id: request.id, simulated: true };
      break;
    }
    case 'mockCall': {
      const request = find(state.requests, payload.requestId, 'Pratica');
      const body = String(payload.message || '').trim();
      if (!body) throw actionError('Testo della chiamata demo obbligatorio.');
      const notification = { id: uid(), requestId: request.id, channel: 'telefono', subject: 'Chiamata demo non avviata', body, priority: 'urgente', readAt: null, dueAt: null, status: 'mock', createdAt: now() };
      state.notifications.unshift(notification);
      appendAudit(state, request.id, 'call.mock', 'Chiamata simulata: nessun numero chiamato.');
      result = { id: notification.id, simulated: true };
      break;
    }
    case 'archiveMaterial': {
      const material = find(state.materials, payload.id, 'Materiale');
      if (payload.confirmation !== 'ARCHIVIA MATERIALE') throw actionError('Scrivi esattamente “ARCHIVIA MATERIALE”.');
      if (material.archivedAt) throw actionError('Il materiale è già archiviato.');
      const request = find(state.requests, material.requestId, 'Pratica');
      const draft = state.drafts.find((entry) => entry.requestId === request.id);
      if (['completata', 'archiviata', 'chiusa'].includes(request.status) || ['pr_simulata', 'pubblicazione_simulata'].includes(draft?.status)) throw actionError('Fonte bloccata dopo la proposta.', 409);
      material.archivedAt = now();
      material.processingStatus = 'archiviato';
      if (draft) { draft.checks = { prices: false, allergens: false, languages: false, clientApproval: false }; draft.status = 'revisione'; draft.revision += 1; }
      request.status = 'in_revisione'; updateRequestTimestamp(request);
      appendAudit(state, material.requestId, type, `Materiale demo archiviato: ${material.filename}.`);
      result = { material };
      break;
    }
    default:
      throw actionError(`Azione demo non supportata: ${type}.`, 400);
  }
  return { state: writeRaw(state), result };
}

export async function uploadDemoFile(requestId, file) {
  const state = readRaw();
  const request = find(state.requests, requestId, 'Pratica');
  const draft = state.drafts.find((entry) => entry.requestId === requestId);
  if (['completata', 'archiviata', 'chiusa'].includes(request.status) || ['pr_simulata', 'pubblicazione_simulata'].includes(draft?.status)) throw actionError('Fonte bloccata dopo la proposta.', 409);
  if (!file) throw actionError('Scegli un file prima di caricare.');
  if (file.size > MAX_FILE_SIZE) throw actionError('Limite demo: massimo 10 MB per file.');
  if (!allowedMime.test(file.type || '')) throw actionError('Sono ammessi testo, PDF, immagini e audio.');
  if (state.materials.filter((material) => material.requestId === requestId).length >= MAX_FILES_PER_REQUEST) throw actionError('Limite demo: 12 materiali per pratica.');
  let excerpt = '';
  if ((file.type || '').startsWith('text/')) {
    try { excerpt = (await file.text()).slice(0, 500); } catch (_) { excerpt = ''; }
  }
  const material = { id: uid(), requestId, filename: file.name || 'file-senza-nome', mime: file.type, size: file.size, source: 'upload_demo', processingStatus: 'metadati', textPreview: excerpt, createdAt: now() };
  state.materials.unshift(material);
  if (draft) { draft.checks = { prices: false, allergens: false, languages: false, clientApproval: false }; draft.status = 'revisione'; draft.revision += 1; }
  request.status = 'materiale_ricevuto'; updateRequestTimestamp(request);
  appendAudit(state, requestId, 'uploadFile', `Materiale demo registrato: ${material.filename}. Contenuto binario non conservato.`);
  return { state: writeRaw(state), result: { material } };
}

export const demoStorageInfo = () => ({ key: STORE_KEY, maxFileSize: MAX_FILE_SIZE, maxFiles: MAX_FILES_PER_REQUEST });

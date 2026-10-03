import { assistExtraction } from '../../_lib/assist.js';
import { applyMenuChanges } from '../../_lib/changes.js';
import { prepareUpdate } from '../../_lib/update.js';
import { PHOTO_TYPES, readMenuPdf, readMenuPhoto } from '../../_lib/vision.js';
import { linkMailFiles, receiveMailFiles } from '../../_lib/mail-files.js';
import { speak } from '../../_lib/voice.js';
import { OWNER_REVIEW } from '../../_lib/missions.js';
import { readCurrentMenu } from '../../_lib/github-live.js';
import { isSameOriginWrite, verifyOwner } from '../../_lib/auth.js';
import { slugify, validateMenu, venueFromSource } from '../../_lib/menu.js';
import { integrations } from '../../_lib/integrations.js';
import { reviewIssues, EVIDENCE_LABELS } from '../../_lib/editorial.js';
import { runPrivateIntegrationAction } from '../../_lib/operations.js';
import { sendOwnerNotification, OWNER_NOTIFICATION_RECIPIENT } from '../../_lib/owner-notifications.js';
import { purgePublishedEmail } from '../../_lib/email-retention.js';
import { resolveCategory, draftBlocker, PLAN_RULES } from '../../_lib/service-rules.js';
import { translateMenu, translationEntries, translationSummary } from '../../_lib/translate.js';
import { applyExtras, proposeSourceExtras } from '../../_lib/extras.js';
import { autopilotMessage, autopilotPreview } from '../../_lib/autopilot.js';
import { createMissions } from '../../_lib/missions.js';
import { getMe, randomToken, sendTelegram, sendVoice, setWebhook, telegramReady } from '../../_lib/telegram.js';
import { ACTIVATIONS, approvalEvidence, approvalState, assessReply, previewEmail, previewUrl, proposeReplyChanges, referenceCode, sha256Hex } from '../../_lib/approvals.js';
const headers = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json; charset=utf-8' };
const answer = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
const failure = (status, message) => answer({ error: message }, status);
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const clean = (value, limit, label, required = true) => {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > limit)
    throw Object.assign(new Error(`${label}: testo non valido o troppo lungo.`), { status: 422 });
  return value.trim();
};
const identifier = (value) => clean(value, 80, 'Identificativo');
const plans = new Set(['standard', 'annuale', 'premium', 'da_definire']);
const kinds = new Set(['nuovo', 'aggiornamento', 'prezzo', 'traduzione', 'qr', 'commerciale', 'altro']);
const channels = new Set(['manuale', 'email', 'whatsapp', 'telefono', 'instagram', 'altro']);
const statuses = new Set(['nuova', 'materiale_ricevuto', 'in_analisi', 'dati_da_confermare', 'bozza_pronta', 'in_revisione', 'in_attesa', 'archiviata', 'chiusa']);
const optional = (value, limit, label) => value == null || value === '' ? null : clean(value, limit, label);
const optionalDate = (value) => {
  if (value == null || value === '') return null;
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && !Number.isNaN(Date.parse(value)), 'Data non valida.');
  return value;
};
const optionalMenuUrl = (value) => {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { assert(false, 'URL menù non valido.'); }
  assert(url.protocol === 'https:' && ['renmenu.pages.dev', 'rua56.github.io'].includes(url.hostname), 'URL menù non autorizzato.');
  return url.href;
};
const assert = (condition, message, status = 422) => {
  if (!condition) throw Object.assign(new Error(message), { status });
};
const getOne = (db, sql, ...params) => db.prepare(sql).bind(...params).first();
const rows = async (db, sql, ...params) => (await db.prepare(sql).bind(...params).all()).results || [];
async function auditedBatch(db, writes, event, summary, requestId = null, guard = null) {
  const id = uid(), stamp = now();
  const auditSql = guard
    ? `INSERT INTO audit_events (id,request_id,action,summary,actor,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS (${guard.sql})`
    : 'INSERT INTO audit_events (id,request_id,action,summary,actor,created_at) VALUES (?,?,?,?,?,?)';
  const audit = db.prepare(auditSql).bind(id, requestId, event, summary.slice(0, 240), db.actor || 'owner', stamp, ...(guard?.args || []));
  const statements = [...writes, audit];
  if (requestId) statements.push(db.prepare('UPDATE requests SET last_action_at=? WHERE id=? AND EXISTS (SELECT 1 FROM audit_events WHERE id=?)').bind(stamp, requestId, id));
  // D1.batch executes within one transaction: an audit failure rolls the business write back.
  const results = await db.batch(statements);
  assert(results[writes.length].meta.changes === 1, 'Operazione concorrente: nessun audit registrato. Ricarica.', 409);
  return results.slice(0, writes.length);
}
const checksDefault = () => ({ prices: false, allergens: false, languages: false, clientApproval: false });

const REQUESTS_SQL = 'SELECT id,client_id AS clientId,subject,source_channel AS sourceChannel,source_text AS sourceText,kind,status,plan,contact_name AS contactName,contact_role AS contactRole,contact_info AS contactInfo,internal_notes AS internalNotes,menu_id AS menuId,public_url AS publicUrl,next_step AS nextStep,follow_up_at AS followUpAt,last_action_at AS lastActionAt,revision,created_at AS createdAt,updated_at AS updatedAt FROM requests ORDER BY created_at DESC LIMIT 500';
// Fallback finche la migrazione 0004 (colonna category) non e applicata allo staging D1.
async function requestRows(db) {
  try { return await rows(db, REQUESTS_SQL.replace('kind,status,plan,', 'kind,category,status,plan,')); }
  catch (error) {
    if (!/no such column/i.test(String(error?.message))) throw error;
    return (await rows(db, REQUESTS_SQL)).map((request) => ({ ...request, category: null }));
  }
}
// Un nuovo menu non può riusare l'identificativo (URL/QR) di un'altra bozza o di un altro cliente:
// una pubblicazione reale sovrascriverebbe il menu di un altro locale.
async function assertSlugFree(db, slug, requestId, clientId) {
  const draft = await getOne(db, "SELECT d.slug, c.name AS clientName FROM drafts d JOIN requests r ON r.id=d.request_id JOIN clients c ON c.id=r.client_id WHERE d.slug=? AND d.request_id<>? AND r.status<>'archiviata' LIMIT 1", slug, requestId); // le prove archiviate (mai pubblicate) non bloccano il nome
  const client = await getOne(db, 'SELECT name FROM clients WHERE menu_id=? AND id<>? LIMIT 1', slug, clientId || '');
  const owner = draft?.clientName || client?.name;
  assert(!owner, `Identificativo «${slug}» già usato da «${owner}»: un nuovo menu sovrascriverebbe quel locale. Imposta nella pratica un Menu ID diverso, poi salva e genera.`, 409);
}
// Fallback finché la migrazione 0006 non è applicata: nessuna approvazione registrata.
async function approvalRows(db) {
  try { return await rows(db, 'SELECT * FROM publication_approvals ORDER BY updated_at DESC LIMIT 500'); }
  catch (error) { if (/no such table/i.test(String(error?.message))) return []; throw error; }
}
const valueAt = (menu, path) => String(path).split('.').reduce((node, key) => (node == null ? undefined : node[key]), menu);
export function keepProvenance(entries, menu) {
  const same = (entry) => entry && typeof entry.path === 'string' && valueAt(menu, entry.path) !== undefined
    && String(valueAt(menu, entry.path)) === String(entry.value);
  const kept = entries.filter(same);
  // Un prezzo resta attestato solo se allo stesso posto c'è ancora lo stesso piatto:
  // piatti spostati o rinominati perdono tutte le loro fonti.
  const itemOf = (path) => /^(sezioni\.\d+\.voci\.\d+)\./.exec(path)?.[1];
  const namedItems = new Set(entries.filter((entry) => /\.nome\.it$/.test(entry?.path || '') && itemOf(entry.path)).map((entry) => itemOf(entry.path)));
  const keptNames = new Set(kept.filter((entry) => /\.nome\.it$/.test(entry.path) && itemOf(entry.path)).map((entry) => itemOf(entry.path)));
  return kept.filter((entry) => { const item = itemOf(entry.path); return !item || !namedItems.has(item) || keptNames.has(item); });
}
const INTERNAL_CHECKS = ['prices', 'allergens', 'languages'];
// Revisione interna (passaggio 1): tutte le regole editoriali tranne il consenso del cliente,
// che ha un percorso proprio (anteprima → risposta → conferma di Riccardo).
const internalIssues = (menu, checks, plan) => reviewIssues(menu,
  { ...checks, clientApproval: true, clientApprovalEvidence: 'Percorso di approvazione del cliente separato.' }, plan).issues;
async function approvalFor(db, draft, requestKind) {
  const approval = await getOne(db, 'SELECT * FROM publication_approvals WHERE draft_id=?', draft.id);
  return { approval, ...approvalState(approval, await sha256Hex(draft.menu_json), requestKind) };
}
const autoTranslationReady = (env) => typeof env?.AI?.run === 'function' && String(env?.TRANSLATION_PROVIDER || 'workers_ai') !== 'disabled';
const DRAFTS_SQL = 'SELECT id,request_id AS requestId,slug,menu_json AS menuJson,status,checks_json AS checksJson,revision,created_at AS createdAt,updated_at AS updatedAt FROM drafts ORDER BY created_at DESC LIMIT 500';
// Fallback finche la migrazione 0005 (colonna provenance_json) non e applicata allo staging D1.
async function draftRows(db) {
  try { return await rows(db, DRAFTS_SQL.replace('checks_json AS checksJson,', 'checks_json AS checksJson,provenance_json AS provenanceJson,')); }
  catch (error) {
    if (!/no such column/i.test(String(error?.message))) throw error;
    return rows(db, DRAFTS_SQL);
  }
}
const parseList = (json) => { try { const value = JSON.parse(json || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } };
// Autopilota: richieste email nuove, mai toccate da Riccardo né da Jarvis. Le azioni passano
// dalle stesse operazioni dell'interfaccia (stessi controlli), con «jarvis» come autore nel registro.
const AUTOPILOT_SQL = `SELECT r.*, c.menu_id AS client_menu_id FROM requests r JOIN clients c ON c.id=r.client_id WHERE r.source_channel='email' AND r.status='nuova' AND r.kind='altro'
  AND r.category IS NULL AND r.revision=1 AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.request_id=r.id)
  AND NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.request_id=r.id AND a.action LIKE 'autopilot.%')
  AND NOT EXISTS (SELECT 1 FROM materials m WHERE m.request_id=r.id AND m.processing_status='da_trascrivere' AND m.archived_at IS NULL AND (m.mime='application/pdf' OR m.mime IN ('image/jpeg','image/png','image/webp')))
  ORDER BY r.created_at ASC LIMIT 2`;
async function autopilotPending(db) {
  try { return await rows(db, AUTOPILOT_SQL); } catch (error) { if (/no such column/i.test(String(error?.message))) return []; throw error; }
}
const asJarvis = (db) => ({ prepare: (sql) => db.prepare(sql), batch: (statements) => db.batch(statements), actor: 'jarvis' });
// Foto e PDF arrivati (email, Telegram o caricati da Riccardo): Jarvis li legge da solo, uno per
// giro dell'orologio, e poi riprova l'autopilota sulla pratica.
export const receivePendingMail = async (db, env, payload) => {
  const outcome = await receiveMailFiles(db, env, payload, { now, uid });
  if (outcome.ok && outcome.skipped.length) {
    // Allegati che Jarvis non sa leggere (Word, HEIC, ecc.): li segnala, non li perde in silenzio.
    await missions.notify(db, env, null, 'allegati da caricare a mano', `L'email di ${String(payload.from).slice(0, 120)} «${String(payload.subject || '').slice(0, 80)}» ha allegati che non so leggere: ${outcome.skipped.join(', ')}. Aprili in Gmail e, se servono, caricali in Materiali come PDF o foto.`);
  }
  return { ok: outcome.ok, stored: outcome.stored ?? 0, skipped: outcome.skipped?.length ?? 0, error: outcome.error };
};
export const linkPendingMailFiles = (db, env) => linkMailFiles(db, env, { now, uid, auditedBatch });
async function discardUntouchedJarvisDraft(db, requestId) {
  const draft = await getOne(db, "SELECT id FROM drafts WHERE request_id=? AND status='bozza' AND revision=1", requestId);
  if (!draft) return false;
  const history = await rows(db, "SELECT action,actor FROM audit_events WHERE request_id=? AND (action LIKE 'draft.%' OR action LIKE 'preview.%' OR action LIKE 'publication.%' OR action LIKE 'pr.%' OR action LIKE 'mission.%')", requestId);
  if (!history.length || history.some((h) => h.action !== 'draft.generate' || h.actor !== 'jarvis')) return false;
  for (const table of ['pr_proposals', 'live_pr_operations', 'publication_approvals', 'jarvis_missions']) {
    let used = null;
    try { used = await getOne(db, `SELECT 1 AS x FROM ${table} WHERE draft_id=?`, draft.id); } catch { used = null; }
    if (used) return false;
  }
  await db.prepare('DELETE FROM draft_versions WHERE draft_id=?').bind(draft.id).run();
  await db.prepare('DELETE FROM drafts WHERE id=?').bind(draft.id).run();
  return true;
}
export async function readPendingMaterials(db, env = {}) {
  let pending = [];
  try { pending = await rows(db, "SELECT id,request_id,filename FROM materials WHERE processing_status='da_trascrivere' AND archived_at IS NULL AND (mime='application/pdf' OR mime IN ('image/jpeg','image/png','image/webp')) AND created_at>'2026-10-02T22:30' ORDER BY created_at ASC LIMIT 1"); }
  catch { return []; }
  const done = [];
  for (const material of pending) {
    const jarvis = asJarvis(db);
    try {
      const outcome = (await action(jarvis, 'readMaterial', { materialId: material.id }, env)).result;
      // Pratica già classificata e senza bozza (es. foto aggiunta da Telegram): Jarvis prepara la bozza.
      const request = await getOne(db, 'SELECT id,category,plan,kind,subject FROM requests WHERE id=?', material.request_id);
      const stillUnread = await getOne(db, "SELECT id FROM materials WHERE request_id=? AND processing_status='da_trascrivere' AND archived_at IS NULL", material.request_id);
      if (stillUnread) { outcome.waiting = true; done.push({ material, request, outcome }); continue; } // bozza dopo l'ultima foto
      // Bozza preparata da Jarvis e mai toccata (né da Riccardo né in pubblicazione): la rifà con tutte le foto.
      if (outcome.ok) await discardUntouchedJarvisDraft(db, material.request_id);
      const hasDraft = await getOne(db, 'SELECT id FROM drafts WHERE request_id=?', material.request_id);
      if (outcome.ok && request?.category && !hasDraft) {
        try { await action(jarvis, 'generateDraft', { requestId: request.id }, env); outcome.drafted = true; }
        catch (error) { outcome.draftError = String(error?.message || 'errore').slice(0, 240); }
      }
      done.push({ material, request, outcome });
    }
    catch (error) {
      await db.prepare("UPDATE materials SET processing_status='non_leggibile' WHERE id=?").bind(material.id).run();
      done.push({ material, outcome: { ok: false, reason: String(error?.message || 'errore').slice(0, 200) } });
    }
  }
  return done;
}
export async function runAutopilot(db, env = {}) {
  const done = [];
  for (const request of await autopilotPending(db)) {
    const preview = autopilotPreview(request);
    const jarvis = asJarvis(db);
    let outcome = preview.action, blocked = '';
    try {
      if (preview.category) {
        const next = preview.action === 'bozza' ? 'Bozza preparata da Jarvis: controllala in Revisione.' : `Proposta di Jarvis: ${preview.categoryLabel}. Conferma o cambia la categoria.`;
        await action(jarvis, 'updateRequest', { id: request.id, revision: request.revision, patch: { category: preview.category, nextStep: next.slice(0, 240) } }, env);
      }
      if (preview.action === 'bozza') await action(jarvis, 'generateDraft', { requestId: request.id }, env);
    } catch (error) {
      outcome = 'proponi';
      blocked = String(error?.message || 'Operazione non completata.').slice(0, 300);
    }
    const message = blocked ? `${autopilotMessage(request.subject, { ...preview, why: '' }, 'proponi')} Bozza non generata: ${blocked}` : autopilotMessage(request.subject, preview, outcome);
    const id = uid(), stamp = now();
    const why = preview.reasons ? ` Fonte: ${preview.reasons}.` : '';
    await auditedBatch(jarvis, [db.prepare('INSERT INTO notifications (id,request_id,channel,subject,body,priority,due_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(id, request.id, 'in_app', outcome === 'bozza' ? 'Jarvis · bozza pronta' : 'Jarvis · serve una tua decisione', `${message}${why}`.slice(0, 5000), outcome === 'bozza' ? 'importante' : 'normale', null, 'mock', stamp)],
    outcome === 'bozza' ? 'autopilot.draft' : 'autopilot.proposal', message, request.id, { sql: 'SELECT 1 FROM notifications WHERE id=?', args: [id] });
    done.push({ requestId: request.id, outcome, message });
  }
  return done;
}

export async function state(db, env = {}) {
  const [clients, requests, materials, rawDrafts, versions, notifications, messages, audit, proposals, rawAnalyses, livePrs, ownerDeliveries, rawApprovals] = await Promise.all([
    rows(db, 'SELECT id,name,email,phone,contact_name AS contactName,contact_role AS contactRole,plan,payment_status AS paymentStatus,menu_id AS menuId,menu_url AS menuUrl,internal_notes AS internalNotes,trial_ends_at AS trialEndsAt,renewal_at AS renewalAt,revision,created_at AS createdAt,updated_at AS updatedAt FROM clients ORDER BY created_at DESC LIMIT 300'),
    requestRows(db),
    rows(db, 'SELECT id,request_id AS requestId,filename,mime,size,source,processing_status AS processingStatus,text_preview AS textPreview,archived_at AS archivedAt,created_at AS createdAt FROM materials ORDER BY created_at DESC LIMIT 500'),
    draftRows(db),
    rows(db, 'SELECT id,draft_id AS draftId,revision,menu_json AS menuJson,actor,created_at AS createdAt FROM draft_versions ORDER BY created_at DESC LIMIT 1000'),
    rows(db, 'SELECT id,request_id AS requestId,channel,subject,body,priority,due_at AS dueAt,read_at AS readAt,status,created_at AS createdAt FROM notifications ORDER BY created_at DESC LIMIT 300'),
    rows(db, 'SELECT id,request_id AS requestId,channel,body,status,created_at AS createdAt FROM messages ORDER BY created_at DESC LIMIT 300'),
    rows(db, 'SELECT id,request_id AS requestId,action,summary,actor,created_at AS createdAt FROM audit_events ORDER BY created_at DESC LIMIT 500'),
    rows(db, 'SELECT id,draft_id AS draftId,revision,snapshot_sha AS snapshotSha,diff_json AS diffJson,branch_name AS branchName,file_path AS filePath,commit_message AS commitMessage,pr_body AS prBody,status,created_at AS createdAt FROM pr_proposals ORDER BY created_at DESC LIMIT 300'),
    rows(db, 'SELECT id,material_id AS materialId,request_id AS requestId,source_sha256 AS sourceSha256,source_text AS sourceText,provenance_json AS provenanceJson,warnings_json AS warningsJson,status,created_at AS createdAt FROM material_analyses ORDER BY created_at DESC LIMIT 500'),
    rows(db, 'SELECT id,draft_id AS draftId,revision,snapshot_sha AS snapshotSha,base_sha AS baseSha,branch_name AS branchName,pr_number AS prNumber,pr_url AS prUrl,status,created_at AS createdAt,updated_at AS updatedAt FROM live_pr_operations ORDER BY created_at DESC LIMIT 300'),
    rows(db, "SELECT id,request_id AS requestId,recipient,status,provider_id AS providerId,created_at AS createdAt,updated_at AS updatedAt FROM outbound_deliveries WHERE channel='email' AND recipient='renmenu1569@gmail.com' ORDER BY created_at DESC LIMIT 300"),
    approvalRows(db)
  ]);
  return {
    githubMode: String(env?.GITHUB_PROVIDER || 'mock').trim() === 'live' ? 'live' : 'mock',
    clients, requests, materials,
    drafts: rawDrafts.map(({ menuJson, checksJson, provenanceJson, ...draft }) => ({ ...draft, menu: JSON.parse(menuJson), checks: JSON.parse(checksJson), provenance: parseList(provenanceJson),
      versions: versions.filter((version) => version.draftId === draft.id).map(({ menuJson: json, ...v }) => ({ ...v, menu: JSON.parse(json) })),
      sourceExtras: ['bozza', 'revisione', 'pronta_pr'].includes(draft.status)
        ? proposeSourceExtras(requests.find((entry) => entry.id === draft.requestId)?.sourceText, JSON.parse(menuJson)) : [] })),
    notifications, messages, audit, autopilotPending: (await autopilotPending(db)).length,
    missions: await missionRows(db),
    telegram: { configured: telegramReady(env), linked: Boolean(await missions.setting(db, 'telegram_chat_id')) },
    voice: { provider: (await missions.setting(db, 'voice_provider')) || '', voiceId: (await missions.setting(db, 'voice_id')) || '', hasKey: Boolean(await missions.setting(db, 'voice_api_key')) },
    proposals: proposals.map(({ diffJson, ...p }) => ({ ...p, diff: JSON.parse(diffJson) })),
    analyses: rawAnalyses.map(({ provenanceJson, warningsJson, ...entry }) => ({ ...entry,
      provenance: JSON.parse(provenanceJson), warnings: JSON.parse(warningsJson) })),
    livePrs, ownerDeliveries,
    approvals: await Promise.all(rawApprovals.map(async (approval) => {
      const draft = rawDrafts.find((entry) => entry.id === approval.draft_id);
      const request = requests.find((entry) => entry.id === approval.request_id);
      const current = draft ? await sha256Hex(draft.menuJson) : '';
      const stateNow = approvalState(approval, current, request?.kind);
      return { id: approval.id, draftId: approval.draft_id, requestId: approval.request_id, referenceCode: approval.reference_code,
        status: approval.status, recipient: approval.recipient, previewUrl: approval.preview_url, emailSubject: approval.email_subject,
        emailBody: approval.email_body, preparedAt: approval.prepared_at, sentAt: approval.sent_at, replyFrom: approval.reply_from,
        replyText: approval.reply_text, replyReceivedAt: approval.reply_received_at, approvedAt: approval.approved_at,
        approvalEvidence: approval.approval_evidence, activation: approval.activation, activationDate: approval.activation_date,
        activationNote: approval.activation_note, revision: approval.revision, stale: stateNow.stale, valid: stateNow.valid,
        activationMissing: stateNow.activationMissing,
        replyAssessment: approval.reply_text ? assessReply(approval.reply_text) : null,
        changeProposals: approval.status === 'modifiche_richieste' && approval.reply_text && draft
          ? proposeReplyChanges(approval.reply_text, JSON.parse(draft.menuJson)) : [] };
    }))
  };
}

// Jarvis autonomo: missioni affidate da Riccardo (vedi _lib/missions.js).
export const missions = createMissions({ action: (...args) => action(...args), auditedBatch, getOne, rows, now, uid, fetchImpl: (...args) => globalThis.fetch(...args) });
async function missionRows(db) {
  try { return await rows(db, 'SELECT id,request_id AS requestId,draft_id AS draftId,status,note,rounds,step_started_at AS stepStartedAt,updated_at AS updatedAt FROM jarvis_missions ORDER BY updated_at DESC LIMIT 200'); }
  catch (error) { if (/no such table/i.test(String(error?.message))) return []; throw error; }
}
export async function action(db, type, input, env = {}) {
  const p = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const privateResult = await runPrivateIntegrationAction({
    db, env, auditedBatch, getOne, rows, now, uid
  }, type, p);
  if (privateResult !== null) return { state: await state(db, env), result: privateResult };
  let result = {};
  if (type === 'createClient') {
    const name = clean(p.name, 140, 'Nome cliente');
    const email = p.email ? clean(p.email, 254, 'Email') : null;
    const phone = p.phone ? clean(p.phone, 40, 'Telefono') : null;
    assert(!email || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), 'Email non valida.');
    const plan = p.plan || 'da_definire';
    assert(plans.has(plan), 'Piano non valido.');
    const paymentStatus = optional(p.paymentStatus, 30, 'Stato pagamento');
    assert(!paymentStatus || ['da_verificare', 'in_prova', 'attivo', 'in_scadenza', 'scaduto'].includes(paymentStatus), 'Stato pagamento non verificato.');
    const id = uid(), timestamp = now();
    await auditedBatch(db, [db.prepare('INSERT INTO clients (id,name,email,phone,contact_name,contact_role,plan,payment_status,menu_id,menu_url,internal_notes,trial_ends_at,renewal_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, name, email, phone, optional(p.contactName, 140, 'Referente'), optional(p.contactRole, 80, 'Ruolo'), plan, paymentStatus,
        optional(p.menuId, 64, 'Menu ID'), optionalMenuUrl(p.menuUrl), optional(p.internalNotes, 3_000, 'Note') || '',
        optionalDate(p.trialEndsAt), optionalDate(p.renewalAt), timestamp, timestamp)], 'client.create', `Cliente registrato: ${name}.`, null,
      { sql: 'SELECT 1 FROM clients WHERE id=?', args: [id] });
    result = { id };
  } else if (type === 'updateClient') {
    const id = identifier(p.id), revision = Number(p.revision);
    const current = await getOne(db, 'SELECT * FROM clients WHERE id=?', id);
    assert(current, 'Cliente non trovato.', 404);
    assert(revision === current.revision, 'Scheda cliente modificata da un’altra sessione. Ricarica.', 409);
    const patch = p.patch && typeof p.patch === 'object' && !Array.isArray(p.patch) ? p.patch : {};
    assert(Object.keys(patch).length > 0 && Object.keys(patch).every((key) => ['name', 'email', 'phone', 'contactName', 'contactRole', 'plan', 'paymentStatus', 'menuId', 'menuUrl', 'internalNotes', 'trialEndsAt', 'renewalAt'].includes(key)), 'Campi cliente non modificabili.');
    const value = (key, old, limit, label) => key in patch ? optional(patch[key], limit, label) : old;
    const name = 'name' in patch ? clean(patch.name, 140, 'Nome locale') : current.name;
    const email = value('email', current.email, 254, 'Email');
    const phone = value('phone', current.phone, 40, 'Telefono');
    const plan = 'plan' in patch ? patch.plan : current.plan;
    const paymentStatus = value('paymentStatus', current.payment_status, 30, 'Stato pagamento');
    assert(!email || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), 'Email non valida.');
    assert(plans.has(plan) && (!paymentStatus || ['da_verificare', 'in_prova', 'attivo', 'in_scadenza', 'scaduto'].includes(paymentStatus)), 'Piano o stato pagamento non valido.');
    const stamp = now();
    const [updated] = await auditedBatch(db, [db.prepare('UPDATE clients SET name=?,email=?,phone=?,contact_name=?,contact_role=?,plan=?,payment_status=?,menu_id=?,menu_url=?,internal_notes=?,trial_ends_at=?,renewal_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?')
      .bind(name, email, phone, value('contactName', current.contact_name, 140, 'Referente'), value('contactRole', current.contact_role, 80, 'Ruolo'), plan,
        paymentStatus, value('menuId', current.menu_id, 64, 'Menu ID'), 'menuUrl' in patch ? optionalMenuUrl(patch.menuUrl) : current.menu_url,
        value('internalNotes', current.internal_notes, 3_000, 'Note') || '',
        'trialEndsAt' in patch ? optionalDate(patch.trialEndsAt) : current.trial_ends_at,
        'renewalAt' in patch ? optionalDate(patch.renewalAt) : current.renewal_at, stamp, id, revision)],
      'client.update', `Scheda cliente aggiornata: ${name}.`, null,
      { sql: 'SELECT 1 FROM clients WHERE id=? AND revision=? AND updated_at=?', args: [id, revision + 1, stamp] });
    assert(updated.meta.changes === 1, 'Scheda cliente modificata da un’altra sessione. Ricarica.', 409);
    result = { id };
  } else if (type === 'createRequest') {
    const clientId = identifier(p.clientId);
    assert(await getOne(db, 'SELECT id FROM clients WHERE id=?', clientId), 'Cliente non trovato.', 404);
    const subject = clean(p.subject, 180, 'Oggetto');
    const sourceText = clean(p.sourceText ?? '', 50_000, 'Materiale', false);
    const sourceChannel = clean(p.sourceChannel, 30, 'Canale');
    const { category, kind, plan } = resolveCategory({ category: p.category, kind: p.kind, plan: p.plan || 'da_definire' });
    assert(kinds.has(kind), 'Tipo pratica non valido.');
    assert(channels.has(sourceChannel) && plans.has(plan), 'Canale o piano non valido.');
    const id = uid(), timestamp = now();
    const categoryColumn = category ? ',category' : '', categoryMark = category ? ',?' : '';
    await auditedBatch(db, [db.prepare(`INSERT INTO requests (id,client_id,subject,source_channel,source_text,kind,status,plan,contact_name,contact_role,contact_info,internal_notes,menu_id,public_url,next_step,follow_up_at,revision,created_at,updated_at${categoryColumn}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?${categoryMark})`)
      .bind(id, clientId, subject, sourceChannel, sourceText, kind, 'nuova', plan, optional(p.contactName, 140, 'Referente'),
        optional(p.contactRole, 80, 'Ruolo'), optional(p.contactInfo, 254, 'Contatto'), optional(p.internalNotes, 3_000, 'Note') || '',
        optional(p.menuId, 64, 'Menu ID'), optionalMenuUrl(p.publicUrl), optional(p.nextStep, 240, 'Prossimo passo'), optionalDate(p.followUpAt),
        1, timestamp, timestamp, ...(category ? [category] : []))], 'request.create', `Pratica ${category || kind} (${plan}): ${subject}.`, id,
      { sql: 'SELECT 1 FROM requests WHERE id=?', args: [id] });
    result = { id };
  } else if (type === 'updateRequest') {
    const id = identifier(p.id), revision = Number(p.revision);
    const current = await getOne(db, 'SELECT * FROM requests WHERE id=?', id);
    assert(current, 'Pratica non trovata.', 404);
    assert(Number.isInteger(revision) && revision === current.revision, 'Pratica modificata da un’altra sessione. Ricarica.', 409);
    assert(!['completata', 'archiviata', 'chiusa'].includes(current.status), 'Pratica chiusa: non modificabile.', 409);
    const linkedDraft = await getOne(db, 'SELECT status FROM drafts WHERE request_id=?', id);
    assert(!linkedDraft || !['pr_simulata', 'pubblicazione_simulata'].includes(linkedDraft.status), 'Proposta già preparata: crea una nuova pratica per modificare le fonti.', 409);
    const patch = p.patch && typeof p.patch === 'object' && !Array.isArray(p.patch) ? p.patch : {};
    assert(Object.keys(patch).length > 0 && Object.keys(patch).every((key) => ['subject', 'sourceText', 'sourceChannel', 'kind', 'status', 'plan', 'contactName', 'contactRole', 'contactInfo', 'internalNotes', 'menuId', 'publicUrl', 'nextStep', 'followUpAt', 'category'].includes(key)), 'Campi non modificabili.');
    const subject = 'subject' in patch ? clean(patch.subject, 180, 'Oggetto') : current.subject;
    const sourceText = 'sourceText' in patch ? clean(patch.sourceText, 50_000, 'Materiale', false) : current.source_text;
    const sourceChannel = 'sourceChannel' in patch ? clean(patch.sourceChannel, 30, 'Canale') : current.source_channel;
    const status = 'status' in patch ? patch.status : current.status;
    let requestedCategory = 'category' in patch ? patch.category : (current.category ?? null);
    const requestedPlan = 'plan' in patch ? patch.plan : current.plan;
    // Se cambia solo il piano di un nuovo menu, la categoria segue il piano scelto.
    if (!('category' in patch) && 'plan' in patch && typeof requestedCategory === 'string' && requestedCategory.startsWith('nuovo_'))
      requestedCategory = plans.has(requestedPlan) && requestedPlan !== 'da_definire' ? `nuovo_${requestedPlan}` : requestedCategory;
    const resolved = resolveCategory({ category: requestedCategory, kind: 'kind' in patch ? patch.kind : current.kind, plan: requestedPlan });
    const kind = resolved.kind, plan = resolved.plan, category = resolved.category;
    const writeCategory = 'category' in patch || category !== (current.category ?? null);
    assert(kinds.has(kind) && channels.has(sourceChannel) && plans.has(plan), 'Canale, tipo o piano non valido.');
    if ('status' in patch) {
      assert(!['approvata', 'pronta_pubblicazione'].includes(current.status), 'Stato approvato: per ricominciare modifica la fonte.', 409);
      assert(statuses.has(status), 'Stato approvativo non impostabile manualmente.');
    }
    const contactName = 'contactName' in patch ? optional(patch.contactName, 140, 'Referente') : current.contact_name;
    const contactRole = 'contactRole' in patch ? optional(patch.contactRole, 80, 'Ruolo') : current.contact_role;
    const contactInfo = 'contactInfo' in patch ? optional(patch.contactInfo, 254, 'Contatto') : current.contact_info;
    const internalNotes = 'internalNotes' in patch ? optional(patch.internalNotes, 3_000, 'Note') || '' : current.internal_notes;
    const menuId = 'menuId' in patch ? optional(patch.menuId, 64, 'Menu ID') : current.menu_id;
    const publicUrl = 'publicUrl' in patch ? optionalMenuUrl(patch.publicUrl) : current.public_url;
    const nextStep = 'nextStep' in patch ? optional(patch.nextStep, 240, 'Prossimo passo') : current.next_step;
    const followUpAt = 'followUpAt' in patch ? optionalDate(patch.followUpAt) : current.follow_up_at;
    const changedSource = sourceText !== current.source_text;
    const nextStatus = changedSource ? 'in_revisione' : status;
    const stamp = now();
    const writes = [db.prepare(`UPDATE requests SET subject=?,source_text=?,source_channel=?,kind=?,status=?,plan=?,contact_name=?,contact_role=?,contact_info=?,internal_notes=?,menu_id=?,public_url=?,next_step=?,follow_up_at=?,${writeCategory ? 'category=?,' : ''}revision=revision+1,updated_at=? WHERE id=? AND revision=?`)
      .bind(subject, sourceText, sourceChannel, kind, nextStatus, plan, contactName, contactRole, contactInfo, internalNotes, menuId, publicUrl, nextStep, followUpAt, ...(writeCategory ? [category] : []), stamp, id, revision)];
    if (changedSource) writes.push(db.prepare("UPDATE drafts SET checks_json=?,status='revisione',revision=revision+1,updated_at=? WHERE request_id=? AND status IN ('bozza','revisione','pronta_pr') AND EXISTS (SELECT 1 FROM requests WHERE id=? AND revision=? AND updated_at=?)")
      .bind(JSON.stringify(checksDefault()), stamp, id, id, revision + 1, stamp));
    const [outcome] = await auditedBatch(db, writes, 'request.update', changedSource ? 'Fonte aggiornata: verifiche bozza azzerate.' : 'Dati pratica aggiornati.', id,
      { sql: 'SELECT 1 FROM requests WHERE id=? AND revision=? AND updated_at=?', args: [id, revision + 1, stamp] });
    assert(outcome.meta.changes === 1, 'Pratica modificata da un’altra sessione. Ricarica.', 409);
    result = { id };
  } else if (type === 'generateDraft') {
    const requestId = identifier(p.requestId);
    const request = await getOne(db, 'SELECT r.*, c.name AS client_name,c.menu_id AS client_menu_id,c.plan AS client_plan FROM requests r JOIN clients c ON c.id=r.client_id WHERE r.id=?', requestId);
    assert(request, 'Pratica non trovata.', 404);
    assert(!await getOne(db, 'SELECT id FROM drafts WHERE request_id=?', requestId), 'Esiste già una bozza per questa pratica.', 409);
    // Aggiornamento di un menu attivo: il piano è quello del cliente (scheda cliente), non va riscelto.
    const isUpdate = ['aggiornamento', 'prezzo'].includes(request.kind);
    const inheritedPlan = isUpdate && !PLAN_RULES[request.plan] && PLAN_RULES[request.client_plan] ? request.client_plan : null;
    if (inheritedPlan) request.plan = inheritedPlan;
    const planBlock = isUpdate && !PLAN_RULES[request.plan] ? 'Piano del cliente non registrato: impostalo nella scheda cliente (Standard, Annuale o Premium), poi genera la bozza.' : draftBlocker(request.plan);
    assert(!planBlock, planBlock, 422);
    // Pratica importata e non classificata (kind 'altro', nessuna categoria): chiedere la categoria, non il Menu ID.
    assert(!(request.kind === 'altro' && !request.category), 'Scegli la categoria della pratica (per esempio “Nuovo menu Standard”) e salva prima di generare la bozza.', 422);
    if (request.kind !== 'nuovo') assert(request.menu_id || request.client_menu_id, 'Aggiornamento: serve il Menu ID esistente per preservare il QR.', 422);
    // Contatto Gmail non attestato: per un menu nuovo usa solo una riga esplicita "Locale: …" del testo.
    // La scheda cliente resta invariata; il nome va confermato in revisione.
    const emailVenue = request.kind === 'nuovo' ? venueFromSource(request.source_text) : '';
    const placeholder = request.client_name === 'Nuovo contatto email';
    // Riga "Locale:" diversa dal cliente collegato (es. stesso mittente, altro locale): decide Riccardo
    // impostando nella pratica il Menu ID; senza quella scelta non si genera.
    const mismatch = emailVenue && !placeholder && slugify(emailVenue) !== slugify(request.client_name);
    assert(!mismatch || request.menu_id, `L’email indica il locale «${emailVenue}», ma il cliente collegato è «${request.client_name}». Se è un locale nuovo, imposta nella pratica il Menu ID (per esempio ${slugify(emailVenue)}); se è lo stesso locale, non è un menu nuovo: scegli la categoria di aggiornamento adatta. Poi salva e genera.`, 409);
    const sourceVenue = emailVenue && (placeholder || (mismatch && slugify(request.menu_id) === slugify(emailVenue))) ? emailVenue : '';
    const venue = sourceVenue || request.client_name;
    const desiredSlug = request.menu_id || (request.kind !== 'nuovo' ? request.client_menu_id : venue);
    if (request.kind === 'nuovo') await assertSlugFree(db, slugify(desiredSlug), requestId, request.client_id);
    // Foto e PDF già letti (da Jarvis o trascritti a mano): si aggiungono in coda al testo della
    // pratica; la provenienza indica il file e la riga, non la riga del testo combinato.
    const analyses = await rows(db, "SELECT a.source_text AS text,a.provenance_json AS prov,m.filename FROM material_analyses a JOIN materials m ON m.id=a.material_id WHERE a.request_id=? AND m.archived_at IS NULL AND a.status IN ('needs_review','complete') AND length(a.source_text)>0 ORDER BY a.created_at", requestId);
    let combinedSource = String(request.source_text || '');
    const segments = [];
    for (const analysis of analyses) {
      const start = combinedSource.split(/\r?\n/).length + 1;
      combinedSource += `\n${analysis.text}`;
      const method = parseList(analysis.prov)[0]?.method || 'manual';
      segments.push({ start, end: combinedSource.split(/\r?\n/).length, filename: analysis.filename, method });
    }
    const relabel = (rowsIn) => rowsIn.map((row) => {
      const match = String(row.source || '').match(/^riga (\d+)(.*)$/);
      const segment = match && segments.find((seg) => Number(match[1]) >= seg.start && Number(match[1]) <= seg.end);
      if (!segment) return row;
      const how = segment.method === 'jarvis_foto_doppia_lettura' ? 'letta da Jarvis due volte' : segment.method === 'jarvis_pdf_testo' ? 'testo del PDF' : segment.method === 'manual' ? 'trascrizione manuale' : 'letta da Jarvis una volta';
      return { ...row, source: `file «${segment.filename}» riga ${Number(match[1]) - segment.start + 1} (${how})`, status: segment.method === 'jarvis_foto_lettura_singola' ? 'da_verificare' : row.status };
    });
    let extraction;
    // Aggiornamento di un menu già online: si parte dal file pubblicato su main, mai da zero.
    const liveUpdate = ['aggiornamento', 'prezzo'].includes(request.kind) && String(env?.GITHUB_PROVIDER || 'mock').trim() === 'live';
    if (liveUpdate) {
      const slug = slugify(desiredSlug);
      let live;
      try { live = await readCurrentMenu(env, slug, typeof (env?.GITHUB_FETCH || env?.fetch) === 'function' ? { fetch: env.GITHUB_FETCH || env.fetch } : {}); }
      catch (error) { assert(false, `Non riesco a leggere il menu online «${slug}» da GitHub (${String(error?.message || 'errore').slice(0, 120)}). Riprova tra poco.`, 503); }
      assert(live.exists, `Il menu «${slug}» non è online: controlla il Menu ID nella pratica o nella scheda cliente.`, 422);
      const update = prepareUpdate({ slug, current: live.menu, sha: live.sha, sourceText: combinedSource, subject: request.subject });
      assert(update.ok, update.reason, 422);
      extraction = update.extraction;
      if (extraction.added && (extraction.menu.lingue || []).includes('en') && autoTranslationReady(env)) {
        const translation = await translateMenu(env.AI, extraction.menu, { lang: 'en' });
        extraction.menu = translation.menu;
        extraction.provenance = [...extraction.provenance, ...translation.provenance];
        const note = translationSummary(translation);
        if (note) extraction.warnings.push(note);
      }
    } else {
      extraction = integrations(env).ai.extract(venue, combinedSource, desiredSlug);
      // Menu scritto a parole: lettura assistita, verificata riga per riga (nessun valore inventato).
      // Le righe dubbie delle foto non passano dal modello: le controlla Riccardo sulla foto.
      if (autoTranslationReady(env) && extraction.uncertain.some((row) => /\d/.test(row) && !row.startsWith('[da verificare]'))) {
        extraction = await assistExtraction(env.AI, venue, combinedSource, desiredSlug, extraction);
      }
    }
    if (segments.length) {
      extraction.provenance = relabel(extraction.provenance || []);
      extraction.warnings.push(`Usati ${segments.length} file (foto/PDF): ${segments.map((seg) => `«${seg.filename}»`).join(', ')}. Confronta i prezzi con gli originali in Materiali.`);
      const doubtful = extraction.uncertain.filter((row) => row.startsWith('[da verificare]')).length;
      if (doubtful) extraction.warnings.push(`${doubtful} voci delle foto lette in modo diverso dalle due letture: le trovi tra le righe da verificare, inseriscile tu dopo aver guardato la foto.`);
    }
    if (sourceVenue) extraction.warnings.push(`Nome del locale letto dalla riga “Locale:” dell’email (“${sourceVenue}”): confermalo in revisione e aggiorna la scheda cliente.`);
    assert(extraction.extracted.length > 0 && extraction.menu.id, 'Nessun piatto con prezzo leggibile: aggiungi il materiale o trascrivi la fonte.', 422);
    // Tutti i piani includono l'inglese: Jarvis lo prepara subito come bozza da verificare.
    if (PLAN_RULES[request.plan] && autoTranslationReady(env)) {
      const translation = await translateMenu(env.AI, extraction.menu, { lang: 'en' });
      extraction.menu = translation.menu;
      extraction.provenance = [...(extraction.provenance || []), ...translation.provenance];
      extraction.translation = { translated: translation.translated, total: translation.total, skipped: translation.skipped };
      const note = translationSummary(translation);
      if (note) extraction.warnings.push(note);
    }
    const id = uid(), timestamp = now(), menuJson = JSON.stringify(extraction.menu);
    await auditedBatch(db, [
      db.prepare('INSERT INTO drafts (id,request_id,slug,menu_json,status,checks_json,provenance_json,revision,created_at,updated_at) SELECT ?,id,?,?,?,?,?,?,?,? FROM requests WHERE id=? AND revision=?')
        .bind(id, extraction.menu.id, menuJson, 'bozza', JSON.stringify(checksDefault()), JSON.stringify(extraction.provenance || []), 1, timestamp, timestamp, requestId, request.revision),
      db.prepare('INSERT INTO draft_versions (id,draft_id,revision,menu_json,actor,created_at) VALUES (?,?,?,?,?,?)')
        .bind(uid(), id, 1, menuJson, extraction.mode === 'aggiornamento' || extraction.mode === 'sostituzione' ? `menu_online_${extraction.mode}` : 'estrazione_deterministica', timestamp),
      db.prepare("UPDATE requests SET status='in_revisione',plan=COALESCE(?,plan),revision=revision+1,updated_at=? WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM drafts WHERE id=?)")
        .bind(inheritedPlan, timestamp, requestId, request.revision, id)
    ], 'draft.generate', `Bozza da ${extraction.extracted.length} voci attestate; ${extraction.uncertain.length} righe da verificare.`, requestId,
      { sql: 'SELECT 1 FROM drafts WHERE id=?', args: [id] });
    result = { id, extraction };
  } else if (type === 'preparePreview') {
    const draftId = identifier(p.draftId), revision = Number(p.revision);
    const draft = await getOne(db, 'SELECT * FROM drafts WHERE id=?', draftId);
    assert(draft, 'Bozza non trovata.', 404);
    assert(revision === draft.revision, 'Bozza modificata da un’altra sessione. Ricarica.', 409);
    assert(['bozza', 'revisione', 'pronta_pr'].includes(draft.status), 'Bozza già chiusa: apri una nuova pratica.', 409);
    const checks = JSON.parse(draft.checks_json);
    assert(INTERNAL_CHECKS.every((key) => checks[key]), 'Prima completa e registra la revisione interna: prezzi, allergeni e lingue.', 422);
    const menu = JSON.parse(draft.menu_json);
    const validation = validateMenu(menu);
    assert(!validation.errors.length, `Correggi il menù: ${validation.errors[0]}`);
    const planOf = (await getOne(db, 'SELECT plan FROM requests WHERE id=?', draft.request_id))?.plan ?? null;
    const internal = internalIssues(menu, checks, planOf);
    assert(!internal.length, internal[0], 422);
    const request = await getOne(db, 'SELECT r.status,r.kind,c.email AS client_email FROM requests r JOIN clients c ON c.id=r.client_id WHERE r.id=?', draft.request_id);
    assert(!['completata', 'archiviata', 'chiusa'].includes(request.status), 'Pratica chiusa.', 409);
    // Anteprima per Riccardo su Telegram: solo se il locale non ha email (pratiche aperte da Riccardo).
    const ownerReview = p.ownerReview === true && !request.client_email;
    const recipient = ownerReview ? OWNER_REVIEW : String(p.recipient || request.client_email || '').trim().toLowerCase();
    assert(ownerReview || (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient) && recipient.length <= 254), 'Indica l’email del locale (scheda cliente o campo destinatario).', 422);
    assert(recipient !== OWNER_NOTIFICATION_RECIPIENT, 'Il destinatario non può essere la casella RenMenu: serve l’email del locale.', 422);
    const sha = await sha256Hex(draft.menu_json);
    const existing = await getOne(db, 'SELECT * FROM publication_approvals WHERE draft_id=?', draftId);
    assert(!(existing?.status === 'approvata_cliente' && existing.snapshot_sha === sha), 'Il cliente ha già approvato questa versione: non serve una nuova anteprima.', 409);
    const code = referenceCode(), url = previewUrl(menu, 'it'), email = previewEmail({ menu, code, url }), stamp = now();
    const write = existing
      ? db.prepare(`UPDATE publication_approvals SET reference_code=?,snapshot_sha=?,status='anteprima_pronta',recipient=?,preview_url=?,email_subject=?,email_body=?,prepared_at=?,
          sent_at=NULL,reply_message_id=NULL,reply_from=NULL,reply_text=NULL,reply_received_at=NULL,approved_at=NULL,approval_evidence=NULL,revision=revision+1,updated_at=? WHERE id=? AND revision=?`)
        .bind(code, sha, recipient, url, email.subject, email.body, stamp, stamp, existing.id, existing.revision)
      : db.prepare(`INSERT INTO publication_approvals (id,draft_id,request_id,reference_code,snapshot_sha,status,recipient,preview_url,email_subject,email_body,prepared_at,revision,created_at,updated_at)
          VALUES (?,?,?,?,?,'anteprima_pronta',?,?,?,?,?,1,?,?)`)
        .bind(uid(), draftId, draft.request_id, code, sha, recipient, url, email.subject, email.body, stamp, stamp, stamp);
    const saved = await auditedBatch(db, [write], 'approval.preview', `Anteprima per il cliente preparata (rif. ${code}); email da inviare da Gmail.`, draft.request_id,
      { sql: 'SELECT 1 FROM publication_approvals WHERE reference_code=?', args: [code] });
    assert(saved[0].meta.changes === 1, 'Approvazione modificata da un’altra sessione. Ricarica.', 409);
    result = { referenceCode: code, previewUrl: url, subject: email.subject, body: email.body, recipient };
  } else if (type === 'markPreviewSent') {
    const id = identifier(p.id), revision = Number(p.revision);
    const approval = await getOne(db, 'SELECT * FROM publication_approvals WHERE id=?', id);
    assert(approval && approval.revision === revision, 'Anteprima modificata. Ricarica.', 409);
    assert(approval.status === 'anteprima_pronta', 'Anteprima già segnata come inviata o superata.', 409);
    const draft = await getOne(db, 'SELECT menu_json FROM drafts WHERE id=?', approval.draft_id);
    assert(approval.snapshot_sha === await sha256Hex(draft.menu_json), 'La bozza è cambiata dopo l’anteprima: preparane una nuova prima di inviarla.', 409);
    const stamp = now();
    await auditedBatch(db, [db.prepare("UPDATE publication_approvals SET status='anteprima_inviata',sent_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='anteprima_pronta'").bind(stamp, stamp, id, revision)],
      'approval.sent', `Anteprima rif. ${approval.reference_code} inviata ${db.actor === 'jarvis' ? 'da Jarvis (Gmail renmenu1569)' : 'da Riccardo'}; in attesa della risposta del locale.`, approval.request_id,
      { sql: "SELECT 1 FROM publication_approvals WHERE id=? AND status='anteprima_inviata'", args: [id] });
    result = { id };
  } else if (type === 'decideClientReply') {
    const id = identifier(p.id), revision = Number(p.revision);
    assert(['approva', 'modifiche'].includes(p.decision), 'Decisione non valida.');
    const approval = await getOne(db, 'SELECT * FROM publication_approvals WHERE id=?', id);
    assert(approval && approval.revision === revision, 'Approvazione modificata. Ricarica.', 409);
    assert(approval.status === 'risposta_ricevuta', 'Nessuna risposta del cliente da valutare.', 409);
    const draft = await getOne(db, 'SELECT * FROM drafts WHERE id=?', approval.draft_id);
    const request = await getOne(db, 'SELECT revision,plan,kind FROM requests WHERE id=?', approval.request_id);
    const checks = JSON.parse(draft.checks_json), stamp = now();
    if (p.decision === 'approva') {
      assert(approval.snapshot_sha === await sha256Hex(draft.menu_json), 'La bozza è cambiata dopo l’anteprima: l’approvazione non vale per questa versione.', 409);
      const assessment = assessReply(approval.reply_text);
      assert(assessment.suggestion !== 'vuota', assessment.note, 422);
      if (assessment.suggestion !== 'approvazione')
        assert(p.confirmation === 'APPROVAZIONE CHIARA VERIFICATA', 'La risposta non sembra un’approvazione esplicita: rileggila; se lo è davvero, conferma con la frase richiesta.', 403);
      const evidence = approvalEvidence(approval);
      const nextChecks = { ...checks, clientApproval: true, clientApprovalEvidence: evidence };
      const ready = INTERNAL_CHECKS.every((key) => nextChecks[key]) && !reviewIssues(JSON.parse(draft.menu_json), nextChecks, request.plan).issues.length;
      const changed = await auditedBatch(db, [
        db.prepare("UPDATE publication_approvals SET status='approvata_cliente',approved_at=?,approval_evidence=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='risposta_ricevuta'").bind(stamp, evidence, stamp, id, revision),
        db.prepare('UPDATE drafts SET checks_json=?,status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').bind(JSON.stringify(nextChecks), ready ? 'pronta_pr' : draft.status === 'pronta_pr' ? 'pronta_pr' : 'revisione', stamp, draft.id, draft.revision),
        db.prepare('UPDATE requests SET status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').bind(ready ? 'approvata' : 'in_revisione', stamp, approval.request_id, request.revision)
      ], 'approval.client', `Approvazione del cliente registrata da Riccardo (rif. ${approval.reference_code}).`, approval.request_id,
        { sql: "SELECT 1 FROM publication_approvals WHERE id=? AND status='approvata_cliente'", args: [id] });
      assert(changed.every((entry) => entry.meta.changes === 1), 'Bozza o pratica modificata da un’altra sessione. Ricarica.', 409);
      result = { id, ready };
    } else {
      const nextChecks = { ...checks, clientApproval: false, clientApprovalEvidence: '' };
      const changed = await auditedBatch(db, [
        db.prepare("UPDATE publication_approvals SET status='modifiche_richieste',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='risposta_ricevuta'").bind(stamp, id, revision),
        db.prepare("UPDATE drafts SET checks_json=?,status=CASE WHEN status='pronta_pr' THEN 'revisione' ELSE status END,revision=revision+1,updated_at=? WHERE id=? AND revision=?").bind(JSON.stringify(nextChecks), stamp, draft.id, draft.revision),
        db.prepare("UPDATE requests SET status='in_revisione',revision=revision+1,updated_at=? WHERE id=? AND revision=?").bind(stamp, approval.request_id, request.revision)
      ], 'approval.changes', `Il cliente chiede modifiche (rif. ${approval.reference_code}): bozza riaperta in revisione.`, approval.request_id,
        { sql: "SELECT 1 FROM publication_approvals WHERE id=? AND status='modifiche_richieste'", args: [id] });
      assert(changed.every((entry) => entry.meta.changes === 1), 'Bozza o pratica modificata da un’altra sessione. Ricarica.', 409);
      result = { id, ready: false };
    }
  } else if (type === 'setActivation') {
    const id = identifier(p.id), revision = Number(p.revision);
    const approval = await getOne(db, 'SELECT * FROM publication_approvals WHERE id=?', id);
    assert(approval && approval.revision === revision, 'Approvazione modificata. Ricarica.', 409);
    const request = await getOne(db, 'SELECT plan FROM requests WHERE id=?', approval.request_id);
    const expected = { standard: 'prova_30_giorni', annuale: 'annuale_pagato', premium: 'premium_acconto' }[request.plan];
    assert(expected && p.activation === expected, `Attivazione non coerente con il piano della pratica (${request.plan}).`, 422);
    const date = String(p.date || '');
    assert(/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)), 'Data di attivazione non valida.', 422);
    const note = optional(p.note, 300, 'Nota attivazione') || null, stamp = now();
    await auditedBatch(db, [db.prepare('UPDATE publication_approvals SET activation=?,activation_date=?,activation_note=?,activation_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?')
      .bind(expected, date, note, stamp, stamp, id, revision)],
      'approval.activation', `Attivazione registrata da Riccardo: ${ACTIVATIONS[expected]} (${date}).`, approval.request_id,
      { sql: 'SELECT 1 FROM publication_approvals WHERE id=? AND activation=?', args: [id, expected] });
    result = { id };
  } else if (type === 'translateDraft') {
    // Completa le voci ancora senza inglese. Non tocca prezzi/allergeni né i testi EN già presenti;
    // la checklist si azzera perché i contenuti cambiano.
    const id = identifier(p.id), revision = Number(p.revision);
    const draft = await getOne(db, 'SELECT * FROM drafts WHERE id=?', id);
    assert(draft, 'Bozza non trovata.', 404);
    assert(Number.isInteger(revision) && revision === draft.revision, 'Bozza modificata da un’altra sessione. Ricarica.', 409);
    assert(['bozza', 'revisione', 'pronta_pr'].includes(draft.status), 'Bozza già chiusa: apri una nuova pratica.', 409);
    assert(autoTranslationReady(env), 'Traduzione automatica non disponibile in questo ambiente.', 503);
    const menu = JSON.parse(draft.menu_json);
    assert(translationEntries(menu, 'en').length, 'Tutti i testi hanno già l’inglese: niente da tradurre.', 422);
    const linkedRequest = await getOne(db, 'SELECT revision FROM requests WHERE id=?', draft.request_id);
    const translation = await translateMenu(env.AI, menu, { lang: 'en' });
    assert(!translation.unavailable, 'Servizio di traduzione non disponibile in questo momento: riprova tra poco.', 502);
    assert(translation.translated > 0, `Nessuna traduzione accettata: ${translationSummary(translation)}`, 422);
    const validation = validateMenu(translation.menu);
    assert(!validation.errors.length, `Menù non valido dopo la traduzione: ${validation.errors.slice(0, 3).join(' ')}`);
    const previous = parseList(draft.provenance_json).filter((entry) => !String(entry.path).endsWith('.en'));
    const provenance = [...previous, ...translation.provenance, ...parseList(draft.provenance_json).filter((entry) => String(entry.path).endsWith('.en'))];
    const menuJson = JSON.stringify(translation.menu), timestamp = now();
    const saved = await auditedBatch(db, [
      db.prepare("UPDATE drafts SET menu_json=?,checks_json=?,provenance_json=?,status='revisione',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM requests WHERE requests.id=? AND requests.revision=?)")
        .bind(menuJson, JSON.stringify(checksDefault()), JSON.stringify(provenance), timestamp, id, revision, draft.request_id, linkedRequest.revision),
      db.prepare('INSERT INTO draft_versions (id,draft_id,revision,menu_json,actor,created_at) SELECT ?,id,?,?,?,? FROM drafts WHERE id=? AND revision=?')
        .bind(uid(), revision + 1, menuJson, 'traduzione_jarvis', timestamp, id, revision + 1),
      db.prepare("UPDATE requests SET status='in_revisione',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM drafts WHERE drafts.id=? AND drafts.revision=? AND drafts.status='revisione')")
        .bind(timestamp, draft.request_id, linkedRequest.revision, id, revision + 1)
    ], 'draft.translate', translationSummary(translation), draft.request_id,
      { sql: 'SELECT 1 FROM draft_versions WHERE draft_id=? AND revision=?', args: [id, revision + 1] });
    assert(saved.every((entry) => entry.meta.changes === 1), 'Bozza o pratica modificata da un’altra sessione. Ricarica.', 409);
    result = { id, translation: { translated: translation.translated, total: translation.total, skipped: translation.skipped }, validation };
  } else if (type === 'entrustToJarvis') {
    result = await missions.entrust(db, env, p);
  } else if (type === 'jarvisTick') {
    result = { done: await missions.tick(db, env) };
  } else if (type === 'jarvisDecide') {
    result = await missions.decide(db, env, identifier(p.missionId), p.yes === true);
  } else if (type === 'cancelMission') {
    const mission = await getOne(db, 'SELECT * FROM jarvis_missions WHERE id=?', identifier(p.missionId));
    assert(mission, 'Missione non trovata.', 404);
    assert(!['completata', 'annullata'].includes(mission.status), 'Missione già chiusa.', 409);
    const stamp = now();
    await auditedBatch(db, [db.prepare("UPDATE jarvis_missions SET status='annullata',note='Ripresa in mano da Riccardo.',revision=revision+1,updated_at=? WHERE id=? AND revision=?").bind(stamp, mission.id, mission.revision),
      db.prepare("UPDATE jarvis_outbox SET status='annullata',updated_at=? WHERE mission_id=? AND status='in_coda'").bind(stamp, mission.id)],
    'jarvis.cancel', 'Riccardo ha ripreso in mano la pratica: Jarvis si ferma.', mission.request_id);
    result = { id: mission.id };
  } else if (type === 'telegramLink') {
    assert(telegramReady(env), 'Manca il segreto TELEGRAM_BOT_TOKEN nel progetto Cloudflare.', 503);
    const secret = randomToken(32), code = randomToken(16);
    const me = await getMe(env);
    assert(me?.ok && me.result?.username, 'Telegram non riconosce il token del bot: controlla TELEGRAM_BOT_TOKEN.', 502);
    await missions.putSetting(db, 'telegram_webhook_secret', secret);
    const hook = await setWebhook(env, secret);
    assert(hook?.ok, `Telegram ha rifiutato il collegamento (${String(hook?.description || 'errore').slice(0, 120)}).`, 502);
    await missions.putSetting(db, 'telegram_pair_code', code);
    await missions.putSetting(db, 'telegram_pair_until', new Date(Date.now() + 15 * 60_000).toISOString());
    await auditedBatch(db, [], 'jarvis.telegram_pairing', `Codice di collegamento Telegram generato per @${me.result.username} (valido 15 minuti).`, null);
    result = { username: me.result.username, link: `https://t.me/${me.result.username}?start=${code}` };
  } else if (type === 'jarvisBriefing') {
    result = { text: await missions.briefing(db, env, { force: true }) };
  } else if (type === 'setVoice') {
    // Voce di Jarvis: la chiave resta solo nel database privato e non torna mai all'interfaccia.
    const provider = String(p.provider || '');
    assert(['elevenlabs', 'openai', 'nessuna'].includes(provider), 'Servizio voce non valido.');
    const voiceId = String(p.voiceId || '').trim();
    assert(!voiceId || /^[A-Za-z0-9_-]{2,40}$/.test(voiceId), 'Voce non valida.');
    const apiKey = String(p.apiKey || '').trim();
    assert(!apiKey || /^[A-Za-z0-9_\-.]{20,200}$/.test(apiKey), 'Chiave non valida: incollala senza spazi.');
    if (provider === 'nessuna') { await missions.putSetting(db, 'voice_provider', ''); await missions.putSetting(db, 'voice_api_key', ''); }
    else {
      assert(apiKey || (await missions.setting(db, 'voice_api_key')), 'Incolla la chiave del servizio voce.');
      await missions.putSetting(db, 'voice_provider', provider);
      await missions.putSetting(db, 'voice_id', voiceId);
      if (apiKey) await missions.putSetting(db, 'voice_api_key', apiKey);
    }
    await auditedBatch(db, [], 'jarvis.voice_settings', `Voce di Jarvis: ${provider}${voiceId ? ` (${voiceId})` : ''}.`, null);
    result = { ok: true };
  } else if (type === 'testVoice') {
    const chat = await missions.setting(db, 'telegram_chat_id');
    assert(chat && telegramReady(env), 'Telegram non ancora collegato.', 409);
    const audio = await speak({ provider: await missions.setting(db, 'voice_provider'), apiKey: await missions.setting(db, 'voice_api_key'), voiceId: await missions.setting(db, 'voice_id') },
      'Buonasera Riccardo. Sono Jarvis. Da adesso puoi parlarmi con un vocale: ti ascolto, preparo il lavoro e aspetto sempre il tuo sì prima di pubblicare.');
    assert(audio, 'La voce non ha risposto: controlla servizio e chiave.', 502);
    const sent = await sendVoice(env, chat, audio, 'Prova voce di Jarvis.');
    assert(sent?.ok, 'Telegram non ha accettato il vocale.', 502);
    result = { ok: true };
  } else if (type === 'telegramTest') {
    const chat = await missions.setting(db, 'telegram_chat_id');
    assert(chat && telegramReady(env), 'Telegram non ancora collegato.', 409);
    const sent = await sendTelegram(env, chat, 'Prova dalla Control Room: Jarvis ti sente.');
    assert(sent?.ok, 'Telegram non ha consegnato il messaggio.', 502);
  } else if (type === 'runAutopilot') {
    result = { done: await runAutopilot(db, env) };
  } else if (type === 'applySourceExtras') {
    // Coperto e allergeni dichiarati nel testo della richiesta: ricalcolati sul server dal
    // testo salvato, applicati solo se scelti da Riccardo, con la riga come fonte.
    const id = identifier(p.draftId), revision = Number(p.revision);
    const draft = await getOne(db, 'SELECT * FROM drafts WHERE id=?', id);
    assert(draft, 'Bozza non trovata.', 404);
    assert(Number.isInteger(revision) && revision === draft.revision, 'Bozza modificata da un’altra sessione. Ricarica.', 409);
    assert(['bozza', 'revisione', 'pronta_pr'].includes(draft.status), 'Bozza già chiusa: apri una nuova pratica.', 409);
    const linkedRequest = await getOne(db, 'SELECT revision,source_text FROM requests WHERE id=?', draft.request_id);
    const menu = JSON.parse(draft.menu_json);
    const chosen = new Set(Array.isArray(p.accept) ? p.accept.map(String) : []);
    const selected = proposeSourceExtras(linkedRequest.source_text, menu).filter((entry) => entry.type !== 'manuale' && chosen.has(entry.id));
    assert(selected.length, 'Seleziona almeno un dato da inserire.', 422);
    const applied = applyExtras(menu, selected, (entry) => `riga ${entry.line}`);
    const validation = validateMenu(applied.menu);
    assert(!validation.errors.length, `Menù non valido: ${validation.errors.slice(0, 3).join(' ')}`);
    const paths = new Set(applied.provenance.map((row) => row.path));
    const provenance = [...parseList(draft.provenance_json).filter((row) => !paths.has(row.path)), ...applied.provenance];
    const menuJson = JSON.stringify(applied.menu), timestamp = now();
    const summaryText = selected.map((entry) => entry.type === 'coperto' ? `coperto ${entry.value} (riga ${entry.line})` : `${entry.name}: ${entry.label} (riga ${entry.line})`).join('; ');
    const saved = await auditedBatch(db, [
      db.prepare("UPDATE drafts SET menu_json=?,checks_json=?,provenance_json=?,status='revisione',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM requests WHERE requests.id=? AND requests.revision=?)")
        .bind(menuJson, JSON.stringify(checksDefault()), JSON.stringify(provenance), timestamp, id, revision, draft.request_id, linkedRequest.revision),
      db.prepare('INSERT INTO draft_versions (id,draft_id,revision,menu_json,actor,created_at) SELECT ?,id,?,?,?,? FROM drafts WHERE id=? AND revision=?')
        .bind(uid(), revision + 1, menuJson, 'dati_dal_locale', timestamp, id, revision + 1),
      db.prepare("UPDATE requests SET status='in_revisione',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM drafts WHERE drafts.id=? AND drafts.revision=? AND drafts.status='revisione')")
        .bind(timestamp, draft.request_id, linkedRequest.revision, id, revision + 1)
    ], 'draft.source_extras', `Dati del locale inseriti da Riccardo: ${summaryText}.`.slice(0, 900), draft.request_id,
      { sql: 'SELECT 1 FROM draft_versions WHERE draft_id=? AND revision=?', args: [id, revision + 1] });
    assert(saved.every((entry) => entry.meta.changes === 1), 'Bozza o pratica modificata da un’altra sessione. Ricarica.', 409);
    result = { id, applied: selected.length, validation };
  } else if (type === 'applyReplyChanges') {
    // Modifiche chieste dal locale: Jarvis le ricalcola dal testo salvato (mai dal browser)
    // e applica solo quelle scelte da Riccardo. Le fonti dei valori invariati restano.
    const id = identifier(p.draftId), revision = Number(p.revision);
    const draft = await getOne(db, 'SELECT * FROM drafts WHERE id=?', id);
    assert(draft, 'Bozza non trovata.', 404);
    assert(Number.isInteger(revision) && revision === draft.revision, 'Bozza modificata da un’altra sessione. Ricarica.', 409);
    assert(['bozza', 'revisione'].includes(draft.status), 'La bozza non è in revisione.', 409);
    const approval = await getOne(db, 'SELECT * FROM publication_approvals WHERE draft_id=?', id);
    assert(approval && approval.status === 'modifiche_richieste' && approval.reply_text, 'Nessuna richiesta di modifiche del locale da applicare.', 409);
    const menu = JSON.parse(draft.menu_json);
    const proposals = proposeReplyChanges(approval.reply_text, menu);
    const chosen = new Set(Array.isArray(p.accept) ? p.accept.map(String) : []);
    const selected = proposals.filter((entry) => entry.type !== 'manuale' && chosen.has(entry.id));
    assert(selected.length, 'Seleziona almeno una modifica da applicare.');
    const sectionsChoice = p.sections && typeof p.sections === 'object' ? p.sections : {};
    const source = `Risposta del locale (rif. ${approval.reference_code})`;
    const applied = applyMenuChanges(menu, parseList(draft.provenance_json), selected, { source, sections: sectionsChoice });
    const { next, added } = applied;
    let { provenance } = applied;
    let finalMenu = next, translationNote = '';
    const newProvenance = [...applied.newProvenance];
    if (added.length && (menu.lingue || []).includes('en') && autoTranslationReady(env)) {
      const translation = await translateMenu(env.AI, next, { lang: 'en' });
      if (translation.translated) { finalMenu = translation.menu; newProvenance.push(...translation.provenance); }
      if (translation.skipped?.length) translationNote = ` ${translation.skipped.length} nomi da tradurre a mano.`;
    }
    const validation = validateMenu(finalMenu);
    assert(!validation.errors.length, `Menù non valido: ${validation.errors.slice(0, 3).join(' ')}`);
    const changedPaths = new Set(newProvenance.map((row) => row.path));
    provenance = [...keepProvenance(provenance.filter((row) => !changedPaths.has(row.path)), finalMenu), ...newProvenance];
    const linkedRequest = await getOne(db, 'SELECT revision FROM requests WHERE id=?', draft.request_id);
    const menuJson = JSON.stringify(finalMenu), timestamp = now();
    const summaryText = selected.map((entry) => entry.type === 'prezzo' ? `${entry.name} ${entry.before} → ${entry.after}`
      : entry.type === 'aggiungi' ? `aggiunto ${entry.name} ${entry.price}` : entry.type === 'coperto' ? `coperto ${entry.value}`
      : entry.type === 'allergeni' ? `allergeni ${entry.name}: ${entry.label}` : `rimosso ${entry.name}`).join('; ');
    const saved = await auditedBatch(db, [
      db.prepare("UPDATE drafts SET menu_json=?,checks_json=?,provenance_json=?,status='revisione',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM requests WHERE requests.id=? AND requests.revision=?)")
        .bind(menuJson, JSON.stringify(checksDefault()), JSON.stringify(provenance), timestamp, id, revision, draft.request_id, linkedRequest.revision),
      db.prepare('INSERT INTO draft_versions (id,draft_id,revision,menu_json,actor,created_at) SELECT ?,id,?,?,?,? FROM drafts WHERE id=? AND revision=?')
        .bind(uid(), revision + 1, menuJson, 'risposta_locale', timestamp, id, revision + 1),
      db.prepare("UPDATE requests SET status='in_revisione',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM drafts WHERE drafts.id=? AND drafts.revision=? AND drafts.status='revisione')")
        .bind(timestamp, draft.request_id, linkedRequest.revision, id, revision + 1)
    ], 'draft.reply_changes', `Modifiche del locale applicate da Riccardo (rif. ${approval.reference_code}): ${summaryText}.${translationNote}`.slice(0, 900), draft.request_id,
      { sql: 'SELECT 1 FROM draft_versions WHERE draft_id=? AND revision=?', args: [id, revision + 1] });
    assert(saved.every((entry) => entry.meta.changes === 1), 'Bozza o pratica modificata da un’altra sessione. Ricarica.', 409);
    result = { id, applied: selected.length, validation };
  } else if (type === 'saveDraft') {
    const id = identifier(p.id), revision = Number(p.revision);
    const draft = await getOne(db, 'SELECT * FROM drafts WHERE id=?', id);
    assert(draft, 'Bozza non trovata.', 404);
    assert(Number.isInteger(revision) && revision === draft.revision, 'Bozza modificata da un’altra sessione. Ricarica.', 409);
    assert(['bozza', 'revisione', 'pronta_pr'].includes(draft.status), 'Bozza già chiusa: apri una nuova pratica.', 409);
    const linkedRequest = await getOne(db, 'SELECT kind,menu_id,revision FROM requests WHERE id=?', draft.request_id);
    const menu = p.menu, slug = clean(p.slug ?? menu?.id, 64, 'Slug');
    assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug), 'Slug non valido.');
    assert(menu && typeof menu === 'object' && !Array.isArray(menu) && menu.id === slug, 'ID JSON e slug non corrispondono.');
    if (linkedRequest.kind !== 'nuovo' || linkedRequest.menu_id) assert(slug === draft.slug, 'Aggiornamento: non cambiare il Menu ID di un QR già distribuito.', 422);
    if (slug !== draft.slug) await assertSlugFree(db, slug, draft.request_id, null);
    assert(JSON.stringify(menu).length <= 250_000, 'Menù troppo grande.');
    const validation = validateMenu(menu);
    assert(!validation.errors.length, `Menù non valido: ${validation.errors.slice(0, 3).join(' ')}`);
    const menuJson = JSON.stringify(menu), timestamp = now();
    // La provenienza resta solo per i valori identici a quelli attestati: un salvataggio
    // senza modifiche non cancella le fonti, un valore cambiato perde la sua.
    const keptProvenance = keepProvenance(parseList(draft.provenance_json), menu);
    const saved = await auditedBatch(db, [
      db.prepare("UPDATE drafts SET slug=?,menu_json=?,checks_json=?,provenance_json=?,status='revisione',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM requests WHERE requests.id=? AND requests.revision=?)")
        .bind(slug, menuJson, JSON.stringify(checksDefault()), JSON.stringify(keptProvenance), timestamp, id, revision, draft.request_id, linkedRequest.revision),
      db.prepare('INSERT INTO draft_versions (id,draft_id,revision,menu_json,actor,created_at) SELECT ?,id,?,? ,?,? FROM drafts WHERE id=? AND revision=?')
        .bind(uid(), revision + 1, menuJson, 'owner', timestamp, id, revision + 1),
      db.prepare("UPDATE requests SET status='in_revisione',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM drafts WHERE drafts.id=? AND drafts.revision=? AND drafts.status='revisione')")
        .bind(timestamp, draft.request_id, linkedRequest.revision, id, revision + 1)
    ], 'draft.save', `Versione ${revision + 1} salvata; ${validation.warnings.length} avvisi ancora da verificare.`, draft.request_id,
      { sql: 'SELECT 1 FROM draft_versions WHERE draft_id=? AND revision=?', args: [id, revision + 1] });
    assert(saved.every((entry) => entry.meta.changes === 1), 'Bozza o pratica modificata da un’altra sessione. Ricarica.', 409);
    result = { id, validation };
  } else if (type === 'reviewDraft') {
    const id = identifier(p.id), revision = Number(p.revision);
    const draft = await getOne(db, 'SELECT * FROM drafts WHERE id=?', id);
    assert(draft, 'Bozza non trovata.', 404);
    assert(revision === draft.revision, 'Revisione superata. Ricarica.', 409);
    assert(['bozza', 'revisione', 'pronta_pr'].includes(draft.status), 'Revisione chiusa.', 409);
    const owning = await getOne(db, 'SELECT status FROM requests WHERE id=?', draft.request_id);
    assert(!['completata', 'archiviata', 'chiusa'].includes(owning?.status), 'Pratica chiusa: menu già pubblicato.', 409);
    const selections = p.checks;
    assert(selections && typeof selections === 'object' && ['prices', 'allergens', 'languages', 'clientApproval'].every((key) => typeof selections[key] === 'boolean'), 'Conferme incomplete.');
    const checks = Object.fromEntries(['prices', 'allergens', 'languages', 'clientApproval'].map((key) => [key, selections[key]]));
    // Il consenso del cliente non si spunta a mano: arriva solo dalla sua risposta email
    // confermata da Riccardo (publication_approvals) e vale per il contenuto attuale.
    const linkedKind = (await getOne(db, 'SELECT kind FROM requests WHERE id=?', draft.request_id))?.kind;
    const clientGate = await approvalFor(db, draft, linkedKind);
    checks.clientApproval = clientGate.valid;
    checks.clientApprovalEvidence = clientGate.valid ? clientGate.approval.approval_evidence : '';
    checks.fieldEvidence = Object.fromEntries(['prices', 'allergens', 'languages'].map((key) => [key,
      checks[key] ? clean(p.fieldEvidence?.[key], 500, EVIDENCE_LABELS[key]) : '']));
    checks.allergenOmissionConfirmed = checks.allergens && p.allergenOmissionConfirmed === true;
    // Approvazione creativa (obbligatoria solo per Premium): conferma di Riccardo, non del locale.
    checks.creativeApproval = p.creativeApproval === true;
    checks.creativeApprovalEvidence = checks.creativeApproval ? clean(p.creativeApprovalEvidence, 500, 'Riferimento approvazione creativa') : '';
    const request = await getOne(db, 'SELECT revision,plan FROM requests WHERE id=?', draft.request_id);
    const validation = validateMenu(JSON.parse(draft.menu_json));
    assert(!validation.errors.length, `Correggi il menù: ${validation.errors[0]}`);
    if (INTERNAL_CHECKS.every((key) => checks[key])) {
      const internal = internalIssues(JSON.parse(draft.menu_json), checks, request.plan);
      assert(!internal.length, internal[0], 422);
    }
    const ready = ['prices', 'allergens', 'languages', 'clientApproval'].every((key) => checks[key]);
    if (ready) {
      const review = reviewIssues(JSON.parse(draft.menu_json), checks, request.plan);
      assert(!review.issues.length, review.issues[0], 422);
    }
    const stamp = now();
    const changed = await auditedBatch(db, [
      db.prepare('UPDATE drafts SET checks_json=?,status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM requests WHERE requests.id=? AND requests.revision=?)')
        .bind(JSON.stringify(checks), ready ? 'pronta_pr' : 'revisione', stamp, id, revision, draft.request_id, request.revision),
      db.prepare('UPDATE requests SET status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM drafts WHERE drafts.id=? AND drafts.revision=? AND drafts.status=?)')
        .bind(ready ? 'approvata' : 'in_revisione', stamp, draft.request_id, request.revision, id, revision + 1, ready ? 'pronta_pr' : 'revisione')
    ], 'draft.review', ready ? 'Conferme editoriali registrate; PR solo simulata.' : 'Checklist editoriale aggiornata.', draft.request_id,
      { sql: 'SELECT 1 FROM drafts WHERE id=? AND revision=? AND updated_at=?', args: [id, revision + 1, stamp] });
    assert(changed[0].meta.changes === 1 && changed[1].meta.changes === 1, 'Revisione superata. Ricarica.', 409);
    result = { id, ready, validation };
  } else if (type === 'preparePr') {
    assert(String(env?.GITHUB_PROVIDER || 'mock').trim() !== 'live', 'GitHub reale attivo: usa Apri PR su GitHub e Pubblica.', 409);
    const id = identifier(p.id), revision = Number(p.revision);
    assert(p.confirmation === 'CONFERMO PR DI PROVA', 'Conferma esplicita mancante.', 403);
    const draft = await getOne(db, 'SELECT * FROM drafts WHERE id=?', id);
    assert(draft, 'Bozza non trovata.', 404);
    assert(draft.revision === revision && draft.status === 'pronta_pr', 'Bozza o revisione non pronta. Ricarica.', 409);
    const checks = JSON.parse(draft.checks_json);
    const validation = validateMenu(JSON.parse(draft.menu_json));
    assert(!validation.errors.length, 'Validazione menù fallita.');
    const planRow = await getOne(db, 'SELECT plan FROM requests WHERE id=?', draft.request_id);
    assert(!reviewIssues(JSON.parse(draft.menu_json), checks, planRow?.plan ?? null).issues.length,
      'Conferme o fonti editoriali mancanti: torna alla checklist.', 403);
    const prKind = (await getOne(db, 'SELECT kind FROM requests WHERE id=?', draft.request_id))?.kind;
    const prGate = await approvalFor(db, draft, prKind);
    assert(prGate.valid, prGate.stale ? 'La bozza è cambiata dopo l’approvazione del cliente: prepara e invia una nuova anteprima.' : 'Manca l’approvazione del cliente: invia l’anteprima e registra la sua risposta.', 403);
    assert(!prGate.activationMissing, 'Menu nuovo: registra prima l’attivazione del servizio (prova, annuale o acconto Premium).', 403);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(draft.menu_json));
    const snapshotSha = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const proposalId = uid();
    const request = await getOne(db, 'SELECT r.*,c.name AS client_name FROM requests r JOIN clients c ON c.id=r.client_id WHERE r.id=?', draft.request_id);
    const sourceFiles = (await rows(db, 'SELECT filename FROM materials WHERE request_id=? AND archived_at IS NULL', draft.request_id)).map((file) => file.filename);
    const proposal = integrations(env).github.prepare({ clientName: request.client_name, requestKind: request.kind,
      requestId: draft.request_id, slug: draft.slug, menu: JSON.parse(draft.menu_json), sourceFiles });
    const prepared = await auditedBatch(db, [
      db.prepare("UPDATE drafts SET status='pr_simulata',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='pronta_pr' AND EXISTS (SELECT 1 FROM requests WHERE requests.id=? AND requests.revision=?)")
        .bind(now(), id, revision, draft.request_id, request.revision),
      db.prepare("INSERT INTO pr_proposals (id,draft_id,revision,snapshot_sha,diff_json,branch_name,file_path,commit_message,pr_body,status,created_at) SELECT ?,id,?,?,?,?,?,?,?,?,? FROM drafts WHERE id=? AND revision=? AND status='pr_simulata'")
        .bind(proposalId, revision, snapshotSha, JSON.stringify(proposal.changes), proposal.branchName,
          proposal.filePath, proposal.commitMessage, proposal.prBody, 'mock', now(), id, revision + 1),
      db.prepare("UPDATE requests SET status='pronta_pubblicazione',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM drafts WHERE drafts.id=? AND drafts.revision=? AND drafts.status='pr_simulata')")
        .bind(now(), draft.request_id, request.revision, id, revision + 1)
    ], 'pr.mock', `PR simulata; SHA bozza ${snapshotSha.slice(0, 12)}. Nessuna scrittura su GitHub.`, draft.request_id,
      { sql: 'SELECT 1 FROM pr_proposals WHERE id=?', args: [proposalId] });
    assert(prepared.every((entry) => entry.meta.changes === 1), 'Bozza o pratica modificata da un’altra sessione. Ricarica.', 409);
    result = { id: proposalId, simulated: true, snapshotSha };
  } else if (type === 'simulatePublish') {
    assert(String(env?.GITHUB_PROVIDER || 'mock').trim() !== 'live', 'GitHub reale attivo: usa Apri PR su GitHub e Pubblica.', 409);
    const id = identifier(p.id), revision = Number(p.revision);
    assert(p.confirmation === 'CONFERMO PUBBLICAZIONE SIMULATA', 'Seconda conferma esplicita mancante.', 403);
    const draft = await getOne(db, 'SELECT * FROM drafts WHERE id=?', id);
    assert(draft && draft.status === 'pr_simulata' && draft.revision === revision, 'PR simulata o revisione non disponibile.', 409);
    assert(await getOne(db, 'SELECT id FROM pr_proposals WHERE draft_id=? AND status=?', id, 'mock'), 'Nessuna proposta simulata.', 409);
    const stamp = now();
    const completed = await auditedBatch(db, [
      db.prepare("UPDATE drafts SET status='pubblicazione_simulata',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='pr_simulata'").bind(stamp, id, revision),
      db.prepare("UPDATE requests SET status='completata',revision=revision+1,updated_at=? WHERE id=? AND EXISTS (SELECT 1 FROM drafts WHERE drafts.id=? AND drafts.revision=? AND drafts.status='pubblicazione_simulata')")
        .bind(stamp, draft.request_id, id, revision + 1)
    ], 'publish.mock', 'Pubblicazione simulata: nessun deploy, QR reale o merge.', draft.request_id,
      { sql: 'SELECT 1 FROM drafts WHERE id=? AND revision=? AND updated_at=?', args: [id, revision + 1, stamp] });
    assert(completed[0].meta.changes === 1 && completed[1].meta.changes === 1, 'Revisione modificata da un’altra sessione. Ricarica.', 409);
    result = { id, simulated: true };
  } else if (type === 'mockIncomingWhatsapp') {
    const from = clean(p.from, 40, 'Numero WhatsApp');
    assert(/^\+?[0-9\s()-]{7,40}$/.test(from), 'Numero di prova non valido.');
    const body = clean(p.body, 5_000, 'Messaggio in entrata');
    const normalized = from.replace(/\D/g, '');
    const candidates = await rows(db, 'SELECT id,name,phone FROM clients WHERE phone IS NOT NULL');
    const client = candidates.find((item) => item.phone.replace(/\D/g, '') === normalized);
    assert(client, 'Numero non associato a una scheda cliente: collegalo prima della simulazione.', 422);
    const classified = integrations(env).whatsapp.classify(body);
    const requestId = uid(), messageId = uid(), stamp = now();
    await auditedBatch(db, [
      db.prepare('INSERT INTO requests (id,client_id,subject,source_channel,source_text,kind,status,plan,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .bind(requestId, client.id, `WhatsApp demo · ${client.name}`, 'whatsapp', body, classified.request_type, 'nuova', 'da_definire', 1, stamp, stamp),
      db.prepare('INSERT INTO messages (id,request_id,channel,body,status,created_at) VALUES (?,?,?,?,?,?)')
        .bind(messageId, requestId, 'whatsapp', body, 'bozza_mock', stamp)
    ], 'whatsapp.incoming.mock', `Messaggio in ingresso simulato; classificazione ${classified.request_type}.`, requestId,
      { sql: 'SELECT 1 FROM messages WHERE id=? AND request_id=?', args: [messageId, requestId] });
    return { state: await state(db, env), result: { id: requestId, classification: classified, simulated: true } };
  } else if (type === 'mockCall') {
    const requestId = identifier(p.requestId);
    assert(await getOne(db, 'SELECT id FROM requests WHERE id=?', requestId), 'Pratica non trovata.', 404);
    const message = clean(p.message, 1000, 'Avviso telefonico');
    const id = uid();
    await auditedBatch(db, [db.prepare('INSERT INTO notifications (id,request_id,channel,subject,body,priority,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(id, requestId, 'telefono', 'Chiamata di prova · non avviata', message, 'urgente', 'mock', now())],
      'call.mock', 'Chiamata simulata verso il proprietario: non è stato composto alcun numero.', requestId,
      { sql: 'SELECT 1 FROM notifications WHERE id=?', args: [id] });
    result = { id, simulated: true };
  } else if (type === 'setMaterialTranscript') {
    const materialId = identifier(p.materialId), revision = Number(p.requestRevision);
    const sourceText = clean(p.text, 50_000, 'Trascrizione manuale');
    assert(sourceText.length >= 5, 'Trascrizione troppo breve.');
    const material = await getOne(db, 'SELECT * FROM materials WHERE id=? AND archived_at IS NULL', materialId);
    assert(material, 'Materiale non trovato o archiviato.', 404);
    const request = await getOne(db, 'SELECT id,revision,status FROM requests WHERE id=?', material.request_id);
    assert(Number.isInteger(revision) && request?.revision === revision, 'Pratica modificata nel frattempo. Ricarica.', 409);
    assert(!['completata', 'archiviata', 'chiusa'].includes(request.status), 'Pratica non modificabile.', 409);
    const linkedDraft = await getOne(db, 'SELECT status FROM drafts WHERE request_id=?', request.id);
    assert(!linkedDraft || !['pr_simulata', 'pubblicazione_simulata'].includes(linkedDraft.status), 'Fonte bloccata dopo la proposta.', 409);
    assert(env.BUCKET?.get, 'Archivio privato non configurato.', 503);
    const object = await env.BUCKET.get(material.r2_key);
    assert(object?.arrayBuffer, 'File originale privato non disponibile.', 404);
    const digest = await crypto.subtle.digest('SHA-256', await object.arrayBuffer());
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const stamp = now(), id = uid();
    const writes = [
      db.prepare(`INSERT INTO material_analyses (id,material_id,request_id,source_sha256,source_text,provenance_json,warnings_json,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(material_id) DO UPDATE SET id=excluded.id, source_sha256=excluded.source_sha256,
        source_text=excluded.source_text, provenance_json=excluded.provenance_json, warnings_json=excluded.warnings_json,
        status=excluded.status, created_at=excluded.created_at`)
        .bind(id, materialId, request.id, hash, sourceText,
          JSON.stringify([{ materialId, method: 'manual', reviewed: false }]),
          JSON.stringify(['Trascrizione manuale: confrontare con il file originale; nessun OCR automatico.']), 'needs_review', stamp),
      db.prepare("UPDATE requests SET status='in_revisione',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM material_analyses WHERE material_id=? AND id=?)")
        .bind(stamp, request.id, revision, materialId, id),
      db.prepare("UPDATE drafts SET checks_json=?,status='revisione',revision=revision+1,updated_at=? WHERE request_id=? AND status IN ('bozza','revisione','pronta_pr') AND EXISTS (SELECT 1 FROM material_analyses WHERE material_id=? AND id=?)")
        .bind(JSON.stringify(checksDefault()), stamp, request.id, materialId, id)
    ];
    const changed = await auditedBatch(db, writes, 'material.transcription.manual',
      'Trascrizione manuale salvata; conferme editoriali invalidate.', request.id,
      { sql: 'SELECT 1 FROM requests WHERE id=? AND revision=? AND updated_at=?', args: [request.id, revision + 1, stamp] });
    assert(changed[1].meta.changes === 1, 'Pratica modificata nel frattempo. Ricarica.', 409);
    result = { id, materialId, sourceSha256: hash, status: 'needs_review' };
  } else if (type === 'readMaterial') {
    // Jarvis legge una foto (due modelli, solo voci concordi) o un PDF (testo incorporato).
    // Il risultato è una FONTE da verificare, non il menu: entra nella bozza alla generazione.
    const materialId = identifier(p.materialId);
    const material = await getOne(db, 'SELECT * FROM materials WHERE id=? AND archived_at IS NULL', materialId);
    assert(material, 'Materiale non trovato o archiviato.', 404);
    assert(material.mime === 'application/pdf' || PHOTO_TYPES.has(material.mime), 'Jarvis legge solo foto (JPG, PNG, WebP) e PDF.', 422);
    const request = await getOne(db, 'SELECT id,status FROM requests WHERE id=?', material.request_id);
    assert(!['completata', 'archiviata', 'chiusa'].includes(request?.status), 'Pratica chiusa.', 409);
    assert(env.BUCKET?.get, 'Archivio privato non configurato.', 503);
    const object = await env.BUCKET.get(material.r2_key);
    assert(object?.arrayBuffer, 'File originale privato non disponibile.', 404);
    const bytes = new Uint8Array(await object.arrayBuffer());
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const read = material.mime === 'application/pdf' ? await readMenuPdf(env.AI, bytes, material.filename) : await readMenuPhoto(env.AI, bytes, material.mime);
    const stamp = now();
    if (!read.ok) {
      await auditedBatch(db, [db.prepare("UPDATE materials SET processing_status='non_leggibile' WHERE id=?").bind(materialId)],
        'material.read.failed', `Jarvis non è riuscito a leggere «${material.filename}»: ${read.reason}.`.slice(0, 600), request.id);
      assert(db.actor === 'jarvis', `Non riesco a leggere il file: ${read.reason}.`, 422);
      result = { ok: false, reason: read.reason };
    } else {
      const analysisId = uid();
      await auditedBatch(db, [
        db.prepare(`INSERT INTO material_analyses (id,material_id,request_id,source_sha256,source_text,provenance_json,warnings_json,status,created_at)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(material_id) DO UPDATE SET id=excluded.id, source_sha256=excluded.source_sha256,
          source_text=excluded.source_text, provenance_json=excluded.provenance_json, warnings_json=excluded.warnings_json,
          status=excluded.status, created_at=excluded.created_at`)
          .bind(analysisId, materialId, request.id, hash, read.text.slice(0, 50_000), JSON.stringify([{ materialId, method: read.method, reviewed: false }]), JSON.stringify(read.warnings), 'needs_review', stamp),
        db.prepare("UPDATE materials SET processing_status='letto_da_jarvis',text_preview=? WHERE id=?").bind(read.text.slice(0, 2500), materialId)
      ], 'material.read.jarvis', `Jarvis ha letto «${material.filename}»: ${read.warnings[0]}`.slice(0, 600), request.id);
      result = { ok: true, agreed: read.agreed ?? null, doubts: read.doubts ?? 0, method: read.method, warnings: read.warnings };
    }
  } else if (type === 'archiveMaterial') {
    const id = identifier(p.id);
    assert(p.confirmation === 'ARCHIVIA MATERIALE', 'Conferma archiviazione mancante.', 403);
    const material = await getOne(db, 'SELECT request_id,archived_at FROM materials WHERE id=?', id);
    assert(material, 'Materiale non trovato.', 404);
    assert(!material.archived_at, 'Materiale già archiviato.', 409);
    const request = await getOne(db, 'SELECT revision,status FROM requests WHERE id=?', material.request_id);
    const linkedDraft = await getOne(db, 'SELECT status FROM drafts WHERE request_id=?', material.request_id);
    assert(!['completata', 'archiviata', 'chiusa'].includes(request.status) &&
      (!linkedDraft || !['pr_simulata', 'pubblicazione_simulata'].includes(linkedDraft.status)), 'Fonte bloccata dopo la proposta: apri una nuova pratica.', 409);
    const stamp = now();
    const archived = await auditedBatch(db, [
      db.prepare('UPDATE materials SET archived_at=? WHERE id=? AND archived_at IS NULL AND EXISTS (SELECT 1 FROM requests WHERE requests.id=? AND requests.revision=?)')
        .bind(stamp, id, material.request_id, request.revision),
      db.prepare("UPDATE requests SET status='in_revisione',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM materials WHERE id=? AND archived_at=?)")
        .bind(stamp, material.request_id, request.revision, id, stamp),
      db.prepare("UPDATE drafts SET checks_json=?,status='revisione',revision=revision+1,updated_at=? WHERE request_id=? AND status IN ('bozza','revisione','pronta_pr') AND EXISTS (SELECT 1 FROM materials WHERE id=? AND archived_at=?)")
        .bind(JSON.stringify(checksDefault()), stamp, material.request_id, id, stamp)
    ], 'material.archive', 'Materiale archiviato: file privato conservato, non cancellato.', material.request_id,
      { sql: 'SELECT 1 FROM materials WHERE id=? AND archived_at=?', args: [id, stamp] });
    assert(archived[0].meta.changes === 1 && archived[1].meta.changes === 1, 'Archiviazione concorrente. Ricarica.', 409);
    result = { id, archived: true };
  } else if (type === 'purgePublishedEmail') {
    result = await purgePublishedEmail({ db, input: p,
      fetch: typeof env.PUBLIC_MENU_FETCH === 'function' ? env.PUBLIC_MENU_FETCH : globalThis.fetch,
      now, uid });
  } else if (type === 'markNotificationRead') {
    const id = identifier(p.id);
    assert(typeof p.read === 'boolean', 'Stato letto non valido.');
    const notice = await getOne(db, 'SELECT id,request_id FROM notifications WHERE id=?', id);
    assert(notice, 'Notifica non trovata.', 404);
    await auditedBatch(db, [db.prepare('UPDATE notifications SET read_at=? WHERE id=?').bind(p.read ? now() : null, id)],
      'notification.read', p.read ? 'Notifica letta.' : 'Notifica da leggere.', notice.request_id,
      { sql: 'SELECT 1 FROM notifications WHERE id=?', args: [id] });
    result = { id };
  } else if (type === 'sendOwnerEmail') {
    assert(p.confirmation === 'CONFERMO EMAIL AL PROPRIETARIO', 'Conferma esplicita per l’email al proprietario mancante.', 403);
    const requestId = identifier(p.requestId);
    const request = await getOne(db, 'SELECT id FROM requests WHERE id=?', requestId);
    assert(request, 'Pratica non trovata.', 404);
    const subject = clean(p.subject, 180, 'Oggetto avviso');
    const text = clean(p.text, 4_000, 'Testo avviso');
    assert(['normale', 'importante', 'urgente'].includes(p.priority || 'normale'), 'Priorità non valida.');
    const sent = await sendOwnerNotification({ db, env, requestId, subject, text,
      priority: p.priority || 'normale', fetchImpl: typeof env.RESEND_FETCH === 'function' ? env.RESEND_FETCH : globalThis.fetch });
    result = { ...sent, recipient: OWNER_NOTIFICATION_RECIPIENT };
  } else if (type === 'addNotification' || type === 'sendMessage') {
    const requestId = p.requestId ? identifier(p.requestId) : null;
    if (type === 'sendMessage') assert(requestId, 'Pratica obbligatoria per i messaggi.');
    if (requestId) assert(await getOne(db, 'SELECT id FROM requests WHERE id=?', requestId), 'Pratica non trovata.', 404);
    const channel = clean(p.channel, 30, 'Canale');
    assert(['in_app', 'email', 'whatsapp', 'telefono'].includes(channel), 'Canale non supportato.');
    const body = clean(p.body, 5_000, 'Messaggio');
    const id = uid(), timestamp = now();
    let entry;
    if (type === 'addNotification') {
      const subject = clean(p.subject, 160, 'Oggetto');
      const priority = p.priority || 'normale';
      assert(['normale', 'importante', 'urgente'].includes(priority), 'Priorità non valida.');
      entry = db.prepare('INSERT INTO notifications (id,request_id,channel,subject,body,priority,due_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(id, requestId, channel, subject, body, priority, optionalDate(p.dueAt), 'mock', timestamp);
    } else entry = db.prepare('INSERT INTO messages (id,request_id,channel,body,status,created_at) VALUES (?,?,?,?,?,?)')
      .bind(id, requestId, channel, body, 'bozza_mock', timestamp);
    await auditedBatch(db, [entry], type === 'addNotification' ? 'notification.mock' : 'message.mock',
      `${channel}: ${type === 'addNotification' ? 'notifica simulata' : 'bozza messaggio non inviata'}.`, requestId,
      { sql: `SELECT 1 FROM ${type === 'addNotification' ? 'notifications' : 'messages'} WHERE id=?`, args: [id] });
    result = { id, simulated: true };
  } else if (type === 'logVoice') {
    const requestId = p.requestId ? identifier(p.requestId) : null;
    if (requestId) assert(await getOne(db, 'SELECT id FROM requests WHERE id=?', requestId), 'Pratica non trovata.', 404);
    const transcript = clean(p.transcript, 2_000, 'Trascrizione');
    const messageId = uid();
    const writes = requestId ? [db.prepare('INSERT INTO messages (id,request_id,channel,body,status,created_at) VALUES (?,?,?,?,?,?)')
      .bind(messageId, requestId, 'voce', transcript, 'bozza_mock', now())] : [];
    await auditedBatch(db, writes, 'voice.mock', 'Trascrizione registrata come bozza: nessuna azione privilegiata.', requestId,
      requestId ? { sql: 'SELECT 1 FROM messages WHERE id=?', args: [messageId] } : null);
    result = { simulated: true };
  } else {
    throw Object.assign(new Error('Operazione non supportata: nessuna azione esterna disponibile.'), { status: 404 });
  }
  return { state: await state(db, env), result };
}

const allowedTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain', 'audio/mpeg', 'audio/mp4', 'audio/webm']);
function validSignature(bytes, mime) {
  const head = bytes.subarray(0, 16);
  const starts = (...values) => values.every((value, i) => head[i] === value);
  if (mime === 'application/pdf') return starts(37, 80, 68, 70, 45);
  if (mime === 'image/jpeg') return starts(255, 216, 255);
  if (mime === 'image/png') return starts(137, 80, 78, 71, 13, 10, 26, 10);
  if (mime === 'image/webp') return new TextDecoder().decode(head.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(head.subarray(8, 12)) === 'WEBP';
  if (mime === 'audio/webm') return starts(26, 69, 223, 163);
  if (mime === 'audio/mpeg') return new TextDecoder().decode(head.subarray(0, 3)) === 'ID3' || (head[0] === 255 && (head[1] & 0xe0) === 0xe0);
  if (mime === 'audio/mp4') return new TextDecoder().decode(head.subarray(4, 8)) === 'ftyp';
  if (mime === 'text/plain') {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return !bytes.includes(0); } catch { return false; }
  }
  return false;
}

async function uploadMaterial(context) {
  assert(context.env.BUCKET?.put, 'Archivio privato non configurato.', 503);
  const request = context.request;
  assert(Number(request.headers.get('content-length') || 0) <= 12_000_000, 'File troppo grande.');
  const form = await request.formData();
  const requestId = identifier(form.get('requestId'));
  const linkedRequest = await getOne(context.env.DB, 'SELECT id,status,revision FROM requests WHERE id=?', requestId);
  assert(linkedRequest, 'Pratica non trovata.', 404);
  assert(!['completata', 'archiviata', 'chiusa'].includes(linkedRequest.status), 'Pratica chiusa: non aggiungere fonti.', 409);
  const linkedDraft = await getOne(context.env.DB, 'SELECT status FROM drafts WHERE request_id=?', requestId);
  assert(!linkedDraft || !['pr_simulata', 'pubblicazione_simulata'].includes(linkedDraft.status), 'PR già preparata: apri una nuova pratica.', 409);
  const count = await getOne(context.env.DB, 'SELECT COUNT(*) AS n FROM materials WHERE request_id=?', requestId);
  assert(count.n < 12, 'Massimo 12 materiali per pratica.');
  const file = form.get('file');
  assert(file instanceof File && file.size > 0 && file.size <= 10_000_000 && allowedTypes.has(file.type), 'Formato o dimensione del file non supportati.');
  const name = clean(file.name, 180, 'Nome file');
  const bytes = new Uint8Array(await file.arrayBuffer());
  assert(validSignature(bytes, file.type), 'La firma del file non corrisponde al formato dichiarato.');
  const id = uid(), key = `private/requests/${requestId}/${id}`;
  await context.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: file.type } });
  try {
    const stamp = now();
    const saved = await auditedBatch(context.env.DB, [
      context.env.DB.prepare("INSERT INTO materials (id,request_id,r2_key,filename,mime,size,source,processing_status,text_preview,created_at) SELECT ?,id,?,?,?,?,?,?,?,? FROM requests WHERE id=? AND revision=? AND status NOT IN ('completata','archiviata','chiusa')")
        .bind(id, key, name, file.type, file.size, 'caricamento_manuale',
          file.type === 'text/plain' ? 'testo_disponibile' : 'da_trascrivere',
          file.type === 'text/plain' ? new TextDecoder().decode(bytes.subarray(0, 2500)) : null, stamp, requestId, linkedRequest.revision),
      context.env.DB.prepare("UPDATE requests SET status='materiale_ricevuto',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM materials WHERE id=?)")
        .bind(stamp, requestId, linkedRequest.revision, id),
      context.env.DB.prepare("UPDATE drafts SET checks_json=?,status='revisione',revision=revision+1,updated_at=? WHERE request_id=? AND status IN ('bozza','revisione','pronta_pr') AND EXISTS (SELECT 1 FROM materials WHERE id=?)")
        .bind(JSON.stringify(checksDefault()), stamp, requestId, id)
    ], 'material.add', `Materiale privato acquisito: ${file.type}, ${file.size} byte.`, requestId,
      { sql: 'SELECT 1 FROM materials WHERE id=?', args: [id] });
    assert(saved[0].meta.changes === 1 && saved[1].meta.changes === 1, 'Pratica modificata mentre caricavi: riprova.', 409);
  } catch (error) { await context.env.BUCKET.delete(key); throw error; }
  return answer({ state: await state(context.env.DB, context.env), result: { id } });
}

async function downloadMaterial(context, id) {
  assert(context.env.BUCKET?.get, 'Archivio privato non configurato.', 503);
  const material = await getOne(context.env.DB, 'SELECT * FROM materials WHERE id=? AND archived_at IS NULL', identifier(id));
  assert(material, 'Materiale non trovato.', 404);
  const item = await context.env.BUCKET.get(material.r2_key);
  assert(item, 'Materiale non disponibile.', 404);
  return new Response(item.body, { headers: {
    'Content-Type': material.mime, 'Content-Disposition': `attachment; filename="materiale"; filename*=UTF-8''${encodeURIComponent(material.filename)}`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'
  } });
}

export async function onRequest(context) {
  try {
    if (!await verifyOwner(context.request, context.env)) return failure(403, 'Area riservata. Accesso negato.');
    assert(context.env.DB?.prepare, 'Database privato non configurato.', 503);
    const request = context.request, method = request.method;
    const route = context.params.route;
    const segments = Array.isArray(route) ? route : typeof route === 'string' ? route.split('/') : [];
    if (method === 'GET' && segments.join('/') === 'state') return answer(await state(context.env.DB, context.env));
    if (method === 'GET' && segments[0] === 'material' && segments.length === 2) return await downloadMaterial(context, segments[1]);
    if (method === 'POST') {
      assert(isSameOriginWrite(request), 'Origine non autorizzata.', 403);
      if (segments.join('/') === 'material') return uploadMaterial(context);
      if (segments.join('/') === 'actions') {
        assert(request.headers.get('content-type')?.startsWith('application/json'), 'Serve application/json.', 415);
        assert(Number(request.headers.get('content-length') || 0) <= 300_000, 'Payload troppo grande.');
        const { type, payload } = await request.json();
        assert(typeof type === 'string', 'Tipo operazione obbligatorio.');
        return answer(await action(context.env.DB, type, payload, context.env));
      }
    }
    return failure(404, 'Risorsa privata non trovata.');
  } catch (error) {
    if (error instanceof SyntaxError) return failure(400, 'JSON non valido.');
    if (error?.status) return failure(error.status, error.message);
    // Internal details and data are deliberately not returned to clients or console logs.
    return failure(500, 'Errore interno. Nessuna azione esterna è stata eseguita.');
  }
}

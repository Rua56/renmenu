import { createAiLiveAdapter } from './ai-live.js';
import { GitHubLiveError, getPrStatus, openApprovedMenuPr, readCurrentMenu } from './github-live.js';
import { reviewIssues } from './editorial.js';
import { slugify, validateMenu } from './menu.js';

/**
 * Private Control Room operations for the separately configured AI and GitHub
 * adapters. This module never sends messages, processes payments, merges a PR,
 * or publishes/deploys a menu. All D1 mutations are delegated through the
 * route's transactional audit helper.
 */
export const PRIVATE_INTEGRATION_ACTIONS = new Set([
  'aiClassifyRequest',
  'aiExtractMenu',
  'saveAiReviewedDraft',
  'aiSuggestTranslations',
  'githubReadMenu',
  'githubOpenPr',
  'githubReconcilePr',
  'githubVerifyPublication'
]);

const OPERATION_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA = /^[A-Za-z0-9._-]{7,128}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLOSED_REQUESTS = new Set(['completata', 'archiviata', 'chiusa']);
const EDITABLE_REQUESTS = new Set(['nuova', 'materiale_ricevuto', 'in_analisi', 'dati_da_confermare', 'bozza_pronta', 'in_revisione', 'in_attesa']);
const RETRYABLE_WITHOUT_WRITE = new Set([
  'GITHUB_NOT_CONFIGURED', 'GITHUB_FETCH_UNAVAILABLE', 'INVALID_SLUG', 'REQUEST_KIND_REQUIRED',
  'INVALID_MENU', 'SLUG_MISMATCH', 'SLUG_EXISTS', 'MENU_NOT_FOUND', 'BASE_SHA_CONFLICT',
  'FILE_SHA_CONFLICT', 'FILE_SHA_REQUIRED', 'BASE_SHA_REQUIRED'
]);
const PUBLIC_LANGUAGES = new Set(['it', 'en', 'de', 'fr', 'es']);
// This is deliberately a constant rather than configuration or client input:
// the verification receipt may only attest the canonical public Pages origin.
const PUBLIC_MENU_ORIGIN = 'https://renmenu.pages.dev';
const COMPLETED_REQUEST_STATUS = 'completata';

function fail(message, status = 422) {
  throw Object.assign(new Error(message), { status });
}

function assert(condition, message, status = 422) {
  if (!condition) fail(message, status);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clean(value, limit, label, required = true) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > limit)
    fail(`${label}: testo non valido o troppo lungo.`);
  return value.trim();
}

function identifier(value) {
  return clean(value, 80, 'Identificativo');
}

function requestRevision(value, current) {
  const revision = Number(value);
  assert(Number.isInteger(revision) && revision === current, 'Pratica modificata da un’altra sessione. Ricarica.', 409);
  return revision;
}

function draftRevision(value, current) {
  const revision = Number(value);
  assert(Number.isInteger(revision) && revision === current, 'Bozza modificata da un’altra sessione. Ricarica.', 409);
  return revision;
}

function hashString(value) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then((digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
}

async function hashBytes(value) {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function aiAdapter(env) {
  const provider = String(env?.AI_PROVIDER || 'mock').trim();
  assert(['mock', 'openai_compatible'].includes(provider),
    'AI disabilitata: impostare esplicitamente AI_PROVIDER=mock o openai_compatible.', 501);
  return createAiLiveAdapter({ ...env, AI_PROVIDER: provider }, { fetch: env?.AI_FETCH || env?.fetch });
}

function requireAiRequestScope(env, adapter, requestId) {
  if (adapter.mode !== 'openai_compatible') return;
  // Fail closed: staging may only send the one synthetic fixture to an external
  // provider. Real-client processing requires a separate, explicit policy change.
  assert(env?.AI_TEST_REQUEST_ID === requestId,
    'Analisi AI live limitata alla pratica fittizia autorizzata.', 403);
}

function requireGitHubLive(env) {
  const provider = String(env?.GITHUB_PROVIDER || 'mock').trim();
  assert(provider === 'live', 'GitHub live non è abilitato: la modalità predefinita è mock/off.', 501);
}

function githubOptions(env) {
  const fetch = env?.GITHUB_FETCH || env?.fetch;
  return typeof fetch === 'function' ? { fetch } : {};
}

function publicMenuFetch(env) {
  // Keep the public verifier separate from the authenticated GitHub adapter.
  // Tests may inject PUBLIC_FETCH, but callers can never inject a public URL.
  const fetch = env?.PUBLIC_FETCH || env?.fetch || globalThis.fetch;
  assert(typeof fetch === 'function', 'Fetch pubblico non disponibile per verificare la pubblicazione.', 503);
  return fetch;
}

function operationBranch(slug, operationKey) {
  // Must stay byte-for-byte aligned with github-live.js without exposing the
  // operation key in a GitHub branch name.
  const fnv = (input, seed) => {
    let hash = seed;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
  };
  return `control-room/menu-${slug}-${fnv(`${slug}\u0000${operationKey}`, 0x811c9dc5)}${fnv(`${slug}\u0000${operationKey}`, 0x9e3779b9)}`;
}

/** Canonical JSON comparison: object-key order is not publication semantics. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sameMenuSemantics(left, right) {
  return stableJson(left) === stableJson(right);
}

function checksDefault() {
  return { prices: false, allergens: false, languages: false, clientApproval: false };
}

function summary(error) {
  // Error messages may originate from an upstream provider. Persist only a
  // bounded code, never remote text, headers, a token, or client material.
  return typeof error?.code === 'string' ? error.code.slice(0, 80) : 'UNKNOWN';
}

function uncertainGitHubError(error) {
  return !(error instanceof GitHubLiveError) || !RETRYABLE_WITHOUT_WRITE.has(error.code);
}

function menuFromExtraction(extraction, venueName, immutableSlug) {
  const primary = (extraction.languages_detected || []).find((language) => PUBLIC_LANGUAGES.has(language)) || 'it';
  const localized = (value) => ({ [primary]: String(value).trim() });
  const sections = (extraction.sections || []).map((section) => ({
    nome: localized(section.name),
    voci: (section.items || []).map((item) => {
      const entry = { nome: localized(item.name) };
      if (item.price !== null && item.price !== undefined) entry.prezzo = item.price;
      if (item.description !== null && item.description !== undefined) entry.descrizione = localized(item.description);
      return entry;
    })
  })).filter((section) => section.voci.length);
  return { id: immutableSlug, nome: localized(venueName), lingue: [primary], sezioni: sections };
}

async function loadRequest(db, getOne, requestId) {
  const request = await getOne(db, `SELECT r.*, c.name AS client_name, c.menu_id AS client_menu_id
    FROM requests r JOIN clients c ON c.id=r.client_id WHERE r.id=?`, requestId);
  assert(request, 'Pratica non trovata.', 404);
  return request;
}

/**
 * A usable transcript is allowed only if the private R2 object still exists,
 * its stored size and SHA-256 match, and its linked analysis is reviewable.
 * This validates provenance without copying object bytes into D1 or audit logs.
 */
async function validatedTranscriptSources({ db, env, requestId, rows }) {
  const analyses = await rows(db, `SELECT ma.material_id,ma.source_sha256,ma.source_text,ma.status,
      m.r2_key,m.size FROM material_analyses ma JOIN materials m ON m.id=ma.material_id
      WHERE ma.request_id=? AND m.archived_at IS NULL AND ma.status IN ('complete','needs_review')
        AND length(trim(ma.source_text)) > 0 ORDER BY m.created_at ASC`, requestId);
  if (!analyses.length) return { text: '', materials: [] };
  assert(env?.BUCKET?.get, 'Archivio privato non configurato per verificare le trascrizioni.', 503);
  const textParts = [];
  const materials = [];
  for (const analysis of analyses) {
    assert(typeof analysis.source_sha256 === 'string' && /^[a-f0-9]{64}$/i.test(analysis.source_sha256),
      'Provenienza della trascrizione non valida.', 409);
    const source = await env.BUCKET.get(analysis.r2_key);
    assert(source?.arrayBuffer, 'Materiale privato non disponibile per verificare la trascrizione.', 409);
    const bytes = new Uint8Array(await source.arrayBuffer());
    assert(bytes.byteLength > 0 && bytes.byteLength === Number(analysis.size),
      'Materiale privato modificato: trascrizione non utilizzabile.', 409);
    const digest = await hashBytes(bytes);
    assert(digest === analysis.source_sha256.toLowerCase(),
      'Materiale privato modificato: trascrizione non utilizzabile.', 409);
    const text = clean(analysis.source_text, 50_000, 'Trascrizione salvata');
    textParts.push(`Trascrizione verificata ${materials.length + 1}:\n${text}`);
    materials.push({ materialId: analysis.material_id, sourceSha256: digest, status: analysis.status });
  }
  return { text: textParts.join('\n\n'), materials };
}

async function auditOnly({ db, auditedBatch, requestId, revision, event, message }) {
  await auditedBatch(db, [], event, message, requestId, {
    sql: 'SELECT 1 FROM requests WHERE id=? AND revision=?', args: [requestId, revision]
  });
}

function extractionInput(request, transcripts) {
  const parts = [];
  if (typeof request.source_text === 'string' && request.source_text.trim()) parts.push(`Richiesta originale:\n${request.source_text.trim()}`);
  if (transcripts.text) parts.push(transcripts.text);
  assert(parts.length, 'Serve testo della richiesta o una trascrizione privata verificata.');
  return parts.join('\n\n');
}

async function classifyRequest(context, p) {
  const requestId = identifier(p.requestId);
  const request = await loadRequest(context.db, context.getOne, requestId);
  const revision = requestRevision(p.requestRevision, request.revision);
  assert(!CLOSED_REQUESTS.has(request.status), 'Pratica chiusa: classificazione non disponibile.', 409);
  const adapter = aiAdapter(context.env);
  requireAiRequestScope(context.env, adapter, requestId);
  const classification = await adapter.classifyEmail({
    subject: request.subject, text: request.source_text, channel: request.source_channel
  });
  // This deliberately records only that an advisory classification was shown:
  // no kind, status, contact, plan, menu id, or other critical field is changed.
  await auditOnly({ ...context, requestId, revision, event: 'ai.classify.advisory',
    message: 'Classificazione AI proposta in sola lettura; nessun campo critico della pratica modificato.' });
  return { requestId, requestRevision: revision, provider: adapter.mode, advisory: true, classification };
}

async function extractMenuPreview(context, p) {
  const requestId = identifier(p.requestId);
  const request = await loadRequest(context.db, context.getOne, requestId);
  const revision = requestRevision(p.requestRevision, request.revision);
  assert(!CLOSED_REQUESTS.has(request.status), 'Pratica chiusa: estrazione non disponibile.', 409);
  const adapter = aiAdapter(context.env);
  requireAiRequestScope(context.env, adapter, requestId);
  const transcripts = await validatedTranscriptSources({ ...context, requestId });
  const extraction = await adapter.extractMenu({ text: extractionInput(request, transcripts), venueName: request.client_name });
  const slug = request.menu_id || (request.kind !== 'nuovo' ? request.client_menu_id : null) || slugify(request.client_name);
  assert(SLUG.test(slug), 'Menu ID non valido: correggilo prima di creare una bozza.', 422);
  const menu = menuFromExtraction(extraction, request.client_name, slug);
  const validation = validateMenu(menu);
  await auditOnly({ ...context, requestId, revision, event: 'ai.extract.preview',
    message: 'Bozza AI proposta per revisione umana; nessun menu è stato salvato.' });
  return {
    requestId, requestRevision: revision, provider: adapter.mode, advisory: true,
    menu, validation,
    extraction: {
      ...extraction,
      // R2 keys, filenames and request text are never included in the result.
      materialSources: transcripts.materials
    }
  };
}

async function saveAiReviewedDraft(context, p) {
  const requestId = identifier(p.requestId);
  assert(p.confirmation === 'CONFERMO BOZZA AI REVISIONATA', 'Conferma esatta di revisione umana mancante.', 403);
  const request = await loadRequest(context.db, context.getOne, requestId);
  const revision = requestRevision(p.requestRevision, request.revision);
  assert(EDITABLE_REQUESTS.has(request.status), 'Pratica non modificabile: apri una nuova pratica.', 409);
  assert(!await context.getOne(context.db, 'SELECT id FROM drafts WHERE request_id=?', requestId), 'Esiste già una bozza per questa pratica.', 409);
  // Revalidate transcript provenance at persistence time so an old preview cannot
  // be saved after a private source changes or disappears.
  await validatedTranscriptSources({ ...context, requestId });
  assert(object(p.menu), 'Menù revisionato non valido.');
  assert(JSON.stringify(p.menu).length <= 250_000, 'Menù troppo grande.');
  const slug = clean(p.slug ?? p.menu.id, 64, 'Slug');
  assert(SLUG.test(slug) && p.menu.id === slug, 'ID JSON e slug non corrispondono.');
  if (request.kind !== 'nuovo' || request.menu_id) {
    const immutable = request.menu_id || request.client_menu_id;
    assert(immutable && slug === immutable, 'Aggiornamento: non cambiare il Menu ID di un QR già distribuito.');
  }
  const validation = validateMenu(p.menu);
  assert(!validation.errors.length, `Menù non valido: ${validation.errors.slice(0, 3).join(' ')}`);
  const id = context.uid(), stamp = context.now(), menuJson = JSON.stringify(p.menu);
  const changed = await context.auditedBatch(context.db, [
    context.db.prepare(`INSERT INTO drafts (id,request_id,slug,menu_json,status,checks_json,revision,created_at,updated_at)
      SELECT ?,id,?,?,?,?,?,?,? FROM requests
      WHERE id=? AND revision=? AND status IN ('nuova','materiale_ricevuto','in_analisi','dati_da_confermare','bozza_pronta','in_revisione','in_attesa')`)
      .bind(id, slug, menuJson, 'bozza', JSON.stringify(checksDefault()), 1, stamp, stamp, requestId, revision),
    context.db.prepare('INSERT INTO draft_versions (id,draft_id,revision,menu_json,actor,created_at) VALUES (?,?,?,?,?,?)')
      .bind(context.uid(), id, 1, menuJson, 'ai_human_review', stamp),
    context.db.prepare(`UPDATE requests SET status='in_revisione',revision=revision+1,updated_at=?
      WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM drafts WHERE id=? AND request_id=?)`)
      .bind(stamp, requestId, revision, id, requestId)
  ], 'ai.draft.save', 'Bozza AI revisionata manualmente e salvata; checklist editoriale da completare.', requestId,
  { sql: 'SELECT 1 FROM drafts WHERE id=? AND request_id=?', args: [id, requestId] });
  assert(changed.every((entry) => entry.meta.changes === 1), 'Pratica modificata da un’altra sessione. Ricarica.', 409);
  return { id, requestId, requestRevision: revision + 1, validation, requiresEditorialReview: true };
}

async function suggestTranslations(context, p) {
  const requestId = identifier(p.requestId);
  const request = await loadRequest(context.db, context.getOne, requestId);
  const revision = requestRevision(p.requestRevision, request.revision);
  assert(!CLOSED_REQUESTS.has(request.status), 'Pratica chiusa: traduzioni non disponibili.', 409);
  const adapter = aiAdapter(context.env);
  requireAiRequestScope(context.env, adapter, requestId);
  const suggestions = await adapter.suggestTranslations({ targetLanguage: p.targetLanguage ?? p.target_language, items: p.items ?? p.entries });
  await auditOnly({ ...context, requestId, revision, event: 'ai.translation.advisory',
    message: 'Suggerimenti di traduzione mostrati senza approvazione né modifica del menu.' });
  return { requestId, requestRevision: revision, provider: adapter.mode, advisory: true, suggestions };
}

async function readGitHubMenu(context, p) {
  requireGitHubLive(context.env);
  const slug = clean(p.slug, 64, 'Slug');
  assert(SLUG.test(slug), 'Slug non valido.');
  const result = await readCurrentMenu(context.env, slug, githubOptions(context.env));
  const validation = result.exists ? validateMenu(result.menu) : null;
  const requestId = p.requestId ? identifier(p.requestId) : null;
  let revision = null;
  if (requestId) {
    const request = await loadRequest(context.db, context.getOne, requestId);
    revision = requestRevision(p.requestRevision, request.revision);
    await auditOnly({ ...context, requestId, revision, event: 'github.menu.read',
      message: `Menu GitHub letto in sola lettura: ${slug}.` });
  } else {
    await context.auditedBatch(context.db, [], 'github.menu.read', `Menu GitHub letto in sola lettura: ${slug}.`);
  }
  return { ...result, validation, requestId, requestRevision: revision, readOnly: true };
}

async function loadPrContext(context, p) {
  const draftId = identifier(p.draftId);
  const draft = await context.getOne(context.db, `SELECT d.*, r.kind AS request_kind,r.status AS request_status,
      r.revision AS request_revision,r.id AS request_id FROM drafts d JOIN requests r ON r.id=d.request_id WHERE d.id=?`, draftId);
  assert(draft, 'Bozza non trovata.', 404);
  const revision = draftRevision(p.revision, draft.revision);
  requestRevision(p.requestRevision, draft.request_revision);
  assert(draft.status === 'pronta_pr' && draft.request_status === 'approvata',
    'La bozza deve essere editorialmente approvata prima di aprire una PR live.', 409);
  let menu;
  try { menu = JSON.parse(draft.menu_json); } catch { fail('Bozza menu non leggibile.', 409); }
  const validation = validateMenu(menu);
  assert(!validation.errors.length, 'Validazione menù fallita.');
  let checks;
  try { checks = JSON.parse(draft.checks_json); } catch { fail('Checklist editoriale non leggibile.', 409); }
  const review = reviewIssues(menu, checks);
  assert(!review.issues.length, 'Conferme o fonti editoriali mancanti: torna alla checklist.', 403);
  const operationKey = clean(p.operationKey, 128, 'Chiave operazione');
  assert(OPERATION_KEY.test(operationKey), 'Chiave operazione non valida.');
  const baseSha = clean(p.expectedBaseSha, 128, 'SHA base');
  assert(SHA.test(baseSha), 'SHA base non valido.');
  const expectedFileSha = p.expectedFileSha == null ? null : clean(p.expectedFileSha, 128, 'SHA file');
  if (draft.request_kind !== 'nuovo') assert(expectedFileSha && SHA.test(expectedFileSha), 'Per un aggiornamento serve lo SHA file revisionato.');
  const snapshotSha = await hashString(draft.menu_json);
  return {
    draft, menu, checks, revision, operationKey, baseSha, expectedFileSha, snapshotSha,
    branchName: operationBranch(draft.slug, operationKey)
  };
}

async function markReconciliation(context, operation, requestId, reason) {
  const stamp = context.now();
  await context.auditedBatch(context.db, [
    context.db.prepare(`UPDATE live_pr_operations SET status='needs_reconciliation',last_error=?,updated_at=?
      WHERE id=? AND status IN ('reserved','branch_created','needs_reconciliation')`)
      .bind(reason, stamp, operation.id)
  ], 'github.pr.needs_reconciliation', 'GitHub non ha fornito un esito certo; riconciliazione manuale richiesta, nessuna nuova scrittura GitHub avviata.', requestId,
  { sql: "SELECT 1 FROM live_pr_operations WHERE id=? AND status='needs_reconciliation'", args: [operation.id] });
}

async function openLivePr(context, p) {
  requireGitHubLive(context.env);
  assert(p.confirmation === 'CONFERMO APERTURA PR LIVE', 'Conferma esatta per la PR live mancante.', 403);
  const prepared = await loadPrContext(context, p);
  let operation = await context.getOne(context.db, 'SELECT * FROM live_pr_operations WHERE draft_id=?', prepared.draft.id);
  if (operation) {
    assert(operation.revision === prepared.revision && operation.snapshot_sha === prepared.snapshotSha && operation.base_sha === prepared.baseSha,
      'Operazione PR non coerente con la bozza revisionata.', 409);
    assert(operation.branch_name === prepared.branchName, 'Chiave idempotente già associata a un branch differente.', 409);
    if (operation.status === 'pr_open') {
      await auditOnly({ ...context, requestId: prepared.draft.request_id, revision: prepared.draft.request_revision,
        event: 'github.pr.idempotent', message: 'PR live già registrata: nessuna nuova scrittura GitHub avviata.' });
      return { operationId: operation.id, status: operation.status, prNumber: operation.pr_number, prUrl: operation.pr_url, reused: true };
    }
    if (operation.status !== 'reserved' || !RETRYABLE_WITHOUT_WRITE.has(operation.last_error || '')) {
      if (operation.status !== 'needs_reconciliation')
        await markReconciliation(context, operation, prepared.draft.request_id, operation.last_error || 'UNKNOWN');
      return { operationId: operation.id, status: 'needs_reconciliation', needsReconciliation: true, reused: true };
    }
  } else {
    operation = { id: context.uid(), ...prepared, status: 'reserved' };
    const stamp = context.now();
    await context.auditedBatch(context.db, [
      context.db.prepare(`INSERT INTO live_pr_operations
        (id,draft_id,revision,snapshot_sha,base_sha,branch_name,pr_number,pr_url,status,last_error,created_at,updated_at)
        SELECT ?,d.id,d.revision,?,?,?,NULL,NULL,'reserved',NULL,?,?
        FROM drafts d JOIN requests r ON r.id=d.request_id
        WHERE d.id=? AND d.revision=? AND d.status='pronta_pr' AND r.revision=? AND r.status='approvata'`)
        .bind(operation.id, prepared.snapshotSha, prepared.baseSha, prepared.branchName, stamp, stamp,
          prepared.draft.id, prepared.revision, prepared.draft.request_revision)
    ], 'github.pr.reserve', 'PR live riservata con revisione editoriale e fonte verificata; nessun merge o deploy.', prepared.draft.request_id,
    { sql: "SELECT 1 FROM live_pr_operations WHERE id=? AND status='reserved'", args: [operation.id] });
  }

  try {
    const opened = await openApprovedMenuPr(context.env, {
      slug: prepared.draft.slug,
      menu: prepared.menu,
      requestKind: prepared.draft.request_kind,
      expectedBaseSha: prepared.baseSha,
      expectedFileSha: prepared.expectedFileSha,
      idempotencyKey: prepared.operationKey
    }, githubOptions(context.env));
    const stamp = context.now();
    const completed = await context.auditedBatch(context.db, [
      context.db.prepare(`UPDATE live_pr_operations SET status='pr_open',pr_number=?,pr_url=?,last_error=NULL,updated_at=?
        WHERE id=? AND status='reserved' AND snapshot_sha=? AND base_sha=? AND branch_name=?`)
        .bind(opened.pr.number, opened.pr.htmlUrl, stamp, operation.id, prepared.snapshotSha, prepared.baseSha, prepared.branchName)
    ], 'github.pr.open', 'Draft PR GitHub aperta; merge, pubblicazione e deploy restano manuali e non sono eseguiti qui.', prepared.draft.request_id,
    { sql: "SELECT 1 FROM live_pr_operations WHERE id=? AND status='pr_open'", args: [operation.id] });
    assert(completed[0].meta.changes === 1, 'Stato PR modificato durante l’apertura: riconcilia manualmente.', 409);
    return {
      operationId: operation.id, status: 'pr_open', branchName: opened.branch,
      pr: opened.pr, reused: opened.reused, wrote: opened.wrote
    };
  } catch (error) {
    const code = summary(error);
    if (uncertainGitHubError(error)) {
      // A network/API failure can follow a successful write with a lost response.
      // Persist the uncertainty, then refuse every automatic write retry.
      await markReconciliation(context, operation, prepared.draft.request_id, code);
    } else {
      const stamp = context.now();
      await context.auditedBatch(context.db, [
        context.db.prepare("UPDATE live_pr_operations SET last_error=?,updated_at=? WHERE id=? AND status='reserved'")
          .bind(code, stamp, operation.id)
      ], 'github.pr.error', 'PR live non aperta: errore noto registrato senza nuova scrittura GitHub.', prepared.draft.request_id,
      { sql: "SELECT 1 FROM live_pr_operations WHERE id=? AND status='reserved' AND last_error=?", args: [operation.id, code] });
    }
    throw error;
  }
}

async function reconcileLivePr(context, p) {
  requireGitHubLive(context.env);
  assert(p.confirmation === 'CONFERMO RICONCILIAZIONE PR LIVE', 'Conferma esatta di riconciliazione mancante.', 403);
  const draftId = identifier(p.draftId);
  const operation = await context.getOne(context.db, `SELECT o.*,d.request_id FROM live_pr_operations o
    JOIN drafts d ON d.id=o.draft_id WHERE o.draft_id=?`, draftId);
  assert(operation, 'Operazione PR live non trovata.', 404);
  assert(['reserved', 'branch_created', 'needs_reconciliation'].includes(operation.status),
    'Operazione PR non richiede riconciliazione.', 409);
  const prNumber = Number(p.prNumber);
  assert(Number.isInteger(prNumber) && prNumber > 0, 'Numero PR non valido.');
  const status = await getPrStatus(context.env, prNumber, githubOptions(context.env));
  assert(status.headRef === operation.branch_name, 'La PR indicata non corrisponde alla riserva Control Room.', 409);
  assert(status.state === 'open' && !status.merged, 'La PR indicata non è una draft PR aperta riconciliabile.', 409);
  const stamp = context.now();
  const changed = await context.auditedBatch(context.db, [
    context.db.prepare(`UPDATE live_pr_operations SET status='pr_open',pr_number=?,pr_url=?,last_error=NULL,updated_at=?
      WHERE id=? AND status IN ('reserved','branch_created','needs_reconciliation')`)
      .bind(status.number, status.htmlUrl, stamp, operation.id)
  ], 'github.pr.reconciled', 'PR live riconciliata con lettura GitHub; nessun merge, pubblicazione o deploy eseguito.', operation.request_id,
  { sql: "SELECT 1 FROM live_pr_operations WHERE id=? AND status='pr_open'", args: [operation.id] });
  assert(changed[0].meta.changes === 1, 'Operazione PR modificata durante la riconciliazione.', 409);
  return { operationId: operation.id, status: 'pr_open', pr: status, reconciled: true };
}

function publicMenuUrl(slug) {
  return `${PUBLIC_MENU_ORIGIN}/menus/${encodeURIComponent(slug)}.json`;
}

async function readPublishedMenu(context, slug) {
  const url = publicMenuUrl(slug);
  let response;
  try {
    response = await publicMenuFetch(context.env)(url, {
      method: 'GET',
      // Redirects must never turn a fixed allow-listed URL into an arbitrary
      // upstream. The status/redirected checks below also cover test doubles.
      redirect: 'error',
      headers: { Accept: 'application/json' }
    });
  } catch {
    fail('Menu pubblico non raggiungibile per la verifica della pubblicazione.', 503);
  }
  assert(response && Number.isInteger(response.status) && typeof response.text === 'function',
    'Risposta del menu pubblico non valida.', 502);
  assert(response.status === 200 && response.redirected !== true,
    'Il menu pubblico deve rispondere direttamente con HTTP 200, senza redirect.', 409);
  let menu;
  try { menu = JSON.parse(await response.text()); }
  catch { fail('Il menu pubblico non contiene JSON valido.', 409); }
  assert(object(menu), 'Il menu pubblico non contiene un oggetto JSON valido.', 409);
  assert(menu.id === slug, 'L’identificativo del menu pubblico non corrisponde allo slug verificato.', 409);
  const validation = validateMenu(menu);
  assert(!validation.errors.length, 'Il menu pubblico non supera la validazione.', 409);
  return { url, menu, validation };
}

async function loadPublicationContext(context, p) {
  const draftId = identifier(p.draftId);
  const record = await context.getOne(context.db, `SELECT o.*,d.request_id,d.slug,d.revision AS draft_revision,
      d.menu_json AS draft_menu_json,r.revision AS request_revision,r.status AS request_status,
      r.public_url AS request_public_url
    FROM live_pr_operations o JOIN drafts d ON d.id=o.draft_id
      JOIN requests r ON r.id=d.request_id WHERE o.draft_id=?`, draftId);
  assert(record, 'Operazione PR live non trovata per la bozza.', 404);
  const revision = draftRevision(p.revision, record.draft_revision);
  const suppliedRequestRevision = Number(p.requestRevision);
  assert(Number.isInteger(suppliedRequestRevision) && suppliedRequestRevision >= 1,
    'Revisione pratica non valida. Ricarica.', 409);
  assert(Number(record.revision) === revision, 'Operazione PR non coerente con la revisione della bozza.', 409);
  assert(['pr_open', 'merged'].includes(record.status),
    'La PR deve risultare aperta prima della verifica di pubblicazione.', 409);
  assert(SLUG.test(record.slug), 'Slug della bozza non valido.', 409);
  const prNumber = Number(record.pr_number);
  assert(Number.isInteger(prNumber) && prNumber > 0 && typeof record.pr_url === 'string' && record.pr_url.trim(),
    'Operazione PR priva di numero o URL verificabile.', 409);

  const version = await context.getOne(context.db,
    'SELECT menu_json FROM draft_versions WHERE draft_id=? AND revision=?', draftId, revision);
  assert(version && typeof version.menu_json === 'string',
    'Snapshot versionato della bozza non disponibile per la verifica.', 409);
  let expectedMenu;
  try { expectedMenu = JSON.parse(version.menu_json); }
  catch { fail('Snapshot versionato della bozza non leggibile.', 409); }
  assert(object(expectedMenu) && expectedMenu.id === record.slug,
    'Snapshot versionato non coerente con lo slug della bozza.', 409);
  const validation = validateMenu(expectedMenu);
  assert(!validation.errors.length, 'Snapshot versionato non supera la validazione.', 409);
  const versionSnapshot = await hashString(version.menu_json);
  const draftSnapshot = await hashString(record.draft_menu_json);
  assert(versionSnapshot === record.snapshot_sha && draftSnapshot === record.snapshot_sha,
    'Snapshot PR non coerente con la bozza versionata.', 409);
  return {
    record: { ...record, pr_number: prNumber }, draftId, revision, suppliedRequestRevision,
    expectedMenu, versionMenuJson: version.menu_json, publicUrl: publicMenuUrl(record.slug)
  };
}

async function verifyGitHubPublication(context, p) {
  requireGitHubLive(context.env);
  assert(p.confirmation === 'CONFERMO VERIFICA PUBBLICAZIONE',
    'Conferma esatta di verifica pubblicazione mancante.', 403);
  const prepared = await loadPublicationContext(context, p);
  const { record } = prepared;

  // A lost success response can be retried with the original request revision.
  // Return only the persisted receipt: no fetches, writes, or additional audit
  // entries are needed once the immutable completion has been recorded.
  if (record.status === 'merged') {
    assert(record.request_status === COMPLETED_REQUEST_STATUS && record.request_public_url === prepared.publicUrl,
      'Receipt di pubblicazione incompleta: riconcilia manualmente.', 409);
    return {
      operationId: record.id, status: 'merged', requestId: record.request_id,
      requestRevision: record.request_revision, prNumber: record.pr_number,
      prUrl: record.pr_url, publicUrl: prepared.publicUrl, verified: true, reused: true, receipt: true
    };
  }

  requestRevision(prepared.suppliedRequestRevision, record.request_revision);
  const status = await getPrStatus(context.env, record.pr_number, githubOptions(context.env));
  assert(status.number === record.pr_number && status.headRef === record.branch_name,
    'La PR GitHub non corrisponde al branch della bozza riservata.', 409);
  assert(status.htmlUrl === record.pr_url, 'L’URL della PR GitHub non corrisponde al record riservato.', 409);
  assert(status.merged === true, 'La PR GitHub non risulta ancora merged.', 409);

  const published = await readPublishedMenu(context, record.slug);
  assert(sameMenuSemantics(published.menu, prepared.expectedMenu),
    'Il menu pubblico differisce semanticamente dalla bozza versionata merged.', 409);

  const stamp = context.now();
  const changed = await context.auditedBatch(context.db, [
    context.db.prepare(`UPDATE live_pr_operations SET status='merged',last_error=NULL,updated_at=?
      WHERE id=? AND status='pr_open' AND revision=? AND snapshot_sha=? AND base_sha=?
        AND branch_name=? AND pr_number=? AND pr_url=?
        AND EXISTS (SELECT 1 FROM drafts d JOIN requests r ON r.id=d.request_id
          WHERE d.id=? AND d.revision=? AND d.menu_json=? AND r.id=? AND r.revision=?
            AND EXISTS (SELECT 1 FROM draft_versions v
              WHERE v.draft_id=d.id AND v.revision=d.revision AND v.menu_json=?))`)
      .bind(stamp, record.id, prepared.revision, record.snapshot_sha, record.base_sha,
        record.branch_name, record.pr_number, record.pr_url, prepared.draftId, prepared.revision,
        record.draft_menu_json, record.request_id, record.request_revision, prepared.versionMenuJson),
    context.db.prepare(`UPDATE requests SET status=?,public_url=?,revision=revision+1,updated_at=?
      WHERE id=? AND revision=?
        AND EXISTS (SELECT 1 FROM live_pr_operations o WHERE o.id=? AND o.status='merged'
          AND o.revision=? AND o.snapshot_sha=? AND o.base_sha=? AND o.branch_name=?
          AND o.pr_number=? AND o.pr_url=?)
        AND EXISTS (SELECT 1 FROM drafts d WHERE d.id=? AND d.request_id=? AND d.revision=? AND d.menu_json=?)`)
      .bind(COMPLETED_REQUEST_STATUS, published.url, stamp, record.request_id, record.request_revision,
        record.id, prepared.revision, record.snapshot_sha, record.base_sha, record.branch_name,
        record.pr_number, record.pr_url, prepared.draftId, record.request_id, prepared.revision,
        record.draft_menu_json)
  ], 'github.publication.verified',
  'PR GitHub merged e menu pubblico verificato semanticamente; nessun merge, deploy o messaggio Gmail eseguito qui.',
  record.request_id, {
    sql: `SELECT 1 FROM live_pr_operations o JOIN requests r ON r.id=?
      WHERE o.id=? AND o.status='merged' AND o.revision=? AND o.snapshot_sha=? AND o.base_sha=?
        AND o.branch_name=? AND o.pr_number=? AND o.pr_url=? AND r.id=? AND r.revision=?
        AND r.status=? AND r.public_url=?`,
    args: [record.request_id, record.id, prepared.revision, record.snapshot_sha, record.base_sha,
      record.branch_name, record.pr_number, record.pr_url, record.request_id,
      Number(record.request_revision) + 1, COMPLETED_REQUEST_STATUS, published.url]
  });
  assert(changed.length === 2 && changed.every((entry) => entry.meta.changes === 1),
    'Stato pubblicazione modificato durante la verifica. Ricarica.', 409);
  return {
    operationId: record.id, status: 'merged', requestId: record.request_id,
    requestRevision: Number(record.request_revision) + 1, prNumber: record.pr_number,
    prUrl: record.pr_url, publicUrl: published.url, verified: true, reused: false
  };
}

/** Returns null for legacy/mock route actions; otherwise handles exactly one private operation. */
export async function runPrivateIntegrationAction(context, type, input) {
  if (!PRIVATE_INTEGRATION_ACTIONS.has(type)) return null;
  const p = object(input) ? input : {};
  assert(context?.db?.prepare && typeof context?.auditedBatch === 'function' && typeof context?.getOne === 'function' && typeof context?.rows === 'function',
    'Integrazione privata non inizializzata.', 503);
  const dependencies = {
    ...context,
    now: context.now || (() => new Date().toISOString()),
    uid: context.uid || (() => crypto.randomUUID())
  };
  if (type === 'aiClassifyRequest') return classifyRequest(dependencies, p);
  if (type === 'aiExtractMenu') return extractMenuPreview(dependencies, p);
  if (type === 'saveAiReviewedDraft') return saveAiReviewedDraft(dependencies, p);
  if (type === 'aiSuggestTranslations') return suggestTranslations(dependencies, p);
  if (type === 'githubReadMenu') return readGitHubMenu(dependencies, p);
  if (type === 'githubOpenPr') return openLivePr(dependencies, p);
  if (type === 'githubVerifyPublication') return verifyGitHubPublication(dependencies, p);
  return reconcileLivePr(dependencies, p);
}

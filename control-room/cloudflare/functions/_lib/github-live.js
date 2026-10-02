import { menuDiff, validateMenu } from './menu.js';

// This module is deliberately not wired into the Phase A route.  It is a
// server-only adapter for a future, separately reviewed integration.
const OWNER = 'Rua56';
const REPOSITORY = 'renmenu';
const BASE_BRANCH = 'main';
const API_ROOT = `https://api.github.com/repos/${OWNER}/${REPOSITORY}`;
const API_VERSION = '2022-11-28';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OPERATION_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const MERGE_CONFIRMATION = 'CONFERMO MERGE MENU APPROVATO';

/** A safe, structured error.  It intentionally never contains the token. */
export class GitHubLiveError extends Error {
  constructor(code, message, { status, retryAfter, details } = {}) {
    super(message);
    this.name = 'GitHubLiveError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, options) {
  throw new GitHubLiveError(code, message, options);
}

function requireText(value, code, message) {
  if (typeof value !== 'string' || !value.trim()) fail(code, message);
  return value.trim();
}

function requireSlug(slug) {
  if (typeof slug !== 'string' || !SLUG.test(slug)) fail('INVALID_SLUG', 'Slug del menu non valido.', { status: 422 });
  return slug;
}

function requireToken(env) {
  return requireText(env?.GITHUB_TOKEN, 'GITHUB_NOT_CONFIGURED', 'GITHUB_TOKEN non configurato.');
}

function getFetch(env, options = {}) {
  const candidate = options.fetch || env?.GITHUB_FETCH || env?.fetch || globalThis.fetch;
  if (typeof candidate !== 'function') fail('GITHUB_FETCH_UNAVAILABLE', 'Fetch GitHub non disponibile.');
  return candidate;
}

function asBase64(text) {
  const bytes = new TextEncoder().encode(text);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function fromBase64(value) {
  const normalized = String(value || '').replace(/\s/g, '');
  try {
    if (typeof Buffer !== 'undefined') return new TextDecoder().decode(Buffer.from(normalized, 'base64'));
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    fail('GITHUB_INVALID_CONTENT', 'GitHub ha restituito contenuto Base64 non valido.');
  }
}

function retryAfter(headers) {
  const retry = Number(headers?.get?.('retry-after'));
  if (Number.isFinite(retry) && retry >= 0) return Math.ceil(retry);
  const reset = Number(headers?.get?.('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, Math.ceil(reset - Date.now() / 1000));
  return undefined;
}

function isRateLimit(status, payload, headers) {
  const message = typeof payload?.message === 'string' ? payload.message : '';
  return status === 429 || (status === 403 && (headers?.get?.('x-ratelimit-remaining') === '0' || /rate limit/i.test(message)));
}

function githubError(response, payload) {
  if (isRateLimit(response.status, payload, response.headers)) {
    return new GitHubLiveError('GITHUB_RATE_LIMITED', 'GitHub ha limitato temporaneamente le richieste.', {
      status: response.status,
      retryAfter: retryAfter(response.headers)
    });
  }
  // Il messaggio di GitHub (es. "Resource not accessible by personal access token") non
  // contiene mai il token: mostrarlo permette di capire il problema dal telefono.
  const detail = typeof payload?.message === 'string' ? payload.message.replace(/[^\x20-\x7E]/g, '').slice(0, 140) : '';
  return new GitHubLiveError('GITHUB_API_ERROR', `GitHub ha rifiutato la richiesta (HTTP ${response.status}${detail ? `: ${detail}` : ''}).`, { status: response.status });
}

async function responsePayload(response) {
  const body = await response.text();
  if (!body) return null;
  try { return JSON.parse(body); } catch { return null; }
}

/**
 * Sends a request only to the fixed allow-listed repository.  The caller
 * cannot supply an owner, repository, or arbitrary URL.
 */
async function githubRequest(env, path, { method = 'GET', body, allowStatuses = [], ...options } = {}) {
  const token = requireToken(env);
  const fetch = getFetch(env, options);
  let response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': API_VERSION,
        // GitHub rifiuta (403) le richieste API senza User-Agent; i Worker non lo aggiungono.
        'User-Agent': 'RenMenu-Jarvis-Control-Room',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  } catch {
    fail('GITHUB_NETWORK_ERROR', 'Impossibile contattare GitHub.');
  }
  if (!response || typeof response.status !== 'number') fail('GITHUB_BAD_RESPONSE', 'Risposta GitHub non valida.');
  const payload = await responsePayload(response);
  if (!response.ok && isRateLimit(response.status, payload, response.headers)) throw githubError(response, payload);
  if (!response.ok && !allowStatuses.includes(response.status)) throw githubError(response, payload);
  // Stop a multi-step operation before its next write when GitHub says the
  // quota is exhausted, even if this individual response happened to be 2xx.
  if (response.ok && response.headers?.get?.('x-ratelimit-remaining') === '0') {
    fail('GITHUB_RATE_LIMITED', 'GitHub ha esaurito temporaneamente la quota.', { retryAfter: retryAfter(response.headers) });
  }
  return { status: response.status, data: payload, headers: response.headers };
}

function contentPath(slug) {
  return `menus/${slug}.json`;
}

function contentEndpoint(slug, ref) {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  return `/contents/menus/${encodeURIComponent(slug)}.json${query}`;
}

function normalizeCurrent(currentMenu) {
  if (currentMenu === undefined) return undefined;
  if (currentMenu === null || currentMenu?.exists === false) return null;
  if (currentMenu?.exists === true) return { menu: currentMenu.menu, sha: currentMenu.sha };
  if (currentMenu?.menu && typeof currentMenu.menu === 'object') return { menu: currentMenu.menu, sha: currentMenu.sha };
  return { menu: currentMenu, sha: undefined };
}

function cloneJson(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { fail('INVALID_MENU', 'Il menu non è serializzabile come JSON.', { status: 422 }); }
}

function operationMode(snapshot) {
  const supplied = snapshot?.requestKind ?? snapshot?.kind ?? snapshot?.mode;
  if (snapshot?.isNew === true || ['nuovo', 'new', 'create'].includes(supplied)) return 'new';
  if (snapshot?.isNew === false || ['aggiornamento', 'prezzo', 'traduzione', 'qr', 'update'].includes(supplied)) return 'update';
  fail('REQUEST_KIND_REQUIRED', 'Specificare se il menu è nuovo o un aggiornamento.', { status: 422 });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sameMenu(left, right) {
  return stableJson(left) === stableJson(right);
}

function refSha(ref) {
  const sha = ref?.object?.sha;
  if (typeof sha !== 'string' || !sha) fail('GITHUB_BAD_RESPONSE', 'GitHub non ha restituito lo SHA del ref.');
  return sha;
}

function expectedSha(snapshot, names, code, message) {
  for (const name of names) if (typeof snapshot?.[name] === 'string' && snapshot[name].trim()) return snapshot[name].trim();
  fail(code, message, { status: 422 });
}

function branchSuffix(value) {
  // Two deterministic 32-bit hashes avoid exposing the operation key in a
  // public branch while making retries address the same branch.
  const fnv = (input, seed) => {
    let hash = seed;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
  };
  return `${fnv(value, 0x811c9dc5)}${fnv(value, 0x9e3779b9)}`;
}

function branchFor(slug, operationKey) {
  return `control-room/menu-${slug}-${branchSuffix(`${slug}\u0000${operationKey}`)}`;
}

function prSummary(pr) {
  if (!Number.isInteger(pr?.number)) fail('GITHUB_BAD_RESPONSE', 'GitHub non ha restituito una pull request valida.');
  return {
    number: pr.number,
    state: pr.state || 'open',
    draft: Boolean(pr.draft),
    merged: Boolean(pr.merged_at),
    htmlUrl: typeof pr.html_url === 'string' ? pr.html_url : null,
    headSha: typeof pr.head?.sha === 'string' ? pr.head.sha : null,
    baseSha: typeof pr.base?.sha === 'string' ? pr.base.sha : null
  };
}

function prBody({ slug, filePath, changes }) {
  const added = changes.filter((change) => change.type === 'aggiunto').length;
  const prices = changes.filter((change) => change.type === 'prezzo').length;
  const removed = changes.filter((change) => change.type === 'rimosso').length;
  return [
    '## Proposta menu pubblica',
    `- File: \`${filePath}\``,
    `- QR pubblico: \`menu/?m=${slug}\``,
    `- Voci aggiunte: ${added}; prezzi modificati: ${prices}; voci rimosse: ${removed}.`,
    '',
    'Verificare il diff, approvare e fare merge manualmente. Nessun merge automatico è configurato.'
  ].join('\n');
}

function putMessage(mode, slug) {
  return mode === 'new' ? `Create public menu ${slug}` : `Update public menu ${slug}`;
}

function requireOperationKey(snapshot, options) {
  const key = options.idempotencyKey ?? options.operationKey ?? snapshot?.idempotencyKey ?? snapshot?.operationKey;
  if (typeof key !== 'string' || !OPERATION_KEY.test(key)) {
    fail('IDEMPOTENCY_KEY_REQUIRED', 'È richiesta una chiave di operazione idempotente valida.', { status: 422 });
  }
  return key;
}

async function getRef(env, name, options, allowMissing = false) {
  const result = await githubRequest(env, `/git/ref/heads/${name}`, { ...options, allowStatuses: allowMissing ? [404] : [] });
  return result.status === 404 ? null : result.data;
}

async function createRef(env, branch, sha, options) {
  return githubRequest(env, '/git/refs', { ...options, method: 'POST', body: { ref: `refs/heads/${branch}`, sha }, allowStatuses: [409, 422] });
}

async function findOperationPr(env, branch, options) {
  const query = new URLSearchParams({ state: 'all', head: `${OWNER}:${branch}`, base: BASE_BRANCH, per_page: '100' });
  const result = await githubRequest(env, `/pulls?${query}`, options);
  if (!Array.isArray(result.data)) fail('GITHUB_BAD_RESPONSE', 'GitHub non ha restituito l’elenco PR previsto.');
  return result.data.find((pr) => pr?.head?.ref === branch && pr?.base?.ref === BASE_BRANCH) || null;
}

async function createOrRecoverPr(env, prepared, branch, options) {
  const existing = await findOperationPr(env, branch, options);
  if (existing) return { pr: existing, reused: true };
  try {
    const result = await githubRequest(env, '/pulls', {
      ...options,
      method: 'POST',
      body: {
        title: `Menu ${prepared.slug}: proposta di pubblicazione`,
        head: branch,
        base: BASE_BRANCH,
        body: prepared.prBody,
        // La PR nasce solo dopo la conferma finale di Riccardo; il merge resta
        // un passaggio separato con frase esplicita, quindi non serve una draft PR.
        draft: false
      }
    });
    return { pr: result.data, reused: false };
  } catch (error) {
    // A retry can race with a previous request that created the PR but whose
    // response was lost. A 422 is only recovered by finding the exact branch.
    if (!(error instanceof GitHubLiveError) || error.status !== 422) throw error;
    const recovered = await findOperationPr(env, branch, options);
    if (!recovered) throw error;
    return { pr: recovered, reused: true };
  }
}

/**
 * Reads a public menu through the GitHub Contents API. A missing menu is a
 * normal result; all other HTTP failures throw GitHubLiveError.
 */
export async function readCurrentMenu(env, slug, options = {}) {
  slug = requireSlug(slug);
  const ref = options.ref || BASE_BRANCH;
  const result = await githubRequest(env, contentEndpoint(slug, ref), { ...options, allowStatuses: [404] });
  if (result.status === 404) return { exists: false, status: 404, slug, filePath: contentPath(slug), menu: null, sha: null, ref };
  const document = result.data;
  if (document?.type !== 'file' || typeof document.sha !== 'string' || typeof document.content !== 'string') {
    fail('GITHUB_BAD_RESPONSE', 'GitHub non ha restituito un file menu valido.');
  }
  let menu;
  try { menu = JSON.parse(fromBase64(document.content)); } catch (error) {
    if (error instanceof GitHubLiveError) throw error;
    fail('GITHUB_INVALID_JSON', 'Il file menu su GitHub non contiene JSON valido.');
  }
  return { exists: true, status: 200, slug, filePath: contentPath(slug), menu, sha: document.sha, ref };
}

/**
 * Validates the approved JSON, keeps its immutable menu id equal to the slug,
 * checks new-vs-existing semantics, and computes only a public menu diff.
 */
export function inspectApprovedMenu({ slug, menu, requestKind, kind, mode, isNew, currentMenu } = {}) {
  slug = requireSlug(slug);
  const requestedMode = operationMode({ requestKind, kind, mode, isNew });
  const candidate = cloneJson(menu);
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || candidate.id !== slug) {
    fail('SLUG_MISMATCH', 'L’identificativo JSON deve coincidere con lo slug immutabile del menu.', { status: 422 });
  }
  const validation = validateMenu(candidate);
  if (validation.errors.length) fail('INVALID_MENU', 'Il JSON del menu non supera la validazione pubblica.', { status: 422, details: { errors: validation.errors } });

  const existing = normalizeCurrent(currentMenu);
  if (existing !== undefined) {
    if (requestedMode === 'new' && existing) fail('SLUG_EXISTS', 'Esiste già un menu con questo slug: non creare un nuovo locale.', { status: 409 });
    if (requestedMode === 'update' && !existing) fail('MENU_NOT_FOUND', 'Il menu da aggiornare non esiste.', { status: 404 });
    // Solo per un menu che esiste già: un menu nuovo (null) non ha un id da confrontare.
    if (existing && existing.menu?.id !== slug) fail('CURRENT_SLUG_MISMATCH', 'Il menu esistente non rispetta lo slug richiesto.', { status: 409 });
  }
  const previous = existing?.menu || null;
  const changes = menuDiff(previous, candidate);
  const json = `${JSON.stringify(candidate, null, 2)}\n`;
  const filePath = contentPath(slug);
  return {
    slug,
    mode: requestedMode,
    filePath,
    menu: candidate,
    json,
    content: asBase64(json),
    validation,
    changes,
    prBody: prBody({ slug, filePath, changes }),
    currentSha: existing?.sha || null
  };
}

// Clear aliases for callers that name this step "prepare" rather than
// "inspect". They share exactly the same validation and slug invariant.
export const prepareApprovedMenu = inspectApprovedMenu;
export const prepareMenuForPr = inspectApprovedMenu;

function assertExpectedCurrent(snapshot, prepared) {
  const expected = expectedSha(snapshot, ['expectedFileSha', 'fileSha', 'currentFileSha'], 'FILE_SHA_REQUIRED',
    'Per un aggiornamento è richiesto lo SHA del file approvato.');
  if (prepared.currentSha !== expected) {
    fail('FILE_SHA_CONFLICT', 'Il file menu è cambiato dopo l’approvazione.', { status: 409 });
  }
}

async function resumeExistingBranch(env, prepared, branch, baseSha, branchRef, options) {
  const onBranch = await readCurrentMenu(env, prepared.slug, { ...options, ref: branch });
  if (onBranch.exists) {
    if (!sameMenu(onBranch.menu, prepared.menu)) {
      fail('OPERATION_COLLISION', 'Il branch idempotente contiene un menu diverso.', { status: 409 });
    }
    return { wrote: false, reusedBranch: true };
  }
  // A branch that was created in a previous attempt but not yet written can
  // be resumed only when it still points to the approved immutable base.
  if (refSha(branchRef) !== baseSha) {
    fail('OPERATION_COLLISION', 'Il branch idempotente non punta alla base approvata.', { status: 409 });
  }
  return writeMenuFile(env, prepared, branch, options);
}

async function recoverOrWriteBranch(env, prepared, branch, baseSha, options) {
  const branchRef = await getRef(env, branch, options, true);
  if (branchRef) return resumeExistingBranch(env, prepared, branch, baseSha, branchRef, options);
  const created = await createRef(env, branch, baseSha, options);
  if (created.status === 201) return writeMenuFile(env, prepared, branch, options);
  // A branch creation collision can be either a safe retry or an unrelated
  // collision. Re-read it and accept only byte-equivalent JSON semantics.
  const recovered = await getRef(env, branch, options, true);
  if (!recovered) {
    fail('BRANCH_CREATE_FAILED', 'GitHub non ha creato il branch della proposta.', { status: created.status });
  }
  return resumeExistingBranch(env, prepared, branch, baseSha, recovered, options);
}

async function writeMenuFile(env, prepared, branch, options) {
  const body = { message: putMessage(prepared.mode, prepared.slug), content: prepared.content, branch };
  if (prepared.mode === 'update') body.sha = prepared.currentSha;
  const result = await githubRequest(env, contentEndpoint(prepared.slug), { ...options, method: 'PUT', body, allowStatuses: [409, 422] });
  if (result.status === 200 || result.status === 201) return { wrote: true, reusedBranch: false };

  // Do not retry a write blindly: it might have succeeded while the response
  // was lost. Recover only if the target branch already contains this menu.
  const onBranch = await readCurrentMenu(env, prepared.slug, { ...options, ref: branch });
  if (onBranch.exists && sameMenu(onBranch.menu, prepared.menu)) return { wrote: false, reusedBranch: true };
  fail('FILE_WRITE_CONFLICT', 'GitHub ha segnalato un conflitto nella scrittura del menu.', { status: result.status });
}

/**
 * Opens exactly one draft PR for an approved snapshot. It never merges.
 *
 * `baseSha`/`expectedBaseSha` is the main commit SHA reviewed by the human;
 * update snapshots also require the reviewed file blob SHA. The operation key
 * deterministically names the retry branch and is never copied to the PR.
 */
export async function openApprovedMenuPr(env, approvedSnapshot, options = {}) {
  const snapshot = approvedSnapshot || {};
  const slug = requireSlug(snapshot.slug);
  const operationKey = requireOperationKey(snapshot, options);
  const baseSha = expectedSha(snapshot, ['expectedBaseSha', 'baseSha', 'mainSha'], 'BASE_SHA_REQUIRED',
    'È richiesto lo SHA del branch main approvato.');
  const local = inspectApprovedMenu({
    slug,
    menu: snapshot.menu,
    requestKind: snapshot.requestKind,
    kind: snapshot.kind,
    mode: snapshot.mode,
    isNew: snapshot.isNew
  });
  const branch = branchFor(slug, operationKey);

  // Idempotency is checked before optimistic-concurrency checks: a completed
  // PR is returned even if main has since moved.
  const existingPr = await findOperationPr(env, branch, options);
  if (existingPr) {
    const existingMenu = await readCurrentMenu(env, slug, { ...options, ref: branch });
    if (!existingMenu.exists || !sameMenu(existingMenu.menu, local.menu)) {
      fail('OPERATION_COLLISION', 'La chiave idempotente è già associata a un contenuto diverso.', { status: 409 });
    }
    return { branch, filePath: local.filePath, changes: local.changes, reused: true, wrote: false, pr: prSummary(existingPr) };
  }

  const mainRef = await getRef(env, BASE_BRANCH, options);
  if (refSha(mainRef) !== baseSha) {
    fail('BASE_SHA_CONFLICT', 'Il branch main è cambiato dopo l’approvazione.', { status: 409 });
  }
  // Read from the immutable reviewed commit, not a moving `main` name.
  const current = await readCurrentMenu(env, slug, { ...options, ref: baseSha });
  const prepared = inspectApprovedMenu({
    slug,
    menu: snapshot.menu,
    requestKind: snapshot.requestKind,
    kind: snapshot.kind,
    mode: snapshot.mode,
    isNew: snapshot.isNew,
    currentMenu: current
  });
  if (prepared.mode === 'update') assertExpectedCurrent(snapshot, prepared);

  const branchResult = await recoverOrWriteBranch(env, prepared, branch, baseSha, options);
  const prResult = await createOrRecoverPr(env, prepared, branch, options);
  return {
    branch,
    filePath: prepared.filePath,
    changes: prepared.changes,
    reused: branchResult.reusedBranch || prResult.reused,
    wrote: branchResult.wrote,
    pr: prSummary(prResult.pr)
  };
}

/** Gets sanitized status for a Control Room-managed pull request only. */
export async function getPrStatus(env, prNumber, options = {}) {
  if (!Number.isInteger(prNumber) || prNumber < 1) fail('INVALID_PR_NUMBER', 'Numero PR non valido.', { status: 422 });
  const result = await githubRequest(env, `/pulls/${prNumber}`, options);
  const pr = result.data;
  if (pr?.base?.ref !== BASE_BRANCH || typeof pr?.head?.ref !== 'string' || !pr.head.ref.startsWith('control-room/menu-')) {
    fail('PR_NOT_MANAGED', 'La pull request non appartiene a una proposta Control Room.', { status: 403 });
  }
  return {
    ...prSummary(pr),
    mergeable: pr.mergeable ?? null,
    mergeableState: pr.mergeable_state ?? null,
    headRef: pr.head.ref,
    baseRef: pr.base.ref
  };
}

/**
 * Deliberately standalone manual merge helper. Nothing in this module calls it.
 * A caller must provide an exact phrase, approved revision, and both reviewed
 * head/base SHAs; GitHub receives the head SHA again as its own merge guard.
 */
export async function mergeApprovedMenuPr(env, {
  prNumber,
  confirmation,
  approvedRevision,
  expectedHeadSha,
  expectedBaseSha
} = {}, options = {}) {
  if (confirmation !== MERGE_CONFIRMATION) {
    fail('MERGE_CONFIRMATION_REQUIRED', 'Conferma esplicita di merge mancante.', { status: 403 });
  }
  if (!Number.isInteger(approvedRevision) || approvedRevision < 1) {
    fail('MERGE_REVISION_REQUIRED', 'È richiesta una revisione approvata valida.', { status: 422 });
  }
  requireText(expectedHeadSha, 'MERGE_SHA_REQUIRED', 'È richiesto lo SHA head approvato.');
  requireText(expectedBaseSha, 'MERGE_SHA_REQUIRED', 'È richiesto lo SHA base approvato.');
  const status = await getPrStatus(env, prNumber, options);
  if (status.state !== 'open' || status.merged) fail('PR_NOT_OPEN', 'La pull request non è aperta.', { status: 409 });
  if (status.draft) fail('PR_IS_DRAFT', 'La pull request è ancora in bozza su GitHub.', { status: 409 });
  if (status.headSha !== expectedHeadSha || status.baseSha !== expectedBaseSha) {
    fail('MERGE_SHA_CONFLICT', 'La pull request è cambiata dopo l’approvazione.', { status: 409 });
  }
  const result = await githubRequest(env, `/pulls/${prNumber}/merge`, {
    ...options,
    method: 'PUT',
    body: {
      sha: expectedHeadSha,
      merge_method: 'squash',
      commit_title: `Merge approved menu PR #${prNumber}`
    }
  });
  if (result.data?.merged !== true) fail('MERGE_NOT_COMPLETED', 'GitHub non ha completato il merge.', { status: 409 });
  return { merged: true, prNumber, revision: approvedRevision, sha: result.data.sha || null };
}

/** SHA attuale di main, usato come base attesa per aprire la PR. */
export async function readBaseSha(env, options = {}) {
  return refSha(await getRef(env, BASE_BRANCH, options));
}

/** Nomi dei file modificati da una PR Control Room (massimo 100). */
export async function listPrFiles(env, prNumber, options = {}) {
  if (!Number.isInteger(prNumber) || prNumber < 1) fail('INVALID_PR_NUMBER', 'Numero PR non valido.', { status: 422 });
  const result = await githubRequest(env, `/pulls/${prNumber}/files?per_page=100`, options);
  if (!Array.isArray(result.data)) fail('GITHUB_BAD_RESPONSE', 'GitHub non ha restituito l’elenco dei file della PR.');
  return result.data.map((file) => ({ filename: String(file?.filename || ''), status: String(file?.status || '') }));
}

export const MANUAL_MERGE_CONFIRMATION = MERGE_CONFIRMATION;
export const GITHUB_REPOSITORY = `${OWNER}/${REPOSITORY}`;

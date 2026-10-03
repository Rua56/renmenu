import { validateMenu } from './menu.js';

const PUBLIC_ORIGIN = 'https://renmenu.pages.dev';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PURGE_ACTION = 'email.retention.purged';
export const PURGE_PUBLISHED_EMAIL_CONFIRMATION = 'CONFERMO ELIMINAZIONE EMAIL PUBBLICATA';

function fail(message, status = 422) {
  throw Object.assign(new Error(message), { status });
}

function assert(condition, message, status = 422) {
  if (!condition) fail(message, status);
}

function identifier(value) {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= 80, 'Identificativo pratica non valido.');
  return value.trim();
}

function revision(value) {
  const parsed = Number(value);
  assert(Number.isInteger(parsed) && parsed > 0, 'Revisione pratica non valida.');
  return parsed;
}

function publicMenuUrl(slug) {
  assert(typeof slug === 'string' && slug.length <= 64 && SLUG.test(slug), 'Slug del menù non valido.', 409);
  const url = new URL(`/menus/${slug}.json`, PUBLIC_ORIGIN);
  // Keep this explicit even though the URL is constructed locally: no caller
  // can turn this verification request into an arbitrary outbound fetch.
  assert(url.protocol === 'https:' && url.hostname === 'renmenu.pages.dev' && url.port === '' &&
    url.pathname === `/menus/${slug}.json` && !url.search && !url.hash, 'Destinazione pubblica non autorizzata.', 409);
  return url;
}

function semanticJson(value) {
  if (Array.isArray(value)) return value.map(semanticJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, semanticJson(value[key])]));
  }
  return value;
}

function semanticallyEqual(left, right) {
  return JSON.stringify(semanticJson(left)) === JSON.stringify(semanticJson(right));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parsedAndValid(menuJson, label) {
  let menu;
  try { menu = JSON.parse(menuJson); } catch { fail(`${label} non leggibile.`, 409); }
  const validation = validateMenu(menu);
  assert(!validation.errors.length, `${label} non valido.`, 409);
  return menu;
}

async function readPublishedMenu(fetchImpl, url, slug) {
  assert(typeof fetchImpl === 'function', 'Verifica pubblica non configurata: nessun dato eliminato.', 503);
  let response;
  try {
    response = await fetchImpl(url.href, {
      method: 'GET', redirect: 'manual', headers: { Accept: 'application/json' }
    });
  } catch {
    fail('Verifica della disponibilità pubblica non riuscita: nessun dato eliminato.', 503);
  }
  assert(response && response.status === 200 && !response.redirected,
    'Menù pubblico non disponibile senza redirect: nessun dato eliminato.', 409);
  // A non-empty response.url must remain the exact constructed allowlisted URL.
  assert(!response.url || response.url === url.href, 'Redirect o destinazione pubblica inattesa: nessun dato eliminato.', 409);
  const contentType = response.headers?.get?.('content-type') || '';
  assert(/^application\/json(?:\s*;|$)/i.test(contentType), 'Menù pubblico non in formato JSON: nessun dato eliminato.', 409);
  let raw;
  try { raw = await response.text(); } catch { fail('Menù pubblico non leggibile: nessun dato eliminato.', 409); }
  assert(raw.length > 0 && raw.length <= 250_000, 'Menù pubblico non leggibile: nessun dato eliminato.', 409);
  const menu = parsedAndValid(raw, 'Menù pubblico');
  assert(menu.id === slug, 'Menù pubblico non corrisponde allo slug: nessun dato eliminato.', 409);
  return menu;
}

/**
 * Scrubs only the inbound Gmail body held by requests.source_text. The current
 * schema keeps external_events as metadata only; it does not mutate R2,
 * materials, or unrelated outbound mock messages. A current, server-written
 * live_pr_operations.status='merged' record is required and no client flag can
 * substitute for it.
 */
export async function purgePublishedEmail({ db, input, fetch: fetchImpl, now = () => new Date().toISOString(), uid = () => crypto.randomUUID() }) {
  assert(db?.prepare && typeof db?.batch === 'function', 'Database privato non configurato.', 503);
  const payload = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const requestId = identifier(payload.requestId);
  const expectedRevision = revision(payload.revision);
  assert(payload.confirmation === PURGE_PUBLISHED_EMAIL_CONFIRMATION, 'Conferma esatta di eliminazione email mancante.', 403);

  const request = await db.prepare('SELECT id,revision,source_channel,source_text FROM requests WHERE id=?').bind(requestId).first();
  assert(request, 'Pratica non trovata.', 404);
  assert(request.source_channel === 'email', 'La pratica non è una richiesta email eliminabile.', 409);

  const prior = await db.prepare('SELECT id FROM audit_events WHERE request_id=? AND action=? LIMIT 1').bind(requestId, PURGE_ACTION).first();
  if (prior) {
    assert(request.source_text === '', 'Stato di retention incoerente: nessun dato eliminato.', 409);
    return { requestId, purged: true, reused: true };
  }

  assert(expectedRevision === request.revision, 'Pratica modificata nel frattempo. Ricarica.', 409);
  assert(typeof request.source_text === 'string' && request.source_text.length > 0,
    'Nessun corpo email da eliminare.', 409);

  const event = await db.prepare(`SELECT id FROM external_events
    WHERE request_id=? AND source='gmail' AND status IN ('imported','needs_review') LIMIT 1`).bind(requestId).first();
  assert(event, 'La pratica non deriva da un evento Gmail verificato: nessun dato eliminato.', 409);

  const draft = await db.prepare(`SELECT id,slug,menu_json,status,revision FROM drafts WHERE request_id=?`).bind(requestId).first();
  assert(draft && draft.status === 'pronta_pr', 'Bozza revisionata non disponibile: nessun dato eliminato.', 409);
  const draftMenu = parsedAndValid(draft.menu_json, 'Bozza revisionata');
  assert(draftMenu.id === draft.slug, 'Bozza revisionata incoerente: nessun dato eliminato.', 409);

  const operation = await db.prepare(`SELECT id,revision,snapshot_sha,pr_number,status FROM live_pr_operations
    WHERE draft_id=? LIMIT 1`).bind(draft.id).first();
  assert(operation && operation.status === 'merged' && Number.isInteger(operation.pr_number) && operation.pr_number > 0,
    'PR live merged verificata non disponibile: nessun dato eliminato.', 409);
  assert(operation.revision === draft.revision && operation.snapshot_sha === await sha256(draft.menu_json),
    'Record PR non corrisponde alla bozza revisionata: nessun dato eliminato.', 409);

  const url = publicMenuUrl(draft.slug);
  const publishedMenu = await readPublishedMenu(fetchImpl, url, draft.slug);
  assert(semanticallyEqual(draftMenu, publishedMenu),
    'Menù pubblico differente dalla bozza revisionata: nessun dato eliminato.', 409);

  const stamp = now();
  const auditId = uid();
  const writes = [
    db.prepare(`UPDATE requests SET source_text='',revision=revision+1,updated_at=?,last_action_at=?
      WHERE id=? AND revision=? AND source_channel='email' AND length(source_text)>0
        AND EXISTS (SELECT 1 FROM external_events WHERE request_id=? AND source='gmail' AND status IN ('imported','needs_review'))
        AND NOT EXISTS (SELECT 1 FROM audit_events WHERE request_id=? AND action=?)`)
      .bind(stamp, stamp, requestId, expectedRevision, requestId, requestId, PURGE_ACTION),
    db.prepare(`INSERT INTO audit_events (id,request_id,action,summary,actor,created_at)
      SELECT ?,?,?,?, 'owner', ?
      WHERE EXISTS (SELECT 1 FROM requests WHERE id=? AND revision=? AND source_text='' AND updated_at=?)
        AND NOT EXISTS (SELECT 1 FROM audit_events WHERE request_id=? AND action=?)`)
      .bind(auditId, requestId, PURGE_ACTION, 'Corpo della richiesta Gmail eliminato dopo verifica del menu pubblico.', stamp,
        requestId, expectedRevision + 1, stamp, requestId, PURGE_ACTION)
  ];
  const results = await db.batch(writes);
  if (results[0]?.meta?.changes === 1 && results[1]?.meta?.changes === 1)
    return { requestId, purged: true, reused: false };

  // A competing transaction may have completed the same atomic scrub after the
  // initial read. Only its durable redacted audit receipt makes this a retry.
  const completed = await db.prepare('SELECT id FROM audit_events WHERE request_id=? AND action=? LIMIT 1').bind(requestId, PURGE_ACTION).first();
  if (completed) return { requestId, purged: true, reused: true };
  fail('Pratica modificata nel frattempo: nessun dato eliminato.', 409);
}

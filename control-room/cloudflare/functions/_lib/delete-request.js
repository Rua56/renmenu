// Eliminazione di una pratica di PROVA o mai pubblicata, su richiesta di Riccardo (pulsante di conferma su Telegram).
// Mai eliminabile: una pratica già pubblicata o in pubblicazione, con anteprima mandata al locale o approvata,
// un cliente con menu online (il suo QR non si tocca). Il registro delle azioni resta, senza il legame con la pratica.
const OPEN_BLOCKED = new Set(['completata']);
const DONE_MISSIONS = new Set(['pubblicazione', 'verifica', 'completata']);

export async function deletionPlan(db, { getOne, rows }, { requestId = null, clientId = null }) {
  const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
  const tables = new Set((await safe(() => rows(db, "SELECT name FROM sqlite_master WHERE type='table'"), [])).map((t) => t.name));
  const has = (name) => tables.has(name);
  const plan = { ok: false, blockers: [], tables, request: null, client: null, drafts: [], materials: [], mediaKeys: [], deleteClient: false, clientNote: '' };
  if (requestId) {
    plan.request = await getOne(db, 'SELECT id,client_id,subject,status,kind,plan FROM requests WHERE id=?', requestId);
    if (!plan.request) { plan.blockers.push('La pratica non esiste più.'); return plan; }
    clientId = plan.request.client_id;
  }
  plan.client = clientId ? await getOne(db, 'SELECT id,name,menu_id FROM clients WHERE id=?', clientId) : null;
  if (!requestId && !plan.client) { plan.blockers.push('Non trovo il cliente.'); return plan; }
  if (requestId) {
    if (OPEN_BLOCKED.has(plan.request.status)) plan.blockers.push('La pratica è chiusa: il menu risulta già pubblicato.');
    plan.drafts = await rows(db, 'SELECT id,status,revision,menu_json FROM drafts WHERE request_id=?', requestId);
    const ids = plan.drafts.map((d) => d.id);
    for (const table of ['pr_proposals', 'live_pr_operations']) {
      if (!has(table)) continue;
      for (const id of ids) if (await safe(() => getOne(db, `SELECT 1 AS x FROM ${table} WHERE draft_id=?`, id), null)) { plan.blockers.push('La bozza è già stata portata in pubblicazione.'); break; }
    }
    if (has('jarvis_missions')) {
      const busy = await safe(() => rows(db, 'SELECT status FROM jarvis_missions WHERE request_id=?', requestId), []);
      if (busy.some((m) => DONE_MISSIONS.has(m.status))) plan.blockers.push('Jarvis l’ha già pubblicata o la sta pubblicando.');
    }
    if (has('publication_approvals')) {
      const approvals = await safe(() => rows(db, 'SELECT recipient,sent_at,approved_at,activation_at FROM publication_approvals WHERE request_id=?', requestId), []);
      if (approvals.some((a) => a.approved_at || a.activation_at)) plan.blockers.push('L’anteprima è già stata approvata.');
      else if (approvals.some((a) => a.sent_at && !String(a.recipient || '').startsWith('telegram:'))) plan.blockers.push('L’anteprima è già stata mandata al locale.');
    }
    plan.materials = await rows(db, 'SELECT id,r2_key FROM materials WHERE request_id=?', requestId);
    if (has('media_items')) plan.mediaKeys = (await safe(() => rows(db, 'SELECT public_key,public_sha FROM media_items WHERE request_id=? AND public_key IS NOT NULL', requestId), [])).map((m) => m.public_key);
  }
  if (plan.client) {
    const others = await getOne(db, 'SELECT COUNT(*) AS n FROM requests WHERE client_id=?' + (requestId ? ' AND id<>?' : ''), ...(requestId ? [plan.client.id, requestId] : [plan.client.id]));
    if (plan.client.menu_id) plan.clientNote = `«${plan.client.name}» ha un menu online: il cliente resta (il suo QR non si tocca).`;
    else if (Number(others?.n)) plan.clientNote = `«${plan.client.name}» ha altre pratiche: il cliente resta.`;
    else plan.deleteClient = true;
    if (!requestId && !plan.deleteClient) plan.blockers.push(plan.clientNote);
  }
  plan.ok = !plan.blockers.length;
  return plan;
}

export function deletionStatements(db, plan) {
  const id = plan.request?.id;
  const out = [];
  const add = (table, sql, ...args) => { if (plan.tables.has(table)) out.push(db.prepare(sql).bind(...args)); };
  if (id) {
    add('mail_files', 'DELETE FROM mail_files WHERE material_id IN (SELECT id FROM materials WHERE request_id=?)', id);
    add('media_items', 'DELETE FROM media_items WHERE request_id=?', id);
    add('jarvis_outbox', 'DELETE FROM jarvis_outbox WHERE request_id=?', id);
    add('jarvis_missions', 'DELETE FROM jarvis_missions WHERE request_id=?', id);
    add('publication_approvals', 'DELETE FROM publication_approvals WHERE request_id=?', id);
    add('draft_versions', 'DELETE FROM draft_versions WHERE draft_id IN (SELECT id FROM drafts WHERE request_id=?)', id);
    add('drafts', 'DELETE FROM drafts WHERE request_id=?', id);
    add('material_analyses', 'DELETE FROM material_analyses WHERE request_id=?', id);
    add('materials', 'DELETE FROM materials WHERE request_id=?', id);
    for (const table of ['notifications', 'messages', 'external_events', 'outbound_deliveries', 'ai_inference_attempts']) add(table, `DELETE FROM ${table} WHERE request_id=?`, id);
    add('audit_events', 'UPDATE audit_events SET request_id=NULL WHERE request_id=?', id);
    add('requests', 'DELETE FROM requests WHERE id=?', id);
  }
  if (plan.deleteClient && plan.client) {
    add('venue_memory', 'DELETE FROM venue_memory WHERE client_id=?', plan.client.id);
    add('clients', "DELETE FROM clients WHERE id=? AND (menu_id IS NULL OR menu_id='') AND NOT EXISTS (SELECT 1 FROM requests WHERE client_id=?)", plan.client.id, plan.client.id);
  }
  return out;
}

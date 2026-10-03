// Allegati delle email dei clienti: lo script Google di renmenu1569 manda a Jarvis le foto e i PDF
// (mai altro) con l'id del messaggio Gmail. Jarvis li tiene da parte finché l'importer crea la
// pratica della stessa email (id gmail-request-<messageId>) e li collega solo se il mittente è
// lo stesso cliente. Poi la lettura delle foto e l'autopilota fanno il resto.
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const MAX_FILE = 10_000_000, MAX_FILES = 6, ORPHAN_DAYS = 3;
const signatureOk = (mime, b) => mime === 'image/jpeg' ? b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
  : mime === 'image/png' ? b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    : mime === 'image/webp' ? String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP'
      : String.fromCharCode(...b.subarray(0, 5)) === '%PDF-';
const hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
function fromBase64(value) {
  const binary = atob(String(value || '').replace(/[^A-Za-z0-9+/=_-]/g, '').replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
const cleanName = (name, part, mime) => String(name || '').replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').trim().slice(0, 120) || `allegato-${part + 1}.${TYPES[mime]}`;

/** Riceve {messageId, from, subject, files:[{name,mime,data}], skipped:[nomi]}. */
export async function receiveMailFiles(db, env, payload, { now, uid }) {
  const messageId = String(payload?.messageId || '');
  const sender = String(payload?.from || '').trim().toLowerCase();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(messageId) || !/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/.test(sender)) return { ok: false, error: 'INVALID_INPUT' };
  if (!env.BUCKET?.put) return { ok: false, error: 'BUCKET_MISSING' };
  const files = Array.isArray(payload.files) ? payload.files.slice(0, MAX_FILES) : [];
  const skipped = (Array.isArray(payload.skipped) ? payload.skipped : []).map((n) => String(n).slice(0, 120)).slice(0, 20);
  const stored = [];
  for (const [part, file] of files.entries()) {
    const mime = String(file?.mime || '').toLowerCase();
    const name = cleanName(file?.name, part, mime);
    if (!TYPES[mime]) { skipped.push(name); continue; }
    let bytes;
    try { bytes = fromBase64(file.data); } catch { skipped.push(name); continue; }
    if (!bytes.length || bytes.length > MAX_FILE || !signatureOk(mime, bytes)) { skipped.push(name); continue; }
    const existing = await db.prepare('SELECT id FROM mail_files WHERE message_id=? AND part=?').bind(messageId, part).first();
    if (existing) { stored.push(existing.id); continue; } // lo script ha riprovato: niente doppioni
    const id = uid(), key = `private/mail/${messageId}/${part}`;
    await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
    await db.prepare('INSERT INTO mail_files (id,message_id,part,sender,subject,filename,mime,size,sha256,r2_key,material_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?) ON CONFLICT(message_id,part) DO NOTHING')
      .bind(id, messageId, part, sender, String(payload.subject || '').slice(0, 200), name, mime, bytes.length, await hex(bytes), key, now()).run();
    stored.push(id);
  }
  return { ok: true, stored: stored.length, skipped };
}

/** Collega gli allegati arrivati alle pratiche create dall'importer. Restituisce gli avvisi per Riccardo. */
export async function linkMailFiles(db, env, { now, uid, auditedBatch }) {
  let pending = [];
  try {
    pending = (await db.prepare(`SELECT f.*, r.id AS request_id, r.status AS request_status, r.revision AS request_revision, r.subject AS request_subject, lower(c.email) AS client_email
      FROM mail_files f LEFT JOIN requests r ON r.id='gmail-request-'||f.message_id LEFT JOIN clients c ON c.id=r.client_id
      WHERE f.material_id IS NULL ORDER BY f.created_at ASC LIMIT 20`).bind().all()).results || [];
  } catch (error) { if (/no such table/i.test(String(error?.message))) return []; throw error; }
  const notices = [], touched = new Map();
  for (const file of pending) {
    if (!file.request_id) {
      if (Date.now() - Date.parse(file.created_at) > ORPHAN_DAYS * 86_400_000) { // email mai importata (non pertinente)
        await env.BUCKET?.delete?.(file.r2_key);
        await db.prepare('DELETE FROM mail_files WHERE id=?').bind(file.id).run();
      }
      continue;
    }
    if (['completata', 'archiviata', 'chiusa'].includes(file.request_status) || file.client_email !== file.sender) {
      await db.prepare("UPDATE mail_files SET material_id='scartato' WHERE id=?").bind(file.id).run();
      if (file.client_email !== file.sender) notices.push({ requestId: file.request_id, text: `Allegato «${file.filename}» non collegato: il mittente non coincide con il cliente della pratica.` });
      continue;
    }
    const count = (await db.prepare('SELECT COUNT(*) AS n FROM materials WHERE request_id=?').bind(file.request_id).first())?.n || 0;
    if (count >= 12) { await db.prepare("UPDATE mail_files SET material_id='scartato' WHERE id=?").bind(file.id).run(); continue; }
    const materialId = uid();
    await auditedBatch({ prepare: (sql) => db.prepare(sql), batch: (s) => db.batch(s), actor: 'jarvis' }, [
      db.prepare('INSERT INTO materials (id,request_id,r2_key,filename,mime,size,source,processing_status,text_preview,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .bind(materialId, file.request_id, file.r2_key, file.filename, file.mime, file.size, 'email', 'da_trascrivere', null, now()),
      db.prepare('UPDATE mail_files SET material_id=? WHERE id=? AND material_id IS NULL').bind(materialId, file.id)
    ], 'material.add', `Allegato dell'email importato da Jarvis: «${file.filename}» (${file.mime}, ${file.size} byte).`, file.request_id);
    touched.set(file.request_id, file);
  }
  // Email con allegati in sospeso (anche foto inserite nel testo, che rendono il corpo «incompleto»):
  // ora che ci sono, la pratica torna all'autopilota. Tutto resta comunque da rivedere da Riccardo.
  for (const [requestId] of touched) {
    await db.prepare(`UPDATE requests SET status='nuova',internal_notes=?,next_step=?,updated_at=? WHERE id=? AND status='dati_da_confermare' AND revision=1
      AND EXISTS (SELECT 1 FROM external_events e WHERE e.request_id=requests.id AND e.reason IN ('attachments_pending','body_incomplete_or_attachments'))`)
      .bind('Email Gmail con allegati importati da Jarvis (foto/PDF): verificare la lettura sugli originali.', 'Jarvis legge gli allegati e prepara la bozza o la proposta.', now(), requestId).run();
  }
  return notices;
}

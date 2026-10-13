// Menu in arrivo su WhatsApp (Cloud API di Meta → /hooks/whatsapp, firma già verificata).
// Ogni messaggio diventa parte di UNA pratica per numero: testo, foto e PDF mandati di seguito
// dallo stesso locale finiscono nella stessa pratica finché resta aperta e recente (12 ore).
// Foto e PDF vengono scaricati da Meta (WHATSAPP_TOKEN) e messi da parte nel bucket privato
// come materiali «da trascrivere»: li legge l'orologio di Jarvis, come quelli di Telegram.
// Il contenuto è un dato non attendibile: non viene mai eseguito né seguito.
import { persistIncomingExternalEvent, persistIgnoredExternalEvent, whatsappRecordFromMessage } from './webhooks.js';

export const GROUP_HOURS = 12;
const GRAPH = 'https://graph.facebook.com';
const MEDIA_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const MAX_MEDIA = 20_000_000;
const MAX_FILES = 20;
const MAX_TEXT = 16 * 1024;

const iso = (date) => date.toISOString();
const id = () => crypto.randomUUID();

/** Cosa contiene il messaggio: testo (anche la didascalia di una foto) ed eventuale file da scaricare. */
export function whatsappParts(message) {
  const raw = message?.content?.raw || {};
  const type = message?.messageType;
  const text = type === 'text' ? String(message.content?.text || '') : String(raw[type]?.caption || '');
  const media = ['image', 'document'].includes(type) && typeof raw[type]?.id === 'string' && /^[0-9A-Za-z_-]{1,128}$/.test(raw[type].id)
    ? { mediaId: raw[type].id, mime: String(raw[type].mime_type || '').split(';')[0].trim().toLowerCase(), filename: String(raw[type].filename || '').slice(0, 120) }
    : null;
  const unsupported = !text && !media ? type || 'unknown' : null;
  return { text: text.slice(0, 8 * 1024), media, unsupported };
}

/** Scarica un file di WhatsApp: prima l'indirizzo temporaneo da Meta, poi i byte (sempre con il token). */
export async function downloadWhatsAppMedia(env, mediaId, fetchImpl) {
  const token = env.WHATSAPP_TOKEN;
  if (!token) return { ok: false, reason: 'WHATSAPP_TOKEN_MISSING' };
  const version = /^v\d{1,2}\.\d$/.test(env.WHATSAPP_GRAPH_VERSION || '') ? env.WHATSAPP_GRAPH_VERSION : 'v21.0';
  const auth = { Authorization: `Bearer ${token}` };
  try {
    const meta = await fetchImpl(`${GRAPH}/${version}/${encodeURIComponent(mediaId)}`, { headers: auth });
    if (!meta.ok) return { ok: false, reason: `META_${meta.status}` };
    const info = await meta.json();
    const mime = String(info?.mime_type || '').split(';')[0].trim().toLowerCase();
    if (!MEDIA_TYPES[mime]) return { ok: false, reason: 'UNSUPPORTED_TYPE', mime };
    if (Number(info?.file_size) > MAX_MEDIA) return { ok: false, reason: 'TOO_LARGE' };
    const url = new URL(String(info?.url || ''));
    if (url.protocol !== 'https:' || !/(^|\.)(fbcdn\.net|facebook\.com|whatsapp\.net)$/.test(url.hostname)) return { ok: false, reason: 'UNEXPECTED_MEDIA_HOST' };
    const file = await fetchImpl(url.toString(), { headers: auth });
    if (!file.ok) return { ok: false, reason: `MEDIA_${file.status}` };
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_MEDIA) return { ok: false, reason: 'TOO_LARGE' };
    return { ok: true, bytes, mime };
  } catch { return { ok: false, reason: 'DOWNLOAD_FAILED' }; }
}

// Pratica WhatsApp ancora aperta dello stesso numero, toccata nelle ultime GROUP_HOURS ore.
async function openRequestFor(db, waId, since) {
  return db.prepare(`SELECT r.id,r.source_text,r.status FROM requests r JOIN clients c ON c.id=r.client_id
    WHERE (c.phone=? OR c.phone=?) AND r.source_channel='whatsapp' AND r.status IN ('nuova','dati_da_confermare') AND r.updated_at>=?
    ORDER BY r.updated_at DESC LIMIT 1`).bind(`+${waId}`, waId, since).first();
}

/**
 * Registra un messaggio WhatsApp. deps: { fetchImpl, now }.
 * Restituisce { kind: 'new'|'appended'|'duplicate'|'ignored', requestId, stored, mediaError }.
 */
export async function importWhatsAppMessage(db, env, message, { fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  const parts = whatsappParts(message);
  if (parts.unsupported && !['audio', 'video', 'sticker', 'location', 'contacts'].includes(parts.unsupported)) {
    // Reazioni, conferme e messaggi di sistema: niente pratica.
    const out = await persistIgnoredExternalEvent(db, { source: 'whatsapp', sourceEventId: message.id, reason: `type_${String(parts.unsupported).slice(0, 40)}` });
    return { kind: out.deduplicated ? 'duplicate' : 'ignored', requestId: null, stored: 0 };
  }
  const stamp = iso(now);
  const name = String(message.content?.raw?.profile?.name || message.profileName || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 80);
  const line = parts.text || (parts.media ? `[${parts.media.mime === 'application/pdf' ? 'PDF' : 'foto'} allegata]` : `[messaggio ${parts.unsupported} non letto: chiedi al locale di scriverlo o mandare una foto]`);
  const open = await openRequestFor(db, message.waId, iso(new Date(now.getTime() - GROUP_HOURS * 3_600_000)));
  let requestId, kind;
  if (open) {
    const gate = await db.prepare("INSERT INTO external_events (id,source,source_event_id,request_id,status,reason,received_at) VALUES (?,?,?,?,'imported','grouped',?) ON CONFLICT(source,source_event_id) DO NOTHING")
      .bind(id(), 'whatsapp', message.id, open.id, stamp).run();
    if (!gate?.meta?.changes) return { kind: 'duplicate', requestId: open.id, stored: 0 };
    const text = `${open.source_text || ''}\n\n${line}`.trim().slice(-MAX_TEXT);
    await db.prepare('UPDATE requests SET source_text=?,updated_at=?,last_action_at=?,revision=revision+1 WHERE id=?').bind(text, stamp, stamp, open.id).run();
    requestId = open.id; kind = 'appended';
  } else {
    const record = whatsappRecordFromMessage(message);
    record.sourceText = `${name ? `WhatsApp da ${name} (+${message.waId})` : `WhatsApp da +${message.waId}`}\n\n${line}`;
    if (parts.media || parts.text) { record.externalStatus = 'imported'; record.requestStatus = 'nuova'; record.reason = null; }
    record.subject = parts.media && !parts.text ? 'Menu da WhatsApp' : 'Richiesta WhatsApp';
    const out = await persistIncomingExternalEvent(db, record);
    if (out.deduplicated) return { kind: 'duplicate', requestId: null, stored: 0 };
    requestId = out.requestId; kind = 'new';
  }
  let stored = 0, mediaError = null;
  if (parts.media) {
    const count = (await db.prepare('SELECT COUNT(*) AS n FROM materials WHERE request_id=?').bind(requestId).first())?.n || 0;
    const file = count >= MAX_FILES ? { ok: false, reason: 'TOO_MANY_FILES' } : !env.BUCKET?.put ? { ok: false, reason: 'BUCKET_MISSING' } : await downloadWhatsAppMedia(env, parts.media.mediaId, fetchImpl);
    if (file.ok) {
      const materialId = id(), key = `private/requests/${requestId}/${materialId}`;
      const filename = parts.media.filename || `whatsapp-${message.id.slice(-12).replace(/[^0-9A-Za-z]/g, '')}.${MEDIA_TYPES[file.mime]}`;
      await env.BUCKET.put(key, file.bytes, { httpMetadata: { contentType: file.mime } });
      await db.batch([
        db.prepare('INSERT INTO materials (id,request_id,r2_key,filename,mime,size,source,processing_status,text_preview,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .bind(materialId, requestId, key, filename, file.mime, file.bytes.length, 'whatsapp', 'da_trascrivere', null, stamp),
        db.prepare('INSERT INTO audit_events (id,request_id,action,summary,actor,created_at) VALUES (?,?,?,?,?,?)')
          .bind(id(), requestId, 'material.add', `File da WhatsApp: ${file.mime}, ${file.bytes.length} byte.`, 'relay', stamp)
      ]);
      stored = 1;
    } else {
      mediaError = file.reason;
      await db.prepare("UPDATE requests SET status='dati_da_confermare',next_step=? WHERE id=?").bind(`Un file da WhatsApp non è stato scaricato (${file.reason}): chiedilo di nuovo al locale.`, requestId).run();
    }
  }
  return { kind, requestId, stored, mediaError };
}

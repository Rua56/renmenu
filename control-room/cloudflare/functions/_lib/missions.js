import { readSealedSetting } from './sealed.js';
import { applyCheck, checkQuestion, normalizePrice } from './checks.js';
import { notesSummary } from './notes.js';
// Jarvis autonomo: una «missione» per ogni pratica che Riccardo affida a Jarvis dopo aver
// controllato la bozza. Jarvis porta la pratica fino alla pubblicazione usando le stesse
// operazioni (con gli stessi controlli) dell'interfaccia, con «jarvis» come autore nel registro.
// Si ferma e chiede a Riccardo quando qualcosa non è chiaro; pubblica solo dopo il suo SÌ.
import { deletionPlan } from './delete-request.js';
import { reviewIssues } from './editorial.js';
import { allExtras } from './extras.js';
import { assessReply, proposeReplyChanges, referenceCode, sha256Hex } from './approvals.js';
import { sendOwnerNotification } from './owner-notifications.js';
import { briefingDue, buildBriefing, romeDay } from './briefing.js';
import { answerCallback, clearButtons, downloadTelegramFile, sendDocument, sendPhoto, sendTelegram, sendVoice, telegramReady } from './telegram.js';
import { buildMenuQr, menuLink } from './qr.js';
import { isBlanchSlug, publicMenuJsonUrl, publicMenuPageUrl } from './blanch.js';
import { CHAT_MODEL, chat as freeChat, matchVenue, planFromText, speak, transcribe, understand, venueSaid } from './voice.js';
import { classifyRequest } from './autopilot.js';
import { editFingerprints, editLogKey, proposeOps, validateOps } from './draft-edit.js';
import { GEMINI_PREFERRED } from './vision.js';
import { findDishes, findLocales, guessIntent, hintsText } from './understanding.js';
import { memoryContext, memoryFor, menuStatements, noteStatement } from './memory.js';
import { slugify } from './menu.js';

export const PARTIAL_MARK = '[Testo parziale: leggi l’email completa in Gmail prima di decidere]';
export const OWNER_REVIEW = 'telegram:riccardo';
const ACTIVE = ['affidata', 'attesa_invio', 'attesa_cliente', 'attesa_si', 'pubblicazione', 'verifica'];
// Modifiche che Jarvis applica da solo; gli allergeni restano sempre a Riccardo.
const HARMLESS = /^(?!.*\d)(?!.*\b(?:ma|però|pero|tranne|cambi\w*|modific\w*|sbagliat\w*|manca\w*|togli\w*|aggiung\w*|non)\b).*\b(?:perfett\w*|benissimo|bene|ottim\w*|grazie|approv\w*|ok|confermo|tutto|bellissim\w*)\b/i;
const AUTO_CHANGES = new Set(['prezzo', 'aggiungi', 'rimuovi', 'coperto']);
const MAX_ROUNDS = 3;
const MINUTE = 60_000;
const ACTIVATION_BY_PLAN = { standard: 'prova_30_giorni', annuale: 'annuale_pagato', premium: 'premium_acconto' };
const PLAN_LABEL = { standard: 'Standard, prova gratuita di 30 giorni', annuale: 'Annuale (249 €/anno)', premium: 'Premium (acconto 490 € + 39 €/mese)' };
const CONTROL_ROOM = 'https://renmenu-jarvis-stage.pages.dev/control-room/';
export const OUTBOX_SUBJECT = 'Jarvis · invio anteprima';
export const ONLINE_SUBJECT = 'Jarvis · invio menu online';

const romeDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const describeChange = (entry) => entry.type === 'prezzo' ? `${entry.name}: ${entry.before} → ${entry.after}`
  : entry.type === 'aggiungi' ? `aggiunto ${entry.name} ${entry.price}` : entry.type === 'rimuovi' ? `tolto ${entry.name}`
    : entry.type === 'coperto' ? `coperto ${entry.value}` : `${entry.name}: ${entry.label || entry.type}`;

const EDIT_WORDS = /(?:\d|\beuro\b|€|\bcost\w*|\bprezz\w*|\baggiung\w*|\btogli\w*|\brimuov\w*|\belimin\w*|\bcancell\w*|\bcambia\w*|\bmetti\w*|\bsposta\w*|\brinomin\w*|\bdescrizion\w*|\bchiam\w*|\bdividi\w*|\bspezza\w*|\bsono\b)/i;
// Frasi che chiedono di cambiare il menu, non il QR (es. «metti il QR nel menu»): non sono richieste di QR.
const EDIT_WORDS_STRICT = /\b(?:aggiung\w*|togli\w*|rimuov\w*|prezzo|costa\w*|rinomin\w*)\b/i;
const REREAD = /\b(?:rileggi\w*|rilegg\w+|rileggere|rifai la lettura|leggi(?:le|li)? (?:di nuovo|ancora))\b/i;
const STATUS_WORDS = /^\W*(?:ok\s+)?(?:jarvis[\s,!.]*)?(?:\/)?stato[\s?!.]*$/i;

export function createMissions(deps) {
  const { action, auditedBatch, getOne, rows, now, uid } = deps;
  const jarvisDb = (db) => ({ prepare: (sql) => db.prepare(sql), batch: (s) => db.batch(s), actor: 'jarvis' });

  async function setting(db, key) {
    try { return (await getOne(db, 'SELECT value FROM jarvis_settings WHERE key=?', key))?.value ?? null; }
    catch (error) { if (/no such table/i.test(String(error?.message))) return null; throw error; }
  }
  // ——— Dubbi della lettura foto, uno alla volta su Telegram ———
  async function checkQueue(db, requestId) {
    const list = await rows(db, "SELECT a.id,a.provenance_json FROM material_analyses a JOIN materials m ON m.id=a.material_id WHERE a.request_id=? AND m.archived_at IS NULL ORDER BY m.created_at ASC", requestId).catch(() => []);
    const queue = [];
    for (const row of list) {
      let prov = []; try { prov = JSON.parse(row.provenance_json || '[]'); } catch {}
      (prov[0]?.checks || []).forEach((check, idx) => { if (check && check.resolved === undefined && check.options?.length) queue.push({ analysisId: row.id, idx }); });
    }
    return queue;
  }
  async function askCheck(db, env, chat, state) {
    const item = state.queue[state.k];
    const row = item && await getOne(db, 'SELECT provenance_json FROM material_analyses WHERE id=?', item.analysisId);
    let check = null; try { check = JSON.parse(row?.provenance_json || '[]')[0]?.checks?.[item.idx]; } catch {}
    if (!check) return finishChecks(db, env, chat, state);
    const q = checkQuestion(check, state.k, state.queue.length);
    await sendTelegram(env, chat, q.text, q.buttons, deps.fetchImpl, { stacked: true });
    return null;
  }
  /** Dopo la lettura: se ci sono dubbi con prezzi, Jarvis li chiede uno alla volta (prima della bozza). */
  async function startChecks(db, env, requestId) {
    const chat = await setting(db, 'telegram_chat_id');
    if (!chat || !telegramReady(env)) return 0;
    const queue = await checkQueue(db, requestId);
    if (!queue.length) return 0;
    const state = { requestId, queue, k: 0, applied: 0, at: now() };
    await putSetting(db, 'tg_checks', JSON.stringify(state));
    await askCheck(db, env, chat, state);
    return queue.length;
  }
  async function finishChecks(db, env, chat, state) {
    await putSetting(db, 'tg_checks', 'null');
    const request = await getOne(db, 'SELECT id,category,plan,subject FROM requests WHERE id=?', state.requestId);
    const draft = await getOne(db, 'SELECT id FROM drafts WHERE request_id=?', state.requestId);
    let text = `Dubbi chiusi: ${state.applied} voci aggiunte al menu.`;
    if (!request) text += ' La pratica non c’è più.';
    else if (draft) text += ' C’è già una bozza: per includerle, in Revisione tocca «Rifai la bozza con tutti i materiali».';
    else if (request.plan === 'premium' || request.category === 'nuovo_premium') text += ' È un Premium: avvia tu la bozza dalla Control Room (scheda creativa).';
    else if (!request.category) text += ' Manca ancora il tipo di pratica: dimmi il piano e preparo la bozza.';
    else {
      // La bozza (con traduzioni) richiede tempo: la prepara il giro dell'orologio di Jarvis, non la risposta a Telegram
      // (che verrebbe interrotta). Al massimo pochi minuti.
      await putSetting(db, 'draft_after_checks', JSON.stringify({ requestId: request.id, at: now() }));
      text += ' Preparo la bozza adesso: ti scrivo appena è pronta (pochi minuti).';
    }
    await sendTelegram(env, chat, text, null, deps.fetchImpl);
    return { text };
  }
  async function answerCheck(db, env, chat, k, choice) {
    let state = null; try { state = JSON.parse(await setting(db, 'tg_checks') || 'null'); } catch {}
    if (!state?.queue) return { text: 'Non ho dubbi aperti in questo momento.' };
    if (choice === 'end') { await finishChecks(db, env, chat, state); return { text: 'Va bene, preparo la bozza.', silent: true }; }
    if (k !== state.k) return { text: 'Questo dubbio è già stato chiuso.', silent: true };
    const item = state.queue[k];
    const row = await getOne(db, 'SELECT id,source_text,provenance_json FROM material_analyses WHERE id=?', item.analysisId);
    let prov = []; try { prov = JSON.parse(row?.provenance_json || '[]'); } catch {}
    const check = prov[0]?.checks?.[item.idx];
    if (row && check) {
      let price;
      if (choice === 's') price = undefined; // resta da verificare
      else if (choice === 'n') price = null; // non è nel menu: tolta
      else if (/^\d$/.test(choice)) price = check.options[Number(choice)];
      else price = normalizePrice(choice);
      if (price !== undefined) {
        const text = applyCheck(row.source_text, check, price);
        check.resolved = price === null ? 'tolta' : price;
        await db.prepare('UPDATE material_analyses SET source_text=?, provenance_json=? WHERE id=?').bind(text, JSON.stringify(prov), row.id).run();
        if (price !== null) state.applied += 1;
      } else { check.resolved = 'saltata'; await db.prepare('UPDATE material_analyses SET provenance_json=? WHERE id=?').bind(JSON.stringify(prov), row.id).run(); }
      await auditedBatch(jarvisDb(db), [], 'material.check', `Dubbio «${String(check.name).slice(0, 80)}»: ${price === undefined ? 'saltato' : price === null ? 'non è nel menu' : `${price} € (scelto da Riccardo)`}.`, state.requestId).catch(() => {});
    }
    state.k += 1; state.awaitPrice = false;
    await putSetting(db, 'tg_checks', JSON.stringify(state));
    if (state.k >= state.queue.length) { await finishChecks(db, env, chat, state); return { text: 'Ultimo dubbio chiuso.', silent: true }; }
    await askCheck(db, env, chat, state);
    return { text: 'Segnato.', silent: true };
  }
  // Punto della situazione con dati certi dal database (scritto o a voce: «Jarvis, stato»).
  async function statusText(db) {
    const list = await rows(db, "SELECT m.status,m.note,d.menu_json FROM jarvis_missions m JOIN drafts d ON d.id=m.draft_id WHERE m.status NOT IN ('completata','annullata') ORDER BY m.updated_at DESC LIMIT 10");
    const pending = (await getOne(db, "SELECT COUNT(*) AS n FROM requests WHERE status NOT IN ('completata','archiviata','chiusa')"))?.n || 0;
    const lines = list.map((row) => { let name = 'pratica'; try { name = JSON.parse(row.menu_json).nome; } catch {} return `- ${name}: ${row.status.replace('_', ' ')}${row.note ? ` (${row.note})` : ''}`; });
    // Salute di Jarvis: letture foto di oggi (quota gratuita di Cloudflare), ultimo file da Gmail, letture in corso.
    const safe = async (sql, ...args) => { try { return await getOne(db, sql, ...args); } catch { return null; } };
    let count = null; try { count = JSON.parse(await setting(db, 'reads_day') || 'null'); } catch {}
    const quotaDay = new Date().toISOString().slice(0, 10); // la quota di Cloudflare si azzera a mezzanotte UTC (le 2 in Italia d'estate)
    const reads = count?.day === quotaDay ? count.n : 0, failedReads = count?.day === quotaDay ? count.failed : 0;
    const queued = (await safe("SELECT COUNT(*) AS n FROM materials WHERE processing_status='da_trascrivere' AND archived_at IS NULL"))?.n || 0;
    const lastMail = (await safe('SELECT MAX(created_at) AS at FROM mail_files'))?.at;
    let gem = null; try { const g = JSON.parse(await setting(db, 'gemini_day') || 'null'); if (g?.day === quotaDay) gem = g; } catch {}
    let retrying = 0; try { const w = JSON.parse(await setting(db, 'read_retries') || '{}') || {}; retrying = Object.values(w).filter((r) => r?.next > new Date().toISOString()).length; } catch {}
    const when = (iso) => new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
    const health = [
      `Foto lette oggi: ${reads}${failedReads ? ` (${failedReads} non riuscite)` : ''}. La quota gratuita regge circa 20 letture al giorno e si azzera alle 2 di notte.`,
      ...(gem ? [`Gemini oggi: ${gem.requests} richieste, ${gem.failed} senza risposta${gem.deferred ? `, ${gem.deferred} letture rimandate e riprovate` : ''}${gem.last ? ` (ultimo errore: ${gem.last})` : ''}.${gem.quota ? ' Google ha segnalato la quota esaurita: si ripristina da sola, intanto leggo con i modelli di riserva.' : ''}`] : []),
      queued ? `File in attesa di lettura: ${queued}${retrying ? `, di cui ${retrying} rimandati perché Google era lento` : ''}.` : 'Nessun file in attesa di lettura.',
      lastMail ? `Ultimo allegato arrivato da Gmail: ${when(lastMail)}.` : 'Da Gmail non è ancora arrivato nessun allegato.'
    ];
    return `${lines.length ? `Pratiche affidate a me:\n${lines.join('\n')}` : 'Nessuna pratica affidata in corso.'}\nRichieste aperte nella Control Room: ${pending}.\n\n${health.join('\n')}`;
  }
  async function putSetting(db, key, value) {
    await db.prepare('INSERT INTO jarvis_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .bind(key, String(value), now()).run();
  }

  // Ogni messaggio va sia nella Control Room (riquadro JARVIS) sia su Telegram, se collegato.
  async function tell(db, env, mission, subject, text, buttons = null, priority = 'normale') {
    const id = uid();
    await db.prepare('INSERT INTO notifications (id,request_id,channel,subject,body,priority,due_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(id, mission?.request_id || null, 'in_app', `Jarvis · ${subject}`, String(text).slice(0, 5000), priority, null, 'mock', now()).run();
    const chat = await setting(db, 'telegram_chat_id');
    if (chat && telegramReady(env)) await sendTelegram(env, chat, `${text}`, buttons, deps.fetchImpl);
  }

  async function move(db, mission, status, note, extra = {}) {
    const stamp = now();
    const fields = { status, note: note ? String(note).slice(0, 500) : null, step_started_at: stamp, attempts: 0, ...extra };
    const keys = Object.keys(fields);
    const result = await db.prepare(`UPDATE jarvis_missions SET ${keys.map((k) => `${k}=?`).join(',')},revision=revision+1,updated_at=? WHERE id=? AND revision=?`)
      .bind(...keys.map((k) => fields[k]), stamp, mission.id, mission.revision).run();
    if (result.meta.changes !== 1) throw Object.assign(new Error('Missione aggiornata da un altro passaggio.'), { status: 409, quiet: true });
    return { ...mission, ...fields, revision: mission.revision + 1, updated_at: stamp };
  }
  async function bump(db, mission, extra = {}) {
    const keys = Object.keys(extra);
    await db.prepare(`UPDATE jarvis_missions SET attempts=attempts+1${keys.map((k) => `,${k}=?`).join('')},updated_at=? WHERE id=? AND revision=?`)
      .bind(...keys.map((k) => extra[k]), now(), mission.id, mission.revision).run();
  }
  async function stop(db, env, mission, why) {
    const venue = await venueOf(db, mission);
    const stopped = await move(db, mission, 'ferma', why);
    await tell(db, env, mission, 'serve una tua decisione', `Riccardo, mi sono fermato su «${venue}»: ${why}\nApri la Control Room → Approvazioni: ${CONTROL_ROOM}`, null, 'importante');
    return stopped;
  }
  async function venueOf(db, mission) {
    const draft = await getOne(db, 'SELECT menu_json FROM drafts WHERE id=?', mission.draft_id);
    try { return JSON.parse(draft.menu_json).nome || 'pratica'; } catch { return 'pratica'; }
  }
  const load = async (db, mission) => {
    const draft = await getOne(db, 'SELECT * FROM drafts WHERE id=?', mission.draft_id);
    const request = await getOne(db, 'SELECT r.*,c.name AS client_name,c.email AS client_email FROM requests r JOIN clients c ON c.id=r.client_id WHERE r.id=?', mission.request_id);
    const approval = await getOne(db, 'SELECT * FROM publication_approvals WHERE draft_id=?', mission.draft_id);
    return { draft, request, approval, menu: JSON.parse(draft.menu_json) };
  };

  // Riccardo attesta la revisione interna con un solo gesto; Jarvis la registra a suo nome.
  async function attest(db, env, draftId, evidence, actorDb = db) {
    const draft = await getOne(db, 'SELECT * FROM drafts WHERE id=?', draftId);
    // L'approvazione creativa Premium registrata da Riccardo resta: l'affido non la cancella.
    let saved = {};
    try { saved = JSON.parse(draft.checks_json || '{}') || {}; } catch { saved = {}; }
    const creative = saved.creativeApproval === true ? { creativeApproval: true, creativeApprovalEvidence: saved.creativeApprovalEvidence } : {};
    await action(actorDb, 'reviewDraft', {
      id: draft.id, revision: draft.revision,
      checks: { prices: true, allergens: true, languages: true, clientApproval: false },
      fieldEvidence: { prices: evidence, allergens: evidence, languages: evidence },
      allergenOmissionConfirmed: true, ...creative
    }, env);
  }

  async function entrust(db, env, p) {
    const draftId = String(p.draftId || ''), revision = Number(p.revision);
    if (p.confirmation !== 'AFFIDO A JARVIS') throw Object.assign(new Error('Conferma «Approva e affida a Jarvis» mancante.'), { status: 403 });
    let draft = await getOne(db, 'SELECT * FROM drafts WHERE id=?', draftId);
    if (!draft || draft.revision !== revision) throw Object.assign(new Error('Bozza modificata da un’altra sessione. Ricarica.'), { status: 409 });
    const existing = await getOne(db, 'SELECT * FROM jarvis_missions WHERE request_id=?', draft.request_id);
    if (existing && ACTIVE.includes(existing.status)) throw Object.assign(new Error('Jarvis sta già seguendo questa pratica.'), { status: 409 });
    const request = await getOne(db, 'SELECT r.*,c.email AS client_email FROM requests r JOIN clients c ON c.id=r.client_id WHERE r.id=?', draft.request_id);
    if (['completata', 'archiviata', 'chiusa'].includes(request.status) || existing?.status === 'completata')
      throw Object.assign(new Error('Questo menu è già pubblicato: per modificarlo apri una pratica di aggiornamento (o dimmelo su Telegram).'), { status: 409 });
    if (request.kind === 'nuovo' && !ACTIVATION_BY_PLAN[request.plan]) throw Object.assign(new Error('Piano non confermato: scegli Standard, Annuale o Premium prima di affidare la pratica.'), { status: 422 });
    const pendingReply = await getOne(db, "SELECT 1 AS x FROM publication_approvals WHERE draft_id=? AND status='risposta_ricevuta'", draftId);
    if (pendingReply) throw Object.assign(new Error('C’è una risposta del locale ancora da decidere: valutala in Approvazioni, poi affida di nuovo.'), { status: 422 });
    const accept = Array.isArray(p.accept) ? p.accept.map(String).filter(Boolean) : [];
    if (accept.length) { await action(db, 'applySourceExtras', { draftId, revision, accept }, env); draft = await getOne(db, 'SELECT * FROM drafts WHERE id=?', draftId); }
    const day = romeDate();
    await attest(db, env, draftId, `Bozza controllata da Riccardo e affidata a Jarvis il ${day} («Approva e affida a Jarvis»).`);
    const stamp = now(), id = existing?.id || uid();
    const write = existing
      ? db.prepare("UPDATE jarvis_missions SET draft_id=?,status='affidata',note=NULL,attempts=0,step_started_at=?,reminded_at=NULL,rounds=0,revision=revision+1,updated_at=? WHERE id=?").bind(draftId, stamp, stamp, id)
      : db.prepare("INSERT INTO jarvis_missions (id,request_id,draft_id,status,step_started_at,created_at,updated_at) VALUES (?,?,?,'affidata',?,?,?)").bind(id, draft.request_id, draftId, stamp, stamp, stamp);
    await auditedBatch(db, [write], 'jarvis.entrust', 'Pratica affidata a Jarvis da Riccardo: anteprima, risposta del locale e modifiche; pubblicazione solo dopo il suo SÌ.', draft.request_id,
      { sql: 'SELECT 1 FROM jarvis_missions WHERE id=? AND updated_at=?', args: [id, stamp] });
    const mission = await getOne(db, 'SELECT * FROM jarvis_missions WHERE id=?', id);
    const after = await step(db, env, mission);
    return { missionId: id, status: after?.status || mission.status };
  }

  // ——— passi della missione ———
  async function stepEntrusted(db, env, mission) {
    const jarvis = jarvisDb(db);
    const { draft, request, menu } = await load(db, mission);
    // Pratica senza email del locale (es. aperta da Riccardo su Telegram): l'anteprima la approva lui, su Telegram.
    if (!request.client_email) return stepOwnerPreview(db, env, mission, draft, menu);
    let prepared;
    try { prepared = (await action(jarvis, 'preparePreview', { draftId: draft.id, revision: draft.revision }, env)).result; }
    catch (error) { return stop(db, env, mission, `non riesco a preparare l’anteprima (${String(error?.message || 'errore').slice(0, 200)})`); }
    const approval = await getOne(db, 'SELECT * FROM publication_approvals WHERE draft_id=?', draft.id);
    const stamp = now();
    await db.prepare("UPDATE jarvis_outbox SET status='annullata',updated_at=? WHERE mission_id=? AND status='in_coda'").bind(stamp, mission.id).run();
    await db.prepare("INSERT INTO jarvis_outbox (id,mission_id,request_id,approval_id,reference_code,recipient,subject,body,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'in_coda',?,?)")
      .bind(uid(), mission.id, mission.request_id, approval.id, prepared.referenceCode, prepared.recipient, prepared.subject, prepared.body, stamp, stamp).run();
    const next = await move(db, mission, 'attesa_invio', `Anteprima ${prepared.referenceCode} in coda per Gmail.`);
    await trigger(db, env, next, prepared.referenceCode);
    return next;
  }
  async function stepOwnerPreview(db, env, mission, draft, menu) {
    const chat = await setting(db, 'telegram_chat_id');
    if (!chat || !telegramReady(env)) return stop(db, env, mission, 'il locale non ha un’email e Telegram non è collegato: non ho a chi mandare l’anteprima');
    let prepared;
    try { prepared = (await action(jarvisDb(db), 'preparePreview', { draftId: draft.id, revision: draft.revision, ownerReview: true }, env)).result; }
    catch (error) { return stop(db, env, mission, `non riesco a preparare l’anteprima (${String(error?.message || 'errore').slice(0, 200)})`); }
    const stamp = now();
    await db.prepare("UPDATE publication_approvals SET status='anteprima_inviata',sent_at=?,revision=revision+1,updated_at=? WHERE draft_id=? AND status='anteprima_pronta'").bind(stamp, stamp, draft.id).run();
    const request = await getOne(db, 'SELECT kind,plan FROM requests WHERE id=?', mission.request_id);
    const activation = request.kind === 'nuovo' ? `\nAl SÌ attivo: ${PLAN_LABEL[request.plan]} da oggi (${romeDate()}).` : '';
    const next = await move(db, mission, 'attesa_si', `Anteprima ${prepared.referenceCode} mandata a Riccardo su Telegram (il locale non ha email): attendo il suo SÌ.`);
    await tell(db, env, next, 'anteprima da approvare', `Ecco l’anteprima di «${menu.nome || 'menu'}» (rif. ${prepared.referenceCode}):\n${String(env.JARVIS_ORIGIN || 'https://renmenu-jarvis-stage.pages.dev').replace(/\/+$/, '')}/jarvis-hook/anteprima/${prepared.referenceCode}\n\nIl locale non ha un’email, quindi l’approvazione è tua.${activation}\nSe va bene pubblico; se c’è da correggere tocca «Non ancora», sistemala in Revisione e affidamela di nuovo.`,
      [['SÌ, pubblica', `pub:${mission.id}`], ['Non ancora', `no:${mission.id}`]], 'importante');
    return next;
  }
  // L'invio parte dall'automazione Gmail di renmenu1569: Jarvis le manda un comando interno
  // (via Resend, solo alla casella RenMenu) con il solo codice; il testo resta nella coda D1.
  async function trigger(db, env, mission, code) {
    const outbox = await getOne(db, "SELECT * FROM jarvis_outbox WHERE reference_code=? AND status='in_coda'", code);
    if (!outbox) return;
    const attempt = outbox.trigger_count + 1;
    const sent = await sendOwnerNotification({ db: jarvisDb(db), env, requestId: mission.request_id,
      subject: `${OUTBOX_SUBJECT} ${code}`,
      text: `Comando interno di Jarvis per l'automazione Gmail di renmenu1569: invia l'anteprima ${code} dalla coda di Jarvis. Tentativo ${attempt}. Nessun dato del cliente in questa email.`,
      // Comando tecnico, non un avviso per Riccardo: non rispetta le ore di silenzio (21–8).
      priority: 'urgente', now: new Date(), fetchImpl: deps.fetchImpl });
    await db.prepare('UPDATE jarvis_outbox SET trigger_count=?,triggered_at=?,error=?,updated_at=? WHERE id=?')
      .bind(attempt, now(), sent?.ok ? null : String(sent?.reason || sent?.code || 'TRIGGER_FAILED').slice(0, 120), now(), outbox.id).run();
  }
  async function stepSending(db, env, mission) {
    const outbox = await getOne(db, 'SELECT * FROM jarvis_outbox WHERE mission_id=? ORDER BY created_at DESC LIMIT 1', mission.id);
    if (!outbox) return stop(db, env, mission, 'coda di invio vuota');
    if (outbox.status === 'errore') return stop(db, env, mission, `Gmail non ha inviato l’anteprima ${outbox.reference_code} (${outbox.error || 'errore'})`);
    if (outbox.status === 'inviata') {
      const approval = await getOne(db, 'SELECT * FROM publication_approvals WHERE id=?', outbox.approval_id);
      if (approval.status === 'anteprima_pronta') await action(jarvisDb(db), 'markPreviewSent', { id: approval.id, revision: approval.revision }, env);
      const venue = await venueOf(db, mission);
      const reminder = /^Promemoria:/.test(outbox.subject || '');
      const next = await move(db, mission, 'attesa_cliente', reminder ? 'Promemoria inviato; attendo la risposta del locale.' : `Anteprima ${outbox.reference_code} inviata; attendo la risposta del locale.`, reminder ? { reminded_at: now() } : {});
      await tell(db, env, next, reminder ? 'promemoria inviato' : 'anteprima inviata', reminder ? `Promemoria inviato a «${venue}» da renmenu1569. Ti scrivo appena risponde.` : `Anteprima di «${venue}» inviata al locale da renmenu1569 (rif. ${outbox.reference_code}). Ti scrivo appena risponde.`);
      return next;
    }
    const waited = Date.now() - Date.parse(outbox.triggered_at || outbox.created_at);
    if (outbox.status === 'in_coda' && outbox.error) {
      // Il comando non è partito (es. Resend non raggiungibile): si riprova al minuto successivo.
      if (outbox.trigger_count >= 5) return stop(db, env, mission, `non riesco a mandare il comando di invio (${outbox.error})`);
      await trigger(db, env, mission, outbox.reference_code);
      return mission;
    }
    if (outbox.status === 'in_coda' && waited > 20 * MINUTE) {
      if (outbox.trigger_count >= 2) return stop(db, env, mission, `l’automazione Gmail non ha inviato l’anteprima ${outbox.reference_code} dopo 2 tentativi`);
      await trigger(db, env, mission, outbox.reference_code);
    }
    return mission;
  }
  async function stepWaitingClient(db, env, mission) {
    const { approval, menu, draft } = await load(db, mission);
    const venue = menu.nome || 'pratica';
    if (!approval) return stop(db, env, mission, 'anteprima non trovata');
    // Nessuna risposta: il promemoria lo propone il giro mattutino (con il testo da approvare), non un avviso a ogni ora.
    if (approval.status === 'anteprima_inviata') return mission;
    if (approval.status !== 'risposta_ricevuta') return mission;
    const reply = String(approval.reply_text || '');
    if (reply.startsWith(PARTIAL_MARK)) return stop(db, env, mission, 'la risposta del locale è lunga o con allegati: leggila tu in Gmail');
    const assessment = assessReply(reply);
    const proposals = proposeReplyChanges(reply, menu);
    const changes = proposals.filter((entry) => entry.type !== 'manuale');
    // Frasi che Jarvis non sa tradurre in una modifica precisa: mai ignorarle in silenzio.
    // Restano innocue solo le conferme di cortesia ("perfetto così", "va benissimo").
    const doubts = proposals.filter((entry) => entry.type === 'manuale' && !HARMLESS.test(entry.source || ''));
    const quote = reply.trim().replace(/\s+/g, ' ').slice(0, 300);
    if (doubts.length) return stop(db, env, mission, `nella risposta del locale c’è qualcosa che non so applicare da solo: «${String(doubts[0].source).slice(0, 200)}»${doubts[0].note ? ` (${doubts[0].note})` : ''}`);
    if (assessment.suggestion === 'approvazione' && !changes.length) {
      const request = await getOne(db, 'SELECT kind,plan FROM requests WHERE id=?', mission.request_id);
      const activation = request.kind === 'nuovo' ? `\nAttivo: ${PLAN_LABEL[request.plan]} da oggi (${romeDate()}).` : '';
      const next = await move(db, mission, 'attesa_si', `Il locale ha approvato (rif. ${approval.reference_code}); attendo il SÌ di Riccardo.`);
      await tell(db, env, next, 'posso pubblicare?', `«${venue}» ha approvato l’anteprima (rif. ${approval.reference_code}).\nRisposta: «${quote}»${activation}\nPubblico il menu? Al tuo SÌ apro la PR, pubblico e verifico online.`,
        [['SÌ, pubblica', `pub:${mission.id}`], ['Non ancora', `no:${mission.id}`]], 'importante');
      return next;
    }
    const unclear = !changes.length || changes.some((entry) => !AUTO_CHANGES.has(entry.type));
    if (unclear) return stop(db, env, mission, `risposta del locale da valutare: «${quote}»`);
    if (mission.rounds >= MAX_ROUNDS) return stop(db, env, mission, `già ${MAX_ROUNDS} giri di modifiche: meglio che lo senta tu`);
    const jarvis = jarvisDb(db);
    try {
      await action(jarvis, 'decideClientReply', { id: approval.id, revision: approval.revision, decision: 'modifiche' }, env);
      const fresh = await getOne(db, 'SELECT * FROM drafts WHERE id=?', draft.id);
      await action(jarvis, 'applyReplyChanges', { draftId: fresh.id, revision: fresh.revision, accept: changes.map((entry) => entry.id) }, env);
      await attest(db, env, draft.id, `Modifiche scritte dal locale nella risposta rif. ${approval.reference_code}, applicate da Jarvis su mandato di Riccardo.`, jarvis);
    } catch (error) { return stop(db, env, mission, `non riesco ad applicare le modifiche (${String(error?.message || 'errore').slice(0, 200)})`); }
    const next = await move(db, mission, 'affidata', 'Modifiche applicate; preparo la nuova anteprima.', { rounds: mission.rounds + 1 });
    await tell(db, env, next, 'modifiche applicate', `«${venue}» ha chiesto modifiche e le ho applicate:\n- ${changes.map(describeChange).join('\n- ')}\nInvio la nuova anteprima al locale.`);
    return stepEntrusted(db, env, next);
  }
  async function stepPublishing(db, env, mission) {
    const jarvis = jarvisDb(db);
    let { draft, request } = await load(db, mission);
    const operation = await getOne(db, 'SELECT * FROM live_pr_operations WHERE draft_id=?', draft.id);
    try {
      if (!operation || operation.status === 'reserved') {
        const read = (await action(jarvis, 'githubReadMenu', { slug: draft.slug }, env)).result;
        if (request.kind === 'nuovo' && read.exists) return stop(db, env, mission, `esiste già un menu «${draft.slug}» sul sito: non lo sovrascrivo`);
        await action(jarvis, 'githubOpenPr', { draftId: draft.id, revision: draft.revision, requestRevision: request.revision,
          operationKey: `${draft.id}.r${draft.revision}`, expectedBaseSha: read.baseSha, expectedFileSha: read.exists ? read.sha : null,
          confirmation: 'CONFERMO APERTURA PR LIVE' }, env);
        ({ draft, request } = await load(db, mission));
      } else if (operation.status !== 'pr_open') {
        return stop(db, env, mission, `la PR è in uno stato da controllare (${operation.status})`);
      }
      await action(jarvis, 'githubMergePr', { draftId: draft.id, revision: draft.revision, requestRevision: request.revision, confirmation: 'CONFERMO MERGE MENU APPROVATO' }, env);
    } catch (error) {
      if (mission.attempts >= 8) return stop(db, env, mission, `pubblicazione non riuscita (${String(error?.message || 'errore').slice(0, 200)})`);
      await bump(db, mission, { note: `Nuovo tentativo: ${String(error?.message || 'errore').slice(0, 200)}` });
      return mission;
    }
    return move(db, mission, 'verifica', 'Menu unito a main: verifico la pubblicazione online.');
  }
  // Menu online: la scheda cliente si allinea (Menu ID, link, piano e prova/rinnovo dell'attivazione),
  // così Jarvis lo riconosce subito per gli aggiornamenti a voce e nel briefing.
  async function syncClientAfterPublish(db, draft, request, publicUrl) {
    const client = await getOne(db, 'SELECT * FROM clients WHERE id=?', request.client_id);
    if (!client || (client.menu_id && client.menu_id !== draft.slug)) return;
    const day = romeDate();
    const plus = (months) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString().slice(0, 10); };
    const plusDays = (n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const fresh = request.kind === 'nuovo' && ACTIVATION_BY_PLAN[request.plan];
    const plan = fresh ? request.plan : client.plan;
    const payment = !fresh ? client.payment_status : request.plan === 'standard' ? 'in_prova' : 'attivo';
    const trial = fresh && request.plan === 'standard' ? plusDays(30) : client.trial_ends_at;
    const renewal = fresh && request.plan === 'annuale' ? plus(12) : fresh && request.plan === 'premium' ? plus(1) : client.renewal_at;
    // Cliente arrivato via email senza nome del locale («Nuovo contatto email»): prende il nome del menu pubblicato.
    let published = ''; try { published = String(JSON.parse(draft.menu_json).nome || '').trim().slice(0, 140); } catch {}
    const name = /^nuovo contatto/i.test(client.name || '') && published ? published : client.name;
    await auditedBatch(jarvisDb(db), [db.prepare('UPDATE clients SET name=?,menu_id=?,menu_url=?,plan=?,payment_status=?,trial_ends_at=?,renewal_at=?,revision=revision+1,updated_at=? WHERE id=?')
      .bind(name, draft.slug, publicUrl || client.menu_url, plan, payment, trial, renewal, now(), client.id)],
    'client.publish_sync', `Scheda cliente aggiornata dopo la pubblicazione: menu ${draft.slug}${fresh ? `, piano ${PLAN_LABEL[request.plan]}` : ''}.`, request.id).catch(() => {});
    // Memoria: Jarvis ricorda com'è fatto il menu appena andato online.
    let menu = null; try { menu = JSON.parse(draft.menu_json); } catch {}
    if (menu) await db.batch(menuStatements(db, client.id, menu, `pubblicazione ${draft.slug}`)).catch(() => {});
  }
  // ——— QR del menu: dopo il SÌ e la verifica online, link e QR su Telegram ———
  // Standard: QR classico. Premium e Annuale: logo del locale al centro (se il logo si legge).
  const QR_WITH_LOGO = new Set(['premium', 'annuale']);
  async function makeMenuQr({ slug, name, plan, logoUrl, baseUrl }) {
    const wantsLogo = QR_WITH_LOGO.has(plan) && logoUrl;
    let absolute = '';
    try { absolute = wantsLogo ? new URL(logoUrl, baseUrl || menuLink(slug)).href : ''; } catch { absolute = ''; }
    return buildMenuQr({ slug, name, logoUrl: absolute, fetchImpl: deps.fetchImpl || globalThis.fetch });
  }
  async function sendMenuQr(db, env, { slug, name, plan, logoUrl, baseUrl, qr = null }) {
    qr = qr || await makeMenuQr({ slug, name, plan, logoUrl, baseUrl });
    const chat = await setting(db, 'telegram_chat_id');
    if (!chat || !telegramReady(env)) return { ok: false, why: 'Telegram non collegato', qr };
    const kind = qr.withLogo ? 'con il logo del locale' : 'classico';
    const note = QR_WITH_LOGO.has(plan) && !qr.withLogo ? `\nIl logo non l’ho potuto inserire (${qr.logoProblem || 'nessun logo nel menu'}): questo è il QR classico, dimmi se vuoi che lo rifaccia con il logo.` : '';
    await sendTelegram(env, chat, `QR del menu di «${name}» (${kind}).\nLink: ${qr.link}\nIl QR non cambia con gli aggiornamenti del menu: puoi stamparlo.${note}`, null, deps.fetchImpl);
    const slugName = String(slug).replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'menu';
    const photo = await sendPhoto(env, chat, qr.png, `QR ${name}`, deps.fetchImpl);
    await sendDocument(env, chat, qr.png, `qr-${slugName}.png`, 'image/png', 'Per stampare: file PNG a piena qualità.', deps.fetchImpl);
    await sendDocument(env, chat, qr.svg, `qr-${slugName}.svg`, 'image/svg+xml', 'Per la stampa professionale: file vettoriale SVG.', deps.fetchImpl);
    return { ok: Boolean(photo?.ok), withLogo: qr.withLogo, link: qr.link, qr };
  }
  // ——— Email al locale con link e QR (la spedisce l'automazione Gmail di renmenu1569, come l'anteprima) ———
  const INTERNAL_MAIL = /^(?:iuran56|renmenu1569)@gmail\.com$/i;
  const b64 = (bytes) => { let t = ''; for (let i = 0; i < bytes.length; i += 0x8000) t += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(t); };
  function onlineMailText(name, qr, slug) {
    const file = String(slug).replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'menu';
    return [
      'Buongiorno,', '',
      `il menu di «${name}» è online. Questo è il link da condividere con i vostri clienti:`, qr.link, '',
      `In allegato trovate il QR code del menu${qr.withLogo ? ', con il logo del locale al centro' : ''}:`,
      `- qr-${file}.png: per stamparlo o inviarlo dal telefono`,
      `- qr-${file}.svg: per la stampa professionale (cartelli, adesivi, tovagliette)`, '',
      'Il link e il QR non cambiano mai: quando il menu viene aggiornato, il QR resta lo stesso e non serve ristampare nulla.',
      'Per modificare prezzi, piatti o lingue basta rispondere a questa email.', '',
      'A presto,', 'Il Team RenMenu'
    ].join('\n');
  }
  async function triggerOnlineMail(db, env, code, requestId, attempt) {
    const sent = await sendOwnerNotification({ db: jarvisDb(db), env, requestId,
      subject: `${ONLINE_SUBJECT} ${code}`,
      text: `Comando interno di Jarvis per l'automazione Gmail di renmenu1569: invia l'email del menu online ${code} dalla coda di Jarvis. Tentativo ${attempt}. Nessun dato del cliente in questa email.`,
      priority: 'urgente', now: new Date(), fetchImpl: deps.fetchImpl });
    await db.prepare('UPDATE jarvis_outbox SET trigger_count=?,triggered_at=?,error=?,updated_at=? WHERE reference_code=?')
      .bind(attempt, now(), sent?.ok ? null : String(sent?.reason || sent?.code || 'TRIGGER_FAILED').slice(0, 120), now(), code).run();
  }
  async function queueOnlineEmail(db, env, { mission, request, draft, menu, qr }) {
    const to = String(request.client_email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) || INTERNAL_MAIL.test(to)) return { queued: false, why: 'il locale non ha un’email' };
    const approval = await getOne(db, 'SELECT id FROM publication_approvals WHERE draft_id=?', mission.draft_id);
    if (!approval) return { queued: false, why: 'approvazione non trovata' };
    const code = referenceCode(), stamp = now();
    const name = String(menu.nome || draft.slug).replace(/[\u0000-\u001f]/g, ' ').slice(0, 80);
    await putSetting(db, `outbox_qr_${code}`, JSON.stringify({ slug: draft.slug, png: b64(qr.png), svg: qr.svg }));
    await db.prepare("INSERT INTO jarvis_outbox (id,mission_id,request_id,approval_id,reference_code,recipient,subject,body,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'in_coda',?,?)")
      .bind(uid(), mission.id, mission.request_id, approval.id, code, to, `Il tuo menu RenMenu è online · ${name}`, onlineMailText(name, qr, draft.slug), stamp, stamp).run();
    await putSetting(db, `onlinemail_${code}`, JSON.stringify({ requestId: mission.request_id, name, to, at: stamp }));
    await triggerOnlineMail(db, env, code, mission.request_id, 1);
    return { queued: true, code, to };
  }
  // Ogni minuto: l'email è partita? Riprova il comando dopo 6 minuti (al massimo 3 volte), poi avvisa Riccardo.
  async function checkOnlineMails(db, env) {
    const pending = await rows(db, "SELECT key,value FROM jarvis_settings WHERE key LIKE 'onlinemail\\_%' ESCAPE '\\' LIMIT 10").catch(() => []);
    for (const row of pending) {
      let info; try { info = JSON.parse(row.value); } catch { await db.prepare('DELETE FROM jarvis_settings WHERE key=?').bind(row.key).run(); continue; }
      const code = row.key.slice('onlinemail_'.length);
      const outbox = await getOne(db, 'SELECT status,trigger_count,triggered_at,error FROM jarvis_outbox WHERE reference_code=?', code);
      const done = async (text) => {
        await db.prepare('DELETE FROM jarvis_settings WHERE key IN (?,?)').bind(row.key, `outbox_qr_${code}`).run();
        await tell(db, env, { request_id: info.requestId }, 'email del menu online', text, null, 'importante');
      };
      if (!outbox || outbox.status === 'annullata') { await db.prepare('DELETE FROM jarvis_settings WHERE key IN (?,?)').bind(row.key, `outbox_qr_${code}`).run(); continue; }
      if (outbox.status === 'inviata') { await done(`Email con link e QR di «${info.name}» inviata al locale (${info.to}).`); continue; }
      if (outbox.status === 'errore') { await done(`L’email con link e QR di «${info.name}» non è partita (${outbox.error || 'errore'}). Il QR l’hai su Telegram: inoltralo tu al locale (${info.to}).`); continue; }
      const waited = Date.now() - Date.parse(outbox.triggered_at || info.at);
      if (waited < 6 * 60_000) continue;
      if (outbox.trigger_count >= 3) { await db.prepare("UPDATE jarvis_outbox SET status='errore',error='NON_PARTITA',updated_at=? WHERE reference_code=? AND status='in_coda'").bind(now(), code).run(); await done(`L’email con link e QR di «${info.name}» non è partita dopo tre tentativi. Il QR l’hai su Telegram: inoltralo tu al locale (${info.to}).`); continue; }
      await triggerOnlineMail(db, env, code, info.requestId, outbox.trigger_count + 1);
    }
  }
  // «mandami il QR di …»: stesso QR di sempre (il link del menu non cambia), per i locali già online.
  async function qrOnRequest(db, env, chat, text) {
    const plain = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const said = plain(text).split(' ');
    const clients = await rows(db, "SELECT id,name,plan,menu_id FROM clients WHERE menu_id IS NOT NULL AND menu_id<>'' ORDER BY name LIMIT 200").catch(() => []);
    const generic = new Set(['osteria', 'trattoria', 'ristorante', 'bar', 'enoteca', 'pizzeria', 'locale', 'menu', 'del', 'della', 'dello', 'dei', 'di', 'da', 'al', 'il', 'la', 'le']);
    const hits = clients.filter((c) => plain(c.name).split(' ').some((w) => w.length >= 3 && !generic.has(w) && said.includes(w)));
    if (hits.length !== 1) {
      const names = (hits.length ? hits : clients).slice(0, 8).map((c) => `«${c.name}»`).join(', ');
      await sendTelegram(env, chat, hits.length ? `Quale locale? ${names}.` : (clients.length ? `Di quale locale vuoi il QR? Quelli già online: ${names}.` : 'Nessun menu è ancora online: il QR lo preparo dopo la pubblicazione.'), null, deps.fetchImpl);
      return;
    }
    const client = hits[0];
    if (isBlanchSlug(client.menu_id)) {
      // Menu in formato Blanch: il QR è quello già stampato e non si rigenera mai.
      await sendTelegram(env, chat, `Il QR di «${client.name}» è quello già stampato e non cambia mai.\nLink: ${publicMenuPageUrl('https://renmenu.pages.dev', client.menu_id)}\nFile del QR: https://renmenu.pages.dev/blanch/qr/trattoria-blanch-qr.png (PNG) e https://renmenu.pages.dev/blanch/qr/trattoria-blanch-qr.svg (SVG).`, null, deps.fetchImpl);
      return;
    }
    let menu = null;
    try { const r = await (deps.fetchImpl || globalThis.fetch)(`https://renmenu.pages.dev/menus/${encodeURIComponent(client.menu_id)}.json`); if (r.ok) menu = await r.json(); } catch { menu = null; }
    if (!menu) { await sendTelegram(env, chat, `Non riesco a leggere il menu online di «${client.name}»: riprova tra poco.`, null, deps.fetchImpl); return; }
    await sendMenuQr(db, env, { slug: client.menu_id, name: client.name, plan: client.plan, logoUrl: menu.premium?.logo || '', baseUrl: menuLink(client.menu_id) });
  }
  async function stepVerifying(db, env, mission) {
    if (Date.now() - Date.parse(mission.step_started_at) < 75_000) return mission;
    const { draft, request, menu } = await load(db, mission);
    try {
      const done = (await action(jarvisDb(db), 'githubVerifyPublication', { draftId: draft.id, revision: draft.revision, requestRevision: request.revision, confirmation: 'CONFERMO VERIFICA PUBBLICAZIONE' }, env)).result;
      await syncClientAfterPublish(db, draft, request, done.publicUrl);
      const next = await move(db, mission, 'completata', `Menu online e verificato: ${done.publicUrl}`);
      await watchRegister(db, mission, draft.slug, menu.nome, done.publicUrl).catch(() => null);
      await tell(db, env, next, 'menu online', `Fatto: «${menu.nome}» è online e verificato.\n${done.publicUrl}\nPR #${done.prNumber}.`, null, 'importante');
      // Menu nuovo: link e QR su Telegram e, se il locale ha un'email, anche a lui. Per un aggiornamento il QR resta quello già distribuito.
      if (request.kind === 'nuovo') {
        const info = { slug: draft.slug, name: menu.nome || draft.slug, plan: request.plan, logoUrl: menu.premium?.logo || '', baseUrl: done.publicUrl };
        const sentQr = await sendMenuQr(db, env, info).catch(() => null);
        if (!sentQr?.ok) await tell(db, env, next, 'QR del menu', `Non sono riuscito a mandarti il QR di «${info.name}». Scrivimi «mandami il QR di ${info.name}» e lo rifaccio.`, null, 'importante').catch(() => {});
        const qr = sentQr?.qr || await makeMenuQr(info).catch(() => null);
        const mail = qr ? await queueOnlineEmail(db, env, { mission, request, draft, menu, qr }).catch((error) => ({ queued: false, why: String(error?.message || 'errore').slice(0, 120) })) : { queued: false, why: 'QR non generato' };
        await tell(db, env, next, 'email del menu online', mail.queued
          ? `Sto mandando al locale (${mail.to}) l’email con link e QR in allegato: ti avviso appena parte.`
          : `Al locale non ho mandato l’email (${mail.why}). Link e QR li hai qui sopra: inoltrali tu a «${info.name}».`, null, 'importante').catch(() => {});
      }
      return next;
    } catch (error) {
      if (mission.attempts >= 15) return stop(db, env, mission, `il menu non risulta ancora online (${String(error?.message || 'errore').slice(0, 200)})`);
      await bump(db, mission);
      return mission;
    }
  }
  async function step(db, env, mission) {
    if (mission.status === 'affidata') return stepEntrusted(db, env, mission);
    if (mission.status === 'attesa_invio') return stepSending(db, env, mission);
    if (mission.status === 'attesa_cliente') return stepWaitingClient(db, env, mission);
    if (mission.status === 'pubblicazione') return stepPublishing(db, env, mission);
    if (mission.status === 'verifica') return stepVerifying(db, env, mission);
    return mission;
  }

  async function tick(db, env) {
    let missions;
    try { missions = await rows(db, "SELECT * FROM jarvis_missions WHERE status IN ('affidata','attesa_invio','attesa_cliente','pubblicazione','verifica') ORDER BY updated_at ASC LIMIT 5"); }
    catch (error) { if (/no such table/i.test(String(error?.message))) return []; throw error; }
    const out = [];
    for (const mission of missions) {
      try { const after = await step(db, env, mission); out.push({ id: mission.id, from: mission.status, to: after?.status }); }
      catch (error) { out.push({ id: mission.id, from: mission.status, error: error?.quiet ? 'concorrente' : String(error?.message || 'errore').slice(0, 160) }); }
    }
    return out;
  }

  // Risposta di Riccardo dai pulsanti Telegram (o dalla Control Room).
  async function decide(db, env, missionId, yes) {
    const mission = await getOne(db, 'SELECT * FROM jarvis_missions WHERE id=?', missionId);
    if (!mission || mission.status !== 'attesa_si') return { ok: false, text: 'Questa domanda non è più attiva.' };
    if (!yes) {
      await move(db, mission, 'ferma', 'Riccardo ha risposto «Non ancora»: pubblicazione sospesa.');
      return { ok: true, text: 'Va bene, non pubblico. La pratica resta ferma in Approvazioni.' };
    }
    let { approval, draft, request } = await load(db, mission);
    if (approval?.recipient === OWNER_REVIEW && approval.status === 'anteprima_inviata') {
      // L'approvazione è di Riccardo: il suo SÌ su Telegram è la risposta registrata.
      const stamp = now();
      await db.prepare("UPDATE publication_approvals SET status='risposta_ricevuta',reply_from='Riccardo (Telegram)',reply_text='Approvo: SÌ, pubblica.',reply_received_at=?,revision=revision+1,updated_at=? WHERE id=? AND status='anteprima_inviata'")
        .bind(stamp, stamp, approval.id).run();
      ({ approval, draft, request } = await load(db, mission));
    }
    if (approval?.status !== 'risposta_ricevuta' || approval.snapshot_sha !== await sha256Hex(draft.menu_json))
      return { ok: false, text: 'La bozza o la risposta sono cambiate: controlla in Approvazioni.' };
    const jarvis = jarvisDb(db);
    try {
      await action(jarvis, 'decideClientReply', { id: approval.id, revision: approval.revision, decision: 'approva' }, env);
      if (request.kind === 'nuovo') {
        const fresh = await getOne(db, 'SELECT * FROM publication_approvals WHERE id=?', approval.id);
        await action(jarvis, 'setActivation', { id: fresh.id, revision: fresh.revision, activation: ACTIVATION_BY_PLAN[request.plan], date: romeDate(),
          note: 'Confermata da Riccardo con il SÌ su Telegram.' }, env);
      }
    } catch (error) { await stop(db, env, mission, `non riesco a registrare l’approvazione (${String(error?.message || 'errore').slice(0, 200)})`); return { ok: false, text: 'Mi sono fermato: dettagli nel prossimo messaggio.' }; }
    const next = await move(db, mission, 'pubblicazione', 'SÌ di Riccardo ricevuto: apro la PR e pubblico.');
    await auditedBatch(jarvis, [], 'jarvis.publish_ok', 'Riccardo ha confermato la pubblicazione (SÌ su Telegram).', mission.request_id);
    const after = await stepPublishing(db, env, next);
    return { ok: true, text: after.status === 'verifica' ? 'Pubblicato. Verifico online tra un minuto e ti scrivo.' : 'Ricevuto: sto pubblicando, ti aggiorno.' };
  }

  async function telegramUpdate(db, env, update) {
    const chat = await setting(db, 'telegram_chat_id');
    if (update?.callback_query) {
      const query = update.callback_query, from = String(query.message?.chat?.id || '');
      if (!chat || from !== chat) return;
      const [verb, missionId, extra, arg4] = String(query.data || '').split(':');
      if (verb === 'chk') {
        if (query.message?.message_id) await clearButtons(env, chat, query.message.message_id, deps.fetchImpl);
        const outcome = missionId === 'end' ? await answerCheck(db, env, chat, -1, 'end') : await answerCheck(db, env, chat, Number(missionId), String(extra || ''));
        await answerCallback(env, query.id, outcome.text, deps.fetchImpl);
        if (!outcome.silent) await sendTelegram(env, chat, outcome.text, null, deps.fetchImpl);
        return;
      }
      if (verb === 'undo') {
        const outcome = await undoDraftEdit(db, env, missionId);
        await answerCallback(env, query.id, outcome.text, deps.fetchImpl);
        if (query.message?.message_id) await clearButtons(env, chat, query.message.message_id, deps.fetchImpl);
        await sendTelegram(env, chat, outcome.text, null, deps.fetchImpl);
        return;
      }
      if (verb === 'peek') {
        const found = (await rows(db, OPEN_DRAFTS).catch(() => [])).find((d) => d.id === missionId);
        const shown = found ? await showDraft(db, env, found) : { text: 'Quella bozza non è più aperta.' };
        await answerCallback(env, query.id, 'Ecco la bozza', deps.fetchImpl);
        await sendTelegram(env, chat, shown.text, shown.buttons || null, deps.fetchImpl);
        return;
      }
      if (verb === 'soll' || verb === 'sollno') {
        await answerCallback(env, query.id, verb === 'sollno' ? 'Aspetto ancora' : 'Lo metto in coda', deps.fetchImpl);
        if (query.message?.message_id) await clearButtons(env, chat, query.message.message_id, deps.fetchImpl);
        const out = verb === 'sollno' ? { text: 'Va bene, aspetto ancora: te lo riproporrò fra qualche giorno.' } : await runReminder(db, env, missionId);
        await sendTelegram(env, chat, out.text, null, deps.fetchImpl);
        return;
      }
      if (verb === 'affq' || verb === 'aff' || verb === 'affno') {
        await answerCallback(env, query.id, verb === 'affno' ? 'Ok, non affido' : 'Un attimo', deps.fetchImpl);
        if (query.message?.message_id && verb !== 'affq') await clearButtons(env, chat, query.message.message_id, deps.fetchImpl);
        const out = verb === 'affno' ? { text: 'Va bene, non affido niente: la pratica resta in Revisione.' }
          : verb === 'affq' ? await entrustBrief(db, env, missionId) : await runEntrust(db, env, missionId, Number(extra), String(arg4 || 'n'));
        await sendTelegram(env, chat, out.text, out.buttons || null, deps.fetchImpl, { stacked: true });
        return;
      }
      if (verb === 'del' || verb === 'delc' || verb === 'delno') {
        const outcome = verb === 'delno' ? { text: 'Va bene, non elimino niente.' } : await runDelete(db, env, verb === 'del' ? { requestId: missionId } : { clientId: missionId });
        await answerCallback(env, query.id, verb === 'delno' ? 'Non elimino' : 'Fatto', deps.fetchImpl);
        if (query.message?.message_id) await clearButtons(env, chat, query.message.message_id, deps.fetchImpl);
        await sendTelegram(env, chat, outcome.text, null, deps.fetchImpl);
        return;
      }
      const outcome = ['pub', 'no'].includes(verb) ? await decide(db, env, missionId, verb === 'pub')
        : verb === 'att' ? await attachTelegramFile(db, env, missionId) : verb === 'attno' ? (await putSetting(db, 'tg_pending_file', ''), { text: 'Va bene, la foto non viene usata.' }) : { text: 'Comando sconosciuto.' };
      await answerCallback(env, query.id, outcome.text, deps.fetchImpl);
      if (query.message?.message_id) await clearButtons(env, chat, query.message.message_id, deps.fetchImpl);
      await sendTelegram(env, chat, outcome.text, null, deps.fetchImpl);
      return;
    }
    const message = update?.message;
    if (message?.chat?.id && String(message.chat.id) === chat && (message.photo || message.document)) { await receiveTelegramFile(db, env, chat, message); return; }
    if (message?.chat?.id && String(message.chat.id) === chat && (message.voice || message.audio)) { await receiveVoice(db, env, chat, message); return; }
    if (!message?.chat?.id || typeof message.text !== 'string') return;
    const from = String(message.chat.id), text = message.text.trim();
    const start = /^\/start\s+([a-f0-9]{16,64})$/i.exec(text);
    if (start && message.chat.type === 'private') {
      const code = await setting(db, 'telegram_pair_code'), until = Date.parse(await setting(db, 'telegram_pair_until') || '');
      if (code && start[1] === code && Date.now() < until) {
        await putSetting(db, 'telegram_chat_id', from);
        await putSetting(db, 'telegram_pair_code', '');
        await auditedBatch(jarvisDb(db), [], 'jarvis.telegram_linked', 'Telegram collegato alla Control Room.', null);
        await sendTelegram(env, from, 'Ciao Riccardo, sono Jarvis. Da ora ti scrivo qui per le pratiche RenMenu e ti chiedo il SÌ prima di pubblicare. Scrivi /stato per il punto della situazione.', null, deps.fetchImpl);
      }
      return;
    }
    if (!chat || from !== chat) return;
    // Dubbi aperti: un prezzo scritto («7,50») risponde al dubbio in corso.
    if (normalizePrice(text)) {
      let open = null; try { open = JSON.parse(await setting(db, 'tg_checks') || 'null'); } catch {}
      if (open?.queue && open.k < open.queue.length) { const outcome = await answerCheck(db, env, chat, open.k, normalizePrice(text)); if (!outcome.silent) await sendTelegram(env, chat, outcome.text, null, deps.fetchImpl); return; }
    }
    if (/\bqr\b/i.test(text) && /\b(?:mand\w*|dammi|dai|gener\w*|invi\w*|rifai|prepar\w*|voglio|serve)\b/i.test(text) && !EDIT_WORDS_STRICT.test(text)) { await qrOnRequest(db, env, chat, text); return; }
    if (/^\/briefing\b/i.test(text)) { await briefing(db, env, { force: true }); return; }
    if (/^\/stato\b/i.test(text) || STATUS_WORDS.test(text)) {
      await sendTelegram(env, chat, await statusText(db), null, deps.fetchImpl);
      return;
    }
    if (/^\/aiuto\b|^\/help\b/i.test(text) || text.startsWith('/')) {
      await sendTelegram(env, chat, 'Puoi scrivermi o mandarmi un vocale: «com’è la situazione?», «al Bakaro il frico ora costa 14», «crea una nuova pratica per il locale … con piano Standard», «pubblica il menu di …». Capisco anche /stato, /briefing, le foto e i PDF dei menu. Pubblicare richiede sempre il tuo SÌ col pulsante.', null, deps.fetchImpl);
      return;
    }
    await converse(db, env, chat, text, false);
  }

  // ——— Conversazione (testo o voce) ———
  async function voiceSettings(db, env) {
    return { provider: await setting(db, 'voice_provider'), apiKey: await readSealedSetting(env, setting, putSetting, db, 'voice_api_key'), voiceId: await setting(db, 'voice_id') };
  }
  async function reply(db, env, chat, text, spoken, buttons = null) {
    // La trascrizione di ciò che ha detto Riccardo resta solo scritta: a voce Jarvis dice solo la risposta.
    const audio = spoken ? await speak(await voiceSettings(db, env), String(text).replace(/^«[\s\S]*?»\n\n/, ''), deps.fetchImpl) : null;
    if (audio && !buttons) { const sent = await sendVoice(env, chat, audio, text, deps.fetchImpl); if (sent?.ok) return; }
    if (audio && buttons) await sendVoice(env, chat, audio, '', deps.fetchImpl);
    await sendTelegram(env, chat, text, buttons, deps.fetchImpl);
  }
  async function receiveVoice(db, env, chat, message) {
    const media = message.voice || message.audio;
    if (Number(media.duration || 0) > 180) { await sendTelegram(env, chat, 'Il vocale è troppo lungo: tienilo sotto i 3 minuti.', null, deps.fetchImpl); return; }
    const file = await downloadTelegramFile(env, media.file_id, deps.fetchImpl);
    if (!file?.bytes?.length) { await sendTelegram(env, chat, 'Non riesco a scaricare il vocale da Telegram: riprova.', null, deps.fetchImpl); return; }
    const heard = await transcribe(env.AI, file.bytes);
    if (!heard.ok) { await sendTelegram(env, chat, `Perdona Riccardo, ${heard.reason}. Puoi ripetere?`, null, deps.fetchImpl); return; }
    if (STATUS_WORDS.test(heard.text.trim())) { await reply(db, env, chat, `«${heard.text.trim()}»\n\n${await statusText(db)}`, false); return; }
    await converse(db, env, chat, heard.text, true);
  }
  // Comprensione: locali (anche trascritti male) e piatti dei menu in memoria citati nel comando.
  async function readClues(db, utterance) {
    const all = await rows(db, 'SELECT id,name,menu_id FROM clients ORDER BY updated_at DESC LIMIT 200').catch(() => []);
    const menus = await rows(db, "SELECT m.client_id,m.text FROM venue_memory m WHERE m.kind='menu' AND m.archived_at IS NULL").catch(() => []);
    const locales = findLocales(utterance, all);
    const dishes = findDishes(utterance, menus.map((m) => ({ client: all.find((c) => c.id === m.client_id), summary: m.text })).filter((m) => m.client));
    return { all, locales, dishes, guess: guessIntent(utterance, { locales, dishes }) };
  }
  async function mentionedMemory(db, clues) {
    const online = clues.all.filter((c) => c.menu_id);
    const ids = [...new Set([...clues.locales, ...clues.dishes.map((d) => d.client), ...(online.length === 1 ? online : [])].map((c) => c.id))].slice(0, 2);
    const parts = [];
    for (const id of ids) { const client = clues.all.find((c) => c.id === id); parts.push(memoryContext(client, await memoryFor(db, id).catch(() => []))); }
    return parts.join('\n\n');
  }
  // Locale da usare: quello detto (se corrisponde) oppure l'unico riconosciuto da nome o piatti.
  function pickLocale(spoken, clues, list) {
    const named = spoken ? matchVenue(spoken, list) : { client: null, candidates: [] };
    if (named.client) return named;
    const ids = new Set(list.map((c) => c.id));
    const seen = [...new Map([...clues.locales, ...clues.dishes.map((d) => d.client)].filter((c) => ids.has(c.id)).map((c) => [c.id, c])).values()];
    return seen.length === 1 ? { client: list.find((c) => c.id === seen[0].id), candidates: [] } : { client: null, candidates: named.candidates.length ? named.candidates : seen };
  }
  async function voiceRemember(db, utterance, spokenVenue, clues) {
    const all = await rows(db, 'SELECT id,name,menu_id FROM clients ORDER BY name LIMIT 200');
    const found = pickLocale(spokenVenue, clues, all);
    const named = found.client;
    if (!named) return found.candidates.length > 1 ? `Più locali corrispondono: ${found.candidates.map((c) => c.name).join(', ')}. Di quale parliamo?` : 'Di quale locale devo ricordarlo, Riccardo?';
    const note = String(utterance).replace(/^\s*(?:ok\s+)?(?:jarvis[,\s]+)?(?:per favore\s+)?(?:ricorda(?:ti)?|memorizza|segna(?:ti)?|annota(?:ti)?)\s+(?:che\s+)?/i, '').trim();
    await auditedBatch(jarvisDb(db), [noteStatement(db, named.id, note || utterance, 'Telegram (Riccardo)')], 'memory.note', `Jarvis ricorda una nuova nota su ${named.name}.`, null);
    return `D’accordo, lo ricorderò per «${named.name}».`;
  }
  async function voiceContext(db, env, clues, history) {
    const brief = await buildBriefing(db, env, { fetchImpl: deps.fetchImpl }).catch(() => '');
    const clients = await rows(db, "SELECT name,menu_id,plan,trial_ends_at,renewal_at FROM clients WHERE menu_id IS NOT NULL AND menu_id<>'' ORDER BY name LIMIT 60").catch(() => []);
    const open = await rows(db, "SELECT subject,status FROM requests WHERE status NOT IN ('completata','archiviata','chiusa') ORDER BY updated_at DESC LIMIT 15").catch(() => []);
    const memory = await mentionedMemory(db, clues);
    const hints = hintsText(clues);
    const facts = `DATI CERTI DI ADESSO (valgono più della conversazione, che può essere superata: pratiche e clienti possono essere stati eliminati): pratiche aperte ${open.length ? open.map((r) => `${r.subject} [${r.status}]`).join('; ') : 'nessuna'}.\n\n`;
    return `${facts}${history ? `CONVERSAZIONE RECENTE (dal più vecchio, può essere superata):\n${history}\n\n` : ''}${hints ? `${hints}\n\n` : ''}${memory ? `${memory}\n\n` : ''}${brief}\n\nLocali con menu online: ${clients.map((c) => `${c.name} (menu ${c.menu_id}, piano ${c.plan}${c.trial_ends_at ? `, prova fino al ${String(c.trial_ends_at).slice(0, 10)}` : ''}${c.renewal_at ? `, rinnovo ${String(c.renewal_at).slice(0, 10)}` : ''})`).join('; ') || 'nessuno'}.\nPratiche aperte: ${open.map((r) => `${r.subject} [${r.status}]`).join('; ') || 'nessuna'}.`;
  }
  // Conversazione: ricorda gli ultimi scambi e, se Jarvis ha appena chiesto un chiarimento,
  // unisce la risposta di Riccardo al comando precedente (es. «cambia il frico a 12» → «quale locale?» → «Bakaro»).
  const PENDING_MINUTES = 10;
  const plainText = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-');
  const localeSaid = (venue, utterance) => {
    const said = `-${plainText(utterance)}-`;
    const key = plainText(venue).split('-').filter((w) => w.length > 2 && !['del', 'dell', 'della', 'dello', 'alla', 'allo', 'dal', 'per', 'menu', 'the'].includes(w));
    return key.length > 0 && key.some((w) => said.includes(`-${w}-`) || (w.length >= 6 && said.includes(`-${w.slice(0, 5)}`)));
  };
  async function converse(db, env, chat, said0, spoken) {
    const said = spoken ? `«${said0}»\n\n` : '';
    let pending = null; try { pending = JSON.parse(await setting(db, 'tg_pending') || 'null'); } catch {}
    const fresh = pending && Date.now() - Date.parse(pending.at) < PENDING_MINUTES * MINUTE;
    const utterance = fresh ? `${pending.text}\n${said0}` : said0;
    let history = []; try { history = JSON.parse(await setting(db, 'tg_history') || '[]').filter((h) => Date.now() - Date.parse(h.at) < 180 * MINUTE); } catch {}
    const clues = await readClues(db, utterance);
    const context = await voiceContext(db, env, clues, history.slice(-8).map((h) => `${h.who}: ${String(h.text).slice(0, 300)}`).join('\n'));
    const gem = await geminiFor(db, env);
    const understood = await understand(env.AI, utterance, context, { gemini: gem });
    if (understood.modelName) await putSetting(db, 'gemini_good', JSON.stringify([understood.modelName])).catch(() => {});
    // Se il modello non è sicuro (o risponde a parole a un ordine) ma le parole chiave indicano un compito chiaro, Jarvis procede.
    const fallbackUsed = (understood.intent === 'non_chiaro' || (understood.intent === 'risposta' && !fresh)) && !['non_chiaro', 'ambiguo', 'risposta'].includes(clues.guess.intent);
    const intent0 = fallbackUsed ? { ...understood, intent: clues.guess.intent, locale: understood.locale || clues.guess.locale } : understood;
    // Comando chiaro ma il modello è incerto, e c'è una bozza in primo piano: è una correzione di quella bozza.
    if (intent0.intent === 'non_chiaro' && !intent0.risposta && !/\?/.test(said0) && /\b(aggiung\w*|togli\w*|tolg\w*|rimuov\w*|elimin\w*|unisc\w*|unific\w*|cambia\w*|metti\w*|mett\w*|sposta\w*|rinomina\w*|chiama\w*|sostituisc\w*|modific\w*|scrivi|correggi\w*)\b/i.test(said0)) {
      let focus = null; try { focus = JSON.parse(await setting(db, 'tg_focus') || 'null'); } catch {}
      if (focus?.requestId && Date.now() - Date.parse(focus.at) < FOCUS_MINUTES * MINUTE) intent0.intent = 'aggiorna_menu';
    }
    // Un locale che il modello nomina ma che Riccardo non ha detto (per esempio «Bevande» preso per un locale) non conta: la frase resta sulla pratica in primo piano.
    const intent = intent0.locale && !localeSaid(intent0.locale, utterance) ? { ...intent0, locale: '' } : intent0;
    if (intent.intent === 'non_chiaro' && !intent.risposta && clues.guess.intent === 'ambiguo') {
      const venue = clues.locales[0]?.name || clues.dishes[0]?.client?.name;
      const dish = clues.dishes[0]?.dish?.name;
      intent.risposta = `Vuoi che modifichi ${dish ? `«${dish}» nel` : 'il'} menu di «${venue}», o ti serve un’informazione?`;
    }
    await auditedBatch(jarvisDb(db), [], 'jarvis.conversation', `Comando ${spoken ? 'vocale' : 'scritto'}: ${intent.intent}${intent.dettaglio ? `/${intent.dettaglio}` : ''} [${understood.engine || 'nessun modello'}]${fallbackUsed ? ' (da parole chiave)' : ''}${fresh ? ' (con chiarimento)' : ''}${understood.why ? ` (${understood.why})` : ''}.`, null).catch(() => {});
    const answer = async (text, buttons = null, { keep = true } = {}) => {
      const asks = keep && /\?\s*$/.test(String(text)) && !buttons;
      await putSetting(db, 'tg_pending', asks ? JSON.stringify({ text: utterance.slice(-1200), at: now() }) : 'null').catch(() => {});
      await putSetting(db, 'tg_history', JSON.stringify([...history, { who: 'Riccardo', text: said0.slice(0, 1200), at: now() }, { who: 'Jarvis', text: String(text).slice(0, 1200), at: now() }].slice(-16))).catch(() => {});
      await reply(db, env, chat, `${said}${text}`, spoken, buttons);
    };
    // Domande e conversazione libera: risponde il modello grande, con tutta la memoria della chat.
    // «Il piano è Standard» subito dopo aver aperto una pratica: vale per QUELLA pratica, non per un menu online.
    const planned = intent.intent === 'crea_pratica' ? null : await planForFocus(db, utterance, intent.locale);
    if (planned) { await answer(planned); return; }
    if (REREAD.test(said0)) { await answer(await voiceReread(db, env, intent.locale, utterance)); return; }
    if (PREPARE_DRAFT.test(said0) && !EDIT_WORDS.test(said0)) { const prepared = await voicePrepareDraft(db, env, utterance, intent.locale); if (prepared) { await answer(prepared); return; } }
    // Correzione dettata a una bozza aperta («le braciole costano 9»), anche se il modello l'ha presa per una domanda.
    if (['risposta', 'non_chiaro'].includes(intent.intent) && EDIT_WORDS.test(said0)) {
      const target = await draftTarget(db, intent.locale, clues, utterance).catch(() => null);
      if (target?.draft && draftMentions(target.draft, utterance)) { const edited = await voiceEditDraft(db, env, utterance, target.draft); await answer(edited.text, edited.buttons || null, { keep: edited.keep }); return; }
    }
    if (intent.intent === 'risposta' || (intent.intent === 'non_chiaro' && clues.guess.intent === 'non_chiaro')) {
      const talk = await freeChat(env.AI, { utterance: said0, context, history: fresh ? [...history, { who: 'Riccardo', text: pending.text }] : history, spoken });
      await auditedBatch(jarvisDb(db), [], 'jarvis.chat', `Conversazione libera: ${talk.ok ? (talk.model === CHAT_MODEL ? 'GPT-OSS 120B' : 'modello di riserva') : 'nessuna risposta'}.`, null).catch(() => {});
      const text = talk.ok ? talk.text : intent.risposta;
      if (text) { await answer(text, null, { keep: !talk.ok }); return; }
    }
    if (intent.intent === 'affida_pratica') { const asked = await voiceEntrust(db, env, intent.locale, clues, utterance); await answer(asked.text, asked.buttons || null, { keep: asked.keep === true }); return; }
    if (intent.intent === 'cancella_pratica') { const asked = await voiceDelete(db, env, intent.locale, clues, utterance); await answer(asked.text, asked.buttons || null, { keep: asked.keep === true }); return; }
    if (intent.intent === 'stato') { const report = await statusReport(db, env, intent.dettaglio || (/\b(dettagli\w*|complet\w*|report|resoconto|riepilogo|tutto)\b/i.test(said0) ? 'completo' : /buone\s+notizie|novit/i.test(said0) ? 'buone_notizie' : 'breve')); await answer(report.text, report.buttons || null, { keep: false }); return; }
    if (intent.intent === 'anteprima') { const shown = await voiceShowPreview(db, env, intent.locale, clues, utterance); await answer(shown.text, shown.buttons || null, { keep: shown.keep }); return; }
    if (intent.intent === 'pubblica') {
      const waiting = await rows(db, "SELECT m.id,d.menu_json,d.slug FROM jarvis_missions m JOIN drafts d ON d.id=m.draft_id WHERE m.status='attesa_si' ORDER BY m.updated_at DESC LIMIT 10");
      const named = waiting.map((m) => { let name = m.slug; try { name = JSON.parse(m.menu_json).nome || name; } catch {} return { ...m, name, menu_id: m.slug }; });
      const pick = intent.locale ? matchVenue(intent.locale, named).client : named.length === 1 ? named[0] : null;
      if (!named.length) { await answer('Al momento nessun menu aspetta il tuo SÌ, Riccardo.'); return; }
      if (!pick) { await answer(`Aspettano il tuo SÌ: ${named.map((m) => m.name).join(', ')}. Quale pubblico?`); return; }
      await answer(`«${pick.name}» è pronto. Per sicurezza la pubblicazione la confermi tu col pulsante.`, [['SÌ, pubblica', `pub:${pick.id}`], ['Non ancora', `no:${pick.id}`]]);
      return;
    }
    if (intent.intent === 'ricorda') { await answer(await voiceRemember(db, utterance, intent.locale, clues)); return; }
    if (intent.intent === 'crea_pratica') { await answer(await voiceCreate(db, utterance, intent.locale, intent.urgente === true || /\b(in\s+fretta|subito|urgent\w*|di\s+corsa)\b/i.test(said0))); return; }
    if (intent.intent === 'aggiorna_menu') {
      const target = await draftTarget(db, intent.locale, clues, utterance);
      if (target?.ask) { await answer(target.ask); return; }
      if (target?.draft) { const edited = await voiceEditDraft(db, env, utterance, target.draft); await answer(edited.text, edited.buttons || null, { keep: edited.keep }); return; }
      await answer(await voiceUpdate(db, env, utterance, intent.locale, clues));
      return;
    }
    await answer(intent.risposta || 'Non ho afferrato, Riccardo: di quale locale parliamo e cosa devo fare?');
  }
  // ——— Correzioni alla BOZZA in Revisione, dettate o scritte su Telegram ———
  async function geminiFor(db, env) {
    try {
      const key = await readSealedSetting(env, setting, putSetting, db, 'gemini_api_key');
      const models = JSON.parse(await setting(db, 'gemini_models') || '[]');
      let good = []; try { good = JSON.parse(await setting(db, 'gemini_good') || '[]'); } catch {}
      let bad = []; try { bad = JSON.parse(await setting(db, 'gemini_bad') || '[]'); } catch {}
      const chain = [...new Set([...good, ...models, ...GEMINI_PREFERRED])].filter((m) => good.includes(m) || !bad.includes(m));
      // Un modello che da poco risponde con errori o scade viene saltato per 10 minuti: meno attese a vuoto (se restano solo quelli, si provano tutti).
      let cool = {}; try { cool = JSON.parse(await setting(db, 'gemini_cool') || '{}'); } catch {}
      const live = chain.filter((m) => !(cool[m] > Date.now()));
      return key && chain.length ? { key, models: live.length ? live : chain, fetchImpl: deps.fetchImpl } : null;
    } catch { return null; }
  }
  const OPEN_DRAFTS = "SELECT d.id,d.request_id,d.slug,d.status,d.revision,d.menu_json,d.provenance_json,r.subject,c.id AS client_id,c.name AS client_name FROM drafts d JOIN requests r ON r.id=d.request_id LEFT JOIN clients c ON c.id=r.client_id WHERE d.status IN ('bozza','revisione','pronta_pr') AND r.status NOT IN ('completata','archiviata','chiusa') ORDER BY d.updated_at DESC LIMIT 20";
  const plainWords = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((w) => w.length >= 4);
  function draftMentions(draft, utterance) {
    const said = plainWords(utterance);
    let menu; try { menu = JSON.parse(draft.menu_json); } catch { return false; }
    return (menu.sezioni || []).some((section) => (section.voci || []).some((item) => plainWords(typeof item.nome === 'string' ? item.nome : item.nome?.it).some((w) => said.some((u) => u === w || (w.length >= 6 && u.length >= 5 && u.slice(0, 5) === w.slice(0, 5))))));
  }
  /** Quale bozza aperta riguarda il comando: null se il comando riguarda un menu già online. */
  async function draftTarget(db, spokenVenue, clues, utterance) {
    const drafts = await rows(db, OPEN_DRAFTS).catch(() => []);
    if (!drafts.length) return null;
    const named = drafts.map((d) => ({ id: d.id, name: d.client_name || '', menu_id: '' }));
    const bySpoken = spokenVenue ? matchVenue(spokenVenue, named) : { client: null, candidates: [] };
    const byClue = [...new Set(clues.locales.map((c) => c.id))].map((id) => drafts.find((d) => d.client_id === id)).filter(Boolean);
    if (bySpoken.client) return { draft: drafts.find((d) => d.id === bySpoken.client.id) };
    if (bySpoken.candidates.length > 1) return { ask: `Ci sono più bozze aperte che corrispondono: ${bySpoken.candidates.map((c) => `«${c.name}»`).join(', ')}. Di quale parliamo?` };
    if (byClue.length === 1) return { draft: byClue[0] };
    // Nessun locale nominato a voce: la pratica su cui Riccardo sta lavorando vince sui locali dedotti solo da parole comuni
    // («bevande», «caffè» compaiono in molti menu): così una frase senza nome non finisce su un altro locale.
    let focus = null; try { focus = JSON.parse(await setting(db, 'tg_focus') || 'null'); } catch {}
    if (!spokenVenue && focus?.requestId && Date.now() - Date.parse(focus.at) < FOCUS_MINUTES * MINUTE) { const inFocus = drafts.find((d) => d.request_id === focus.requestId); if (inFocus) return { draft: inFocus }; }
    if (spokenVenue || clues.locales.length) return null; // locale detto ma senza bozza aperta: menu già online
    const mentioned = drafts.filter((d) => draftMentions(d, utterance));
    if (clues.dishes.length) return null; // il piatto è in un menu online
    if (mentioned.length === 1) return { draft: mentioned[0] };
    if (mentioned.length > 1) return { ask: `Quel piatto compare in più bozze aperte: ${mentioned.map((d) => `«${d.client_name || d.subject}»`).join(', ')}. Di quale locale parliamo?` };
    return null;
  }
  /** Frasi che Jarvis non ha saputo applicare: restano nel registro, così si vedono i punti da migliorare. */
  async function noteMiss(db, utterance, reason, requestId = null) {
    try { await auditedBatch(jarvisDb(db), [], 'jarvis.not_understood', `«${String(utterance).replace(/\s+/g, ' ').slice(0, 220)}» → ${String(reason).replace(/\s+/g, ' ').slice(0, 260)}`, requestId); } catch { /* solo diagnostica */ }
  }
  async function voiceEditDraft(db, env, utterance, draft) {
    let menu; try { menu = JSON.parse(draft.menu_json); } catch { return { text: 'La bozza non si legge: aprila in Revisione.' }; }
    const name = draft.client_name || menu.nome || draft.subject || 'la bozza';
    const plan = await proposeOps({ ai: env.AI, gemini: await geminiFor(db, env), utterance, menu });
    // Quali modelli Gemini hanno risposto o no: gli assenti (404) non si riprovano, i guasti restano in /stato.
    if (plan.tries?.length) {
      try {
        const missing = plan.tries.filter((t) => t.status === 404).map((t) => t.model);
        const slow = plan.tries.filter((t) => [429, 500, 502, 503, 504, 'tempo scaduto'].includes(t.status)).map((t) => t.model);
        if (slow.length || plan.modelName) {
          let cool = {}; try { cool = JSON.parse(await setting(db, 'gemini_cool') || '{}'); } catch {}
          for (const m of slow) cool[m] = Date.now() + 10 * MINUTE;
          if (plan.modelName) delete cool[plan.modelName];
          for (const m of Object.keys(cool)) if (!(cool[m] > Date.now())) delete cool[m];
          await putSetting(db, 'gemini_cool', JSON.stringify(cool));
        }
        if (missing.length) { let bad = []; try { bad = JSON.parse(await setting(db, 'gemini_bad') || '[]'); } catch {} await putSetting(db, 'gemini_bad', JSON.stringify([...new Set([...bad, ...missing])].slice(0, 12))); }
        await auditedBatch(jarvisDb(db), [], 'jarvis.edit_models', `Correzione bozza: ${plan.model === 'gemini' ? `risposto ${plan.modelName}` : plan.unavailable ? 'nessun modello ha risposto' : 'ripiego su Cloudflare'}; tentativi Gemini falliti: ${plan.tries.map((t) => `${t.model} ${t.status}`).join(', ').slice(0, 300)}.`, null);
      } catch { /* solo diagnostica */ }
    }
    if (plan.modelName) await putSetting(db, 'gemini_good', JSON.stringify([plan.modelName])).catch(() => {});
    if (plan.unavailable) return { text: `Non riesco a interpretare la modifica adesso: i modelli non rispondono. Riprova tra qualche minuto, oppure correggi la bozza di «${name}» in Revisione.` };
    const checked = validateOps(plan.ops, menu, utterance);
    if (checked.problems.length) await noteMiss(db, utterance, checked.problems.slice(0, 3).join(' | '), draft.request_id);
    if (checked.problems.length) return { text: `Per la bozza di «${name}» non applico nulla, perché:\n${checked.problems.slice(0, 5).map((p) => `• ${p}`).join('\n')}\n\nRiscrivimi la correzione con i nomi e i prezzi precisi.` };
    if (!checked.ops.length) await noteMiss(db, utterance, plan.dubbio || 'nessuna modifica precisa', draft.request_id);
    if (!checked.ops.length) return { text: plan.dubbio ? plan.dubbio : `Non trovo una modifica precisa per la bozza di «${name}». Dimmi per esempio «le braciole costano 9» o «aggiungi il tiramisù a 5 euro nei dolci».`, keep: true };
    const snapshot = { draftId: draft.id, menu_json: draft.menu_json, provenance_json: draft.provenance_json, at: now() };
    let saved;
    try { saved = (await action(jarvisDb(db), 'editDraftOps', { id: draft.id, revision: draft.revision, ops: checked.ops, source: 'Riccardo (Telegram)' }, env)).result; }
    catch (error) { await noteMiss(db, utterance, String(error?.message || 'errore'), draft.request_id); return { text: `Non sono riuscito a modificare la bozza di «${name}»: ${String(error?.message || 'errore').slice(0, 200)}` }; }
    await putSetting(db, 'draft_undo', JSON.stringify({ ...snapshot, revision: saved.revision })).catch(() => {});
    // Chi lavora su una bozza continua a lavorarci: ogni correzione rinnova la pratica «in primo piano».
    await putSetting(db, 'tg_focus', JSON.stringify({ requestId: draft.request_id, subject: draft.subject || name, at: now() })).catch(() => {});
    // Memoria delle correzioni dettate: se Riccardo rifà la bozza, la Control Room le rimette al loro posto.
    try {
      const key = editLogKey(draft.request_id); let log = []; try { log = JSON.parse(await setting(db, key) || '[]'); } catch { log = []; }
      log.push({ at: now(), ops: checked.ops, fp: editFingerprints(menu, checked.ops) });
      await putSetting(db, key, JSON.stringify(log.slice(-60)));
    } catch { /* la correzione è già salvata: la memoria è solo un aiuto */ }
    // Un'anteprima già preparata vale solo per il contenuto esatto: dopo la modifica la missione in attesa si ferma, così nessun SÌ vecchio resta in giro.
    let paused = false;
    try {
      const waiting = await getOne(db, "SELECT id,revision FROM jarvis_missions WHERE draft_id=? AND status IN ('attesa_si','attesa_cliente','attesa_invio')", draft.id);
      if (waiting) {
        const stamp = now();
        await auditedBatch(jarvisDb(db), [db.prepare("UPDATE jarvis_missions SET status='annullata',note='Bozza modificata da Riccardo su Telegram: serve una nuova revisione e una nuova anteprima.',revision=revision+1,updated_at=? WHERE id=? AND revision=?").bind(stamp, waiting.id, waiting.revision),
          db.prepare("UPDATE jarvis_outbox SET status='annullata',updated_at=? WHERE mission_id=? AND status='in_coda'").bind(stamp, waiting.id)], 'jarvis.mission_paused', 'Missione fermata: la bozza è cambiata dopo l’anteprima.', draft.request_id);
        paused = true;
      }
    } catch { /* se non riesce, la pubblicazione resta comunque bloccata dal controllo sul contenuto */ }
    const english = saved.needsEnglish && (menu.lingue || []).includes('en');
    if (english) await putSetting(db, 'draft_translate', JSON.stringify({ draftId: draft.id, at: now() })).catch(() => {});
    return {
      text: `Fatto, bozza di «${name}» aggiornata:\n${checked.ops.length ? saved.summary.split(/(?<=\.)\s+/).map((line) => `• ${line}`).join('\n') : ''}\n\nLa trovi in Revisione. La checklist si è azzerata: va riconfermata prima dell’anteprima.${paused ? ' L’anteprima che avevo già preparato non vale più: ho fermato quella pratica, e dopo la revisione me la riaffidi da «Approva e affida a Jarvis».' : ''}${english ? ' L’inglese delle voci nuove lo preparo tra un minuto.' : ''}${paused ? '' : '\n\nProssimo passo: guarda la bozza e, se ti va bene, affidami la pratica: ti faccio il riepilogo da confermare qui.'}`,
      buttons: [['Annulla', `undo:${draft.id}`], ['Mostrami la bozza', `peek:${draft.id}`], ['Affida a Jarvis', `affq:${draft.id}`]]
    };
  }
  async function undoDraftEdit(db, env, draftId) {
    let saved = null; try { saved = JSON.parse(await setting(db, 'draft_undo') || 'null'); } catch {}
    if (!saved || saved.draftId !== draftId) return { text: 'Non c’è più nulla da annullare per questa bozza.' };
    const draft = await getOne(db, 'SELECT id,request_id,revision,status FROM drafts WHERE id=?', draftId);
    if (!draft) return { text: 'La bozza non esiste più.' };
    if (draft.revision !== saved.revision) return { text: 'Dopo la mia modifica la bozza è cambiata ancora: per non perdere lavoro non annullo. Correggila in Revisione, oppure dimmi la correzione.' };
    try {
      await action(jarvisDb(db), 'restoreDraftSnapshot', { id: draftId, revision: draft.revision, menu: JSON.parse(saved.menu_json), provenance: JSON.parse(saved.provenance_json || '[]') }, env);
    } catch (error) { return { text: `Non sono riuscito ad annullare: ${String(error?.message || 'errore').slice(0, 200)}` }; }
    await putSetting(db, 'draft_undo', 'null').catch(() => {});
    try {
      const key = editLogKey(draft.request_id); const log = JSON.parse(await setting(db, key) || '[]');
      if (Array.isArray(log) && log.length) { log.pop(); await putSetting(db, key, JSON.stringify(log)); }
    } catch { /* solo memoria */ }
    try { const q = JSON.parse(await setting(db, 'draft_translate') || 'null'); if (q?.draftId === draftId) await putSetting(db, 'draft_translate', 'null'); } catch {}
    return { text: 'Annullato: la bozza è tornata com’era prima della mia modifica.' };
  }
  /** Inglese delle voci aggiunte o cambiate a voce: lo prepara il giro dell'orologio. */
  async function translateAfterEdit(db, env) {
    let queued = null; try { queued = JSON.parse(await setting(db, 'draft_translate') || 'null'); } catch {}
    if (!queued?.draftId) return null;
    await putSetting(db, 'draft_translate', 'null');
    const draft = await getOne(db, "SELECT id,revision,status FROM drafts WHERE id=? AND status IN ('bozza','revisione','pronta_pr')", queued.draftId);
    if (!draft) return null;
    let undo = null; try { undo = JSON.parse(await setting(db, 'draft_undo') || 'null'); } catch {}
    let text;
    try {
      const out = (await action(jarvisDb(db), 'translateDraft', { id: draft.id, revision: draft.revision }, env)).result;
      if (undo?.draftId === draft.id && undo.revision === draft.revision) { const now2 = await getOne(db, 'SELECT revision FROM drafts WHERE id=?', draft.id); await putSetting(db, 'draft_undo', JSON.stringify({ ...undo, revision: now2.revision })); }
      text = `Inglese delle voci modificate pronto in bozza${out?.summary ? ` (${String(out.summary).slice(0, 120)})` : ''}. Resta una bozza automatica: la controlli tu.`;
    } catch (error) {
      if (/già l.inglese|niente da tradurre/i.test(String(error?.message))) return null;
      text = `Non sono riuscito a preparare l’inglese delle voci nuove (${String(error?.message || 'errore').slice(0, 120)}). Puoi farlo in Revisione con «Traduci».`;
    }
    const chat = await setting(db, 'telegram_chat_id');
    if (chat && telegramReady(env)) await sendTelegram(env, chat, text, null, deps.fetchImpl);
    return { text };
  }
  // «Jarvis, rileggi le foto»: rimette in coda tutti i file della pratica e li legge con le regole attuali.
  async function voiceReread(db, env, spokenVenue, utterance) {
    const open = await rows(db, "SELECT r.id,r.subject,c.name AS client_name FROM requests r LEFT JOIN clients c ON c.id=r.client_id WHERE r.status NOT IN ('completata','archiviata','chiusa') AND EXISTS (SELECT 1 FROM materials m WHERE m.request_id=r.id AND m.archived_at IS NULL AND m.processing_status IN ('letto_da_jarvis','non_leggibile','da_trascrivere') AND (m.mime='application/pdf' OR m.mime IN ('image/jpeg','image/png','image/webp'))) ORDER BY r.updated_at DESC LIMIT 10").catch(() => []);
    if (!open.length) return 'Non ci sono pratiche aperte con foto o PDF da rileggere.';
    let pick = null;
    const named = spokenVenue ? matchVenue(spokenVenue, open.map((r) => ({ id: r.id, name: r.client_name || r.subject || '', menu_id: '' }))) : { client: null, candidates: [] };
    if (named.client) pick = open.find((r) => r.id === named.client.id);
    if (!pick) { const said = String(utterance).toLowerCase(); const hit = open.filter((r) => r.client_name && said.includes(String(r.client_name).toLowerCase())); if (hit.length === 1) pick = hit[0]; }
    if (!pick) { let focus = null; try { focus = JSON.parse(await setting(db, 'tg_focus') || 'null'); } catch {} if (focus?.requestId && Date.now() - Date.parse(focus.at) < FOCUS_MINUTES * MINUTE) pick = open.find((r) => r.id === focus.requestId) || null; }
    if (!pick && open.length === 1) pick = open[0];
    if (!pick) return `Di quale pratica rileggo le foto? ${open.slice(0, 6).map((r) => `«${r.client_name || r.subject}»`).join(', ')}.`;
    let out;
    try { out = (await action(jarvisDb(db), 'rereadRequest', { requestId: pick.id }, env)).result; }
    catch (error) { return `Non sono riuscito a mettere in coda la rilettura: ${String(error?.message || 'errore').slice(0, 200)}`; }
    const untouched = out.draft && out.draft.status === 'bozza' && out.draft.revision === 1;
    const draft = !out.draft ? ' Quando ho finito preparo la bozza.' : untouched ? ' La bozza attuale, mai modificata, la rifaccio con le nuove letture.' : ' Hai già lavorato sulla bozza, quindi non la tocco: a lettura finita, in Revisione tocca «Rifai la bozza con tutti i materiali».';
    return `Rimetto in coda ${out.queued} file di «${pick.client_name || pick.subject}»: ne leggo uno al minuto e ti scrivo appena ho finito.${draft}`;
  }
  async function planForFocus(db, utterance, spokenVenue) {
    const plan = planFromText(utterance);
    if (!plan || String(utterance).split(/\s+/).length > 30) return null;
    if (/\b(?:cambia|aggiung|togli|rimuov|costa|prezzo|euro|€)/i.test(utterance)) return null;
    let focus = null;
    try { focus = JSON.parse(await setting(db, 'tg_focus') || 'null'); } catch {}
    if (!focus?.requestId || Date.now() - Date.parse(focus.at) >= FOCUS_MINUTES * MINUTE) return null;
    const request = await getOne(db, 'SELECT r.id,r.subject,r.plan,r.status,r.revision,r.kind,c.name AS client_name FROM requests r LEFT JOIN clients c ON c.id=r.client_id WHERE r.id=?', focus.requestId);
    if (!request || ['completata', 'archiviata', 'chiusa'].includes(request.status) || request.kind !== 'nuovo') return null;
    if (spokenVenue && !matchVenue(spokenVenue, [{ id: request.id, name: request.client_name || '', menu_id: '' }]).client) return null;
    const label = plan[0].toUpperCase() + plan.slice(1);
    if (request.plan === plan) return `Sì, la pratica «${request.subject}» è già sul piano ${label}.`;
    try {
      const subject = String(request.subject || '').replace(/^Nuovo menu (?:\(piano da definire\)|Standard|Annuale|Premium)/, `Nuovo menu ${label}`);
      await action(jarvisDb(db), 'updateRequest', { id: request.id, revision: request.revision, patch: { plan, category: `nuovo_${plan}`, subject } });
      return `Segnato, Riccardo: piano ${PLAN_LABEL[plan]} per la pratica «${subject}».`;
    } catch (error) {
      return `Non sono riuscito a segnare il piano: ${String(error?.message || 'errore').slice(0, 200)}`;
    }
  }

  // «Prepara la bozza» / «la bozza devi crearla per la chincaglieria»: vale per la pratica nominata (anche solo con una parte del nome)
  // o, senza nome, per quella in primo piano. Mai per un altro locale.
  const PREPARE_DRAFT = /\b(?:prepar\w*|cre[ai]\w*|gener\w*|fai|fammi|rifai|costruisc\w*)\b[^.?!]{0,40}\bbozza\b|\bbozza\b[^.?!]{0,30}\b(?:crear\w*|prepar\w*|gener\w*|far\w*)/i;
  async function voicePrepareDraft(db, env, utterance, spokenVenue) {
    const open = await rows(db, "SELECT r.id,r.subject,r.plan,r.kind,c.name AS client_name FROM requests r LEFT JOIN clients c ON c.id=r.client_id WHERE r.status NOT IN ('completata','archiviata','chiusa') AND r.kind='nuovo' ORDER BY r.created_at DESC LIMIT 20").catch(() => []);
    if (!open.length) return null;
    const plain = slugify(utterance);
    const named = open.map((r) => ({ id: r.id, name: r.client_name || '', menu_id: '' }));
    let request = null;
    if (spokenVenue) { const m = matchVenue(spokenVenue, named); if (m.client) request = open.find((r) => r.id === m.client.id); else if (m.candidates.length > 1) return `Ci sono più pratiche che corrispondono: ${m.candidates.map((c) => `«${c.name}»`).join(', ')}. Di quale preparo la bozza?`; }
    if (!request) {
      // Nome detto dentro la frase senza che il modello l'abbia isolato: parole distintive del cliente (almeno 6 lettere).
      const hit = open.filter((r) => slugify(r.client_name || '').split('-').some((w) => w.length >= 6 && plain.split('-').includes(w)));
      if (hit.length === 1) request = hit[0]; else if (hit.length > 1) return `Ci sono più pratiche che corrispondono: ${hit.map((r) => `«${r.client_name}»`).join(', ')}. Di quale preparo la bozza?`;
    }
    if (!request && !spokenVenue) {
      let focus = null; try { focus = JSON.parse(await setting(db, 'tg_focus') || 'null'); } catch {}
      if (focus?.requestId && Date.now() - Date.parse(focus.at) < FOCUS_MINUTES * MINUTE) request = open.find((r) => r.id === focus.requestId) || null;
      if (!request && open.length === 1) request = open[0];
    }
    if (!request) return spokenVenue ? null : `Per quale pratica preparo la bozza? Aperte: ${open.slice(0, 4).map((r) => `«${r.client_name || r.subject}»`).join(', ')}.`;
    const label = request.client_name || request.subject;
    await putSetting(db, 'tg_focus', JSON.stringify({ requestId: request.id, subject: request.subject || label, at: now() })).catch(() => {});
    const existing = await getOne(db, "SELECT id,status,revision FROM drafts WHERE request_id=? AND status IN ('bozza','revisione','pronta_pr')", request.id);
    if (existing) return `La bozza di «${label}» c’è già (versione ${existing.revision}): scrivimi «mostrami l’anteprima di ${label}» per vederla, oppure dimmi cosa correggere.`;
    const mats = await getOne(db, 'SELECT COUNT(*) AS n FROM materials WHERE request_id=? AND archived_at IS NULL', request.id);
    const read = await getOne(db, "SELECT COUNT(*) AS n FROM material_analyses a JOIN materials m ON m.id=a.material_id WHERE a.request_id=? AND m.archived_at IS NULL AND a.status IN ('complete','needs_review') AND length(a.source_text)>0", request.id);
    const unread = await getOne(db, "SELECT COUNT(*) AS n FROM materials m WHERE m.request_id=? AND m.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM material_analyses a WHERE a.material_id=m.id)", request.id);
    if (!(mats?.n > 0)) return `Per «${label}» non ho ancora nessun materiale (foto o PDF del menu): mandalo e preparo la bozza.`;
    if (unread?.n > 0) {
      await putSetting(db, 'draft_after_checks', JSON.stringify({ requestId: request.id, at: now() })).catch(() => {});
      return `Per «${label}» ho ancora ${unread.n} ${unread.n === 1 ? 'file' : 'file'} da leggere: preparo la bozza appena ho finito e ti scrivo.`;
    }
    if (!(read?.n > 0)) return `Per «${label}» non sono riuscito a leggere il materiale: rimandami le foto, più nitide, e riprovo.`;
    try {
      await action(jarvisDb(db), 'generateDraft', { requestId: request.id }, env);
      return `Bozza di «${label}» pronta, Riccardo, dalle ${read.n} ${read.n === 1 ? 'lettura' : 'letture'} del materiale. Scrivimi «mostrami l’anteprima di ${label}» per vederla: le voci dubbie restano da verificare e nulla è online.`;
    } catch (error) { return `Non sono riuscito a preparare la bozza di «${label}»: ${String(error?.message || 'errore').slice(0, 200)}`; }
  }

  // Nuova pratica a voce: cliente (esistente o nuovo) + pratica «nuovo menu». Le foto e i PDF che
  // Riccardo manda nell'ora successiva si collegano da soli a questa pratica.
  const FOCUS_MINUTES = 60;
  // ——— Controllo dopo la pubblicazione: dopo 6 ore, 2 giorni e 7 giorni Jarvis rilegge il menu online. Tace se va tutto bene ———
  const WATCH_AFTER_HOURS = [6, 48, 168];
  const PUBLIC_ORIGIN = 'https://renmenu.pages.dev';
  async function readPublic(slug) {
    const get = async (url, json) => {
      let response;
      try { response = await deps.fetchImpl(url, { redirect: 'manual', headers: json ? { Accept: 'application/json' } : {}, signal: AbortSignal.timeout(8000) }); }
      catch { return { ok: false, why: 'non raggiungibile' }; }
      if (response.status !== 200) return { ok: false, why: `risponde HTTP ${response.status}` };
      const body = await response.text().catch(() => '');
      return { ok: true, body };
    };
    const menuJson = await get(publicMenuJsonUrl(PUBLIC_ORIGIN, slug), true);
    const page = await get(publicMenuPageUrl(PUBLIC_ORIGIN, slug), false);
    let sha = null, id = null;
    if (menuJson.ok) { try { const parsed = JSON.parse(menuJson.body); id = parsed?.id ?? (isBlanchSlug(slug) && parsed?.name ? slug : null); sha = await sha256Hex(JSON.stringify(parsed)); } catch { menuJson.ok = false; menuJson.why = 'non è un JSON valido'; } }
    return { menuJson, page, sha, id };
  }
  async function watchRegister(db, mission, slug, name, url) {
    const seen = await readPublic(slug);
    const first = Date.now() + WATCH_AFTER_HOURS[0] * 3600_000;
    await putSetting(db, `watch_${mission.id}`, JSON.stringify({ requestId: mission.request_id, slug, name: String(name || slug).slice(0, 80), url, sha: seen.sha, step: 0, fails: 0, next: new Date(first).toISOString() }));
  }
  async function watchTick(db, env) {
    await checkOnlineMails(db, env).catch(() => null);
    const due = await rows(db, "SELECT key,value FROM jarvis_settings WHERE key LIKE 'watch\\_%' ESCAPE '\\' LIMIT 20").catch(() => []);
    const out = [];
    for (const row of due) {
      let watch; try { watch = JSON.parse(row.value); } catch { continue; }
      if (!watch?.next || Date.parse(watch.next) > Date.now()) continue;
      if (out.length >= 2) break;
      const seen = await readPublic(watch.slug);
      const problems = [];
      if (!seen.menuJson.ok) problems.push(`il file del menu ${seen.menuJson.why}`);
      else if (seen.id !== watch.slug) problems.push('il file del menu non ha più l’identificativo giusto');
      else if (watch.sha && seen.sha !== watch.sha) problems.push('il contenuto del menu online è diverso da quello che ho pubblicato');
      if (!seen.page.ok) problems.push(`la pagina del menu (quella del QR) ${seen.page.why}`);
      if (problems.length) {
        const fails = (watch.fails || 0) + 1;
        if (fails >= 2) {
          await tell(db, env, { request_id: watch.requestId }, 'controllo dopo la pubblicazione', `Attenzione, Riccardo: controllando «${watch.name}» dopo la pubblicazione ho trovato un problema: ${problems.join('; ')}.\nPagina del QR: ${watch.url || publicMenuPageUrl(PUBLIC_ORIGIN, watch.slug)}\nNon tocco niente: dimmi tu come procedere.`, null, 'importante');
          await putSetting(db, row.key, JSON.stringify({ ...watch, fails: 0, next: new Date(Date.now() + 6 * 3600_000).toISOString() }));
        } else await putSetting(db, row.key, JSON.stringify({ ...watch, fails, next: new Date(Date.now() + 10 * 60_000).toISOString() }));
        out.push({ watch: watch.slug, ok: false });
        continue;
      }
      const step = (watch.step || 0) + 1;
      if (step >= WATCH_AFTER_HOURS.length) await db.prepare('DELETE FROM jarvis_settings WHERE key=?').bind(row.key).run();
      else await putSetting(db, row.key, JSON.stringify({ ...watch, sha: watch.sha || seen.sha, step, fails: 0, next: new Date(Date.now() + (WATCH_AFTER_HOURS[step] - WATCH_AFTER_HOURS[step - 1]) * 3600_000).toISOString() }));
      out.push({ watch: watch.slug, ok: true, last: step >= WATCH_AFTER_HOURS.length });
    }
    return out;
  }
  // ——— Giro mattutino con proposte (dopo il briefing delle 8) e solleciti: Jarvis propone, tu tocchi ———
  const DAY_MS = 86_400_000;
  const reminderDraft = (venue, approval) => ({
    subject: `Promemoria: anteprima del vostro menu digitale RenMenu · rif. ${approval.reference_code}`,
    body: ['Buongiorno,', '', `vi scrivo per sapere se avete avuto modo di guardare l’anteprima del menu digitale di ${venue}:`, approval.preview_url || '', '',
      'Se è tutto corretto, rispondete a questa email scrivendo «Approvo». Se qualcosa va cambiato, indicatelo nella risposta e prepariamo una nuova anteprima.', '', 'Grazie,', 'Riccardo · RenMenu', '', `Riferimento anteprima: ${approval.reference_code}`].join('\n')
  });
  async function morningProposals(db, env) {
    const chat = await setting(db, 'telegram_chat_id');
    if (!chat || !telegramReady(env)) return [];
    const items = [];
    const safe = (sql, ...args) => Promise.resolve().then(() => rows(db, sql, ...args)).catch(() => []);
    const missionRows = await safe("SELECT m.id,m.status,m.note,m.request_id,m.draft_id,m.reminded_at,m.attempts,m.revision,m.step_started_at,d.menu_json,d.slug FROM jarvis_missions m JOIN drafts d ON d.id=m.draft_id WHERE m.status IN ('attesa_si','ferma','attesa_cliente')");
    const nameOf = (row) => { try { return JSON.parse(row.menu_json).nome || row.slug; } catch { return row.slug; } };
    for (const m of missionRows.filter((x) => x.status === 'attesa_si')) {
      const approval = await Promise.resolve().then(() => getOne(db, 'SELECT snapshot_sha FROM publication_approvals WHERE draft_id=?', m.draft_id)).catch(() => null);
      const stale = approval?.snapshot_sha && approval.snapshot_sha !== await sha256Hex(m.menu_json);
      items.push(stale ? { text: `«${nameOf(m)}»: la bozza è cambiata dopo l’anteprima, il SÌ non vale più. Guardala e riaffidamela.`, buttons: [['Mostrami la bozza', `peek:${m.draft_id}`], ['Affida a Jarvis', `affq:${m.draft_id}`]] }
        : { text: `«${nameOf(m)}» aspetta il tuo SÌ per la pubblicazione. Vuoi che pubblichi?`, buttons: [['SÌ, pubblica', `pub:${m.id}`], ['Non ancora', `no:${m.id}`]] });
    }
    for (const m of missionRows.filter((x) => x.status === 'attesa_cliente')) {
      const approval = await Promise.resolve().then(() => getOne(db, "SELECT * FROM publication_approvals WHERE draft_id=? AND status='anteprima_inviata' AND sent_at IS NOT NULL", m.draft_id)).catch(() => null);
      if (!approval) continue;
      const done = await Promise.resolve().then(() => getOne(db, "SELECT COUNT(*) AS n FROM jarvis_outbox WHERE mission_id=? AND status='inviata' AND subject LIKE 'Promemoria:%'", m.id)).catch(() => ({ n: 0 }));
      const anchor = Math.max(Date.parse(approval.sent_at) || 0, Date.parse(m.reminded_at || '') || 0);
      const wait = m.reminded_at ? 4 * DAY_MS : 3 * DAY_MS;
      if (Number(done?.n) >= 2 || m.attempts >= 3 || Date.now() - anchor < wait) continue;
      const mail = reminderDraft(nameOf(m), approval);
      const days = Math.floor((Date.now() - Date.parse(approval.sent_at)) / DAY_MS);
      await db.prepare('UPDATE jarvis_missions SET attempts=attempts+1,reminded_at=?,updated_at=? WHERE id=? AND revision=?').bind(now(), now(), m.id, m.revision).run();
      items.push({ text: `«${nameOf(m)}» non ha risposto all’anteprima da ${days} giorni. Ti propongo questo promemoria, da renmenu1569:\n\n«${mail.body.split('\n').slice(0, 6).join(' ').replace(/\s+/g, ' ')}»\n\nLo mando solo se tocchi il pulsante.`, buttons: [['Manda il promemoria', `soll:${m.id}`], ['Aspetto ancora', 'sollno:x']] });
    }
    for (const m of missionRows.filter((x) => x.status === 'ferma')) items.push({ text: `«${nameOf(m)}» è ferma${m.note ? `: ${String(m.note).slice(0, 200)}` : ''}. Guardala e, se vuoi riprendere, riaffidamela.`, buttons: [['Mostrami la bozza', `peek:${m.draft_id}`], ['Affida a Jarvis', `affq:${m.draft_id}`]] });
    const followed = new Set((await safe('SELECT request_id FROM jarvis_missions')).map((x) => x.request_id));
    for (const d of (await safe(OPEN_DRAFTS)).filter((x) => !followed.has(x.request_id))) items.push({ text: `«${d.client_name || d.subject}»: la bozza è pronta da guardare. Se ti va bene, affidamela.`, buttons: [['Mostrami la bozza', `peek:${d.id}`], ['Affida a Jarvis', `affq:${d.id}`]] });
    const sent = items.slice(0, 5);
    for (const [i, item] of sent.entries()) await sendTelegram(env, chat, `${i === 0 ? `Da decidere stamattina (${sent.length}${items.length > sent.length ? ` di ${items.length}` : ''}):\n\n` : ''}${item.text}`, item.buttons, deps.fetchImpl, { stacked: true });
    return sent;
  }
  async function runReminder(db, env, missionId) {
    const mission = await getOne(db, 'SELECT * FROM jarvis_missions WHERE id=?', missionId);
    if (!mission || mission.status !== 'attesa_cliente') return { text: 'Il promemoria non serve più: la pratica è cambiata.' };
    const approval = await getOne(db, "SELECT * FROM publication_approvals WHERE draft_id=? AND status='anteprima_inviata'", mission.draft_id);
    if (!approval) return { text: 'Il locale ha già risposto: non mando il promemoria.' };
    const last = await getOne(db, 'SELECT recipient FROM jarvis_outbox WHERE mission_id=? AND recipient NOT LIKE ? ORDER BY created_at DESC LIMIT 1', mission.id, 'telegram:%');
    const recipient = last?.recipient || (approval.recipient && !String(approval.recipient).startsWith('telegram:') ? approval.recipient : null);
    if (!recipient) return { text: 'Non ho l’indirizzo del locale: il promemoria non parte.' };
    const venue = await venueOf(db, mission), mail = reminderDraft(venue, approval), stamp = now(), code = referenceCode();
    await db.prepare("UPDATE jarvis_outbox SET status='annullata',updated_at=? WHERE mission_id=? AND status='in_coda'").bind(stamp, mission.id).run();
    await db.prepare("INSERT INTO jarvis_outbox (id,mission_id,request_id,approval_id,reference_code,recipient,subject,body,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'in_coda',?,?)")
      .bind(uid(), mission.id, mission.request_id, approval.id, code, recipient, mail.subject, mail.body, stamp, stamp).run();
    const next = await move(db, mission, 'attesa_invio', `Promemoria ${code} in coda per Gmail.`);
    await trigger(db, env, next, code);
    return { text: `Fatto: il promemoria per «${venue}» è in coda e parte da renmenu1569 a minuti. Ti scrivo quando è inviato.` };
  }
  // ——— «Affido a Jarvis» da Telegram: riepilogo da confermare con un tocco (stessa conferma della Control Room) ———
  async function voiceEntrust(db, env, spokenVenue, clues, utterance) {
    const drafts = await rows(db, OPEN_DRAFTS).catch(() => []);
    const target = await draftTarget(db, spokenVenue, clues, utterance).catch(() => null);
    if (target?.ask) return { text: target.ask };
    let draft = target?.draft || null;
    if (!draft && !spokenVenue && !clues.locales.length) {
      if (drafts.length === 1) draft = drafts[0];
      else return { text: drafts.length ? `Quale pratica affido? Ho queste bozze aperte: ${drafts.map((d) => `«${d.client_name || d.subject}»`).join(', ')}.` : 'Non ho bozze da affidare, Riccardo.' };
    }
    if (!draft) return { text: `Non trovo una bozza aperta per «${spokenVenue || 'quel locale'}». Dimmi il nome esatto del locale.` };
    return entrustBrief(db, env, draft.id);
  }
  async function entrustBrief(db, env, draftId) {
    const draft = await getOne(db, 'SELECT d.id,d.request_id,d.status,d.revision,d.menu_json,d.checks_json,d.provenance_json FROM drafts d WHERE d.id=?', draftId);
    if (!draft || !['bozza', 'revisione', 'pronta_pr'].includes(draft.status)) return { text: 'Quella bozza non è più aperta.' };
    const request = await getOne(db, 'SELECT r.id,r.plan,r.kind,r.subject,r.source_text,c.email AS client_email,c.name AS client_name FROM requests r JOIN clients c ON c.id=r.client_id WHERE r.id=?', draft.request_id);
    if (['completata', 'archiviata', 'chiusa'].includes(request?.status)) return { text: 'Questa pratica è chiusa: per modificare un menu online serve una pratica di aggiornamento.' };
    const mission = await Promise.resolve().then(() => getOne(db, 'SELECT status FROM jarvis_missions WHERE request_id=?', draft.request_id)).catch(() => null);
    if (mission && ACTIVE.includes(mission.status)) return { text: `Jarvis sta già seguendo «${request.client_name}» (stato: ${mission.status.replace(/_/g, ' ')}).` };
    if (request.kind === 'nuovo' && !ACTIVATION_BY_PLAN[request.plan]) return { text: `Il piano di «${request.client_name}» non è confermato: dimmi se è Standard, Annuale o Premium (da Control Room, scheda cliente) e poi riprovo.` };
    let menu, saved = {}; try { menu = JSON.parse(draft.menu_json); } catch { return { text: 'La bozza non si legge: aprila in Revisione.' }; }
    try { saved = JSON.parse(draft.checks_json || '{}') || {}; } catch { saved = {}; }
    const note = 'Riepilogo su Telegram: prezzi, allergeni e lingue controllati da Riccardo.';
    const probe = { prices: true, allergens: true, languages: true, clientApproval: false, allergenOmissionConfirmed: true, fieldEvidence: { prices: note, allergens: note, languages: note }, ...(saved.creativeApproval === true ? { creativeApproval: true, creativeApprovalEvidence: saved.creativeApprovalEvidence } : {}) };
    const { issues, missing } = reviewIssues(menu, probe, request.plan);
    const blockers = issues.filter((issue) => !/checklist contiene conferme/i.test(issue));
    const items = (menu.sezioni || []).reduce((t, section) => t + (section.voci || []).length, 0);
    const link = await peekUrl(db, env, draft.id);
    if (blockers.length) return { text: `Non posso ancora affidare «${request.client_name}»: ${blockers.slice(0, 3).join(' ')}\n\nGuarda la bozza: ${link}`, buttons: [['Mostrami la bozza', `peek:${draft.id}`]] };
    const extras = allExtras(request.source_text, menu).filter((entry) => !entry.legend);
    let english = 0; try { english = JSON.parse(draft.provenance_json || '[]').filter((entry) => String(entry.path).endsWith('.en')).length; } catch {}
    const lines = [`Riepilogo per affidare «${request.client_name}» (versione ${draft.revision}, ${items} voci).`, '',
      'Con il tuo tocco confermi di aver controllato prezzi, allergeni e lingue:',
      `- Prezzi: ${items - missing.pricesMissing.length} voci su ${items} hanno il prezzo.`,
      `- Allergeni: ${missing.allergensMissing.length ? `${missing.allergensMissing.length} voci non ne indicano: restano senza, non li invento.` : 'tutte le voci li indicano.'}`,
      `- Lingue: ${english ? `${english} testi in inglese tradotti da me (bozza, da verificare).` : 'nessuna traduzione automatica da verificare.'}`];
    if (extras.length) lines.push(`- Dati scritti dal locale non ancora nel menu: ${extras.slice(0, 5).map((entry) => (entry.type === 'coperto' ? `coperto € ${entry.value}` : `allergeni di ${entry.name}: ${entry.label}`)).join('; ')}.`);
    lines.push('', `Guarda la bozza: ${link}`, '', request.client_email ? `Poi preparo l'anteprima e la mando a ${request.client_email}.` : 'Il locale non ha email: l’anteprima la approvi tu qui su Telegram.', 'Pubblico solo dopo il tuo SÌ.');
    return { text: lines.join('\n'), buttons: [...(extras.length ? [['Sì, affida e inserisci i dati del locale', `aff:${draft.id}:${draft.revision}:x`], ['Sì, affida senza quei dati', `aff:${draft.id}:${draft.revision}:n`]] : [['Sì, affida a Jarvis', `aff:${draft.id}:${draft.revision}:n`]]), ['Non ancora', 'affno:x']] };
  }
  async function runEntrust(db, env, draftId, revision, mode) {
    const draft = await getOne(db, 'SELECT id,request_id,revision,status FROM drafts WHERE id=?', draftId);
    if (!draft) return { text: 'Quella bozza non esiste più.' };
    if (draft.revision !== revision) { const again = await entrustBrief(db, env, draftId); return { text: `La bozza è cambiata dopo il riepilogo che hai visto: non affido niente. Ecco quello aggiornato.\n\n${again.text}`, buttons: again.buttons }; }
    const request = await getOne(db, 'SELECT r.source_text,r.subject,c.email AS client_email,c.name AS client_name FROM requests r JOIN clients c ON c.id=r.client_id WHERE r.id=?', draft.request_id);
    let accept = [];
    if (mode === 'x') { try { accept = allExtras(request.source_text, JSON.parse((await getOne(db, 'SELECT menu_json FROM drafts WHERE id=?', draftId)).menu_json)).filter((entry) => !entry.legend).map((entry) => entry.id); } catch { accept = []; } }
    try { await entrust(db, env, { draftId, revision, accept, confirmation: 'AFFIDO A JARVIS' }); }
    catch (error) { return { text: `Non riesco ad affidarla: ${String(error?.message || 'errore').slice(0, 220)}` }; }
    return { text: `Fatto, Riccardo: «${request.client_name}» è affidata a Jarvis.${request.client_email ? ` Preparo l'anteprima per ${request.client_email} e ti scrivo quando risponde.` : ' Ti mando qui l’anteprima da approvare.'} Pubblico solo con il tuo SÌ.` };
  }
  // ——— «Elimina la pratica di X»: Jarvis propone, Riccardo conferma col pulsante, poi si cancella ———
  async function voiceDelete(db, env, spokenVenue, clues, utterance) {
    const open = await rows(db, "SELECT r.id,r.subject,r.status,r.updated_at,c.id AS client_id,c.name FROM requests r JOIN clients c ON c.id=r.client_id WHERE r.status<>'completata' ORDER BY r.updated_at DESC LIMIT 80").catch(() => []);
    const clients = (await rows(db, 'SELECT id,name,menu_id FROM clients ORDER BY updated_at DESC LIMIT 300').catch(() => [])).map((c) => ({ ...c, menu_id: c.menu_id || '' }));
    let ids = [];
    if (spokenVenue || clues.locales.length) {
      const named = spokenVenue ? matchVenue(spokenVenue, clients) : { client: null, candidates: [] };
      ids = named.client ? [named.client.id] : named.candidates.length ? named.candidates.map((c) => c.id) : [...new Set(clues.locales.map((c) => c.id))];
      if (!ids.length) return { text: `Non trovo un cliente che si chiami «${spokenVenue}». Dimmi il nome esatto del locale.` };
    } else if (open.length === 1) ids = [open[0].client_id];
    else return { text: open.length ? `Quale pratica elimino? Ho aperte: ${open.slice(0, 8).map((r) => `«${r.name}»`).join(', ')}.` : 'Non ci sono pratiche aperte da eliminare, Riccardo.' };
    if (ids.length > 1) return { text: `Ci sono più clienti simili: ${ids.map((id) => `«${clients.find((c) => c.id === id)?.name}»`).join(', ')}. Quale elimino?` };
    const client = clients.find((c) => c.id === ids[0]);
    const requests = open.filter((r) => r.client_id === client.id);
    if (requests.length > 1) return { text: `«${client.name}» ha ${requests.length} pratiche aperte: ${requests.map((r) => `«${r.subject}»`).join(', ')}. Dimmi quale elimino, per esempio con le parole del titolo.` };
    const target = requests[0] ? { requestId: requests[0].id } : { clientId: client.id };
    const plan = await deletionPlan(db, { getOne, rows }, target);
    const label = plan.request?.subject || `cliente «${client.name}»`;
    if (!plan.ok) return { text: `Non elimino «${label}»: ${plan.blockers[0]}` };
    const parts = [];
    if (plan.drafts.length) { let items = 0; try { items = (JSON.parse(plan.drafts[0].menu_json).sezioni || []).reduce((t, section) => t + (section.voci || []).length, 0); } catch {} parts.push(`la bozza (versione ${plan.drafts[0].revision}${items ? `, ${items} voci` : ''})`); }
    if (plan.materials.length) parts.push(`${plan.materials.length} ${plan.materials.length === 1 ? 'file caricato' : 'file caricati'}`);
    const clientLine = plan.deleteClient ? `Elimino anche il cliente «${client.name}»: non ha altre pratiche né un menu online.` : (plan.clientNote || '');
    return { text: `Vuoi che elimini «${label}»?${parts.length ? ` Cancello ${parts.join(' e ')}.` : ''} ${clientLine}\n\nNon si può annullare. Il registro delle azioni resta.`.replace(/ \n/g, '\n'),
      buttons: [['SÌ, elimina', `${plan.request ? 'del' : 'delc'}:${plan.request?.id || client.id}`], ['No, tienila', 'delno:x']] };
  }
  async function runDelete(db, env, target) {
    const plan = await deletionPlan(db, { getOne, rows }, target);
    if (!plan.ok) return { text: `Non elimino: ${plan.blockers[0]}` };
    const label = plan.request?.subject || `cliente «${plan.client?.name}»`;
    try { await action(jarvisDb(db), 'deleteRequest', { ...target, confirmation: 'ELIMINA PRATICA' }, env); }
    catch (error) { return { text: `Non sono riuscito a eliminare «${label}»: ${String(error?.message || 'errore').slice(0, 200)}` }; }
    // Ricordi di lavoro che puntavano alla pratica eliminata.
    const mine = (key, test) => setting(db, key).then((raw) => { try { const v = JSON.parse(raw || 'null'); return v && test(v) ? putSetting(db, key, 'null') : null; } catch { return null; } }).catch(() => null);
    const draftIds = new Set(plan.drafts.map((d) => d.id));
    await mine('tg_focus', (v) => v.requestId === plan.request?.id);
    await mine('tg_checks', (v) => v.requestId === plan.request?.id);
    await mine('draft_undo', (v) => draftIds.has(v.draftId));
    await mine('draft_translate', (v) => draftIds.has(v.draftId));
    return { text: `Fatto, Riccardo: ho eliminato «${label}»${plan.deleteClient && plan.request ? ` e il cliente «${plan.client.name}»` : ''}, con ${plan.materials.length} file${plan.drafts.length ? ' e la bozza' : ''}.\n\nProssimo passo: vuoi aprire una nuova pratica? Dimmi il nome del locale.` };
  }
  // ——— Punto della situazione: scritto da dati certi del database, mai inventato dal modello ———
  const MISSION_LABEL = { affidata: 'la sto preparando io', attesa_cliente: 'anteprima inviata, aspetto la risposta del locale', attesa_invio: 'anteprima in coda per Gmail', attesa_si: 'aspetta il tuo SÌ per pubblicare', ferma: 'ferma, serve il tuo intervento', pubblicazione: 'in pubblicazione', verifica: 'in verifica dopo la pubblicazione' };
  async function statusReport(db, env, cut = 'breve') {
    const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
    const stamp = new Date(), day = stamp.toISOString().slice(0, 10), weekAgo = new Date(stamp.getTime() - 7 * 24 * 3600_000).toISOString();
    const reqs = await safe(() => rows(db, "SELECT r.id,r.subject,r.status,r.plan,r.kind,c.name AS client FROM requests r LEFT JOIN clients c ON c.id=r.client_id WHERE r.status NOT IN ('completata','archiviata','chiusa') ORDER BY r.updated_at DESC LIMIT 12"), []);
    const detail = [];
    // Poche interrogazioni raggruppate (il limite di richieste per messaggio è basso): missioni, bozze e file di tutte le pratiche aperte.
    const ids = new Set(reqs.map((r) => r.id));
    const firstBy = (list) => { const map = new Map(); for (const row of list) if (ids.has(row.request_id) && !map.has(row.request_id)) map.set(row.request_id, row); return map; };
    const missionOf = firstBy(await safe(() => rows(db, "SELECT id,request_id,status,note FROM jarvis_missions WHERE status NOT IN ('completata','annullata') ORDER BY updated_at DESC LIMIT 200"), []));
    const draftOf = firstBy(await safe(() => rows(db, 'SELECT id,request_id,status,revision FROM drafts ORDER BY created_at DESC LIMIT 300'), []));
    const fileRows = await safe(() => rows(db, 'SELECT request_id,processing_status AS st,COUNT(*) AS n FROM materials WHERE archived_at IS NULL GROUP BY request_id,processing_status'), []);
    const approvalOf = new Map((await safe(() => rows(db, 'SELECT request_id,snapshot_sha FROM publication_approvals'), [])).map((a) => [a.request_id, a.snapshot_sha]));
    for (const r of reqs) {
      const mission = missionOf.get(r.id) || null, draft = draftOf.get(r.id) || null;
      let stale = false;
      if (mission && ['attesa_si', 'attesa_cliente', 'attesa_invio'].includes(mission.status) && approvalOf.has(r.id)) {
        const current = await safe(() => getOne(db, 'SELECT menu_json FROM drafts WHERE request_id=? ORDER BY created_at DESC LIMIT 1', r.id), null);
        stale = !!current && approvalOf.get(r.id) !== await sha256Hex(current.menu_json);
      }
      const files = fileRows.filter((f) => f.request_id === r.id);
      const nFiles = files.reduce((t, f) => t + f.n, 0), toRead = files.filter((f) => f.st === 'da_trascrivere').reduce((t, f) => t + f.n, 0);
      let phrase;
      if (mission && stale) phrase = 'la bozza è stata modificata dopo l’anteprima: il SÌ non vale più, serve rivedere la checklist e rifare l’anteprima';
      else if (mission) phrase = `${MISSION_LABEL[mission.status] || mission.status}${mission.status === 'ferma' && mission.note ? ` (${mission.note})` : ''}`;
      else if (draft && ['bozza', 'revisione', 'pronta_pr'].includes(draft.status)) phrase = `bozza in revisione (versione ${draft.revision}), da controllare e confermare da te`;
      else if (toRead) phrase = `${toRead} file da leggere su ${nFiles}`;
      else if (nFiles) phrase = `${nFiles} file letti, bozza non ancora preparata`;
      else phrase = 'in attesa di foto o PDF del menu';
      detail.push({ name: r.client || r.subject, missionId: mission?.id, missionStatus: mission?.status, draftId: draft?.id, draftStatus: draft?.status, stale, toRead, nFiles, phrase, waitsYou: stale || mission?.status === 'attesa_si' || mission?.status === 'ferma' || (!mission && draft && ['bozza', 'revisione', 'pronta_pr'].includes(draft.status)), stuck: mission?.status === 'ferma' });
    }
    const quotaDay = day;
    let count = null; try { count = JSON.parse(await setting(db, 'reads_day') || 'null'); } catch {}
    let gem = null; try { const g = JSON.parse(await setting(db, 'gemini_day') || 'null'); if (g?.day === quotaDay) gem = g; } catch {}
    const failedReads = count?.day === quotaDay ? count.failed || 0 : 0, reads = count?.day === quotaDay ? count.n || 0 : 0;
    const queued = (await safe(() => getOne(db, "SELECT COUNT(*) AS n FROM materials WHERE processing_status='da_trascrivere' AND archived_at IS NULL"), null))?.n || 0;
    const problems = [];
    for (const d of detail.filter((x) => x.stuck)) problems.push(`«${d.name}» è ferma e aspetta un tuo intervento`);
    if (failedReads) problems.push(`${failedReads} ${failedReads === 1 ? 'lettura di foto non è riuscita' : 'letture di foto non sono riuscite'} oggi`);
    if (gem?.quota) problems.push('Google ha segnalato la quota esaurita, quindi leggo con i modelli di riserva');
    const waiting = detail.filter((d) => d.waitsYou);
    const word = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    // Proposta del passo successivo: una sola, la più utile, con un pulsante solo dove l'azione è sicura.
    const next = (() => {
      const stale = detail.find((d) => d.stale), ready = detail.find((d) => d.missionStatus === 'attesa_si' && !d.stale), stuck = detail.find((d) => d.stuck);
      const review = detail.find((d) => !d.missionStatus && ['bozza', 'revisione', 'pronta_pr'].includes(d.draftStatus));
      const photos = detail.find((d) => !d.missionStatus && !d.draftStatus && !d.nFiles), reading = detail.find((d) => d.toRead);
      if (stale) return { text: `la bozza di «${stale.name}» è cambiata dopo l’anteprima: guardala e riaffidamela, il riepilogo da confermare te lo faccio qui.`, buttons: stale.draftId ? [['Mostrami la bozza', `peek:${stale.draftId}`], ['Affida a Jarvis', `affq:${stale.draftId}`]] : null };
      if (ready) return { text: `«${ready.name}» è pronto: se vuoi pubblicarlo tocca SÌ, altrimenti «Non ancora».`, buttons: [['SÌ, pubblica', `pub:${ready.missionId}`], ['Non ancora', `no:${ready.missionId}`]] };
      if (stuck) return { text: `«${stuck.name}» è ferma: riaffidala dalla Control Room, oppure dimmi «elimina la pratica di ${stuck.name}».`, buttons: null };
      if (review) return { text: `guarda «${review.name}» e, se ti va bene, affidamela: il riepilogo da confermare te lo faccio qui.`, buttons: review.draftId ? [['Mostrami la bozza', `peek:${review.draftId}`], ['Affida a Jarvis', `affq:${review.draftId}`]] : null };
      if (photos) return { text: `mandami le foto o il PDF del menu di «${photos.name}».`, buttons: null };
      if (reading) return { text: `nessuno da parte tua: sto leggendo i file di «${reading.name}».`, buttons: null };
      return { text: 'vuoi aprire una nuova pratica? Dimmi il nome del locale.', buttons: null };
    })();
    const finish = (text) => ({ text: `${text}\n\nProssimo passo: ${next.text}`.slice(0, 3900), buttons: next.buttons });
    if (cut === 'buone_notizie') {
      const online = (await safe(() => getOne(db, "SELECT COUNT(*) AS n FROM clients WHERE menu_id IS NOT NULL AND menu_id<>''"), null))?.n || 0;
      const done = (await safe(() => getOne(db, "SELECT COUNT(*) AS n FROM requests WHERE status='completata' AND updated_at>=?", weekAgo), null))?.n || 0;
      const trial = (await safe(() => getOne(db, 'SELECT COUNT(*) AS n FROM clients WHERE trial_ends_at IS NOT NULL AND trial_ends_at>=?', day), null))?.n || 0;
      const ready = detail.filter((d) => d.phrase.startsWith('aspetta il tuo SÌ'));
      const good = [];
      if (online) good.push(`${word(online, 'menu è online', 'menu sono online')}`);
      if (done) good.push(`${word(done, 'pratica chiusa', 'pratiche chiuse')} negli ultimi sette giorni`);
      if (trial) good.push(`${word(trial, 'locale è in prova gratuita', 'locali sono in prova gratuita')}`);
      if (ready.length) good.push(`${ready.map((d) => `«${d.name}»`).join(' e ')} ${ready.length === 1 ? 'è pronto e aspetta' : 'sono pronti e aspettano'} solo il tuo SÌ`);
      if (reads && !failedReads) good.push(`le ${reads} letture di foto di oggi sono andate tutte a buon fine`);
      if (!problems.length) good.push('nessun problema in vista');
      return finish(good.length > 1 ? `Buone notizie, Riccardo: ${good.slice(0, 5).join('; ')}.` : `Notizie clamorose non ne ho, Riccardo, ma nemmeno guai: ${good[0] || 'tutto procede con calma'}.`);
    }
    if (cut === 'completo') {
      const lines = detail.map((d) => `- ${d.name}: ${d.phrase}`);
      const base = await statusText(db).catch(() => '');
      const dates = await safe(() => rows(db, 'SELECT name,trial_ends_at,renewal_at FROM clients WHERE (trial_ends_at IS NOT NULL AND trial_ends_at>=?) OR (renewal_at IS NOT NULL AND renewal_at>=?) ORDER BY COALESCE(trial_ends_at,renewal_at) LIMIT 6', day, day), []);
      const when = (iso) => new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'long' }).format(new Date(iso));
      const brief = dates.length ? `Prossime scadenze: ${dates.map((c) => `${c.name} (${c.trial_ends_at && c.trial_ends_at >= day ? `fine prova ${when(c.trial_ends_at)}` : `rinnovo ${when(c.renewal_at)}`})`).join('; ')}.` : 'Nessuna scadenza di prova o rinnovo in vista.';
      return finish([`Resoconto completo, Riccardo.`, '', reqs.length ? `Pratiche aperte (${reqs.length}):\n${lines.join('\n')}` : 'Non ci sono pratiche aperte.',
        waiting.length ? `\nAspettano te: ${waiting.map((d) => `«${d.name}»`).join(', ')}.` : '\nNon aspetto nulla da te per ora.',
        problems.length ? `\nDa tenere d’occhio: ${problems.join('; ')}.` : '\nProblemi: nessuno.', '', base, brief ? `\n${brief}` : ''].filter((x) => x !== undefined).join('\n').slice(0, 3500));
    }
    // breve
    const head = reqs.length ? `Hai ${word(reqs.length, 'pratica aperta', 'pratiche aperte')}: ${detail.slice(0, 4).map((d) => `«${d.name}» (${d.phrase})`).join('; ')}${detail.length > 4 ? ` e altre ${detail.length - 4}` : ''}.` : 'Non ci sono pratiche aperte.';
    const verdict = problems.length ? `Una cosa da guardare: ${problems.join('; ')}.` : waiting.length ? `Per il resto è tutto regolare: aspettano te ${waiting.map((d) => `«${d.name}»`).join(', ')}.` : 'Per il resto è tutto regolare, non aspetto nulla da te.';
    return finish(`${head} ${verdict}${queued ? ` File in coda di lettura: ${queued}.` : ''}`);
  }
  // ——— «Mostrami l’anteprima di X»: link di sola visione alla bozza (nessuna approvazione, nessuna pubblicazione) ———
  async function voiceShowPreview(db, env, spokenVenue, clues, utterance) {
    const drafts = await rows(db, OPEN_DRAFTS).catch(() => []);
    const target = await draftTarget(db, spokenVenue, clues, utterance).catch(() => null);
    if (target?.ask) return { text: target.ask };
    let draft = target?.draft || null;
    if (!draft && !spokenVenue && !clues.locales.length) {
      if (drafts.length === 1) draft = drafts[0];
      else if (drafts.length > 1) return { text: `Di quale locale vuoi l’anteprima? Ho queste bozze aperte: ${drafts.map((d) => `«${d.client_name || d.subject}»`).join(', ')}.` };
      else return { text: 'Non ho bozze aperte da mostrarti, Riccardo. Se ti serve un menu già online, dimmi il nome del locale.' };
    }
    if (!draft) {
      const clients = await rows(db, "SELECT id,name,menu_id FROM clients WHERE menu_id IS NOT NULL AND menu_id<>''").catch(() => []);
      const { client } = pickLocale(spokenVenue, clues, clients);
      if (client) return { text: `«${client.name}» non ha bozze aperte, ma ha il menu online: ${publicMenuPageUrl('https://renmenu.pages.dev', client.menu_id)}` };
      return { text: `Non trovo una bozza né un menu online per «${spokenVenue || 'quel locale'}». Dimmi il nome esatto del locale.` };
    }
    return showDraft(db, env, draft);
  }
  // Link di sola lettura alla bozza (24 ore): niente approvazione, niente pubblicazione.
  async function peekUrl(db, env, draftId) {
    const code = `BZ-${[...crypto.getRandomValues(new Uint8Array(10))].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('')}`;
    await Promise.resolve().then(() => db.prepare("DELETE FROM jarvis_settings WHERE key LIKE 'peek\\_%' ESCAPE '\\' AND updated_at < ?").bind(new Date(Date.now() - 2 * 24 * 3600_000).toISOString()).run()).catch(() => {});
    await putSetting(db, `peek_${code}`, JSON.stringify({ draftId, exp: new Date(Date.now() + 24 * 3600_000).toISOString() }));
    return `${String(env.JARVIS_ORIGIN || 'https://renmenu-jarvis-stage.pages.dev').replace(/\/+$/, '')}/jarvis-hook/bozza/${code}`;
  }
  async function showDraft(db, env, draft) {
    let menu; try { menu = JSON.parse(draft.menu_json); } catch { return { text: 'La bozza non si legge: aprila in Revisione.' }; }
    const link = await peekUrl(db, env, draft.id);
    const sections = (menu.sezioni || []).length, items = (menu.sezioni || []).reduce((t, s2) => t + (s2.voci || []).length, 0);
    const checks = await Promise.resolve().then(() => getOne(db, 'SELECT checks_json FROM drafts WHERE id=?', draft.id)).then((row) => { try { return JSON.parse(row?.checks_json || '{}') || {}; } catch { return {}; } }).catch(() => ({}));
    return { text: `Ecco la bozza di «${draft.client_name || menu.nome || draft.subject}» (versione ${draft.revision}, ${items} voci in ${sections} sezioni):\n${link}\n\nÈ solo da guardare: non è pubblicata e non è stata inviata a nessuno. Il link vale 24 ore.${['prices', 'allergens', 'languages'].every((key) => checks[key]) ? '' : ' La checklist di revisione (prezzi, allergeni, lingue) non è ancora confermata.'}\n\nProssimo passo: se la bozza ti va bene, affidami la pratica: ti faccio il riepilogo da confermare qui, con un tocco.`, keep: false, buttons: [['Affida a Jarvis', `affq:${draft.id}`]] };
  }
  async function voiceCreate(db, utterance, spokenVenue, urgent = false) {
    const venue = String(spokenVenue || '').replace(/^[«"“']|[»"”']$/g, '').trim();
    if (!venue || !venueSaid(venue, utterance)) return 'Come si chiama il locale? Ripetimi il nome, per favore.';
    const plan = planFromText(utterance);
    const jarvis = jarvisDb(db);
    const clients = await rows(db, 'SELECT id,name,menu_id FROM clients');
    const { client: existing, candidates } = matchVenue(venue, clients.map((c) => ({ ...c, menu_id: c.menu_id || '' })));
    const exact = existing && (existing.name || '').toLowerCase().replace(/\s+/g, ' ').trim() === venue.toLowerCase().replace(/\s+/g, ' ').trim() ? existing : null;
    if (!exact && candidates.length) return `Esiste già un cliente simile: ${candidates.map((c) => `«${c.name}»`).join(', ')}. Se è lo stesso dimmi «nuova pratica per ${candidates[0].name}» con il nome esatto; se è un altro locale, dimmi il nome completo.`;
    if (exact?.menu_id) return `«${exact.name}» ha già un menu online: per cambiarlo dimmi direttamente le modifiche, per esempio «al ${exact.name} il frico costa 14».`;
    try {
      const clientId = exact ? exact.id : (await action(jarvis, 'createClient', { name: venue, internalNotes: 'Cliente creato da Jarvis su comando vocale di Riccardo.' })).result.id;
      const subject = `Nuovo menu ${plan ? plan[0].toUpperCase() + plan.slice(1) : '(piano da definire)'} · ${venue}`;
      const requestId = (await action(jarvis, 'createRequest', { clientId, subject, sourceChannel: 'altro', sourceText: `Locale: ${venue}`, kind: 'nuovo',
        ...(plan ? { category: `nuovo_${plan}`, plan } : { plan: 'da_definire' }), internalNotes: `${urgent ? 'URGENTE (Riccardo ha chiesto fretta). ' : ''}Pratica aperta da Jarvis su comando di Riccardo: in attesa di foto o PDF del menu.` })).result.id;
      await putSetting(db, 'tg_focus', JSON.stringify({ requestId, subject, at: now() }));
      return `Fatto, Riccardo. ${exact ? `Ho usato il cliente «${venue}» che avevamo già` : `Ho creato il cliente «${venue}»`} e aperto la pratica «${subject}»${plan ? '' : ': il piano lo decidiamo poi'}. ${urgent ? 'L’ho segnata come urgente. ' : ''}Mandami pure foto o PDF del menu nella prossima ora: li collego a questa pratica, li leggo e preparo la bozza${urgent ? ' appena arrivano, senza altri passaggi inutili' : ''}.`;
    } catch (error) {
      return `Non sono riuscito ad aprire la pratica: ${String(error?.message || 'errore').slice(0, 200)}`;
    }
  }

  // Modifica a voce di un menu già online: pratica + bozza dal menu su main, con le sole parole di Riccardo.
  async function voiceUpdate(db, env, utterance, spokenVenue, clues = { locales: [], dishes: [] }) {
    const clients = await rows(db, "SELECT id,name,menu_id,plan FROM clients WHERE menu_id IS NOT NULL AND menu_id<>''");
    const { client, candidates } = pickLocale(spokenVenue, clues, clients);
    if (client && /^nuovo contatto/i.test(client.name || '') && !(spokenVenue && matchVenue(spokenVenue, [client]).client)) return 'Su quale menu devo intervenire? Dimmi il nome del locale.';
    if (!client && spokenVenue) {
      // Locale con un menu in formato proprio (per esempio Trattoria Blanch): Jarvis lo conosce ma non può ancora modificarlo.
      const legacy = await rows(db, "SELECT id,name FROM clients WHERE (menu_id IS NULL OR menu_id='') AND menu_url IS NOT NULL AND menu_url<>''").catch(() => []);
      const own = matchVenue(spokenVenue, legacy.map((c) => ({ ...c, menu_id: '' }))).client;
      if (own) return `«${own.name}» ha un menu online in un formato proprio, che non è ancora collegato alla modifica di Jarvis: non ho cambiato niente e non ho aperto nessuna pratica. Per ora la modifica va fatta a mano nei file del locale.`;
    }
    if (!client) return candidates.length > 1 ? `Ho trovato più locali: ${candidates.map((c) => c.name).join(', ')}. Quale intendi?` : `${spokenVenue ? `Non trovo un locale con menu online che si chiami «${spokenVenue}».` : 'Non ho capito di quale locale si tratta.'} Su quale menu devo intervenire?`;
    const proposal = classifyRequest('Richiesta a voce', utterance);
    const category = ['prezzo', 'piatto', 'vini_cocktail', 'disponibilita'].includes(proposal.category) ? proposal.category : 'piatto';
    const jarvis = jarvisDb(db);
    let requestId;
    try {
      requestId = (await action(jarvis, 'createRequest', { clientId: client.id, subject: `Richiesta a voce · ${client.name}`, sourceText: utterance, sourceChannel: 'altro', category })).result.id;
      await action(jarvis, 'generateDraft', { requestId }, env);
    } catch (error) {
      // Nessun prezzo o piatto da cambiare (per esempio «i titoli delle sezioni sono in minuscolo»): la bozza parte identica al menu online e la frase si applica come correzione di bozza.
      if (/modifica precisa|Nessun piatto/i.test(String(error?.message || ''))) {
        try {
          await action(jarvis, 'generateDraft', { requestId, baseOnly: true }, env);
          await putSetting(db, 'tg_focus', JSON.stringify({ requestId, subject: `Richiesta a voce · ${client.name}`, at: now() }));
          const base = (await rows(db, OPEN_DRAFTS)).find((d) => d.request_id === requestId);
          if (base) {
            const edited = await voiceEditDraft(db, env, utterance, base);
            return `Ho preparato la bozza di «${client.name}» partendo dal menu online. ${edited.text}`;
          }
        } catch (inner) { return `Ho aperto la pratica per «${client.name}», ma non ho preparato la bozza: ${String(inner?.message || 'errore').slice(0, 200)}`; }
      }
      return `Ho aperto la pratica per «${client.name}», ma non ho preparato la bozza: ${String(error?.message || 'errore').slice(0, 200)}`;
    }
    await putSetting(db, 'tg_focus', JSON.stringify({ requestId, subject: `Richiesta a voce · ${client.name}`, at: now() })).catch(() => {});
    const done = await getOne(db, "SELECT summary FROM audit_events WHERE request_id=? AND action='draft.generate' ORDER BY created_at DESC LIMIT 1", requestId);
    let todo = '';
    try { todo = notesSummary(JSON.parse((await getOne(db, 'SELECT review_notes_json AS n FROM drafts WHERE request_id=? ORDER BY created_at DESC LIMIT 1', requestId))?.n || '[]')); } catch {}
    return `Fatto. Ho preparato l’aggiornamento di «${client.name}» partendo dal menu online. ${done?.summary || ''} Lo trovi in Revisione: niente va online senza il tuo SÌ.${todo ? `\n\n${todo}` : ''}`;
  }

  // Foto o PDF mandati da Riccardo al bot: Jarvis chiede a quale pratica collegarli.
  const FILE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
  async function receiveTelegramFile(db, env, chat, message) {
    const photo = Array.isArray(message.photo) ? message.photo.filter((p) => !p.file_size || p.file_size <= 4_500_000).sort((a, b) => (b.width * b.height) - (a.width * a.height))[0] : null;
    const doc = message.document;
    const mime = photo ? 'image/jpeg' : String(doc?.mime_type || '');
    if (!photo && !FILE_TYPES.has(mime)) {
      await sendTelegram(env, chat, /heic|heif/i.test(mime) ? 'Questa foto è in formato HEIC: mandamela come foto normale (non come file), così Telegram la converte in JPG.' : 'Posso leggere foto (JPG, PNG, WebP) e PDF dei menu.', null, deps.fetchImpl);
      return;
    }
    const fileId = photo ? photo.file_id : doc.file_id;
    const name = photo ? `foto-telegram-${now().slice(0, 16).replace(/[:T]/g, '-')}.jpg` : String(doc.file_name || 'menu.pdf').slice(0, 120);
    await putSetting(db, 'tg_pending_file', JSON.stringify({ fileId, mime, name, at: now() }));
    let focus = null;
    try { focus = JSON.parse(await setting(db, 'tg_focus') || 'null'); } catch {}
    if (focus?.requestId && Date.now() - Date.parse(focus.at) < FOCUS_MINUTES * MINUTE) {
      const outcome = await attachTelegramFile(db, env, focus.requestId);
      await sendTelegram(env, chat, outcome.text.startsWith('Collegato') ? `${outcome.text} (è la pratica che mi hai appena fatto aprire).` : outcome.text, null, deps.fetchImpl);
      return;
    }
    const open = await rows(db, "SELECT id,subject FROM requests WHERE status NOT IN ('completata','archiviata','chiusa') ORDER BY updated_at DESC LIMIT 5");
    if (!open.length) { await sendTelegram(env, chat, 'Non ci sono pratiche aperte a cui collegare il file: crea prima la pratica nella Control Room.', null, deps.fetchImpl); return; }
    await sendTelegram(env, chat, `Ricevuto «${name}». A quale pratica lo collego? Poi lo leggo e ti dico cosa ho trovato.`,
      [...open.map((r) => [String(r.subject || r.id).slice(0, 48), `att:${r.id}`]), ['Nessuna, lascia stare', 'attno:x']], deps.fetchImpl, { stacked: true });
  }
  async function attachTelegramFile(db, env, requestId) {
    let pending = null;
    try { pending = JSON.parse(await setting(db, 'tg_pending_file') || 'null'); } catch {}
    if (!pending?.fileId || Date.now() - Date.parse(pending.at) > 30 * MINUTE) return { text: 'Il file non è più disponibile: mandamelo di nuovo.' };
    const request = await getOne(db, "SELECT id,subject,status FROM requests WHERE id=? AND status NOT IN ('completata','archiviata','chiusa')", requestId);
    if (!request) return { text: 'Pratica non trovata o chiusa.' };
    if (!env.BUCKET?.put) return { text: 'Archivio privato non configurato.' };
    const count = (await getOne(db, 'SELECT COUNT(*) AS n FROM materials WHERE request_id=?', request.id))?.n || 0;
    if (count >= 20) return { text: 'Questa pratica ha già 20 file: archiviane qualcuno nella Control Room.' };
    const file = await downloadTelegramFile(env, pending.fileId, deps.fetchImpl);
    if (!file?.bytes?.length) return { text: 'Non riesco a scaricare il file da Telegram: riprova.' };
    const id = uid(), key = `private/requests/${request.id}/${id}`;
    await env.BUCKET.put(key, file.bytes, { httpMetadata: { contentType: pending.mime } });
    try {
      await auditedBatch(jarvisDb(db), [db.prepare('INSERT INTO materials (id,request_id,r2_key,filename,mime,size,source,processing_status,text_preview,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .bind(id, request.id, key, pending.name, pending.mime, file.bytes.length, 'telegram', 'da_trascrivere', null, now())],
      'material.add', `File da Telegram collegato da Riccardo: ${pending.mime}, ${file.bytes.length} byte.`, request.id);
    } catch (error) { await env.BUCKET.delete(key); throw error; }
    await putSetting(db, 'tg_pending_file', '');
    return { text: `Collegato a «${String(request.subject || '').slice(0, 60)}». Lo leggo e ti scrivo tra circa un minuto.` };
  }

  // Briefing del mattino: una volta al giorno, lun–sab alle 8 (ora italiana).
  async function briefing(db, env, { force = false, now: at = new Date() } = {}) {
    const day = romeDay(at);
    if (!force) {
      if (!briefingDue(at) || (await setting(db, 'last_briefing_day')) === day) return null;
      await putSetting(db, 'last_briefing_day', day);
    }
    const text = await buildBriefing(db, env, { now: at, fetchImpl: deps.fetchImpl });
    await tell(db, env, null, 'briefing', text);
    await morningProposals(db, env).catch(() => null);
    return text;
  }

  const notify = (db, env, requestId, subject, text) => tell(db, env, { request_id: requestId }, subject, text);
  /** Bozza in coda dopo i dubbi: la prepara il giro dell'orologio. */
  async function draftAfterChecks(db, env) {
    let queued = null; try { queued = JSON.parse(await setting(db, 'draft_after_checks') || 'null'); } catch {}
    if (!queued?.requestId) return null;
    await putSetting(db, 'draft_after_checks', 'null');
    const chat = await setting(db, 'telegram_chat_id');
    const request = await getOne(db, 'SELECT id,subject FROM requests WHERE id=?', queued.requestId);
    if (!request || await getOne(db, 'SELECT id FROM drafts WHERE request_id=?', request.id)) return null;
    let text, buttons = null;
    try { await action(jarvisDb(db), 'generateDraft', { requestId: request.id }, env); text = `Bozza pronta per «${String(request.subject || 'la pratica').slice(0, 60)}»: guardala qui sotto e, se ti va bene, affidamela. Le voci che hai saltato restano da verificare.`; buttons = [['Mostrami la bozza', `peek:${(await getOne(db, 'SELECT id FROM drafts WHERE request_id=?', request.id))?.id}`], ['Affida a Jarvis', `affq:${(await getOne(db, 'SELECT id FROM drafts WHERE request_id=?', request.id))?.id}`]]; }
    catch (error) { text = `Non sono riuscito a preparare la bozza: ${String(error?.message || 'errore').slice(0, 160)}.`; }
    if (chat && telegramReady(env)) await sendTelegram(env, chat, text, buttons, deps.fetchImpl, { stacked: true });
    return { text };
  }
  // Prova di comprensione: classifica frasi senza eseguire nulla e senza scrivere sul database.
  async function probeIntents(db, env, phrases, engine = 'auto') {
    const out = [];
    const gem = await geminiFor(db, env);
    for (const phrase of phrases.slice(0, 12)) {
      const started = Date.now();
      const clues = await readClues(db, phrase);
      const context = await voiceContext(db, env, clues, '');
      const understood = await understand(env.AI, phrase, context, { gemini: gem, engine });
      const fallbackUsed = (understood.intent === 'non_chiaro' || understood.intent === 'risposta') && !['non_chiaro', 'ambiguo', 'risposta'].includes(clues.guess.intent);
      out.push({ phrase, intent: understood.intent, dettaglio: understood.dettaglio || '', locale: understood.locale || '', urgente: understood.urgente === true, engine: understood.engine || 'nessuno', model: understood.modelName || '', keyword: clues.guess.intent, final: fallbackUsed ? clues.guess.intent : understood.intent, ms: Date.now() - started, why: understood.why || '' });
    }
    return out;
  }
  return { entrust, tick, watchTick, queueOnlineEmail, checkOnlineMails, makeMenuQr, decide, telegramUpdate, probeIntents, setting, putSetting, briefing, notify, startChecks, answerCheck, draftAfterChecks, translateAfterEdit, undoDraftEdit, draftTarget, voiceEditDraft };
}

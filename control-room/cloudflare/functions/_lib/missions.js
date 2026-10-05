import { notesSummary } from './notes.js';
// Jarvis autonomo: una «missione» per ogni pratica che Riccardo affida a Jarvis dopo aver
// controllato la bozza. Jarvis porta la pratica fino alla pubblicazione usando le stesse
// operazioni (con gli stessi controlli) dell'interfaccia, con «jarvis» come autore nel registro.
// Si ferma e chiede a Riccardo quando qualcosa non è chiaro; pubblica solo dopo il suo SÌ.
import { assessReply, proposeReplyChanges, sha256Hex } from './approvals.js';
import { sendOwnerNotification } from './owner-notifications.js';
import { briefingDue, buildBriefing, romeDay } from './briefing.js';
import { answerCallback, clearButtons, downloadTelegramFile, sendTelegram, sendVoice, telegramReady } from './telegram.js';
import { CHAT_MODEL, chat as freeChat, matchVenue, planFromText, speak, transcribe, understand, venueSaid } from './voice.js';
import { classifyRequest } from './autopilot.js';
import { findDishes, findLocales, guessIntent, hintsText } from './understanding.js';
import { memoryContext, memoryFor, menuStatements, noteStatement } from './memory.js';

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

const romeDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const describeChange = (entry) => entry.type === 'prezzo' ? `${entry.name}: ${entry.before} → ${entry.after}`
  : entry.type === 'aggiungi' ? `aggiunto ${entry.name} ${entry.price}` : entry.type === 'rimuovi' ? `tolto ${entry.name}`
    : entry.type === 'coperto' ? `coperto ${entry.value}` : `${entry.name}: ${entry.label || entry.type}`;

export function createMissions(deps) {
  const { action, auditedBatch, getOne, rows, now, uid } = deps;
  const jarvisDb = (db) => ({ prepare: (sql) => db.prepare(sql), batch: (s) => db.batch(s), actor: 'jarvis' });

  async function setting(db, key) {
    try { return (await getOne(db, 'SELECT value FROM jarvis_settings WHERE key=?', key))?.value ?? null; }
    catch (error) { if (/no such table/i.test(String(error?.message))) return null; throw error; }
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
      const next = await move(db, mission, 'attesa_cliente', `Anteprima ${outbox.reference_code} inviata; attendo la risposta del locale.`);
      await tell(db, env, next, 'anteprima inviata', `Anteprima di «${venue}» inviata al locale da renmenu1569 (rif. ${outbox.reference_code}). Ti scrivo appena risponde.`);
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
    if (approval.status === 'anteprima_inviata') {
      if (!mission.reminded_at && Date.now() - Date.parse(approval.sent_at || mission.step_started_at) > 3 * 24 * 60 * MINUTE) {
        await bump(db, mission, { reminded_at: now() });
        await tell(db, env, mission, 'nessuna risposta', `«${venue}» non ha ancora risposto all’anteprima (3 giorni). Vuoi sentirlo tu? Io continuo ad aspettare.`);
      }
      return mission;
    }
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
  async function stepVerifying(db, env, mission) {
    if (Date.now() - Date.parse(mission.step_started_at) < 75_000) return mission;
    const { draft, request, menu } = await load(db, mission);
    try {
      const done = (await action(jarvisDb(db), 'githubVerifyPublication', { draftId: draft.id, revision: draft.revision, requestRevision: request.revision, confirmation: 'CONFERMO VERIFICA PUBBLICAZIONE' }, env)).result;
      await syncClientAfterPublish(db, draft, request, done.publicUrl);
      const next = await move(db, mission, 'completata', `Menu online e verificato: ${done.publicUrl}`);
      await tell(db, env, next, 'menu online', `Fatto: «${menu.nome}» è online e verificato.\n${done.publicUrl}\nPR #${done.prNumber}.`, null, 'importante');
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
      const [verb, missionId] = String(query.data || '').split(':');
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
    if (/^\/briefing\b/i.test(text)) { await briefing(db, env, { force: true }); return; }
    if (/^\/stato\b/i.test(text)) {
      const list = await rows(db, "SELECT m.status,m.note,d.menu_json FROM jarvis_missions m JOIN drafts d ON d.id=m.draft_id WHERE m.status NOT IN ('completata','annullata') ORDER BY m.updated_at DESC LIMIT 10");
      const pending = (await getOne(db, "SELECT COUNT(*) AS n FROM requests WHERE status IN ('nuova','dati_da_confermare','in_revisione')"))?.n || 0;
      const lines = list.map((row) => { let name = 'pratica'; try { name = JSON.parse(row.menu_json).nome; } catch {} return `- ${name}: ${row.status.replace('_', ' ')}${row.note ? ` (${row.note})` : ''}`; });
      await sendTelegram(env, chat, `${lines.length ? `Pratiche affidate a me:\n${lines.join('\n')}` : 'Nessuna pratica affidata in corso.'}\nRichieste aperte nella Control Room: ${pending}.`, null, deps.fetchImpl);
      return;
    }
    if (/^\/aiuto\b|^\/help\b/i.test(text) || text.startsWith('/')) {
      await sendTelegram(env, chat, 'Puoi scrivermi o mandarmi un vocale: «com’è la situazione?», «al Bakaro il frico ora costa 14», «crea una nuova pratica per il locale … con piano Standard», «pubblica il menu di …». Capisco anche /stato, /briefing, le foto e i PDF dei menu. Pubblicare richiede sempre il tuo SÌ col pulsante.', null, deps.fetchImpl);
      return;
    }
    await converse(db, env, chat, text, false);
  }

  // ——— Conversazione (testo o voce) ———
  async function voiceSettings(db) {
    return { provider: await setting(db, 'voice_provider'), apiKey: await setting(db, 'voice_api_key'), voiceId: await setting(db, 'voice_id') };
  }
  async function reply(db, env, chat, text, spoken, buttons = null) {
    // La trascrizione di ciò che ha detto Riccardo resta solo scritta: a voce Jarvis dice solo la risposta.
    const audio = spoken ? await speak(await voiceSettings(db), String(text).replace(/^«[\s\S]*?»\n\n/, ''), deps.fetchImpl) : null;
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
    return `${history ? `CONVERSAZIONE RECENTE (dal più vecchio):\n${history}\n\n` : ''}${hints ? `${hints}\n\n` : ''}${memory ? `${memory}\n\n` : ''}${brief}\n\nLocali con menu online: ${clients.map((c) => `${c.name} (menu ${c.menu_id}, piano ${c.plan}${c.trial_ends_at ? `, prova fino al ${String(c.trial_ends_at).slice(0, 10)}` : ''}${c.renewal_at ? `, rinnovo ${String(c.renewal_at).slice(0, 10)}` : ''})`).join('; ') || 'nessuno'}.\nPratiche aperte: ${open.map((r) => `${r.subject} [${r.status}]`).join('; ') || 'nessuna'}.`;
  }
  // Conversazione: ricorda gli ultimi scambi e, se Jarvis ha appena chiesto un chiarimento,
  // unisce la risposta di Riccardo al comando precedente (es. «cambia il frico a 12» → «quale locale?» → «Bakaro»).
  const PENDING_MINUTES = 10;
  async function converse(db, env, chat, said0, spoken) {
    const said = spoken ? `«${said0}»\n\n` : '';
    let pending = null; try { pending = JSON.parse(await setting(db, 'tg_pending') || 'null'); } catch {}
    const fresh = pending && Date.now() - Date.parse(pending.at) < PENDING_MINUTES * MINUTE;
    const utterance = fresh ? `${pending.text}\n${said0}` : said0;
    let history = []; try { history = JSON.parse(await setting(db, 'tg_history') || '[]').filter((h) => Date.now() - Date.parse(h.at) < 180 * MINUTE); } catch {}
    const clues = await readClues(db, utterance);
    const context = await voiceContext(db, env, clues, history.slice(-8).map((h) => `${h.who}: ${String(h.text).slice(0, 300)}`).join('\n'));
    const understood = await understand(env.AI, utterance, context);
    // Se il modello non è sicuro (o risponde a parole a un ordine) ma le parole chiave indicano un compito chiaro, Jarvis procede.
    const fallbackUsed = (understood.intent === 'non_chiaro' || (understood.intent === 'risposta' && !fresh)) && !['non_chiaro', 'ambiguo', 'risposta'].includes(clues.guess.intent);
    const intent = fallbackUsed ? { ...understood, intent: clues.guess.intent, locale: understood.locale || clues.guess.locale } : understood;
    if (intent.intent === 'non_chiaro' && !intent.risposta && clues.guess.intent === 'ambiguo') {
      const venue = clues.locales[0]?.name || clues.dishes[0]?.client?.name;
      const dish = clues.dishes[0]?.dish?.name;
      intent.risposta = `Vuoi che modifichi ${dish ? `«${dish}» nel` : 'il'} menu di «${venue}», o ti serve un’informazione?`;
    }
    await auditedBatch(jarvisDb(db), [], 'jarvis.conversation', `Comando ${spoken ? 'vocale' : 'scritto'}: ${intent.intent}${fallbackUsed ? ' (da parole chiave)' : ''}${fresh ? ' (con chiarimento)' : ''}${understood.why ? ` (${understood.why})` : ''}.`, null).catch(() => {});
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
    if (intent.intent === 'risposta' || (intent.intent === 'non_chiaro' && clues.guess.intent === 'non_chiaro')) {
      const talk = await freeChat(env.AI, { utterance: said0, context, history: fresh ? [...history, { who: 'Riccardo', text: pending.text }] : history, spoken });
      await auditedBatch(jarvisDb(db), [], 'jarvis.chat', `Conversazione libera: ${talk.ok ? (talk.model === CHAT_MODEL ? 'GPT-OSS 120B' : 'modello di riserva') : 'nessuna risposta'}.`, null).catch(() => {});
      const text = talk.ok ? talk.text : intent.risposta;
      if (text) { await answer(text, null, { keep: !talk.ok }); return; }
    }
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
    if (intent.intent === 'crea_pratica') { await answer(await voiceCreate(db, utterance, intent.locale)); return; }
    if (intent.intent === 'aggiorna_menu') { await answer(await voiceUpdate(db, env, utterance, intent.locale, clues)); return; }
    await answer(intent.risposta || 'Non ho afferrato, Riccardo: di quale locale parliamo e cosa devo fare?');
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

  // Nuova pratica a voce: cliente (esistente o nuovo) + pratica «nuovo menu». Le foto e i PDF che
  // Riccardo manda nell'ora successiva si collegano da soli a questa pratica.
  const FOCUS_MINUTES = 60;
  async function voiceCreate(db, utterance, spokenVenue) {
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
        ...(plan ? { category: `nuovo_${plan}`, plan } : { plan: 'da_definire' }), internalNotes: 'Pratica aperta da Jarvis su comando di Riccardo: in attesa di foto o PDF del menu.' })).result.id;
      await putSetting(db, 'tg_focus', JSON.stringify({ requestId, subject, at: now() }));
      return `Fatto, Riccardo. ${exact ? `Ho usato il cliente «${venue}» che avevamo già` : `Ho creato il cliente «${venue}»`} e aperto la pratica «${subject}»${plan ? '' : ': il piano lo decidiamo poi'}. Mandami pure foto o PDF del menu nella prossima ora: li collego a questa pratica, li leggo e preparo la bozza.`;
    } catch (error) {
      return `Non sono riuscito ad aprire la pratica: ${String(error?.message || 'errore').slice(0, 200)}`;
    }
  }

  // Modifica a voce di un menu già online: pratica + bozza dal menu su main, con le sole parole di Riccardo.
  async function voiceUpdate(db, env, utterance, spokenVenue, clues = { locales: [], dishes: [] }) {
    const clients = await rows(db, "SELECT id,name,menu_id,plan FROM clients WHERE menu_id IS NOT NULL AND menu_id<>''");
    const { client, candidates } = pickLocale(spokenVenue, clues, clients);
    if (client && /^nuovo contatto/i.test(client.name || '') && !(spokenVenue && matchVenue(spokenVenue, [client]).client)) return 'Su quale menu devo intervenire? Dimmi il nome del locale.';
    if (!client) return candidates.length > 1 ? `Ho trovato più locali: ${candidates.map((c) => c.name).join(', ')}. Quale intendi?` : `${spokenVenue ? `Non trovo un locale con menu online che si chiami «${spokenVenue}».` : 'Non ho capito di quale locale si tratta.'} Su quale menu devo intervenire?`;
    const proposal = classifyRequest('Richiesta a voce', utterance);
    const category = ['prezzo', 'piatto', 'vini_cocktail', 'disponibilita'].includes(proposal.category) ? proposal.category : 'piatto';
    const jarvis = jarvisDb(db);
    let requestId;
    try {
      requestId = (await action(jarvis, 'createRequest', { clientId: client.id, subject: `Richiesta a voce · ${client.name}`, sourceText: utterance, sourceChannel: 'altro', category })).result.id;
      await action(jarvis, 'generateDraft', { requestId }, env);
    } catch (error) {
      return `Ho aperto la pratica per «${client.name}», ma non ho preparato la bozza: ${String(error?.message || 'errore').slice(0, 200)}`;
    }
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
    return text;
  }

  const notify = (db, env, requestId, subject, text) => tell(db, env, { request_id: requestId }, subject, text);
  return { entrust, tick, decide, telegramUpdate, setting, putSetting, briefing, notify };
}

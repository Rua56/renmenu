// Jarvis autonomo: una «missione» per ogni pratica che Riccardo affida a Jarvis dopo aver
// controllato la bozza. Jarvis porta la pratica fino alla pubblicazione usando le stesse
// operazioni (con gli stessi controlli) dell'interfaccia, con «jarvis» come autore nel registro.
// Si ferma e chiede a Riccardo quando qualcosa non è chiaro; pubblica solo dopo il suo SÌ.
import { assessReply, proposeReplyChanges, sha256Hex } from './approvals.js';
import { sendOwnerNotification } from './owner-notifications.js';
import { briefingDue, buildBriefing, romeDay } from './briefing.js';
import { answerCallback, clearButtons, sendTelegram, telegramReady } from './telegram.js';

export const PARTIAL_MARK = '[Testo parziale: leggi l’email completa in Gmail prima di decidere]';
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
    const request = await getOne(db, 'SELECT r.*,c.name AS client_name FROM requests r JOIN clients c ON c.id=r.client_id WHERE r.id=?', mission.request_id);
    const approval = await getOne(db, 'SELECT * FROM publication_approvals WHERE draft_id=?', mission.draft_id);
    return { draft, request, approval, menu: JSON.parse(draft.menu_json) };
  };

  // Riccardo attesta la revisione interna con un solo gesto; Jarvis la registra a suo nome.
  async function attest(db, env, draftId, evidence, actorDb = db) {
    const draft = await getOne(db, 'SELECT * FROM drafts WHERE id=?', draftId);
    await action(actorDb, 'reviewDraft', {
      id: draft.id, revision: draft.revision,
      checks: { prices: true, allergens: true, languages: true, clientApproval: false },
      fieldEvidence: { prices: evidence, allergens: evidence, languages: evidence },
      allergenOmissionConfirmed: true
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
    const { draft } = await load(db, mission);
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
  async function stepVerifying(db, env, mission) {
    if (Date.now() - Date.parse(mission.step_started_at) < 75_000) return mission;
    const { draft, request, menu } = await load(db, mission);
    try {
      const done = (await action(jarvisDb(db), 'githubVerifyPublication', { draftId: draft.id, revision: draft.revision, requestRevision: request.revision, confirmation: 'CONFERMO VERIFICA PUBBLICAZIONE' }, env)).result;
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
    const { approval, draft, request } = await load(db, mission);
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
      const outcome = ['pub', 'no'].includes(verb) ? await decide(db, env, missionId, verb === 'pub') : { text: 'Comando sconosciuto.' };
      await answerCallback(env, query.id, outcome.text, deps.fetchImpl);
      if (query.message?.message_id) await clearButtons(env, chat, query.message.message_id, deps.fetchImpl);
      await sendTelegram(env, chat, outcome.text, null, deps.fetchImpl);
      return;
    }
    const message = update?.message;
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
    await sendTelegram(env, chat, 'Per ora capisco /stato, /briefing e i pulsanti SÌ / Non ancora. Il resto lo gestisci dalla Control Room.', null, deps.fetchImpl);
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

  return { entrust, tick, decide, telegramUpdate, setting, putSetting, briefing };
}

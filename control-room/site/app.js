import { getMaterialUrl, isAuthorizedHost, isDemoMode, loadState, modeLabel, performAction, uploadFile } from './api.js';
import { menuDiff, validateMenu } from './model.js';
import { configureVoice, interpretVoice, listen, speak, speechAvailable, synthesisAvailable, stopListening, voiceSettings } from './voice.js';
import { resetDemoState } from './demo-store.js';

const navItems = [
  ['command', '01', 'Command Center'], ['richieste', '02', 'Richieste'], ['clienti', '03', 'Clienti'],
  ['materiali', '04', 'Materiali'], ['builder', '05', 'Builder'], ['revisione', '06', 'Revisione'],
  ['anteprima', '07', 'Anteprima'], ['approvazioni', '08', 'Approvazioni'], ['notifiche', '09', 'Notifiche'],
  ['registro', '10', 'Registro'], ['voce', '11', 'Voce']
];
const validViews = new Set(navItems.map(([id]) => id));
const $ = (selector, root = document) => root.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
const clone = (value) => JSON.parse(JSON.stringify(value));
const time = (value) => new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
const shortTime = (value) => new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));

const app = $('#app');
const view = $('#view');
const primaryNav = $('#primary-nav');
const bottomNav = $('#bottom-nav');
const modeBadge = $('#mode-badge');
const themeToggle = $('#theme-toggle');
const toastRegion = $('#toast-region');
const dialog = $('#confirm-dialog');
const dialogForm = $('#confirm-form');
const dialogInput = $('#confirm-input');
let state = null;
let activeView = 'command';
let selectedRequestId = null;
let selectedClientId = null;
let clientFilter = '';
let mobileMenuOpen = false;
let pendingConfirm = null;
let lastVoiceTranscript = '';
let lastVoiceReply = '';
let voiceStatus = 'Voce disattivata: puoi usare il testo senza microfono.';
let previewMode = 'phone';

function statusLabel(status) {
  return ({ nuova: 'Nuova', in_lavorazione: 'In lavorazione', in_revisione: 'In revisione', in_attesa: 'In attesa', materiale_ricevuto: 'Materiale ricevuto', in_analisi: 'In analisi', dati_da_confermare: 'Dati da confermare', bozza_pronta: 'Bozza pronta', approvata: 'Approvata nel mock', pronta_pubblicazione: 'Pronta nel mock', archiviata: 'Archiviata', chiusa: 'Chiusa', completata: 'Simulazione completata', bozza: 'Bozza', revisione: 'Revisione', pronta_pr: 'Pronta PR', pr_simulata: 'PR simulata', pubblicazione_simulata: 'Pubblicazione simulata' }[status] || status || '—');
}
function statusTone(status) {
  if (['completata', 'pubblicazione_simulata'].includes(status)) return 'good';
  if (['in_attesa', 'bozza'].includes(status)) return 'wait';
  if (['nuova'].includes(status)) return 'alert';
  return 'info';
}
function status(status) { return `<span class="status ${statusTone(status)}">${escapeHtml(statusLabel(status))}</span>`; }
function requestById(id = selectedRequestId) { return state?.requests.find((request) => request.id === id) || null; }
function clientById(id) { return state?.clients.find((client) => client.id === id) || null; }
function selectedClient() { return clientById(selectedClientId) || clientById(requestById()?.clientId) || null; }
function draftForRequest(id = selectedRequestId) { return state?.drafts.find((draft) => draft.requestId === id) || null; }
function requestForDraft(draft) { return draft ? requestById(draft.requestId) : null; }
function requestOptions(selected = selectedRequestId, includeEmpty = false) {
  const empty = includeEmpty ? '<option value="">Nessuna pratica</option>' : '';
  return `${empty}${(state?.requests || []).map((request) => `<option value="${escapeHtml(request.id)}" ${request.id === selected ? 'selected' : ''}>${escapeHtml(request.subject)}</option>`).join('')}`;
}
function clientOptions(selected = '') { return (state?.clients || []).map((client) => `<option value="${escapeHtml(client.id)}" ${client.id === selected ? 'selected' : ''}>${escapeHtml(client.name)}</option>`).join(''); }
function kindOptions(selected = 'nuovo') { return [['nuovo','Nuovo menu'],['aggiornamento','Aggiornamento'],['prezzo','Prezzo'],['traduzione','Traduzione'],['qr','QR'],['commerciale','Commerciale'],['altro','Altro']].map(([value,label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join(''); }
function planOptions(selected = 'da_definire') { return [['da_definire','Da definire'],['standard','Standard'],['annuale','Annuale'],['premium','Premium']].map(([value,label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join(''); }
function requestStatusOptions(selected = 'nuova') { const protectedOption = ['approvata','pronta_pubblicazione','completata'].includes(selected) ? `<option value="${selected}" selected>${escapeHtml(statusLabel(selected))} · protetto</option>` : ''; return protectedOption + [['nuova','Nuova'],['materiale_ricevuto','Materiale ricevuto'],['in_analisi','In analisi'],['dati_da_confermare','Dati da confermare'],['bozza_pronta','Bozza pronta'],['in_revisione','In revisione'],['in_attesa','In attesa cliente'],['archiviata','Archiviata'],['chiusa','Chiusa']].map(([value,label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join(''); }
function channelOptions(selected = 'manuale') { return [['manuale','Manuale'],['email','Email'],['whatsapp','WhatsApp'],['telefono','Telefono'],['instagram','Instagram'],['altro','Altro']].map(([value,label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join(''); }
function header(eyebrow, title, description, actions = '') {
  return `<header class="view-header"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p class="view-subtitle">${escapeHtml(description)}</p></div>${actions ? `<div class="context-bar">${actions}</div>` : ''}</header>`;
}
function demoNotice() {
  return isDemoMode
    ? '<div class="notice"><strong>Demo locale attiva.</strong> Dati sintetici in localStorage; offline compatibile se lo storage è disponibile. Nessuna chiamata remota, invio, PR o pubblicazione reale.</div>'
    : '<div class="notice"><strong>Area privata.</strong> Dati caricati solo dall’API same-origin protetta; le azioni esterne richiedono sempre conferma dedicata.</div>';
}
function empty(text) { return `<p class="empty">${escapeHtml(text)}</p>`; }
function toast(message, type = 'ok') {
  const item = document.createElement('div');
  item.className = `toast ${type === 'error' ? 'error' : ''}`;
  item.textContent = message;
  toastRegion.append(item);
  window.setTimeout(() => item.remove(), 4500);
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Attiva tema chiaro' : 'Attiva tema scuro');
  themeToggle.title = themeToggle.getAttribute('aria-label');
  try { localStorage.setItem('renmenu-control-room-theme', theme); } catch (_) { /* preferenza non essenziale */ }
}
function initializeTheme() {
  let saved = 'dark';
  try { saved = localStorage.getItem('renmenu-control-room-theme') || 'dark'; } catch (_) { /* tema scuro di default */ }
  setTheme(saved === 'light' ? 'light' : 'dark');
}

function renderNavigation() {
  const nav = navItems.map(([id, number, label]) => `<a class="nav-link" href="#${id}" aria-current="${activeView === id ? 'page' : 'false'}"><span class="nav-icon">${number}</span><span>${label}</span></a>`).join('');
  primaryNav.innerHTML = nav;
  const mobilePrimary = navItems.slice(0, 4).map(([id, number, label]) => `<a class="nav-link" href="#${id}" aria-current="${activeView === id ? 'page' : 'false'}"><span class="nav-icon">${number}</span><span>${label}</span></a>`).join('');
  const extra = navItems.slice(4).map(([id, number, label]) => `<a class="nav-link" href="#${id}" aria-current="${activeView === id ? 'page' : 'false'}"><span class="nav-icon">${number}</span><span>${label}</span></a>`).join('');
  bottomNav.innerHTML = `${mobilePrimary}<button class="nav-link" type="button" data-action="toggle-mobile-menu" aria-expanded="${mobileMenuOpen}"><span class="nav-icon">••</span><span>Altro</span></button>${mobileMenuOpen ? `<div class="mobile-nav-menu" aria-label="Altre sezioni">${extra}</div>` : ''}`;
}
function renderUnavailable() {
  modeBadge.textContent = 'NON DISPONIBILE';
  primaryNav.innerHTML = '';
  bottomNav.innerHTML = '';
  view.innerHTML = `<div class="view-wrap">${header('ACCESSO LIMITATO', 'Control Room non disponibile', 'Questa origine non è autorizzata a mostrare dati o mock della Control Room.')}<section class="panel"><div class="notice danger"><strong>Accesso bloccato.</strong> La Control Room è visibile solo in locale su localhost/127.0.0.1 oppure sull’origine Cloudflare Pages autorizzata. Su questo host non viene eseguita alcuna richiesta API e non vengono caricati dati fittizi.</div><p class="muted">Il mock richiede inoltre <span class="mono">?demo=1</span> in locale.</p></section></div>`;
}
function renderAccessError(error) {
  modeBadge.textContent = modeLabel;
  view.innerHTML = `<div class="view-wrap">${header('AREA PRIVATA', 'Accesso da verificare', 'La Control Room richiede Cloudflare Access e API private.')}<section class="panel"><div class="notice danger"><strong>Stato non caricato.</strong> ${escapeHtml(error.message || 'Accesso non disponibile.')}</div><p class="muted">Non è stato mostrato alcun dato locale su questa origine.</p></section></div>`;
}

function renderCommand() {
  const open = state.requests.filter((request) => !['completata', 'archiviata', 'chiusa'].includes(request.status)).length;
  const waiting = state.requests.filter((request) => request.status === 'in_attesa').length;
  const review = state.requests.filter((request) => request.status === 'in_revisione').length;
  const warnings = state.drafts.reduce((count, draft) => count + validateMenu(draft.menu).warnings.length, 0);
  const tasks = [
    ...state.requests.filter((request) => request.status === 'in_attesa').map((request) => ({ request, label: 'Risolvi dati senza fonte', detail: 'Apri Builder e prepara una richiesta di conferma.' })),
    ...state.requests.filter((request) => request.status === 'in_revisione').map((request) => ({ request, label: 'Completa revisione editoriale', detail: 'Controlla JSON, provenienza e checklist.' })),
    ...state.requests.filter((request) => request.status === 'nuova').map((request) => ({ request, label: 'Avvia estrazione prudente', detail: 'Genera una bozza solo dal testo disponibile.' }))
  ].slice(0, 5);
  return `<div class="view-wrap">${header('01 / OPERAZIONI', 'Command Center', 'Copilota operativo: priorità chiare, regia umana e nessuna azione esterna automatica.', `<button class="button" type="button" data-route="richieste">Nuova richiesta</button>`)}${demoNotice()}<hr class="accent-line"><div class="kpis"><button class="kpi" type="button" data-route="richieste"><span>Pratiche aperte</span><strong>${open}</strong><small>clicca per gestire</small></button><button class="kpi" type="button" data-route="revisione"><span>In revisione</span><strong>${review}</strong><small>richiedono verifica</small></button><button class="kpi" type="button" data-route="builder"><span>In attesa</span><strong>${waiting}</strong><small>dati da confermare</small></button><button class="kpi" type="button" data-route="notifiche"><span>Avvisi menu</span><strong>${warnings}</strong><small>tecnici/editoriali</small></button></div>${tasks[0] ? `<div class="next-action"><span class="eyebrow">PROSSIMA AZIONE CONSIGLIATA</span><strong>${escapeHtml(tasks[0].label)} · ${escapeHtml(tasks[0].request.subject)}</strong><button class="button secondary small-button" type="button" data-select-request="${tasks[0].request.id}" data-route="${tasks[0].request.status === 'in_attesa' ? 'builder' : 'revisione'}">Apri priorità</button></div>` : ''}<div class="grid grid-command"><section class="panel"><div class="panel-heading"><div><p class="eyebrow">CODA DI LAVORO</p><h2>Task attivi</h2></div><span class="capsule">${tasks.length} priorità</span></div><div class="task-list">${tasks.length ? tasks.map((task, index) => `<button class="task-card" type="button" data-select-request="${task.request.id}" data-route="${task.request.status === 'in_attesa' ? 'builder' : 'revisione'}"><span class="task-index">0${index + 1}</span><span class="task-body"><strong>${escapeHtml(task.label)}</strong><small>${escapeHtml(task.request.subject)} · ${escapeHtml(task.detail)}</small></span>${status(task.request.status)}</button>`).join('') : empty('Nessuna priorità aperta.')}</div></section><aside class="panel"><p class="eyebrow">SEGNALI</p><h2>Stato di controllo</h2><div class="stack"><div class="list-row"><div class="list-main"><strong>Fonti tracciate</strong><small>Ogni prezzo estratto mostra una riga o “nessuna fonte”.</small></div><span class="status good">attivo</span></div><div class="list-row"><div class="list-main"><strong>Azioni esterne</strong><small>PR, pubblicazione e messaggi restano simulati.</small></div><span class="status info">manuale</span></div><div class="list-row"><div class="list-main"><strong>Voce</strong><small>Microfono opzionale e testo non sostituiscono le conferme.</small></div><span class="status wait">vincolata</span></div></div><div class="button-row spaced-top"><button class="button secondary" type="button" data-route="registro">Apri registro</button><button class="button secondary" type="button" data-route="voce">Testa voce</button>${isDemoMode ? '<button class="button secondary" type="button" data-action="reset-demo">Ripristina demo</button>' : ''}</div></aside></div></div>`;
}

function requestOperationalCard(request, compact = false) {
  const client = clientById(request.clientId);
  const draft = draftForRequest(request.id);
  const materials = state.materials.filter((item) => item.requestId === request.id);
  const messages = state.messages.filter((item) => item.requestId === request.id);
  const audits = state.audit.filter((item) => item.requestId === request.id);
  const proposal = draft && state.proposals.find((item) => item.draftId === draft.id);
  const menu = draft ? `<span class="mono">${escapeHtml(draft.slug)}</span><br><small>URL proposto: <span class="mono">/menu/?m=${escapeHtml(draft.slug)}</span> · non attivo</small>` : '<span class="muted">Nessuna bozza</span>';
  if (compact) return `<tr class="click-row" data-select-request="${request.id}"><td><strong>${escapeHtml(request.subject)}</strong><br><span class="mono">${escapeHtml(request.id.slice(0, 8))}</span></td><td>${escapeHtml(client?.name || '—')}<br><small>${escapeHtml(request.sourceChannel)}</small></td><td>${status(request.status)}<br><small>${escapeHtml(request.plan || '—')} · ${escapeHtml(request.kind)}</small></td><td>${materials.length} mat. · ${draft ? escapeHtml(draft.slug) : 'bozza assente'}</td><td>${escapeHtml(request.nextStep || 'Definisci prossimo passo.')}</td><td><button class="button small-button secondary" type="button" data-select-request="${request.id}" data-route="builder">Apri</button></td></tr>`;
  return `<div class="data-grid"><div><small>ID PRATICA</small><code>${escapeHtml(request.id)}</code></div><div><small>CLIENTE / CANALE</small><strong>${escapeHtml(client?.name || '—')}</strong><span>${escapeHtml(request.sourceChannel)}${request.contactName || client?.contactName ? ` · ${escapeHtml(request.contactName || client?.contactName)} (${escapeHtml(request.contactRole || client?.contactRole || 'referente')})` : ''}</span></div><div><small>RICEVUTA</small><strong>${time(request.receivedAt || request.createdAt)}</strong><span>rev. ${request.revision}</span></div><div><small>PIANO / TIPO</small><strong>${escapeHtml(request.plan || 'non indicato')}</strong><span>${escapeHtml(request.kind)}</span></div><div><small>MATERIALI / NOTE</small><strong>${materials.length} materiali</strong><span>${escapeHtml(request.internalNotes || 'Nessuna nota')}</span></div><div><small>MENU ID / URL</small>${menu}${request.menuId || client?.menuId ? `<span>ID dichiarato: ${escapeHtml(request.menuId || client?.menuId)}</span>` : ''}${request.publicUrl || client?.menuUrl ? `<span>URL esistente dichiarato: ${escapeHtml(request.publicUrl || client?.menuUrl)}</span>` : ''}</div><div><small>PROSSIMO PASSO</small><strong>${escapeHtml(request.nextStep || 'Da definire')}</strong><span>${request.followUpAt ? `follow-up ${time(request.followUpAt)}` : 'follow-up non impostato'}</span></div><div><small>COLLEGAMENTI</small><strong>${messages.length} bozze messaggi · ${audits.length} audit</strong><span>Ultima azione: ${request.lastActionAt ? time(request.lastActionAt) : 'da definire'}</span><span>${proposal ? 'PR simulata presente' : draft ? 'approvazioni da completare' : 'bozza da generare'}</span></div></div>`;
}

function renderRequests() {
  const selected = requestById();
  return `<div class="view-wrap">${header('02 / INGRESSO', 'Richieste', 'Ogni pratica mantiene ID, provenienza, stato, piano, materiali, note e prossimo passo: nessun campo è inventato.')}<div class="grid grid-2"><section class="panel"><div class="panel-heading"><div><p class="eyebrow">NUOVA PRATICA</p><h2>Registra materiale ricevuto</h2></div><span class="capsule">nessun invio</span></div><form data-form="create-request"><div class="form-grid"><label class="field">Cliente sintetico<select name="clientId" required>${clientOptions(selected?.clientId)}</select></label><label class="field">Tipo<select name="kind">${kindOptions('nuovo')}</select></label><label class="field">Piano<select name="plan"><option value="da_definire">Da definire</option><option value="standard">Standard</option><option value="annuale">Annuale</option><option value="premium">Premium</option></select></label><label class="field">Follow-up facoltativo<input name="followUpAt" type="datetime-local"></label><label class="field full">Oggetto<input name="subject" required maxlength="120" placeholder="Es. aggiornamento pranzo"></label><label class="field">Canale sorgente<select name="sourceChannel">${channelOptions('manuale')}</select></label><label class="field">Referente (se noto)<input name="contactName" maxlength="140" placeholder="Non inventare il nome"></label><label class="field">Menu ID esistente (solo aggiornamenti)<input name="menuId" maxlength="64" placeholder="es. trattoria-demo"></label><label class="field full">Testo sorgente (facoltativo se carichi un file dopo)<textarea name="sourceText" placeholder="Locale: Esempio demo&#10;# Sezione&#10;Piatto — 12,00"></textarea></label><label class="field">Note operative<textarea name="internalNotes" maxlength="600" placeholder="Solo note ricevute o interne."></textarea></label><label class="field">Prossimo passo<textarea name="nextStep" maxlength="240" placeholder="Es. verifica un prezzo con il locale."></textarea></label></div><div class="form-actions"><button class="button" type="submit">Crea pratica</button></div></form></section><section class="panel"><p class="eyebrow">SCHEDA OPERATIVA</p><h2>${escapeHtml(selected?.subject || 'Nessuna pratica')}</h2>${selected ? `${requestOperationalCard(selected)}<form data-form="update-request-meta" class="form-grid spaced-top"><input type="hidden" name="id" value="${escapeHtml(selected.id)}"><input type="hidden" name="revision" value="${selected.revision}"><label class="field">Stato<select name="status" ${['approvata','pronta_pubblicazione','completata','archiviata','chiusa'].includes(selected.status) ? 'disabled' : ''}>${requestStatusOptions(selected.status)}</select></label><label class="field">Prossimo passo<input name="nextStep" maxlength="240" value="${escapeHtml(selected.nextStep || '')}"></label><label class="field full">Note interne<textarea name="internalNotes" maxlength="3000">${escapeHtml(selected.internalNotes || '')}</textarea></label><div class="form-actions field full"><button class="button secondary" type="submit">Aggiorna pratica</button></div></form><div class="button-row spaced-top"><button class="button secondary" type="button" data-route="builder">Apri Builder</button><button class="button secondary" type="button" data-route="materiali">Materiali</button><button class="button secondary" type="button" data-select-client="${selected.clientId}" data-route="clienti">Scheda cliente</button></div>` : empty('Seleziona una riga per vedere il contesto.')}</section></div><section class="panel"><div class="panel-heading"><div><p class="eyebrow">CODA</p><h2>Tutte le pratiche</h2></div><span class="capsule">${state.requests.length} totali</span></div><div class="table-wrap"><table class="table"><thead><tr><th>Pratica / ID</th><th>Cliente / canale</th><th>Stato / piano</th><th>Materiali / menu</th><th>Prossimo passo</th><th></th></tr></thead><tbody>${state.requests.map((request) => requestOperationalCard(request, true)).join('')}</tbody></table></div></section></div>`;
}

function renderClientRows() {
  const query = clientFilter.toLocaleLowerCase('it');
  const matching = state.clients.filter((client) => client.name.toLocaleLowerCase('it').includes(query) || client.id.includes(query));
  return matching.length ? matching.map((client) => {
    const requests = state.requests.filter((request) => request.clientId === client.id);
    return `<div class="list-row"><div class="list-main"><strong>${escapeHtml(client.name)}</strong><small><span class="mono">${escapeHtml(client.id)}</span> · creato ${time(client.createdAt)}</small></div><div class="list-meta"><span class="capsule">${requests.length} pratiche</span><button class="button small-button secondary" type="button" data-select-client="${client.id}" data-route="clienti">Apri</button></div></div>`;
  }).join('') : empty('Nessun cliente demo corrisponde al filtro.');
}
function renderClients() {
  const client = selectedClient();
  const clientRequests = client ? state.requests.filter((request) => request.clientId === client.id) : [];
  const ids = new Set(clientRequests.map((request) => request.id));
  const materials = state.materials.filter((item) => ids.has(item.requestId));
  const drafts = state.drafts.filter((item) => ids.has(item.requestId));
  const messages = state.messages.filter((item) => ids.has(item.requestId));
  const audit = state.audit.filter((item) => ids.has(item.requestId));
  const approved = drafts.filter((item) => ['pr_simulata', 'pubblicazione_simulata'].includes(item.status));
  return `<div class="view-wrap">${header('03 / RUBRICA', 'Clienti', 'Schede demo che collegano pratiche, materiali, bozze, messaggi, approvazioni e audit, senza dati reali.')}<div class="grid grid-equal"><section class="panel"><p class="eyebrow">NUOVA ANAGRAFICA</p><h2>Crea cliente demo</h2><form data-form="create-client"><div class="form-grid"><label class="field full">Nome<input name="name" required minlength="2" maxlength="120" placeholder="Es. Locale Fittizio — demo"></label><label class="field">Piano<select name="plan"><option value="da_definire" selected>Da definire</option><option value="standard">Standard</option><option value="annuale">Annuale</option><option value="premium">Premium</option></select></label><label class="field">Referente facoltativo<input name="contactName" maxlength="100" placeholder="solo se esplicito"></label><label class="field">Ruolo referente<input name="contactRole" maxlength="80" placeholder="solo se esplicito"></label><label class="field">Email facoltativa<input name="email" type="email" maxlength="160" placeholder="solo se esplicita"></label><label class="field">Telefono facoltativo<input name="phone" maxlength="40" placeholder="solo se esplicito"></label><label class="field full">Note interne<textarea name="internalNotes" maxlength="500" placeholder="Solo informazioni sintetiche della demo."></textarea></label></div><div class="form-actions"><button class="button" type="submit">Crea cliente</button></div></form></section><section class="panel"><p class="eyebrow">FILTRO</p><h2>Trova una pratica</h2><label class="field">Nome o ID<input id="client-filter" class="filter-input" value="${escapeHtml(clientFilter)}" placeholder="Filtra senza uscire dalla pagina"></label><p class="notice">I contatti non sono necessari per lavorare al menu: non inserire dati personali nella demo.</p></section></div><section class="panel"><div class="panel-heading"><div><p class="eyebrow">ANAGRAFICHE</p><h2>Clienti demo</h2></div><span class="capsule">${state.clients.length} registrati</span></div><div id="client-list" class="stack">${renderClientRows()}</div></section>${client ? `<section class="panel"><div class="panel-heading"><div><p class="eyebrow">SCHEDA CLIENTE COLLEGATA</p><h2>${escapeHtml(client.name)}</h2><p class="muted mono">${escapeHtml(client.id)}</p></div><span class="capsule">solo demo</span></div><div class="kpis relationship-kpis"><div class="kpi"><span>Pratiche</span><strong>${clientRequests.length}</strong></div><div class="kpi"><span>Materiali</span><strong>${materials.length}</strong></div><div class="kpi"><span>Bozze</span><strong>${drafts.length}</strong></div><div class="kpi"><span>Registro</span><strong>${audit.length}</strong></div></div><form data-form="update-client" class="form-grid spaced-top"><input type="hidden" name="id" value="${escapeHtml(client.id)}"><input type="hidden" name="revision" value="${client.revision}"><label class="field">Piano<select name="plan">${planOptions(client.plan || 'da_definire')}</select></label><label class="field">Referente<input name="contactName" value="${escapeHtml(client.contactName || '')}" maxlength="100" placeholder="solo se esplicito"></label><label class="field full">Note interne<textarea name="internalNotes" maxlength="500">${escapeHtml(client.internalNotes || '')}</textarea></label><div class="form-actions field full"><button class="button secondary" type="submit">Aggiorna scheda demo</button></div></form><div class="relationship-grid"><section><h3>Pratiche e bozze</h3>${clientRequests.length ? clientRequests.map((request) => { const draft = draftForRequest(request.id); return `<div class="list-row"><div class="list-main"><strong>${escapeHtml(request.subject)}</strong><small>${statusLabel(request.status)} · ${draft ? `bozza ${escapeHtml(draft.slug)}` : 'bozza assente'}</small></div><button class="button small-button secondary" type="button" data-select-request="${request.id}" data-route="richieste">Apri</button></div>`; }).join('') : empty('Nessuna pratica.')}</section><section><h3>Materiali e messaggi</h3><p class="muted">${materials.length} materiali associati · ${messages.length} bozze messaggi non inviate</p>${messages.length ? messages.map((message) => `<div class="list-row"><div class="list-main"><strong>${escapeHtml(message.channel)}</strong><small>${escapeHtml(message.body)}</small></div><span class="status wait">bozza</span></div>`).join('') : empty('Nessun messaggio associato.')}</section><section><h3>Approvazioni e registro</h3><p class="muted">${approved.length} stati PR/pubblicazione simulati · ${audit.length} eventi audit</p><div class="button-row"><button class="button secondary small-button" type="button" data-select-request="${clientRequests[0]?.id || ''}" data-route="approvazioni" ${clientRequests.length ? '' : 'disabled'}>Approvazioni</button><button class="button secondary small-button" type="button" data-route="registro">Registro</button></div></section></div></section>` : ''}</div>`;
}

function renderMaterials() {
  const request = requestById();
  const materials = request ? state.materials.filter((material) => material.requestId === request.id) : [];
  return `<div class="view-wrap">${header('04 / FONTI', 'Materiali', 'Associa file alla pratica con limiti chiari. In demo si conservano solo metadati e un breve estratto testuale.')}<div class="grid grid-2"><section class="panel"><div class="panel-heading"><div><p class="eyebrow">CARICAMENTO</p><h2>Materiale associato</h2></div>${request ? status(request.status) : ''}</div><label class="field">Pratica<select data-select-request>${requestOptions(selectedRequestId)}</select></label>${request ? `<form data-form="upload-material" class="spaced-top"><label class="field">File (testo, PDF, immagine o audio; max 10 MB)<input name="file" type="file" required accept="text/*,application/pdf,image/*,audio/*"></label><p class="muted small">Limite demo: 12 materiali per pratica. I binari non vengono persistiti dal mock.</p><div class="form-actions"><button class="button" type="submit">Registra materiale</button></div></form>` : empty('Seleziona una pratica per associare materiale.')}</section><section class="panel"><p class="eyebrow">PRIVACY</p><h2>Regole di deposito</h2><div class="stack"><div class="notice"><strong>Demo:</strong> nessun upload remoto; solo nome, tipo, dimensione ed estratto testuale breve.</div><div class="notice warning"><strong>Live:</strong> l’URL del file è privato, same-origin e richiede Access.</div><div class="notice"><strong>Editor:</strong> foto e PDF non vengono interpretati né trasformati automaticamente.</div></div></section></div><section class="panel"><div class="panel-heading"><div><p class="eyebrow">ELENCO</p><h2>${escapeHtml(request?.subject || 'Materiali')}</h2></div><span class="capsule">${materials.length} file</span></div><div class="stack">${materials.length ? materials.map((material) => `<div class="list-row"><div class="list-main"><strong>${escapeHtml(material.filename)}</strong><small>${escapeHtml(material.mime)} · ${Math.ceil(material.size / 1024)} KB · ${time(material.createdAt)}${(material.textPreview || material.excerpt) ? ` · “${escapeHtml((material.textPreview || material.excerpt).slice(0, 90))}”` : ''}</small></div><span class="capsule">${escapeHtml(material.processingStatus || 'metadati')}</span>${material.archivedAt ? '<span class="status wait">archiviato</span>' : `<button class="button secondary small-button" type="button" data-action="archive-material" data-material-id="${material.id}">Archivia</button>`}${getMaterialUrl(material.id) ? `<a class="button secondary small-button" href="${escapeHtml(getMaterialUrl(material.id))}">Apri privato</a>` : ''}</div>`).join('') : empty('Nessun materiale associato alla pratica selezionata.')}</div></section></div>`;
}

function renderBuilder() {
  const request = requestById();
  const draft = draftForRequest();
  const validation = draft ? validateMenu(draft.menu) : null;
  const provenance = draft?.provenance || [];
  return `<div class="view-wrap">${header('05 / ESTRAZIONE', 'Builder da testo', 'Estrattore deterministico: riconosce solo “Nome — 12,00”; prezzi, allergeni, contatti e traduzioni non presenti restano da verificare.', `<label class="field">Pratica<select data-select-request>${requestOptions(selectedRequestId)}</select></label>`)}<div class="grid grid-2"><section class="panel"><div class="panel-heading"><div><p class="eyebrow">TESTO SORGENTE</p><h2>${escapeHtml(request?.subject || 'Scegli una pratica')}</h2></div>${request ? status(request.status) : ''}</div>${request ? `<form data-form="update-source"><input type="hidden" name="id" value="${escapeHtml(request.id)}"><input type="hidden" name="revision" value="${request.revision}"><div class="form-grid"><label class="field">Canale<select name="sourceChannel">${channelOptions(request.sourceChannel)}</select></label><label class="field">Tipo<select name="kind">${kindOptions(request.kind)}</select></label><label class="field full">Testo ricevuto<textarea name="sourceText" required>${escapeHtml(request.sourceText)}</textarea></label><label class="field">Note interne<textarea name="internalNotes" maxlength="600">${escapeHtml(request.internalNotes || '')}</textarea></label><label class="field">Prossimo passo<textarea name="nextStep" maxlength="240">${escapeHtml(request.nextStep || '')}</textarea></label><label class="field">Follow-up<input name="followUpAt" type="datetime-local" value="${request.followUpAt ? new Date(request.followUpAt).toISOString().slice(0, 16) : ''}"></label></div><div class="form-actions"><button class="button secondary" type="submit">Salva sorgente</button>${draft ? '<button class="button" type="button" data-route="revisione">Apri bozza esistente</button>' : '<button class="button" type="button" data-action="generate-draft">Genera bozza prudente</button>'}</div></form>` : empty('Torna a Richieste per selezionare o creare una pratica.')}</section><aside class="panel"><p class="eyebrow">GUARDRAIL</p><h2>Blocco dati inferiti</h2><div class="stack"><div class="notice"><strong>Prezzi:</strong> viene letto solo un importo numerico esplicito; altrimenti resta vuoto.</div><div class="notice"><strong>Allergeni:</strong> nessuna deduzione da ingredienti o nomi dei piatti.</div><div class="notice"><strong>Lingue:</strong> nessuna traduzione accreditata come verificata.</div><div class="notice warning"><strong>Contatti:</strong> non vengono aggiunti da testo non strutturato.</div></div></aside></div>${draft ? `<section class="panel"><div class="panel-heading"><div><p class="eyebrow">ULTIMA BOZZA</p><h2>${escapeHtml(draft.slug)} · rev. ${draft.revision}</h2></div>${status(draft.status)}</div><div class="grid grid-equal"><div><p class="muted">${validation.valid ? 'Struttura tecnicamente valida; gli avvisi restano editoriali.' : 'La struttura contiene errori da correggere in Revisione.'}</p>${renderValidation(validation)}</div><div class="provenance">${provenance.length ? provenance.map((entry) => `<div class="provenance-row"><code>${escapeHtml(entry.path)}</code><span class="status ${entry.status === 'confermato' ? 'good' : 'wait'}">${escapeHtml(entry.status.replace('_', ' '))}</span><small>${escapeHtml(entry.source)} · ${escapeHtml(entry.value)}</small></div>`).join('') : empty('Genera una bozza per vedere provenienza e campi da verificare.')}</div></div><div class="button-row spaced-top"><button class="button secondary" type="button" data-route="revisione">Apri editor JSON</button><button class="button secondary" type="button" data-route="notifiche">Prepara richiesta chiarimenti</button></div></section>` : ''}</div>`;
}

function renderValidation(result) {
  const items = [...result.errors, ...result.warnings];
  return `<div class="validation-list">${items.length ? items.map((issue) => `<div class="validation-item ${issue.level}"><strong>${issue.level === 'error' ? 'Errore bloccante' : 'Avviso'}</strong> · <span class="mono">${escapeHtml(issue.path)}</span> — ${escapeHtml(issue.message)}</div>`).join('') : '<div class="notice"><strong>OK tecnico.</strong> Nessun errore né avviso strutturale; serve comunque conferma di contenuti, prezzi e allergeni.</div>'}</div>`;
}
function editorMenu() {
  const field = $('#menu-editor');
  if (!field) return null;
  try { return JSON.parse(field.value); } catch (error) { toast(`JSON non leggibile: ${error.message}`, 'error'); return null; }
}
function writeEditor(menu) {
  const field = $('#menu-editor');
  if (field) field.value = JSON.stringify(menu, null, 2);
}
function renderReorder(menu) {
  return menu.sezioni.map((section, index) => `<div class="reorder-item"><span>${index + 1}. ${escapeHtml(section.nome?.it || section.nome || 'Sezione senza nome')} <small class="muted">(${section.voci?.length || 0} voci)</small></span><span class="reorder-buttons"><button type="button" class="mini-button" aria-label="Sposta su" data-action="move-section" data-index="${index}" data-direction="-1" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" class="mini-button" aria-label="Sposta giù" data-action="move-section" data-index="${index}" data-direction="1" ${index === menu.sezioni.length - 1 ? 'disabled' : ''}>↓</button></span></div>`).join('');
}
function renderReview() {
  const draft = draftForRequest();
  const request = requestForDraft(draft);
  if (!draft) return `<div class="view-wrap">${header('06 / REVISIONE', 'Revisione editoriale', 'JSON strutturato, provenienza e validazione compatibile con RenMenu.')}<section class="panel">${empty('Nessuna bozza per la pratica selezionata. Genera prima una bozza dal Builder.')}<div class="button-row"><button class="button" type="button" data-route="builder">Vai al Builder</button></div></section></div>`;
  const validation = validateMenu(draft.menu);
  return `<div class="view-wrap">${header('06 / REVISIONE', 'Revisione editoriale', 'Modifica JSON e struttura; ogni salvataggio azzera la checklist di approvazione.', `<label class="field">Pratica<select data-select-request>${requestOptions(selectedRequestId)}</select></label>`)}<div class="grid grid-2"><section class="panel"><div class="editor-toolbar"><div><p class="eyebrow">BOZZA ${escapeHtml(draft.slug)}</p><h2>JSON RenMenu · rev. ${draft.revision}</h2></div>${status(draft.status)}</div><textarea class="json-editor" id="menu-editor" spellcheck="false" aria-label="Editor JSON del menu">${escapeHtml(JSON.stringify(draft.menu, null, 2))}</textarea><div class="button-row spaced-top-tight"><button class="button secondary" type="button" data-action="validate-editor">Valida JSON</button><button class="button" type="button" data-action="save-editor" data-draft="${draft.id}" data-revision="${draft.revision}">Salva revisione</button></div><div id="editor-validation">${renderValidation(validation)}</div></section><aside class="panel"><p class="eyebrow">PROVENIENZA</p><h2>Campi leggibili</h2><div class="provenance">${(draft.provenance || []).length ? draft.provenance.map((entry) => `<div class="provenance-row"><code>${escapeHtml(entry.path)}</code><span class="status ${entry.status === 'confermato' ? 'good' : 'wait'}">${escapeHtml(entry.status.replace('_', ' '))}</span><small>${escapeHtml(entry.source)} · ${escapeHtml(entry.value)}</small></div>`).join('') : empty('Nessuna provenienza registrata.')}</div><hr class="divider"><p class="notice warning"><strong>Dati inferiti bloccati.</strong> Aggiungi prezzo, allergeni o traduzioni solo da una fonte confermata.</p></aside></div><div class="grid grid-equal spaced-top"><section class="panel tight"><p class="eyebrow">ORDINE SEZIONI</p><h2>Riordina senza riscrivere</h2><div id="reorder-list" class="reorder-list">${renderReorder(draft.menu)}</div><form data-form="add-section" class="inline-form spaced-top"><label class="field">Nuova sezione<input name="sectionName" required maxlength="80" placeholder="Nome esplicito dalla fonte"></label><button class="button secondary" type="submit">Aggiungi sezione</button></form></section><section class="panel tight"><p class="eyebrow">NUOVA VOCE</p><h2>Aggiungi con fonte</h2><form data-form="add-item"><div class="form-grid"><label class="field">Sezione<select name="sectionIndex">${draft.menu.sezioni.map((section, index) => `<option value="${index}">${escapeHtml(section.nome?.it || '')}</option>`).join('')}</select></label><label class="field">Prezzo esplicito<input name="price" inputmode="decimal" placeholder="es. 12,00"></label><label class="field full">Nome voce<input name="itemName" required maxlength="120" placeholder="Nome esplicito dalla fonte"></label></div><div class="form-actions"><button class="button secondary" type="submit">Aggiungi nell'editor</button></div></form></section></div>${request ? `<section class="panel"><p class="eyebrow">CHECKLIST</p><h2>Controlli visibili</h2><form data-form="review-draft"><input type="hidden" name="id" value="${draft.id}"><input type="hidden" name="revision" value="${draft.revision}"><div class="checklist">${checkRows(draft.checks)}</div><label class="field spaced-top-small">Evidenza approvazione scritta (se disponibile)<textarea name="approvalEvidence" maxlength="500" placeholder="Riferimento interno, senza inventare dati.">${escapeHtml(draft.checks?.clientApprovalEvidence || draft.approvalEvidence || '')}</textarea></label><p class="notice">Traduzioni aggiuntive sono solo proposte editabili: non vengono mai autoconfermate.</p><div class="form-actions"><button class="button" type="submit">Registra checklist</button><button class="button secondary" type="button" data-route="approvazioni">Vai alle approvazioni</button></div></form></section>` : ''}</div>`;
}
function checkRows(checks) {
  const rows = [
    ['prices', 'Prezzi verificati', 'Ho confrontato ogni importo con una fonte leggibile del locale.'],
    ['allergens', 'Allergeni verificati', 'Ho controllato che nessun allergene sia stato dedotto.'],
    ['languages', 'Lingue verificate', 'Ho verificato le lingue dichiarate e le traduzioni disponibili.'],
    ['clientApproval', 'Consenso scritto cliente', 'Ho registrato l’approvazione scritta del contenuto.']
  ];
  return rows.map(([name, title, note]) => `<label class="check-row"><input type="checkbox" name="${name}" ${checks?.[name] ? 'checked' : ''}><span><strong>${title}</strong><small>${note}</small></span></label>`).join('');
}

function renderPreview() {
  const draft = draftForRequest();
  if (!draft) return `<div class="view-wrap">${header('07 / VISUALIZZAZIONE', 'Anteprima', 'Renderer isolato: nessun URL o QR reale viene creato.')}<section class="panel">${empty('Genera una bozza per aprire l’anteprima.')}</section></div>`;
  const previous = draft.versions?.[0]?.menu || null;
  const diff = previous ? menuDiff(previous, draft.menu) : { changes: [], summary: { added: 0, removed: 0, changed: 0 } };
  return `<div class="view-wrap">${header('07 / VISUALIZZAZIONE', 'Anteprima', 'Mock isolato del menù; il QR è esclusivamente provvisorio e non pubblicabile.', `<label class="field">Pratica<select data-select-request>${requestOptions(selectedRequestId)}</select></label>`)}<div class="grid grid-2"><section class="panel"><p class="eyebrow">RENDERER MOCK</p><button class="button secondary small-button" type="button" data-action="preview-device">Passa a ${previewMode === 'phone' ? 'desktop' : 'telefono'}</button><div class="preview-device ${previewMode === 'desktop' ? 'desktop-preview' : ''}" aria-label="Anteprima simulata menu"><div class="preview-top"><small>RENMENU · ANTEPRIMA</small><h3>${escapeHtml(draft.menu.nome?.it || draft.menu.nome)}</h3></div>${draft.menu.sezioni.map((section) => `<div class="preview-section"><h4>${escapeHtml(section.nome?.it || section.nome)}</h4>${section.voci.map((item) => `<div class="preview-item"><span>${escapeHtml(item.nome?.it || item.nome)}</span><strong>${item.prezzo ? `€ ${escapeHtml(item.prezzo)}` : 'da verificare'}</strong></div>`).join('')}</div>`).join('')}<div class="preview-section"><div class="qr-placeholder" aria-label="QR provvisorio"><span>QR<br>PROVVISORIO<br>NON ATTIVO</span></div></div></div></section><aside class="panel"><p class="eyebrow">LINK E QR</p><h2>Mai una pubblicazione</h2><div class="notice danger"><strong>Link mock:</strong> <span class="mono">/menu/?m=${escapeHtml(draft.slug)}</span><br>Non è stato creato né verificato: non condividere.</div><div class="notice warning"><strong>QR provvisorio.</strong> È un segnaposto visivo, distinto da ogni QR distribuito al locale.</div><hr class="divider"><p class="eyebrow">DIFF EDITORIALE</p><h2>${previous ? 'Rispetto alla versione precedente' : 'Nessuna versione precedente'}</h2><div class="diff-list">${diff.changes.length ? diff.changes.map((change) => `<div class="diff-row"><strong>${escapeHtml(change.type.replaceAll('_', ' '))}</strong><span>${escapeHtml(change.label)}<br><code>${escapeHtml(change.before ?? '—')} → ${escapeHtml(change.after ?? '—')}</code></span></div>`).join('') : empty(previous ? 'Nessuna differenza rilevata.' : 'Il prossimo salvataggio consentirà un confronto.')}</div></aside></div></div>`;
}

function renderApprovals() {
  const draft = draftForRequest();
  if (!draft) return `<div class="view-wrap">${header('08 / CONFERME', 'Approvazioni', 'Checklist obbligatoria, PR di prova e pubblicazione simulata: nessun bypass.')}<section class="panel">${empty('Nessuna bozza selezionata.')}</section></div>`;
  const allChecks = ['prices','allergens','languages','clientApproval'].every((key) => draft.checks?.[key] === true) && Boolean(draft.checks?.clientApprovalEvidence || draft.approvalEvidence);
  const proposal = state.proposals.find((entry) => entry.draftId === draft.id);
  const readyForPublish = draft.status === 'pr_simulata' && proposal;
  return `<div class="view-wrap">${header('08 / CONFERME', 'Approvazioni', 'La voce e i messaggi non possono saltare questi due passaggi di conferma esplicita.', `<label class="field">Pratica<select data-select-request>${requestOptions(selectedRequestId)}</select></label>`)}<div class="grid grid-2"><section class="panel"><p class="eyebrow">CHECKLIST OBBLIGATORIA</p><h2>Revisione contenuto</h2><div class="checklist">${checkRows(draft.checks)}</div><p class="notice ${allChecks ? '' : 'warning'} spaced-top"><strong>${allChecks ? 'Checklist completa.' : 'Checklist incompleta.'}</strong> Solo la revisione visibile può segnare questi quattro valori.</p><div class="button-row spaced-top"><button class="button secondary" type="button" data-route="revisione">Torna alla checklist</button><button class="button" type="button" data-action="open-confirm" data-confirm-kind="pr" ${allChecks && draft.status === 'pronta_pr' ? '' : 'disabled'}>Prepara PR di prova</button></div></section><section class="panel"><p class="eyebrow">SECONDO PASSAGGIO</p><h2>Pubblicazione simulata</h2><div class="notice danger"><strong>Non pubblica nulla.</strong> Nessun menu, QR, repository o provider viene aggiornato da questa schermata.</div>${proposal ? `<div class="list-row spaced-top"><div class="list-main"><strong>PR di prova pronta</strong><small>${escapeHtml(proposal.branchName || `menu/${draft.slug}-demo`)} · ${escapeHtml(proposal.filePath || `menus/${draft.slug}.json`)}</small><small><span class="mono">${escapeHtml(proposal.id.slice(0, 8))}</span> · ${time(proposal.createdAt)}</small></div><span class="status info">mock</span></div>` : '<p class="muted">Prima completa la checklist e prepara una PR simulata.</p>'}<div class="button-row spaced-top"><button class="button danger" type="button" data-action="open-confirm" data-confirm-kind="publish" ${readyForPublish ? '' : 'disabled'}>Conferma pubblicazione simulata</button></div></section></div><section class="panel"><p class="eyebrow">STATO CORRENTE</p><h2>${escapeHtml(statusLabel(draft.status))}</h2><p class="muted">Cliente: ${escapeHtml(clientById(requestForDraft(draft)?.clientId)?.name || '—')} · File: <span class="mono">menus/${escapeHtml(draft.slug)}.json</span> · URL proposto: <span class="mono">/menu/?m=${escapeHtml(draft.slug)}</span> · nessuna pubblicazione reale.</p><p class="muted">Bozza <span class="mono">${escapeHtml(draft.slug)}</span> · revisione <span class="mono">${draft.revision}</span></p></section></div>`;
}

function renderNotifications() {
  const request = requestById();
  const notes = state.notifications.filter((item) => !item.requestId || item.requestId === selectedRequestId);
  const messages = state.messages.filter((item) => item.requestId === selectedRequestId);
  return `<div class="view-wrap">${header('09 / COMUNICAZIONI', 'Notifiche e bozze messaggi', 'Priorità e lettura sono mock locali; tutti i messaggi restano bozze e nessun provider è collegato.', `<label class="field">Pratica<select data-select-request>${requestOptions(selectedRequestId, true)}</select></label>`)}<div class="grid grid-equal"><section class="panel"><p class="eyebrow">NOTIFICA INTERNA</p><h2>Segnala un controllo</h2><form data-form="add-notification"><input type="hidden" name="requestId" value="${escapeHtml(selectedRequestId || '')}"><div class="form-grid"><label class="field">Canale<select name="channel"><option value="in_app">Interno</option><option value="email">Email mock</option><option value="whatsapp">WhatsApp mock</option><option value="telefono">Chiamata mock</option></select></label><label class="field">Priorità<select name="priority"><option value="normale" selected>Normale</option><option value="importante">Importante</option><option value="urgente">Urgente</option></select></label><label class="field">Scadenza facoltativa<input name="dueAt" type="datetime-local"></label><label class="field">Oggetto<input name="subject" required maxlength="100" placeholder="Es. prezzo da confermare"></label><label class="field full">Testo<textarea name="body" required maxlength="600" placeholder="Descrivi quale fonte manca."></textarea></label></div><div class="form-actions"><button class="button" type="submit">Aggiungi notifica</button></div></form></section><section class="panel"><p class="eyebrow">MESSAGGIO CLIENTE</p><h2>Prepara bozza</h2>${request ? `<form data-form="save-message"><input type="hidden" name="requestId" value="${escapeHtml(request.id)}"><label class="field">Canale mock<select name="channel"><option value="whatsapp">Bozza WhatsApp</option><option value="email">Bozza email</option></select></label><label class="field spaced-top-small">Testo<textarea name="body" required maxlength="900" placeholder="Ciao, puoi confermare…"></textarea></label><p class="notice warning">Il pulsante salva una bozza. Non esiste invio reale.</p><div class="form-actions"><button class="button" type="submit">Salva bozza, non inviare</button></div></form>` : empty('Seleziona una pratica per preparare una bozza.')}</section></div><section class="panel spaced-top"><p class="eyebrow">SIMULAZIONI DI CANALE</p><h2>Eventi in ingresso senza provider</h2><div class="grid grid-equal"><form data-form="mock-whatsapp"><label class="field">Numero fittizio collegato al cliente<input name="from" value="+390000000001" required></label><label class="field">Messaggio WhatsApp fittizio<textarea name="body" required placeholder="Vorrei aggiornare il mio menù"></textarea></label><button class="button secondary" type="submit">Simula messaggio entrante</button></form><form data-form="mock-call"><label class="field">Pratica<select name="requestId">${requestOptions(selectedRequestId)}</select></label><label class="field">Avviso per Riccardo<textarea name="message" required placeholder="Bozza urgente da rivedere"></textarea></label><button class="button secondary" type="submit">Simula chiamata non avviata</button></form></div><p class="muted small">Nessun webhook, WhatsApp, telefono o SMS viene contattato.</p></section><div class="grid grid-equal spaced-top"><section class="panel"><p class="eyebrow">NOTIFICHE</p><h2>Registro operativo</h2><div class="stack">${notes.length ? notes.map((note) => `<div class="list-row"><div class="list-main"><strong>${escapeHtml(note.subject)}</strong><small>${escapeHtml(note.body)} · priorità ${escapeHtml(note.priority || 'normale')}${note.dueAt ? ` · scade ${time(note.dueAt)}` : ''}</small></div><div class="list-meta"><span class="status ${note.priority === 'urgente' ? 'alert' : note.priority === 'importante' ? 'wait' : 'info'}">${escapeHtml(note.priority || 'normale')}</span><button class="button secondary small-button" type="button" data-action="mark-notification" data-notification-id="${note.id}" data-read="${note.readAt ? 'false' : 'true'}">${note.readAt ? 'Segna non letta' : 'Segna letta'}</button></div></div>`).join('') : empty('Nessuna notifica nel contesto selezionato.')}</div></section><section class="panel"><p class="eyebrow">BOZZE</p><h2>Non inviate</h2><div class="stack">${messages.length ? messages.map((message) => `<div class="list-row"><div class="list-main"><strong>${escapeHtml(message.channel)}</strong><small>${escapeHtml(message.body)} · ${time(message.createdAt)}</small></div><span class="status wait">bozza</span></div>`).join('') : empty('Nessuna bozza messaggio per questa pratica.')}</div></section></div></div>`;
}

function renderAudit() {
  const records = [...state.audit].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return `<div class="view-wrap">${header('10 / TRACCIABILITÀ', 'Registro audit', 'Azioni demo e API rimangono collegate a pratica, orario e sintesi.')}<section class="panel"><div class="panel-heading"><div><p class="eyebrow">EVENTI</p><h2>Registro immutabile lato interfaccia</h2></div><span class="capsule">${records.length} eventi</span></div><div class="timeline">${records.length ? records.map((record) => { const request = requestById(record.requestId); return `<article class="timeline-item"><time>${time(record.createdAt)} · ${escapeHtml(record.action)}</time><p><strong>${escapeHtml(record.summary)}</strong></p><small class="muted">${request ? escapeHtml(request.subject) : 'Contesto generale'} · <span class="mono">${escapeHtml(record.id.slice(0, 8))}</span></small></article>`; }).join('') : empty('Nessun evento registrato.')}</div></section></div>`;
}

function renderVoice() {
  const settings = voiceSettings();
  const context = requestById();
  const history = lastVoiceTranscript ? `<div class="voice-replies" aria-live="polite"><p><strong>Riccardo:</strong> ${escapeHtml(lastVoiceTranscript)}</p><p><strong>Jarvis:</strong> ${escapeHtml(lastVoiceReply)}</p></div>` : '<p class="muted">La conversazione apparirà qui, sempre in testo.</p>';
  return `<div class="view-wrap">${header('11 / VOCE', 'Voce e comandi', 'Microfono facoltativo del browser, trascrizione correggibile e sintesi italiana generica. Nessun comando approva o pubblica.')}<div class="grid grid-2"><section class="panel"><div class="voice-box"><div class="voice-orb" aria-hidden="true">///</div><p class="eyebrow">VOICE DESK · ${settings.enabled ? 'ATTIVO SOLO SU RICHIESTA' : 'SPENTO'}</p><h2>Parla o scrivi</h2><p class="muted">Alcuni browser possono elaborare il riconoscimento audio tramite un proprio servizio remoto: autorizzalo soltanto se lo desideri. RenMenu non salva l’audio; il testo resta correggibile prima dell’invio.</p><label class="check-row voice-setting"><input id="voice-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}><span><strong>Abilita voce browser</strong><small>Disattiva in qualsiasi momento; il microfono non è mai sempre acceso.</small></span></label><div class="voice-controls"><button class="button secondary voice-mic" type="button" data-action="voice-mic" ${!settings.enabled || !speechAvailable ? 'disabled' : ''}>Microfono</button><button class="button secondary" type="button" data-action="voice-stop">Ferma ascolto</button><button class="button voice-speak" type="button" data-action="voice-speak" ${!settings.enabled || !synthesisAvailable || !lastVoiceReply ? 'disabled' : ''}>Ascolta Jarvis</button></div><p class="notice warning voice-status" id="voice-status" role="status">${escapeHtml(voiceStatus)}</p><form data-form="voice"><label class="field">Pratica facoltativa<select name="requestId">${requestOptions(selectedRequestId, true)}</select></label><label class="field spaced-top-tight">Trascrizione correggibile<textarea id="voice-input" name="transcript" required maxlength="500" placeholder="Es. Cosa devo fare oggi?">${escapeHtml(lastVoiceTranscript)}</textarea></label><p class="muted small">${speechAvailable ? 'Riconoscimento vocale disponibile, avviato solo con il tasto Microfono.' : 'SpeechRecognition non disponibile: usa il testo. La sintesi può funzionare separatamente.'}</p><div class="form-actions"><button class="button" type="submit">Interpreta senza eseguire</button></div></form>${history}</div></section><aside class="panel"><p class="eyebrow">PREFERENZE</p><h2>Voce originale RenMenu</h2><label class="field voice-setting">Velocità <output id="voice-rate-output">${settings.rate.toFixed(1)}×</output><input id="voice-rate" type="range" min="0.6" max="1.4" step="0.1" value="${settings.rate}"></label><label class="field voice-setting">Volume <output id="voice-volume-output">${Math.round(settings.volume * 100)}%</output><input id="voice-volume" type="range" min="0" max="1" step="0.1" value="${settings.volume}"></label><label class="field">Motore voce<select id="voice-provider"><option value="browser">Sistema / browser</option><option value="provider" disabled>Provider TTS non configurato</option></select></label><div class="notice spaced-top"><strong>Guardrail:</strong> “Pubblica il menù” apre solo una richiesta di conferma a schermo. Non esegue PR, invio, chiamata o merge.</div><div class="button-row spaced-top"><button class="button secondary" type="button" data-route="approvazioni">Apri conferme</button><button class="button secondary" type="button" data-route="registro">Vedi registro</button></div></aside></div></div>`;
}

function renderView() {
  const renderers = { command: renderCommand, richieste: renderRequests, clienti: renderClients, materiali: renderMaterials, builder: renderBuilder, revisione: renderReview, anteprima: renderPreview, approvazioni: renderApprovals, notifiche: renderNotifications, registro: renderAudit, voce: renderVoice };
  view.innerHTML = renderers[activeView]();
  document.title = `${navItems.find(([id]) => id === activeView)?.[2] || 'Control Room'} · RenMenu`;
}
function render() {
  if (!state) return;
  if (!requestById()) selectedRequestId = state.requests[0]?.id || null;
  if (!clientById(selectedClientId)) selectedClientId = requestById()?.clientId || state.clients[0]?.id || null;
  modeBadge.textContent = isDemoMode ? 'DEMO LOCALE · OFFLINE' : modeLabel;
  renderNavigation();
  renderView();
}
function routeFromHash() {
  const target = location.hash.replace(/^#/, '');
  return validViews.has(target) ? target : 'command';
}
function navigate(target) {
  if (!validViews.has(target)) return;
  mobileMenuOpen = false;
  if (location.hash !== `#${target}`) location.hash = target;
  else { activeView = target; render(); $('#main-content').focus(); }
}

async function refresh() {
  state = await loadState();
  if (!state || !Array.isArray(state.requests)) throw new Error('Stato API non conforme al contratto.');
  if (!requestById()) selectedRequestId = state.requests[0]?.id || null;
  render();
}
async function doAction(type, payload, successMessage) {
  await performAction(type, payload);
  await refresh(); // Contract: the page reloads state after every action.
  if (successMessage) toast(successMessage);
}
async function doUpload(requestId, file) {
  await uploadFile(requestId, file);
  await refresh();
  toast('Materiale registrato nel contesto selezionato.');
}

function confirmationSummary(kind, draft) {
  const request = requestForDraft(draft);
  const client = clientById(request?.clientId);
  const files = state.materials.filter((item) => item.requestId === draft.requestId && !item.archivedAt).map((item) => item.filename);
  const changes = draft.versions?.[0] ? menuDiff(draft.versions[0].menu, draft.menu).changes : [];
  const count = draft.menu?.sezioni?.reduce((sum, section) => sum + (section.voci?.length || 0), 0) || 0;
  const lines = [
    `Cliente: ${client?.name || 'da verificare'}. Pratica: ${request?.subject || draft.requestId}.`,
    `Menù: ${draft.slug} (${count} voci); file coinvolto: menus/${draft.slug}.json.`,
    `Materiali: ${files.length ? files.join(', ') : 'solo testo della pratica'}.`,
    `URL proposto, NON attivo: /menu/?m=${draft.slug}.`,
    `Differenze rispetto alla versione salvata: ${changes.length ? changes.map((item) => `${item.label}: ${item.before ?? '—'} → ${item.after ?? '—'}`).join('; ').slice(0, 400) : 'nessuna versione precedente confrontabile; il menu live non è stato letto'}.`,
    kind === 'pr' ? 'Esito: crea solo un record di PR mock. Nessun branch o commit GitHub. Annulla è disponibile.' :
      'Esito: seconda conferma, pubblicazione SOLO SIMULATA. Nessun merge, deploy, invio o QR reale. Annulla è disponibile.'
  ];
  return lines.join('\n');
}

async function handleClick(event) {
  const trigger = event.target.closest('[data-action], [data-route], [data-select-request]');
  if (!trigger || trigger.disabled) return;
  if (trigger.dataset.selectClient !== undefined) {
    event.preventDefault();
    selectedClientId = trigger.dataset.selectClient || null;
    const first = state.requests.find((request) => request.clientId === selectedClientId);
    if (first) selectedRequestId = first.id;
    if (trigger.dataset.route) navigate(trigger.dataset.route); else render();
    return;
  }
  if (trigger.dataset.selectRequest !== undefined) {
    event.preventDefault();
    if (trigger.dataset.selectRequest) { selectedRequestId = trigger.dataset.selectRequest; selectedClientId = requestById(selectedRequestId)?.clientId || selectedClientId; }
    if (trigger.dataset.route) navigate(trigger.dataset.route); else render();
    return;
  }
  if (trigger.dataset.route) { event.preventDefault(); navigate(trigger.dataset.route); return; }
  const action = trigger.dataset.action;
  if (!action) return;
  event.preventDefault();
  if (action === 'toggle-mobile-menu') { mobileMenuOpen = !mobileMenuOpen; renderNavigation(); return; }
  if (action === 'reset-demo') {
    if (!isDemoMode) throw new Error('Ripristino disponibile solo in demo locale.');
    if (!window.confirm('Ripristinare soltanto i dati fittizi di questa demo locale?')) return;
    resetDemoState(); await refresh(); toast('Demo fittizia ripristinata.'); return;
  }
  if (action === 'voice-mic') {
    if (!window.confirm('Il browser potrebbe elaborare la tua voce con un servizio esterno. Vuoi avviare il microfono solo per questa frase?')) return;
    listen({ onTranscript: (text) => { const field = $('#voice-input'); if (field) field.value = text; },
      onStatus: (message) => { voiceStatus = message; const label = $('#voice-status'); if (label) label.textContent = message; } });
    return;
  }
  if (action === 'voice-stop') { stopListening(); voiceStatus = 'Ascolto fermato.'; const label = $('#voice-status'); if (label) label.textContent = voiceStatus; return; }
  if (action === 'voice-speak') { speak(lastVoiceReply); return; }
  if (action === 'preview-device') { previewMode = previewMode === 'phone' ? 'desktop' : 'phone'; render(); return; }
  if (action === 'mark-notification') {
    await doAction('markNotificationRead', { id: trigger.dataset.notificationId, read: trigger.dataset.read === 'true' }, 'Stato di lettura aggiornato.');
    return;
  }
  if (action === 'archive-material') {
    const material = state.materials.find((entry) => entry.id === trigger.dataset.materialId);
    const linkedRequest = state.requests.find((entry) => entry.id === material?.requestId);
    const linkedClient = state.clients.find((entry) => entry.id === linkedRequest?.clientId);
    if (!material) throw new Error('Materiale non disponibile.');
    openConfirmation({ title: 'Archivia materiale demo',
      copy: `Cliente: ${linkedClient?.name || 'da verificare'}. Pratica: ${linkedRequest?.subject || material.requestId}.\nFile: ${material.filename} (${material.mime}).\nEsito: archiviazione logica reversibile solo con una futura procedura amministrativa. Il binario resta privato, non viene cancellato né pubblicato. La checklist già approvata verrà azzerata.`,
      phrase: 'ARCHIVIA MATERIALE', button: 'Archivia materiale', type: 'archiveMaterial', payload: { id: material.id, confirmation: 'ARCHIVIA MATERIALE' }, success: 'Materiale demo archiviato.' });
    return;
  }
  if (action === 'generate-draft') {
    const request = requestById();
    if (!request) throw new Error('Seleziona una pratica prima di generare.');
    await doAction('generateDraft', { requestId: request.id }, 'Bozza estratta senza dati inferiti.');
    return;
  }
  if (action === 'validate-editor') {
    const menu = editorMenu();
    if (!menu) return;
    const output = $('#editor-validation');
    if (output) output.innerHTML = renderValidation(validateMenu(menu));
    return;
  }
  if (action === 'save-editor') {
    const menu = editorMenu();
    if (!menu) return;
    const check = validateMenu(menu);
    const output = $('#editor-validation');
    if (output) output.innerHTML = renderValidation(check);
    if (!check.valid) { toast('Correggi gli errori bloccanti prima di salvare.', 'error'); return; }
    await doAction('saveDraft', { id: trigger.dataset.draft, revision: Number(trigger.dataset.revision), menu, slug: menu.id }, 'Revisione salvata; checklist azzerata.');
    return;
  }
  if (action === 'move-section') {
    const menu = editorMenu();
    if (!menu) return;
    const index = Number(trigger.dataset.index); const destination = index + Number(trigger.dataset.direction);
    if (destination < 0 || destination >= menu.sezioni.length) return;
    [menu.sezioni[index], menu.sezioni[destination]] = [menu.sezioni[destination], menu.sezioni[index]];
    writeEditor(menu);
    const list = $('#reorder-list'); if (list) list.innerHTML = renderReorder(menu);
    return;
  }
  if (action === 'open-confirm') {
    const draft = draftForRequest();
    if (!draft) return;
    if (trigger.dataset.confirmKind === 'pr') openConfirmation({ title: 'Prepara una PR di prova', copy: confirmationSummary('pr', draft), phrase: 'CONFERMO PR DI PROVA', button: 'Prepara PR simulata', type: 'preparePr', payload: { id: draft.id, revision: draft.revision, confirmation: 'CONFERMO PR DI PROVA' }, success: 'PR di prova registrata: nessun repository modificato.' });
    if (trigger.dataset.confirmKind === 'publish') openConfirmation({ title: 'Conferma pubblicazione simulata', copy: confirmationSummary('publish', draft), phrase: 'CONFERMO PUBBLICAZIONE SIMULATA', button: 'Registra simulazione', type: 'simulatePublish', payload: { id: draft.id, revision: draft.revision, confirmation: 'CONFERMO PUBBLICAZIONE SIMULATA' }, success: 'Pubblicazione simulata registrata; nessuna pubblicazione reale.' });
  }
}

async function handleSubmit(event) {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  const kind = form.dataset.form;
  if (kind === 'create-client') { await doAction('createClient', Object.fromEntries(data), 'Cliente demo creato.'); selectedClientId = state.clients[0]?.id || selectedClientId; render(); return; }
  if (kind === 'update-client') { await doAction('updateClient', { id: data.get('id'), revision: Number(data.get('revision')), patch: { plan: data.get('plan'), contactName: data.get('contactName'), internalNotes: data.get('internalNotes') } }, 'Scheda cliente demo aggiornata.'); return; }
  if (kind === 'create-request') { await doAction('createRequest', Object.fromEntries(data), 'Nuova pratica creata.'); selectedRequestId = state.requests[0]?.id || selectedRequestId; selectedClientId = requestById(selectedRequestId)?.clientId || selectedClientId; render(); return; }
  if (kind === 'update-source') {
    await doAction('updateRequest', { id: data.get('id'), revision: Number(data.get('revision')), patch: { sourceText: data.get('sourceText'), sourceChannel: data.get('sourceChannel'), kind: data.get('kind'), internalNotes: data.get('internalNotes'), nextStep: data.get('nextStep'), followUpAt: data.get('followUpAt') } }, 'Sorgente aggiornata.');
    return;
  }
  if (kind === 'update-request-meta') { await doAction('updateRequest', { id: data.get('id'), revision: Number(data.get('revision')), patch: { ...(data.get('status') ? { status: data.get('status') } : {}), nextStep: data.get('nextStep'), internalNotes: data.get('internalNotes') } }, 'Pratica aggiornata.'); return; }
  if (kind === 'upload-material') { const file = data.get('file'); await doUpload(selectedRequestId, file); return; }
  if (kind === 'add-section') {
    const menu = editorMenu(); if (!menu) return;
    menu.sezioni.push({ nome: { it: String(data.get('sectionName')).trim() }, voci: [] });
    writeEditor(menu); const list = $('#reorder-list'); if (list) list.innerHTML = renderReorder(menu); form.reset(); toast('Sezione aggiunta nell’editor: salva per registrarla.'); return;
  }
  if (kind === 'add-item') {
    const menu = editorMenu(); if (!menu) return;
    const section = menu.sezioni[Number(data.get('sectionIndex'))];
    if (!section) throw new Error('Sezione non disponibile.');
    const price = String(data.get('price') || '').trim();
    section.voci.push({ nome: { it: String(data.get('itemName')).trim() }, prezzo: price });
    writeEditor(menu); const list = $('#reorder-list'); if (list) list.innerHTML = renderReorder(menu); form.reset(); toast('Voce aggiunta nell’editor: prezzo vuoto = da verificare.'); return;
  }
  if (kind === 'review-draft') {
    const checks = ['prices', 'allergens', 'languages', 'clientApproval'].reduce((out, key) => ({ ...out, [key]: data.get(key) === 'on' }), {});
    await doAction('reviewDraft', { id: data.get('id'), revision: Number(data.get('revision')), checks, approvalEvidence: data.get('approvalEvidence') || '' }, 'Checklist registrata.'); return;
  }
  if (kind === 'mock-whatsapp') { await doAction('mockIncomingWhatsapp', Object.fromEntries(data), 'WhatsApp fittizio ricevuto: nessun webhook reale.'); selectedRequestId = state.requests[0]?.id || selectedRequestId; render(); return; }
  if (kind === 'mock-call') { await doAction('mockCall', Object.fromEntries(data), 'Chiamata simulata: non avviata.'); return; }
  if (kind === 'add-notification') { await doAction('addNotification', Object.fromEntries(data), 'Notifica mock aggiunta.'); return; }
  if (kind === 'save-message') { await doAction('sendMessage', Object.fromEntries(data), 'Bozza salvata: non è stata inviata.'); return; }
  if (kind === 'voice') {
    const transcript = String(data.get('transcript') || '').trim();
    const answer = interpretVoice(transcript, { requests: state.requests, clients: state.clients, messages: state.messages,
      selectedRequestId, draft: draftForRequest(), client: selectedClient() });
    await doAction('logVoice', Object.fromEntries(data), 'Comando registrato: nessuna conferma aggirata.');
    lastVoiceTranscript = transcript; lastVoiceReply = answer.reply;
    voiceStatus = 'Risposta pronta. Nessuna azione esterna eseguita.';
    if (answer.requestId) selectedRequestId = answer.requestId;
    if (answer.target && answer.target !== activeView) navigate(answer.target);
    else render();
    toast(answer.reply);
    return;
  }
}

function handleInput(event) {
  if (event.target.id === 'voice-rate') {
    const settings = configureVoice({ rate: event.target.value });
    $('#voice-rate-output').textContent = `${settings.rate.toFixed(1)}×`; return;
  }
  if (event.target.id === 'voice-volume') {
    const settings = configureVoice({ volume: event.target.value });
    $('#voice-volume-output').textContent = `${Math.round(settings.volume * 100)}%`; return;
  }
  if (event.target.id !== 'client-filter') return;
  clientFilter = event.target.value;
  const list = $('#client-list');
  if (list) list.innerHTML = renderClientRows();
}
function handleSelectChange(event) {
  if (event.target.id === 'voice-enabled') {
    const settings = configureVoice({ enabled: event.target.checked });
    voiceStatus = settings.enabled ? 'Voce abilitata; il microfono si avvia solo dopo una seconda scelta esplicita.' : 'Voce disattivata.';
    render(); return;
  }
  if (!event.target.matches('select[data-select-request]')) return;
  selectedRequestId = event.target.value || null;
  render();
}
function openConfirmation(config) {
  if (!dialog?.showModal) { toast('Il browser non supporta la conferma sicura richiesta.', 'error'); return; }
  pendingConfirm = config;
  $('#confirm-title').textContent = config.title;
  $('#confirm-copy').textContent = config.copy;
  $('#confirm-submit').textContent = config.button;
  dialogInput.value = '';
  dialogInput.placeholder = config.phrase;
  dialog.showModal();
  window.setTimeout(() => dialogInput.focus(), 0);
}

primaryNav.addEventListener('click', () => { mobileMenuOpen = false; });
document.addEventListener('click', (event) => { handleClick(event).catch((error) => toast(error.message || 'Operazione non riuscita.', 'error')); });
view.addEventListener('submit', (event) => { handleSubmit(event).catch((error) => toast(error.message || 'Operazione non riuscita.', 'error')); });
view.addEventListener('input', handleInput);
view.addEventListener('change', handleSelectChange);
themeToggle.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
dialogForm.addEventListener('submit', (event) => {
  const submitter = event.submitter;
  if (submitter?.value !== 'confirm') return;
  if (!pendingConfirm || dialogInput.value.trim() !== pendingConfirm.phrase) {
    event.preventDefault();
    toast(`Scrivi esattamente: ${pendingConfirm?.phrase || ''}`, 'error');
    dialogInput.focus();
  }
});
dialog.addEventListener('close', () => {
  const configuration = pendingConfirm;
  pendingConfirm = null;
  if (dialog.returnValue !== 'confirm' || !configuration) return;
  doAction(configuration.type, configuration.payload, configuration.success).catch((error) => toast(error.message || 'Operazione non riuscita.', 'error'));
});
dialog.addEventListener('cancel', () => { pendingConfirm = null; });
window.addEventListener('hashchange', () => { activeView = routeFromHash(); mobileMenuOpen = false; render(); $('#main-content').focus(); });

async function init() {
  initializeTheme();
  if (!isAuthorizedHost) { renderUnavailable(); return; }
  activeView = routeFromHash();
  try { await refresh(); } catch (error) { renderAccessError(error); }
}
init();

import { fetchMaterialPreview, isAuthorizedHost, isDemoMode, isPreviewableMime, loadState, modeLabel, performAction, uploadFile } from './api.js';
import { menuDiff, validateMenu } from './model.js';
import { criticalFields, reviewIssues, suggestedEvidence } from './editorial.js';
import { PLAN_RULES, REQUEST_CATEGORIES, categoryByCode, draftBlocker, planIssues, planWarnings } from './service-rules.js';
import { provisionalQrSvg, provisionalTarget } from './provisional-qr.js';
import { mountPdfPreview } from './pdf-preview.js';
import { extractPdfText } from './material-extract.js';
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
const materialViewer = $('#material-viewer');
const materialViewerTitle = $('#material-viewer-title');
const materialViewerMeta = $('#material-viewer-meta');
const materialViewerContent = $('#material-viewer-content');
const materialViewerComparison = $('#material-viewer-comparison');
const materialViewerExternal = $('#material-viewer-external');
const materialViewerZoom = $('#material-viewer-zoom');
const materialViewerZoomLabel = $('#material-viewer-zoom-label');
const VOICE_HISTORY_KEY = 'renmenu-control-room-demo-voice-v1';
const VOICE_HISTORY_LIMIT = 12;
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
let voiceHistory = [];
let voiceProposal = null;
let materialPreview = null;
let pdfPreviewController = null;
let aiPreview = null;
let aiBusy = false;
const reviewEvidenceCache = new Map();
const DEMO_PDF_ID = '5eae22bc-7a50-4bd2-8b8a-000000000403';

function statusLabel(status) {
  return ({ nuova: 'Nuova', in_lavorazione: 'In lavorazione', in_revisione: 'In revisione', in_attesa: 'In attesa', materiale_ricevuto: 'Materiale ricevuto', in_analisi: 'In analisi', dati_da_confermare: 'Dati da confermare', bozza_pronta: 'Bozza pronta', approvata: 'Approvata nel mock', pronta_pubblicazione: 'Pronta nel mock', archiviata: 'Archiviata', chiusa: 'Chiusa', completata: 'Simulazione completata · niente online', bozza: 'Bozza mock', revisione: 'Bozza mock in revisione', pronta_pr: 'PR mock pronta', pr_simulata: 'PR mock simulata', pubblicazione_simulata: 'Pubblicazione simulata · niente online' }[status] || status || '—');
}
function statusTone(status) {
  if (['completata', 'pubblicazione_simulata'].includes(status)) return 'info'; // Simulazione: mai verde "online".
  if (['in_attesa', 'bozza'].includes(status)) return 'wait';
  if (['nuova'].includes(status)) return 'alert';
  return 'info';
}
function status(status) { return `<span class="status ${statusTone(status)}">${escapeHtml(statusLabel(status))}</span>`; }
// Pratiche archiviate nascoste di default (pulizia 2026-10-02); la pratica selezionata resta sempre visibile.
let showArchived = false;
function visibleRequests() { return (state?.requests || []).filter((request) => showArchived || request.status !== 'archiviata' || request.id === selectedRequestId); }
function archivedCount() { return (state?.requests || []).filter((request) => request.status === 'archiviata').length; }
function requestById(id = selectedRequestId) { return state?.requests.find((request) => request.id === id) || null; }
function clientById(id) { return state?.clients.find((client) => client.id === id) || null; }
function selectedClient() { return clientById(selectedClientId) || clientById(requestById()?.clientId) || null; }
function draftForRequest(id = selectedRequestId) { return state?.drafts.find((draft) => draft.requestId === id) || null; }
function requestForDraft(draft) { return draft ? requestById(draft.requestId) : null; }
function requestOptions(selected = selectedRequestId, includeEmpty = false) {
  const empty = includeEmpty ? '<option value="">Nessuna pratica</option>' : '';
  return `${empty}${visibleRequests().map((request) => `<option value="${escapeHtml(request.id)}" ${request.id === selected ? 'selected' : ''}>${escapeHtml(request.subject)}</option>`).join('')}`;
}
function clientOptions(selected = '') { return (state?.clients || []).map((client) => `<option value="${escapeHtml(client.id)}" ${client.id === selected ? 'selected' : ''}>${escapeHtml(client.name)}</option>`).join(''); }
function categoryOptions(selected = 'nuovo_standard', legacyKind = '') {
  const legacy = !selected ? `<option value="" selected>Da classificare${legacyKind ? ` (tipo precedente: ${escapeHtml(legacyKind)})` : ''}</option>` : '';
  return legacy + REQUEST_CATEGORIES.map((entry) => `<option value="${entry.code}" ${entry.code === selected ? 'selected' : ''}>${escapeHtml(entry.label)}</option>`).join('');
}
function requestTypeLabel(request) { return categoryByCode(request?.category)?.label || `${request?.kind || '—'} · da classificare`; }
// Aggiornamento di un menu attivo: vale il piano registrato nella scheda cliente.
function effectivePlan(request) {
  if (PLAN_RULES[request?.plan] || !['aggiornamento', 'prezzo'].includes(request?.kind)) return request?.plan;
  return state.clients.find((entry) => entry.id === request.clientId)?.plan || request?.plan;
}
function planRulesPanel(request, draft) {
  if (!request) return '';
  const plan = effectivePlan(request);
  const rule = PLAN_RULES[plan];
  const blocker = draftBlocker(plan);
  const issues = draft ? planIssues(draft.menu, plan, draft.checks) : [];
  const warnings = draft ? planWarnings(draft.menu, plan) : [];
  const languages = rule ? (rule.allowedLanguages ? rule.allowedLanguages.join(' + ').toUpperCase() : `fino a ${rule.maxLanguages}`) : '—';
  return `<section class="panel"><div class="panel-heading"><div><p class="eyebrow">REGOLE DEL PIANO</p><h2>${escapeHtml(rule?.label || 'Piano da confermare')}</h2></div><span class="capsule">${escapeHtml(requestTypeLabel(request))}</span></div>${blocker ? `<p class="notice danger"><strong>Bozza bloccata.</strong> ${escapeHtml(blocker)}</p>` : `<p class="muted">${escapeHtml(rule.summary)}</p><div class="data-grid"><div><small>LINGUE CONSENTITE</small><strong>${escapeHtml(languages)}</strong></div><div><small>APPROVAZIONE CREATIVA</small><strong>${rule.creativeApproval ? 'Obbligatoria' : 'Non richiesta'}</strong></div><div><small>PUBBLICAZIONE</small><strong>Solo con conferma di Riccardo</strong></div></div>`}${draft && issues.length ? `<div class="stack spaced-top-small">${issues.map((issue) => `<div class="notice warning">${escapeHtml(issue)}</div>`).join('')}</div>` : ''}${draft && warnings.length ? `<div class="stack spaced-top-small">${warnings.map((warning) => `<div class="notice warning"><strong>Avviso, non bloccante.</strong> ${escapeHtml(warning)}</div>`).join('')}</div>` : ''}${draft && !blocker && !issues.length && !warnings.length ? '<p class="notice spaced-top-small">Bozza coerente con il piano. Restano le conferme della checklist.</p>' : ''}</section>`;
}
function planOptions(selected = 'da_definire') { return [['da_definire','Da definire'],['standard','Standard'],['annuale','Annuale'],['premium','Premium']].map(([value,label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join(''); }
function requestStatusOptions(selected = 'nuova') { const protectedOption = ['approvata','pronta_pubblicazione','completata'].includes(selected) ? `<option value="${selected}" selected>${escapeHtml(statusLabel(selected))} · protetto</option>` : ''; return protectedOption + [['nuova','Nuova'],['materiale_ricevuto','Materiale ricevuto'],['in_analisi','In analisi'],['dati_da_confermare','Dati da confermare'],['bozza_pronta','Bozza pronta'],['in_revisione','In revisione'],['in_attesa','In attesa cliente'],['archiviata','Archiviata'],['chiusa','Chiusa']].map(([value,label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join(''); }
function channelOptions(selected = 'manuale') { return [['manuale','Manuale'],['email','Email'],['whatsapp','WhatsApp'],['telefono','Telefono'],['instagram','Instagram'],['altro','Altro']].map(([value,label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join(''); }
function header(eyebrow, title, description, actions = '') {
  return `<header class="view-header"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p class="view-subtitle">${escapeHtml(description)}</p></div>${actions ? `<div class="context-bar">${actions}</div>` : ''}</header>`;
}
function demoNotice() {
  return isDemoMode
    ? '<div class="notice"><strong>Demo locale attiva.</strong> Dati sintetici in localStorage; offline compatibile se lo storage è disponibile. Nessuna chiamata remota, invio, PR o pubblicazione reale.</div>'
    : '<div class="notice"><strong>Staging privato.</strong> I dati di staging sono caricati solo dall’API same-origin protetta: record D1 e file R2 restano privati. Le PR e le pubblicazioni restano mock e richiedono sempre conferma dedicata.</div>';
}
function empty(text) { return `<p class="empty">${escapeHtml(text)}</p>`; }
function dateInputValue(value) { return /^\d{4}-\d{2}-\d{2}/.test(String(value || '')) ? String(value).slice(0, 10) : ''; }
function isSameLocalDay(value, reference = new Date()) {
  const date = new Date(value || '');
  return !Number.isNaN(date.valueOf()) && date.getFullYear() === reference.getFullYear() && date.getMonth() === reference.getMonth() && date.getDate() === reference.getDate();
}
function isDueSoon(value, reference = new Date()) {
  const date = new Date(value || '');
  if (Number.isNaN(date.valueOf())) return false;
  const start = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
  const end = new Date(start); end.setDate(end.getDate() + 30);
  return date >= start && date <= end;
}
function cleanVoiceText(value, limit = 700) {
  return String(value || '').replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
function restoreVoiceHistory() {
  voiceHistory = [];
  if (!isDemoMode) return;
  try {
    const raw = JSON.parse(sessionStorage.getItem(VOICE_HISTORY_KEY) || '[]');
    if (!Array.isArray(raw)) return;
    voiceHistory = raw.filter((entry) => ['user', 'assistant'].includes(entry?.role) && typeof entry?.text === 'string')
      .slice(-VOICE_HISTORY_LIMIT).map((entry) => ({ role: entry.role, text: cleanVoiceText(entry.text, entry.role === 'user' ? 500 : 700), at: String(entry.at || '') }));
    lastVoiceTranscript = [...voiceHistory].reverse().find((entry) => entry.role === 'user')?.text || '';
    lastVoiceReply = [...voiceHistory].reverse().find((entry) => entry.role === 'assistant')?.text || '';
  } catch (_) { voiceHistory = []; }
}
function persistVoiceHistory() {
  if (!isDemoMode) return;
  try { sessionStorage.setItem(VOICE_HISTORY_KEY, JSON.stringify(voiceHistory.slice(-VOICE_HISTORY_LIMIT))); } catch (_) { /* cronologia demo non essenziale */ }
}
function appendVoiceTurn(transcript, reply) {
  voiceHistory = [...voiceHistory,
    { role: 'user', text: cleanVoiceText(transcript, 500), at: new Date().toISOString() },
    { role: 'assistant', text: cleanVoiceText(reply, 700), at: new Date().toISOString() }
  ].filter((entry) => entry.text).slice(-VOICE_HISTORY_LIMIT);
  persistVoiceHistory();
}
function clearVoiceHistory() {
  voiceHistory = []; voiceProposal = null; lastVoiceTranscript = ''; lastVoiceReply = '';
  if (isDemoMode) { try { sessionStorage.removeItem(VOICE_HISTORY_KEY); } catch (_) { /* non essenziale */ } }
}
function materialPreviewControl(material) {
  if (material.archivedAt) return '<span class="status wait">archiviato</span>';
  if (isDemoMode && material.id !== DEMO_PDF_ID) return '<span class="capsule">solo metadati demo</span>';
  if (!isPreviewableMime(material.mime)) return '<span class="capsule">viewer non supportato</span>';
  return `<button class="button secondary small-button" type="button" data-action="preview-material" data-material-id="${escapeHtml(material.id)}" aria-label="Apri nel viewer privato ${escapeHtml(material.filename)}">Apri viewer</button>`;
}
function materialStorageSummary(material) {
  if (isDemoMode) return material.id === DEMO_PDF_ID ? 'PDF fittizio statico della demo; non è un file cliente.' : 'Metadati demo; il binario dell’upload non viene conservato.';
  if (material.source === 'caricamento_manuale') return 'Record D1 di staging privato · upload R2 di staging privato acquisito manualmente.';
  return `Record D1 di staging privato${material.source ? ` · origine ${material.source}.` : '.'}`;
}
function materialProcessingLabel(value) {
  return ({ testo_disponibile: 'testo disponibile', da_trascrivere: 'da trascrivere', needs_review: 'da verificare' }[value] || value || 'stato non indicato');
}
function analysisForMaterial(materialId) { return (state?.analyses || []).find((analysis) => analysis?.materialId === materialId) || null; }
function analysisStatusLabel(value) { return ({ needs_review: 'da verificare', reviewed: 'verificata', manual: 'manuale' }[value] || value || 'nessuna trascrizione'); }
function materialListRows(materials, options = {}) {
  return materials.length ? materials.map((material) => `<div class="list-row material-row"><div class="list-main"><strong>${escapeHtml(material.filename)}</strong><small>${escapeHtml(material.mime)} · ${Math.ceil(Number(material.size || 0) / 1024)} KB · ${time(material.createdAt)} · ${escapeHtml(materialStorageSummary(material))}${material.processingStatus ? ` · ${escapeHtml(materialProcessingLabel(material.processingStatus))}` : ''}${(material.textPreview || material.excerpt) ? ` · “${escapeHtml((material.textPreview || material.excerpt).slice(0, 90))}”` : ''}</small></div><div class="list-meta">${isDemoMode ? '<span class="capsule">demo</span>' : '<span class="status good">staging privato</span>'}${materialPreviewControl(material)}${options.allowArchive !== false && !material.archivedAt ? `<button class="button secondary small-button" type="button" data-action="archive-material" data-material-id="${escapeHtml(material.id)}">Archivia</button>` : ''}</div></div>`).join('') : empty(options.emptyText || 'Nessun materiale associato alla pratica selezionata.');
}
function renderMaterialAnalysis(material, request) {
  if (isDemoMode) return `<article class="material-analysis"><div><p class="eyebrow">${analysis?.provenance?.[0]?.method?.startsWith('jarvis') ? 'LETTURA DI JARVIS' : 'TRASCRIZIONE'}</p><h3>${escapeHtml(material.filename)}</h3><p class="muted small">Demo: gli upload aggiunti conservano solo metadati. Non viene salvato un binario, non viene calcolato alcun hash e non esiste OCR o chiamata esterna. Il PDF fittizio, se presente, è solo una fixture statica.</p></div><span class="capsule">solo demo</span></article>`;
  const analysis = analysisForMaterial(material.id);
  const warnings = Array.isArray(analysis?.warnings) ? analysis.warnings : [];
  const hash = analysis?.sourceSha256 || '';
  return `<article class="material-analysis"><div class="material-analysis-heading"><div><p class="eyebrow">${analysis?.provenance?.[0]?.method?.startsWith('jarvis') ? 'LETTURA DI JARVIS' : 'TRASCRIZIONE'}</p><h3>${escapeHtml(material.filename)}</h3></div><span class="status ${analysis ? (analysis.status === 'needs_review' ? 'wait' : 'good') : 'info'}">${escapeHtml(analysisStatusLabel(analysis?.status))}</span></div><div class="material-analysis-meta"><span><strong>Revisione pratica richiesta:</strong> <code>${escapeHtml(request.revision)}</code></span><span><strong>Hash fonte SHA-256:</strong> <code>${escapeHtml(hash || 'sarà calcolato al salvataggio')}</code></span></div>${analysis ? `<p class="muted small">Ultima trascrizione registrata ${analysis.createdAt ? time(analysis.createdAt) : 'in data non disponibile'} · provenienza ${escapeHtml(analysis.provenance?.[0]?.method || 'manuale')} · revisione umana ${analysis.provenance?.[0]?.reviewed ? 'registrata' : 'ancora necessaria'}.</p>` : '<p class="muted small">Nessuna trascrizione registrata per questo materiale.</p>'}${warnings.length ? `<div class="notice warning material-analysis-warning">${warnings.map((warning) => escapeHtml(warning)).join(' ')}</div>` : ''}<form data-form="set-material-transcript" class="spaced-top"><input type="hidden" name="materialId" value="${escapeHtml(material.id)}"><input type="hidden" name="requestRevision" value="${escapeHtml(request.revision)}"><label class="field">Testo trascritto manualmente<textarea name="text" required minlength="5" maxlength="50000" placeholder="Trascrivi solo ciò che puoi leggere e confrontare con il file originale.">${escapeHtml(analysis?.sourceText || '')}</textarea></label><p class="notice warning spaced-top-small"><strong>Fonte da verificare.</strong> Puoi scriverlo tu o farlo leggere a Jarvis (foto: due letture indipendenti, entrano solo le voci concordi; PDF: testo del file). Va sempre confrontato con il file originale. Il salvataggio aggiorna la revisione della pratica e invalida le conferme editoriali.</p><div class="form-actions"><button class="button" type="submit">Salva trascrizione manuale</button>${material.mime === 'application/pdf' ? `<button class="button secondary" type="button" data-action="extract-pdf-text" data-material-id="${escapeHtml(material.id)}">Estrai testo PDF locale</button>` : ''}${!isDemoMode && (material.mime === 'application/pdf' || ['image/jpeg', 'image/png', 'image/webp'].includes(material.mime)) ? `<button class="button secondary" type="button" data-action="read-material" data-material-id="${escapeHtml(material.id)}">${analysis ? 'Rileggi con Jarvis' : 'Leggi con Jarvis'}</button>` : ''}</div></form></article>`;
}
function releaseMaterialPreview() {
  pdfPreviewController?.destroy(); pdfPreviewController = null;
  if (materialPreview?.url) URL.revokeObjectURL(materialPreview.url);
  materialPreview = null;
  if (materialViewerContent) materialViewerContent.replaceChildren();
  if (materialViewerComparison) materialViewerComparison.replaceChildren();
  if (materialViewerExternal) { materialViewerExternal.removeAttribute('href'); materialViewerExternal.hidden = true; }
  if (materialViewerZoom) materialViewerZoom.hidden = true;
}
function closeMaterialViewer() {
  if (materialViewer?.open) materialViewer.close();
  else releaseMaterialPreview();
}
function renderMaterialViewer() {
  if (!materialPreview || !materialViewerContent) return;
  const { filename, mime, url, text, requestId, synthetic } = materialPreview;
  materialViewerTitle.textContent = filename;
  materialViewerMeta.textContent = synthetic
    ? `${mime} · PDF FINTIZIO statico, nessun file di un cliente.`
    : `${mime} · download da staging privato via Blob; nessun URL R2 pubblico.`;
  materialViewerContent.replaceChildren();
  const draft = draftForRequest(requestId);
  if (materialViewerComparison) materialViewerComparison.innerHTML = draft ? `
    <p class="eyebrow">BOZZA A CONFRONTO</p><h3>${escapeHtml(draft.menu.nome?.it || draft.menu.nome)}</h3>
    <p class="muted small">${escapeHtml(draft.slug)} · revisione ${draft.revision}. La fonte a sinistra non viene estratta automaticamente né usata per inventare allergeni.</p>
    ${draft.menu.sezioni.map((section) => `<div class="compare-section"><strong>${escapeHtml(section.nome?.it || section.nome)}</strong>${section.voci.map((item) => `<div class="compare-item"><span>${escapeHtml(item.nome?.it || item.nome)}</span><span>${item.prezzo ? escapeHtml(item.prezzo) : 'PREZZO NON CONFERMATO'}</span></div>`).join('')}</div>`).join('')}
    <p class="notice warning">${criticalFields(draft.menu).allergensMissing.length ? 'ALLERGENI NON CONFERMATI DAL LOCALE. Non dedurre numeri dalla fonte.' : 'I numeri allergeni richiedono verifica della fonte.'}</p>
    <button class="button secondary" type="button" data-route="revisione">Apri editor e riferimenti</button>`
    : '<p class="eyebrow">BOZZA A CONFRONTO</p><p class="muted">Nessuna bozza per questa pratica. Non estrarre informazioni automaticamente dal file.</p>';
  materialViewerExternal.href = url; materialViewerExternal.hidden = false;
  if (mime === 'application/pdf') {
    const message = document.createElement('p');
    message.className = 'muted'; message.textContent = 'Preparazione delle pagine PDF locali…';
    materialViewerContent.append(message);
  } else if (mime.startsWith('image/')) {
    const stage = document.createElement('div'); stage.className = 'private-material-image-stage';
    const image = document.createElement('img'); image.id = 'private-material-image'; image.className = 'private-material-image'; image.src = url; image.alt = `Anteprima privata di ${filename}`;
    image.style.setProperty('--material-zoom', String(materialPreview.zoom)); stage.append(image); materialViewerContent.append(stage);
    materialViewerZoom.hidden = false; materialViewerZoomLabel.textContent = `${Math.round(materialPreview.zoom * 100)}%`;
  } else {
    const pre = document.createElement('pre'); pre.className = 'private-material-text'; pre.textContent = text || 'File di testo vuoto.'; materialViewerContent.append(pre);
  }
}
async function openMaterialPreview(material) {
  if (isDemoMode && material?.id !== DEMO_PDF_ID) throw new Error('La demo conserva solo metadati degli upload: nessuna anteprima binaria è disponibile.');
  if (!material || material.archivedAt) throw new Error('Materiale non disponibile o archiviato.');
  if (!isPreviewableMime(material.mime)) throw new Error('Questo tipo di file non è supportato dal viewer privato.');
  closeMaterialViewer();
  const { blob, mime, synthetic } = await fetchMaterialPreview(material.id);
  const text = mime.startsWith('text/') ? (await blob.text()).slice(0, 200000) : '';
  materialPreview = { id: material.id, requestId: material.requestId, filename: material.filename,
    mime, synthetic, url: URL.createObjectURL(blob), zoom: 1, text };
  renderMaterialViewer();
  if (!materialViewer?.showModal) { releaseMaterialPreview(); throw new Error('Il browser non supporta il viewer privato richiesto.'); }
  materialViewer.showModal();
  if (mime === 'application/pdf') {
    try {
      const controller = await mountPdfPreview(blob, materialViewerContent);
      if (materialPreview?.id !== material.id || !materialViewer.open) controller.destroy();
      else pdfPreviewController = controller;
    } catch (error) {
      closeMaterialViewer();
      throw new Error(`PDF non visualizzabile: ${error.message}`);
    }
  }
  window.setTimeout(() => $('#material-viewer-close')?.focus(), 0);
}
function changeMaterialZoom(delta) {
  if (!materialPreview || !materialPreview.mime.startsWith('image/')) return;
  materialPreview.zoom = Math.max(.75, Math.min(3, Math.round((materialPreview.zoom + delta) * 100) / 100));
  const image = $('#private-material-image');
  if (image) image.style.setProperty('--material-zoom', String(materialPreview.zoom));
  if (materialViewerZoomLabel) materialViewerZoomLabel.textContent = `${Math.round(materialPreview.zoom * 100)}%`;
}
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

// Voce di Jarvis: servizio, voce e chiave (la chiave non viene mai mostrata, solo sostituita).
const VOICES = {
  elevenlabs: [['JBFqnCBsd6RMkjVDRZzb', 'George · caldo e calmo, stile Jarvis'], ['onwK4e9ZLuTAKqWW03F9', 'Daniel · profondo e autorevole'], ['nPczCjzI2devNBz1zQrb', 'Brian · profondo e rassicurante']],
  openai: [['onyx', 'Onyx · profonda e calma'], ['ash', 'Ash · calda e pacata'], ['echo', 'Echo · chiara e misurata']]
};
function voiceForm() {
  const v = state.voice || {};
  const provider = v.provider || 'elevenlabs';
  const options = (VOICES[provider] || VOICES.elevenlabs).map(([id, label]) => `<option value="${id}" ${v.voiceId === id ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
  return `<details class="spaced-top-small"><summary><strong>Voce di Jarvis</strong> · ${v.provider && v.hasKey ? `<span class="status good">attiva (${escapeHtml(v.provider)})</span>` : '<span class="status info">solo testo</span>'}</summary><form data-form="voice-settings" class="spaced-top-small"><label class="field">Servizio<select name="provider"><option value="elevenlabs" ${provider === 'elevenlabs' ? 'selected' : ''}>ElevenLabs (voce più naturale)</option><option value="openai" ${provider === 'openai' ? 'selected' : ''}>OpenAI</option><option value="nessuna">Nessuna voce (solo testo)</option></select></label><label class="field">Voce<select name="voiceId">${options}</select></label><label class="field">Chiave API ${v.hasKey ? '(salvata: lascia vuoto per tenerla)' : ''}<input name="apiKey" type="password" autocomplete="off" placeholder="${v.hasKey ? '••••••••' : 'incolla la chiave'}"></label><div class="button-row"><button class="button small-button" type="submit">Salva voce</button>${v.hasKey ? '<button class="button secondary small-button" type="button" data-action="voice-test">Prova voce</button>' : ''}</div><p class="muted small">Mandami un vocale su Telegram: ti rispondo a voce. Pubblicare richiede sempre il pulsante SÌ.</p></form></details>`;
}
// Ultimi messaggi dell'autopilota: cosa ha preparato Jarvis e cosa aspetta una decisione.
function jarvisPanel() {
  const notes = state.notifications.filter((item) => /^Jarvis · /.test(item.subject || '') && !item.readAt).slice(0, 4);
  const tg = state.telegram || {};
  const telegram = isDemoMode ? '' : !tg.configured ? '' : !tg.linked
    ? `<div class="notice spaced-top-small">${telegramLinkUrl ? `Tocca il link e poi <strong>Avvia</strong> in Telegram (valido 15 minuti): <a href="${escapeHtml(telegramLinkUrl)}" target="_blank" rel="noopener">Apri Jarvis su Telegram</a>` : 'Collega Telegram: Jarvis ti scriverà lì e ti chiederà il SÌ prima di pubblicare.'}</div><div class="button-row spaced-top-small"><button class="button" type="button" data-action="telegram-link">${telegramLinkUrl ? 'Nuovo link' : 'Collega Telegram'}</button></div>`
    : `<div class="button-row spaced-top-small"><span class="status good">Telegram collegato</span><button class="button secondary small-button" type="button" data-action="jarvis-briefing">Briefing ora</button><button class="button secondary small-button" type="button" data-action="telegram-test">Messaggio di prova</button></div>${voiceForm()}`;
  if (!notes.length && !autopilotRunning && !telegram) return '';
  const row = (item) => `<div class="list-row"><div class="list-main"><strong>${escapeHtml(item.subject)}</strong><small>${escapeHtml(item.body)}</small><small>${time(item.createdAt)}</small></div><div class="button-row"><button class="mini-button" type="button" data-select-request="${escapeHtml(item.requestId || '')}" data-route="${item.subject.includes('bozza pronta') ? 'revisione' : 'richieste'}">Apri</button><button class="mini-button" type="button" data-action="mark-notification" data-notification-id="${escapeHtml(item.id)}" data-read="true">Fatto</button></div></div>`;
  return `<section class="panel spaced-top-small"><p class="eyebrow">JARVIS</p>${autopilotRunning ? '<p class="notice">Jarvis sta preparando le nuove richieste…</p>' : ''}<div class="list">${notes.map(row).join('')}</div>${telegram}</section>`;
}
function renderCommand() {
  const open = state.requests.filter((request) => !['completata', 'archiviata', 'chiusa'].includes(request.status)).length;
  const newRequests = state.requests.filter((request) => request.status === 'nuova').length;
  const drafts = state.drafts.filter((draft) => ['bozza', 'revisione'].includes(draft.status)).length;
  const approvals = state.drafts.filter((draft) => ['pronta_pr', 'pr_simulata'].includes(draft.status)).length;
  const renewalDates = state.clients.flatMap((client) => [client.trialEndsAt, client.renewalAt].filter(Boolean));
  const renewals = renewalDates.filter((value) => isDueSoon(value)).length;
  const updatesToday = state.requests.filter((request) => ['aggiornamento', 'prezzo', 'traduzione', 'qr'].includes(request.kind) && isSameLocalDay(request.updatedAt || request.lastActionAt)).length;
  const warnings = state.drafts.reduce((count, draft) => count + validateMenu(draft.menu).warnings.length, 0);
  const gmailRequests = state.requests.filter((request) => request.id.startsWith('gmail-request-')).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const realGmailRequests = gmailRequests.filter((request) => !request.id.includes('synthetic'));
  const tasks = [
    ...state.requests.filter((request) => request.status === 'in_attesa').map((request) => ({ request, label: 'Risolvi dati senza fonte', detail: 'Apri Builder e prepara una richiesta di conferma.' })),
    ...state.requests.filter((request) => request.status === 'in_revisione').map((request) => ({ request, label: 'Completa revisione editoriale', detail: 'Controlla JSON, provenienza e checklist.' })),
    ...state.requests.filter((request) => request.status === 'nuova').map((request) => ({ request, label: 'Avvia estrazione prudente', detail: 'Genera una bozza solo dal testo disponibile.' }))
  ].slice(0, 5);
  const metrics = [
    ['Nuove richieste', newRequests, 'richieste', 'arrivate da leggere'],
    ['Email Gmail', realGmailRequests.length, 'richieste', 'richieste clienti importate'],
    ['Bozze', drafts, 'builder', 'da controllare'],
    ['Approvazioni', approvals, 'approvazioni', 'in attesa di passaggio'],
    ['Clienti', state.clients.length, 'clienti', 'anagrafiche disponibili'],
    ['Rinnovi', renewalDates.length ? renewals : '—', 'clienti', renewalDates.length ? 'entro 30 giorni' : 'nessuna scadenza disponibile'],
    ['Aggiornamenti oggi', updatesToday, 'richieste', 'dati con data odierna']
  ];
  return `<div class="view-wrap">${header('01 / OPERAZIONI', 'Command Center', 'Copilota operativo: priorità chiare, regia umana e nessuna azione esterna automatica.', `<button class="button" type="button" data-route="richieste">Nuova richiesta</button>`)}${demoNotice()}${jarvisPanel()}<hr class="accent-line"><div class="kpis command-kpis">${metrics.map(([label, value, route, note]) => `<button class="kpi" type="button" data-route="${route}" aria-label="${label}: ${value}"><span>${label}</span><strong>${value}</strong><small>${note}</small></button>`).join('')}</div>${tasks[0] ? `<div class="next-action"><span class="eyebrow">PROSSIMA AZIONE CONSIGLIATA</span><strong>${escapeHtml(tasks[0].label)} · ${escapeHtml(tasks[0].request.subject)}</strong><button class="button secondary small-button" type="button" data-select-request="${tasks[0].request.id}" data-route="${tasks[0].request.status === 'in_attesa' ? 'builder' : 'revisione'}">Apri priorità</button></div>` : ''}<div class="grid grid-command"><section class="panel"><div class="panel-heading"><div><p class="eyebrow">CODA DI LAVORO</p><h2>Task attivi</h2></div><span class="capsule">${tasks.length} priorità</span></div><div class="task-list">${tasks.length ? tasks.map((task, index) => `<button class="task-card" type="button" data-select-request="${task.request.id}" data-route="${task.request.status === 'in_attesa' ? 'builder' : 'revisione'}"><span class="task-index">0${index + 1}</span><span class="task-body"><strong>${escapeHtml(task.label)}</strong><small>${escapeHtml(task.request.subject)} · ${escapeHtml(task.detail)}</small></span>${status(task.request.status)}</button>`).join('') : empty('Nessuna priorità aperta.')}</div></section><aside class="panel"><p class="eyebrow">SEGNALI</p><h2>Stato di controllo</h2><div class="stack"><div class="list-row"><div class="list-main"><strong>Fonti tracciate</strong><small>Ogni prezzo estratto mostra una riga o “nessuna fonte”.</small></div><span class="status good">attivo</span></div><div class="list-row"><div class="list-main"><strong>Azioni esterne</strong><small>PR, pubblicazione e messaggi restano simulati.</small></div><span class="status info">manuale</span></div><div class="list-row"><div class="list-main"><strong>Avvisi menu</strong><small>${warnings} avvisi tecnici/editoriali da rivedere.</small></div><span class="status wait">vincolata</span></div></div><div class="button-row spaced-top"><button class="button secondary" type="button" data-route="notifiche">Email proprietario</button><button class="button secondary" type="button" data-route="registro">Apri registro</button><button class="button secondary" type="button" data-route="voce">Testa voce</button>${isDemoMode ? '<button class="button secondary" type="button" data-action="reset-demo">Ripristina demo</button>' : ''}</div></aside></div><div class="spaced-top">${ownerEmailCard()}</div><section class="panel spaced-top" aria-labelledby="gmail-intake-title"><div class="panel-heading"><div><p class="eyebrow">EMAIL IN ARRIVO</p><h2 id="gmail-intake-title">Casella business RenMenu</h2></div><span class="capsule">unico monitor Gmail</span></div><p class="muted">Le richieste pertinenti dalla Inbox di renmenu1569@gmail.com vengono registrate come pratiche private in questa Control Room, non più nel precedente Jarvis. Le email non pertinenti non diventano pratiche. Nessuna risposta automatica, cancellazione o pubblicazione; gli allegati restano da verificare nella casella originale e il primo evento reale va collaudato.</p><div class="stack">${gmailRequests.length ? gmailRequests.slice(0, 5).map((request) => `<div class="list-row"><div class="list-main"><strong>${escapeHtml(request.subject)}</strong><small>${request.id.includes('synthetic') ? 'Collaudo fittizio · ' : ''}${time(request.createdAt)} · ${escapeHtml(request.id)}</small></div><div class="list-meta">${status(request.status)}<button class="button secondary small-button" type="button" data-select-request="${escapeHtml(request.id)}" data-route="richieste">Apri pratica</button></div></div>`).join('') : empty('Nessuna richiesta Gmail importata. Il monitor non recupera automaticamente la posta pregressa.')}</div><p class="muted">Le email originali restano in Gmail finché il relativo menù non è online e disponibile e Riccardo non ne autorizza la rimozione.</p></section></div>`;
}

function requestOperationalCard(request, compact = false) {
  const client = clientById(request.clientId);
  const draft = draftForRequest(request.id);
  const materials = state.materials.filter((item) => item.requestId === request.id);
  const messages = state.messages.filter((item) => item.requestId === request.id);
  const audits = state.audit.filter((item) => item.requestId === request.id);
  const proposal = draft && state.proposals.find((item) => item.draftId === draft.id);
  const menu = draft ? `<span class="mono">${escapeHtml(draft.slug)}</span><br><small>URL proposto: <span class="mono">/menu/?m=${escapeHtml(draft.slug)}</span> · non attivo</small>` : '<span class="muted">Nessuna bozza</span>';
  if (compact) return `<tr class="click-row" data-select-request="${request.id}"><td><strong>${escapeHtml(request.subject)}</strong><br><span class="mono">${escapeHtml(request.id.slice(0, 8))}</span></td><td>${escapeHtml(client?.name || '—')}<br><small>${escapeHtml(request.sourceChannel)}</small></td><td>${status(request.status)}<br><small>${escapeHtml(request.plan || '—')} · ${escapeHtml(requestTypeLabel(request))}</small></td><td>${materials.length} mat. · ${draft ? escapeHtml(draft.slug) : 'bozza assente'}</td><td>${escapeHtml(request.nextStep || 'Definisci prossimo passo.')}</td><td><button class="button small-button secondary" type="button" data-select-request="${request.id}" data-route="builder">Apri</button></td></tr>`;
  return `<div class="data-grid"><div><small>ID PRATICA</small><code>${escapeHtml(request.id)}</code></div><div><small>CLIENTE / CANALE</small><strong>${escapeHtml(client?.name || '—')}</strong><span>${escapeHtml(request.sourceChannel)}${request.contactName || client?.contactName ? ` · ${escapeHtml(request.contactName || client?.contactName)} (${escapeHtml(request.contactRole || client?.contactRole || 'referente')})` : ''}</span></div><div><small>RICEVUTA</small><strong>${time(request.receivedAt || request.createdAt)}</strong><span>rev. ${request.revision}</span></div><div><small>PIANO / TIPO</small><strong>${escapeHtml(request.plan || 'non indicato')}</strong><span>${escapeHtml(requestTypeLabel(request))}</span></div><div><small>MATERIALI / NOTE</small><strong>${materials.length} materiali</strong><span>${escapeHtml(request.internalNotes || 'Nessuna nota')}</span></div><div><small>MENU ID / URL</small>${menu}${request.menuId || client?.menuId ? `<span>ID dichiarato: ${escapeHtml(request.menuId || client?.menuId)}</span>` : ''}${request.publicUrl || client?.menuUrl ? `<span>URL esistente dichiarato: ${escapeHtml(request.publicUrl || client?.menuUrl)}</span>` : ''}</div><div><small>PROSSIMO PASSO</small><strong>${escapeHtml(request.nextStep || 'Da definire')}</strong><span>${request.followUpAt ? `follow-up ${time(request.followUpAt)}` : 'follow-up non impostato'}</span></div><div><small>COLLEGAMENTI</small><strong>${messages.length} bozze messaggi · ${audits.length} audit</strong><span>Ultima azione: ${request.lastActionAt ? time(request.lastActionAt) : 'da definire'}</span><span>${proposal ? 'PR simulata presente' : draft ? 'approvazioni da completare' : 'bozza da generare'}</span></div></div>`;
}

function requestCard(request) {
  const client = clientById(request.clientId);
  const materials = state.materials.filter((item) => item.requestId === request.id);
  const contactName = request.contactName || client?.contactName || '—';
  const contactRole = request.contactRole || client?.contactRole || '—';
  const contactInfo = request.contactInfo || client?.email || client?.phone || '—';
  const cardId = `request-card-${request.id}`;
  return `<article class="request-card" aria-labelledby="${escapeHtml(cardId)}"><header><div><p class="eyebrow">${escapeHtml(request.id.slice(0, 8))}</p><h3 id="${escapeHtml(cardId)}">${escapeHtml(request.subject)}</h3></div>${status(request.status)}</header><dl class="request-card-grid"><div><dt>Locale</dt><dd>${escapeHtml(client?.name || '—')}</dd></div><div><dt>Canale</dt><dd>${escapeHtml(request.sourceChannel)}</dd></div><div><dt>Referente</dt><dd>${escapeHtml(contactName)}<small>${escapeHtml(contactRole)} · ${escapeHtml(contactInfo)}</small></dd></div><div><dt>Piano / tipo</dt><dd>${escapeHtml(request.plan || '—')}<small>${escapeHtml(requestTypeLabel(request))}</small></dd></div><div><dt>Materiali</dt><dd>${materials.length}<small>${request.menuId || client?.menuId ? `Menu ID: ${escapeHtml(request.menuId || client?.menuId)}` : 'Menu ID non indicato'}</small></dd></div><div><dt>URL esistente</dt><dd class="mono">${escapeHtml(request.publicUrl || client?.menuUrl || '—')}</dd></div><div class="request-card-wide"><dt>Prossimo passo</dt><dd>${escapeHtml(request.nextStep || 'Da definire')}</dd></div></dl><footer><small>Ricevuta ${time(request.receivedAt || request.createdAt)} · rev. ${request.revision}</small><button class="button secondary small-button" type="button" data-select-request="${escapeHtml(request.id)}" data-route="builder" aria-label="Apri pratica ${escapeHtml(request.subject)}">Apri pratica</button></footer></article>`;
}
function renderRequests() {
  const selected = requestById();
  return `<div class="view-wrap">${header('02 / INGRESSO', 'Richieste', 'Ogni pratica mantiene ID, provenienza, stato, piano, materiali, note e prossimo passo: nessun campo è inventato.')}<div class="grid grid-2"><section class="panel"><div class="panel-heading"><div><p class="eyebrow">NUOVA PRATICA</p><h2>Registra materiale ricevuto</h2></div><span class="capsule">nessun invio</span></div><form data-form="create-request"><div class="form-grid"><label class="field">${isDemoMode ? 'Cliente demo' : 'Cliente in staging privato'}<select name="clientId" required>${clientOptions(selected?.clientId)}</select></label><label class="field">Categoria<select name="category">${categoryOptions('nuovo_standard')}</select></label><label class="field">Piano<select name="plan"><option value="da_definire">Da definire</option><option value="standard">Standard</option><option value="annuale">Annuale</option><option value="premium">Premium</option></select></label><label class="field">Follow-up facoltativo<input name="followUpAt" type="datetime-local"></label><label class="field full">Oggetto<input name="subject" required maxlength="120" placeholder="Es. aggiornamento pranzo"></label><label class="field">Canale sorgente<select name="sourceChannel">${channelOptions('manuale')}</select></label><label class="field">Referente (se noto)<input name="contactName" maxlength="140" placeholder="Non inventare il nome"></label><label class="field">Ruolo referente<input name="contactRole" maxlength="80" placeholder="Es. titolare"></label><label class="field">Contatto (se esplicito)<input name="contactInfo" maxlength="254" placeholder="email o telefono ricevuti"></label><label class="field">Menu ID esistente (solo aggiornamenti)<input name="menuId" maxlength="64" placeholder="${isDemoMode ? 'es. trattoria-demo' : 'es. menu-di-staging'}"></label><label class="field">URL pubblico esistente<input name="publicUrl" type="url" maxlength="500" placeholder="https://… se già online"></label><label class="field full">Testo sorgente (facoltativo se carichi un file dopo)<textarea name="sourceText" placeholder="${isDemoMode ? 'Locale: Esempio demo' : 'Locale di staging privato'}&#10;# Sezione&#10;Piatto — 12,00"></textarea></label><label class="field">Note operative<textarea name="internalNotes" maxlength="600" placeholder="Solo note ricevute o interne."></textarea></label><label class="field">Prossimo passo<textarea name="nextStep" maxlength="240" placeholder="Es. verifica un prezzo con il locale."></textarea></label></div><div class="form-actions"><button class="button" type="submit">Crea pratica</button></div></form></section><section class="panel"><p class="eyebrow">SCHEDA OPERATIVA</p><h2>${escapeHtml(selected?.subject || 'Nessuna pratica')}</h2>${selected ? `${requestOperationalCard(selected)}<form data-form="update-request-meta" class="form-grid spaced-top"><input type="hidden" name="id" value="${escapeHtml(selected.id)}"><input type="hidden" name="revision" value="${selected.revision}"><label class="field">Stato<select name="status" ${['approvata','pronta_pubblicazione','completata','archiviata','chiusa'].includes(selected.status) ? 'disabled' : ''}>${requestStatusOptions(selected.status)}</select></label><label class="field">Piano<select name="plan">${planOptions(selected.plan || 'da_definire')}</select></label><label class="field">Referente<input name="contactName" maxlength="140" value="${escapeHtml(selected.contactName || '')}"></label><label class="field">Ruolo referente<input name="contactRole" maxlength="80" value="${escapeHtml(selected.contactRole || '')}"></label><label class="field">Contatto<input name="contactInfo" maxlength="254" value="${escapeHtml(selected.contactInfo || '')}"></label><label class="field">Menu ID (aggiornamento: quello esistente · nuovo menu: identificativo scelto)<input name="menuId" maxlength="64" value="${escapeHtml(selected.menuId || '')}"></label><label class="field full">URL pubblico esistente<input name="publicUrl" type="url" maxlength="500" value="${escapeHtml(selected.publicUrl || '')}"></label><label class="field">Prossimo passo<input name="nextStep" maxlength="240" value="${escapeHtml(selected.nextStep || '')}"></label><label class="field full">Note interne<textarea name="internalNotes" maxlength="3000">${escapeHtml(selected.internalNotes || '')}</textarea></label><div class="form-actions field full"><button class="button secondary" type="submit">Aggiorna pratica</button></div></form><div class="button-row spaced-top"><button class="button secondary" type="button" data-route="builder">Apri Builder</button><button class="button secondary" type="button" data-route="materiali">Materiali</button><button class="button secondary" type="button" data-select-client="${selected.clientId}" data-route="clienti">Scheda cliente</button></div>` : empty('Seleziona una riga per vedere il contesto.')}</section></div><section class="panel"><div class="panel-heading"><div><p class="eyebrow">CODA</p><h2>Tutte le pratiche</h2></div><span class="capsule">${state.requests.length} totali</span>${archivedCount() ? `<button class="mini-button" type="button" data-action="toggle-archived">${showArchived ? 'Nascondi archiviate' : `Mostra archiviate (${archivedCount()})`}</button>` : ''}</div><div class="table-wrap request-table-desktop"><table class="table"><thead><tr><th>Pratica / ID</th><th>Cliente / canale</th><th>Stato / piano</th><th>Materiali / menu</th><th>Prossimo passo</th><th></th></tr></thead><tbody>${visibleRequests().map((request) => requestOperationalCard(request, true)).join('')}</tbody></table></div><div class="request-card-list" aria-label="Pratiche in formato scheda">${visibleRequests().map((request) => requestCard(request)).join('')}</div></section></div>`;
}

function renderClientRows() {
  const query = clientFilter.toLocaleLowerCase('it');
  const matching = state.clients.filter((client) => client.name.toLocaleLowerCase('it').includes(query) || client.id.includes(query));
  const emptyText = isDemoMode ? 'Nessun cliente demo corrisponde al filtro.' : 'Nessun cliente di staging privato corrisponde al filtro.';
  return matching.length ? matching.map((client) => {
    const requests = state.requests.filter((request) => request.clientId === client.id);
    return `<div class="list-row"><div class="list-main"><strong>${escapeHtml(client.name)}</strong><small><span class="mono">${escapeHtml(client.id)}</span> · creato ${time(client.createdAt)}</small></div><div class="list-meta"><span class="capsule">${requests.length} pratiche</span><button class="button small-button secondary" type="button" data-select-client="${client.id}" data-route="clienti">Apri</button></div></div>`;
  }).join('') : empty(emptyText);
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
  const mode = isDemoMode ? {
    description: 'Schede demo che collegano pratiche, materiali, bozze mock, messaggi, PR mock e audit. Nessun dato reale o invio esterno.',
    create: 'Crea cliente demo', list: 'Clienti demo', capsule: 'solo demo', update: 'Aggiorna scheda demo',
    contactNote: 'I contatti non sono necessari per lavorare al menu: non inserire dati personali nella demo.',
    namePlaceholder: 'Es. Locale Fittizio — demo', notesPlaceholder: 'Solo informazioni sintetiche della demo.'
  } : {
    description: 'Schede di staging privato che collegano record D1, materiali R2 privati, bozze mock, PR mock e audit. Nessun dato viene pubblicato.',
    create: 'Crea cliente in staging privato', list: 'Clienti in staging privato', capsule: 'staging privato', update: 'Aggiorna scheda di staging',
    contactNote: 'I contatti sono dati privati di staging: inseriscili solo se espliciti e necessari alla pratica.',
    namePlaceholder: 'Es. locale di staging', notesPlaceholder: 'Solo note operative di staging privato.'
  };
  return `<div class="view-wrap">${header('03 / RUBRICA', 'Clienti', mode.description)}<div class="grid grid-equal"><section class="panel"><p class="eyebrow">NUOVA ANAGRAFICA</p><h2>${mode.create}</h2><form data-form="create-client"><div class="form-grid"><label class="field full">Nome<input name="name" required minlength="2" maxlength="120" placeholder="${mode.namePlaceholder}"></label><label class="field">Piano<select name="plan"><option value="da_definire" selected>Da definire</option><option value="standard">Standard</option><option value="annuale">Annuale</option><option value="premium">Premium</option></select></label><label class="field">Referente facoltativo<input name="contactName" maxlength="100" placeholder="solo se esplicito"></label><label class="field">Ruolo referente<input name="contactRole" maxlength="80" placeholder="solo se esplicito"></label><label class="field">Email facoltativa<input name="email" type="email" maxlength="160" placeholder="solo se esplicita"></label><label class="field">Telefono facoltativo<input name="phone" maxlength="40" placeholder="solo se esplicito"></label><label class="field">Stato pagamento<input name="paymentStatus" maxlength="80" placeholder="solo se disponibile"></label><label class="field">Menu ID<input name="menuId" maxlength="64" placeholder="${isDemoMode ? 'es. locale-demo' : 'es. locale-di-staging'}"></label><label class="field full">URL menu<input name="menuUrl" type="url" maxlength="500" placeholder="https://… se già online"></label><label class="field">Fine prova<input name="trialEndsAt" type="date"></label><label class="field">Rinnovo<input name="renewalAt" type="date"></label><label class="field full">Note interne<textarea name="internalNotes" maxlength="500" placeholder="${mode.notesPlaceholder}"></textarea></label></div><div class="form-actions"><button class="button" type="submit">Crea cliente</button></div></form></section><section class="panel"><p class="eyebrow">FILTRO</p><h2>Trova una pratica</h2><label class="field">Nome o ID<input id="client-filter" class="filter-input" value="${escapeHtml(clientFilter)}" placeholder="Filtra senza uscire dalla pagina"></label><p class="notice">${mode.contactNote}</p></section></div><section class="panel"><div class="panel-heading"><div><p class="eyebrow">ANAGRAFICHE</p><h2>${mode.list}</h2></div><span class="capsule">${state.clients.length} registrati</span></div><div id="client-list" class="stack">${renderClientRows()}</div></section>${client ? `<section class="panel"><div class="panel-heading"><div><p class="eyebrow">SCHEDA CLIENTE COLLEGATA</p><h2>${escapeHtml(client.name)}</h2><p class="muted mono">${escapeHtml(client.id)}</p></div><span class="capsule">${mode.capsule}</span></div><div class="kpis relationship-kpis"><div class="kpi"><span>Pratiche</span><strong>${clientRequests.length}</strong></div><div class="kpi"><span>Materiali</span><strong>${materials.length}</strong></div><div class="kpi"><span>Bozze mock</span><strong>${drafts.length}</strong></div><div class="kpi"><span>Registro</span><strong>${audit.length}</strong></div></div><form data-form="update-client" class="form-grid spaced-top"><input type="hidden" name="id" value="${escapeHtml(client.id)}"><input type="hidden" name="revision" value="${client.revision}"><label class="field">Piano<select name="plan">${planOptions(client.plan || 'da_definire')}</select></label><label class="field">Referente<input name="contactName" value="${escapeHtml(client.contactName || '')}" maxlength="100" placeholder="solo se esplicito"></label><label class="field">Ruolo referente<input name="contactRole" value="${escapeHtml(client.contactRole || '')}" maxlength="80"></label><label class="field">Email<input name="email" type="email" value="${escapeHtml(client.email || '')}" maxlength="160"></label><label class="field">Telefono<input name="phone" value="${escapeHtml(client.phone || '')}" maxlength="40"></label><label class="field">Stato pagamento<input name="paymentStatus" value="${escapeHtml(client.paymentStatus || '')}" maxlength="80"></label><label class="field">Menu ID<input name="menuId" value="${escapeHtml(client.menuId || '')}" maxlength="64"></label><label class="field full">URL menu<input name="menuUrl" type="url" value="${escapeHtml(client.menuUrl || '')}" maxlength="500"></label><label class="field">Fine prova<input name="trialEndsAt" type="date" value="${dateInputValue(client.trialEndsAt)}"></label><label class="field">Rinnovo<input name="renewalAt" type="date" value="${dateInputValue(client.renewalAt)}"></label><label class="field full">Note interne<textarea name="internalNotes" maxlength="500">${escapeHtml(client.internalNotes || '')}</textarea></label><div class="form-actions field full"><button class="button secondary" type="submit">${mode.update}</button></div></form><div class="relationship-grid"><section><h3>Pratiche e bozze mock</h3>${clientRequests.length ? clientRequests.map((request) => { const draft = draftForRequest(request.id); return `<div class="list-row"><div class="list-main"><strong>${escapeHtml(request.subject)}</strong><small>${statusLabel(request.status)} · ${draft ? `bozza mock ${escapeHtml(draft.slug)}` : 'bozza assente'}</small></div><button class="button small-button secondary" type="button" data-select-request="${request.id}" data-route="richieste">Apri</button></div>`; }).join('') : empty('Nessuna pratica.')}</section><section><h3>Materiali e messaggi mock</h3><p class="muted">${materials.length} materiali associati · ${messages.length} bozze messaggi mock non inviate</p>${messages.length ? messages.map((message) => `<div class="list-row"><div class="list-main"><strong>${escapeHtml(message.channel)}</strong><small>${escapeHtml(message.body)}</small></div><span class="status wait">bozza mock</span></div>`).join('') : empty('Nessun messaggio associato.')}</section><section><h3>PR mock e registro</h3><p class="muted">${approved.length} stati PR/pubblicazione mock · ${audit.length} eventi audit</p><div class="button-row"><button class="button secondary small-button" type="button" data-select-request="${clientRequests[0]?.id || ''}" data-route="approvazioni" ${clientRequests.length ? '' : 'disabled'}>Approvazioni</button><button class="button secondary small-button" type="button" data-route="registro">Registro</button></div></section></div></section>` : ''}</div>`;
}

function renderMaterials() {
  const request = requestById();
  const materials = request ? state.materials.filter((material) => material.requestId === request.id) : [];
  const privacyNote = isDemoMode
    ? '<div class="notice"><strong>Demo locale:</strong> gli upload aggiunti conservano solo nome, tipo, dimensione ed estratto testuale breve. Nessun binario cliente viene persistito e non c’è OCR. L’unico PDF apribile è una fixture fittizia statica.</div>'
    : '<div class="notice"><strong>Staging privato:</strong> i metadati mostrati provengono da record D1 di staging; un upload manuale riuscito è custodito nel bucket R2 di staging privato. Il viewer richiede Access e usa solo Blob same-origin, senza URL R2 pubblici.</div>';
  const uploadNote = isDemoMode
    ? 'Demo: al massimo 12 materiali per pratica; i binari dei nuovi upload non vengono persistiti.'
    : 'Staging privato: al massimo 12 materiali per pratica. Se il caricamento riesce, il record D1 e il file R2 di staging restano privati; nessun canale esterno viene contattato.';
  return `<div class="view-wrap">${header('04 / FONTI', 'Materiali', isDemoMode ? 'Associa fonti demo alla pratica con limiti chiari. Non viene avviato OCR.' : 'Associa fonti di staging privato alla pratica con limiti chiari. Puoi aggiungere una trascrizione manuale verificabile o estrarre esplicitamente il testo incorporato di un PDF; non viene avviato OCR.')}<div class="grid grid-2"><section class="panel"><div class="panel-heading"><div><p class="eyebrow">CARICAMENTO</p><h2>Materiale associato</h2></div>${request ? status(request.status) : ''}</div><label class="field">Pratica<select data-select-request>${requestOptions(selectedRequestId)}</select></label>${request ? `<form data-form="upload-material" class="spaced-top"><label class="field">File (testo, PDF, immagine o audio; max 10 MB)<input name="file" type="file" required accept="text/*,application/pdf,image/*,audio/*"></label><p class="muted small">${uploadNote}</p><div class="form-actions"><button class="button" type="submit">Registra materiale</button></div></form>` : empty('Seleziona una pratica per associare materiale.')}</section><section class="panel"><p class="eyebrow">PRIVACY</p><h2>Regole di deposito</h2><div class="stack">${privacyNote}<div class="notice"><strong>Allowlist:</strong> solo PDF, PNG/JPEG/GIF/WebP/AVIF e testo semplice/CSV/Markdown vengono visualizzati.</div><div class="notice"><strong>Editor:</strong> foto e PDF non vengono interpretati né trasformati automaticamente.</div></div></section></div><section class="panel"><div class="panel-heading"><div><p class="eyebrow">ELENCO</p><h2>${escapeHtml(request?.subject || 'Materiali')}</h2></div><span class="capsule">${materials.length} file</span></div><div class="stack">${materialListRows(materials)}</div></section>${request ? `<section class="panel spaced-top"><div class="panel-heading"><div><p class="eyebrow">ANALISI E FONTE</p><h2>Stato delle trascrizioni</h2><p class="muted small">Revisione della pratica corrente: <code>${escapeHtml(request.revision)}</code>. Ogni hash è calcolato dal file privato al salvataggio della trascrizione.</p></div><span class="capsule">${isDemoMode ? 'demo senza OCR' : `${(state.analyses || []).filter((analysis) => analysis.requestId === request.id).length} analisi`}</span></div><div class="material-analysis-list">${materials.length ? materials.map((material) => renderMaterialAnalysis(material, request)).join('') : empty('Carica o registra un materiale per poterlo trascrivere manualmente.')}</div></section>` : ''}</div>`;
}

function renderBuilder() {
  const request = requestById();
  const draft = draftForRequest();
  const validation = draft ? validateMenu(draft.menu) : null;
  const provenance = draft?.provenance || [];
  return `<div class="view-wrap">${header('05 / ESTRAZIONE', 'Builder da testo', 'Estrattore deterministico: riconosce solo “Nome — 12,00”; prezzi, allergeni, contatti e traduzioni non presenti restano da verificare.', `<label class="field">Pratica<select data-select-request>${requestOptions(selectedRequestId)}</select></label>`)}<div class="grid grid-2"><section class="panel"><div class="panel-heading"><div><p class="eyebrow">TESTO SORGENTE</p><h2>${escapeHtml(request?.subject || 'Scegli una pratica')}</h2></div>${request ? status(request.status) : ''}</div>${request ? `<form data-form="update-source"><input type="hidden" name="id" value="${escapeHtml(request.id)}"><input type="hidden" name="revision" value="${request.revision}"><div class="form-grid"><label class="field">Canale<select name="sourceChannel">${channelOptions(request.sourceChannel)}</select></label><label class="field">Categoria<select name="category">${categoryOptions(request.category || '', request.kind)}</select></label><label class="field full">Testo ricevuto<textarea name="sourceText" required>${escapeHtml(request.sourceText)}</textarea></label><label class="field">Note interne<textarea name="internalNotes" maxlength="600">${escapeHtml(request.internalNotes || '')}</textarea></label><label class="field">Prossimo passo<textarea name="nextStep" maxlength="240">${escapeHtml(request.nextStep || '')}</textarea></label><label class="field">Follow-up<input name="followUpAt" type="datetime-local" value="${request.followUpAt ? new Date(request.followUpAt).toISOString().slice(0, 16) : ''}"></label></div><div class="form-actions"><button class="button secondary" type="submit">Salva sorgente</button>${draft ? '<button class="button" type="button" data-route="revisione">Apri bozza esistente</button>' : `<button class="button" type="button" data-action="generate-draft" ${draftBlocker(effectivePlan(request)) ? 'disabled title="Piano da confermare"' : ''}>Genera bozza prudente</button>`}</div></form>` : empty('Torna a Richieste per selezionare o creare una pratica.')}</section><aside class="panel"><p class="eyebrow">GUARDRAIL</p><h2>Blocco dati inferiti</h2><div class="stack"><div class="notice"><strong>Prezzi:</strong> viene letto solo un importo numerico esplicito; altrimenti resta vuoto.</div><div class="notice"><strong>Allergeni:</strong> nessuna deduzione da ingredienti o nomi dei piatti.</div><div class="notice"><strong>Lingue:</strong> nessuna traduzione accreditata come verificata.</div><div class="notice warning"><strong>Contatti:</strong> non vengono aggiunti da testo non strutturato.</div></div></aside></div>${planRulesPanel(request, draft)}${draft ? `<section class="panel"><div class="panel-heading"><div><p class="eyebrow">ULTIMA BOZZA</p><h2>${escapeHtml(draft.slug)} · rev. ${draft.revision}</h2></div>${status(draft.status)}</div><div class="grid grid-equal"><div><p class="muted">${validation.valid ? 'Struttura tecnicamente valida; gli avvisi restano editoriali.' : 'La struttura contiene errori da correggere in Revisione.'}</p>${renderValidation(validation)}</div><div class="provenance">${provenance.length ? provenance.map((entry) => `<div class="provenance-row"><code>${escapeHtml(entry.path)}</code><span class="status ${entry.status === 'confermato' ? 'good' : 'wait'}">${escapeHtml(entry.status.replace('_', ' '))}</span><small>${escapeHtml(entry.source)} · ${escapeHtml(entry.value)}</small></div>`).join('') : empty(draft ? 'Nessuna provenienza registrata: la bozza è stata modificata a mano o creata prima della registrazione delle fonti.' : 'Genera una bozza per vedere provenienza e campi da verificare.')}</div></div><div class="button-row spaced-top"><button class="button secondary" type="button" data-route="revisione">Apri editor JSON</button><button class="button secondary" type="button" data-route="notifiche">Prepara richiesta chiarimenti</button></div></section>` : ''}</div>`;
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
// Testi ancora senza inglese (stessi campi tradotti dal server: nomi e descrizioni, avvisi).
function missingEnglish(menu) {
  const missing = (value) => { const it = typeof value === 'string' ? value : value?.it; return Boolean(String(it || '').trim()) && !(value && typeof value === 'object' && String(value.en || '').trim()); };
  let count = ['sottotitolo', 'avviso', 'note', 'orari'].filter((key) => key in (menu || {}) && missing(menu[key])).length;
  for (const section of menu?.sezioni || []) {
    count += missing(section?.nome) + ('descrizione' in (section || {}) && missing(section.descrizione));
    for (const item of section?.voci || []) count += missing(item?.nome) + ('descrizione' in (item || {}) && missing(item.descrizione));
  }
  return count;
}
function renderEnglishPreview(draft) {
  const auto = new Set((draft.provenance || []).filter((entry) => String(entry.path).endsWith('.en')).map((entry) => entry.path));
  const rows = [];
  for (const [si, section] of (draft.menu?.sezioni || []).entries()) {
    const line = (value, path, strong) => { if (!value || typeof value !== 'object') return; const en = String(value.en || '').trim();
      rows.push(`<div class="provenance-row"><span>${strong ? '<strong>' : ''}${escapeHtml(value.it || '')}${strong ? '</strong>' : ''}</span><span class="status ${en ? (auto.has(`${path}.en`) ? 'wait' : 'good') : 'alert'}">${en ? (auto.has(`${path}.en`) ? 'bozza Jarvis' : 'presente') : 'manca'}</span><small>${escapeHtml(en || '—')}</small></div>`); };
    line(section?.nome, `sezioni.${si}.nome`, true);
    for (const [vi, item] of (section?.voci || []).entries()) { line(item?.nome, `sezioni.${si}.voci.${vi}.nome`); line(item?.descrizione, `sezioni.${si}.voci.${vi}.descrizione`); }
  }
  if (!rows.length) return '';
  return `<div class="spaced-top-small"><p class="eyebrow">ITALIANO → INGLESE</p>${auto.size ? '<div class="notice spaced-top-small">Traduzione preparata in automatico da Jarvis: è una bozza. Correggi nel JSON se serve, poi conferma le lingue nella checklist.</div>' : ''}<div class="provenance">${rows.join('')}</div></div>`;
}
function renderReview() {
  const draft = draftForRequest();
  const request = requestForDraft(draft);
  const suggestion = draft ? suggestedEvidence(draft, request) : { notes: {} };
  if (!draft) return `<div class="view-wrap">${header('06 / REVISIONE', 'Revisione editoriale', 'JSON strutturato, provenienza e validazione compatibile con RenMenu.')}<section class="panel">${empty('Nessuna bozza per la pratica selezionata. Genera prima una bozza dal Builder.')}<div class="button-row"><button class="button" type="button" data-route="builder">Vai al Builder</button></div></section></div>`;
  const validation = validateMenu(draft.menu);
  return `<div class="view-wrap">${header('06 / REVISIONE', 'Revisione editoriale', 'Modifica JSON e struttura; ogni salvataggio azzera la checklist di approvazione.', `<label class="field">Pratica<select data-select-request>${requestOptions(selectedRequestId)}</select></label>`)}${sourceExtrasPanel(draft)}${jarvisMissionPanel(draft)}<div class="grid grid-2 spaced-top-small"><section class="panel"><div class="editor-toolbar"><div><p class="eyebrow">BOZZA ${escapeHtml(draft.slug)}</p><h2>JSON RenMenu · rev. ${draft.revision}</h2></div>${status(draft.status)}</div><textarea class="json-editor" id="menu-editor" spellcheck="false" aria-label="Editor JSON del menu">${escapeHtml(JSON.stringify(draft.menu, null, 2))}</textarea><div class="button-row spaced-top-tight"><button class="button secondary" type="button" data-action="validate-editor">Valida JSON</button><button class="button" type="button" data-action="save-editor" data-draft="${draft.id}" data-revision="${draft.revision}">Salva revisione</button>${missingEnglish(draft.menu) && ['bozza', 'revisione', 'pronta_pr'].includes(draft.status) ? `<button class="button secondary" type="button" data-action="translate-draft" data-draft="${draft.id}" data-revision="${draft.revision}">Traduci in inglese (Jarvis)</button>` : ''}</div>${renderEnglishPreview(draft)}<div id="editor-validation">${renderValidation(validation)}</div></section><aside class="panel"><p class="eyebrow">PROVENIENZA</p><h2>Campi leggibili</h2><div class="provenance">${(draft.provenance || []).length ? draft.provenance.map((entry) => `<div class="provenance-row"><code>${escapeHtml(entry.path)}</code><span class="status ${entry.status === 'confermato' ? 'good' : 'wait'}">${escapeHtml(entry.status.replace('_', ' '))}</span><small>${escapeHtml(entry.source)} · ${escapeHtml(entry.value)}</small></div>`).join('') : empty('Nessuna provenienza registrata.')}</div><hr class="divider"><p class="notice warning"><strong>Dati inferiti bloccati.</strong> Aggiungi prezzo, allergeni o traduzioni solo da una fonte confermata.</p></aside></div>${request ? `<section class="panel spaced-top"><div class="panel-heading"><div><p class="eyebrow">FONTE ORIGINALE</p><h2>Materiali privati della pratica</h2></div><span class="capsule">${state.materials.filter((item) => item.requestId === request.id && !item.archivedAt).length} attivi</span></div><div class="stack">${materialListRows(state.materials.filter((item) => item.requestId === request.id && !item.archivedAt), { allowArchive: false, emptyText: 'Nessun materiale attivo; usa la sezione Materiali per associare una fonte.' })}</div><p class="muted small spaced-top-small">In area privata il viewer usa Blob same-origin e non espone URL R2. In demo restano metadati, salvo la fixture PDF fittizia.</p></section>` : ''}<div class="grid grid-equal spaced-top"><section class="panel tight"><p class="eyebrow">ORDINE SEZIONI</p><h2>Riordina senza riscrivere</h2><div id="reorder-list" class="reorder-list">${renderReorder(draft.menu)}</div><form data-form="add-section" class="inline-form spaced-top"><label class="field">Nuova sezione<input name="sectionName" required maxlength="80" placeholder="Nome esplicito dalla fonte"></label><button class="button secondary" type="submit">Aggiungi sezione</button></form></section><section class="panel tight"><p class="eyebrow">NUOVA VOCE</p><h2>Aggiungi con fonte</h2><form data-form="add-item"><div class="form-grid"><label class="field">Sezione<select name="sectionIndex">${draft.menu.sezioni.map((section, index) => `<option value="${index}">${escapeHtml(section.nome?.it || '')}</option>`).join('')}</select></label><label class="field">Prezzo esplicito<input name="price" inputmode="decimal" placeholder="es. 12,00"></label><label class="field full">Nome voce<input name="itemName" required maxlength="120" placeholder="Nome esplicito dalla fonte"></label></div><div class="form-actions"><button class="button secondary" type="submit">Aggiungi nell'editor</button></div></form></section></div>${request ? `<section class="panel"><p class="eyebrow">CHECKLIST</p><h2>Controlli visibili</h2><form data-form="review-draft"><input type="hidden" name="id" value="${draft.id}"><input type="hidden" name="revision" value="${draft.revision}"><div class="checklist">${checkRows(draft.checks)}</div>${criticalFields(draft.menu).allergensMissing.length ? `<div class="notice danger spaced-top-small"><strong>ALLERGENI NON CONFERMATI DAL LOCALE</strong><br>Non aggiungere tag o deduzioni: registra un riferimento scritto del locale anche quando l’informazione resta assente.</div><label class="check-row spaced-top-small"><input type="checkbox" name="allergenOmissionConfirmed" ${draft.checks?.allergenOmissionConfirmed ? "checked" : ""}><span><strong>Omissione esplicitamente autorizzata dal locale (solo mock)</strong><small>Attiva solo dopo conferma scritta: il menù non mostrerà numeri allergeni mancanti. Non equivale a una dichiarazione di assenza di allergeni.</small></span></label>` : `<div class="notice spaced-top-small"><strong>Numeri allergeni presenti.</strong> Verifica che ogni valore sia supportato dalla fonte originale.</div>`}${evidenceSuggestionNotice(draft, suggestion)}<div class="form-grid spaced-top-small"><label class="field">Evidenza prezzi (min. 12 caratteri)<textarea name="fieldEvidence-prices" maxlength="500" placeholder="Fonte controllabile per ogni prezzo verificato.">${escapeHtml(draft.fieldEvidence?.prices || draft.checks?.fieldEvidence?.prices || suggestion.prices || '')}</textarea></label><label class="field">Evidenza allergeni (min. 12 caratteri)<textarea name="fieldEvidence-allergens" maxlength="500" placeholder="Riferimento scritto del locale, anche per omissioni.">${escapeHtml(draft.fieldEvidence?.allergens || draft.checks?.fieldEvidence?.allergens || suggestion.allergens || '')}</textarea></label><label class="field full">Evidenza lingue (min. 12 caratteri)<textarea name="fieldEvidence-languages" maxlength="500" placeholder="Fonte per lingue e traduzioni dichiarate.">${escapeHtml(draft.fieldEvidence?.languages || draft.checks?.fieldEvidence?.languages || suggestion.languages || '')}</textarea></label></div><label class="field spaced-top-small">Evidenza approvazione scritta (se disponibile)<textarea name="approvalEvidence" maxlength="500" placeholder="Riferimento interno, senza inventare dati.">${escapeHtml(draft.checks?.clientApprovalEvidence || draft.approvalEvidence || '')}</textarea></label>${PLAN_RULES[request.plan]?.creativeApproval ? `<label class="check-row spaced-top-small"><input type="checkbox" name="creativeApproval" ${draft.checks?.creativeApproval ? 'checked' : ''}><span><strong>Approvazione creativa Premium (Riccardo)</strong><small>Obbligatoria per il piano Premium: confermi grafica, struttura e materiali autorizzati.</small></span></label><label class="field spaced-top-small">Riferimento approvazione creativa (min. 12 caratteri)<textarea name="creativeApprovalEvidence" maxlength="500" placeholder="Es. proposta grafica v2 approvata il …">${escapeHtml(draft.checks?.creativeApprovalEvidence || '')}</textarea></label>` : ''}<p class="notice warning">Le checkbox non bastano: per prezzi, allergeni e lingue serve una fonte controllabile. Prezzi assenti restano bloccanti finché non corretti.</p><div class="form-actions"><button class="button" type="submit">Registra checklist</button><button class="button secondary" type="button" data-route="approvazioni">Vai alle approvazioni</button></div></form></section>` : ''}</div>`;
}
function evidenceSuggestionNotice(draft, suggestion) {
  const saved = draft.fieldEvidence || draft.checks?.fieldEvidence || {};
  const proposed = ['prices', 'allergens', 'languages'].filter((key) => !saved[key] && suggestion[key]);
  const notes = Object.values(suggestion.notes || {});
  if (!proposed.length && !notes.length) return '';
  return `<div class="notice spaced-top-small"><strong>Proposto da Jarvis, verifica e modifica se serve.</strong> Testi costruiti solo da provenienza, pratica e lingue della bozza. Spunta le caselle solo dopo il controllo; l’omissione degli allergeni e l’approvazione scritta restano tue.${notes.map((note) => `<br>${escapeHtml(note)}`).join('')}</div>`;
}
function checkRows(checks) {
  const rows = [
    ['prices', 'Prezzi verificati', 'Ho confrontato ogni importo con una fonte leggibile del locale.'],
    ['allergens', 'Allergeni / omissione verificata', 'Non ho dedotto allergeni; per un’omissione serve conferma scritta esplicita del locale.'],
    ['languages', 'Lingue verificate', 'Ho verificato le lingue dichiarate e le traduzioni disponibili.'],
    ['clientApproval', 'Consenso scritto cliente', 'Non si spunta a mano: arriva dalla risposta email del locale all’anteprima, confermata da te in Approvazioni.']
  ];
  return rows.map(([name, title, note]) => `<label class="check-row"><input type="checkbox" name="${name}" ${checks?.[name] ? 'checked' : ''}${name === 'clientApproval' ? ' disabled' : ''}><span><strong>${title}</strong><small>${note}</small></span></label>`).join('');
}

function renderPreview() {
  const draft = draftForRequest();
  if (!draft) return `<div class="view-wrap">${header('07 / VISUALIZZAZIONE', 'Anteprima', 'Renderer isolato: nessun menu o QR pubblico viene creato.')}<section class="panel">${empty('Genera una bozza per aprire l’anteprima.')}</section></div>`;
  const request = requestForDraft(draft);
  // The demo fixture is deliberately synthetic. The real published menu is NOT fetched.
  const snapshot = isDemoMode && request?.kind !== 'nuovo' ? state.publicMenuSnapshots?.[draft.slug] : null;
  const previous = snapshot?.menu || draft.versions?.[0]?.menu || null;
  const diff = previous ? menuDiff(previous, draft.menu) : { changes: [], summary: { added: 0, removed: 0, changed: 0 } };
  const diffTitle = snapshot ? 'Rispetto allo snapshot pubblicato FINTIZIO' : previous ? 'Rispetto alla versione bozza salvata' : 'Nessun confronto disponibile';
  const target = provisionalTarget(draft.slug);
  return `<div class="view-wrap">${header('07 / VISUALIZZAZIONE', 'Anteprima', 'Anteprima locale: il QR è scansionabile ma la sua destinazione privata non è attiva; non condividere.', `<label class="field">Pratica<select data-select-request>${requestOptions(selectedRequestId)}</select></label>`)}
    <div class="grid grid-2"><section class="panel"><p class="eyebrow">RENDERER MOCK</p><button class="button secondary small-button" type="button" data-action="preview-device">Passa a ${previewMode === 'phone' ? 'desktop' : 'telefono'}</button>
    <div class="preview-device ${previewMode === 'desktop' ? 'desktop-preview' : ''}" aria-label="Anteprima simulata menu"><div class="preview-top"><small>RENMENU · ANTEPRIMA</small><h3>${escapeHtml(draft.menu.nome?.it || draft.menu.nome)}</h3></div>
    ${draft.menu.sezioni.map((section) => `<div class="preview-section"><h4>${escapeHtml(section.nome?.it || section.nome)}</h4>${section.voci.map((item) => `<div class="preview-item"><span>${escapeHtml(item.nome?.it || item.nome)}</span><strong>${item.prezzo ? `€ ${escapeHtml(item.prezzo)}` : 'da verificare'}</strong></div>`).join('')}</div>`).join('')}
    <div class="preview-section qr-preview"><div class="qr-real" role="img" aria-label="QR scansionabile di preview NON ATTIVA">${provisionalQrSvg(draft.slug)}</div><strong>QR DI PROVA — NON ATTIVO</strong><small>Destinazione privata non distribuita; non è il QR del locale.</small></div></div></section>
    <aside class="panel"><p class="eyebrow">LINK E QR</p><h2>Mai una pubblicazione</h2><div class="notice danger"><strong>URL del QR di prova:</strong> <span class="mono">${escapeHtml(target)}</span><br>Non è attivo e non mostra la bozza; NON distribuire. Il percorso commerciale /menu/?m= è distinto e resta invariato.</div>
    <div class="notice warning"><strong>QR provvisorio scansionabile.</strong> Generato nel browser senza servizi esterni: anche se lo scansioni, nessun menu viene pubblicato.</div><hr class="divider"><p class="eyebrow">DIFF EDITORIALE</p><h2>${diffTitle}</h2>
    ${snapshot ? `<p class="muted small">${escapeHtml(snapshot.source)} · ${time(snapshot.capturedAt)}. È un esempio inventato, non il menu online.</p>` : `<p class="muted small">Il menu online NON è stato letto. Questo confronto non attesta modifiche al menu pubblicato.</p>`}
    <div class="diff-list">${diff.changes.length ? diff.changes.map((change) => `<div class="diff-row"><strong>${escapeHtml(change.type.replaceAll('_', ' '))}</strong><span>${escapeHtml(change.label)}<br><code>${escapeHtml(change.before ?? '—')} → ${escapeHtml(change.after ?? '—')}</code></span></div>`).join('') : empty(previous ? 'Nessuna differenza rilevata rispetto al riferimento indicato.' : 'Salva una versione per poterla confrontare.')}</div></aside></div></div>`;
}

const ACTIVATION_LABELS = { prova_30_giorni: 'Standard: prova gratuita di 30 giorni avviata', annuale_pagato: 'Annuale: pagamento ricevuto', premium_acconto: 'Premium: acconto ricevuto' };
const PLAN_ACTIVATION = { standard: 'prova_30_giorni', annuale: 'annuale_pagato', premium: 'premium_acconto' };
function approvalForDraft(draft) { return (state.approvals || []).find((entry) => entry.draftId === draft?.id) || null; }
function stepRow(number, title, done, detail, current = false) {
  return `<div class="list-row"><div class="list-main"><strong>${number}. ${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></div><span class="status ${done ? 'good' : current ? 'alert' : 'wait'}">${done ? 'fatto' : current ? 'da fare' : 'in attesa'}</span></div>`;
}
const MISSION_LABEL = { affidata: 'preparo l’anteprima', attesa_invio: 'invio l’anteprima da Gmail', attesa_cliente: 'aspetto la risposta del locale', attesa_si: 'aspetto il tuo SÌ su Telegram', pubblicazione: 'sto pubblicando', verifica: 'verifico online', completata: 'completata', ferma: 'ferma: serve una tua decisione', annullata: 'ripresa in mano da te' };
const missionFor = (draft) => (state.missions || []).find((entry) => entry.draftId === draft?.id || entry.requestId === draft?.requestId) || null;
// Affidamento a Jarvis: un solo gesto di Riccardo dopo il controllo della bozza.
function jarvisMissionPanel(draft) {
  if (!draft || isDemoMode) return '';
  const mission = missionFor(draft);
  const active = mission && !['completata', 'ferma', 'annullata'].includes(mission.status);
  if (active) return `<section class="panel spaced-top-small"><p class="eyebrow">JARVIS AL LAVORO</p><p><strong>${escapeHtml(MISSION_LABEL[mission.status] || mission.status)}</strong></p>${mission.note ? `<p class="muted small">${escapeHtml(mission.note)}</p>` : ''}${mission.status === 'attesa_si' ? `<div class="button-row spaced-top-small"><button class="button" type="button" data-action="mission-yes" data-id="${escapeHtml(mission.id)}">SÌ, pubblica</button><button class="button secondary" type="button" data-action="mission-no" data-id="${escapeHtml(mission.id)}">Non ancora</button></div>` : ''}<div class="button-row spaced-top-small"><button class="button secondary" type="button" data-action="mission-cancel" data-id="${escapeHtml(mission.id)}">Riprendi in mano</button></div></section>`;
  if (!['bozza', 'revisione', 'pronta_pr'].includes(draft.status)) return '';
  const request = requestForDraft(draft);
  const client = state.clients.find((entry) => entry.id === request?.clientId);
  const stopped = mission?.status === 'ferma' ? `<p class="notice warning">Jarvis si era fermato: ${escapeHtml(mission.note || '')}</p>` : '';
  const planOk = request?.kind !== 'nuovo' || ['standard', 'annuale', 'premium'].includes(request?.plan);
  return `<form data-form="entrust-jarvis" class="panel spaced-top-small"><input type="hidden" name="draftId" value="${escapeHtml(draft.id)}"><input type="hidden" name="revision" value="${draft.revision}"><p class="eyebrow">AFFIDA A JARVIS</p>${stopped}<p class="small">Confermando dichiari che hai controllato la bozza: prezzi e piatti corretti, allergeni solo quelli scritti dal locale (le voci senza restano senza), inglese corretto. I dati del locale spuntati qui sopra vengono inseriti.</p>${client?.email ? `<p class="muted small">Poi Jarvis invia l’anteprima a <strong>${escapeHtml(client.email)}</strong> da renmenu1569, legge la risposta, applica da solo le modifiche chiare (prezzi, piatti, coperto) e rimanda l’anteprima. Si ferma su allergeni o risposte ambigue. Prima di pubblicare ti chiede il SÌ su Telegram.</p>` : `<p class="muted small">Il locale non ha un’email: Jarvis manda l’anteprima <strong>a te su Telegram</strong> e pubblica solo dopo il tuo SÌ. Se vuoi che la approvi il locale, aggiungi prima la sua email nella scheda cliente.</p>`}${planOk ? '' : '<p class="notice warning">Prima conferma il piano della pratica (Standard, Annuale o Premium).</p>'}<div class="form-actions spaced-top-small"><button class="button" type="submit" ${planOk && (client?.email || state.telegram?.linked) ? '' : 'disabled'}>Approva e affida a Jarvis</button></div></form>`;
}
function sourceExtrasPanel(draft) {
  const proposals = draft?.sourceExtras || [];
  if (!proposals.length) return '';
  const row = (entry) => entry.type === 'manuale'
    ? `<div class="list-row"><div class="list-main"><strong>Da valutare a mano · riga ${entry.line}</strong><small>«${escapeHtml(entry.source)}»</small><small>${escapeHtml(entry.note || '')}</small></div></div>`
    : `<label class="list-row extra-row"><input type="checkbox" name="accept" value="${escapeHtml(entry.id)}" checked><div class="list-main"><span>${entry.type === 'coperto' ? `Coperto <strong>€ ${escapeHtml(entry.value)}</strong>` : `Allergeni di <strong>${escapeHtml(entry.name)}</strong>: ${escapeHtml(entry.label)}`}</span><small>Riga ${entry.line}: «${escapeHtml(entry.source)}»</small></div></label>`;
  const actionable = proposals.some((entry) => entry.type !== 'manuale');
  return `<form data-form="apply-source-extras" class="panel spaced-top-small"><input type="hidden" name="draftId" value="${escapeHtml(draft.id)}"><input type="hidden" name="revision" value="${draft.revision}"><p class="eyebrow">DATI SCRITTI DAL LOCALE</p><p class="muted small">Coperto e allergeni dichiarati nella richiesta. Jarvis non deduce allergeni dagli ingredienti: propone solo ciò che il locale ha scritto.</p><div class="list spaced-top-small">${proposals.map(row).join('')}</div>${actionable ? '<div class="form-actions spaced-top-small"><button class="button" type="submit">Inserisci nella bozza</button></div>' : ''}</form>`;
}

function replyChangesPanel(draft, approval) {
  const applied = (state.audit || []).some((entry) => entry.requestId === draft.requestId && entry.action === 'draft.reply_changes'
    && String(entry.summary || '').includes(approval.referenceCode) && entry.createdAt >= (approval.replyReceivedAt || ''));
  const proposals = approval.changeProposals || [];
  const sections = (draft.menu?.sezioni || []).map((section, index) => ({ index, name: typeof section.nome === 'string' ? section.nome : section.nome?.it || `Sezione ${index + 1}` }));
  const row = (entry) => {
    if (entry.type === 'manuale') return `<div class="list-row"><div class="list-main"><strong>Da gestire a mano</strong><small>«${escapeHtml(entry.source)}»</small><small>${escapeHtml(entry.note || '')}</small></div></div>`;
    const label = entry.type === 'prezzo' ? `${escapeHtml(entry.name)}: ${escapeHtml(entry.before)} → <strong>${escapeHtml(entry.after)}</strong>`
      : entry.type === 'aggiungi' ? `Aggiungi <strong>${escapeHtml(entry.name)}</strong> · ${escapeHtml(entry.price)}`
      : entry.type === 'coperto' ? `Coperto <strong>€ ${escapeHtml(entry.value)}</strong>`
      : entry.type === 'allergeni' ? `Allergeni di <strong>${escapeHtml(entry.name)}</strong>: ${escapeHtml(entry.label)}` : `Rimuovi <strong>${escapeHtml(entry.name)}</strong>`;
    const select = entry.type === 'aggiungi' ? `<label class="field spaced-top-small">Sezione<select name="section-${escapeHtml(entry.id)}">${sections.map((section) => `<option value="${section.index}" ${section.index === entry.section ? 'selected' : ''}>${escapeHtml(section.name)}</option>`).join('')}</select></label>` : '';
    return `<label class="list-row extra-row"><input type="checkbox" name="accept" value="${escapeHtml(entry.id)}" checked><div class="list-main"><span>${label}</span><small>Dalla risposta: «${escapeHtml(entry.source)}»</small>${select}</div></label>`;
  };
  if (applied && !proposals.some((entry) => entry.type !== 'manuale')) return `<p class="notice"><strong>Modifiche del locale applicate.</strong> Controlla la bozza, rifai la checklist e prepara la nuova anteprima.</p>${proposals.length ? `<div class="list spaced-top-small">${proposals.map(row).join('')}</div>` : ''}`;
  if (!proposals.length) return `<p class="notice warning"><strong>Jarvis non ha trovato modifiche precise nella risposta.</strong> Leggila e correggi la bozza nel Builder.</p><blockquote class="notice spaced-top-small">${escapeHtml(approval.replyText || '').replace(/\n/g, '<br>')}</blockquote>`;
  const actionable = proposals.some((entry) => entry.type !== 'manuale');
  return `<form data-form="apply-reply-changes" class="panel spaced-top-small"><input type="hidden" name="draftId" value="${escapeHtml(draft.id)}"><input type="hidden" name="revision" value="${draft.revision}"><p class="eyebrow">MODIFICHE CHIESTE DAL LOCALE</p><p class="muted small">Jarvis le ha lette nella risposta (rif. ${escapeHtml(approval.referenceCode)}). Togli la spunta a quelle da non applicare.</p><div class="list spaced-top-small">${proposals.map(row).join('')}</div>${actionable ? '<div class="form-actions spaced-top-small"><button class="button" type="submit">Applica alla bozza</button></div>' : ''}</form>`;
}

function approvalPathPanel(draft) {
  const request = requestForDraft(draft);
  const client = clientById(request?.clientId);
  const approval = approvalForDraft(draft);
  const internalDone = ['prices', 'allergens', 'languages'].every((key) => draft.checks?.[key]);
  const usable = approval && !approval.stale && approval.status !== 'modifiche_richieste';
  const previewDone = usable && approval.status !== 'anteprima_pronta';
  const clientDone = Boolean(approval?.valid);
  const isNew = request?.kind === 'nuovo';
  const activationDone = !isNew || Boolean(approval?.activation);
  const live = state.githubMode === 'live';
  const livePr = (state.livePrs || []).find((entry) => entry.draftId === draft.id) || null;
  const mergedAudit = livePr && (state.audit || []).some((entry) => entry.requestId === draft.requestId && entry.action === 'github.pr.merged');
  const liveVerified = livePr?.status === 'merged';
  const published = live ? liveVerified : draft.status === 'pubblicazione_simulata';
  const finalDone = live ? Boolean(livePr && ['pr_open', 'merged'].includes(livePr.status)) : ['pr_simulata', 'pubblicazione_simulata'].includes(draft.status);
  const customerUrl = `https://renmenu.pages.dev/menu/?m=${encodeURIComponent(draft.slug)}`;
  let action = '';
  const mission = missionFor(draft);
  if (mission && !['completata', 'ferma', 'annullata'].includes(mission.status)) action = jarvisMissionPanel(draft);
  else if (!internalDone) action = `${sourceExtrasPanel(draft)}${jarvisMissionPanel(draft)}<p class="notice warning"><strong>Passaggio 1.</strong> Completa la revisione interna (prezzi, allergeni, lingue) e salvala.</p><div class="button-row spaced-top-small"><button class="button secondary" type="button" data-route="revisione">Vai alla revisione</button></div>`;
  else if (!usable) {
    const why = approval?.stale ? 'La bozza è cambiata dopo l’ultima anteprima: serve una nuova anteprima.' : approval?.status === 'modifiche_richieste' ? 'Il locale ha chiesto modifiche: correggi la bozza, poi prepara una nuova anteprima.' : 'Jarvis prepara il link di anteprima e il testo dell’email per il locale.';
    action = `${approval?.status === 'modifiche_richieste' ? replyChangesPanel(draft, approval) : ''}<p class="notice"><strong>Passaggio 2.</strong> ${escapeHtml(why)}</p><label class="field spaced-top-small">Email del locale<input id="preview-recipient" type="email" maxlength="254" value="${escapeHtml(approval?.recipient || client?.email || '')}" placeholder="email del locale"></label><div class="button-row spaced-top-small"><button class="button" type="button" data-action="prepare-preview" data-draft="${escapeHtml(draft.id)}" data-revision="${draft.revision}">Prepara anteprima ed email</button></div>`;
  } else if (approval.status === 'anteprima_pronta') {
    const gmail = `googlegmail:///co?to=${encodeURIComponent(approval.recipient)}&subject=${encodeURIComponent(approval.emailSubject)}&body=${encodeURIComponent(approval.emailBody)}`;
    const mail = `mailto:${encodeURIComponent(approval.recipient)}?subject=${encodeURIComponent(approval.emailSubject)}&body=${encodeURIComponent(approval.emailBody)}`;
    action = `<p class="notice"><strong>Passaggio 2 · invia tu l’email.</strong> Usa l’account <code>renmenu1569@gmail.com</code>: la risposta del locale arriva lì e Jarvis la collega da solo grazie al riferimento <strong>${escapeHtml(approval.referenceCode)}</strong>. Prima di inviare controlla che il campo <strong>Oggetto</strong> sia compilato con il testo qui sotto.</p><p class="muted small spaced-top-small">A: ${escapeHtml(approval.recipient)}<br>Oggetto: ${escapeHtml(approval.emailSubject)}</p><label class="field spaced-top-small">Testo dell’email<textarea readonly rows="9">${escapeHtml(approval.emailBody)}</textarea></label><div class="button-row spaced-top-small"><a class="button secondary" href="${escapeHtml(approval.previewUrl)}" target="_blank" rel="noopener">Apri anteprima</a><a class="button" href="${escapeHtml(gmail)}">Apri in Gmail</a><a class="button secondary" href="${escapeHtml(mail)}">Apri in Mail</a><button class="button secondary" type="button" data-action="copy-preview-email" data-part="subject" data-id="${escapeHtml(approval.id)}">Copia oggetto</button><button class="button secondary" type="button" data-action="copy-preview-email" data-part="body" data-id="${escapeHtml(approval.id)}">Copia testo</button></div><div class="button-row spaced-top-small"><button class="button" type="button" data-action="mark-preview-sent" data-id="${escapeHtml(approval.id)}" data-revision="${approval.revision}">Ho inviato l’email</button></div>`;
  } else if (approval.status === 'anteprima_inviata') {
    action = `<p class="notice"><strong>Passaggio 3 · in attesa del locale.</strong> Anteprima inviata a ${escapeHtml(approval.recipient)} il ${time(approval.sentAt)} (rif. ${escapeHtml(approval.referenceCode)}). Quando risponde, la risposta compare qui.</p><div class="button-row spaced-top-small"><a class="button secondary" href="${escapeHtml(approval.previewUrl)}" target="_blank" rel="noopener">Apri anteprima</a></div>`;
  } else if (approval.status === 'risposta_ricevuta') {
    const assessment = approval.replyAssessment || { suggestion: 'incerta', reply: approval.replyText, note: '' };
    const tone = assessment.suggestion === 'approvazione' ? '' : 'warning';
    const verdict = assessment.suggestion === 'modifiche' ? '<p class="notice danger spaced-top-small"><strong>Jarvis: il locale chiede modifiche.</strong> Tocca «Chiede modifiche»: nel passaggio successivo Jarvis ti propone le correzioni da applicare alla bozza.</p>'
      : assessment.suggestion === 'approvazione' ? '<p class="notice spaced-top-small"><strong>Jarvis: sembra un’approvazione chiara.</strong> Leggi il testo e conferma tu.</p>' : '';
    action = `<p class="notice ${tone}"><strong>Passaggio 3 · risposta del locale.</strong> Da ${escapeHtml(approval.replyFrom)} · ${time(approval.replyReceivedAt)}</p>${verdict}<blockquote class="notice spaced-top-small">${escapeHtml(assessment.reply || '').replace(/\n/g, '<br>')}</blockquote><p class="muted small spaced-top-small">Jarvis: ${escapeHtml(assessment.note)}</p><div class="button-row spaced-top-small"><button class="button ${assessment.suggestion === 'modifiche' ? 'secondary' : ''}" type="button" data-action="client-reply-approve" data-id="${escapeHtml(approval.id)}" data-revision="${approval.revision}" data-suggestion="${escapeHtml(assessment.suggestion)}" ${assessment.suggestion === 'vuota' ? 'disabled' : ''}>È un’approvazione chiara</button><button class="button ${assessment.suggestion === 'modifiche' ? '' : 'secondary'}" type="button" data-action="client-reply-changes" data-id="${escapeHtml(approval.id)}" data-revision="${approval.revision}">Chiede modifiche</button></div>`;
  } else if (clientDone && !activationDone) {
    const expected = PLAN_ACTIVATION[request?.plan];
    action = expected ? `<form data-form="set-activation" class="spaced-top-small"><input type="hidden" name="id" value="${escapeHtml(approval.id)}"><input type="hidden" name="revision" value="${approval.revision}"><input type="hidden" name="activation" value="${expected}"><p class="notice"><strong>Passaggio 4 · attivazione.</strong> Menu nuovo: registra ${escapeHtml(ACTIVATION_LABELS[expected])}. Jarvis non legge Stripe: lo segni tu.</p><div class="form-grid spaced-top-small"><label class="field">Data<input type="date" name="date" required value="${new Date().toISOString().slice(0, 10)}"></label><label class="field">Nota (facoltativa)<input name="note" maxlength="300" placeholder="es. riferimento pagamento"></label></div><div class="form-actions"><button class="button" type="submit">Registra attivazione</button></div></form>` : `<p class="notice danger">Piano della pratica non definito: impostalo prima dell’attivazione.</p>`;
  } else if (live && livePr?.status === 'needs_reconciliation') {
    action = `<p class="notice danger"><strong>Stato della PR incerto.</strong> GitHub non ha confermato l’operazione: non riprovare. Scrivi a Jarvis «PR da verificare» e controlliamo insieme.</p>`;
  // «reserved» = tentativo fermato prima della PR da un errore noto: si può riprovare (stessa chiave, nessuna riscrittura).
  } else if (live && clientDone && activationDone && (!livePr || livePr.status === 'reserved') && draft.status === 'pronta_pr') {
    action = `<p class="notice"><strong>Passaggio 5 · proposta su GitHub.</strong> Jarvis apre una PR che modifica solo <span class="mono">menus/${escapeHtml(draft.slug)}.json</span>. Niente va online finché non tocchi «Pubblica il menu».</p><div class="button-row spaced-top-small"><button class="button" type="button" data-action="live-open-pr">Apri PR su GitHub</button></div>`;
  } else if (live && livePr?.status === 'pr_open' && !mergedAudit) {
    action = `<p class="notice"><strong>Passaggio 6 · pubblicazione reale.</strong> PR #${escapeHtml(livePr.prNumber)} aperta. Se vuoi, controlla la modifica su GitHub, poi pubblica: il menu andrà online sul sito pubblico in 1–2 minuti.</p><div class="button-row spaced-top-small"><a class="button secondary" href="${escapeHtml(livePr.prUrl || '#')}" target="_blank" rel="noopener">Vedi la modifica su GitHub</a><button class="button danger" type="button" data-action="live-merge">Pubblica il menu</button></div>`;
  } else if (live && livePr?.status === 'pr_open' && mergedAudit) {
    action = `<p class="notice"><strong>Passaggio 6 · verifica online.</strong> Pubblicazione avviata: il sito si aggiorna in 1–2 minuti. Poi tocca «Verifica online»: Jarvis controlla che il menu pubblico coincida con quello approvato.</p><div class="button-row spaced-top-small"><a class="button secondary" href="${escapeHtml(customerUrl)}" target="_blank" rel="noopener">Apri il menu pubblico</a><button class="button" type="button" data-action="live-verify">Verifica online</button></div>`;
  } else if (live && liveVerified) {
    action = `<p class="notice"><strong>Menu online e verificato.</strong> Il menu pubblico coincide con la versione approvata dal locale.</p><div class="button-row spaced-top-small"><a class="button" href="${escapeHtml(customerUrl)}" target="_blank" rel="noopener">Apri il menu pubblico</a></div>`;
  } else if (clientDone && !finalDone) action = `<p class="notice"><strong>Passaggio 5 · conferma finale.</strong> Tutto approvato: prepara la PR qui sotto.</p>`;
  const steps = [
    stepRow(1, 'Revisione interna', internalDone, 'Prezzi, allergeni e lingue con fonte.', !internalDone),
    stepRow(2, 'Anteprima al locale', previewDone, approval && usable ? `Rif. ${approval.referenceCode} · ${approval.recipient}` : 'Link di anteprima ed email preparati da Jarvis, inviati da te.', internalDone && !previewDone),
    stepRow(3, 'Approvazione del locale', clientDone, clientDone ? approval.approvalEvidence : approval?.stale && approval?.status === 'approvata_cliente' ? 'Scaduta: la bozza è cambiata dopo l’approvazione.' : 'Risposta email chiara, confermata da te.', previewDone && !clientDone),
    isNew ? stepRow(4, 'Attivazione del servizio', activationDone, approval?.activation ? `${ACTIVATION_LABELS[approval.activation]} · ${approval.activationDate}` : 'Obbligatoria per i menu nuovi.', clientDone && !activationDone) : stepRow(4, 'Attivazione del servizio', true, 'Non richiesta: aggiornamento di un locale già attivo. Menu ID e QR restano invariati.'),
    stepRow(5, 'Conferma finale e PR', finalDone, live ? (livePr?.prNumber ? `PR #${livePr.prNumber} su GitHub, solo il file del menu.` : 'PR su GitHub con il solo file del menu, dopo la tua frase di conferma.') : 'Riepilogo, frase di conferma, PR con il solo file del menu.', clientDone && activationDone && !finalDone),
    stepRow(6, 'Pubblicazione e verifica', published, live ? (liveVerified ? 'Online e verificato.' : 'Pubblicazione reale con frase di conferma, poi verifica online.') : 'Ora simulata: la pubblicazione reale si abilita con il token GitHub.', live ? Boolean(livePr && !liveVerified) : draft.status === 'pr_simulata')
  ].join('');
  return `<section class="panel spaced-top"><p class="eyebrow">PERCORSO DI PUBBLICAZIONE</p><h2>Prima della pubblicazione reale</h2><div class="list">${steps}</div><div class="spaced-top">${action}</div></section>`;
}

function renderApprovals() {
  const draft = draftForRequest();
  if (!draft) return `<div class="view-wrap">${header('08 / CONFERME', 'Approvazioni', 'Checklist obbligatoria, PR di prova e pubblicazione simulata: nessun bypass.')}<section class="panel">${empty('Nessuna bozza selezionata.')}</section></div>`;
  const fieldEvidence = draft.fieldEvidence || draft.checks?.fieldEvidence || reviewEvidenceCache.get(draft.id) || {};
  const allChecks = reviewIssues(draft.menu, { ...draft.checks, fieldEvidence }, requestForDraft(draft)?.plan ?? null).issues.length === 0;
  const proposal = state.proposals.find((entry) => entry.draftId === draft.id);
  const readyForPublish = draft.status === 'pr_simulata' && proposal;
  return `<div class="view-wrap">${header('08 / CONFERME', 'Approvazioni', 'Revisione, anteprima al locale, sua approvazione scritta, attivazione e conferma finale: nessun passaggio si salta.', `<label class="field">Pratica<select data-select-request>${requestOptions(selectedRequestId)}</select></label>`)}${approvalPathPanel(draft)}<div class="grid grid-2 spaced-top"><section class="panel"><p class="eyebrow">CHECKLIST OBBLIGATORIA</p><h2>Revisione contenuto</h2><div class="checklist">${checkRows(draft.checks)}</div>${criticalFields(draft.menu).allergensMissing.length ? `<p class="notice danger spaced-top-small"><strong>ALLERGENI NON CONFERMATI DAL LOCALE</strong><br>Nessun allergene viene inferito. L’omissione nel mock richiede conferma scritta distinta.</p>` : ""}<p class="notice ${allChecks ? '' : 'warning'} spaced-top"><strong>${allChecks ? 'Checklist ed evidenze complete.' : 'Checklist o evidenze incomplete.'}</strong> Checkbox e riferimenti controllabili per prezzi, allergeni e lingue sono tutti obbligatori.</p><div class="button-row spaced-top"><button class="button secondary" type="button" data-route="revisione">Torna alla checklist</button><button class="button" type="button" data-action="open-confirm" data-confirm-kind="pr" ${allChecks && draft.status === 'pronta_pr' && state.githubMode !== 'live' ? '' : 'disabled'}>Prepara PR di prova</button></div></section><section class="panel"><p class="eyebrow">SECONDO PASSAGGIO</p><h2>Pubblicazione simulata</h2><div class="notice danger"><strong>Non pubblica nulla.</strong> Nessun menu, QR, repository o provider viene aggiornato da questa schermata.</div>${proposal ? `<div class="list-row spaced-top"><div class="list-main"><strong>PR di prova pronta</strong><small>${escapeHtml(proposal.branchName || `menu/${draft.slug}-demo`)} · ${escapeHtml(proposal.filePath || `menus/${draft.slug}.json`)}</small><small><span class="mono">${escapeHtml(proposal.id.slice(0, 8))}</span> · ${time(proposal.createdAt)}</small></div><span class="status info">mock</span></div>` : '<p class="muted">Prima completa la checklist e prepara una PR simulata.</p>'}<div class="button-row spaced-top"><button class="button danger" type="button" data-action="open-confirm" data-confirm-kind="publish" ${readyForPublish && state.githubMode !== 'live' ? '' : 'disabled'}>Conferma pubblicazione simulata</button></div></section></div><section class="panel"><p class="eyebrow">STATO CORRENTE</p><h2>${escapeHtml(statusLabel(draft.status))}</h2>${draft.status === 'pubblicazione_simulata' ? '<p class="notice danger"><strong>Il menu NON è online.</strong> Questa è solo una simulazione registrata: nessun file su GitHub, nessun deploy, nessun QR reale e nessun messaggio al cliente. La pubblicazione reale non parte da qui e richiede la tua approvazione esplicita.</p>' : ''}${planWarnings(draft.menu, requestForDraft(draft)?.plan).map((warning) => `<p class="notice warning spaced-top-small"><strong>Avviso, non bloccante.</strong> ${escapeHtml(warning)}</p>`).join('')}<p class="muted">Cliente: ${escapeHtml(clientById(requestForDraft(draft)?.clientId)?.name || '—')} · File: <span class="mono">menus/${escapeHtml(draft.slug)}.json</span> · URL proposto: <span class="mono">/menu/?m=${escapeHtml(draft.slug)}</span> · nessuna pubblicazione reale.</p><p class="muted">Bozza <span class="mono">${escapeHtml(draft.slug)}</span> · revisione <span class="mono">${draft.revision}</span></p></section></div>`;
}

function ownerEmailCard() {
  const initialRequest = requestById() || state.requests[0] || null;
  if (!initialRequest) return `<section class="panel owner-email-card"><p class="eyebrow">EMAIL AL PROPRIETARIO</p><h2>Nessuna pratica selezionabile</h2>${empty('Crea o seleziona una pratica prima di preparare un avviso per il proprietario.')}</section>`;
  const disabled = isDemoMode ? ' disabled' : '';
  const subject = `Controllo richiesto · ${initialRequest.subject}`.slice(0, 180);
  const body = isDemoMode
    ? `Simulazione senza invio per la pratica “${initialRequest.subject}”. Nessun messaggio viene inviato dalla demo locale.`
    : `Verificare la pratica “${initialRequest.subject}” prima di procedere. I dati e i materiali restano nel perimetro di staging privato.`;
  return `<section class="panel owner-email-card"><div class="panel-heading"><div><p class="eyebrow">EMAIL AL PROPRIETARIO</p><h2>Avviso operativo riservato</h2></div><span class="capsule">solo proprietario</span></div><p class="notice"><strong>Destinatario bloccato:</strong> <code>renmenu1569@gmail.com</code>. Non sono disponibili invii a clienti, WhatsApp o telefonate.</p><form data-form="send-owner-email" class="spaced-top"><fieldset${disabled}><div class="form-grid"><label class="field">Pratica esistente<select name="requestId" required>${requestOptions(initialRequest.id)}</select></label><label class="field">Priorità<select name="priority"><option value="normale">Normale</option><option value="importante" selected>Importante</option><option value="urgente">Urgente</option></select></label><label class="field full">Oggetto<input name="subject" required maxlength="180" value="${escapeHtml(subject)}"></label><label class="field full">Testo<textarea name="text" required maxlength="4000">${escapeHtml(body)}</textarea></label></div><div class="form-actions"><button class="button" type="submit">Invia solo al proprietario</button></div></fieldset></form>${isDemoMode ? '<p class="notice warning owner-email-disabled"><strong>simulazione senza invio</strong> — la card è disabilitata nella demo locale.</p>' : '<p class="muted small">La conferma è solo on-screen. L’azione richiede Cloudflare Access e una configurazione Resend valida; l’esito non verrà presentato come consegna se il provider non la conferma.</p>'}</section>`;
}
function ownerEmailConfirmationSummary({ request, client, subject, text: body, priority }) {
  const payload = { requestId: request?.id || '', subject, text: body, priority, confirmation: 'CONFERMO EMAIL AL PROPRIETARIO' };
  return [
    `Cliente: ${client?.name || 'da verificare'}`,
    'Email: renmenu1569@gmail.com',
    `Testo: ${body}`,
    `Richiesta: ${request?.subject || 'da verificare'} (${request?.id || 'ID non disponibile'})`,
    `Oggetto: ${subject}`,
    `Priorità: ${priority}`,
    'Conferma: CONFERMO EMAIL AL PROPRIETARIO',
    `Payload API: ${JSON.stringify(payload)}`,
    'Azione: invio esclusivamente al proprietario; nessun cliente, WhatsApp o telefono viene contattato.'
  ].join('\n');
}
function ownerEmailResultToast(result) {
  const deliveryId = result?.deliveryId ? ` ID consegna: ${result.deliveryId}.` : '';
  if (result?.sent === true && result?.status === 'sent') {
    return { type: 'ok', message: `Email al solo proprietario accettata da Resend.${deliveryId} La consegna nella casella non è confermata da questa schermata.` };
  }
  if (result?.duplicate && result?.status === 'sent') {
    return { type: 'ok', message: `Email già accettata dal provider in precedenza.${deliveryId} Non è stato eseguito un nuovo invio.` };
  }
  const configurationReasons = new Set(['EMAIL_LIVE_DISABLED', 'MISSING_RESEND_API_KEY', 'EMAIL_FROM_NOT_VERIFIED', 'INVALID_EMAIL_FROM', 'ONBOARDING_SENDER_NOT_AUTHORIZED', 'OWNER_EMAIL_MISMATCH', 'STAGING_NOT_PROTECTED', 'INVALID_ENVIRONMENT']);
  if (configurationReasons.has(result?.reason)) {
    return { type: 'error', message: `Email non inviata: configurazione Resend/Access non disponibile (${result.reason}). Nessuna consegna è stata dichiarata.` };
  }
  if (result?.status === 'unknown' || result?.reason === 'PROVIDER_UNAVAILABLE') {
    return { type: 'error', message: `Esito Resend non confermato${deliveryId} Nessuna consegna viene dichiarata.${result?.reason ? ` Motivo: ${result.reason}.` : ''}` };
  }
  if (result?.status === 'failed' || result?.reason) {
    return { type: 'error', message: `Email non inviata${deliveryId}${result?.reason ? ` Motivo: ${result.reason}.` : ''} Nessuna consegna è stata dichiarata.` };
  }
  return { type: 'error', message: 'Email non inviata: risposta Resend/Access non valida. Nessuna consegna è stata dichiarata.' };
}
function renderNotifications() {
  const request = requestById();
  const notes = state.notifications.filter((item) => !item.requestId || item.requestId === selectedRequestId);
  const messages = state.messages.filter((item) => item.requestId === selectedRequestId);
  const description = isDemoMode
    ? 'Priorità e lettura sono mock locali; tutti i messaggi restano bozze mock e nessun provider è collegato.'
    : 'Le notifiche e le bozze sono record di staging privato. Restano mock, salvo l’email esplicitamente confermata al solo proprietario.';
  return `<div class="view-wrap">${header('09 / COMUNICAZIONI', 'Notifiche e bozze messaggi', description, `<label class="field">Pratica<select data-select-request>${requestOptions(selectedRequestId, true)}</select></label>`)}${ownerEmailCard()}<div class="grid grid-equal spaced-top"><section class="panel"><p class="eyebrow">NOTIFICA INTERNA MOCK</p><h2>Segnala un controllo</h2><form data-form="add-notification"><input type="hidden" name="requestId" value="${escapeHtml(selectedRequestId || '')}"><div class="form-grid"><label class="field">Canale<select name="channel"><option value="in_app">Interno</option><option value="email">Email mock</option><option value="whatsapp">WhatsApp mock</option><option value="telefono">Chiamata mock</option></select></label><label class="field">Priorità<select name="priority"><option value="normale" selected>Normale</option><option value="importante">Importante</option><option value="urgente">Urgente</option></select></label><label class="field">Scadenza facoltativa<input name="dueAt" type="datetime-local"></label><label class="field">Oggetto<input name="subject" required maxlength="100" placeholder="Es. prezzo da confermare"></label><label class="field full">Testo<textarea name="body" required maxlength="600" placeholder="Descrivi quale fonte manca."></textarea></label></div><div class="form-actions"><button class="button" type="submit">Aggiungi notifica mock</button></div></form></section><section class="panel"><p class="eyebrow">BOZZA CLIENTE MOCK</p><h2>Prepara bozza, non inviare</h2>${request ? `<form data-form="save-message"><input type="hidden" name="requestId" value="${escapeHtml(request.id)}"><label class="field">Canale mock<select name="channel"><option value="whatsapp">Bozza WhatsApp</option><option value="email">Bozza email</option></select></label><label class="field spaced-top-small">Testo<textarea name="body" required maxlength="900" placeholder="Ciao, puoi confermare…"></textarea></label><p class="notice warning">Il pulsante salva solo una bozza mock. Non esiste invio reale.</p><div class="form-actions"><button class="button" type="submit">Salva bozza mock, non inviare</button></div></form>` : empty('Seleziona una pratica per preparare una bozza mock.')}</section></div><section class="panel spaced-top"><p class="eyebrow">SIMULAZIONI DI CANALE</p><h2>Eventi in ingresso mock senza provider</h2><div class="grid grid-equal"><form data-form="mock-whatsapp"><label class="field">Numero fittizio collegato al cliente<input name="from" value="+390000000001" required></label><label class="field">Messaggio WhatsApp fittizio<textarea name="body" required placeholder="Vorrei aggiornare il mio menù"></textarea></label><button class="button secondary" type="submit">Simula messaggio entrante</button></form><form data-form="mock-call"><label class="field">Pratica<select name="requestId">${requestOptions(selectedRequestId)}</select></label><label class="field">Avviso per Riccardo<textarea name="message" required placeholder="Bozza urgente da rivedere"></textarea></label><button class="button secondary" type="submit">Simula chiamata non avviata</button></form></div><p class="muted small">Nessun webhook, WhatsApp, telefono o SMS viene contattato.</p></section><div class="grid grid-equal spaced-top"><section class="panel"><p class="eyebrow">NOTIFICHE MOCK</p><h2>Registro operativo</h2><div class="stack">${notes.length ? notes.map((note) => `<div class="list-row"><div class="list-main"><strong>${escapeHtml(note.subject)}</strong><small>${escapeHtml(note.body)} · priorità ${escapeHtml(note.priority || 'normale')}${note.dueAt ? ` · scade ${time(note.dueAt)}` : ''}</small></div><div class="list-meta"><span class="status ${note.priority === 'urgente' ? 'alert' : note.priority === 'importante' ? 'wait' : 'info'}">${escapeHtml(note.priority || 'normale')}</span><span class="capsule">mock</span><button class="button secondary small-button" type="button" data-action="mark-notification" data-notification-id="${note.id}" data-read="${note.readAt ? 'false' : 'true'}">${note.readAt ? 'Segna non letta' : 'Segna letta'}</button></div></div>`).join('') : empty('Nessuna notifica mock nel contesto selezionato.')}</div></section><section class="panel"><p class="eyebrow">BOZZE MOCK</p><h2>Non inviate</h2><div class="stack">${messages.length ? messages.map((message) => `<div class="list-row"><div class="list-main"><strong>${escapeHtml(message.channel)}</strong><small>${escapeHtml(message.body)} · ${time(message.createdAt)}</small></div><span class="status wait">bozza mock</span></div>`).join('') : empty('Nessuna bozza mock per questa pratica.')}</div></section></div></div>`;
}

function renderAudit() {
  const records = [...state.audit].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return `<div class="view-wrap">${header('10 / TRACCIABILITÀ', 'Registro audit', 'Azioni demo e API rimangono collegate a pratica, orario e sintesi.')}<section class="panel"><div class="panel-heading"><div><p class="eyebrow">EVENTI</p><h2>Registro immutabile lato interfaccia</h2></div><span class="capsule">${records.length} eventi</span></div><div class="timeline">${records.length ? records.map((record) => { const request = requestById(record.requestId); return `<article class="timeline-item"><time>${time(record.createdAt)} · ${escapeHtml(record.action)}</time><p><strong>${escapeHtml(record.summary)}</strong></p><small class="muted">${request ? escapeHtml(request.subject) : 'Contesto generale'} · <span class="mono">${escapeHtml(record.id.slice(0, 8))}</span></small></article>`; }).join('') : empty('Nessun evento registrato.')}</div></section></div>`;
}

function renderVoiceHistory() {
  if (!voiceHistory.length) return '<p class="muted">La conversazione apparirà qui, sempre in testo e correggibile prima dell’invio.</p>';
  return `<ol class="voice-history" aria-label="Cronologia conversazione">${voiceHistory.map((turn) => `<li class="voice-turn ${turn.role === 'user' ? 'user' : 'assistant'}"><span>${turn.role === 'user' ? 'Riccardo' : 'Jarvis'}${turn.at ? ` · ${escapeHtml(shortTime(turn.at))}` : ''}</span><p>${escapeHtml(turn.text)}</p></li>`).join('')}</ol>`;
}
function renderVoiceProposal() {
  if (!voiceProposal) return '<section class="voice-proposal"><p class="eyebrow">PROPOSTA CORREGGIBILE</p><h3>Nessuna proposta pronta</h3><p class="muted small">Puoi chiedere una proposta di prezzo, sezione, voce o bozza messaggio. Jarvis preparerà solo testo: non applica né salva modifiche.</p></section>';
  const allowedTarget = voiceProposal.target === 'notifiche' ? 'notifiche' : 'revisione';
  return `<section class="voice-proposal" aria-labelledby="voice-proposal-title"><div class="panel-heading"><div><p class="eyebrow">PROPOSTA CORREGGIBILE</p><h3 id="voice-proposal-title">${escapeHtml(voiceProposal.title || 'Proposta da verificare')}</h3></div><span class="status wait">non applicata</span></div><form data-form="voice-proposal"><label class="field">Titolo proposta<input name="title" required maxlength="120" value="${escapeHtml(voiceProposal.title || '')}"></label><label class="field spaced-top-small">Testo da correggere e verificare<textarea name="text" required maxlength="900">${escapeHtml(voiceProposal.text || '')}</textarea></label><label class="field spaced-top-small">Destinazione scelta manualmente<select name="target"><option value="revisione" ${allowedTarget === 'revisione' ? 'selected' : ''}>Revisione editoriale</option><option value="notifiche" ${allowedTarget === 'notifiche' ? 'selected' : ''}>Bozze messaggi</option></select></label><label class="check-row spaced-top-small"><input type="checkbox" name="confirmed" ${voiceProposal.confirmed ? 'checked' : ''}><span><strong>Ho corretto e verificato questa proposta</strong><small>Confermo soltanto il passaggio alla schermata scelta. La proposta non modifica dati, non salva, non invia, non pubblica e non approva nulla.</small></span></label><div class="form-actions"><button class="button secondary" type="submit">Aggiorna solo proposta</button><button class="button" type="button" data-action="navigate-voice-proposal" ${voiceProposal.confirmed ? '' : 'disabled'}>Apri ${allowedTarget === 'revisione' ? 'Revisione' : 'bozze messaggi'} per riportarla manualmente</button><button class="button secondary" type="button" data-action="clear-voice-proposal">Scarta proposta</button></div></form></section>`;
}
function renderVoice() {
  const settings = voiceSettings();
  const context = requestById();
  const materialCount = context ? state.materials.filter((item) => item.requestId === context.id && !item.archivedAt).length : 0;
  const draft = draftForRequest();
  const historyNotice = isDemoMode ? 'Cronologia demo: massimo 6 scambi, testo sanificato in sessionStorage solo per questa scheda.' : 'Cronologia area privata: solo memoria della pagina corrente; non viene scritta in sessionStorage.';
  return `<div class="view-wrap">${header('11 / VOCE', 'Voce e comandi', 'Assistente testuale deterministico sullo stato corrente, non un provider AI live. Microfono facoltativo, trascrizione correggibile e nessun comando approva o pubblica.')}<div class="grid grid-2"><section class="panel"><div class="voice-box"><div class="voice-orb" aria-hidden="true">///</div><p class="eyebrow">VOICE DESK · ${settings.enabled ? 'ATTIVO SOLO SU RICHIESTA' : 'SPENTO'}</p><h2>Parla o scrivi</h2><p class="muted">Alcuni browser possono elaborare il riconoscimento audio tramite un proprio servizio remoto: autorizzalo soltanto se lo desideri. RenMenu non salva l’audio; il testo resta correggibile prima dell’invio.</p><div class="notice"><strong>Contesto corrente:</strong> ${escapeHtml(context?.subject || 'nessuna pratica selezionata')} · ${materialCount} materiali attivi · ${draft ? `bozza ${escapeHtml(draft.slug)}` : 'nessuna bozza'}.</div><label class="check-row voice-setting"><input id="voice-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}><span><strong>Abilita voce browser</strong><small>Disattiva in qualsiasi momento; il microfono non è mai sempre acceso.</small></span></label><div class="voice-controls"><button class="button secondary voice-mic" type="button" data-action="voice-mic" ${!settings.enabled || !speechAvailable ? 'disabled' : ''}>Microfono</button><button class="button secondary" type="button" data-action="voice-stop">Ferma ascolto</button><button class="button voice-speak" type="button" data-action="voice-speak" ${!settings.enabled || !synthesisAvailable || !lastVoiceReply ? 'disabled' : ''}>Ascolta Jarvis</button></div><p class="notice warning voice-status" id="voice-status" role="status">${escapeHtml(voiceStatus)}</p><form data-form="voice"><label class="field">Pratica facoltativa<select name="requestId">${requestOptions(selectedRequestId, true)}</select></label><label class="field spaced-top-tight">Trascrizione correggibile<textarea id="voice-input" name="transcript" required maxlength="500" placeholder="Es. Cosa devo fare oggi?">${escapeHtml(lastVoiceTranscript)}</textarea></label><p class="muted small">${speechAvailable ? 'Riconoscimento vocale disponibile, avviato solo con il tasto Microfono.' : 'SpeechRecognition non disponibile: usa il testo. La sintesi può funzionare separatamente.'}</p><div class="form-actions"><button class="button" type="submit">Interpreta senza eseguire</button></div></form>${renderVoiceProposal()}<section class="voice-replies" aria-labelledby="voice-history-title"><div class="panel-heading"><div><p class="eyebrow">CONVERSAZIONE</p><h3 id="voice-history-title">Cronologia contestuale</h3></div>${isDemoMode && voiceHistory.length ? '<button class="button secondary small-button" type="button" data-action="clear-voice-history">Cancella cronologia demo</button>' : ''}</div><p class="muted small">${historyNotice}</p>${renderVoiceHistory()}</section></div></section><aside class="panel"><p class="eyebrow">PREFERENZE</p><h2>Voce originale RenMenu</h2><label class="field voice-setting">Velocità <output id="voice-rate-output">${settings.rate.toFixed(1)}×</output><input id="voice-rate" type="range" min="0.6" max="1.4" step="0.1" value="${settings.rate}"></label><label class="field voice-setting">Volume <output id="voice-volume-output">${Math.round(settings.volume * 100)}%</output><input id="voice-volume" type="range" min="0" max="1" step="0.1" value="${settings.volume}"></label><label class="field">Motore voce<select id="voice-provider"><option value="browser">Sistema / browser</option><option value="provider" disabled>Provider TTS non configurato</option></select></label><div class="notice spaced-top"><strong>Guardrail:</strong> domande su pratiche, materiali, dubbi e azioni usano soltanto lo stato corrente. “Pubblica il menù” apre solo una richiesta di conferma a schermo.</div><div class="button-row spaced-top"><button class="button secondary" type="button" data-route="approvazioni">Apri conferme</button><button class="button secondary" type="button" data-route="registro">Vedi registro</button></div></aside></div></div>`;
}

function renderAiPanel() {
  const request = requestById();
  if (!request || isDemoMode) return '';
  const current = aiPreview?.requestId === request.id && aiPreview.requestRevision === request.revision ? aiPreview : null;
  const result = current?.result;
  const title = current?.type === 'aiExtractMenu' ? 'Proposta di menù da revisionare' : 'Classificazione da revisionare';
  return `<section class="panel spaced-top" id="ai-advisory"><div class="panel-heading"><div><p class="eyebrow">AI · SOLO BOZZA</p><h2>Analisi assistita della pratica</h2></div><span class="capsule">nessuna pubblicazione</span></div><p class="notice warning"><strong>Invio al provider AI configurato:</strong> questi pulsanti inviano solo il testo della pratica e, per l’estrazione, le trascrizioni private già registrate. Non inviano il PDF originale o le immagini. L’account Cloudflare verificato oggi è su Workers Free: richieste oltre la quota gratuita falliscono, ma un futuro cambio di piano potrebbe comportare costi. Il server permette soltanto la fixture sigillata e massimo tre tentativi al giorno per azione. Una risposta riuscita resta una proposta da revisionare: nessun campo, bozza, PR o messaggio viene salvato automaticamente.</p><div class="button-row spaced-top"><button class="button secondary" type="button" data-action="ai-classify" ${!aiBusy && String(request.sourceText || '').trim() ? '' : 'disabled'}>Classifica richiesta (bozza)</button><button class="button secondary" type="button" data-action="ai-extract" ${aiBusy ? 'disabled' : ''}>Analizza menù (bozza)</button></div>${aiBusy ? '<p class="muted small spaced-top" role="status">Analisi AI in corso; attendi l’esito prima di riprovare.</p>' : current?.error ? `<p class="notice danger spaced-top" role="alert">Analisi non completata: ${escapeHtml(current.error)}</p>` : result ? `<div class="spaced-top" role="status"><h3>${title}</h3><p class="muted small">Provider: ${escapeHtml(current.provider)} · revisione pratica ${escapeHtml(request.revision)}. Confronta ogni campo e riferimento con la fonte originale; eventuali errori bloccanti restano da correggere.</p><pre class="json-editor private-material-text">${escapeHtml(JSON.stringify(result, null, 2))}</pre></div>` : '<p class="muted small spaced-top">Nessuna analisi AI eseguita in questa sessione.</p>'}</section>`;
}
function renderView() {
  const renderers = { command: renderCommand, richieste: renderRequests, clienti: renderClients, materiali: renderMaterials, builder: renderBuilder, revisione: renderReview, anteprima: renderPreview, approvazioni: renderApprovals, notifiche: renderNotifications, registro: renderAudit, voce: renderVoice };
  view.innerHTML = renderers[activeView]() + (activeView === 'builder' ? renderAiPanel() : '');
  document.title = `${navItems.find(([id]) => id === activeView)?.[2] || 'Control Room'} · RenMenu`;
}
function render() {
  if (!state) return;
  if (!requestById()) selectedRequestId = state.requests[0]?.id || null;
  if (!clientById(selectedClientId)) selectedClientId = requestById()?.clientId || state.clients[0]?.id || null;
  modeBadge.textContent = isDemoMode ? 'DEMO LOCALE · OFFLINE' : 'STAGING PRIVATO';
  renderNavigation();
  renderView();
}
function routeFromHash() {
  const target = location.hash.replace(/^#/, '');
  return validViews.has(target) ? target : 'command';
}
function navigate(target) {
  if (!validViews.has(target)) return;
  closeMaterialViewer();
  mobileMenuOpen = false;
  if (location.hash !== `#${target}`) location.hash = target;
  else { activeView = target; render(); $('#main-content').focus(); }
}

let autopilotRunning = false;
let telegramLinkUrl = '';
async function refresh() {
  state = await loadState();
  if (!state || !Array.isArray(state.requests)) throw new Error('Stato API non conforme al contratto.');
  if (!requestById()) selectedRequestId = state.requests[0]?.id || null;
  render();
  // Autopilota: appena la Control Room si apre, Jarvis lavora sulle richieste nuove.
  if (!isDemoMode && state.autopilotPending > 0 && !autopilotRunning) {
    autopilotRunning = true; render();
    performAction('runAutopilot', {}).then(async (response) => {
      autopilotRunning = false;
      const done = response?.result?.done || [];
      await refresh();
      if (done.length) toast(done.map((entry) => entry.outcome === 'bozza' ? 'Jarvis: bozza pronta.' : 'Jarvis: serve una tua decisione.').join(' '));
    }).catch(() => { autopilotRunning = false; render(); });
  }
}
async function doAction(type, payload, successMessage) {
  const response = await performAction(type, payload);
  const result = response?.result ?? response;
  await refresh(); // Contract: the page reloads state after every action.
  if (successMessage) toast(successMessage);
  return result;
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
  const syntheticSnapshot = isDemoMode && request?.kind !== 'nuovo' ? state.publicMenuSnapshots?.[draft.slug] : null;
  const previous = syntheticSnapshot?.menu || draft.versions?.[0]?.menu;
  const changes = previous ? menuDiff(previous, draft.menu).changes : [];
  const count = draft.menu?.sezioni?.reduce((sum, section) => sum + (section.voci?.length || 0), 0) || 0;
  const lines = [
    `Cliente: ${client?.name || 'da verificare'}. Pratica: ${request?.subject || draft.requestId}.`,
    `Menù: ${draft.slug} (${count} voci); file coinvolto: menus/${draft.slug}.json.`,
    `Materiali: ${files.length ? files.join(', ') : 'solo testo della pratica'}.`,
    `URL proposto, NON attivo: /menu/?m=${draft.slug}.`,
    ...planWarnings(draft.menu, request?.plan).map((warning) => `Avviso: ${warning}`),
    `Differenze rispetto a ${syntheticSnapshot ? "snapshot FINTIZIO, non GitHub" : "versione bozza, non menu live"}: ${changes.length ? changes.map((item) => `${item.label}: ${item.before ?? '—'} → ${item.after ?? '—'}`).join('; ').slice(0, 400) : 'nessuna versione precedente confrontabile; il menu live non è stato letto'}.`,
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
  if (action === 'ai-classify' || action === 'ai-extract') {
    if (isDemoMode) throw new Error('La demo locale non invia richieste al provider AI.');
    if (aiBusy) throw new Error('Un’analisi è già in corso; attendi il risultato.');
    const request = requestById();
    if (!request) throw new Error('Seleziona una pratica prima di avviare l’analisi.');
    const type = action === 'ai-classify' ? 'aiClassifyRequest' : 'aiExtractMenu';
    openConfirmation({ title: 'Analisi AI della sola pratica fittizia',
      copy: `Pratica: ${request.subject} (${request.id}).\nAl provider AI configurato nello staging verrà inviato il testo della pratica${type === 'aiExtractMenu' ? ' e il testo delle trascrizioni private registrate' : ''}; non il binario del PDF o immagini. Nell’account Workers Free attuale il modello usa la quota gratuita e il server blocca i testi diversi dalla fixture sigillata. Non usare dati reali di clienti. Esito: solo proposta da revisionare, senza menù salvato, PR, messaggi o pubblicazione.`,
      phrase: 'CONFERMO INVIO AI TEST', button: 'Analizza solo la pratica fittizia', type,
      payload: { requestId: request.id, requestRevision: request.revision, confirmation: 'CONFERMO INVIO AI TEST' },
      resultToast: (result) => {
        aiPreview = { requestId: request.id, requestRevision: request.revision, type,
          provider: result.provider, result: type === 'aiClassifyRequest' ? result.classification :
            { menu: result.menu, validation: result.validation, extraction: result.extraction } };
        return { message: 'Proposta AI ricevuta: verifica la fonte prima di ogni utilizzo.' };
      } });
    return;
  }
  if (action === 'preview-material') {
    const material = state.materials.find((entry) => entry.id === trigger.dataset.materialId);
    await openMaterialPreview(material); return;
  }
  if (action === 'extract-pdf-text') {
    if (isDemoMode) throw new Error('La demo non estrae né salva testo dai materiali: il PDF fittizio resta una fixture statica.');
    const material = state.materials.find((entry) => entry.id === trigger.dataset.materialId);
    const request = material && requestById(material.requestId);
    if (!material || !request || material.archivedAt) throw new Error('Materiale o pratica non disponibili. Ricarica prima di estrarre.');
    if (material.mime !== 'application/pdf') throw new Error('L’estrazione locale è disponibile solo per PDF privati.');
    const preview = await fetchMaterialPreview(material.id);
    const extracted = await extractPdfText(preview.blob);
    const text = String(extracted.text || '').slice(0, 50000).trim();
    if (!text) throw new Error(extracted.warnings?.[0] || 'Il PDF non contiene testo selezionabile. Usa la trascrizione manuale; nessun OCR è stato avviato.');
    const warnings = Array.isArray(extracted.warnings) && extracted.warnings.length ? ` Avvisi: ${extracted.warnings.join(' ')}` : '';
    if (!window.confirm(`Il testo verrà registrato come NON CONFERMATO e richiederà revisione sul PDF originale. Nessun OCR o servizio esterno verrà usato. Procedere?${warnings}`)) return;
    await performAction('setMaterialTranscript', { materialId: material.id, requestRevision: request.revision, text });
    await refresh();
    toast(`Testo PDF locale registrato come non confermato.${warnings}`);
    return;
  }
  if (action === 'close-material-viewer') { closeMaterialViewer(); return; }
  if (action === 'material-zoom-in') { changeMaterialZoom(.25); return; }
  if (action === 'material-zoom-out') { changeMaterialZoom(-.25); return; }
  if (action === 'clear-voice-history') { clearVoiceHistory(); voiceStatus = 'Cronologia demo cancellata.'; render(); return; }
  if (action === 'clear-voice-proposal') { voiceProposal = null; render(); return; }
  if (action === 'navigate-voice-proposal') {
    if (!voiceProposal?.confirmed) throw new Error('Correggi e conferma prima la proposta sullo schermo.');
    navigate(voiceProposal.target === 'notifiche' ? 'notifiche' : 'revisione'); return;
  }
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
  if (action === 'mission-yes' || action === 'mission-no') {
    await doAction('jarvisDecide', { missionId: trigger.dataset.id, yes: action === 'mission-yes' }, action === 'mission-yes' ? 'Ricevuto: Jarvis pubblica e verifica.' : 'Pubblicazione sospesa.');
    return;
  }
  if (action === 'mission-cancel') {
    await doAction('cancelMission', { missionId: trigger.dataset.id }, 'Pratica ripresa in mano: Jarvis si ferma.');
    return;
  }
  if (action === 'telegram-link') {
    const response = await performAction('telegramLink', {});
    const link = response?.result?.link;
    if (link) { telegramLinkUrl = link; render(); }
    return;
  }
  if (action === 'read-material') {
    await doAction('readMaterial', { materialId: trigger.dataset.materialId }, 'Jarvis ha letto il file: controlla il testo e le righe da verificare.');
    return;
  }
  if (action === 'jarvis-briefing') {
    await doAction('jarvisBriefing', {}, 'Briefing inviato su Telegram e nel riquadro Jarvis.');
    return;
  }
  if (action === 'voice-test') {
    await doAction('testVoice', {}, 'Vocale di prova inviato su Telegram.');
    return;
  }
  if (action === 'telegram-test') {
    await doAction('telegramTest', {}, 'Messaggio di prova inviato su Telegram.');
    return;
  }
  if (action === 'mark-notification') {
    await doAction('markNotificationRead', { id: trigger.dataset.notificationId, read: trigger.dataset.read === 'true' }, 'Stato di lettura aggiornato.');
    return;
  }
  if (action === 'archive-material') {
    const linkedDraft = draftForRequest(state.materials.find((entry) => entry.id === trigger.dataset.materialId)?.requestId);
    if (linkedDraft) reviewEvidenceCache.delete(linkedDraft.id);
    closeMaterialViewer();
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
  if (action === 'toggle-archived') {
    showArchived = !showArchived;
    render();
    return;
  }
  if (action === 'prepare-preview') {
    const recipient = String($('#preview-recipient')?.value || '').trim();
    await doAction('preparePreview', { draftId: trigger.dataset.draft, revision: Number(trigger.dataset.revision), ...(recipient ? { recipient } : {}) }, 'Anteprima ed email pronte: inviala da Gmail con l’account RenMenu.');
    return;
  }
  if (action === 'copy-preview-email') {
    const approval = (state.approvals || []).find((entry) => entry.id === trigger.dataset.id);
    if (!approval) return;
    const subjectOnly = trigger.dataset.part === 'subject';
    try { await navigator.clipboard.writeText(subjectOnly ? approval.emailSubject : approval.emailBody); toast(subjectOnly ? 'Oggetto copiato: incollalo nel campo Oggetto.' : 'Testo copiato: incollalo nel corpo dell’email.'); }
    catch { toast('Copia non riuscita: seleziona il testo a mano.', 'error'); }
    return;
  }
  if (action === 'mark-preview-sent') {
    if (!window.confirm('Confermi di aver inviato l’email di anteprima al locale?')) return;
    await doAction('markPreviewSent', { id: trigger.dataset.id, revision: Number(trigger.dataset.revision) }, 'Anteprima segnata come inviata: in attesa della risposta del locale.');
    return;
  }
  if (action === 'client-reply-approve') {
    const payload = { id: trigger.dataset.id, revision: Number(trigger.dataset.revision), decision: 'approva' };
    if (trigger.dataset.suggestion === 'approvazione') {
      if (!window.confirm('Registri questa risposta come approvazione scritta del locale? Vale solo per la versione attuale della bozza.')) return;
      await doAction('decideClientReply', payload, 'Approvazione del locale registrata.');
    } else {
      openConfirmation({ title: 'Approvazione non esplicita', copy: 'Jarvis non riconosce un’approvazione chiara in questa risposta. Registrala solo se sei certo che il locale approva il menu così com’è; altrimenti chiedigli di rispondere «Approvo».', phrase: 'APPROVAZIONE CHIARA VERIFICATA', button: 'Registra approvazione', type: 'decideClientReply', payload: { ...payload, confirmation: 'APPROVAZIONE CHIARA VERIFICATA' }, success: 'Approvazione del locale registrata.' });
    }
    return;
  }
  if (action === 'client-reply-changes') {
    if (!window.confirm('Il locale chiede modifiche? La bozza torna in revisione e servirà una nuova anteprima.')) return;
    await doAction('decideClientReply', { id: trigger.dataset.id, revision: Number(trigger.dataset.revision), decision: 'modifiche' }, 'Bozza riaperta in revisione: correggi e prepara una nuova anteprima.');
    return;
  }
  if (action === 'translate-draft') {
    reviewEvidenceCache.delete(String(trigger.dataset.draft));
    trigger.disabled = true; trigger.textContent = 'Jarvis sta traducendo…';
    await doAction('translateDraft', { id: trigger.dataset.draft, revision: Number(trigger.dataset.revision) }, 'Inglese preparato da Jarvis come bozza; checklist azzerata.');
    return;
  }
  if (action === 'save-editor') {
    reviewEvidenceCache.delete(String(trigger.dataset.draft));
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
  if (['live-open-pr', 'live-merge', 'live-verify'].includes(action)) {
    const draft = draftForRequest();
    const request = draft ? requestForDraft(draft) : null;
    if (!draft || !request) return;
    if (action === 'live-open-pr') {
      const read = (await performAction('githubReadMenu', { slug: draft.slug }))?.result;
      if (!read?.baseSha) { toast('GitHub non ha restituito lo stato di main. Riprova tra poco.', 'error'); return; }
      if (request.kind === 'nuovo' && read.exists) { toast(`Esiste già un menu ${draft.slug} sul sito: usa un altro Menu ID oppure una pratica di aggiornamento.`, 'error'); return; }
      // Chiave stabile per bozza e revisione: un nuovo tentativo dopo un errore noto riusa
      // la stessa operazione invece di scontrarsi con quella già riservata.
      openConfirmation({ title: 'Apri la PR su GitHub', copy: `Menu ${draft.slug} · file menus/${draft.slug}.json · ${read.exists ? 'aggiornamento di un menu esistente' : 'menu nuovo'}. Viene aperta solo la proposta: niente va online.`, phrase: 'CONFERMO APERTURA PR LIVE', button: 'Apri PR', type: 'githubOpenPr',
        payload: { draftId: draft.id, revision: draft.revision, requestRevision: request.revision, operationKey: `${draft.id}.r${draft.revision}`, expectedBaseSha: read.baseSha, expectedFileSha: read.exists ? read.sha : null, confirmation: 'CONFERMO APERTURA PR LIVE' },
        success: 'PR aperta su GitHub: niente è ancora online.' });
      return;
    }
    if (action === 'live-merge') {
      openConfirmation({ title: 'Pubblica il menu', copy: `Il menu ${draft.slug} approvato dal locale va online su renmenu.pages.dev. Jarvis controlla prima che la PR contenga solo questo file e la versione approvata.`, phrase: 'CONFERMO MERGE MENU APPROVATO', button: 'Pubblica', type: 'githubMergePr',
        payload: { draftId: draft.id, revision: draft.revision, requestRevision: request.revision, confirmation: 'CONFERMO MERGE MENU APPROVATO' },
        success: 'Pubblicazione avviata: tra 1–2 minuti tocca «Verifica online».' });
      return;
    }
    await doAction('githubVerifyPublication', { draftId: draft.id, revision: draft.revision, requestRevision: request.revision, confirmation: 'CONFERMO VERIFICA PUBBLICAZIONE' }, 'Menu online e verificato.');
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
  if (kind === 'create-client') { await doAction('createClient', Object.fromEntries(data), isDemoMode ? 'Cliente demo creato.' : 'Cliente creato in staging privato.'); selectedClientId = state.clients[0]?.id || selectedClientId; render(); return; }
  if (kind === 'update-client') { await doAction('updateClient', { id: data.get('id'), revision: Number(data.get('revision')), patch: { plan: data.get('plan'), contactName: data.get('contactName'), contactRole: data.get('contactRole'), email: data.get('email'), phone: data.get('phone'), paymentStatus: data.get('paymentStatus'), menuId: data.get('menuId'), menuUrl: data.get('menuUrl'), trialEndsAt: data.get('trialEndsAt'), renewalAt: data.get('renewalAt'), internalNotes: data.get('internalNotes') } }, isDemoMode ? 'Scheda cliente demo aggiornata.' : 'Scheda cliente di staging aggiornata.'); return; }
  if (kind === 'entrust-jarvis') {
    const accept = [...document.querySelectorAll('form[data-form="apply-source-extras"] input[name="accept"]:checked')].map((input) => String(input.value));
    await doAction('entrustToJarvis', { draftId: data.get('draftId'), revision: Number(data.get('revision')), accept, confirmation: 'AFFIDO A JARVIS' }, 'Pratica affidata a Jarvis: ti aggiorna lui.');
    return;
  }
  if (kind === 'apply-source-extras') {
    await doAction('applySourceExtras', { draftId: data.get('draftId'), revision: Number(data.get('revision')), accept: data.getAll('accept').map(String) }, 'Dati del locale inseriti: rifai la checklist.');
    return;
  }
  if (kind === 'apply-reply-changes') {
    const accept = data.getAll('accept').map(String);
    const sections = Object.fromEntries(accept.map((id) => [id, data.get(`section-${id}`)]).filter(([, value]) => value != null).map(([id, value]) => [id, Number(value)]));
    await doAction('applyReplyChanges', { draftId: data.get('draftId'), revision: Number(data.get('revision')), accept, sections }, 'Modifiche applicate: controlla la bozza e rifai la checklist.');
    return;
  }
  if (kind === 'create-request') { await doAction('createRequest', Object.fromEntries(data), 'Nuova pratica creata.'); selectedRequestId = state.requests[0]?.id || selectedRequestId; selectedClientId = requestById(selectedRequestId)?.clientId || selectedClientId; render(); return; }
  if (kind === 'update-source') {
    await doAction('updateRequest', { id: data.get('id'), revision: Number(data.get('revision')), patch: { sourceText: data.get('sourceText'), sourceChannel: data.get('sourceChannel'), ...(data.get('category') ? { category: data.get('category') } : {}), internalNotes: data.get('internalNotes'), nextStep: data.get('nextStep'), followUpAt: data.get('followUpAt') } }, 'Sorgente aggiornata.');
    return;
  }
  if (kind === 'update-request-meta') { await doAction('updateRequest', { id: data.get('id'), revision: Number(data.get('revision')), patch: { ...(data.get('status') ? { status: data.get('status') } : {}), plan: data.get('plan'), contactName: data.get('contactName'), contactRole: data.get('contactRole'), contactInfo: data.get('contactInfo'), menuId: data.get('menuId'), publicUrl: data.get('publicUrl'), nextStep: data.get('nextStep'), internalNotes: data.get('internalNotes') } }, 'Pratica aggiornata.'); return; }
  if (kind === 'set-activation') { await doAction('setActivation', { id: data.get('id'), revision: Number(data.get('revision')), activation: data.get('activation'), date: data.get('date'), note: data.get('note') }, 'Attivazione registrata.'); return; }
  if (kind === 'upload-material') { const file = data.get('file'); await doUpload(selectedRequestId, file); return; }
  if (kind === 'voice-settings') {
    await doAction('setVoice', { provider: String(data.get('provider') || ''), voiceId: String(data.get('voiceId') || ''), apiKey: String(data.get('apiKey') || '') }, 'Voce di Jarvis salvata.');
    return;
  }
  if (kind === 'set-material-transcript') {
    if (isDemoMode) throw new Error('La demo non salva trascrizioni o hash di materiali.');
    const material = state.materials.find((item) => item.id === String(data.get('materialId') || ''));
    const request = material && requestById(material.requestId);
    if (!material || !request) throw new Error('Materiale o pratica non disponibili. Ricarica la pagina.');
    await doAction('setMaterialTranscript', { materialId: material.id, requestRevision: Number(data.get('requestRevision')), text: String(data.get('text') || '') }, 'Trascrizione manuale salvata: verifica ancora la fonte originale.');
    return;
  }
  if (kind === 'voice-proposal') {
    const target = data.get('target') === 'notifiche' ? 'notifiche' : 'revisione';
    voiceProposal = { ...(voiceProposal || {}), title: cleanVoiceText(data.get('title'), 120), text: cleanVoiceText(data.get('text'), 900), target, confirmed: data.get('confirmed') === 'on' };
    if (!voiceProposal.title || !voiceProposal.text) throw new Error('Correggi titolo e testo della proposta prima di proseguire.');
    toast('Proposta aggiornata solo nell’interfaccia: nessuna modifica è stata salvata.'); render(); return;
  }
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
    const fieldEvidence = Object.fromEntries(['prices', 'allergens', 'languages'].map((key) =>
      [key, String(data.get(`fieldEvidence-${key}`) || '').trim()]));
    const allergenOmissionConfirmed = data.get('allergenOmissionConfirmed') === 'on';
    const approvalEvidence = String(data.get('approvalEvidence') || '').trim();
    const creativeApproval = data.get('creativeApproval') === 'on';
    const creativeApprovalEvidence = String(data.get('creativeApprovalEvidence') || '').trim();
    const currentDraft = draftForRequest();
    const evaluation = reviewIssues(currentDraft?.menu, {
      ...checks, fieldEvidence, allergenOmissionConfirmed, clientApprovalEvidence: approvalEvidence, creativeApproval, creativeApprovalEvidence
    }, requestForDraft(currentDraft)?.plan ?? null);
    if (['prices', 'allergens', 'languages', 'clientApproval'].every((key) => checks[key]) && evaluation.issues.length)
      throw new Error(evaluation.issues[0]);
    await doAction('reviewDraft', { id: data.get('id'), revision: Number(data.get('revision')),
      checks, approvalEvidence, fieldEvidence, allergenOmissionConfirmed,
      ...(creativeApproval ? { creativeApproval, creativeApprovalEvidence } : {}) }, 'Checklist ed evidenze registrate.');
    reviewEvidenceCache.set(String(data.get('id')), fieldEvidence);
    return;
  }
  if (kind === 'send-owner-email') {
    if (isDemoMode) throw new Error('simulazione senza invio');
    const ownerRequest = requestById(String(data.get('requestId') || ''));
    if (!ownerRequest) throw new Error('Seleziona una pratica esistente prima di preparare l’email al proprietario.');
    const subject = String(data.get('subject') || '').trim();
    const emailText = String(data.get('text') || '').trim();
    const priority = String(data.get('priority') || 'normale');
    if (!subject || !emailText) throw new Error('Oggetto e testo sono obbligatori per l’email al proprietario.');
    if (!['normale', 'importante', 'urgente'].includes(priority)) throw new Error('Priorità email non valida.');
    openConfirmation({
      title: 'Conferma email al proprietario',
      copy: ownerEmailConfirmationSummary({ request: ownerRequest, client: clientById(ownerRequest.clientId), subject, text: emailText, priority }),
      phrase: 'CONFERMO EMAIL AL PROPRIETARIO', button: 'Invia solo al proprietario', type: 'sendOwnerEmail',
      payload: { requestId: ownerRequest.id, subject, text: emailText, priority, confirmation: 'CONFERMO EMAIL AL PROPRIETARIO' },
      resultToast: ownerEmailResultToast
    });
    return;
  }
  if (kind === 'mock-whatsapp') { await doAction('mockIncomingWhatsapp', Object.fromEntries(data), 'WhatsApp fittizio ricevuto: nessun webhook reale.'); selectedRequestId = state.requests[0]?.id || selectedRequestId; render(); return; }
  if (kind === 'mock-call') { await doAction('mockCall', Object.fromEntries(data), 'Chiamata simulata: non avviata.'); return; }
  if (kind === 'add-notification') { await doAction('addNotification', Object.fromEntries(data), 'Notifica mock aggiunta.'); return; }
  if (kind === 'save-message') { await doAction('sendMessage', Object.fromEntries(data), 'Bozza mock salvata: non è stata inviata.'); return; }
  if (kind === 'voice') {
    const transcript = cleanVoiceText(data.get('transcript'), 500);
    if (!transcript) throw new Error('Inserisci una domanda testuale prima di interpretarla.');
    const voiceRequestId = String(data.get('requestId') || selectedRequestId || '');
    const voiceRequest = requestById(voiceRequestId);
    const answer = interpretVoice(transcript, { requests: state.requests, clients: state.clients, messages: state.messages, materials: state.materials, analyses: state.analyses || [], audit: state.audit, notifications: state.notifications,
      selectedRequestId: voiceRequestId || null, draft: draftForRequest(voiceRequestId || selectedRequestId), client: clientById(voiceRequest?.clientId) || selectedClient(), history: voiceHistory });
    // A voice/text interpretation is read-only: it never creates an audit record or mutates the selected practice.
    if (answer.proposal) voiceProposal = { ...answer.proposal, confirmed: false };
    lastVoiceTranscript = transcript; lastVoiceReply = answer.reply; appendVoiceTurn(transcript, answer.reply);
    voiceStatus = 'Risposta pronta. Nessuna azione esterna eseguita.';
    if (answer.requestId) selectedRequestId = answer.requestId;
    else if (voiceRequestId) selectedRequestId = voiceRequestId;
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
  dialog.setAttribute('aria-describedby', 'confirm-copy');
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
  const isAi = ['aiClassifyRequest', 'aiExtractMenu'].includes(configuration.type);
  if (isAi) { aiBusy = true; aiPreview = null; render(); }
  doAction(configuration.type, configuration.payload, configuration.success)
    .then((result) => {
      if (!configuration.resultToast) return;
      const outcome = configuration.resultToast(result);
      toast(outcome.message, outcome.type);
    })
    .catch((error) => {
      if (isAi) {
        aiPreview = { requestId: configuration.payload.requestId, requestRevision: configuration.payload.requestRevision,
          type: configuration.type, error: error.message || 'Errore del provider AI.' };
      }
      if (configuration.type === 'sendOwnerEmail') {
        toast(`Email al proprietario non inviata: verifica Cloudflare Access e la configurazione Resend. ${error.message || ''}`.trim(), 'error');
      } else toast(error.message || 'Operazione non riuscita.', 'error');
    }).finally(() => { if (isAi) { aiBusy = false; render(); } });
});
dialog.addEventListener('cancel', () => { pendingConfirm = null; });
materialViewer?.addEventListener('close', releaseMaterialPreview);
materialViewer?.addEventListener('cancel', () => { releaseMaterialPreview(); });
window.addEventListener('beforeunload', releaseMaterialPreview);
window.addEventListener('hashchange', () => { closeMaterialViewer(); activeView = routeFromHash(); mobileMenuOpen = false; render(); $('#main-content').focus(); });

async function init() {
  initializeTheme();
  restoreVoiceHistory();
  if (!isAuthorizedHost) { renderUnavailable(); return; }
  activeView = routeFromHash();
  try { await refresh(); } catch (error) { renderAccessError(error); }
}
init();

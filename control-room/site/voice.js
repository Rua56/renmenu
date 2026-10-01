/* Browser-only speech option; no audio is sent to the RenMenu API. Some browsers
 * use a remote speech-recognition service: ask before starting the microphone.
 * The default state is OFF. No command can approve, send, merge or publish.
 */
import { menuDiff } from './model.js';
const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
const Synth = globalThis.speechSynthesis;
let recognition = null;
let enabled = false;
let rate = 1;
let volume = .8;

export const speechAvailable = Boolean(Recognition);
export const synthesisAvailable = Boolean(Synth && globalThis.SpeechSynthesisUtterance);
export const voiceSettings = () => ({ enabled, rate, volume, speechAvailable, synthesisAvailable, provider: 'browser' });
export const configureVoice = (patch = {}) => {
  if (typeof patch.enabled === 'boolean') {
    enabled = patch.enabled;
    if (!enabled) stopListening();
    if (!enabled) Synth?.cancel();
  }
  if (Number.isFinite(Number(patch.rate))) rate = Math.max(.6, Math.min(1.4, Number(patch.rate)));
  if (Number.isFinite(Number(patch.volume))) volume = Math.max(0, Math.min(1, Number(patch.volume)));
  return voiceSettings();
};
export function speak(text) {
  if (!enabled) throw new Error('Attiva prima la voce del browser.');
  if (!synthesisAvailable) throw new Error('Sintesi vocale non supportata da questo browser.');
  Synth.cancel();
  const utterance = new SpeechSynthesisUtterance(String(text || '').slice(0, 900));
  utterance.lang = 'it-IT'; utterance.rate = rate; utterance.volume = volume;
  const italian = Synth.getVoices().find((candidate) => candidate.lang?.toLowerCase().startsWith('it'));
  if (italian) utterance.voice = italian;
  Synth.speak(utterance);
}
export function stopListening() {
  if (recognition) { recognition.abort(); recognition = null; }
}
export function listen({ onTranscript, onStatus }) {
  if (!enabled) throw new Error('Attiva prima la voce del browser.');
  if (!speechAvailable) throw new Error('Microfono/browser SpeechRecognition non disponibile. Usa il testo.');
  stopListening();
  const instance = new Recognition();
  recognition = instance;
  instance.lang = 'it-IT'; instance.continuous = false; instance.interimResults = false; instance.maxAlternatives = 1;
  instance.onstart = () => onStatus('In ascolto… correggi poi la trascrizione prima di inviarla.');
  instance.onresult = (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript || '';
    if (transcript) onTranscript(transcript);
    onStatus('Trascrizione ricevuta. Modificala se necessario; non è ancora stata inviata.');
  };
  instance.onerror = (event) => onStatus(`Microfono non disponibile (${event.error || 'errore'}). Puoi scrivere il comando.`);
  instance.onend = () => { if (recognition === instance) recognition = null; };
  instance.start();
}
export function interpretVoice(transcript, {
  requests = [], clients = [], messages = [], materials = [], audit = [], notifications = [],
  selectedRequestId = null, draft = null, client = null, history = []
} = {}) {
  const words = String(transcript || '').toLocaleLowerCase('it-IT').replace(/\s+/g, ' ').trim();
  const selectedRequest = requests.find((item) => item.id === selectedRequestId) || null;
  const venue = client?.name || clients.find((item) => item.id === selectedRequest?.clientId)?.name || 'il locale selezionato';
  const items = draft?.menu?.sezioni?.reduce((count, section) => count + (section.voci?.length || 0), 0) || 0;
  const changes = draft?.versions?.[0]?.menu ? menuDiff(draft.versions[0].menu, draft.menu).changes.length : 0;
  const activeRequests = requests.filter((item) => !['completata', 'archiviata', 'chiusa'].includes(item.status));
  const requestMaterials = materials.filter((item) => item.requestId === selectedRequestId && !item.archivedAt);
  const uncertain = (draft?.provenance || []).filter((item) => item.status !== 'confermato');
  const unread = notifications.filter((item) => !item.readAt && (!item.requestId || item.requestId === selectedRequestId));
  const lastUserTurn = [...history].reverse().find((turn) => turn?.role === 'user')?.text || '';

  // This module is a deterministic browser-side readout/navigation aid, not an AI provider.
  if (!words) return { reply: 'Scrivi o correggi una domanda prima di interpretarla. Nessuna azione è stata eseguita.', target: null };
  if (/non pubblicare|ferma/.test(words)) return { reply: 'Non ho pubblicato nulla. Tutte le operazioni esterne restano disattivate.', target: null };
  if (/promemoria|scadenz/.test(words)) return { reply: 'Ho aperto il centro notifiche. Registra il promemoria come avviso interno, non come messaggio esterno.', target: 'notifiche' };
  if (/pubblic|manda|invia|chiama|merge|pag(a|o|hi)/.test(words)) {
    return { reply: `Ho preparato soltanto la schermata di controllo per ${venue}. Include ${items} voci e ${changes} modifiche confrontabili tra bozze (non rispetto al menu live). Vuoi aprire la conferma sul telefono? Nessuna pubblicazione, invio o chiamata è partita.`, target: 'approvazioni' };
  }
  if (/leggimi.*messagg/.test(words)) {
    const note = messages.find((item) => item.requestId === selectedRequestId);
    return { reply: note ? `Bozza non inviata: ${note.body.slice(0, 500)}` : 'Non c’è un messaggio preparato per la pratica selezionata.', target: 'notifiche' };
  }
  const opened = words.match(/\bapri\s+(.+)/);
  if (opened) {
    const requested = opened[1].trim();
    const matching = requests.find((request) => {
      const name = clients.find((item) => item.id === request.clientId)?.name?.toLocaleLowerCase('it-IT').split(' — ')[0] || '';
      return requested.includes(request.subject.toLocaleLowerCase('it-IT')) || (name.length >= 4 && requested.includes(name));
    });
    if (matching) return { reply: `Ho individuato la pratica ${matching.subject}. L’ho selezionata senza modificarla.`, target: 'richieste', requestId: matching.id };
  }
  if (/azioni|cosa hai fatto|ultima azione|registro/.test(words)) {
    const last = audit.filter((item) => !selectedRequestId || item.requestId === selectedRequestId)[0];
    return { reply: last ? `Ultima azione registrata: ${last.summary} È un registro informativo: non ho eseguito nuove azioni.` : 'Non ci sono ancora azioni registrate nel contesto selezionato.', target: 'registro' };
  }
  if (/quali.*(?:pratic|richiest)|(?:pratic|richiest).*aperte|elenca.*(?:pratic|richiest)/.test(words)) {
    const labels = activeRequests.slice(0, 3).map((item) => item.subject).join('; ');
    return { reply: activeRequests.length ? `Ci sono ${activeRequests.length} pratiche aperte: ${labels}${activeRequests.length > 3 ? '; e altre da vedere nell’elenco.' : '.'}` : 'Non ci sono pratiche aperte nel contesto corrente.', target: 'richieste' };
  }
  if (/oggi|priorit|cosa devo fare/.test(words)) {
    const next = activeRequests[0];
    return { reply: next ? `La prossima priorità è ${next.subject}. Apri la pratica e verifica la fonte prima di procedere.` : 'Non ci sono pratiche aperte nel contesto corrente.', target: 'command' };
  }
  if (/nuove richieste|richiest/.test(words)) return { reply: `Ci sono ${requests.filter((item) => item.status === 'nuova').length} nuove richieste. Ho aperto l’elenco; non ho contattato i clienti.`, target: 'richieste' };
  if (/riassum.*materiale|materiali?|file|allegat/.test(words)) {
    const sourceRows = selectedRequest?.sourceText?.split('\n').filter(Boolean).length || 0;
    const filenames = requestMaterials.slice(0, 3).map((item) => item.filename).join(', ');
    return { reply: selectedRequest ? `La pratica selezionata contiene ${requestMaterials.length} materiali attivi${filenames ? `: ${filenames}` : ''} e ${sourceRows} righe di testo sorgente. PDF e immagini restano fonti private: non c’è OCR automatico.` : 'Seleziona una pratica per riassumere materiali e testo sorgente.', target: 'materiali' };
  }
  if (/allergen|dubb|dati mancan|manca|incert/.test(words)) {
    const warning = uncertain.length ? `${uncertain.length} campi sono da verificare nella provenienza.` : 'Non vedo campi marcati da verificare nella bozza corrente.';
    const notices = unread.length ? ` Ci sono anche ${unread.length} avvisi non letti.` : '';
    return { reply: `${warning}${notices} Gli allergeni non vengono dedotti: confronta ogni voce con la fonte ufficiale del locale.`, target: 'builder' };
  }
  if (/bozz|prepara il men/.test(words)) return { reply: 'Ho aperto il Builder. Puoi generare una bozza prudente dal materiale, senza approvarla automaticamente.', target: 'builder' };
  if (/anteprima|qr/.test(words)) return { reply: 'Ho aperto l’anteprima privata. Il QR è provvisorio e non va condiviso.', target: 'anteprima' };
  if (/messagg|whatsapp|email/.test(words)) return { reply: 'Ho aperto le bozze messaggi. Nessun invio avviene senza revisione e consenso sullo schermo.', target: 'notifiche' };
  if (/prezzo|sezione|modifica|aggiungi/.test(words)) return { reply: 'Ho aperto l’editor. La modifica va scritta, confrontata con la fonte e salvata manualmente.', target: 'revisione' };
  if (/contesto|questa pratica|quale pratica|e i dettagli/.test(words) && selectedRequest) {
    return { reply: `Stai lavorando su ${selectedRequest.subject} per ${venue}. Prossimo passo: ${selectedRequest.nextStep || 'da definire'}. La conversazione precedente resta solo come contesto testuale${lastUserTurn ? '; non interpreta o esegue comandi impliciti.' : '.'}`, target: 'richieste' };
  }
  return { reply: 'Posso leggere pratiche, materiali, dubbi e azioni registrate dal contesto attuale. Non sono un provider AI live e non eseguo azioni. Puoi specificare la tua domanda.', target: null };
}

// Strato HUD di J.A.R.V.I.S.: orologio della telemetria e avvio «sistemi online» una volta per sessione.
// Solo decorazione: niente dati, niente rete. Con «riduci movimento» l'avvio non compare.
const clock = document.getElementById('hud-clock');
const format = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Rome' });
const tick = () => { if (clock) clock.textContent = format.format(new Date()); };
tick();
setInterval(tick, 1000);

const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const dark = document.documentElement.dataset.theme !== 'light';
let seen = false;
try { seen = sessionStorage.getItem('hud-boot') === '1'; sessionStorage.setItem('hud-boot', '1'); } catch { seen = true; }
if (!seen && !still && dark) {
  const boot = document.createElement('div');
  boot.className = 'hud-boot';
  boot.setAttribute('aria-hidden', 'true');
  boot.innerHTML = '<div><img class="hud-boot-core" src="./icons/jarvis-192.png" alt="" width="96" height="96"><strong>J.A.R.V.I.S.</strong><span>Avvio sistemi</span><span>Collegamento RenMenu</span><span>Tutti i sistemi online</span></div>';
  document.body.append(boot);
  setTimeout(() => boot.remove(), 2200);
}

// App sul telefono: Android offre «Installa» (evento beforeinstallprompt), iPhone si aggiunge da Condividi.
export const installed = () => Boolean(globalThis.matchMedia?.('(display-mode: standalone)').matches || globalThis.navigator?.standalone);
let installPrompt = null;
globalThis.addEventListener?.('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt = event; });
/** Restituisce il messaggio da mostrare: installata, chiesta al telefono, o i passi per iPhone. */
export async function installApp() {
  if (installed()) return 'Jarvis è già installato: lo apri dall’icona sulla schermata Home.';
  if (installPrompt) {
    const event = installPrompt; installPrompt = null;
    event.prompt();
    const choice = await event.userChoice.catch(() => null);
    return choice?.outcome === 'accepted' ? 'Fatto: trovi Jarvis sulla schermata Home.' : 'Va bene, quando vuoi lo installi da qui.';
  }
  return /iphone|ipad|ipod/i.test(globalThis.navigator?.userAgent || '')
    ? 'Su iPhone: apri questa pagina in Safari, tocca Condividi (il quadrato con la freccia) e poi «Aggiungi alla schermata Home».'
    : 'Dal menu del browser (⋮) scegli «Installa app» o «Aggiungi a schermata Home».';
}

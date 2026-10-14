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
  boot.innerHTML = '<div><strong>J.A.R.V.I.S.</strong><span>Avvio sistemi</span><span>Collegamento RenMenu</span><span>Tutti i sistemi online</span></div>';
  document.body.append(boot);
  setTimeout(() => boot.remove(), 2200);
}

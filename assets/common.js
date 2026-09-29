/* RenMenu — common helpers */
window.RENMENU = {
  brand: 'RenMenu',
  tagline: 'Il menù digitale del tuo locale, pronto in 10 minuti.',
  contattoWhatsApp: '393515924327',
  contattoEmail: 'iuran56@gmail.com',
  /* Pagamenti: compila questi campi e la pagina paga/ si aggiorna da sola.
     - stripe: incolla i Payment Link creati su dashboard.stripe.com (uno per piano). Vuoto = bottone carta nascosto.
     - iban/intestatario: per il bonifico. Vuoto = blocco bonifico nascosto.
     - paypal: es. 'https://paypal.me/tuonome'. satispay: link o vuoto. */
  pagamenti: {
    intestatario: '',
    iban: '',
    banca: '',
    paypal: '',
    satispay: '',
    stripe: { mensile: '', annuale: '', sumisura: '' },
    piani: {
      mensile:  { nome: 'Mensile',  prezzo: 25,  unita: '/ mese', descr: 'Menù online in 24 ore, QR, IT + EN, aggiornamenti illimitati. Primo mese gratis, disdici quando vuoi.', prova: true },
      annuale:  { nome: 'Annuale',  prezzo: 249, unita: '/ anno', descr: 'Tutto il mensile, una lingua extra, QR con il tuo logo, fattura unica. Due mesi gratis rispetto al mensile.' },
      sumisura: { nome: 'Su misura', prezzo: 490, unita: 'acconto', descr: 'Grafica disegnata sul tuo locale, fino a 4 lingue, tema giorno/notte. Il preventivo definitivo lo concordiamo su WhatsApp; qui versi l\'acconto per partire.', mensile: 39 }
    }
  },
  logo: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="26" height="26" rx="7"/><path d="M10 11h12M10 16h12M10 21h7"/><circle cx="21.5" cy="21" r="1.2" fill="currentColor" stroke="none"/></svg>',
  allergeni: {
    '1': { it: 'Glutine', en: 'Gluten' }, '2': { it: 'Crostacei', en: 'Crustaceans' }, '3': { it: 'Uova', en: 'Eggs' },
    '4': { it: 'Pesce', en: 'Fish' }, '5': { it: 'Arachidi', en: 'Peanuts' }, '6': { it: 'Soia', en: 'Soy' },
    '7': { it: 'Latte', en: 'Milk' }, '8': { it: 'Frutta a guscio', en: 'Tree nuts' }, '9': { it: 'Sedano', en: 'Celery' },
    '10': { it: 'Senape', en: 'Mustard' }, '11': { it: 'Sesamo', en: 'Sesame' }, '12': { it: 'Solfiti', en: 'Sulphites' },
    '13': { it: 'Lupini', en: 'Lupin' }, '14': { it: 'Molluschi', en: 'Molluscs' }
  },
  tags: {
    veg: { it: 'Vegetariano', en: 'Vegetarian', icon: '🌱' },
    vegan: { it: 'Vegano', en: 'Vegan', icon: '🌿' },
    spicy: { it: 'Piccante', en: 'Spicy', icon: '🌶' },
    gf: { it: 'Senza glutine', en: 'Gluten free', icon: '🌾' },
    new: { it: 'Novità', en: 'New', icon: '✦' },
    top: { it: 'Consigliato', en: "Chef's pick", icon: '★' },
    frozen: { it: 'Surgelato*', en: 'Frozen*', icon: '❄' },
    hot: { it: 'Servito caldo', en: 'Served hot', icon: '🔥' },
    riserva: { it: 'Gran riserva', en: 'Grand reserve', icon: '♛' }
  }
};

(function theme() {
  const r = document.documentElement;
  let d = matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light';
  r.setAttribute('data-theme', d);
  const sun = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
  const moon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  function paint() {
    document.querySelectorAll('[data-theme-toggle]').forEach(t => {
      t.innerHTML = d === 'dark' ? sun : moon;
      t.setAttribute('aria-label', d === 'dark' ? 'Passa al tema chiaro' : 'Passa al tema scuro');
    });
  }
  document.addEventListener('DOMContentLoaded', () => {
    paint();
    document.querySelectorAll('[data-theme-toggle]').forEach(t => t.addEventListener('click', () => {
      d = d === 'dark' ? 'light' : 'dark'; r.setAttribute('data-theme', d); paint();
    }));
    document.querySelectorAll('[data-logo]').forEach(el => { el.innerHTML = window.RENMENU.logo; });
    document.querySelectorAll('[data-brand-name]').forEach(el => { el.textContent = window.RENMENU.brand; });
  });
})();

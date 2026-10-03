/* RenMenu Premium su misura. Usa gli stessi dati dei menu Standard (menus/<id>.json): piatti,
 * prezzi, info del locale. Il blocco "premium" decide solo l'aspetto, così Jarvis aggiorna
 * prezzi e piatti di un Premium esattamente come per gli altri locali, e il QR (/menu/?m=<id>) resta lo stesso. */
(function () {
  const DIREZIONI = ['editoriale', 'bistrot', 'moderno'];
  // Coppie di caratteri ammesse (Google Fonts): titoli + testo.
  const CARATTERI = {
    classico: { titoli: "'Cormorant Garamond', Georgia, serif", corpo: "'DM Sans', system-ui, sans-serif", css: 'family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=DM+Sans:wght@400;500;600' },
    moderno: { titoli: "'Bricolage Grotesque', system-ui, sans-serif", corpo: "'Manrope', system-ui, sans-serif", css: 'family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=Manrope:wght@400;500;600;700' },
    artigianale: { titoli: "'Fraunces', Georgia, serif", corpo: "'Karla', system-ui, sans-serif", css: 'family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Karla:wght@400;500;600;700' }
  };
  const DEFAULT = {
    editoriale: { caratteri: 'classico', colori: { fondo: '#f6f1e7', testo: '#1f2622', accento: '#8a5a2b', secondario: '#22352c' } },
    bistrot: { caratteri: 'artigianale', colori: { fondo: '#fbf7f0', testo: '#2a211b', accento: '#a4462b', secondario: '#2f4a3a' } },
    moderno: { caratteri: 'moderno', colori: { fondo: '#f4f4f1', testo: '#141414', accento: '#c2410c', secondario: '#141414' } }
  };
  const HEX = /^#[0-9a-f]{6}$/i;

  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lum = (hex) => { const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const mix = (a, b, w) => '#' + rgb(a).map((c, i) => Math.round((c * (1 - w) + rgb(b)[i] * w) * 255).toString(16).padStart(2, '0')).join('');
  /** Scurisce o schiarisce un colore finché non è leggibile sul fondo (min 4.5:1). */
  function readable(color, bg, min = 4.5) {
    if (contrast(color, bg) >= min) return color;
    const target = lum(bg) > 0.4 ? '#000000' : '#ffffff';
    for (let w = 0.1; w <= 1; w += 0.1) { const c = mix(color, target, w); if (contrast(c, bg) >= min) return c; }
    return target;
  }

  /** Stile finale (sempre leggibile) a partire dal blocco premium del menu. */
  function resolveStyle(premium, override) {
    const direzione = DIREZIONI.includes(override) ? override : DIREZIONI.includes(premium.direzione) ? premium.direzione : 'editoriale';
    const base = DEFAULT[direzione];
    const colori = { ...base.colori };
    for (const k of Object.keys(colori)) if (HEX.test(premium.colori?.[k] || '')) colori[k] = premium.colori[k].toLowerCase();
    colori.testo = readable(colori.testo, colori.fondo, 7);
    const accentoForte = readable(colori.accento, colori.fondo, 4.5);
    const suSecondario = contrast('#ffffff', colori.secondario) >= 4.5 ? '#ffffff' : readable('#111111', colori.secondario, 4.5);
    const caratteri = CARATTERI[premium.caratteri] ? premium.caratteri : base.caratteri;
    return { direzione, colori, accentoForte, suSecondario, caratteri };
  }

  const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    tel: svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>'),
    map: svg('<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>'),
    fb: svg('<path d="M14 8h3V4h-3a4 4 0 0 0-4 4v3H7v4h3v6h4v-6h3l1-4h-4V8.5a.5.5 0 0 1 .5-.5Z"/>'),
    ig: svg('<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".8"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    wifi: svg('<path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r=".8"/>'),
    web: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    up: svg('<path d="m6 14 6-6 6 6"/>')
  };
  const T = {
    it: { benvenuti: 'Benvenuti', cerca: 'Cerca un piatto o un vino…', nessuno: 'Nessun piatto trovato.', allergeni: 'Allergeni', coperto: 'Coperto', chiama: 'Chiama', indicazioni: 'Indicazioni', oggi: 'Oggi', persona: 'a persona', powered: 'Menù digitale curato da', su: 'Torna su', vai: 'Vai al menù', sito: 'Sito', sfoglia: 'Sfoglia il menù', cucina: 'La cucina', vini: 'I vini', bere: 'Da bere', intavola: 'In tavola', ilmenu: 'Il menù', allergie: 'Allergie o intolleranze? Chiedi al personale prima di ordinare.', percorso: 'Percorso degustazione', aspettiamo: 'Ti aspettiamo', ciVediamo: 'Ci vediamo', a: 'a', legenda: 'Legenda allergeni', menu: 'Menù', carta: 'Carta dei vini' },
    en: { benvenuti: 'Welcome', cerca: 'Search a dish or a wine…', nessuno: 'No dishes found.', allergeni: 'Allergens', coperto: 'Cover charge', chiama: 'Call', indicazioni: 'Directions', oggi: 'Today', persona: 'per person', powered: 'Digital menu by', su: 'Back to top', vai: 'Skip to menu', sito: 'Website', sfoglia: 'Browse the menu', cucina: 'Food', vini: 'Wines', bere: 'Drinks', intavola: 'At the table', ilmenu: 'The menu', allergie: 'Allergies or intolerances? Please ask our staff before ordering.', percorso: 'Tasting menu', aspettiamo: 'Visit us', ciVediamo: 'See you', a: 'in', legenda: 'Allergen key', menu: 'Menu', carta: 'Wine list' },
    de: { benvenuti: 'Willkommen', cerca: 'Gericht oder Wein suchen…', nessuno: 'Keine Gerichte gefunden.', allergeni: 'Allergene', coperto: 'Gedeck', chiama: 'Anrufen', indicazioni: 'Route', oggi: 'Heute', persona: 'pro Person', powered: 'Digitale Speisekarte von', su: 'Nach oben', vai: 'Zur Speisekarte', sito: 'Webseite', sfoglia: 'Zur Speisekarte', cucina: 'Küche', vini: 'Weine', bere: 'Getränke', intavola: 'Bei Tisch', ilmenu: 'Die Speisekarte', allergie: 'Allergien oder Unverträglichkeiten? Bitte fragen Sie vor der Bestellung.', percorso: 'Degustationsmenü', aspettiamo: 'Besuchen Sie uns', ciVediamo: 'Bis bald', a: 'in', legenda: 'Allergene', menu: 'Speisekarte', carta: 'Weinkarte' },
    fr: { benvenuti: 'Bienvenue', cerca: 'Chercher un plat ou un vin…', nessuno: 'Aucun plat trouvé.', allergeni: 'Allergènes', coperto: 'Couvert', chiama: 'Appeler', indicazioni: 'Itinéraire', oggi: "Aujourd'hui", persona: 'par personne', powered: 'Menu numérique par', su: 'Haut de page', vai: 'Aller au menu', sito: 'Site', sfoglia: 'Voir le menu', cucina: 'La cuisine', vini: 'Les vins', bere: 'Boissons', intavola: 'À table', ilmenu: 'Le menu', allergie: 'Allergies ou intolérances ? Demandez au personnel avant de commander.', percorso: 'Menu dégustation', aspettiamo: 'Nous vous attendons', ciVediamo: 'À bientôt', a: 'à', legenda: 'Allergènes', menu: 'Menu', carta: 'Carte des vins' },
    es: { benvenuti: 'Bienvenidos', cerca: 'Buscar un plato o un vino…', nessuno: 'No se encontraron platos.', allergeni: 'Alérgenos', coperto: 'Cubierto', chiama: 'Llamar', indicazioni: 'Cómo llegar', oggi: 'Hoy', persona: 'por persona', powered: 'Menú digital de', su: 'Volver arriba', vai: 'Ir al menú', sito: 'Web', sfoglia: 'Ver el menú', cucina: 'La cocina', vini: 'Los vinos', bere: 'Bebidas', intavola: 'En la mesa', ilmenu: 'El menú', allergie: '¿Alergias o intolerancias? Pregunte al personal antes de pedir.', percorso: 'Menú degustación', aspettiamo: 'Te esperamos', ciVediamo: 'Nos vemos', a: 'en', legenda: 'Alérgenos', menu: 'Menú', carta: 'Carta de vinos' },
    sl: { benvenuti: 'Dobrodošli', cerca: 'Poišči jed ali vino…', nessuno: 'Ni najdenih jedi.', allergeni: 'Alergeni', coperto: 'Pogrinjek', chiama: 'Pokliči', indicazioni: 'Navodila', oggi: 'Danes', persona: 'na osebo', powered: 'Digitalni meni', su: 'Na vrh', vai: 'Na meni', sito: 'Spletna stran', sfoglia: 'Odpri meni', cucina: 'Kuhinja', vini: 'Vina', bere: 'Pijače', intavola: 'Pri mizi', ilmenu: 'Meni', allergie: 'Alergije ali intolerance? Pred naročilom vprašajte osebje.', percorso: 'Degustacijski meni', aspettiamo: 'Pričakujemo vas', ciVediamo: 'Se vidimo', a: 'v', legenda: 'Alergeni', menu: 'Meni', carta: 'Vinska karta' }
  };
  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV'];
  // Immagini: solo indirizzi https o file del sito (nessun altro schema).
  const safeImg = (src) => { const s = String(src || '').trim(); return /^https:\/\//i.test(s) || /^(?:\.\.\/|\/)?[A-Za-z0-9_./-]+\.(?:webp|png|jpe?g|svg|avif)$/i.test(s) ? s : ''; };
  // Tipo di locale scritto all'inizio del nome («Enoteca Isonzo» → Enoteca / Isonzo).
  const TIPI = /^(Enoteca|Trattoria|Osteria|Ristorante|Pizzeria|Bistrot|Locanda|Agriturismo|Bar|Caffè|Caffe|Cantina|Vineria|Birreria|Pub|Hostaria|Taverna|Gastronomia)\s+(.+)$/i;
  const DRINK = /\bvin[io]?\b|vini|wine|wein|bollicin|spumant|prosecco|champagne|franciacorta|cantina|calice|bottigli|mescita|cocktail|aperitiv|spritz|birr|beer|bier|bevand|bibit|drink|getränk|amari\b|distillat|grapp|liquor/i;
  const WINE = /\bvin[io]?\b|vini|wine|wein|bollicin|spumant|prosecco|champagne|franciacorta|cantina|calice|bottigli|mescita/i;

  /** Città dall'indirizzo: «Via Rastello 12, 34170 Gorizia (GO)» → Gorizia. */
  function cityOf(address) {
    const parts = String(address || '').split(',').map((p) => p.replace(/\((?:[A-Z]{2}|esempio)\)/gi, '').replace(/\b\d{5}\b/g, '').trim()).filter(Boolean);
    const last = parts.length > 1 ? parts[parts.length - 1] : '';
    return /^[\p{L}' .-]{2,40}$/u.test(last) && !/^(via|viale|piazza|corso|borgo|largo|strada|vicolo)\b/i.test(last) ? last : '';
  }

  function render(menu, { lang: startLang, R = {}, params = new URLSearchParams() } = {}) {
    const premium = menu.premium || {};
    const style = resolveStyle(premium, params.get('direzione'));
    const langs = (menu.lingue || ['it']).filter((l) => /^[a-z]{2}$/.test(l)).slice(0, 4);
    let lang = langs.includes(startLang) ? startLang : langs[0] || 'it';
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const t = (v) => (v == null ? '' : typeof v === 'string' ? v : (v[lang] || v.it || Object.values(v)[0] || ''));
    const S = () => T[lang] || T.it;

    // Caratteri e colori
    const font = CARATTERI[style.caratteri];
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = `https://fonts.googleapis.com/css2?${font.css}&display=swap`;
    document.head.appendChild(link);
    document.documentElement.removeAttribute('data-theme');
    const body = document.body;
    const c = style.colori;
    const dark = lum(c.fondo) < 0.2;
    body.className = `pm pm--${style.direzione}${dark ? ' pm--scuro' : ''}`;
    // Fascia d'apertura: sempre leggibile sul colore secondario.
    const apertura = dark ? mix(c.secondario, c.fondo, 0.35) : c.secondario;
    const suApertura = contrast('#ffffff', apertura) >= 4.5 ? '#fbf7f0' : '#141414';
    const oroApertura = readable(c.accento, apertura, 3);
    Object.entries({ '--pm-fondo': c.fondo, '--pm-testo': c.testo, '--pm-accento': c.accento, '--pm-accento-forte': style.accentoForte, '--pm-secondario': c.secondario, '--pm-su-secondario': style.suSecondario,
      '--pm-apertura': apertura, '--pm-su-apertura': suApertura, '--pm-oro-apertura': oroApertura, '--pm-su-accento': contrast('#ffffff', c.accento) >= 3 ? '#ffffff' : '#141414', '--pm-titoli': font.titoli, '--pm-corpo': font.corpo })
      .forEach(([k, v]) => body.style.setProperty(k, v));
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = c.fondo; m.removeAttribute('media'); });

    const logo = safeImg(premium.logo), cover = safeImg(premium.copertina);
    const tel = menu.telefono ? String(menu.telefono).replace(/\s/g, '') : '';
    const ig = menu.instagram ? String(menu.instagram).replace(/^@/, '') : '';
    const fbRaw = menu.facebook ? String(menu.facebook).trim() : '';
    const fb = !fbRaw ? '' : /^https?:\/\//i.test(fbRaw) ? fbRaw : /^[A-Za-z0-9.]{3,50}$/.test(fbRaw) ? `https://www.facebook.com/${fbRaw}` : `https://www.facebook.com/search/top?q=${encodeURIComponent(fbRaw)}`;
    const site = /^https:\/\//i.test(String(menu.sito || menu.website || menu.url || '')) ? String(menu.sito || menu.website || menu.url) : '';
    const nome = String(menu.nome || '');
    const tipoMatch = ((m) => (m && /^\p{Lu}/u.test(m[2]) ? m : null))(TIPI.exec(nome));
    const tipo = tipoMatch ? tipoMatch[1] : '', nomeProprio = tipoMatch ? tipoMatch[2] : nome;
    const citta = cityOf(menu.indirizzo);
    const maps = menu.maps || (menu.indirizzo ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${nome} ${menu.indirizzo}`)}` : '');
    const iniziale = (nomeProprio.match(/\p{L}/u) || ['R'])[0].toUpperCase();

    // Cucina e bevande in due carte separate (come una carta dei vini vera).
    const sezioni = (menu.sezioni || []).map((s, i) => {
      const n = Object.values(typeof s.nome === 'string' ? { it: s.nome } : s.nome || {}).join(' ');
      const varianti = (s.voci || []).length && (s.voci || []).every((v) => Array.isArray(v.prezzi) && v.prezzi.length);
      const bere = s.tipo !== 'degustazione' && (DRINK.test(n) || varianti);
      return { s, i, bere, vino: bere && (WINE.test(n) || varianti) };
    });
    const haBere = sezioni.some((x) => x.bere), haCucina = sezioni.some((x) => !x.bere);
    const labelBere = sezioni.some((x) => x.vino) ? 'vini' : 'bere';
    let view = params.get('view') === 'wine' && haBere ? 'bere' : haCucina ? 'cucina' : 'bere';
    let query = '';

    const price = (p) => (p ? `€\u00a0${esc(p)}` : '');
    function meta(v) {
      const tags = (v.tag || []).map((k) => (R.tags?.[k] ? `<span class="${k === 'top' ? 'pm-tag--top' : ''}">${R.tags[k].icon} ${esc(R.tags[k][lang] || R.tags[k].it)}</span>` : '')).join('');
      const all = (v.allergeni || []).length ? `<span>${S().allergeni}${v.allergeni.map((k) => `<i>${esc(k)}</i>`).join('')}</span>` : '';
      return tags || all ? `<div class="pm-voce__meta">${tags}${all}</div>` : '';
    }
    function voce(v) {
      const varianti = Array.isArray(v.prezzi) && v.prezzi.length ? `<div class="pm-varianti">${v.prezzi.map((p) => `<span>${esc(t(p.etichetta))}<b>${price(p.prezzo)}</b></span>`).join('')}</div>` : '';
      const p = !varianti && v.prezzo ? `<div class="pm-voce__prezzo">${price(v.prezzo)}${v.unita ? `<small>${esc(t(v.unita))}</small>` : ''}</div>` : '<div></div>';
      return `<article class="pm-voce"><h3 class="pm-voce__nome">${esc(t(v.nome))}</h3>${p}${v.descrizione && t(v.descrizione) ? `<p class="pm-voce__desc">${esc(t(v.descrizione))}</p>` : ''}${varianti}${meta(v)}</article>`;
    }
    // Carta dei vini: colonne «Calice / Bottiglia» allineate.
    function cartaVini(voci) {
      const cols = [];
      for (const v of voci) for (const p of v.prezzi || []) { const l = t(p.etichetta); if (l && !cols.includes(l)) cols.push(l); }
      if (!cols.length || cols.length > 3) return `<div class="pm-voci">${voci.map(voce).join('')}</div>`;
      const row = (v) => {
        const by = Object.fromEntries((v.prezzi || []).map((p) => [t(p.etichetta), p.prezzo]));
        const cells = cols.map((l, k) => `<span class="pm-vino__p">${by[l] ? price(by[l]) : (k === cols.length - 1 && v.prezzo && !(v.prezzi || []).length ? price(v.prezzo) : '<em>—</em>')}</span>`).join('');
        return `<div class="pm-vino"><div class="pm-vino__nome"><h3>${esc(t(v.nome))}</h3>${v.descrizione && t(v.descrizione) ? `<p>${esc(t(v.descrizione))}</p>` : ''}${meta(v)}</div>${cells}</div>`;
      };
      return `<div class="pm-vini" style="--pm-cols:${cols.length}"><div class="pm-vino pm-vino--head" aria-hidden="true"><span></span>${cols.map((l) => `<span class="pm-vino__p">${esc(l)}</span>`).join('')}</div>${voci.map(row).join('')}</div>`;
    }
    function sezione({ s, i, vino }, voci, n) {
      const num = String(n + 1).padStart(2, '0');
      const desc = s.descrizione && t(s.descrizione) ? `<p class="pm-sezione__desc">${esc(t(s.descrizione))}</p>` : '';
      if (s.tipo === 'degustazione') {
        const titolo = t(s.nome).replace(/^(?:percorso\s+(?:di\s+)?degustazione|menu\s+degustazione|tasting\s+menu)\s*/i, '').replace(/^[«"“]\s*|\s*[»"”]$/g, '').trim() || t(s.nome);
        const portate = voci.filter((v) => !v.prezzo), extra = voci.filter((v) => v.prezzo);
        const pp = s.prezzo ? `<p class="pm-degu__prezzo"><b>${price(s.prezzo)}</b><small>${esc(t(s.unita) || S().persona)}</small></p>` : '';
        return `<section class="pm-sezione pm-sezione--degu" id="pm-sez-${i}"><div class="pm-degu"><span class="pm-degu__eyebrow">${S().percorso}</span><h2>${esc(titolo)}</h2>${pp}<span class="pm-orn" aria-hidden="true">✦</span>
          <ol>${portate.map((v, k) => `<li><span class="pm-degu__n">${ROMAN[k] || k + 1}</span><b>${esc(t(v.nome))}</b>${v.descrizione && t(v.descrizione) ? `<span>${esc(t(v.descrizione))}</span>` : ''}</li>`).join('')}</ol>
          ${extra.length ? `<div class="pm-degu__extra">${extra.map((v) => `<div><span>${esc(t(v.nome))}</span><b>+ ${price(v.prezzo)}</b>${v.unita ? `<small>${esc(t(v.unita))}</small>` : ''}</div>`).join('')}</div>` : ''}
          ${desc}</div></section>`;
      }
      return `<section class="pm-sezione" id="pm-sez-${i}"><header class="pm-sezione__head"><span class="pm-sezione__num">${num}</span><h2>${esc(t(s.nome))}</h2></header>${desc}${vino ? cartaVini(voci) : `<div class="pm-voci">${voci.map(voce).join('')}</div>`}</section>`;
    }

    function draw() {
      document.documentElement.lang = lang;
      document.title = `${nome} — ${S().menu}`;
      const q = query.trim().toLowerCase();
      const match = (v) => !q || `${t(v.nome)} ${t(v.descrizione)}`.toLowerCase().includes(q);
      const visibili = sezioni.filter((x) => q || (view === 'bere') === x.bere);
      const blocks = visibili.map((x) => ({ x, voci: (x.s.voci || []).filter(match) })).filter((b) => b.voci.length);
      const usedAll = new Set((menu.sezioni || []).flatMap((s) => (s.voci || []).flatMap((v) => v.allergeni || [])));
      const switcher = haBere && haCucina ? `<div class="pm-switch" role="group" aria-label="${S().menu}"><button type="button" data-view="cucina" aria-pressed="${view === 'cucina'}">${S().cucina}</button><button type="button" data-view="bere" aria-pressed="${view === 'bere'}">${S()[labelBere]}</button></div>` : '';
      const langBtns = langs.length > 1 ? `<div class="pm-lang" role="group" aria-label="Lingua">${langs.map((l) => `<button type="button" data-lang="${l}" aria-pressed="${l === lang}">${l}</button>`).join('')}</div>` : '';
      const motto = t(premium.motto) || t(menu.sottotitolo);
      const eyebrow = [citta, tipo].filter(Boolean).join(' · ') || S().benvenuti;
      body.innerHTML = `<a class="pm-skip" href="#pm-carta">${S().vai}</a>
      <header class="pm-bar"><div class="pm-wrap pm-bar__row"><a class="pm-id" href="#pm-top">${tipo ? `<small>${esc(tipo)}</small>` : ''}<span>${esc(nomeProprio)}</span></a>${langBtns}</div></header>
      <main id="pm-top">
        <section class="pm-open"><div class="pm-wrap pm-open__in">
          <span class="pm-eyebrow">${esc(eyebrow)}</span>
          ${logo ? `<img class="pm-open__logo" src="${esc(logo)}" alt="${esc(nome)}">` : `<span class="pm-crest" aria-hidden="true"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="57" fill="none" stroke="currentColor" stroke-width="1"/><circle cx="60" cy="60" r="50" fill="none" stroke="currentColor" stroke-width=".6" stroke-dasharray="1.5 3"/></svg><b>${esc(iniziale)}</b></span>`}
          <h1>${tipo ? `<small>${esc(tipo)}</small>` : ''}${esc(nomeProprio)}</h1>
          <span class="pm-orn" aria-hidden="true">✦</span>
          ${motto ? `<p class="pm-open__motto">${esc(motto)}</p>` : ''}
          ${menu.orari && t(menu.orari) ? `<p class="pm-open__orari">${ICON.clock}<span>${esc(t(menu.orari))}</span></p>` : ''}
          <div class="pm-open__links"><a class="pm-btn pm-btn--pieno" href="#pm-carta" data-go="cucina">${S().sfoglia}</a>${haBere && haCucina ? `<a class="pm-btn pm-btn--linea" href="#pm-carta" data-go="bere">${labelBere === 'vini' ? S().carta : S().bere}</a>` : ''}</div>
        </div></section>
        ${cover ? `<figure class="pm-wrap pm-cover"><img src="${esc(cover)}" alt="" loading="eager"></figure>` : ''}
        ${t(premium.storia) ? `<p class="pm-wrap pm-storia">${esc(t(premium.storia))}</p>` : ''}
        ${menu.avviso && t(menu.avviso) ? `<div class="pm-wrap"><div class="pm-avviso"><b>${S().oggi}</b>${esc(t(menu.avviso)).replace(/^Oggi:\s*|^Today:\s*/i, '')}</div></div>` : ''}
        <section class="pm-wrap pm-carta" id="pm-carta">
          <div class="pm-carta__intro"><span class="pm-eyebrow pm-eyebrow--scuro">${S().intavola}</span><h2>${S().ilmenu}</h2><p>${S().allergie}</p></div>
          <div class="pm-tools">${switcher}<div class="pm-search">${ICON.search}<input id="pm-q" type="search" placeholder="${S().cerca}" aria-label="${S().cerca}" value="${esc(query)}" autocomplete="off"></div></div>
          ${q ? '' : `<nav class="pm-nav" aria-label="Sezioni">${visibili.map((x, n) => `<a href="#pm-sez-${x.i}" data-i="${x.i}"><i>${String(n + 1).padStart(2, '0')}</i>${esc(x.s.tipo === 'degustazione' ? S().percorso : t(x.s.nome))}</a>`).join('')}</nav>`}
          ${blocks.map((b, n) => sezione(b.x, b.voci, n)).join('') || `<p class="pm-empty">${S().nessuno}</p>`}
          ${menu.coperto || (usedAll.size && R.allergeni) || (menu.note && t(menu.note)) ? `<div class="pm-fine">
            ${menu.coperto ? `<p class="pm-coperto"><span>${S().coperto}</span><b>${price(menu.coperto)}</b></p>` : ''}
            ${usedAll.size && R.allergeni ? `<div class="pm-legenda"><h4>${S().legenda}</h4>${[...usedAll].sort((a, b) => a - b).map((k) => (R.allergeni[k] ? `<span><b>${esc(k)}</b>${esc(R.allergeni[k][lang] || R.allergeni[k].it)}</span>` : '')).join('')}</div>` : ''}
            ${menu.note && t(menu.note) ? `<p class="pm-note">${esc(t(menu.note))}</p>` : ''}</div>` : ''}
        </section>
        <section class="pm-visita"><div class="pm-wrap pm-visita__in">
          <div><span class="pm-eyebrow">${S().aspettiamo}</span><h2>${citta ? `${S().ciVediamo} ${S().a} ${esc(citta)}.` : esc(nome)}</h2>${menu.indirizzo ? `<address>${esc(menu.indirizzo)}</address>` : ''}${menu.orari && t(menu.orari) ? `<p>${esc(t(menu.orari))}</p>` : ''}</div>
          <div class="pm-visita__azioni">
            ${tel ? `<a class="pm-btn pm-btn--pieno" href="tel:${esc(tel)}">${ICON.tel}${S().chiama}: ${esc(menu.telefono)}</a>` : ''}
            ${maps ? `<a class="pm-btn pm-btn--linea" href="${esc(maps)}" target="_blank" rel="noopener">${ICON.map}${S().indicazioni} ↗</a>` : ''}
            <div class="pm-social">${ig ? `<a href="https://instagram.com/${esc(ig)}" target="_blank" rel="noopener">${ICON.ig}@${esc(ig)}</a>` : ''}${fb ? `<a href="${esc(fb)}" target="_blank" rel="noopener">${ICON.fb}Facebook</a>` : ''}${site ? `<a href="${esc(site)}" target="_blank" rel="noopener">${ICON.web}${S().sito}</a>` : ''}${menu.wifi ? `<span>${ICON.wifi}Wi-Fi: ${esc(menu.wifi)}</span>` : ''}</div>
          </div>
        </div></section>
      </main>
      <footer class="pm-footer"><span>${esc(nome)}${citta ? ` · ${esc(citta)}` : ''}</span><span>${S().powered} <a href="../index.html">RenMenu</a></span></footer>
      <button class="pm-su" type="button" aria-label="${S().su}">${ICON.up}</button>`;
      wire();
    }

    const goTo = (el) => { if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - (body.querySelector('.pm-bar').offsetHeight + 8), behavior: 'smooth' }); };
    function wire() {
      body.querySelectorAll('.pm-lang button').forEach((b) => b.addEventListener('click', () => { lang = b.dataset.lang; draw(); }));
      body.querySelectorAll('.pm-switch button').forEach((b) => b.addEventListener('click', () => { view = b.dataset.view; draw(); goTo(document.getElementById('pm-carta')); }));
      body.querySelectorAll('[data-go]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); if (haBere && haCucina) view = a.dataset.go; draw(); goTo(document.getElementById('pm-carta')); }));
      body.querySelector('.pm-id').addEventListener('click', (e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
      const input = body.querySelector('#pm-q');
      input.addEventListener('input', () => { const pos = input.selectionStart; query = input.value; draw(); const n = body.querySelector('#pm-q'); n.focus(); n.setSelectionRange(pos, pos); });
      body.querySelectorAll('.pm-nav a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); goTo(document.getElementById(a.getAttribute('href').slice(1))); }));
      body.querySelector('.pm-su').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
      if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('pm-in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -6% 0px' });
        body.querySelectorAll('.pm-sezione').forEach((s) => io.observe(s));
      }
      active = null;
      onScroll();
    }
    let active = null;
    function onScroll() {
      const bar = body.querySelector('.pm-bar');
      if (!bar) return;
      bar.classList.toggle('scrolled', window.scrollY > 120);
      body.querySelector('.pm-su')?.classList.toggle('show', window.scrollY > 700);
      const secs = [...body.querySelectorAll('.pm-sezione')];
      if (!secs.length) return;
      const line = bar.offsetHeight + 40;
      let cur = secs[0];
      for (const s of secs) if (s.getBoundingClientRect().top <= line) cur = s;
      const i = cur.id.replace('pm-sez-', '');
      if (i === active) return;
      active = i;
      const links = [...body.querySelectorAll('.pm-nav a')];
      links.forEach((l) => l.setAttribute('aria-current', String(l.dataset.i === i)));
    }
    window.addEventListener('scroll', () => { onScroll(); }, { passive: true });
    draw();
  }

  window.RenMenuPremium = { render, resolveStyle, contrast, cityOf, DIREZIONI, CARATTERI: Object.keys(CARATTERI) };
})();

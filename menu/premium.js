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
  const SEZ_ICON = {
    antipasti: svg('<path d="M4 13h16a8 8 0 0 1-16 0Z"/><path d="M8 9c0-2 2-2 2-4M12 9c0-2 2-2 2-4M16 9c0-2 2-2 2-4"/>'),
    primi: svg('<path d="M3 12h18a9 9 0 0 1-18 0Z"/><path d="M7 12c1-4 3-6 5-6s4 2 5 6"/><path d="M9.5 12c.5-2 1.5-3 2.5-3s2 1 2.5 3"/>'),
    secondi: svg('<path d="M7 3v8a2 2 0 0 1-2 2v8M5 3v5M9 3v5"/><path d="M17 21V3c-2 1.5-3 4-3 7 0 1.5 1 2.5 3 2.5"/>'),
    pesce: svg('<path d="M3 12c3-4 7-6 11-6 3 0 5 2 7 6-2 4-4 6-7 6-4 0-8-2-11-6Z"/><path d="M3 12 1 8M3 12l-2 4"/><circle cx="16" cy="11" r="1"/>'),
    pizza: svg('<path d="M12 3 3 19c6 3 12 3 18 0L12 3Z"/><circle cx="11" cy="12" r="1.2"/><circle cx="14" cy="16" r="1.2"/><circle cx="9" cy="16.5" r="1"/>'),
    contorni: svg('<path d="M5 19c0-8 5-14 15-15-1 10-7 15-15 15Z"/><path d="M5 19 13 11"/>'),
    dolci: svg('<path d="M4 20h16v-6H4Z"/><path d="M4 14c2-1 4 1 6 0s4 1 6 0 3 1 4 0"/><path d="M12 10V6M12 6c-1-1-1-2 0-3 1 1 1 2 0 3Z"/>'),
    bollicine: svg('<path d="M9 3h6l-.5 7a2.5 2.5 0 0 1-5 0Z"/><path d="M12 12.5V20M9 21h6"/><circle cx="11" cy="6.5" r=".5"/><circle cx="13" cy="8" r=".5"/><path d="M18 4l1-1M19.5 7H21M5 4 4 3M4.5 7H3"/>'),
    vini: svg('<path d="M8 3h8c0 5-1 9-4 9s-4-4-4-9Z"/><path d="M12 12v8M8 21h8"/>'),
    birre: svg('<path d="M6 8h10v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1Z"/><path d="M16 11h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2"/><path d="M6 8c0-2 1.5-3 3-3 .5-1 2-2 3.5-1.5C14 3 16 4 16 6v2"/>'),
    cocktail: svg('<path d="M4 4h16l-8 9Z"/><path d="M12 13v7M8 20h8"/><path d="M15 4l3-2"/>'),
    caffe: svg('<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5Z"/><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3c0 1.5 1 1.5 1 3M12 3c0 1.5 1 1.5 1 3"/>'),
    bevande: svg('<path d="M7 4h10l-1.5 16a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1Z"/><path d="M7.5 9h9"/><path d="M14 4l2-2"/>'),
    piatto: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.5"/>')
  };
  const iconFor = (section) => {
    const n = Object.values(typeof section.nome === 'string' ? { it: section.nome } : section.nome || {}).join(' ').toLowerCase();
    const rules = [['dolci', /dolc|dessert|torte|gelat|sweet|nachspeise|postre/], ['bollicine', /bollicin|spumant|prosecco|champagne|franciacorta|sparkling|sekt/], ['vini', /\bvin|wine|bollicin|prosecco|champagne|wein/], ['birre', /birr|beer|bier|cervez/], ['cocktail', /cocktail|aperitiv|spritz|amari\b|distillat|liquor|\bgin\b|\brum\b/], ['caffe', /caff|coffee|kaffee|colazion|breakfast|\bt[eè]\b|tisan/], ['bevande', /bevand|bibit|drink|getr|bebida|analcol|acqu/], ['pizza', /pizz|focacc/], ['antipasti', /antipast|cicchett|stuzzic|starter|tapas|tagliere|vorspeis|entr[ée]/], ['primi', /\bprim|pasta|risott|zupp|first|suppe|minestr/], ['secondi', /second|\bcarne|main|griglia|bistecc|hauptgericht/], ['contorni', /contorn|insalat|verdur|side|salad/], ['pesce', /pesce|\bmare\b|fish|crud|frutti di mare/]];
    const hit = rules.find(([, rx]) => rx.test(n));
    return SEZ_ICON[hit ? hit[0] : 'piatto'];
  };
  const T = {
    it: { piatto1: 'piatto', piattiN: 'piatti', vino1: 'vino', viniN: 'vini', benvenuti: 'Benvenuti', cerca: 'Cerca un piatto o un vino…', nessuno: 'Nessun piatto trovato.', allergeni: 'Allergeni', coperto: 'Coperto', chiama: 'Chiama', indicazioni: 'Indicazioni', oggi: 'Oggi', persona: 'a persona', powered: 'Menù digitale curato da', su: 'Torna su', vai: 'Vai al menù', sito: 'Sito', sfoglia: 'Sfoglia il menù', cucina: 'La cucina', vini: 'I vini', bere: 'Da bere', intavola: 'In tavola', ilmenu: 'Il menù', allergie: 'Allergie o intolleranze? Chiedi al personale prima di ordinare.', percorso: 'Percorso degustazione', aspettiamo: 'Ti aspettiamo', ciVediamo: 'Ci vediamo', a: 'a', legenda: 'Legenda allergeni', menu: 'Menù', carta: 'Carta dei vini' },
    en: { piatto1: 'dish', piattiN: 'dishes', vino1: 'wine', viniN: 'wines', benvenuti: 'Welcome', cerca: 'Search a dish or a wine…', nessuno: 'No dishes found.', allergeni: 'Allergens', coperto: 'Cover charge', chiama: 'Call', indicazioni: 'Directions', oggi: 'Today', persona: 'per person', powered: 'Digital menu by', su: 'Back to top', vai: 'Skip to menu', sito: 'Website', sfoglia: 'Browse the menu', cucina: 'Food', vini: 'Wines', bere: 'Drinks', intavola: 'At the table', ilmenu: 'The menu', allergie: 'Allergies or intolerances? Please ask our staff before ordering.', percorso: 'Tasting menu', aspettiamo: 'Visit us', ciVediamo: 'See you', a: 'in', legenda: 'Allergen key', menu: 'Menu', carta: 'Wine list' },
    de: { piatto1: 'Gericht', piattiN: 'Gerichte', vino1: 'Wein', viniN: 'Weine', benvenuti: 'Willkommen', cerca: 'Gericht oder Wein suchen…', nessuno: 'Keine Gerichte gefunden.', allergeni: 'Allergene', coperto: 'Gedeck', chiama: 'Anrufen', indicazioni: 'Route', oggi: 'Heute', persona: 'pro Person', powered: 'Digitale Speisekarte von', su: 'Nach oben', vai: 'Zur Speisekarte', sito: 'Webseite', sfoglia: 'Zur Speisekarte', cucina: 'Küche', vini: 'Weine', bere: 'Getränke', intavola: 'Bei Tisch', ilmenu: 'Die Speisekarte', allergie: 'Allergien oder Unverträglichkeiten? Bitte fragen Sie vor der Bestellung.', percorso: 'Degustationsmenü', aspettiamo: 'Besuchen Sie uns', ciVediamo: 'Bis bald', a: 'in', legenda: 'Allergene', menu: 'Speisekarte', carta: 'Weinkarte' },
    fr: { piatto1: 'plat', piattiN: 'plats', vino1: 'vin', viniN: 'vins', benvenuti: 'Bienvenue', cerca: 'Chercher un plat ou un vin…', nessuno: 'Aucun plat trouvé.', allergeni: 'Allergènes', coperto: 'Couvert', chiama: 'Appeler', indicazioni: 'Itinéraire', oggi: "Aujourd'hui", persona: 'par personne', powered: 'Menu numérique par', su: 'Haut de page', vai: 'Aller au menu', sito: 'Site', sfoglia: 'Voir le menu', cucina: 'La cuisine', vini: 'Les vins', bere: 'Boissons', intavola: 'À table', ilmenu: 'Le menu', allergie: 'Allergies ou intolérances ? Demandez au personnel avant de commander.', percorso: 'Menu dégustation', aspettiamo: 'Nous vous attendons', ciVediamo: 'À bientôt', a: 'à', legenda: 'Allergènes', menu: 'Menu', carta: 'Carte des vins' },
    es: { piatto1: 'plato', piattiN: 'platos', vino1: 'vino', viniN: 'vinos', benvenuti: 'Bienvenidos', cerca: 'Buscar un plato o un vino…', nessuno: 'No se encontraron platos.', allergeni: 'Alérgenos', coperto: 'Cubierto', chiama: 'Llamar', indicazioni: 'Cómo llegar', oggi: 'Hoy', persona: 'por persona', powered: 'Menú digital de', su: 'Volver arriba', vai: 'Ir al menú', sito: 'Web', sfoglia: 'Ver el menú', cucina: 'La cocina', vini: 'Los vinos', bere: 'Bebidas', intavola: 'En la mesa', ilmenu: 'El menú', allergie: '¿Alergias o intolerancias? Pregunte al personal antes de pedir.', percorso: 'Menú degustación', aspettiamo: 'Te esperamos', ciVediamo: 'Nos vemos', a: 'en', legenda: 'Alérgenos', menu: 'Menú', carta: 'Carta de vinos' },
    sl: { piatto1: 'jed', piattiN: 'jedi', vino1: 'vino', viniN: 'vina', benvenuti: 'Dobrodošli', cerca: 'Poišči jed ali vino…', nessuno: 'Ni najdenih jedi.', allergeni: 'Alergeni', coperto: 'Pogrinjek', chiama: 'Pokliči', indicazioni: 'Navodila', oggi: 'Danes', persona: 'na osebo', powered: 'Digitalni meni', su: 'Na vrh', vai: 'Na meni', sito: 'Spletna stran', sfoglia: 'Odpri meni', cucina: 'Kuhinja', vini: 'Vina', bere: 'Pijače', intavola: 'Pri mizi', ilmenu: 'Meni', allergie: 'Alergije ali intolerance? Pred naročilom vprašajte osebje.', percorso: 'Degustacijski meni', aspettiamo: 'Pričakujemo vas', ciVediamo: 'Se vidimo', a: 'v', legenda: 'Alergeni', menu: 'Meni', carta: 'Vinska karta' }
  };
  const ICON_STAR = svg('<path d="m12 3 2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7Z"/>');
  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV'];
  // Immagini: solo indirizzi https o file del sito (nessun altro schema).
  // Testi delle schede (pannello che si apre dal basso, storia del locale, scheda sommelier).
  const T2 = {
    it: { scopri: 'Scopri', somm: 'Scheda sommelier', chiudi: 'Chiudi', storia: 'La nostra storia', leggi: 'Leggi la nostra storia', foto: 'Foto', profilo: { aromi: 'Aromi', struttura: 'Struttura', acidita: 'Acidità', dolcezza: 'Dolcezza', corpo: 'Corpo' }, campi: { cantina: 'Cantina', territorio: 'Territorio', vitigno: 'Vitigno', annata: 'Annata', gradazione: 'Gradazione', temperatura: 'Servire a', affinamento: 'Affinamento', colore: 'Colore', profumo: 'Profumo', gusto: 'Gusto', abbinamenti: 'Abbinamenti' } },
    en: { scopri: 'Discover', somm: 'Sommelier notes', chiudi: 'Close', storia: 'Our story', leggi: 'Read our story', foto: 'Photo', profilo: { aromi: 'Aromas', struttura: 'Structure', acidita: 'Acidity', dolcezza: 'Sweetness', corpo: 'Body' }, campi: { cantina: 'Winery', territorio: 'Region', vitigno: 'Grape', annata: 'Vintage', gradazione: 'Alcohol', temperatura: 'Serve at', affinamento: 'Ageing', colore: 'Colour', profumo: 'Nose', gusto: 'Palate', abbinamenti: 'Pairings' } },
    de: { scopri: 'Entdecken', somm: 'Sommelier-Notiz', chiudi: 'Schließen', storia: 'Unsere Geschichte', leggi: 'Unsere Geschichte lesen', foto: 'Foto', profilo: { aromi: 'Aromen', struttura: 'Struktur', acidita: 'Säure', dolcezza: 'Süße', corpo: 'Körper' }, campi: { cantina: 'Weingut', territorio: 'Gebiet', vitigno: 'Rebsorte', annata: 'Jahrgang', gradazione: 'Alkohol', temperatura: 'Trinktemperatur', affinamento: 'Ausbau', colore: 'Farbe', profumo: 'Duft', gusto: 'Geschmack', abbinamenti: 'Passt zu' } },
    fr: { scopri: 'Découvrir', somm: 'Fiche du sommelier', chiudi: 'Fermer', storia: 'Notre histoire', leggi: 'Lire notre histoire', foto: 'Photo', profilo: { aromi: 'Arômes', struttura: 'Structure', acidita: 'Acidité', dolcezza: 'Douceur', corpo: 'Corps' }, campi: { cantina: 'Domaine', territorio: 'Terroir', vitigno: 'Cépage', annata: 'Millésime', gradazione: 'Degré', temperatura: 'Servir à', affinamento: 'Élevage', colore: 'Robe', profumo: 'Nez', gusto: 'Bouche', abbinamenti: 'Accords' } },
    es: { scopri: 'Descubrir', somm: 'Ficha del sumiller', chiudi: 'Cerrar', storia: 'Nuestra historia', leggi: 'Leer nuestra historia', foto: 'Foto', profilo: { aromi: 'Aromas', struttura: 'Estructura', acidita: 'Acidez', dolcezza: 'Dulzor', corpo: 'Cuerpo' }, campi: { cantina: 'Bodega', territorio: 'Territorio', vitigno: 'Uva', annata: 'Añada', gradazione: 'Graduación', temperatura: 'Servir a', affinamento: 'Crianza', colore: 'Color', profumo: 'Nariz', gusto: 'Boca', abbinamenti: 'Maridajes' } },
    sl: { scopri: 'Odkrij', somm: 'Sommelierjev opis', chiudi: 'Zapri', storia: 'Naša zgodba', leggi: 'Preberi našo zgodbo', foto: 'Foto', profilo: { aromi: 'Arome', struttura: 'Struktura', acidita: 'Kislost', dolcezza: 'Sladkost', corpo: 'Telo' }, campi: { cantina: 'Klet', territorio: 'Okoliš', vitigno: 'Sorta', annata: 'Letnik', gradazione: 'Alkohol', temperatura: 'Postrezi pri', affinamento: 'Zorenje', colore: 'Barva', profumo: 'Vonj', gusto: 'Okus', abbinamenti: 'Kombinacije' } }
  };
  const PROFILO = ['aromi', 'struttura', 'acidita', 'dolcezza', 'corpo'];
  const TESSERE = ['temperatura', 'abbinamenti', 'colore', 'profumo', 'gusto', 'territorio', 'vitigno', 'affinamento', 'gradazione', 'annata'];
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
    const S = () => ({ ...(T[lang] || T.it), ...(T2[lang] || T2.it) });

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
    const galleria = (Array.isArray(premium.galleria) ? premium.galleria : []).map((g) => (typeof g === 'string' ? { src: g } : g || {})).map((g) => ({ src: safeImg(g.src), alt: g.alt })).filter((g) => g.src).slice(0, 8);
    const firma = String(premium.firma || '').trim().slice(0, 80);
    let schede = [];
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
    const sch = (v) => (v.scheda && typeof v.scheda === 'object' ? v.scheda : {});
    const haScheda = (v) => PROFILO.some((k) => Number.isFinite(sch(v).profilo?.[k])) || TESSERE.some((k) => t(sch(v)[k])) || !!t(sch(v).nota);
    function pills(v) {
      return Array.isArray(v.prezzi) && v.prezzi.length ? `<div class="pm-pills">${v.prezzi.map((p) => `<span class="pm-pill"><small>${esc(t(p.etichetta))}</small>${price(p.prezzo)}</span>`).join('')}</div>` : '';
    }
    function voce(v, vino) {
      const varianti = pills(v);
      const p = !varianti && v.prezzo ? `<span class="pm-pill pm-pill--solo">${price(v.prezzo)}${v.unita ? `<small>${esc(t(v.unita))}</small>` : ''}</span>` : '';
      const foto = safeImg(v.foto), scheda = haScheda(v);
      const apri = !!(foto || scheda);
      const k = apri ? schede.push({ v, vino }) - 1 : -1;
      const terr = t(sch(v).territorio), cantina = t(sch(v).cantina);
      const badge = vino && (terr || cantina) ? `<p class="pm-card__orig">${terr ? `<span class="pm-badge">${esc(terr)}</span>` : ''}${cantina ? `<span>${esc(cantina)}</span>` : ''}</p>` : '';
      const cta = apri ? `<span class="pm-card__cta">${scheda && vino ? S().somm : S().scopri}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span>` : '';
      const img = foto ? `<span class="pm-card__img${vino ? ' pm-card__img--bott' : ''}"><img src="${esc(foto)}" alt="" loading="lazy" decoding="async"></span>` : '';
      return `<article class="pm-card${foto ? ' pm-card--foto' : ''}${apri ? ' pm-card--apri' : ''}"${apri ? ` data-k="${k}" role="button" tabindex="0" aria-haspopup="dialog" aria-label="${esc(t(v.nome))} — ${esc(scheda && vino ? S().somm : S().scopri)}"` : ''}>${img}<div class="pm-card__body">${badge}<div class="pm-card__top"><h3 class="pm-card__nome">${esc(t(v.nome))}</h3>${p}</div>${v.descrizione && t(v.descrizione) ? `<p class="pm-card__desc">${esc(t(v.descrizione))}</p>` : ''}${varianti}${meta(v)}${cta}</div></article>`;
    }
    // Pannello dal basso: foto grande, racconto e scheda sommelier.
    function schedaHtml({ v, vino }) {
      const s = sch(v), foto = safeImg(v.foto);
      const p = pills(v) || (v.prezzo ? `<div class="pm-pills"><span class="pm-pill pm-pill--solo">${price(v.prezzo)}${v.unita ? `<small>${esc(t(v.unita))}</small>` : ''}</span></div>` : '');
      const testo = t(s.nota) || t(v.descrizione);
      const barre = PROFILO.filter((k) => Number.isFinite(s.profilo?.[k])).map((k) => { const n = Math.max(0, Math.min(100, Math.round(s.profilo[k]))); return `<div class="pm-barra"><span>${S().profilo[k]}</span><i><b style="--w:${n}%"></b></i><em>${n}</em></div>`; }).join('');
      const tessere = TESSERE.filter((k) => t(s[k])).map((k) => `<div class="pm-tessera${k === 'temperatura' ? ' pm-tessera--temp' : ''}"><span>${S().campi[k]}</span><p>${esc(t(s[k]))}</p></div>`).join('');
      return `${foto ? `<figure class="pm-sheet__foto${vino ? ' pm-sheet__foto--bott' : ''}"><img src="${esc(foto)}" alt="${esc(t(v.nome))}"></figure>` : ''}
        <div class="pm-sheet__in">
          ${t(s.territorio) || t(s.cantina) ? `<p class="pm-card__orig">${t(s.territorio) ? `<span class="pm-badge">${esc(t(s.territorio))}</span>` : ''}${t(s.cantina) ? `<span>${esc(t(s.cantina))}</span>` : ''}</p>` : ''}
          <h2 id="pm-sheet-t">${esc(t(v.nome))}</h2>${p}
          ${testo ? `<blockquote class="pm-sheet__quote">${esc(testo)}</blockquote>` : ''}
          ${barre ? `<div class="pm-profilo">${barre}</div>` : ''}
          ${tessere ? `${vino && haScheda(v) ? `<p class="pm-sheet__label">${S().somm}</p>` : ''}<div class="pm-tessere">${tessere}</div>` : ''}
          ${meta(v)}
        </div>`;
    }
    function storiaHtml() {
      const par = t(premium.storia).split(/\n{2,}|\n/).map((x) => x.trim()).filter(Boolean);
      return `${galleria.length ? `<div class="pm-galleria" tabindex="0" aria-label="${S().foto}">${galleria.map((g) => `<figure><img src="${esc(g.src)}" alt="${esc(t(g.alt))}" loading="lazy"></figure>`).join('')}</div>${galleria.length > 1 ? `<div class="pm-punti" aria-hidden="true">${galleria.map((_, n) => `<i${n ? '' : ' class="on"'}></i>`).join('')}</div>` : ''}` : ''}
        <div class="pm-sheet__in pm-sheet__in--storia"><span class="pm-eyebrow pm-eyebrow--scuro">${esc(nome)}</span><h2 id="pm-sheet-t">${S().storia}</h2>${par.map((x) => `<p>${esc(x)}</p>`).join('')}${firma ? `<p class="pm-firma">— ${esc(firma)}</p>` : ''}</div>`;
    }
    let lastFocus = null;
    function openSheet(html) {
      closeSheet(true);
      lastFocus = document.activeElement;
      const wrap = document.createElement('div');
      wrap.className = 'pm-sheet-wrap';
      wrap.innerHTML = `<div class="pm-sheet__velo" data-close></div><section class="pm-sheet" role="dialog" aria-modal="true" aria-labelledby="pm-sheet-t"><div class="pm-sheet__maniglia" aria-hidden="true"><i></i></div><button class="pm-sheet__x" type="button" data-close aria-label="${S().chiudi}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button><div class="pm-sheet__scroll">${html}</div></section>`;
      document.body.appendChild(wrap);
      document.documentElement.classList.add('pm-lock');
      requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('open')));
      wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeSheet()));
      wrap.querySelector('.pm-sheet__x').focus({ preventScroll: true });
      const gal = wrap.querySelector('.pm-galleria');
      if (gal) gal.addEventListener('scroll', () => { const n = Math.round(gal.scrollLeft / gal.clientWidth); wrap.querySelectorAll('.pm-punti i').forEach((d, j) => d.classList.toggle('on', j === n)); }, { passive: true });
      // Trascina in giù la maniglia per chiudere.
      const sheet = wrap.querySelector('.pm-sheet'), grip = wrap.querySelector('.pm-sheet__maniglia');
      let y0 = null;
      grip.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; sheet.style.transition = 'none'; }, { passive: true });
      grip.addEventListener('touchmove', (e) => { if (y0 == null) return; const dy = Math.max(0, e.touches[0].clientY - y0); sheet.style.transform = `translateY(${dy}px)`; }, { passive: true });
      grip.addEventListener('touchend', (e) => { const dy = e.changedTouches[0].clientY - (y0 ?? 0); y0 = null; sheet.style.transition = ''; sheet.style.transform = ''; if (dy > 90) closeSheet(); });
    }
    function closeSheet(now) {
      const wrap = document.querySelector('.pm-sheet-wrap');
      if (!wrap) return;
      document.documentElement.classList.remove('pm-lock');
      if (now) { wrap.remove(); return; }
      wrap.classList.remove('open');
      setTimeout(() => wrap.remove(), 320);
      if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
    }
    document.addEventListener('keydown', (e) => {
      const wrap = document.querySelector('.pm-sheet-wrap');
      if (!wrap) return;
      if (e.key === 'Escape') { closeSheet(); return; }
      if (e.key === 'Tab') { // il focus resta nel pannello
        const f = [...wrap.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])')];
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
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
      const conta = `${voci.length} ${voci.length === 1 ? (vino ? S().vino1 : S().piatto1) : (vino ? S().viniN : S().piattiN)}`;
      return `<section class="pm-sezione" id="pm-sez-${i}"><div class="pm-pannello"><header class="pm-sezione__head"><span class="pm-medaglia" aria-hidden="true">${iconFor(s)}</span><div class="pm-sezione__tit"><span class="pm-sezione__num">${num} · ${conta}</span><h2>${esc(t(s.nome))}</h2></div></header>${desc}<div class="pm-voci">${voci.map((v) => voce(v, vino)).join('')}</div></div></section>`;
    }

    function draw() {
      schede = [];
      closeSheet(true);
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
          <h1${logo ? ' class="pm-vh"' : ''}>${tipo ? `<small>${esc(tipo)}</small>` : ''}${esc(nomeProprio)}</h1>
          <span class="pm-orn" aria-hidden="true">✦</span>
          ${motto ? `<p class="pm-open__motto">${esc(motto)}</p>` : ''}
          ${menu.orari && t(menu.orari) ? `<p class="pm-open__orari">${ICON.clock}<span>${esc(t(menu.orari))}</span></p>` : ''}
          <div class="pm-open__links"><a class="pm-btn pm-btn--pieno" href="#pm-carta" data-go="cucina">${S().sfoglia}</a>${haBere && haCucina ? `<a class="pm-btn pm-btn--linea" href="#pm-carta" data-go="bere">${labelBere === 'vini' ? S().carta : S().bere}</a>` : ''}</div>
        </div></section>
        ${cover ? `<figure class="pm-wrap pm-cover"><img src="${esc(cover)}" alt="" loading="eager"></figure>` : ''}
        ${t(premium.storia) || galleria.length ? `<section class="pm-wrap pm-racconto"><button type="button" class="pm-racconto__card" data-storia aria-haspopup="dialog">${galleria[0] ? `<span class="pm-racconto__img"><img src="${esc(galleria[0].src)}" alt="" loading="lazy"></span>` : ''}<span class="pm-racconto__txt"><span class="pm-eyebrow pm-eyebrow--scuro">${S().storia}</span>${t(premium.storia) ? `<span class="pm-racconto__p">${esc(t(premium.storia).split(/\n/)[0])}</span>` : ''}${firma ? `<span class="pm-firma">— ${esc(firma)}</span>` : ''}<span class="pm-card__cta">${t(premium.storia) ? S().leggi : S().foto}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span></span></button>${galleria.length > 2 ? `<div class="pm-racconto__strip" style="--n:${Math.min(3, galleria.length - 1)}" aria-hidden="true">${galleria.slice(1, 4).map((g) => `<img src="${esc(g.src)}" alt="" loading="lazy">`).join('')}</div>` : ''}</section>` : ''}
        ${menu.avviso && t(menu.avviso) ? `<div class="pm-wrap"><div class="pm-avviso"><b>${S().oggi}</b>${esc(t(menu.avviso)).replace(/^Oggi:\s*|^Today:\s*/i, '')}</div></div>` : ''}
        <section class="pm-wrap pm-carta" id="pm-carta">
          <div class="pm-carta__intro"><span class="pm-eyebrow pm-eyebrow--scuro">${S().intavola}</span><h2>${S().ilmenu}</h2><p>${S().allergie}</p></div>
          <div class="pm-tools">${switcher}<div class="pm-search">${ICON.search}<input id="pm-q" type="search" placeholder="${S().cerca}" aria-label="${S().cerca}" value="${esc(query)}" autocomplete="off"></div></div>
          ${q ? '' : `<nav class="pm-nav" aria-label="Sezioni">${visibili.map((x, n) => `<a href="#pm-sez-${x.i}" data-i="${x.i}">${x.s.tipo === 'degustazione' ? ICON_STAR : iconFor(x.s)}${esc(x.s.tipo === 'degustazione' ? S().percorso : t(x.s.nome))}</a>`).join('')}</nav>`}
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
      body.querySelectorAll('.pm-card--apri').forEach((c) => {
        const go = () => { const x = schede[Number(c.dataset.k)]; if (x) openSheet(schedaHtml(x)); };
        c.addEventListener('click', go);
        c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      });
      body.querySelector('[data-storia]')?.addEventListener('click', () => openSheet(storiaHtml()));
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
    // Apertura animata con il logo (una volta per visita; mai con «riduci movimento»).
    (function intro() {
      const forza = params.get('intro') === '1';
      if (!forza && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      const key = `pm-intro-${menu.id || nome}`;
      try { if (!forza && sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch { /* navigazione privata */ }
      const el = document.createElement('div');
      el.className = 'pm-intro';
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = `<div class="pm-intro__in">${logo ? `<img src="${esc(logo)}" alt="">` : `<span class="pm-crest"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="57" fill="none" stroke="currentColor" stroke-width="1"/><circle cx="60" cy="60" r="50" fill="none" stroke="currentColor" stroke-width=".6" stroke-dasharray="1.5 3"/></svg><b>${esc(iniziale)}</b></span>`}<span class="pm-intro__nome">${tipo ? `<small>${esc(tipo)}</small>` : ''}${esc(nomeProprio)}</span><i class="pm-intro__luce"></i></div>`;
      document.body.appendChild(el);
      const via = () => { el.classList.add('via'); setTimeout(() => el.remove(), 700); };
      el.addEventListener('click', via);
      setTimeout(via, 2300);
    })();
  }

  window.RenMenuPremium = { render, resolveStyle, contrast, cityOf, DIREZIONI, CARATTERI: Object.keys(CARATTERI) };
})();

/* Premium «su misura» (2026-10-03).
 * Il contenuto resta lo stesso menu RenMenu (menus/<id>.json, stesso URL e stesso QR);
 * l'aspetto vive nel blocco pubblico «premium», letto da menu/premium.js sul sito.
 * Jarvis prepara una SCHEDA CREATIVA dal testo del cliente e 3 DIREZIONI GRAFICHE;
 * Riccardo sceglie, approva la grafica e decide il preventivo. Nulla viene inventato:
 * niente motto, storia, prezzi o totale del preventivo che il cliente non abbia scritto. */

export const DIREZIONI = {
  editoriale: { label: 'Editoriale elegante', caratteri: 'classico', colori: { fondo: '#f6f1e7', testo: '#1f1b16', accento: '#8a5a2b', secondario: '#2a3b30' },
    descrizione: 'Carta avorio, titoli serif, molta aria: adatto a ristoranti curati, gourmet, storici.' },
  bistrot: { label: 'Bistrot caldo', caratteri: 'artigianale', colori: { fondo: '#f3ebe0', testo: '#2a211b', accento: '#a4462b', secondario: '#2f3d33' },
    descrizione: 'Toni caldi, schede e copertina piena: adatto a osterie, trattorie, enoteche, locali di famiglia.' },
  moderno: { label: 'Moderno deciso', caratteri: 'moderno', colori: { fondo: '#ffffff', testo: '#141414', accento: '#d9480f', secondario: '#141414' },
    descrizione: 'Pulito, numeri di sezione grandi, colori pieni: adatto a cocktail bar, street food, locali giovani.' }
};
export const CARATTERI = ['classico', 'moderno', 'artigianale'];
const PALETTE_KEYS = ['fondo', 'testo', 'accento', 'secondario'];
const PREMIUM_KEYS = new Set(['direzione', 'caratteri', 'colori', 'logo', 'copertina', 'motto', 'storia', 'firma', 'galleria']);
const HEX = /^#[0-9a-f]{6}$/i;
const IMAGE = /^(?:\.\.\/|\/)?[a-z0-9_./-]+\.(?:webp|png|jpe?g|svg|avif)$/i;
// Lingue con testi d'interfaccia nel template Premium.
export const PREMIUM_LANGS = { it: 'italiano', en: 'inglese', de: 'tedesco', fr: 'francese', es: 'spagnolo', sl: 'sloveno' };

const norm = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
// Le email di Gmail vanno a capo da sole: le righe spezzate a metà frase si riuniscono.
const sentences = (text) => String(text || '').replace(/\r/g, '').replace(/([^\n.!?:;])\n(?=[a-zà-ÿ(])/g, '$1 ').split(/\n+|(?<=[.!?;])\s+/).map((s) => s.trim()).filter(Boolean);
const cut = (s) => s.length > 160 ? `${s.slice(0, 157)}…` : s;

const STYLE = [
  ['editoriale', /\belegant\w*|raffinat\w*|\bclassic\w*|\bstoric\w*|gourmet|stellat\w*|sobri\w*|\bchic\b|lusso|lussuos\w*|esclusiv\w*|ricercat\w*|signoril\w*/],
  ['bistrot', /\bbistrot\b|rustic\w*|\bcald[oaie]\b|familiar\w*|tradizional\w*|accoglient\w*|\blegno\b|vintage|\bretro\b|\bosteria\b|\btrattoria\b|\benoteca\b|artigianal\w*|casereccio|genuin\w*/],
  ['moderno', /modern\w*|giovan\w*|minimal\w*|contemporane\w*|\burban\w*|\bpop\b|audac\w*|colorat\w*|dinamic\w*|\bfresc[oa]\b|street|\bgrintos\w*|essenzial\w*/]
];
// Parole colore → tinta curata (leggibile su carta chiara). Prima le espressioni composte.
const COLORS = [
  ['blu notte', /blu notte|blu scuro|navy/, '#1f2f4a'], ['verde bosco', /verde (?:bosco|scuro|bottiglia)/, '#2f4a3a'], ['verde salvia', /verde salvia|salvia/, '#5f7a5c'],
  ['oro', /\boro\b|dorat\w*|\bgold\b/, '#a67c2e'], ['bordeaux', /bordeaux|\bbordo\b|amaranto|vinaccia/, '#6e1f2b'], ['terracotta', /terracotta|mattone|ruggine/, '#b0522b'],
  ['rame', /\brame\b|ramato/, '#9a5b34'], ['oliva', /\boliva\b|verde oliva/, '#6b6b2f'], ['ocra', /\bocra\b|senape/, '#a87a12'], ['arancio', /arancio\w*|arancion\w*/, '#c2410c'],
  ['rosso', /\bross[oie]\b/, '#a3262e'], ['rosa', /\bros[ae]\b|rosa antico|cipria/, '#b5536e'], ['viola', /\bviola\b|lilla|prugna|melanzana/, '#5b3a72'],
  ['azzurro', /azzurr\w*|celest\w*|turchese|acquamarina/, '#2f7a9a'], ['blu', /\bblu\b|\bblue\b/, '#1d4f7a'], ['verde', /\bverd[ei]\b/, '#2f6b45'],
  ['marrone', /marron\w*|cioccolato|\bcaffe\b|nocciola/, '#6b4a2f'], ['giallo', /giall\w*/, '#a88a00'], ['grigio', /grigi\w*|antracite/, '#4a4f55'],
  ['nero', /\bner[oaie]\b|\bblack\b/, '#141414'], ['crema', /\bcrema\b|avorio|panna|beige|sabbia|\bbianc\w*/, '#f6f1e7']
];
const NEUTRAL = new Set(['nero', 'crema', 'grigio']);
const COLOR_CONTEXT = /\b(colou?r\w*|ton[oi]|tonalita|palette|tinta|tinte|grafica|logo|sfondo|fondo|stile|look|aspetto|brand|marchio|insegna|arredament\w*|pareti)\b/;
const LANG_WORDS = [['en', /ingles\w*|english/], ['de', /tedesc\w*|deutsch|german\w*/], ['fr', /frances\w*|french/], ['es', /spagnol\w*|spanish/], ['sl', /sloven\w*/],
  ['hr', /croat\w*/], ['ru', /\brusso\b|russian/], ['zh', /cines\w*|chinese/], ['ja', /giappones\w*|japanese/], ['ar', /\barab\w*/], ['pt', /portoghes\w*/], ['nl', /oland\w*/]];
const SPECIALS = [
  ['vini', /carta dei vini|\bvin[io]\b|cantina|calic[ei]|bottigli\w*|etichett\w* di vino/, 'Carta dei vini con calice e bottiglia'],
  ['degustazione', /degustazion\w*|percorso|menu (?:del territorio|a sorpresa)|tasting/, 'Percorso o menu degustazione a prezzo fisso'],
  ['cocktail', /cocktail|mixology|signature drink|aperitiv\w*/, 'Sezione cocktail'],
  ['birre', /birr\w* artigianal\w*|carta delle birre|\bbirre\b/, 'Carta delle birre'],
  ['giorno', /piatt\w* del giorno|menu del giorno|fuori menu/, 'Piatti del giorno (avviso in alto)']
];
// Richieste che il template non copre: lavoro su misura da valutare e quotare (decide Riccardo).
const OUT_OF_SCOPE = [
  [/prenotazion\w* (?:online|dal menu|del tavolo)|prenotare (?:un |il )?tavolo|prenota(?:re)? online|sistema di prenotazion\w*/, 'Prenotazioni online'],
  [/ordin\w* (?:dal|al) tavolo|ordinazion\w* (?:online|dal telefono|dal menu)|ordinare dal (?:menu|telefono)|carrello/, 'Ordini dal tavolo o online'],
  [/pagament\w* (?:online|al tavolo|dal menu)|pagare (?:dal|al) (?:telefono|tavolo|menu)|pagare con il telefono/, 'Pagamenti dal menu'],
  [/\bvideo\b|animazion\w*|animat\w*|effetti/, 'Video o animazioni'],
  [/\bapp\b|applicazione/, 'App dedicata'],
  [/delivery|consegna a domicilio|asporto online|e-?commerce|negozio online/, 'Delivery o vendita online'],
  [/newsletter|raccolta (?:email|contatti)|fidelity|fidelizzazion\w*|punti fedelta/, 'Raccolta contatti o fidelity'],
  [/recension\w*|tripadvisor|google review/, 'Recensioni nel menu'],
  [/sito (?:web )?(?:completo|intero|nuovo)|piu pagine|pagina (?:eventi|chi siamo)/, 'Sito con più pagine']
];

/** Scheda creativa: cosa ha chiesto il cliente per l'aspetto, con la frase da cui viene. */
export function creativeBrief(text, { attachments = 0 } = {}) {
  const rows = sentences(text);
  const brief = { stile: [], colori: [], sfondoScuro: false, lingue: [], lingueFuori: [], sezioni: [], riferimenti: [], logo: null, foto: null, permessoFoto: false,
    scadenza: null, fuori: [], preventivo: null, mancanti: [], direzione: null, storia: null, galleria: null, schedeVini: null, diciture: [] };
  const seen = new Set();
  const push = (list, key, item) => { if (!seen.has(`${list}:${key}`)) { seen.add(`${list}:${key}`); brief[list].push(item); } };
  for (const row of rows) {
    const t = norm(row);
    const venueLine = /^\s*(?:locale|nome del locale|ristorante|attivita)\s*:/.test(t);
    if (!venueLine) for (const [dir, rx] of STYLE) { const m = t.match(rx); if (m) push('stile', m[0], { parola: m[0], direzione: dir, fonte: cut(row) }); }
    for (const m of row.matchAll(/#[0-9a-f]{6}\b/gi)) push('colori', m[0].toLowerCase(), { nome: m[0].toLowerCase(), hex: m[0].toLowerCase(), fonte: cut(row) });
    if (COLOR_CONTEXT.test(t) || /\b(?:color[ei]|toni) (?:del|dei|della)\b/.test(t)) {
      let rest = t;
      for (const [nome, rx, hex] of COLORS) if (rx.test(rest)) { push('colori', nome, { nome, hex, fonte: cut(row) }); rest = rest.replace(rx, ' '); }
    }
    if (/sfondo (?:scuro|nero|blu notte)|fondo (?:scuro|nero)|\bdark\b|tutto (?:nero|scuro)|\b(?:grafica|tema|stile|look|aspetto|menu)\b[^.]{0,30}\bscur[ao]\b/.test(t)) brief.sfondoScuro = true;
    if (/\b(lingu\w*|tradu\w*|tradott\w*|versione|anche in|in italiano|turist\w*|stranier\w*)\b/.test(t) || LANG_WORDS.filter(([, rx]) => rx.test(t)).length >= 2)
      for (const [code, rx] of LANG_WORDS) if (rx.test(t)) {
        if (PREMIUM_LANGS[code]) push('lingue', code, code); else push('lingueFuori', code, { lingua: code, fonte: cut(row) });
      }
    for (const [code, rx, label] of SPECIALS) if (rx.test(t)) push('sezioni', code, { codice: code, label, fonte: cut(row) });
    for (const m of row.matchAll(/\bhttps?:\/\/[^\s<>"')]+|\bwww\.[^\s<>"')]+/gi)) push('riferimenti', m[0], { tipo: 'link', valore: m[0].replace(/[.,;]$/, ''), fonte: cut(row) });
    if (/\b(?:come|simile|ispirat\w*|stile del|tipo il|riferimento)\b/.test(t) && /\b(sito|instagram|pagina|locale|menu)\b/.test(t) && !/\b(?:storia|galleria|schede)\b/.test(t) && !brief.riferimenti.some((r) => r.fonte === cut(row)))
      push('riferimenti', row, { tipo: 'esempio', valore: cut(row), fonte: cut(row) });
    if (/\blogo\b/.test(t)) {
      const attached = /allegat\w*|in allegato|vi mando|vi invio|ti mando|ti invio|trovate/.test(t);
      const none = /(?:non|senza) (?:abbiamo |ho )?(?:ancora )?(?:un |il )?logo|logo (?:da fare|da creare|non c'e)|(?:creare|fare|disegnare) (?:anche )?(?:il |un )?logo/.test(t);
      brief.logo = { stato: none ? 'da_creare' : attached ? 'allegato' : 'citato', fonte: cut(row) };
    }
    if (/\bfoto\w*|immagin\w*|fotografi\w*/.test(t) && !/foto del menu|fotograf\w* del menu|menu in foto/.test(t)) {
      brief.foto = brief.foto || { fonte: cut(row) };
      if (/(?:potete|puoi|potete pure|liberi di|autorizz\w*|permesso)\b[^.]{0,40}\b(?:usa|utilizz|pubblic|mett)\w*|(?:usate|usa pure|utilizzate)\b[^.]{0,30}\bfoto/.test(t)) brief.permessoFoto = true;
    }
    const due = t.match(/\bentro (?:il |la |fine |meta )?[^,.;]{2,30}|\b(?:apertura|inaugurazion\w*|apriamo)\b[^,.;]{0,40}|\bper (?:il|la) (?:\d{1,2}|prossim\w*|fine)[^,.;]{0,25}/);
    if (due && !brief.scadenza && !/prenot|percorso|degustazion|sera stessa|tavol/.test(t)) brief.scadenza = { testo: due[0].trim(), fonte: cut(row) };
    for (const [rx, label] of OUT_OF_SCOPE) if (rx.test(t)) push('fuori', label, { label, fonte: cut(row) });
    if (!brief.preventivo && /preventivo|quanto (?:costa|verrebbe|spendiamo|costerebbe|tempo)|budget|prezzo del servizio|costo totale|\bacconto\b|tempi e prezzi|prezzi e tempi|che tempi|quali tempi|\bcosti\b/.test(t)) {
      brief.preventivo = { fonte: cut(row) };
    }
    // «Possiamo partire da un acconto già questa settimana»: può stare in una frase dopo la domanda sui prezzi.
    if (brief.preventivo && /\bacconto\b/.test(t)) {
      const when = t.match(/\b(?:gia\s+)?(questa settimana|oggi|domani|subito|entro [a-z0-9 ]{2,20})\b/);
      Object.assign(brief.preventivo, { acconto: true, quando: when ? when[1] : null });
    }
    // Pagina «storia del locale»: Jarvis non scrive la storia, annota i fatti scritti dal cliente e chiede il testo.
    if (/\b(?:pagina|sezione|racconti\w*|raccontare)\b[^.]{0,60}\bstoria\b|\bstoria\b[^.]{0,40}\b(?:locale|osteria|ristorante|famiglia)\b/.test(t) && !brief.storia) {
      const facts = [...row.matchAll(/\b(?:è nato|e nato|nato|nata|fondat[oa]|aperto|aperta)\s+(?:nel|nel\s+lontano|dal|il|in)\s+[^),.;]{3,60}/gi)].map((m) => m[0].trim());
      brief.storia = { fatti: facts, fonte: cut(row) };
    }
    const gal = t.match(/galleria[^.]{0,40}?\b(\d{1,2}(?:\s*[-–]\s*\d{1,2})?)\s*foto/) || t.match(/\b(\d{1,2}(?:\s*[-–]\s*\d{1,2})?)\s*foto\b[^.]{0,40}galleria/);
    if ((gal || /\bgalleria\b/.test(t)) && !brief.galleria) brief.galleria = { numero: gal ? gal[1].replace(/\s+/g, '') : null, fonte: cut(row) };
    if (brief.galleria && !brief.galleria.arrivo && /\b(?:foto|immagini)\b[^.]{0,60}\b(?:whatsapp|domani|mail|email|telegram|dopo)\b|\b(?:whatsapp|domani)\b[^.]{0,40}\b(?:foto|immagini)\b/.test(t)) brief.galleria.arrivo = cut(row);
    if (/\bschede?\b[^.]{0,30}\bvin[io]\b/.test(t) && !brief.schedeVini) brief.schedeVini = { fonte: cut(row) };
    const claim = row.match(/\b(?:scritta|dicitura|slogan|claim|vogliamo scrivere|vorremmo scrivere)\s*[:“"«]?\s*[“"«]([^”"»]{4,80})[”"»]/i);
    if (claim) brief.diciture.push({ testo: claim[1].trim(), dubbio: /non (?:sono |siamo )?(?:sicur\w*|certa|certo|certi)|dubbi\w*|si possa dire|si può dire|non so se/.test(t), fonte: cut(row) });
  }
  if (attachments > 0 && brief.logo?.stato === 'citato') brief.logo.stato = 'allegato';
  const score = { editoriale: 0, bistrot: 0, moderno: 0 };
  for (const s of brief.stile) score[s.direzione] += 1;
  if (brief.sezioni.some((s) => s.codice === 'cocktail')) score.moderno += 0.5;
  if (brief.sezioni.some((s) => s.codice === 'degustazione')) score.editoriale += 0.5;
  if (brief.sezioni.some((s) => s.codice === 'vini')) score.bistrot += 0.25;
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  brief.direzione = best[1] > 0 ? best[0] : null;
  if (!brief.stile.length) brief.mancanti.push('Stile desiderato (elegante, caldo, moderno…) o un locale/sito di riferimento');
  if (!brief.colori.length) brief.mancanti.push('Colori del locale o del marchio');
  if (!brief.logo) brief.mancanti.push('Logo in buona qualità (PNG trasparente o SVG), se esiste');
  else if (brief.logo.stato === 'citato') brief.mancanti.push('Il file del logo: è citato ma non allegato');
  if (brief.foto && !brief.permessoFoto) brief.mancanti.push('Permesso scritto di usare le foto nel menu pubblico');
  if (brief.storia) brief.mancanti.push('Testo della storia del locale scritto o confermato dal cliente (Jarvis non lo inventa)');
  if (brief.galleria && !brief.permessoFoto) brief.mancanti.push(`Le foto della galleria${brief.galleria.numero ? ` (${brief.galleria.numero})` : ''} e il permesso scritto di pubblicarle`);
  if (brief.schedeVini) brief.mancanti.push('Dati per le schede dei vini (cantina, vitigno, annata, descrizione): Jarvis non li inventa');
  if (brief.lingue.length + 1 > 4) brief.mancanti.push(`Lingue: il Premium ne prevede fino a 4, ne sono state chieste ${brief.lingue.length + 1}`);
  return brief;
}

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (h) => { const c = hexToRgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const mix = (a, b, w) => `#${hexToRgb(a).map((v, i) => Math.round(v * (1 - w) + hexToRgb(b)[i] * w).toString(16).padStart(2, '0')).join('')}`;

/** Tre direzioni grafiche, la più adatta alla scheda per prima. Ogni «premium» è già pubblicabile. */
export function premiumDirections(brief = {}) {
  const order = [brief.direzione, 'editoriale', 'bistrot', 'moderno'].filter((d, i, all) => d && DIREZIONI[d] && all.indexOf(d) === i);
  const chromatic = (brief.colori || []).filter((c) => !NEUTRAL.has(c.nome) && lum(c.hex) < 0.6);
  const wantsBlack = (brief.colori || []).some((c) => c.nome === 'nero');
  return order.map((direzione, index) => {
    const base = DIREZIONI[direzione];
    const colori = { ...base.colori };
    if (chromatic[0]) colori.accento = chromatic[0].hex;
    if (chromatic[1]) colori.secondario = chromatic[1].hex;
    else if (chromatic[0]) colori.secondario = direzione === 'moderno' && wantsBlack ? '#141414' : mix(chromatic[0].hex, '#000000', 0.45);
    if (brief.sfondoScuro) { colori.fondo = direzione === 'bistrot' ? '#1f1a16' : '#121212'; colori.testo = '#f3eee6'; if (!chromatic[0]) colori.accento = '#c9a45c'; }
    const why = index === 0 && brief.direzione
      ? `scelta dallo stile richiesto (${brief.stile.filter((s) => s.direzione === direzione).map((s) => `«${s.parola}»`).slice(0, 3).join(', ') || 'sezioni del menu'})`
      : index === 0 ? 'proposta di partenza: lo stile non è scritto nella richiesta' : 'alternativa da confrontare';
    return { direzione, label: base.label, descrizione: base.descrizione, why, colorNote: chromatic.length ? `colori dal cliente: ${chromatic.slice(0, 2).map((c) => c.nome).join(' e ')}` : 'colori della direzione (il cliente non li ha indicati)',
      premium: { direzione, caratteri: base.caratteri, colori } };
  });
}

/** Controllo stretto del blocco pubblico «premium» (stesse regole di scripts/validate-menus.py). */
export function premiumErrors(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['menu.premium: deve essere un oggetto.'];
  for (const key of Object.keys(value)) if (!PREMIUM_KEYS.has(key)) errors.push(`menu.premium.${key}: campo non previsto.`);
  if ('direzione' in value && !DIREZIONI[value.direzione]) errors.push('menu.premium.direzione: usa editoriale, bistrot o moderno.');
  if ('caratteri' in value && !CARATTERI.includes(value.caratteri)) errors.push('menu.premium.caratteri: usa classico, moderno o artigianale.');
  if ('colori' in value) {
    if (!value.colori || typeof value.colori !== 'object' || Array.isArray(value.colori)) errors.push('menu.premium.colori: deve essere un oggetto.');
    else for (const [key, color] of Object.entries(value.colori)) if (!PALETTE_KEYS.includes(key) || typeof color !== 'string' || !HEX.test(color)) errors.push(`menu.premium.colori.${key}: usa un colore #rrggbb.`);
  }
  for (const key of ['logo', 'copertina']) if (key in value && !(typeof value[key] === 'string' && (value[key].startsWith('https://') || IMAGE.test(value[key])))) errors.push(`menu.premium.${key}: serve un indirizzo https o un file immagine del sito.`);
  for (const key of ['motto', 'storia']) if (key in value) {
    const v = value[key];
    const ok = typeof v === 'string' || (v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v).every(([k, s]) => /^[a-z]{2}$/.test(k) && typeof s === 'string'));
    if (!ok) errors.push(`menu.premium.${key}: serve testo o traduzioni per lingua.`);
  }
  if ('firma' in value && !(typeof value.firma === 'string' && value.firma.trim() && value.firma.trim().length <= 80)) errors.push('menu.premium.firma: testo breve (massimo 80 caratteri).');
  if ('galleria' in value) {
    const gallery = value.galleria;
    if (!Array.isArray(gallery) || gallery.length > 8) errors.push('menu.premium.galleria: elenco di massimo 8 foto.');
    else gallery.forEach((photo, n) => {
      const src = photo && typeof photo === 'object' ? photo.src : photo;
      if (!(typeof src === 'string' && (src.startsWith('https://') || IMAGE.test(src)))) errors.push(`menu.premium.galleria, foto ${n + 1}: serve un indirizzo https o un file immagine del sito.`);
    });
  }
  return errors;
}

const LABEL_LANG = (codes) => codes.map((c) => PREMIUM_LANGS[c] || c).join(', ');
/** Righe brevi per Revisione, Telegram e note: cosa ha chiesto il cliente e cosa manca. */
export function briefLines(brief) {
  if (!brief) return [];
  const out = [];
  if (brief.stile.length) out.push(`Stile: ${brief.stile.map((s) => s.parola).slice(0, 4).join(', ')}`);
  if (brief.colori.length) out.push(`Colori: ${brief.colori.map((c) => c.nome).slice(0, 4).join(', ')}${brief.sfondoScuro ? ' (sfondo scuro)' : ''}`);
  if (brief.lingue.length) out.push(`Lingue: italiano + ${LABEL_LANG(brief.lingue)}`);
  if (brief.sezioni.length) out.push(`Sezioni speciali: ${brief.sezioni.map((s) => s.label.toLowerCase()).join('; ')}`);
  if (brief.logo) out.push(`Logo: ${{ allegato: 'allegato', citato: 'citato, file da ricevere', da_creare: 'da creare (lavoro su misura)' }[brief.logo.stato]}`);
  if (brief.foto) out.push(`Foto: ${brief.permessoFoto ? 'permesso di usarle scritto nell’email' : 'citate, manca il permesso scritto'}`);
  if (brief.riferimenti.length) out.push(`Riferimenti: ${brief.riferimenti.map((r) => r.valore).slice(0, 2).join(' · ')}`);
  if (brief.scadenza) out.push(`Scadenza: ${brief.scadenza.testo}`);
  if (brief.fuori.length) out.push(`Lavoro su misura (fuori dal template, da quotare): ${brief.fuori.map((f) => f.label).join(', ')}`);
  if (brief.lingueFuori.length) out.push(`Lingue non ancora nel template: ${brief.lingueFuori.map((l) => l.lingua).join(', ')} (lavoro su misura)`);
  if (brief.storia) out.push(`Pagina storia del locale richiesta${brief.storia.fatti.length ? ` (dal cliente: ${brief.storia.fatti.join('; ')})` : ''}`);
  if (brief.galleria) out.push(`Galleria foto${brief.galleria.numero ? `: ${brief.galleria.numero} foto` : ''}${brief.galleria.arrivo ? ', il cliente le manda a parte' : ''}`);
  if (brief.schedeVini) out.push('Schede dei vini principali richieste');
  for (const d of brief.diciture) out.push(`Dicitura richiesta: «${d.testo}»${d.dubbio ? ' (il cliente stesso ha un dubbio)' : ''}`);
  if (brief.preventivo) out.push(`Chiede ${brief.preventivo.acconto ? 'tempi, prezzi e può versare un acconto' : 'il preventivo'}${brief.preventivo.quando ? ` (${brief.preventivo.quando})` : ''}: acconto 490 € + 39 €/mese, il totale lo decidi tu`);
  if (brief.mancanti.length) out.push(`Da chiedere al cliente: ${brief.mancanti.join('; ')}`);
  return out;
}

/** Note per «Da sistemare o confermare»: solo ciò che richiede una decisione di Riccardo. */
export function briefNotes(brief) {
  if (!brief) return [];
  const notes = [];
  for (const f of brief.fuori) notes.push({ kind: 'premium', text: f.fonte, hint: `Lavoro su misura: ${f.label}. Non è nel template Premium: valuta e quota tu.` });
  for (const l of brief.lingueFuori) notes.push({ kind: 'premium', text: l.fonte, hint: `Lingua «${l.lingua}» non ancora nel template: lavoro su misura.` });
  if (brief.logo?.stato === 'da_creare') notes.push({ kind: 'premium', text: brief.logo.fonte, hint: 'Logo da creare: lavoro su misura, da quotare.' });
  for (const m of brief.mancanti.filter((x) => !/^(?:Testo della storia|Le foto della galleria|Dati per le schede)/.test(x))) notes.push({ kind: 'premium', text: m, hint: 'Da chiedere al cliente prima di chiudere la grafica.' });
  const extraLangs = brief.lingue.filter((code) => code !== 'en');
  if (extraLangs.length) notes.push({ kind: 'premium', text: `Lingue richieste: italiano + ${LABEL_LANG(brief.lingue)}`, hint: `Jarvis prepara in automatico solo l’inglese: ${LABEL_LANG(extraLangs)} ${extraLangs.length > 1 ? 'sono da preparare' : 'è da preparare'} e da verificare prima di aggiungerle al menu.` });
  if (brief.storia) notes.push({ kind: 'premium', text: brief.storia.fonte, hint: `Pagina storia richiesta${brief.storia.fatti.length ? `: il cliente scrive solo «${brief.storia.fatti.join('; ')}»` : ''}. Non scrivo la storia da solo: chiedi al cliente il testo e approvalo tu.` });
  if (brief.galleria) notes.push({ kind: 'premium', text: brief.galleria.fonte, hint: `Galleria${brief.galleria.numero ? ` di ${brief.galleria.numero} foto` : ''}: le foto arrivano a parte${brief.galleria.arrivo ? ' (il cliente le manda)' : ''}. Non entra nulla nel menu senza la tua approvazione.` });
  if (brief.schedeVini) notes.push({ kind: 'premium', text: brief.schedeVini.fonte, hint: 'Schede dei vini: servono cantina, vitigno, annata e descrizione dal cliente. Jarvis non li inventa.' });
  for (const d of brief.diciture) notes.push({ kind: 'premium', text: d.fonte, hint: `Dicitura «${d.testo}»: non l’ho inserita.${d.dubbio ? ' Il cliente stesso non è sicuro che si possa dire: verifica con lui prima di pubblicarla.' : ''}` });
  if (brief.preventivo) notes.push({ kind: 'premium', text: brief.preventivo.fonte, hint: `${brief.preventivo.acconto ? 'Il cliente chiede tempi e prezzi e può versare un acconto' : 'Preventivo richiesto'}${brief.preventivo.quando ? ` (${brief.preventivo.quando})` : ''}: rispondi tu. Acconto 490 € + 39 €/mese; il totale lo decidi tu e i tempi li comunichi tu, Jarvis non li scrive.` });
  return notes;
}

/** La storia del locale come l'ha scritta il cliente («La nostra storia: …» fino alla riga vuota).
 *  Testo del cliente, parola per parola (solo gli a capo dell'email diventano spazi): niente invenzioni. */
export function storyFromSource(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^\s*(?:la\s+nostra\s+storia|la\s+storia(?:\s+del\s+locale)?|chi\s+siamo)\s*[:\-–—]/i.test(line));
  if (start < 0) return '';
  const parts = [lines[start].replace(/^\s*[^:\-–—]+[:\-–—]\s*/, '')];
  for (let i = start + 1; i < lines.length && lines[i].trim(); i += 1) parts.push(lines[i].trim());
  const story = parts.join(' ').replace(/\s+/g, ' ').trim();
  return story.length >= 20 ? (story[0].toUpperCase() + story.slice(1)).slice(0, 900) : '';
}

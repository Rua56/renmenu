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
    it: { benvenuti: 'Benvenuti', cerca: 'Cerca nel menù…', nessuno: 'Nessun piatto trovato.', info: 'Informazioni', allergeni: 'Allergeni', coperto: 'Coperto', chiama: 'Chiama', mappa: 'Mappa', oggi: 'Oggi', persona: 'a persona', powered: 'Menù digitale realizzato con', su: 'Torna su', vai: 'Vai al menù', sito: 'Sito' },
    en: { benvenuti: 'Welcome', cerca: 'Search the menu…', nessuno: 'No dishes found.', info: 'Information', allergeni: 'Allergens', coperto: 'Cover charge', chiama: 'Call', mappa: 'Map', oggi: 'Today', persona: 'per person', powered: 'Digital menu made with', su: 'Back to top', vai: 'Skip to menu', sito: 'Website' },
    de: { benvenuti: 'Willkommen', cerca: 'Speisekarte durchsuchen…', nessuno: 'Keine Gerichte gefunden.', info: 'Informationen', allergeni: 'Allergene', coperto: 'Gedeck', chiama: 'Anrufen', mappa: 'Karte', oggi: 'Heute', persona: 'pro Person', powered: 'Digitale Speisekarte erstellt mit', su: 'Nach oben', vai: 'Zur Speisekarte', sito: 'Webseite' },
    fr: { benvenuti: 'Bienvenue', cerca: 'Rechercher dans le menu…', nessuno: 'Aucun plat trouvé.', info: 'Informations', allergeni: 'Allergènes', coperto: 'Couvert', chiama: 'Appeler', mappa: 'Plan', oggi: "Aujourd'hui", persona: 'par personne', powered: 'Menu numérique réalisé avec', su: 'Haut de page', vai: 'Aller au menu', sito: 'Site' },
    es: { benvenuti: 'Bienvenidos', cerca: 'Buscar en el menú…', nessuno: 'No se encontraron platos.', info: 'Información', allergeni: 'Alérgenos', coperto: 'Cubierto', chiama: 'Llamar', mappa: 'Mapa', oggi: 'Hoy', persona: 'por persona', powered: 'Menú digital creado con', su: 'Volver arriba', vai: 'Ir al menú', sito: 'Web' },
    sl: { benvenuti: 'Dobrodošli', cerca: 'Iskanje po meniju…', nessuno: 'Ni najdenih jedi.', info: 'Informacije', allergeni: 'Alergeni', coperto: 'Pogrinjek', chiama: 'Pokliči', mappa: 'Zemljevid', oggi: 'Danes', persona: 'na osebo', powered: 'Digitalni meni izdelal', su: 'Na vrh', vai: 'Na meni', sito: 'Spletna stran' }
  };
  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV'];
  // Immagini: solo indirizzi https o file del sito (nessun altro schema).
  const safeImg = (src) => { const s = String(src || '').trim(); return /^https:\/\//i.test(s) || /^(?:\.\.\/|\/)?[A-Za-z0-9_./-]+\.(?:webp|png|jpe?g|svg|avif)$/i.test(s) ? s : ''; };

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
    body.className = `pm pm--${style.direzione}`;
    const c = style.colori;
    Object.entries({ '--pm-fondo': c.fondo, '--pm-testo': c.testo, '--pm-accento': c.accento, '--pm-accento-forte': style.accentoForte, '--pm-secondario': c.secondario, '--pm-su-secondario': style.suSecondario, '--pm-titoli': font.titoli, '--pm-corpo': font.corpo })
      .forEach(([k, v]) => body.style.setProperty(k, v));
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = style.direzione === 'bistrot' ? c.secondario : c.fondo; m.removeAttribute('media'); });

    const logo = safeImg(premium.logo), cover = safeImg(premium.copertina);
    const tel = menu.telefono ? String(menu.telefono).replace(/\s/g, '') : '';
    const ig = menu.instagram ? String(menu.instagram).replace(/^@/, '') : '';
    const fbRaw = menu.facebook ? String(menu.facebook).trim() : '';
    const fb = !fbRaw ? '' : /^https?:\/\//i.test(fbRaw) ? fbRaw : /^[A-Za-z0-9.]{3,50}$/.test(fbRaw) ? `https://www.facebook.com/${fbRaw}` : `https://www.facebook.com/search/top?q=${encodeURIComponent(fbRaw)}`;
    const site = /^https:\/\//i.test(String(menu.sito || menu.website || menu.url || '')) ? String(menu.sito || menu.website || menu.url) : '';
    let query = '';

    const price = (p) => (p ? `€ ${esc(p)}` : '');
    function voce(v) {
      const tags = (v.tag || []).map((k) => (R.tags?.[k] ? `<span class="${k === 'top' ? 'pm-tag--top' : ''}">${R.tags[k].icon} ${esc(R.tags[k][lang] || R.tags[k].it)}</span>` : '')).join('');
      const all = (v.allergeni || []).length ? `<span>${S().allergeni}${v.allergeni.map((k) => `<i>${esc(k)}</i>`).join('')}</span>` : '';
      const varianti = Array.isArray(v.prezzi) && v.prezzi.length ? `<div class="pm-varianti">${v.prezzi.map((p) => `<span>${esc(t(p.etichetta))}<b>${price(p.prezzo)}</b></span>`).join('')}</div>` : '';
      const p = !varianti && v.prezzo ? `<div class="pm-voce__prezzo">${price(v.prezzo)}${v.unita ? `<small>${esc(t(v.unita))}</small>` : ''}</div>` : '<div></div>';
      return `<article class="pm-voce"><div class="pm-voce__nome"><span>${esc(t(v.nome))}</span></div>${p}${v.descrizione && t(v.descrizione) ? `<p class="pm-voce__desc">${esc(t(v.descrizione))}</p>` : ''}${varianti}${tags || all ? `<div class="pm-voce__meta">${tags}${all}</div>` : ''}</article>`;
    }
    function sezione(s, i, voci) {
      const num = style.direzione === 'moderno' ? String(i + 1).padStart(2, '0') : ROMAN[i] || String(i + 1);
      const desc = s.descrizione && t(s.descrizione) ? `<p class="pm-sezione__desc">${esc(t(s.descrizione))}</p>` : '';
      if (s.tipo === 'degustazione') {
        const pp = s.prezzo ? `<span class="pm-degu__prezzo">${price(s.prezzo)}<small>${esc(t(s.unita) || S().persona)}</small></span>` : '';
        return `<section class="pm-sezione" id="pm-sez-${i}"><div class="pm-degu"><span class="pm-sezione__num">${num}</span><h2>${esc(t(s.nome))}</h2>${desc}${pp}<ol>${voci.map((v) => `<li><b>${esc(t(v.nome))}</b>${v.descrizione && t(v.descrizione) ? `<span>${esc(t(v.descrizione))}</span>` : ''}${v.prezzo ? `<em class="pm-degu__extra">+ ${price(v.prezzo)}</em>` : ''}</li>`).join('')}</ol></div></section>`;
      }
      const head = style.direzione === 'bistrot' ? `<div class="pm-sezione__head"><div><h2>${esc(t(s.nome))}</h2>${desc}</div><span class="pm-sezione__num">${num}</span></div>`
        : `<div class="pm-sezione__head"><span class="pm-sezione__num">${num}</span><h2>${esc(t(s.nome))}</h2>${desc}</div>`;
      return `<section class="pm-sezione" id="pm-sez-${i}">${head}<div class="pm-sezione__body"><div class="pm-voci">${voci.map(voce).join('')}</div></div></section>`;
    }

    function draw() {
      document.documentElement.lang = lang;
      document.title = `${menu.nome} — Menù`;
      const q = query.trim().toLowerCase();
      const match = (v) => !q || `${t(v.nome)} ${t(v.descrizione)}`.toLowerCase().includes(q);
      const blocks = (menu.sezioni || []).map((s, i) => ({ s, i, voci: (s.voci || []).filter(match) })).filter((b) => b.voci.length);
      const actions = [tel ? `<a class="pm-btn" href="tel:${esc(tel)}">${ICON.tel}${S().chiama}</a>` : '', menu.maps ? `<a class="pm-btn" href="${esc(menu.maps)}" target="_blank" rel="noopener">${ICON.map}${S().mappa}</a>` : '',
        ig ? `<a class="pm-btn" href="https://instagram.com/${esc(ig)}" target="_blank" rel="noopener">${ICON.ig}Instagram</a>` : '', fb ? `<a class="pm-btn" href="${esc(fb)}" target="_blank" rel="noopener">${ICON.fb}Facebook</a>` : ''].join('');
      const usedAll = new Set((menu.sezioni || []).flatMap((s) => (s.voci || []).flatMap((v) => v.allergeni || [])));
      body.innerHTML = `<a class="pm-skip" href="#pm-carta">${S().vai}</a>
      <header class="pm-bar"><div class="pm-wrap"><div class="pm-bar__row"><span class="pm-bar__name">${esc(menu.nome)}</span>${langs.length > 1 ? `<div class="pm-lang" role="group" aria-label="Lingua">${langs.map((l) => `<button type="button" data-lang="${l}" aria-pressed="${l === lang}">${l}</button>`).join('')}</div>` : ''}</div>
      <nav class="pm-nav" aria-label="Sezioni">${(menu.sezioni || []).map((s, i) => `<a href="#pm-sez-${i}" data-i="${i}">${esc(t(s.nome))}</a>`).join('')}</nav></div></header>
      <main class="pm-wrap" id="pm-carta">
        <section class="pm-hero">
          ${logo ? `<img class="pm-hero__logo" src="${esc(logo)}" alt="${esc(menu.nome)}">` : `<span class="pm-hero__eyebrow">${S().benvenuti}</span>`}
          <h1>${esc(menu.nome)}</h1>
          ${t(premium.motto) || t(menu.sottotitolo) ? `<p class="pm-hero__motto">${esc(t(premium.motto) || t(menu.sottotitolo))}</p>` : ''}
          ${menu.orari && t(menu.orari) ? `<div class="pm-hero__meta"><span>${esc(t(menu.orari))}</span></div>` : ''}
          ${actions ? `<div class="pm-hero__actions">${actions}</div>` : ''}
        </section>
        ${cover ? `<figure class="pm-cover"><img src="${esc(cover)}" alt="" loading="eager"></figure>` : ''}
        ${t(premium.storia) ? `<p class="pm-storia">${esc(t(premium.storia))}</p>` : ''}
        ${menu.avviso && t(menu.avviso) ? `<div class="pm-avviso"><b>${S().oggi}</b>${esc(t(menu.avviso)).replace(/^Oggi:\s*|^Today:\s*/i, '')}</div>` : ''}
        <div class="pm-search">${ICON.search}<input id="pm-q" type="search" placeholder="${S().cerca}" aria-label="${S().cerca}" value="${esc(query)}" autocomplete="off"></div>
        ${blocks.map((b) => sezione(b.s, b.i, b.voci)).join('') || `<p class="pm-empty">${S().nessuno}</p>`}
        <section class="pm-info"><h3>${S().info}</h3><div class="pm-info__grid">
          ${menu.indirizzo ? `<div class="pm-row">${ICON.map}<span>${esc(menu.indirizzo)}${menu.maps ? ` · <a href="${esc(menu.maps)}" target="_blank" rel="noopener">${S().mappa}</a>` : ''}</span></div>` : ''}
          ${menu.orari && t(menu.orari) ? `<div class="pm-row">${ICON.clock}<span>${esc(t(menu.orari))}</span></div>` : ''}
          ${tel ? `<div class="pm-row">${ICON.tel}<a href="tel:${esc(tel)}">${esc(menu.telefono)}</a></div>` : ''}
          ${ig ? `<div class="pm-row">${ICON.ig}<a href="https://instagram.com/${esc(ig)}" target="_blank" rel="noopener">@${esc(ig)}</a></div>` : ''}
          ${fb ? `<div class="pm-row">${ICON.fb}<a href="${esc(fb)}" target="_blank" rel="noopener">Facebook</a></div>` : ''}
          ${site ? `<div class="pm-row">${ICON.web}<a href="${esc(site)}" target="_blank" rel="noopener">${S().sito}</a></div>` : ''}
          ${menu.wifi ? `<div class="pm-row">${ICON.wifi}<span>Wi-Fi: ${esc(menu.wifi)}</span></div>` : ''}
        </div>
        ${menu.coperto ? `<p class="pm-coperto">${S().coperto}: € ${esc(menu.coperto)}</p>` : ''}
        ${usedAll.size && R.allergeni ? `<div class="pm-legenda">${[...usedAll].sort((a, b) => a - b).map((k) => (R.allergeni[k] ? `<span><b>${esc(k)}</b>${esc(R.allergeni[k][lang] || R.allergeni[k].it)}</span>` : '')).join('')}</div>` : ''}
        ${menu.note && t(menu.note) ? `<p class="pm-note">${esc(t(menu.note))}</p>` : ''}
        </section>
      </main>
      <footer class="pm-footer">${S().powered} <a href="../index.html">RenMenu</a></footer>
      <button class="pm-su" type="button" aria-label="${S().su}">${ICON.up}</button>`;
      wire();
    }

    function wire() {
      body.querySelectorAll('.pm-lang button').forEach((b) => b.addEventListener('click', () => { lang = b.dataset.lang; draw(); }));
      const input = body.querySelector('#pm-q');
      input.addEventListener('input', () => { const pos = input.selectionStart; query = input.value; draw(); const n = body.querySelector('#pm-q'); n.focus(); n.setSelectionRange(pos, pos); });
      body.querySelectorAll('.pm-nav a').forEach((a) => a.addEventListener('click', (e) => {
        e.preventDefault();
        const el = document.getElementById(a.getAttribute('href').slice(1));
        if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - (body.querySelector('.pm-bar').offsetHeight + 8), behavior: 'smooth' });
      }));
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
      bar.classList.toggle('scrolled', window.scrollY > 160);
      body.querySelector('.pm-su')?.classList.toggle('show', window.scrollY > 700);
      const secs = [...body.querySelectorAll('.pm-sezione')];
      if (!secs.length) return;
      const line = bar.offsetHeight + 24;
      let cur = secs[0];
      for (const s of secs) if (s.getBoundingClientRect().top <= line) cur = s;
      const i = cur.id.replace('pm-sez-', '');
      if (i === active) return;
      active = i;
      const links = [...body.querySelectorAll('.pm-nav a')];
      links.forEach((l) => l.setAttribute('aria-current', String(l.dataset.i === i)));
      const a = links.find((l) => l.dataset.i === i);
      if (a) a.parentElement.scrollTo({ left: a.offsetLeft - (a.parentElement.clientWidth - a.offsetWidth) / 2, behavior: 'smooth' });
    }
    window.addEventListener('scroll', () => { onScroll(); }, { passive: true });
    draw();
  }

  window.RenMenuPremium = { render, resolveStyle, contrast, DIREZIONI, CARATTERI: Object.keys(CARATTERI) };
})();

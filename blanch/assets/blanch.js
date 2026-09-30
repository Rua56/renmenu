(() => {
  'use strict';
  const ui = {
    it: {eyebrow:'QUATTRO GENERAZIONI · UNA TAVOLA',hero:'La nostra cucina,<br>la nostra storia.',lead:'Dal 1904, una cucina di famiglia che segue le stagioni e le tradizioni del Collio.',readMenu:'Sfoglia il menù <span aria-hidden="true">↗</span>',readWine:'Carta dei vini',place:'Mossa, nel cuore del Collio',inscription:'una storia da condividere',eyebrowMenu:'IN TAVOLA',menuTitle:'Il menù',menuIntro:'I piatti della nostra cucina e i vini da scoprire, con la cura di sempre.',food:'La cucina',wine:'I vini',searchLabel:'Cerca nel menù',searchPlaceholder:'Cerca un piatto o un vino…',heritageEyebrow:'LA NOSTRA STORIA',heritageTitle:'Una casa, una famiglia, una cucina.',heritageBody:'Dal 1904 la famiglia Blanch accoglie i suoi ospiti a Mossa. Quattro generazioni, piatti della tradizione e ingredienti che raccontano la stagione.',visitEyebrow:'TI ASPETTIAMO',visitTitle:'Ci vediamo a Mossa.',call:'Chiama: 0481 80020',directions:'Indicazioni ↗',closed:'Chiuso lunedì e martedì sera; mercoledì tutto il giorno.',loading:'Caricamento della carta…',empty:'Nessuna voce trovata. Prova un’altra ricerca.',failed:'Non riusciamo a caricare il menù. Riprova o chiama il ristorante.'},
    en: {eyebrow:'FOUR GENERATIONS · ONE TABLE',hero:'Our kitchen,<br>our story.',lead:'Since 1904, a family kitchen guided by the seasons and the traditions of the Collio.',readMenu:'Browse the menu <span aria-hidden="true">↗</span>',readWine:'Wine list',place:'Mossa, in the heart of the Collio',inscription:'a story to share',eyebrowMenu:'AT THE TABLE',menuTitle:'The menu',menuIntro:'Our food and wines, prepared and selected with the care we have always shared.',food:'Food',wine:'Wines',searchLabel:'Search the menu',searchPlaceholder:'Find a dish or a wine…',heritageEyebrow:'OUR STORY',heritageTitle:'A home, a family, a kitchen.',heritageBody:'The Blanch family has welcomed guests to Mossa since 1904. Four generations, traditional dishes and ingredients that reflect the season.',visitEyebrow:'VISIT US',visitTitle:'See you in Mossa.',call:'Call: +39 0481 80020',directions:'Directions ↗',closed:'Closed Monday and Tuesday evenings, and all day Wednesday.',loading:'Loading the menu…',empty:'No results. Try another search.',failed:'The menu could not be loaded. Please try again or call the restaurant.'},
    de: {eyebrow:'VIER GENERATIONEN · EIN TISCH',hero:'Unsere Küche,<br>unsere Geschichte.',lead:'Seit 1904: eine Familienküche, geprägt von den Jahreszeiten und den Traditionen des Collio.',readMenu:'Speisekarte ansehen <span aria-hidden="true">↗</span>',readWine:'Weinkarte',place:'Mossa, im Herzen des Collio',inscription:'eine Geschichte zum Teilen',eyebrowMenu:'BEI TISCH',menuTitle:'Die Speisekarte',menuIntro:'Unsere Gerichte und Weine – mit der Sorgfalt, die uns seit jeher auszeichnet.',food:'Speisen',wine:'Weine',searchLabel:'Speisekarte durchsuchen',searchPlaceholder:'Gericht oder Wein suchen…',heritageEyebrow:'UNSERE GESCHICHTE',heritageTitle:'Ein Haus, eine Familie, eine Küche.',heritageBody:'Seit 1904 begrüßt die Familie Blanch ihre Gäste in Mossa. Vier Generationen, traditionelle Gerichte und Zutaten der Saison.',visitEyebrow:'WIR FREUEN UNS AUF SIE',visitTitle:'Bis bald in Mossa.',call:'Anrufen: +39 0481 80020',directions:'Wegbeschreibung ↗',closed:'Montag- und Dienstagabend sowie mittwochs ganztägig geschlossen.',loading:'Speisekarte wird geladen…',empty:'Keine Einträge gefunden. Versuchen Sie eine andere Suche.',failed:'Die Speisekarte konnte nicht geladen werden. Bitte versuchen Sie es erneut oder rufen Sie das Restaurant an.'}
  };
  const allowedLanguages = ['it','en','de'];
  const params = new URLSearchParams(location.search);
  let language = allowedLanguages.includes(params.get('lang')) ? params.get('lang') : 'it';
  let view = params.get('view') === 'wine' ? 'wine' : 'food';
  let data = null;
  const results = document.getElementById('menu-results');
  const categories = document.getElementById('category-nav');
  const note = document.getElementById('menu-note');
  const status = document.getElementById('menu-status');
  const queryInput = document.getElementById('menu-query');
  const esc = text => String(text ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const translate = value => typeof value === 'string' ? value : (value && (value[language] || value.it || value.en || value.de)) || '';
  const normalize = text => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const sectionId = (index) => `sezione-${view}-${index}`;
  const updateUrl = () => {
    const url = new URL(location.href);
    if (language === 'it') url.searchParams.delete('lang'); else url.searchParams.set('lang', language);
    if (view === 'food') url.searchParams.delete('view'); else url.searchParams.set('view', view);
    history.replaceState(null, '', url);
  };
  function applyLanguage() {
    document.documentElement.lang = language;
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const value = ui[language][el.dataset.i18n];
      if (value !== undefined) {
        if (el.dataset.i18n === 'hero' || el.dataset.i18n === 'readMenu') el.innerHTML = value;
        else el.textContent = value;
      }
    });
    queryInput.placeholder = ui[language].searchPlaceholder;
    document.querySelectorAll('[data-lang]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.lang === language)));
    document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
    document.querySelector('.menu-switch').setAttribute('aria-label', language === 'it' ? 'Scegli la carta' : language === 'en' ? 'Choose a menu' : 'Speisekarte wählen');
    document.querySelector('.language-switch').setAttribute('aria-label', language === 'it' ? 'Seleziona lingua' : language === 'en' ? 'Choose language' : 'Sprache wählen');
    categories.setAttribute('aria-label', language === 'it' ? 'Categorie del menù' : language === 'en' ? 'Menu categories' : 'Speisekartenrubriken');
    document.title = (language === 'de' ? 'Trattoria Blanch · Speisekarte' : language === 'en' ? 'Trattoria Blanch · Menu' : 'Trattoria Blanch · Menù');
  }
  function matching(item, query) {
    if (!query) return true;
    const parts = [item.name,item.description,item.detail,item.producer,item.vintage,item.volume,item.price,...(item.variants || []).map(v => v.label)].flatMap(value => typeof value === 'object' && value !== null ? Object.values(value) : [value]);
    return normalize(parts.join(' ')).includes(query);
  }
  function itemHtml(item) {
    const desc = translate(item.description);
    const info = [translate(item.detail), item.producer, item.vintage, item.volume].filter(Boolean).join(' · ');
    const prices = String(item.price || '').split(' / ');
    const price = !item.price ? '' : prices.length === 2
      ? `<div class="menu-item__price menu-item__price--double"><span>${esc(prices[0])}</span><span>/ ${esc(prices[1].startsWith('€') ? prices[1] : '€ ' + prices[1])}</span></div>`
      : `<div class="menu-item__price">${esc(item.price)}</div>`;
    const variants = (item.variants || []).length ? `<ul class="menu-item__variants">${item.variants.map(v => `<li><span>${esc(translate(v.label))}</span><b>${esc(v.price)}</b></li>`).join('')}</ul>` : '';
    return `<article class="menu-item"><div><h4 class="menu-item__name">${esc(translate(item.name))}</h4>${desc ? `<p class="menu-item__desc">${esc(desc)}</p>` : ''}${info ? `<p class="menu-item__meta">${esc(info)}</p>` : ''}${variants}</div>${price}</article>`;
  }
  function render() {
    applyLanguage();
    updateUrl();
    if (!data) return;
    const sections = Array.isArray(data[view]) ? data[view] : [];
    const term = normalize(queryInput.value.trim());
    const filtered = sections.map((section, index) => ({section,index,items:(section.items || []).filter(item => matching(item,term))})).filter(block => block.items.length);
    categories.innerHTML = term ? '' : filtered.map(({section,index}) => `<a href="#${sectionId(index)}">${esc(translate(section.title))}</a>`).join('');
    results.innerHTML = filtered.length ? filtered.map(({section,index,items}) => `<section class="menu-section ${view === 'wine' ? 'menu-section--wine' : ''}" id="${sectionId(index)}"><div class="menu-section__head"><span class="section-number">${String(index+1).padStart(2,'0')}</span><h3>${esc(translate(section.title))}</h3>${section.caption && translate(section.caption) ? `<p class="menu-section__caption">${esc(translate(section.caption))}</p>` : ''}</div><div>${items.map(itemHtml).join('')}</div></section>`).join('') : `<p class="empty">${ui[language].empty}</p>`;
    if (status) status.textContent = `${filtered.reduce((total, group) => total + group.items.length, 0)} ${language === 'it' ? 'risultati' : language === 'de' ? 'Ergebnisse' : 'results'}`;
    const noteText = translate(data.notes && data.notes[view]);
    note.innerHTML = noteText ? `<p>${esc(noteText)}</p>` : '';
  }
  document.querySelectorAll('[data-lang]').forEach(button => button.addEventListener('click', () => { language = button.dataset.lang; render(); }));
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { view = button.dataset.view; queryInput.value = ''; render(); }));
  document.querySelectorAll('[data-action="wine"]').forEach(link => link.addEventListener('click', () => { view = 'wine'; queryInput.value = ''; render(); }));
  queryInput.addEventListener('input', render);
  fetch('data/menu.json', {cache:'no-cache'})
    .then(response => { if (!response.ok) throw new Error('menu unavailable'); return response.json(); })
    .then(json => { data = json; render(); })
    .catch(() => { results.innerHTML = `<p class="empty">${ui[language].failed}</p>`; });
  applyLanguage();
})();

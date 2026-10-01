/* Menu privato Richard — nessun invio automatico: WhatsApp apre la chat con il testo pronto. */
(() => {
  'use strict';

  const products = [
    'Fragole e panna',
    'Nutella',
    'Slonz caldo',
    'Pasta al tonno',
    'Tartufo fresco',
    'Acciughe del Cantabrico'
  ];
  const sections = [
    { id: 'collo', name: 'Collo' },
    { id: 'capezzoli', name: 'Capezzoli' },
    { id: 'pancia', name: 'Pancia' },
    { id: 'bimbin-riposo', name: 'Bimbin a riposo' },
    { id: 'bimbin-attenti', name: "Bimbin sull'attenti" },
    { id: 'piedi', name: 'Piedi' }
  ];
  const storageKey = 'renmenu-richard-cart-v1';
  const sectionById = new Map(sections.map(section => [section.id, section]));
  const makeKey = (sectionId, productIndex) => `${sectionId}:${productIndex}`;
  const validKey = key => {
    const [sectionId, index] = String(key).split(':');
    return sectionById.has(sectionId) && /^\d+$/.test(index) && Number(index) < products.length;
  };

  const optionContainers = document.querySelectorAll('[data-options]');
  optionContainers.forEach(container => {
    const sectionId = container.dataset.options;
    products.forEach((product, index) => {
      const label = document.createElement('label');
      label.className = 'product-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = makeKey(sectionId, index);
      input.name = `product-${sectionId}`;
      input.setAttribute('aria-label', `${sectionById.get(sectionId).name}: ${product}`);
      const text = document.createElement('span');
      text.textContent = product;
      label.append(input, text);
      container.append(label);
    });
  });

  let saved = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (Array.isArray(parsed)) saved = parsed.filter(validKey);
  } catch (_) { /* Modalità privata o dati precedenti non validi. */ }
  const cart = new Set(saved);
  const addButton = document.getElementById('add-to-cart');
  const status = document.getElementById('selection-status');
  const cartItems = document.getElementById('cart-items');
  const sendLink = document.getElementById('send-order');
  const inputs = [...document.querySelectorAll('.product-option input')];

  function saveCart() {
    try { localStorage.setItem(storageKey, JSON.stringify([...cart])); } catch (_) { /* Il carrello resta disponibile per questa pagina. */ }
  }

  function updateSelection() {
    const count = inputs.filter(input => input.checked).length;
    addButton.disabled = count === 0;
    if (count) status.textContent = `${count} ${count === 1 ? 'abbinamento selezionato' : 'abbinamenti selezionati'}.`;
    else if (!status.dataset.feedback) status.textContent = 'Seleziona almeno un abbinamento per iniziare.';
  }

  function orderText() {
    const lines = sections.flatMap(section => {
      const chosen = products.filter((_, index) => cart.has(makeKey(section.id, index)));
      return chosen.length ? [`*${section.name}*`, ...chosen.map(product => `• ${product}`), ''] : [];
    });
    return `Ciao Richard! Questo è il mio ordine dal menu «il corpo di Richard»:\n\n${lines.join('\n').trimEnd()}`;
  }

  function renderCart() {
    const count = cart.size;
    document.getElementById('header-count').textContent = count;
    document.getElementById('mobile-count').textContent = count;
    const badge = document.getElementById('cart-count');
    badge.textContent = String(count).padStart(2, '0');
    badge.setAttribute('aria-label', `${count} ${count === 1 ? 'abbinamento' : 'abbinamenti'}`);
    cartItems.replaceChildren();

    if (count === 0) {
      const empty = document.createElement('div');
      empty.className = 'cart-empty';
      empty.innerHTML = '<span aria-hidden="true">✳</span><p>Il carrello è ancora vuoto.</p><small>Il bello deve ancora cominciare.</small>';
      cartItems.append(empty);
      sendLink.href = '#carrello';
      sendLink.classList.add('is-disabled');
      sendLink.setAttribute('aria-disabled', 'true');
      sendLink.removeAttribute('target');
      sendLink.removeAttribute('rel');
      return;
    }

    sections.forEach(section => {
      const chosen = products.map((product, index) => ({ product, key: makeKey(section.id, index) })).filter(item => cart.has(item.key));
      if (!chosen.length) return;
      const group = document.createElement('div');
      group.className = 'cart-group';
      const heading = document.createElement('h3');
      heading.textContent = section.name;
      group.append(heading);
      chosen.forEach(item => {
        const row = document.createElement('div');
        row.className = 'cart-row';
        const name = document.createElement('span');
        name.textContent = item.product;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `Rimuovi ${item.product} da ${section.name}`);
        remove.addEventListener('click', () => {
          cart.delete(item.key);
          saveCart();
          renderCart();
        });
        row.append(name, remove);
        group.append(row);
      });
      cartItems.append(group);
    });
    sendLink.href = `https://wa.me/393515924327?text=${encodeURIComponent(orderText())}`;
    sendLink.classList.remove('is-disabled');
    sendLink.setAttribute('aria-disabled', 'false');
    sendLink.target = '_blank';
    sendLink.rel = 'noopener noreferrer';
  }

  inputs.forEach(input => input.addEventListener('change', () => {
    delete status.dataset.feedback;
    updateSelection();
  }));
  addButton.addEventListener('click', () => {
    const selected = inputs.filter(input => input.checked);
    if (!selected.length) return;
    const before = cart.size;
    selected.forEach(input => { cart.add(input.value); input.checked = false; });
    const added = cart.size - before;
    status.textContent = added ? `${added} ${added === 1 ? 'abbinamento aggiunto' : 'abbinamenti aggiunti'} al carrello.` : 'Gli abbinamenti selezionati sono già nel carrello.';
    status.dataset.feedback = 'true';
    saveCart();
    updateSelection();
    renderCart();
  });
  sendLink.addEventListener('click', event => {
    if (!cart.size) event.preventDefault();
  });

  updateSelection();
  renderCart();
})();

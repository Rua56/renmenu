import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  BLANCH_SLUG, BlanchError, blanchToMenu, canonicalBlanch, compileBlanch, exportBlanchFiles, menuToCompiled,
  publicMenuJsonUrl, publicMenuPageUrl, serializeCompiled, unsupportedFields
} from '../cloudflare/functions/_lib/blanch.js';
import { openApprovedMenuPr, readCurrentMenu } from '../cloudflare/functions/_lib/github-live.js';
import { validateMenu } from '../cloudflare/functions/_lib/menu.js';

// I file veri di Trattoria Blanch, quelli pubblicati nel sito.
const dataFile = (name) => readFileSync(new URL(`../../blanch/data/${name}`, import.meta.url), 'utf8');
const files = { food: dataFile('food.json'), wines: dataFile('wines.tsv'), menu: dataFile('menu.json') };
const base = () => blanchToMenu(compileBlanch(files.food, files.wines));
const lines = (text) => text.split('\n');
const diffLines = (a, b) => { const x = lines(a), y = lines(b); return x.length === y.length ? x.map((l, i) => (l === y[i] ? null : i)).filter((i) => i !== null).length : null; };

describe('Trattoria Blanch: lettura, scrittura e controllo', () => {
  it('la compilazione in JavaScript è identica, byte per byte, a blanch/data/menu.json (build_menu.py)', () => {
    assert.equal(serializeCompiled(compileBlanch(files.food, files.wines)), files.menu);
  });

  it('il menu in formato RenMenu supera la validazione e torna ai file originali senza cambiare un byte', () => {
    const menu = base();
    assert.equal(menu.id, BLANCH_SLUG);
    assert.deepEqual(validateMenu(menu).errors, []);
    const out = exportBlanchFiles(menu, files);
    assert.equal(out.food, files.food);
    assert.equal(out.wines, files.wines);
    assert.equal(out.menu, files.menu);
    assert.deepEqual(out.changed, { food: false, wines: false });
  });

  it('i due importi senza spiegazione restano due importi, mai uniti o inventati', () => {
    const menu = base();
    const ravioli = menu.sezioni[1].voci.find((v) => /Ravioli/.test(v.nome.it));
    assert.deepEqual(ravioli.prezzi.map((p) => [p.etichetta.it, p.prezzo]), [['Primo prezzo', '10,00'], ['Secondo prezzo', '13,00']]);
    ravioli.prezzi[1].prezzo = '14,00';
    const out = exportBlanchFiles(menu, files);
    assert.match(out.food, /"price":"€ 10,00 \/ 14,00"/);
    assert.equal(diffLines(files.food, out.food), 1);
  });

  it('cambiare un prezzo tocca una sola riga di food.json e aggiorna menu.json; il resto resta identico', () => {
    const menu = base();
    menu.sezioni[0].voci[0].prezzo = '13,00';
    const out = exportBlanchFiles(menu, files);
    assert.equal(diffLines(files.food, out.food), 1);
    assert.equal(out.wines, files.wines);
    assert.match(out.food, /"price":"€ 13,00","source":"IMG_9190"/);
    assert.equal(JSON.parse(out.menu).food[0].items[0].price, '€ 13,00');
    assert.notEqual(out.menu, files.menu);
    assert.equal(out.menu, serializeCompiled(compileBlanch(out.food, out.wines)));
  });

  it('un piatto nuovo ha EN e DE (ripiego sull’italiano, mai inventati) e la fonte «Jarvis»', () => {
    const menu = base();
    menu.sezioni[0].voci.push({ nome: { it: 'Tagliere speciale', en: 'Special board' }, prezzo: '15,00' });
    const out = exportBlanchFiles(menu, files);
    assert.match(out.food, /\{"name":\{"it":"Tagliere speciale","en":"Special board","de":"Tagliere speciale"\},"price":"€ 15,00","source":"Jarvis"\}/);
    const added = JSON.parse(out.menu).food[0].items.at(-1);
    assert.equal(added.name.de, 'Tagliere speciale');
    assert.equal(added.source, undefined, 'la fonte interna non va nel menu pubblico');
  });

  it('rinominare un piatto ne conserva la fonte; toglierne un altro cancella solo la sua riga', () => {
    const renamed = base();
    renamed.sezioni[0].voci[0].nome = { it: 'Prosciutto San Daniele riserva', en: 'Reserve ham', de: 'Reserveschinken' };
    const out = exportBlanchFiles(renamed, files);
    assert.match(out.food, /Prosciutto San Daniele riserva[^\n]*"source":"IMG_9190"/);
    assert.equal(diffLines(files.food, out.food), 1);
    const removed = base();
    removed.sezioni[0].voci.splice(1, 1);
    const out2 = exportBlanchFiles(removed, files);
    assert.doesNotMatch(out2.food, /Salame nostrano/);
    assert.equal(lines(out2.food).length, lines(files.food).length - 1);
  });

  it('i vini: prezzo cambiato, vino nuovo e vino tolto; l’ordine del file e le altre righe non cambiano', () => {
    const menu = base();
    const bianchi = menu.sezioni.find((s) => s.nome.it === 'Vini bianchi');
    const first = bianchi.voci[0];
    first.prezzo = '27,00';
    bianchi.voci.push({ nome: 'Chardonnay', descrizione: 'Nuova Cantina · Cormons Loc. Test', prezzo: '28,00' });
    const out = exportBlanchFiles(menu, files);
    assert.equal(out.food, files.food);
    assert.equal(lines(out.wines).length, lines(files.wines).length + 1);
    assert.match(out.wines, /Vini Bianchi\tBorgo Trevisan\tGradisca d’Isonzo\tMalvasia\t\t27,00\tIMG_9197/);
    assert.match(out.wines, /Vini Bianchi\tNuova Cantina\tCormons Loc. Test\tChardonnay\t\t28,00\tJarvis/);
    assert.equal(out.wines.split('\n').slice(0, 3).join('\n').includes('27,00'), true);
    const removed = base();
    removed.sezioni.find((s) => s.nome.it === 'Vini rossi').voci.splice(0, 1);
    const out2 = exportBlanchFiles(removed, files);
    assert.equal(lines(out2.wines).length, lines(files.wines).length - 1);
  });

  it('ciò che il formato Blanch non può contenere blocca l’esportazione con un messaggio chiaro', () => {
    for (const mutate of [
      (m) => { m.sezioni[0].voci[0].allergeni = ['1']; },
      (m) => { m.telefono = '0481 80020'; },
      (m) => { m.sezioni[0].voci[0].tag = ['veg']; },
      (m) => { m.coperto = '3'; }
    ]) {
      const menu = base();
      mutate(menu);
      assert.ok(unsupportedFields(menu).length);
      assert.throws(() => exportBlanchFiles(menu, files), (e) => e instanceof BlanchError && /non può contenere/.test(e.message));
    }
    const notes = base();
    notes.avviso.it = 'Coperto 5 €.';
    assert.throws(() => exportBlanchFiles(notes, files), /Gli avvisi su coperto e allergie/);
  });

  it('non pubblica se il menu compilato online non coincide con le sorgenti', () => {
    assert.throws(() => exportBlanchFiles(base(), { ...files, menu: `${files.menu} ` }), /non coincide con food\.json e wines\.tsv/);
  });

  it('confronto semantico: bozza, PR e menu online si confrontano nella sola forma che Blanch può rappresentare', () => {
    const draft = base();
    draft.sezioni.find((s) => s.nome.it === 'Vini bianchi').voci[0].nome = { it: 'Malvasia', en: 'Malvasia' };
    assert.deepEqual(canonicalBlanch(draft), canonicalBlanch(base()));
    assert.equal(menuToCompiled(base()).food.length, 8);
  });

  it('indirizzi pubblici: /blanch/ e il suo menu compilato, mai menu/?m=', () => {
    assert.equal(publicMenuPageUrl('https://renmenu.pages.dev', BLANCH_SLUG), 'https://renmenu.pages.dev/blanch/');
    assert.equal(publicMenuJsonUrl('https://renmenu.pages.dev', BLANCH_SLUG), 'https://renmenu.pages.dev/blanch/data/menu.json');
    assert.equal(publicMenuPageUrl('https://renmenu.pages.dev', 'altro-locale'), 'https://renmenu.pages.dev/menu/?m=altro-locale');
  });
});

// ——— Adattatore GitHub (finto): lettura dei tre file, PR con le sole righe cambiate ———
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const PATHS = { 'blanch/data/food.json': 'food', 'blanch/data/wines.tsv': 'wines', 'blanch/data/menu.json': 'menu' };

function fakeGithub(initial = files) {
  const branches = new Map();
  const calls = [];
  const blob = (key, ref) => ({ type: 'file', sha: `sha-${key}-${ref === 'main' || ref === 'base-sha' ? 'base' : 'branch'}`, content: b64((branches.get(ref) || initial)[key]) });
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    calls.push({ method, path: url.pathname, body: init.body ? JSON.parse(init.body) : null });
    if (url.pathname.endsWith('/git/ref/heads/main')) return json({ object: { sha: 'base-sha' } });
    if (url.pathname.includes('/git/ref/heads/control-room/')) return branches.has(decodeURIComponent(url.pathname.split('/heads/')[1])) ? json({ object: { sha: 'base-sha' } }) : json({ message: 'Not Found' }, 404);
    if (url.pathname.endsWith('/git/refs') && method === 'POST') { branches.set(JSON.parse(init.body).ref.replace('refs/heads/', ''), { ...initial }); return json({}, 201); }
    const m = /\/contents\/(blanch\/data\/[a-z.]+)$/.exec(url.pathname);
    if (m && method === 'GET') return json(blob(PATHS[m[1]], url.searchParams.get('ref')));
    if (m && method === 'PUT') {
      const body = JSON.parse(init.body);
      assert.equal(body.sha, `sha-${PATHS[m[1]]}-base`, 'ogni file si aggiorna con il suo SHA di base');
      branches.get(body.branch)[PATHS[m[1]]] = Buffer.from(body.content, 'base64').toString('utf8');
      return json({ content: { sha: 'new' } }, 200);
    }
    if (url.pathname.endsWith('/pulls') && method === 'GET') return json([]);
    if (url.pathname.endsWith('/pulls') && method === 'POST') return json({ number: 9, state: 'open', draft: false, merged_at: null, html_url: 'https://github.example/pull/9', head: { ref: JSON.parse(init.body).head, sha: 'head' }, base: { ref: 'main', sha: 'base-sha' } }, 201);
    throw new Error(`Chiamata inattesa: ${method} ${url}`);
  };
  return { fetch, calls, branches };
}

describe('Trattoria Blanch: GitHub (finto)', () => {
  it('legge i tre file e restituisce il menu RenMenu con una firma unica dei tre', async () => {
    const remote = fakeGithub();
    const read = await readCurrentMenu({ GITHUB_TOKEN: 't', fetch: remote.fetch }, BLANCH_SLUG, { ref: 'main' });
    assert.equal(read.exists, true);
    assert.equal(read.menu.id, BLANCH_SLUG);
    assert.match(read.sha, /^[a-f0-9]{40}$/);
    assert.equal(read.filePath, 'blanch/data/food.json');
  });

  it('apre una PR che scrive solo i file cambiati, mai menus/ e mai il QR', async () => {
    const remote = fakeGithub();
    const env = { GITHUB_TOKEN: 't', fetch: remote.fetch };
    const current = await readCurrentMenu(env, BLANCH_SLUG, { ref: 'main' });
    const menu = structuredClone(current.menu);
    menu.sezioni[0].voci[0].prezzo = '13,00';
    const result = await openApprovedMenuPr(env, { slug: BLANCH_SLUG, menu, requestKind: 'aggiornamento', expectedBaseSha: 'base-sha', expectedFileSha: current.sha, idempotencyKey: 'op-blanch-1' });
    assert.equal(result.pr.number, 9);
    const puts = remote.calls.filter((c) => c.method === 'PUT').map((c) => c.path.split('/contents/')[1]);
    assert.deepEqual(puts.sort(), ['blanch/data/food.json', 'blanch/data/menu.json']);
    assert.equal(remote.calls.some((c) => /menus\/|qr\//.test(c.path)), false);
    const branch = [...remote.branches.values()][0];
    assert.match(branch.food, /"price":"€ 13,00","source":"IMG_9190"/);
    assert.equal(branch.menu, serializeCompiled(compileBlanch(branch.food, branch.wines)));
  });

  it('rifiuta la PR se la bozza contiene campi che Blanch non può avere, prima di scrivere su GitHub', async () => {
    const remote = fakeGithub();
    const env = { GITHUB_TOKEN: 't', fetch: remote.fetch };
    const current = await readCurrentMenu(env, BLANCH_SLUG, { ref: 'main' });
    const menu = structuredClone(current.menu);
    menu.telefono = '0481 80020';
    await assert.rejects(() => openApprovedMenuPr(env, { slug: BLANCH_SLUG, menu, requestKind: 'aggiornamento', expectedBaseSha: 'base-sha', expectedFileSha: current.sha, idempotencyKey: 'op-blanch-2' }), (e) => e.code === 'LEGACY_FORMAT');
    assert.equal(remote.calls.some((c) => c.method === 'PUT' || (c.method === 'POST')), false);
  });
});

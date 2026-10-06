import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GitHubLiveError,
  MANUAL_MERGE_CONFIRMATION,
  getPrStatus,
  inspectApprovedMenu,
  mergeApprovedMenuPr,
  openApprovedMenuPr,
  readCurrentMenu
} from '../cloudflare/functions/_lib/github-live.js';

const token = 'test-token-never-a-real-secret';
const baseSha = 'main-commit-a';
const fileSha = 'menu-blob-a';

const menu = (price = '9,00') => ({
  id: 'trattoria-test',
  nome: { it: 'Trattoria di prova' },
  lingue: ['it'],
  sezioni: [{ nome: { it: 'Piatti' }, voci: [{ nome: { it: 'Pasta di prova' }, prezzo: price, allergeni: ['1'] }] }]
});

const file = (value, sha = fileSha) => ({
  type: 'file',
  sha,
  content: Buffer.from(JSON.stringify(value)).toString('base64')
});

const json = (value, status = 200, headers = {}) => new Response(value === null ? null : JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json', ...headers }
});

function fakeFetch(handler) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init, calls);
  };
  return { fetch, calls };
}

function env(fetch) {
  return { GITHUB_TOKEN: token, fetch };
}

function approved(overrides = {}) {
  return {
    slug: 'trattoria-test',
    menu: menu('10,00'),
    requestKind: 'aggiornamento',
    expectedBaseSha: baseSha,
    expectedFileSha: fileSha,
    idempotencyKey: 'operation-test-001',
    ...overrides
  };
}

function pr(number = 17, branch = 'control-room/menu-trattoria-test-retry') {
  return {
    number,
    state: 'open',
    draft: false,
    merged_at: null,
    html_url: `https://github.example/Rua56/renmenu/pull/${number}`,
    head: { ref: branch, sha: 'head-commit-a' },
    base: { ref: 'main', sha: baseSha }
  };
}

async function rejectsCode(run, code) {
  await assert.rejects(run, (error) => error instanceof GitHubLiveError && error.code === code);
}

describe('GitHub live adapter (fake fetch only)', () => {
  it('un menu nuovo (file assente su main) supera l’ispezione; uno esistente deve avere lo stesso id', () => {
    const menu = { id: 'agriturismo-prova', nome: 'Agriturismo prova', lingue: ['it'], sezioni: [{ nome: { it: 'Primi' }, voci: [{ nome: { it: 'Gnocchi' }, prezzo: '10,00', allergeni: ['1'] }] }] };
    const fresh = inspectApprovedMenu({ slug: 'agriturismo-prova', menu, requestKind: 'nuovo', currentMenu: { exists: false } });
    assert.equal(fresh.mode, 'new');
    assert.throws(() => inspectApprovedMenu({ slug: 'agriturismo-prova', menu, requestKind: 'aggiornamento', currentMenu: { exists: true, menu: { ...menu, id: 'altro' }, sha: 'x' } }),
      (error) => error.code === 'CURRENT_SLUG_MISMATCH');
  });

  it('distingue un menu mancante 404 da un errore GitHub e conserva lo SHA quando esiste', async () => {
    const missing = fakeFetch((url, init) => {
      assert.equal(url.pathname, '/repos/Rua56/renmenu/contents/menus/trattoria-test.json');
      assert.equal(url.searchParams.get('ref'), 'main');
      assert.equal(init.headers.Authorization, `Bearer ${token}`);
      assert.equal(init.headers['User-Agent'], 'RenMenu-Jarvis-Control-Room', 'GitHub rifiuta le API senza User-Agent');
      return json({ message: 'Not Found' }, 404);
    });
    const result = await readCurrentMenu(env(missing.fetch), 'trattoria-test');
    assert.deepEqual(result, {
      exists: false,
      status: 404,
      slug: 'trattoria-test',
      filePath: 'menus/trattoria-test.json',
      menu: null,
      sha: null,
      ref: 'main'
    });

    const broken = fakeFetch(() => json({ message: 'server error' }, 500));
    await rejectsCode(() => readCurrentMenu(env(broken.fetch), 'trattoria-test'), 'GITHUB_API_ERROR');
  });

  it('ispeziona JSON, mantiene lo slug e calcola il diff pubblico', () => {
    const before = menu('9,00');
    const prepared = inspectApprovedMenu({
      slug: 'trattoria-test',
      requestKind: 'aggiornamento',
      menu: menu('10,00'),
      currentMenu: { exists: true, menu: before, sha: fileSha }
    });
    assert.equal(prepared.menu.id, 'trattoria-test');
    assert.equal(prepared.currentSha, fileSha);
    assert.deepEqual(prepared.changes, [{ type: 'prezzo', name: 'Piatti / Pasta di prova', before: '9,00', after: '10,00' }]);
    assert.match(prepared.prBody, /menu\/\?m=trattoria-test/);
    assert.doesNotMatch(prepared.prBody, /test-token|operation-test/i);

    assert.throws(() => inspectApprovedMenu({
      slug: 'trattoria-test', requestKind: 'nuovo', menu: menu(), currentMenu: { exists: true, menu: before, sha: fileSha }
    }), (error) => error.code === 'SLUG_EXISTS');
    assert.throws(() => inspectApprovedMenu({ slug: 'trattoria-test', requestKind: 'nuovo', menu: { ...menu(), id: 'other' } }),
      (error) => error.code === 'SLUG_MISMATCH');
  });

  it('crea branch dalla base approvata, scrive esclusivamente sul branch e apre una PR senza auto-merge', async () => {
    const remoteMenu = menu('9,00');
    let writeBody;
    let prBody;
    const remote = fakeFetch((url, init) => {
      if (url.pathname.endsWith('/pulls') && init.method === 'GET') return json([]);
      if (url.pathname.endsWith('/git/ref/heads/main')) return json({ object: { sha: baseSha } });
      if (url.pathname.endsWith('/contents/menus/trattoria-test.json') && init.method === 'GET') {
        assert.equal(url.searchParams.get('ref'), baseSha);
        return json(file(remoteMenu));
      }
      if (url.pathname.includes('/git/ref/heads/control-room/menu-trattoria-test-')) return json({ message: 'Not Found' }, 404);
      if (url.pathname.endsWith('/git/refs') && init.method === 'POST') {
        const body = JSON.parse(init.body);
        assert.equal(body.sha, baseSha);
        assert.match(body.ref, /^refs\/heads\/control-room\/menu-trattoria-test-/);
        return json({ ref: body.ref, object: { sha: baseSha } }, 201);
      }
      if (url.pathname.endsWith('/contents/menus/trattoria-test.json') && init.method === 'PUT') {
        writeBody = JSON.parse(init.body);
        assert.equal(writeBody.sha, fileSha);
        assert.match(writeBody.branch, /^control-room\/menu-trattoria-test-/);
        return json({ content: { sha: 'new-file-sha' }, commit: { sha: 'write-commit' } }, 200);
      }
      if (url.pathname.endsWith('/pulls') && init.method === 'POST') {
        prBody = JSON.parse(init.body);
        assert.equal(prBody.base, 'main');
        assert.equal(prBody.draft, false, "PR pronta: il merge resta separato e con frase");
        assert.doesNotMatch(prBody.body, /token|operation|request|private/i);
        return json(pr(17, prBody.head), 201);
      }
      throw new Error(`Chiamata inattesa: ${init.method} ${url}`);
    });

    const result = await openApprovedMenuPr(env(remote.fetch), approved());
    assert.equal(result.wrote, true);
    assert.equal(result.reused, false);
    assert.equal(result.pr.number, 17);
    assert.equal(writeBody.branch, prBody.head);
    assert.equal(remote.calls.some(({ url }) => url.pathname.endsWith('/merge')), false);
    assert.equal(remote.calls.every(({ url }) => url.hostname === 'api.github.com'), true);
  });

  it('rifiuta un nuovo locale se lo slug esiste, prima di creare ref o scrivere file', async () => {
    const remote = fakeFetch((url, init) => {
      if (url.pathname.endsWith('/pulls') && init.method === 'GET') return json([]);
      if (url.pathname.endsWith('/git/ref/heads/main')) return json({ object: { sha: baseSha } });
      if (url.pathname.endsWith('/contents/menus/trattoria-test.json')) return json(file(menu('9,00')));
      throw new Error(`Non avrebbe dovuto mutare GitHub: ${init.method} ${url}`);
    });
    await rejectsCode(() => openApprovedMenuPr(env(remote.fetch), approved({
      requestKind: 'nuovo',
      expectedFileSha: undefined,
      idempotencyKey: 'operation-new-collision'
    })), 'SLUG_EXISTS');
    assert.equal(remote.calls.some(({ init }) => init.method === 'POST' || init.method === 'PUT'), false);
  });

  it('recupera un branch gia scritto e una PR del medesimo operation key senza doppie scritture', async () => {
    const candidate = menu('10,00');
    let branch;
    let pullListCalls = 0;
    const remote = fakeFetch((url, init) => {
      if (url.pathname.endsWith('/pulls') && init.method === 'GET') {
        pullListCalls += 1;
        return json(pullListCalls === 1 ? [] : [pr(33, branch)]);
      }
      if (url.pathname.endsWith('/git/ref/heads/main')) return json({ object: { sha: baseSha } });
      if (url.pathname.endsWith('/contents/menus/trattoria-test.json') && init.method === 'GET' && url.searchParams.get('ref') === baseSha) return json(file(menu('9,00')));
      if (url.pathname.includes('/git/ref/heads/control-room/menu-trattoria-test-')) {
        branch = decodeURIComponent(url.pathname.split('/heads/')[1]);
        return json({ object: { sha: 'write-commit-after-base' } });
      }
      if (url.pathname.endsWith('/contents/menus/trattoria-test.json') && init.method === 'GET' && url.searchParams.get('ref') === branch) return json(file(candidate, 'new-file-sha'));
      if (url.pathname.endsWith('/pulls') && init.method === 'POST') {
        const body = JSON.parse(init.body);
        branch = body.head;
        return json(pr(33, branch), 201);
      }
      throw new Error(`Chiamata inattesa: ${init.method} ${url}`);
    });

    const first = await openApprovedMenuPr(env(remote.fetch), approved());
    assert.equal(first.wrote, false);
    assert.equal(first.reused, true);
    assert.equal(first.pr.number, 33);
    const callsAfterFirst = remote.calls.length;
    const second = await openApprovedMenuPr(env(remote.fetch), approved());
    assert.equal(second.reused, true);
    assert.equal(second.pr.number, 33);
    assert.equal(remote.calls.length, callsAfterFirst + 2, 'il retry con PR esistente verifica la PR e il suo file di branch');
    assert.equal(remote.calls.filter(({ init }) => init.method === 'PUT').length, 0);
  });

  it('gestisce limiti GitHub e conflitti SHA senza nascondere un errore come retry riuscito', async () => {
    const rateLimited = fakeFetch(() => json({ message: 'API rate limit exceeded' }, 429, { 'Retry-After': '17' }));
    await assert.rejects(() => readCurrentMenu(env(rateLimited.fetch), 'trattoria-test'), (error) =>
      error.code === 'GITHUB_RATE_LIMITED' && error.retryAfter === 17 && !String(error.message).includes(token));

    const stale = fakeFetch((url, init) => {
      if (url.pathname.endsWith('/pulls') && init.method === 'GET') return json([]);
      if (url.pathname.endsWith('/git/ref/heads/main')) return json({ object: { sha: 'new-main-commit' } });
      throw new Error(`Chiamata inattesa: ${init.method} ${url}`);
    });
    await rejectsCode(() => openApprovedMenuPr(env(stale.fetch), approved({ idempotencyKey: 'operation-stale-sha' })), 'BASE_SHA_CONFLICT');
    assert.equal(stale.calls.some(({ init }) => init.method === 'POST' || init.method === 'PUT'), false);
  });

  it('espone stato PR e permette merge solo con conferma, revisione e SHA espliciti', async () => {
    const neverFetch = async () => { throw new Error('non deve essere chiamato'); };
    await rejectsCode(() => mergeApprovedMenuPr(env(neverFetch), { prNumber: 51, approvedRevision: 2, expectedHeadSha: 'head-1', expectedBaseSha: baseSha }),
      'MERGE_CONFIRMATION_REQUIRED');

    const remote = fakeFetch((url, init) => {
      if (url.pathname.endsWith('/pulls/51') && init.method === 'GET') return json(pr(51, 'control-room/menu-trattoria-test-safe'));
      if (url.pathname.endsWith('/pulls/51/merge') && init.method === 'PUT') {
        assert.deepEqual(JSON.parse(init.body), {
          sha: 'head-commit-a', merge_method: 'squash', commit_title: 'Merge approved menu PR #51'
        });
        return json({ merged: true, sha: 'merge-commit-a' });
      }
      throw new Error(`Chiamata inattesa: ${init.method} ${url}`);
    });
    const status = await getPrStatus(env(remote.fetch), 51);
    assert.equal(status.headRef, 'control-room/menu-trattoria-test-safe');
    const merged = await mergeApprovedMenuPr(env(remote.fetch), {
      prNumber: 51,
      confirmation: MANUAL_MERGE_CONFIRMATION,
      approvedRevision: 2,
      expectedHeadSha: 'head-commit-a',
      expectedBaseSha: baseSha
    });
    assert.deepEqual(merged, { merged: true, prNumber: 51, revision: 2, sha: 'merge-commit-a' });
  });
});

import { menuMediaFiles } from '../cloudflare/functions/_lib/github-live.js';
describe('Fase 2c: foto del menu Premium nella stessa PR', () => {
  const sha = 'a'.repeat(64);
  const url = `https://renmenu-jarvis-stage.pages.dev/jarvis-hook/media/${sha}.jpg`;
  it('trova solo le foto servite dallo staging di Jarvis, una volta sola', () => {
    const m = { ...menu(), premium: { logo: url, galleria: [{ src: url }, { src: 'https://esempio.it/x.jpg' }] } };
    assert.deepEqual(menuMediaFiles(m), [{ sha, ext: 'jpg', path: `menus/media/${sha}.jpg` }]);
  });
  it('scrive la foto sul branch della PR (mai su main) e non la riscrive se c’è già', async () => {
    const puts = [];
    let mediaExists = false;
    const remote = fakeFetch((u, init) => {
      if (u.pathname.endsWith('/pulls') && init.method === 'GET') return json([]);
      if (u.pathname.endsWith('/git/ref/heads/main')) return json({ object: { sha: baseSha } });
      if (u.pathname.endsWith('/contents/menus/trattoria-test.json') && init.method === 'GET') return json(file(menu('9,00')));
      if (u.pathname.includes('/git/ref/heads/control-room/menu-trattoria-test-')) return json({ message: 'Not Found' }, 404);
      if (u.pathname.endsWith('/git/refs') && init.method === 'POST') return json({ ref: JSON.parse(init.body).ref, object: { sha: baseSha } }, 201);
      if (u.pathname.endsWith('/contents/menus/trattoria-test.json') && init.method === 'PUT') return json({ content: { sha: 'n' } }, 200);
      if (u.pathname.endsWith(`/contents/menus/media/${sha}.jpg`)) {
        if (init.method === 'PUT') { puts.push(JSON.parse(init.body)); mediaExists = true; return json({ content: { sha: 'm' } }, 201); }
        return mediaExists ? json({ sha: 'm' }) : json({ message: 'Not Found' }, 404);
      }
      if (u.pathname.endsWith('/pulls') && init.method === 'POST') return json({ number: 18, html_url: 'https://github.com/Rua56/renmenu/pull/18', head: { ref: JSON.parse(init.body).head, sha: 'h' }, base: { ref: 'main' }, state: 'open', draft: false }, 201);
      throw new Error(`Chiamata inattesa: ${init.method} ${u}`);
    });
    await openApprovedMenuPr(env(remote.fetch), approved({ menu: { ...menu('10,00'), premium: { logo: url } }, media: [{ path: `menus/media/${sha}.jpg`, base64: 'AAEC' }] }));
    assert.equal(puts.length, 1);
    assert.match(puts[0].branch, /^control-room\/menu-trattoria-test-/);
    assert.equal(puts[0].content, 'AAEC');
  });
  it('rifiuta percorsi che non sono foto del menu', async () => {
    const remote = fakeFetch((u, init) => {
      if (u.pathname.endsWith('/pulls') && init.method === 'GET') return json([]);
      if (u.pathname.endsWith('/git/ref/heads/main')) return json({ object: { sha: baseSha } });
      if (u.pathname.endsWith('/contents/menus/trattoria-test.json') && init.method === 'GET') return json(file(menu('9,00')));
      if (u.pathname.includes('/git/ref/heads/control-room/menu-trattoria-test-')) return json({ message: 'Not Found' }, 404);
      if (u.pathname.endsWith('/git/refs') && init.method === 'POST') return json({ ref: JSON.parse(init.body).ref, object: { sha: baseSha } }, 201);
      if (init.method === 'PUT' || init.method === 'POST') throw new Error('Nessuna scrittura prima del controllo delle foto');
      throw new Error(`Non avrebbe dovuto scrivere: ${init.method} ${u}`);
    });
    await assert.rejects(() => openApprovedMenuPr(env(remote.fetch), approved({ media: [{ path: 'index.html', base64: 'AAEC' }] })), (e) => e.code === 'INVALID_MEDIA');
  });
});

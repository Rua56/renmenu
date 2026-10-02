import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { integrations } from '../cloudflare/functions/_lib/integrations.js';

describe('integrations (fase A)', () => {
  it('con GitHub live il Builder resta locale; gli altri provider live restano bloccati', () => {
    const live = integrations({ GITHUB_PROVIDER: 'live' });
    assert.equal(live.ai.mode, 'mock');
    assert.ok(live.ai.extract('Prova', 'Primi\nGnocchi — 10', 'prova').menu.sezioni.length === 1);
    assert.throws(() => live.github.merge(), /non implementata/);
    assert.throws(() => integrations({ GITHUB_PROVIDER: 'altro' }), /GitHub/);
    assert.throws(() => integrations({ WHATSAPP_PROVIDER: 'live' }), /WhatsApp/);
  });
});

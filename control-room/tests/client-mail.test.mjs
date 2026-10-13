import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clientMailConfig, sendClientMail } from '../cloudflare/functions/_lib/client-mail.js';

const env = { CLIENT_MAIL_FROM: 'RenMenu <menu@renmenu.com>', EMAIL_LIVE_ENABLED: 'true', RESEND_API_KEY: 're_test_123456' };

describe('invio diretto ai locali', () => {
  it('si attiva solo con mittente su renmenu.com, chiave e invii abilitati', () => {
    assert.equal(clientMailConfig({}).reason, 'CLIENT_MAIL_OFF');
    assert.equal(clientMailConfig({ ...env, EMAIL_LIVE_ENABLED: 'false' }).reason, 'EMAIL_LIVE_DISABLED');
    assert.equal(clientMailConfig({ ...env, CLIENT_MAIL_FROM: 'onboarding@resend.dev' }).reason, 'INVALID_CLIENT_MAIL_FROM');
    assert.equal(clientMailConfig({ ...env, RESEND_API_KEY: '' }).reason, 'MISSING_RESEND_API_KEY');
    assert.equal(clientMailConfig(env).sender, 'menu@renmenu.com');
  });
  it('rifiuta destinatari non validi o del nostro dominio, senza chiamare Resend', async () => {
    let called = 0;
    const fetchImpl = async () => { called += 1; return Response.json({ id: 'x' }); };
    for (const to of ['', 'non-email', 'menu@renmenu.com', 'a@b.com\r\nBcc: x@y.z']) {
      const out = await sendClientMail({ env, to, subject: 'Ciao', text: 'Testo', idempotencyKey: 'k', fetchImpl });
      assert.equal(out.ok, false, to);
    }
    assert.equal((await sendClientMail({ env, to: 'locale@example.com', subject: 'a\nb', text: 'x', idempotencyKey: 'k', fetchImpl })).reason, 'INVALID_SUBJECT');
    assert.equal(called, 0);
  });
  it('distingue errori temporanei (si riprova) dai rifiuti', async () => {
    const reply = (status, body) => async () => Response.json(body, { status });
    assert.deepEqual(await sendClientMail({ env, to: 'locale@example.com', subject: 'S', text: 'T', idempotencyKey: 'k', fetchImpl: reply(200, { id: 'abc' }) }), { ok: true, id: 'abc' });
    assert.equal((await sendClientMail({ env, to: 'locale@example.com', subject: 'S', text: 'T', idempotencyKey: 'k', fetchImpl: reply(503, {}) })).retryable, true);
    const refused = await sendClientMail({ env, to: 'locale@example.com', subject: 'S', text: 'T', idempotencyKey: 'k', fetchImpl: reply(403, { message: 'The renmenu.com domain is not verified' }) });
    assert.equal(refused.retryable, false);
    assert.match(refused.reason, /^RESEND_403 The renmenu\.com domain is not verified/);
    assert.equal((await sendClientMail({ env, to: 'locale@example.com', subject: 'S', text: 'T', idempotencyKey: 'k', fetchImpl: async () => { throw new Error('down'); } })).reason, 'PROVIDER_UNAVAILABLE');
  });
});

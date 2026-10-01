import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { verifyOwner, isSameOriginWrite } from '../cloudflare/functions/_lib/auth.js';
import { onRequest as middleware } from '../cloudflare/functions/_middleware.js';

const domain = 'https://team-di-test.cloudflareaccess.com';
const env = { TEAM_DOMAIN: domain, POLICY_AUD: 'solo-app-control-room', OWNER_EMAIL: 'owner@example.test' };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'test-control-room', use: 'sig', alg: 'RS256' };
const jwks = async (url) => {
  assert.equal(url, `${domain}/cdn-cgi/access/certs`);
  return Response.json({ keys: [jwk] });
};
const claims = (more = {}) => ({ iss: domain, aud: [env.POLICY_AUD], email: env.OWNER_EMAIL, type: 'app', exp: Math.floor(Date.now() / 1000) + 300, nbf: Math.floor(Date.now() / 1000) - 20, ...more });
async function token(payload = claims()) {
  const head = encode({ alg: 'RS256', kid: jwk.kid });
  const body = encode(payload);
  const bytes = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(bytes).toString('base64url')}`;
}
const request = (jwt, url = 'https://renmenu.pages.dev/control-room/') => new Request(url, { headers: jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {} });

describe('Cloudflare Access owner-only', () => {
  it('accetta soltanto firma verificata, AUD, iss, type app ed email del proprietario', async () => {
    assert.equal(await verifyOwner(request(await token()), env, jwks), true);
    assert.equal(await verifyOwner(request(await token(claims({ email: 'altro@example.test' }))), env, jwks), false);
    assert.equal(await verifyOwner(request(await token(claims({ aud: ['un-altra-app'] }))), env, jwks), false);
    assert.equal(await verifyOwner(request(await token(claims({ iss: 'https://altro.cloudflareaccess.com' }))), env, jwks), false);
    assert.equal(await verifyOwner(request(await token(claims({ type: 'org' }))), env, jwks), false);
    assert.equal(await verifyOwner(request(await token(claims({ exp: Math.floor(Date.now() / 1000) - 1 }))), env, jwks), false);
  });
  it('rifiuta header falsificato, token mancante e configurazione assente', async () => {
    const signed = await token();
    const [a, b, c] = signed.split('.');
    assert.equal(await verifyOwner(request(`${a}.${encode({ ...claims(), email: 'intruso@example.test' })}.${c}`), env, jwks), false);
    assert.equal(await verifyOwner(request(), env, jwks), false);
    assert.equal(await verifyOwner(request(signed), { ...env, POLICY_AUD: '' }, jwks), false);
  });
  it('nega asset statici e API senza accesso ma non intercetta il sito pubblico esistente', async () => {
    for (const path of ['/control-room/', '/control-room/styles.css', '/control-room/api/state']) {
      let called = false;
      const response = await middleware({ request: request('', `https://renmenu.pages.dev${path}`), env, next: () => { called = true; return new Response('PUBLIC'); } });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('cache-control').includes('no-store'), true);
      assert.equal(called, false);
    }
    const publicResponse = await middleware({ request: request('', 'https://renmenu.pages.dev/menu/?m=demo'), env, next: () => new Response('PUBLIC') });
    assert.equal(await publicResponse.text(), 'PUBLIC');
  });
  it('richiede origine corrispondente per le scritture (CSRF)', () => {
    assert.equal(isSameOriginWrite(new Request('https://renmenu.pages.dev/control-room/api/actions', { headers: { origin: 'https://renmenu.pages.dev', 'Sec-Fetch-Site': 'same-origin' } })), true);
    assert.equal(isSameOriginWrite(new Request('https://renmenu.pages.dev/control-room/api/actions', { headers: { origin: 'https://malicious.example', 'Sec-Fetch-Site': 'cross-site' } })), false);
  });
});

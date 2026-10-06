import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal, isSealed, readSealedSetting } from '../cloudflare/functions/_lib/sealed.js';

describe('Chiavi cifrate nel database', () => {
  const env = { SETTINGS_SECRET: 'segreto-di-prova-abbastanza-lungo' };
  it('cifra e decifra, mai in chiaro', async () => {
    const stored = await seal(env, 'sk_chiave_di_prova_123456');
    assert.ok(isSealed(stored));
    assert.doesNotMatch(stored, /sk_chiave/);
    assert.equal(await unseal(env, stored), 'sk_chiave_di_prova_123456');
    assert.equal(await unseal({ SETTINGS_SECRET: 'altro' }, stored), '', 'segreto sbagliato: nessuna chiave');
  });
  it('una chiave vecchia in chiaro viene cifrata alla prima lettura', async () => {
    const box = { voice_api_key: 'sk_vecchia_in_chiaro_99999' };
    const get = async (_db, k) => box[k], put = async (_db, k, v) => { box[k] = v; };
    assert.equal(await readSealedSetting(env, get, put, null, 'voice_api_key'), 'sk_vecchia_in_chiaro_99999');
    assert.ok(isSealed(box.voice_api_key));
    assert.equal(await readSealedSetting(env, get, put, null, 'voice_api_key'), 'sk_vecchia_in_chiaro_99999');
  });
});

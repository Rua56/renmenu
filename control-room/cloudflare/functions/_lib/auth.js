// Cloudflare Access JWT verification. No client-controlled headers are trusted before signature validation.
const jwksCache = new Map();
const b64url = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};
const decodeJson = (value) => JSON.parse(new TextDecoder().decode(b64url(value)));
const configuredDomain = (value) => {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(value)) return null;
  return value;
};

async function signingKey(teamDomain, kid, fetcher) {
  let cached = jwksCache.get(teamDomain);
  if (!cached || cached.expires < Date.now() || !cached.keys.some((key) => key.kid === kid)) {
    const response = await fetcher(`${teamDomain}/cdn-cgi/access/certs`);
    if (!response.ok) throw new Error('Access JWKS unavailable');
    const json = await response.json();
    if (!Array.isArray(json.keys) || json.keys.length > 10) throw new Error('Invalid JWKS');
    cached = { keys: json.keys, expires: Date.now() + 10 * 60_000 };
    jwksCache.set(teamDomain, cached);
  }
  const jwk = cached.keys.find((key) => key.kid === kid && key.kty === 'RSA' && key.alg === 'RS256' && key.use === 'sig');
  if (!jwk) throw new Error('Signing key not found');
  return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

export async function verifyOwner(request, env, fetcher = fetch) {
  const domain = configuredDomain(env?.TEAM_DOMAIN);
  const audience = env?.POLICY_AUD;
  const email = env?.OWNER_EMAIL;
  if (!domain || typeof audience !== 'string' || !audience || typeof email !== 'string' ||
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return false;
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || token.length > 8192) return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const header = decodeJson(parts[0]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.kid.length > 256) return false;
    const key = await signingKey(domain, header.kid, fetcher);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return false;
    const claims = decodeJson(parts[1]);
    const now = Math.floor(Date.now() / 1000);
    return claims.iss === domain && claims.type === 'app' &&
      (Array.isArray(claims.aud) ? claims.aud.includes(audience) : claims.aud === audience) &&
      typeof claims.exp === 'number' && claims.exp > now &&
      (claims.nbf === undefined || (typeof claims.nbf === 'number' && claims.nbf <= now)) &&
      (claims.iat === undefined || (typeof claims.iat === 'number' && claims.iat <= now + 60)) &&
      typeof claims.email === 'string' && claims.email.toLowerCase() === email.toLowerCase();
  } catch {
    return false; // Key service failures also fail closed.
  }
}

export function isSameOriginWrite(request) {
  const url = new URL(request.url);
  return request.headers.get('origin') === url.origin &&
    ['same-origin', 'none', null].includes(request.headers.get('sec-fetch-site'));
}

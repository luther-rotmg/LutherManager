// LutherManager release-channel Worker.
//
// Serves versioned Electron artifacts + the `latest.yml` update manifest
// from an R2 bucket, gated behind a per-install Bearer token held in a KV
// namespace. electron-updater's `generic` provider hits this endpoint on
// startup and every check-for-update interval.
//
// Route: luther-rotmg.com/api/releases/*
// Auth:  Authorization: Bearer <token>  (token looked up in TOKENS KV)
//
// KV token schema:
//   key   = <token>
//   value = { "revoked": boolean, "email"?: string, "install_date"?: string, "note"?: string }
//   Any missing key or revoked=true -> 403.

export interface Env {
  RELEASES: R2Bucket;
  TOKENS: KVNamespace;
}

interface TokenRecord {
  revoked?: boolean;
  email?: string;
  install_date?: string;
  note?: string;
}

const HEALTH_PATH = '/api/releases/health';
const PATH_PREFIX = '/api/releases/';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PATH_PREFIX)) {
      return json({ error: 'Not found.' }, 404);
    }
    if (url.pathname === HEALTH_PATH && request.method === 'GET') {
      return json({ ok: true, service: 'luther-manager-release-channel' }, 200);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'Method not allowed.' }, 405, { Allow: 'GET, HEAD' });
    }

    const auth = await authorize(request, env);
    if (!auth.ok) {
      return json({ error: auth.reason }, 401, {
        'WWW-Authenticate': 'Bearer realm="LutherManager Release Channel"',
      });
    }

    // Object key inside the R2 bucket = the URL path minus the prefix.
    // e.g. /api/releases/win/latest.yml  ->  win/latest.yml
    const objectKey = url.pathname.slice(PATH_PREFIX.length);
    if (!objectKey || objectKey.includes('..')) {
      return json({ error: 'Invalid object key.' }, 400);
    }

    const object = await env.RELEASES.get(objectKey);
    if (!object) {
      return json({ error: 'Release artifact not found.', key: objectKey }, 404);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', objectKey.endsWith('latest.yml') ? 'no-store' : 'public, max-age=31536000, immutable');
    if (!headers.has('content-type')) {
      // electron-updater expects text/yaml for the manifest; everything else is binary.
      headers.set('content-type', objectKey.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream');
    }
    return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
  },
};

async function authorize(request: Request, env: Env): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  const header = request.headers.get('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return { ok: false, reason: 'Missing Bearer token.' };
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token || token.length > 512) {
    return { ok: false, reason: 'Malformed token.' };
  }
  const raw = await env.TOKENS.get(token);
  if (!raw) {
    return { ok: false, reason: 'Unknown token.' };
  }
  let record: TokenRecord;
  try {
    record = JSON.parse(raw) as TokenRecord;
  } catch {
    return { ok: false, reason: 'Corrupt token record.' };
  }
  if (record.revoked === true) {
    return { ok: false, reason: 'Token has been revoked.' };
  }
  return { ok: true, token };
}

function json(body: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

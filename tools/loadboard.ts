#!/usr/bin/env node
// The load board's server: serves the grid and proxies operator verbs to
// whatever surface the deployment runs. Same boundary as every other operator
// client in the set — no privileged path, no session forwarding, nothing the
// CLI could not also do.
//
//   OWP_URL=http://desk:7117 npm run board     # → http://localhost:7121
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');
const MAX_BODY_BYTES = 1024 * 1024;
const upstreamSignal = () => {
  const configured = Number(process.env.OWP_TIMEOUT_MS ?? 10_000);
  return AbortSignal.timeout(Number.isFinite(configured) && configured > 0 ? configured : 10_000);
};

async function protocolBody(req: IncomingMessage) {
  if (req.method !== 'POST' || !/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] ?? ''))) {
    throw Object.assign(new Error('POST /v0/<verb> requires Content-Type: application/json'), { status: 400, code: 'VALIDATION' });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const chunk = c as Buffer;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error(`JSON body exceeds ${MAX_BODY_BYTES} bytes`), { status: 400, code: 'VALIDATION' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8') || '{}';
}

export function makeLoadBoard(surfaceUrl: string, token?: string): Server {
  const surface = surfaceUrl.replace(/\/$/, '');
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'" });
        return res.end(readFileSync(UI));
      }
      if (url.pathname.startsWith('/v0/')) {
        const requestBody = await protocolBody(req);
        const upstream = await fetch(surface + url.pathname, {
          method: 'POST',
          headers: {
            'content-type': 'application/json', 'x-owp-client': 'load-board',
            ...(req.headers['idempotency-key'] ? { 'idempotency-key': String(req.headers['idempotency-key']) } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: requestBody,
          signal: upstreamSignal(),
        });
        const body = await upstream.text();
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        return res.end(body);
      }
      res.writeHead(404).end('not found');
    } catch (e) {
      const local = e as Error & { status?: number; code?: string };
      res.writeHead(local.status ?? 502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: { code: local.code ?? 'SURFACE_UNREACHABLE', message: local.message } }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const surfaceUrl = process.env.OWP_URL ?? 'http://127.0.0.1:7117';
  const port = Number(process.env.BOARD_PORT ?? 7121);
  // An operator client carries no authority of its own: it proxies whatever the
  // deployment's token confers, or — in open mode — plain operator authority.
  // So reaching this port IS the authority, and binding every interface hands
  // it to the network. The surface itself binds loopback for exactly this
  // reason; a board that does not would simply move the hole one layer up.
  // BOARD_HOST is the opt-out for someone putting real auth in front of it.
  const host = process.env.BOARD_HOST ?? '127.0.0.1';
  makeLoadBoard(surfaceUrl, process.env.OWP_TOKEN).listen(port, host, () =>
    console.log(`the load board → http://${host}:${port}  (surface: ${surfaceUrl})`));
}

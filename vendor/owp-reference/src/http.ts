// HTTP+JSON reference binding (spec §17; normative annex A). Uniform routes:
//
//   POST /v0/<verb>           body = verb args (JSON)
//   GET  /v0/health
//
// Actor identity travels in headers: x-owp-session (registered session id)
// or x-owp-client (free-form client identity — operator CLI, cron, watcher).
// A client MAY pin a revision with x-owp-protocol (annex A.5).
// Responses: 200 {ok:true, result} | 4xx {ok:false, error:{code, message, data?}}.
// Route shapes are a binding definition, recorded in docs/binding-http.md.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, type Grant } from './schema.ts';
import { OwpError, Surface } from './surface.ts';

// The operator UI: a single self-contained page, served by the surface at GET /.
// It is an ordinary operator client speaking the verbs below — no special access.
const UI_PATH = new URL('../ui/index.html', import.meta.url);

const STATUS: Record<string, number> = {
  VALIDATION: 400, UNSUPPORTED_VERSION: 400, UNKNOWN_VERB: 404, NOT_FOUND: 404,
  SESSION_REQUIRED: 401, UNAUTHENTICATED: 401, FORBIDDEN: 403, CONFLICT: 409, STATE: 422,
};

// ---------- A.5 revision selection ----------
//
// §9 states the obligation at protocol level — "a surface MUST report the
// revisions it supports, and MUST answer UNSUPPORTED_VERSION to a client that
// pins one it does not implement" — and delegates the *mechanism* to the
// binding: "a binding MUST provide some mechanism and state it". For HTTP the
// mechanism is annex A.5's request header. This binding read no such header
// and never raised the code, so a client pinning a revision this surface
// cannot serve was answered in 1.0-rc1 as though it had asked for it: the
// reference implementation failing its own normative annex.
const PIN_HEADER = 'x-owp-protocol';
const IDEMPOTENCY_HEADER = 'idempotency-key';
const MAX_BODY_BYTES = 1024 * 1024;
const SUPPORTED: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS;

// Node lowercases header names and joins repeats with ", "; a repeated or
// list-valued pin is not a revision this surface implements, and falls through
// to the refusal below carrying `supported` — which is the useful answer.
function pinnedRevision(req: IncomingMessage): string | undefined {
  const raw = req.headers[PIN_HEADER];
  const value = (Array.isArray(raw) ? raw.join(', ') : raw ?? '').trim();
  return value || undefined;
}

// Authentication (D-20): two static bearer tokens map to the two §18 authority
// classes. Both unset → open mode: authority is inferred by the surface, and
// server.ts binds loopback only unless OWP_HOST says otherwise.
// Configure via OWP_OPERATOR_TOKEN / OWP_AGENT_TOKEN.
// grantTokens (D-26) are §18's explicit trigger-owner grants: each token is
// agent-class plus the right to unpark parks whose trigger matches a prefix —
// OWP_GRANTS='[{"token":"…","unpark_triggers":["window:"]}]'.
export interface AuthConfig {
  operatorToken?: string;
  agentToken?: string;
  grantTokens?: { token: string; unpark_triggers?: string[]; grants?: Grant[] }[];
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const chunk = c as Buffer;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new OwpError('VALIDATION', `JSON body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestHash(verb: string, args: unknown): string {
  return createHash('sha256').update(`${verb}\n${stableJson(args)}`).digest('hex');
}

function idempotencyKey(req: IncomingMessage): string | undefined {
  const raw = req.headers[IDEMPOTENCY_HEADER];
  const value = (Array.isArray(raw) ? raw.join(',') : raw ?? '').trim();
  if (!value) return undefined;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new OwpError('VALIDATION', 'Idempotency-Key must be 1-128 ASCII letters, digits, dot, underscore, colon, or hyphen');
  }
  return value;
}

function respond(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

export function makeServer(surface: Surface, auth: AuthConfig = {}): Server {
  const authEnabled = !!(auth.operatorToken || auth.agentToken);
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      // The pin is settled BEFORE anything else the request asks for —
      // routing, and authentication too. A.5's MUST is unconditional, so a
      // caller whose credential is also wrong must still be told the revision
      // is the problem, or it retries forever against a surface that cannot
      // speak to it. Nothing leaks: GET /v0/health already names the revision
      // without a credential, and the refusal itself is the only unauthenticated
      // way to learn `supported` when surface.describe is behind a token.
      // Scoped to /v0/* — the operator console at GET / is outside the annex.
      if (url.pathname.startsWith('/v0/')) {
        const pin = pinnedRevision(req);
        if (pin && !SUPPORTED.includes(pin)) {
          return respond(res, STATUS.UNSUPPORTED_VERSION, {
            ok: false,
            error: {
              code: 'UNSUPPORTED_VERSION',
              message: `this surface does not implement protocol revision ${pin}`,
              data: { supported: [...SUPPORTED] },
            },
          });
        }
      }
      if (req.method === 'GET' && url.pathname === '/v0/health') {
        return respond(res, 200, { ok: true, protocol: `owp/${PROTOCOL_VERSION}`, auth: authEnabled });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = readFileSync(UI_PATH);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
        });
        return res.end(html);
      }
      // Any verb-shaped path reaches the surface, so an unimplemented verb
      // answers UNKNOWN_VERB rather than NOT_FOUND — the binding must not
      // conflate "this route did not parse" with "this surface lacks that
      // verb" (caught by the conformance kit).
      const m = url.pathname.match(/^\/v0\/([a-z][a-z0-9._-]*)$/i);
      if (!m || req.method !== 'POST') {
        return respond(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'POST /v0/<verb> or GET /v0/health' } });
      }
      const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
      if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
        return respond(res, 400, { ok: false, error: { code: 'VALIDATION', message: 'POST /v0/<verb> requires Content-Type: application/json' } });
      }
      const origin = String(req.headers.origin ?? '');
      const host = String(req.headers.host ?? '');
      if (origin && origin !== `http://${host}` && origin !== `https://${host}`) {
        return respond(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'cross-origin browser requests are not allowed' } });
      }
      let authority: 'agent' | 'operator' | undefined;
      let grants: Grant[] | undefined;
      if (authEnabled) {
        const token = ((req.headers.authorization as string) ?? '').replace(/^Bearer\s+/i, '')
          || (req.headers['x-owp-token'] as string) || '';
        const grant = auth.grantTokens?.find(g => g.token === token);
        if (auth.operatorToken && token === auth.operatorToken) authority = 'operator';
        else if (grant) {
          authority = 'agent';
          // A grant token declares either the v1.0 shape (verbs + scope) or the
          // v0.3 spelling (unpark trigger prefixes), normalized here.
          grants = grant.grants ?? (grant.unpark_triggers ?? []).map(p => ({ verbs: ['work.unpark'], trigger_prefix: p }));
        }
        else if (auth.agentToken && token === auth.agentToken) authority = 'agent';
        else return respond(res, 401, { ok: false, error: { code: 'UNAUTHENTICATED', message: 'valid bearer token required (operator, agent, or grant)' } });
      }
      const args = await readBody(req);
      const actor = {
        session: (req.headers['x-owp-session'] as string) || undefined,
        client: (req.headers['x-owp-client'] as string) || undefined,
        authority,
        grants,
      };
      const key = idempotencyKey(req);
      if (!key) {
        const result = surface.call(m[1], args, actor);
        return respond(res, 200, { ok: true, result });
      }

      // Annex A.6: the mutation and its replay record commit atomically. Store
      // transactions use savepoints, so verbs that already protect a claim or
      // create remain atomic inside this binding-level transaction.
      const actorKey = `${authority ?? (actor.session ? 'agent' : 'operator')}:${actor.session ?? actor.client ?? 'client'}`;
      const hash = requestHash(m[1], args);
      const replay = surface.store.tx(() => {
        const existing = surface.store.getHttpIdempotency(actorKey, key);
        if (existing) {
          if (existing.verb !== m[1] || existing.request_hash !== hash) {
            return {
              status: 400,
              payload: { ok: false, error: { code: 'VALIDATION', message: 'Idempotency-Key was already used for a different request' } },
            };
          }
          return { status: existing.status, payload: JSON.parse(existing.response) as unknown };
        }

        let status = 200;
        let payload: unknown;
        try {
          payload = { ok: true, result: surface.call(m[1], args, actor) };
        } catch (e) {
          if (!(e instanceof OwpError)) throw e;
          status = STATUS[e.code] ?? 400;
          payload = { ok: false, error: { code: e.code, message: e.message } };
        }
        surface.store.putHttpIdempotency(actorKey, key, m[1], hash, status, JSON.stringify(payload));
        return { status, payload };
      });
      return respond(res, replay.status, replay.payload);
    } catch (e) {
      if (e instanceof OwpError) {
        return respond(res, STATUS[e.code] ?? 400, { ok: false, error: { code: e.code, message: e.message } });
      }
      if (e instanceof SyntaxError) {
        return respond(res, 400, { ok: false, error: { code: 'VALIDATION', message: `invalid JSON body: ${e.message}` } });
      }
      respond(res, 500, { ok: false, error: { code: 'INTERNAL', message: (e as Error).message } });
    }
  });
}

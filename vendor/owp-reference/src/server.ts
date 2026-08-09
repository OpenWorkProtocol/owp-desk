// Entry point: `npm run serve` / `node src/server.ts`.
// OWP_DB (default ~/.owp/owp.db), OWP_PORT (default 7117).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { makeServer } from './http.ts';
import { Store } from './store.ts';
import { Surface } from './surface.ts';

const db = process.env.OWP_DB ?? join(homedir(), '.owp', 'owp.db');
const port = Number(process.env.OWP_PORT ?? 7117);

const auth = {
  operatorToken: process.env.OWP_OPERATOR_TOKEN,
  agentToken: process.env.OWP_AGENT_TOKEN,
  grantTokens: process.env.OWP_GRANTS ? JSON.parse(process.env.OWP_GRANTS) : undefined,
};
const store = new Store(db);
const surface = new Surface(store);
// With no tokens set, authority is INFERRED: a caller that sends no session
// header is operator-class. On a routable interface that means one omitted
// header buys the whole authority model, so open mode binds loopback only.
// OWP_HOST is the explicit opt-out for someone who means it.
const authed = !!(auth.operatorToken || auth.agentToken);
const host = process.env.OWP_HOST ?? (authed ? '0.0.0.0' : '127.0.0.1');
const server = makeServer(surface, auth).listen(port, host, () => {
  const mode = authed
    ? 'token auth'
    : host === '127.0.0.1'
      ? 'OPEN MODE — loopback only (authority is inferred; set tokens to expose it)'
      : 'OPEN MODE on a routable interface — ANY CALLER IS THE OPERATOR';
  console.log(`owp surface listening on ${host}:${port} (db: ${db}) — ${mode}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(error => {
    try {
      store.close();
    } catch (closeError) {
      console.error(closeError);
      process.exitCode = 1;
    }
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

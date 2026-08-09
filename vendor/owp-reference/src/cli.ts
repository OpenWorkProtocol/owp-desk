#!/usr/bin/env node
// owp — thin CLI binding (spec §17).
//
// Direct mode (default): embeds the surface over OWP_DB (~/.owp/owp.db).
// HTTP mode: set OWP_URL and the same commands go over the wire.
//
// Session identity: --session > OWP_SESSION > .owp/session (written by
// `owp register`, per-cwd). Client identity: --client > OWP_CLIENT > "operator".
// Machine-readable output everywhere with --json; attention/portfolio/projects
// render for humans by default (every human path goes through a renderer).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { VERB_NAMES } from './schema.ts';
import type { AttentionRow } from './surface.ts';

// ---------- arg parsing ----------

const REPEATABLE = new Set(['option', 'friction', 'now-true', 'supersedes', 'knowledge', 'depends']);
const BOOLEANS = new Set(['json', 'dispatch', 'finalize', 'help', 'active-only']);

interface Args { positional: string[]; flags: Record<string, string | boolean | string[]> }

function parseArgs(argv: string[]): Args {
  const out: Args = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out.positional.push(a); continue; }
    const key = a.slice(2);
    if (BOOLEANS.has(key)) { out.flags[key] = true; continue; }
    const val = argv[++i];
    if (val === undefined) fail(`--${key} needs a value`);
    if (REPEATABLE.has(key)) {
      (out.flags[key] = (out.flags[key] as string[] | undefined) ?? []) as string[];
      (out.flags[key] as string[]).push(val);
    } else {
      out.flags[key] = val;
    }
  }
  return out;
}

const str = (v: string | boolean | string[] | undefined) => (typeof v === 'string' ? v : undefined);
const list = (v: string | boolean | string[] | undefined) => (Array.isArray(v) ? v : []);

function fail(msg: string): never {
  console.error(`owp: ${msg}`);
  process.exit(1);
}

function parseJsonArg(s: string, what: string): unknown {
  try { return JSON.parse(s === '-' ? readFileSync(0, 'utf8') : s); }
  catch (e) { fail(`invalid JSON for ${what}: ${(e as Error).message}`); }
}

// ---------- transport ----------

const DB_PATH = process.env.OWP_DB ?? join(homedir(), '.owp', 'owp.db');
const SESSION_FILE = join(process.cwd(), '.owp', 'session');

// Delivery is adopter-defined (D-22): the protocol never mandates a topology.
// owp-code's own convention, in resolution order: OWP_URL env → a deployment-
// provided .owp/config.json {url, project} in the working directory → the
// local database. A deployment may use any, all, or none of these slots.
function repoConfig(): { url?: string; project?: string } {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), '.owp', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function sessionId(flags: Args['flags']): string | undefined {
  return str(flags.session) ?? process.env.OWP_SESSION
    ?? (existsSync(SESSION_FILE) ? readFileSync(SESSION_FILE, 'utf8').trim() : undefined);
}

async function invoke(verb: string, args: unknown, actor: { session?: string; client?: string }): Promise<unknown> {
  const url = process.env.OWP_URL ?? repoConfig().url;
  if (url) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (actor.session) headers['x-owp-session'] = actor.session;
    if (actor.client) headers['x-owp-client'] = actor.client;
    if (process.env.OWP_TOKEN) headers['authorization'] = `Bearer ${process.env.OWP_TOKEN}`;
    if (process.env.OWP_PROTOCOL) headers['x-owp-protocol'] = process.env.OWP_PROTOCOL;
    if (process.env.OWP_IDEMPOTENCY_KEY) headers['idempotency-key'] = process.env.OWP_IDEMPOTENCY_KEY;
    const configured = Number(process.env.OWP_TIMEOUT_MS ?? 10_000);
    const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 10_000;
    const res = await fetch(`${url.replace(/\/$/, '')}/v0/${verb}`, {
      method: 'POST', headers, body: JSON.stringify(args ?? {}), signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await res.json() as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    if (!payload.ok) fail(`${payload.error?.code}: ${payload.error?.message}`);
    return payload.result;
  }
  const { Store } = await import('./store.ts');
  const { Surface, OwpError } = await import('./surface.ts');
  const surface = new Surface(new Store(DB_PATH));
  try {
    return surface.call(verb, args, actor);
  } catch (e) {
    if (e instanceof OwpError) fail(`${e.code}: ${e.message}`);
    throw e;
  }
}

// ---------- renderers ----------

function humanize(s: number): string {
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function renderAttention(rows: AttentionRow[], staleMinutes: number) {
  const shown = rows.filter(r =>
    !(r.kind === 'health' && r.action === 'release' && r.elapsed_s < staleMinutes * 60));
  if (!shown.length) { console.log('attention queue is empty'); return; }
  const label: Record<string, string> = { decision: 'DECIDE', triage: 'TRIAGE', health: 'HEALTH', review: 'REVIEW' };
  for (const r of shown) {
    console.log(`${label[r.kind].padEnd(7)} ${r.target.padEnd(9)} ${humanize(r.elapsed_s).padStart(4)}  ${r.reason}  → ${r.action}`);
  }
  const hidden = rows.length - shown.length;
  if (hidden) console.log(`(${hidden} in-progress item${hidden > 1 ? 's' : ''} under --stale ${staleMinutes}m hidden)`);
}

function renderPortfolio(projects: any[]) {
  for (const p of projects) {
    console.log(`\n${p.key} · ${p.name} · working set ${p.working_set}`);
    for (const d of p.in_flight) {
      console.log(`  ▸ ${d.ref} ${d.title} (${d.owner_session})`);
      if (d.status_line) console.log(`      ${d.status_line}`);
      if (d.next_checkpoint) console.log(`      next: ${d.next_checkpoint}`);
    }
    for (const d of p.parked) console.log(`  ⏸ ${d.ref} ${d.title} — parked ${humanize(d.elapsed_s)} (${d.cause}: ${d.trigger})`);
    for (const d of p.review) console.log(`  ✓ ${d.ref} ${d.title} — in review`);
    if (p.todo.length) console.log(`  · todo ${p.todo.length}: ${p.todo.map((d: any) => d.ref).join(', ')}`);
    if (p.proposed.length) console.log(`  · proposed ${p.proposed.length}: ${p.proposed.map((d: any) => d.ref).join(', ')}`);
  }
  console.log();
}

// ---------- commands ----------

const HELP = `owp — Open Work Protocol CLI (owp-1.0-rc2 surface)

setup       owp project add KEY "name" --goal "..." [--knowledge-dir path]
            owp projects
            owp register --project KEY [--tool claude-code] [--parent SESSION]
            owp whoami · owp heartbeat · owp end
agent       owp next [--cursor N]            claim + assignment packet (or "no eligible work")
            owp claim REF · owp get REF [--cursor N]
            owp create --title T --intent I [--kind k] [--project KEY] [--dispatch]
                       [--urgency u] [--priority 1-5] [--depends REF]... [--parent REF] [--links JSON]
            owp progress REF "text" · owp note REF "text"
            owp ask REF 'BODY-JSON'|-        question; options[] each with evidence[]
            owp answer REF QSEQ CHOICE [text]
            owp rejection REF --reason R --continuation needs-info|redirect|rework|record-only [--what W] [--event N]
              (the continuation vocabulary is open; only record-only closes a thing)
            owp park REF --cause decision|external --trigger T --why W --state-so-far S
                       --resume R --on-release O [--question QSEQ]
            owp update REF [--status "..."] [--next "..."] [--links JSON]
            owp complete REF --outcome "..." [--friction F]... [--now-true N]...
                       [--supersedes S]... [--knowledge K]... [--finalize]  (or --record JSON)
            owp policies REF · owp knowledge "query" [--project KEY]
            owp reground JSON|-              {completed[], in_flight[], proposed[]}
operator    owp attention [--stale MIN] · owp portfolio · owp view REF
            (visual: "owp serve" then open http://127.0.0.1:7117/ — open mode is loopback-only)
            owp reject REF --reason R --continuation C [--what W] [--event QSEQ]
              (§10 operator-side rejection: appends the rejection to REF's worklog;
               --event QSEQ names the question it answers and releases its decision-park)
            owp triage TARGET accept|reject [--reason R] [--continuation C]
              (reject continuations: record-only closes; needs-info sends back; rework bounces review)
            owp note REF "text"              works without a session — operator voice, no verdict
            owp promote SEQ proposal|policy [--title T] [--intent I] [--type t] [--text x] [--scope s]
            owp unpark REF [note] · owp release REF [note]
            owp cancel REF --reason "why this work is withdrawn"
            owp pin REF N|none · owp prio REF N
            owp policy add --scope S --type T "text" · owp policy retire pol-N
raw         owp call VERB [JSON|-]           any verb, raw args
            owp serve                        HTTP surface (OWP_PORT, default 7117)

env: OWP_DB (default ~/.owp/owp.db) · OWP_URL (HTTP mode) · OWP_SESSION · OWP_CLIENT
     OWP_TIMEOUT_MS (default 10000) · OWP_PROTOCOL · OWP_IDEMPOTENCY_KEY
flags: --json (machine output) · --session ID · --client ID · --idempotency-key KEY`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  if (str(flags['idempotency-key'])) process.env.OWP_IDEMPOTENCY_KEY = str(flags['idempotency-key']);
  const actor = { session: sessionId(flags), client: str(flags.client) ?? process.env.OWP_CLIENT ?? 'operator' };
  const agentActor = { session: actor.session }; // session-required verbs must not fall back to client
  // Operator commands must not carry a stray .owp/session — a session actor is
  // agent-authority (D-20) and would be denied the operator verbs.
  const opActor = { client: actor.client };
  const emit = (result: unknown) => console.log(JSON.stringify(result, null, 2));

  switch (cmd) {
    case undefined: case 'help': case '--help': console.log(HELP); return;

    case 'serve': await import('./server.ts'); return;

    case 'project': {
      const [sub, key, name] = positional;
      if (sub !== 'add') fail('usage: owp project add KEY "name" --goal "..."');
      emit(await invoke('project.create', {
        key, name, goal: str(flags.goal) ?? fail('--goal required'),
        ...(str(flags['knowledge-dir']) ? { knowledge_dir: str(flags['knowledge-dir']) } : {}),
      }, opActor));
      return;
    }
    case 'projects': {
      const projects = await invoke('project.list', {}, opActor) as any[];
      if (flags.json) return emit(projects);
      for (const p of projects) console.log(`${p.key.padEnd(8)} ${p.name} — ${p.goal}`);
      return;
    }

    case 'register': {
      const result = await invoke('session.register', {
        tool: str(flags.tool) ?? 'claude-code',
        host: str(flags.host) ?? hostname(),
        project: str(flags.project) ?? repoConfig().project ?? fail('--project required (or .owp/config.json with {"project": "KEY"})'),
        ...(str(flags.parent) ? { parent: str(flags.parent) } : {}),
      }, {}) as { id: string };
      mkdirSync(join(process.cwd(), '.owp'), { recursive: true });
      writeFileSync(SESSION_FILE, result.id + '\n');
      emit(result);
      console.error(`session id written to .owp/session`);
      return;
    }
    case 'whoami': {
      if (!actor.session) fail('no session (register first, or set --session/OWP_SESSION)');
      console.log(actor.session);
      return;
    }
    case 'heartbeat': emit(await invoke('session.heartbeat', {}, agentActor)); return;
    case 'end': emit(await invoke('session.end', {}, agentActor)); return;

    case 'next': {
      const result = await invoke('work.next', { cursor: Number(str(flags.cursor) ?? 0) }, agentActor);
      if (result === null) { console.log(flags.json ? 'null' : 'no eligible work'); process.exitCode = 3; return; }
      emit(result);
      return;
    }
    case 'claim': emit(await invoke('work.claim', { ref: positional[0], cursor: Number(str(flags.cursor) ?? 0) }, agentActor)); return;
    case 'get': emit(await invoke('work.get', { ref: positional[0], cursor: Number(str(flags.cursor) ?? 0) }, agentActor)); return;

    case 'create': {
      const item: Record<string, unknown> = {
        title: str(flags.title) ?? fail('--title required'),
        intent: str(flags.intent) ?? fail('--intent required'),
      };
      if (str(flags.kind)) item.kind = str(flags.kind);
      if (str(flags.project)) item.project = str(flags.project);
      if (str(flags.urgency)) item.urgency = str(flags.urgency);
      if (str(flags.priority)) item.priority = Number(str(flags.priority));
      if (list(flags.depends).length) item.depends_on = list(flags.depends);
      if (str(flags.parent)) item.parent = str(flags.parent);
      if (str(flags.links)) item.links = parseJsonArg(str(flags.links)!, '--links');
      emit(await invoke('work.create', { item, dispatch: !!flags.dispatch }, actor.session ? agentActor : opActor));
      return;
    }

    case 'progress': case 'note': {
      // notes fall back to the client identity — the operator's non-verdict voice
      const a = cmd === 'note' && !actor.session ? opActor : agentActor;
      emit(await invoke('event.append', { ref: positional[0], kind: cmd, body: { text: positional.slice(1).join(' ') } }, a));
      return;
    }
    case 'ask':
      emit(await invoke('event.append', {
        ref: positional[0], kind: 'question',
        body: parseJsonArg(positional[1] ?? fail(`ask needs a JSON body: owp ask REF 'BODY'|-`), 'question body'),
      }, agentActor));
      return;
    case 'rejection':
      emit(await invoke('event.append', {
        ref: positional[0], kind: 'rejection',
        body: {
          reason: str(flags.reason) ?? fail('--reason required'),
          continuation: str(flags.continuation) ?? fail('--continuation required'),
          ...(str(flags.what) ? { what: str(flags.what) } : {}),
          ...(str(flags.event) ? { event: Number(str(flags.event)) } : {}),
        },
      }, agentActor));
      return;

    case 'park':
      emit(await invoke('work.park', {
        ref: positional[0],
        park: {
          cause: str(flags.cause) ?? fail('--cause required'),
          trigger: str(flags.trigger) ?? fail('--trigger required'),
          ...(str(flags.question) ? { question: Number(str(flags.question)) } : {}),
          handoff: {
            why: str(flags.why) ?? fail('--why required'),
            state_so_far: str(flags['state-so-far']) ?? fail('--state-so-far required'),
            resume_point: str(flags.resume) ?? fail('--resume required'),
            on_release: str(flags['on-release']) ?? fail('--on-release required'),
          },
        },
      }, agentActor));
      return;

    case 'update': {
      const args: Record<string, unknown> = { ref: positional[0] };
      if (str(flags.status) !== undefined) args.status_line = str(flags.status);
      if (str(flags.next) !== undefined) args.next_checkpoint = str(flags.next);
      if (str(flags.links)) args.links = parseJsonArg(str(flags.links)!, '--links');
      emit(await invoke('work.update', args, agentActor));
      return;
    }

    case 'complete': {
      const record = str(flags.record)
        ? parseJsonArg(str(flags.record)!, 'completion record')
        : {
            outcome: str(flags.outcome) ?? fail('--outcome required (or --json RECORD)'),
            friction: list(flags.friction), now_true: list(flags['now-true']),
            supersedes: list(flags.supersedes), knowledge_edits: list(flags.knowledge),
          };
      emit(await invoke('work.complete', { ref: positional[0], record, finalize: !!flags.finalize }, agentActor));
      return;
    }

    // work.view is an operator projection (§15: agents read assignments, not
    // boards), so it goes out as the client identity even in a checkout that
    // has a .owp/session — a session actor would earn a FORBIDDEN. An agent
    // reads its own item with `owp get`.
    case 'view': emit(await invoke('work.view', { ref: positional[0], cursor: Number(str(flags.cursor) ?? 0) }, opActor)); return;
    case 'policies': emit(await invoke('policy.applicable', { ref: positional[0] }, actor.session ? agentActor : opActor)); return;
    case 'knowledge':
      emit(await invoke('knowledge.query', {
        q: positional[0] ?? fail('query required'),
        ...(str(flags.project) ? { project: str(flags.project) } : {}),
      }, actor.session ? agentActor : opActor));
      return;
    case 'reground':
      emit(await invoke('reground.submit', parseJsonArg(positional[0] ?? '-', 'reground payload'), agentActor));
      return;

    case 'attention': {
      // §15: attention answers with a page envelope ALWAYS — {rows, cursor,
      // total, more} — so the CLI unwraps it rather than branching on shape.
      const page = await invoke('attention', {}, opActor) as { rows: AttentionRow[]; total: number; more: boolean };
      if (flags.json) return emit(page);
      renderAttention(page.rows, Number(str(flags.stale) ?? 30));
      if (page.more) console.log(`(${page.rows.length} of ${page.total} rows — the surface returned a page)`);
      return;
    }
    case 'portfolio': {
      const projects = await invoke('portfolio', {}, opActor) as any[];
      if (flags.json) return emit(projects);
      renderPortfolio(projects);
      return;
    }

    case 'answer':
      emit(await invoke('answer', {
        ref: positional[0], question: Number(positional[1]), choice: positional[2] ?? fail('usage: owp answer REF QSEQ CHOICE [text]'),
        ...(positional[3] ? { text: positional.slice(3).join(' ') } : {}),
      }, opActor));
      return;
    case 'reject':
      emit(await invoke('reject', {
        ref: positional[0],
        reason: str(flags.reason) ?? fail('--reason required'),
        continuation: str(flags.continuation) ?? fail('--continuation required'),
        ...(str(flags.what) ? { what: str(flags.what) } : {}),
        ...(str(flags.event) ? { event: Number(str(flags.event)) } : {}),
      }, opActor));
      return;
    case 'triage':
      emit(await invoke('triage', {
        target: positional[0], decision: positional[1] ?? fail('usage: owp triage TARGET accept|reject [--reason R] [--continuation C]'),
        ...(str(flags.reason) ? { reason: str(flags.reason) } : {}),
        ...(str(flags.continuation) ? { continuation: str(flags.continuation) } : {}),
      }, opActor));
      return;
    case 'promote':
      emit(await invoke('promote', {
        event: Number(positional[0]), to: positional[1] ?? fail('usage: owp promote SEQ proposal|policy'),
        ...(str(flags.title) ? { title: str(flags.title) } : {}),
        ...(str(flags.intent) ? { intent: str(flags.intent) } : {}),
        ...(str(flags.kind) ? { kind: str(flags.kind) } : {}),
        ...(str(flags.scope) ? { scope: str(flags.scope) } : {}),
        ...(str(flags.type) ? { type: str(flags.type) } : {}),
        ...(str(flags.text) ? { text: str(flags.text) } : {}),
      }, opActor));
      return;
    case 'unpark': {
      // owp unpark REF [note] — or owp unpark --trigger "window:sun-0300" [note]
      const trig = str(flags.trigger);
      emit(await invoke('work.unpark', {
        ...(trig ? { trigger: trig } : { ref: positional[0] }),
        ...((trig ? positional[0] : positional[1]) ? { note: (trig ? positional : positional.slice(1)).join(' ') } : {}),
      }, opActor));
      return;
    }
    case 'release':
      emit(await invoke('work.release', { ref: positional[0], ...(positional[1] ? { note: positional.slice(1).join(' ') } : {}) }, actor.session ? agentActor : opActor));
      return;
    case 'cancel':
      emit(await invoke('work.cancel', {
        ref: positional[0] ?? fail('usage: owp cancel REF --reason "..."'),
        reason: str(flags.reason) ?? fail('--reason required'),
      }, opActor));
      return;
    case 'pin':
      emit(await invoke('work.pin', { ref: positional[0], pin: positional[1] === 'none' ? null : Number(positional[1]) }, opActor));
      return;
    case 'prio':
      emit(await invoke('work.reprioritize', { ref: positional[0], priority: Number(positional[1]) }, opActor));
      return;
    case 'policy': {
      const [sub] = positional;
      if (sub === 'add') {
        emit(await invoke('policy.set', {
          scope: str(flags.scope) ?? fail('--scope required'),
          type: str(flags.type) ?? 'note',
          text: positional[1] ?? fail('usage: owp policy add --scope S --type T "text"'),
        }, opActor));
      } else if (sub === 'retire') {
        emit(await invoke('policy.retire', { id: positional[1] }, opActor));
      } else fail('usage: owp policy add|retire');
      return;
    }

    case 'call': {
      const verb = positional[0] ?? fail(`usage: owp call VERB [JSON|-]  (verbs: ${VERB_NAMES.join(', ')})`);
      emit(await invoke(verb, positional[1] ? parseJsonArg(positional[1], 'args') : {}, actor.session ? { ...actor } : actor));
      return;
    }

    default: fail(`unknown command: ${cmd} (owp help)`);
  }
}

await main();

// SQLite persistence for the surface. One file, WAL mode, safe for concurrent
// CLI invocations in direct mode (claims run inside BEGIN IMMEDIATE).
// JSON columns hold the shapes defined in schema.ts; the store adds only the
// internal bookkeeping fields the projections need (eligible_since,
// elevated_release, state_since) — those never leave the surface.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ExitState } from './schema.ts';
import type { CompletionRecord, Deliverable, Event, Park, Policy, Project } from './schema.ts';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  key TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL,
  knowledge_dir TEXT, rank_tiebreak TEXT, vocabulary TEXT, counter INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS deliverables (
  ref TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(key),
  title TEXT NOT NULL, intent TEXT NOT NULL, kind TEXT NOT NULL,
  state TEXT NOT NULL, owner_session TEXT, parent TEXT,
  depends_on TEXT NOT NULL DEFAULT '[]', pin INTEGER, urgency TEXT NOT NULL DEFAULT 'routine',
  priority INTEGER NOT NULL DEFAULT 3, status_line TEXT NOT NULL DEFAULT '',
  next_checkpoint TEXT NOT NULL DEFAULT '', links TEXT NOT NULL DEFAULT '{}',
  park TEXT, completion TEXT,
  elevated_release INTEGER NOT NULL DEFAULT 0,
  eligible_since TEXT, state_since TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, tool TEXT NOT NULL, host TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(key), parent_session TEXT,
  started_at TEXT NOT NULL, last_seen TEXT NOT NULL,
  current_item TEXT, status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL,
  session TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_item ON events(item, seq);
CREATE TABLE IF NOT EXISTS policies (
  n INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, type TEXT NOT NULL,
  text TEXT NOT NULL, provenance TEXT, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS reground_diffs (
  n INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, project TEXT NOT NULL,
  kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verb_log (
  n INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
  actor TEXT NOT NULL, verb TEXT NOT NULL, args TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS http_idempotency (
  actor TEXT NOT NULL, key TEXT NOT NULL, verb TEXT NOT NULL,
  request_hash TEXT NOT NULL, status INTEGER NOT NULL, response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor, key)
);
`;

export interface SessionRow {
  id: string; tool: string; host: string; project: string;
  parent_session: string | null; started_at: string; last_seen: string;
  current_item: string | null; status: 'active' | 'ended';
}

// Deliverable plus store-internal bookkeeping.
export interface DeliverableRow extends Deliverable {
  completion: CompletionRecord | null;
  elevated_release: boolean;
  eligible_since: string | null;
  state_since: string;
  created_at: string;
  // Null on rows written before the column existed, and on any surface that
  // does not record it — the invariant then cannot fire for that row, which
  // is the honest failure mode for a fact nobody captured.
  created_by: string | null;
}

export interface RegroundDiffRow {
  id: string; session: string; project: string;
  kind: 'completed' | 'in_flight'; payload: unknown;
  status: 'pending' | 'accepted' | 'rejected'; reason: string | null; created_at: string;
}

// States that have left the working set, as a SQL tuple — DERIVED from the
// published enum so the two cannot drift again. D-9 called these
// "store-internal" and said nothing outside the store sees them; that was
// never true of `work.view`, which hands an operator the state of any ref it
// is given, including an exited one. The schema now names them (§8 exits) and
// this list is generated from it, so the surface's SQL and its published enum
// are one definition.
export const EXITED = `(${ExitState.options.map(s => `'${s}'`).join(',')})`;

const now = () => new Date().toISOString();

export class Store {
  db: DatabaseSync;
  private txDepth = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(SCHEMA_SQL);
    this.migrate();
  }

  // The surface database is long-lived (a deployment's working set survives
  // every code update), and CREATE TABLE IF NOT EXISTS never touches existing
  // tables — additive columns migrate here. Found live: the first project
  // created after the v0.3 tiebreak landed hit a column that tests (always on
  // fresh :memory: databases) could never miss.
  private migrate(): void {
    const additive: [table: string, column: string, ddl: string][] = [
      ['projects', 'rank_tiebreak', 'ALTER TABLE projects ADD COLUMN rank_tiebreak TEXT'],
      ['projects', 'vocabulary', 'ALTER TABLE projects ADD COLUMN vocabulary TEXT'],
      // Who proposed this item, so the delegation invariant can refuse a
      // grant holder that triages its own proposal (finding R-3). Same shape
      // as `completed_by`: recorded, never inferred from event archaeology.
      ['deliverables', 'created_by', 'ALTER TABLE deliverables ADD COLUMN created_by TEXT'],
      ['http_idempotency', 'created_at', 'ALTER TABLE http_idempotency ADD COLUMN created_at TEXT'],
    ];
    for (const [table, column, ddl] of additive) {
      const cols = this.db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[];
      if (!cols.some(c => c.name === column)) this.db.exec(ddl);
    }
  }

  close() { this.db.close(); }

  tx<T>(fn: () => T): T {
    const outer = this.txDepth === 0;
    const savepoint = `owp_tx_${this.txDepth}`;
    if (outer) this.db.exec('BEGIN IMMEDIATE');
    else this.db.exec(`SAVEPOINT ${savepoint}`);
    this.txDepth++;
    try {
      const out = fn();
      this.txDepth--;
      if (outer) this.db.exec('COMMIT');
      else this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return out;
    } catch (e) {
      this.txDepth--;
      if (outer) this.db.exec('ROLLBACK');
      else {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      throw e;
    }
  }

  // ---- HTTP binding idempotency (Annex A.6) ----

  getHttpIdempotency(actor: string, key: string):
    { verb: string; request_hash: string; status: number; response: string } | null {
    const row = this.db.prepare(
      'SELECT verb, request_hash, status, response FROM http_idempotency WHERE actor = ? AND key = ?',
    ).get(actor, key) as { verb: string; request_hash: string; status: number; response: string } | undefined;
    return row ?? null;
  }

  putHttpIdempotency(
    actor: string, key: string, verb: string, requestHash: string, status: number, response: string,
  ): void {
    const createdAt = now();
    this.db.prepare(
      'INSERT INTO http_idempotency (actor, key, verb, request_hash, status, response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(actor, key, verb, requestHash, status, response, createdAt);
    // Annex A.6 requires >=24 h. Seven days supports delayed retries while
    // bounding ordinary growth. Above the soft cap, only records already past
    // the mandatory 24 h window are removed; a hostile burst inside that
    // window must be bounded by deployment authentication/rate controls, never
    // by violating replay safety. Both deletions are in the mutation tx.
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare('DELETE FROM http_idempotency WHERE created_at IS NULL OR created_at < ?').run(cutoff);
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM http_idempotency').get() as { n: number }).n;
    if (count > 50_000) {
      const minimumCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      this.db.prepare(`DELETE FROM http_idempotency WHERE rowid IN (
        SELECT rowid FROM http_idempotency WHERE created_at < ? ORDER BY created_at, rowid LIMIT ?
      )`).run(minimumCutoff, count - 50_000);
    }
  }

  // ---- projects ----

  createProject(p: Project): void {
    this.db.prepare('INSERT INTO projects (key, name, goal, knowledge_dir, rank_tiebreak, vocabulary) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.key, p.name, p.goal, p.knowledge_dir ?? null,
        p.rank_tiebreak ? JSON.stringify(p.rank_tiebreak) : null,
        p.vocabulary ? JSON.stringify(p.vocabulary) : null);
  }

  getProject(key: string): (Project & { counter: number }) | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE key = ?').get(key) as Record<string, unknown> | undefined;
    if (!r) return null;
    return { key: r.key as string, name: r.name as string, goal: r.goal as string,
      knowledge_dir: (r.knowledge_dir as string | null) ?? undefined,
      rank_tiebreak: r.rank_tiebreak ? JSON.parse(r.rank_tiebreak as string) as Project['rank_tiebreak'] : null,
      vocabulary: r.vocabulary ? JSON.parse(r.vocabulary as string) as Project['vocabulary'] : null,
      counter: r.counter as number };
  }

  listProjects(): (Project & { counter: number })[] {
    return (this.db.prepare('SELECT key FROM projects ORDER BY key').all() as { key: string }[])
      .map(r => this.getProject(r.key)!);
  }

  nextRef(projectKey: string): string {
    this.db.prepare('UPDATE projects SET counter = counter + 1 WHERE key = ?').run(projectKey);
    const { counter } = this.db.prepare('SELECT counter FROM projects WHERE key = ?').get(projectKey) as { counter: number };
    return `${projectKey}-${counter}`;
  }

  // ---- deliverables ----

  private rowToDeliverable(r: Record<string, unknown>): DeliverableRow {
    return {
      ref: r.ref as string, project: r.project as string, title: r.title as string,
      intent: r.intent as string, kind: r.kind as string,
      state: r.state as DeliverableRow['state'],
      owner_session: r.owner_session as string | null, parent: r.parent as string | null,
      depends_on: JSON.parse(r.depends_on as string), pin: r.pin as number | null,
      urgency: r.urgency as DeliverableRow['urgency'], priority: r.priority as number,
      status_line: r.status_line as string, next_checkpoint: r.next_checkpoint as string,
      links: JSON.parse(r.links as string),
      park: r.park ? JSON.parse(r.park as string) as Park : null,
      completion: r.completion ? JSON.parse(r.completion as string) as CompletionRecord : null,
      elevated_release: !!(r.elevated_release as number),
      eligible_since: r.eligible_since as string | null,
      state_since: r.state_since as string, created_at: r.created_at as string,
      created_by: (r.created_by as string | null) ?? null,
    };
  }

  insertDeliverable(d: Omit<Deliverable, 'park'>, opts: { eligible: boolean; by?: string }): void {
    const t = now();
    this.db.prepare(`INSERT INTO deliverables
      (ref, project, title, intent, kind, state, owner_session, parent, depends_on,
       pin, urgency, priority, status_line, next_checkpoint, links, park,
       eligible_since, state_since, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`)
      .run(d.ref, d.project, d.title, d.intent, d.kind, d.state, d.owner_session,
        d.parent, JSON.stringify(d.depends_on), d.pin, d.urgency, d.priority,
        d.status_line, d.next_checkpoint, JSON.stringify(d.links),
        opts.eligible ? t : null, t, t, opts.by ?? null);
  }

  getDeliverable(ref: string): DeliverableRow | null {
    const r = this.db.prepare('SELECT * FROM deliverables WHERE ref = ?').get(ref) as Record<string, unknown> | undefined;
    return r ? this.rowToDeliverable(r) : null;
  }

  // Patch selected columns. JSON-typed values are stringified here.
  patchDeliverable(ref: string, patch: Partial<Record<string, unknown>>): void {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      if (k === 'depends_on' || k === 'links' || k === 'park' || k === 'completion') {
        vals.push(v === null ? null : JSON.stringify(v));
      } else if (typeof v === 'boolean') {
        vals.push(v ? 1 : 0);
      } else {
        vals.push(v as never);
      }
    }
    if (!cols.length) return;
    this.db.prepare(`UPDATE deliverables SET ${cols.join(', ')} WHERE ref = ?`).run(...(vals as never[]), ref);
  }

  setState(ref: string, state: string, extra: Partial<Record<string, unknown>> = {}): void {
    this.patchDeliverable(ref, { state, state_since: now(), ...extra });
  }

  deliverablesWhere(sql: string, ...params: unknown[]): DeliverableRow[] {
    return (this.db.prepare(`SELECT * FROM deliverables WHERE ${sql}`).all(...(params as never[])) as Record<string, unknown>[])
      .map(r => this.rowToDeliverable(r));
  }

  // Number of open items whose depends_on includes ref (§11 unblocks-others).
  unblocksCount(ref: string): number {
    const r = this.db.prepare(`SELECT COUNT(*) c FROM deliverables d, json_each(d.depends_on) je
      WHERE je.value = ? AND d.state NOT IN ${EXITED}`).get(ref) as { c: number };
    return r.c;
  }

  // Live downstream items that would be stranded if ref left the working set.
  openDependents(ref: string): string[] {
    return (this.db.prepare(`SELECT DISTINCT d.ref FROM deliverables d, json_each(d.depends_on) je
      WHERE je.value = ? AND d.state NOT IN ${EXITED} ORDER BY d.ref`).all(ref) as { ref: string }[])
      .map(r => r.ref);
  }

  // Atomic claim: succeeds only if the item is still todo and unheld.
  tryClaim(ref: string, session: string): boolean {
    const r = this.db.prepare(`UPDATE deliverables
      SET owner_session = ?, state = 'in_progress', state_since = ?, elevated_release = 0
      WHERE ref = ? AND state = 'todo' AND owner_session IS NULL`).run(session, now(), ref);
    return r.changes === 1;
  }

  // ---- sessions ----

  insertSession(s: SessionRow): void {
    this.db.prepare(`INSERT INTO sessions (id, tool, host, project, parent_session, started_at, last_seen, current_item, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(s.id, s.tool, s.host, s.project, s.parent_session, s.started_at, s.last_seen, s.current_item, s.status);
  }

  getSession(id: string): SessionRow | null {
    return (this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined) ?? null;
  }

  // v1.0 §15: the fleet projection. Observations only — the caller decides what
  // "idle" means; the surface reports elapsed facts and never acts on them.
  listSessions(project?: string, includeEnded = false): SessionRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (project) { where.push('project = ?'); params.push(project); }
    if (!includeEnded) where.push(`status = 'active'`);
    const sql = `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at, id`;
    return this.db.prepare(sql).all(...(params as never[])) as unknown as SessionRow[];
  }

  touchSession(id: string, patch: Partial<Pick<SessionRow, 'current_item' | 'status'>> = {}): void {
    const cols = ['last_seen = ?'];
    const vals: unknown[] = [now()];
    if ('current_item' in patch) { cols.push('current_item = ?'); vals.push(patch.current_item); }
    if (patch.status) { cols.push('status = ?'); vals.push(patch.status); }
    this.db.prepare(`UPDATE sessions SET ${cols.join(', ')} WHERE id = ?`).run(...(vals as never[]), id);
  }

  // ---- events ----

  appendEvent(item: string, actor: string, kind: string, body: unknown): Event {
    const at = now();
    const r = this.db.prepare('INSERT INTO events (item, session, kind, body, at) VALUES (?, ?, ?, ?, ?)')
      .run(item, actor, kind, JSON.stringify(body ?? {}), at);
    return { seq: Number(r.lastInsertRowid), item, actor, session: actor, kind: kind as Event['kind'], body, at };
  }

  private rowToEvent(r: Record<string, unknown>): Event {
    const actor = r.session as string;   // column name predates the v1.0 rename
    return { seq: r.seq as number, item: r.item as string,
      actor, session: actor,             // `session` is the deprecated alias (§7.4)
      kind: r.kind as Event['kind'], body: JSON.parse(r.body as string), at: r.at as string };
  }

  eventsSince(item: string, cursor: number): Event[] {
    return (this.db.prepare('SELECT * FROM events WHERE item = ? AND seq > ? ORDER BY seq').all(item, cursor) as Record<string, unknown>[])
      .map(r => this.rowToEvent(r));
  }

  getEvent(seq: number): Event | null {
    const r = this.db.prepare('SELECT * FROM events WHERE seq = ?').get(seq) as Record<string, unknown> | undefined;
    return r ? this.rowToEvent(r) : null;
  }

  lastEventAt(item: string): string | null {
    const r = this.db.prepare('SELECT at FROM events WHERE item = ? ORDER BY seq DESC LIMIT 1').get(item) as { at: string } | undefined;
    return r?.at ?? null;
  }

  // Question events with no resolving decision: neither an answer naming their
  // seq nor a rejection targeting it (§12.2: a decision chooses and/or rejects —
  // a rejected question is decided, not open; D-21).
  openQuestions(item?: string): Event[] {
    const filter = item ? 'AND q.item = ?' : '';
    const params = item ? [item] : [];
    return (this.db.prepare(`SELECT q.* FROM events q WHERE q.kind = 'question' ${filter}
      AND NOT EXISTS (SELECT 1 FROM events a WHERE a.item = q.item AND a.kind = 'answer'
        AND json_extract(a.body, '$.question') = q.seq)
      AND NOT EXISTS (SELECT 1 FROM events r WHERE r.item = q.item AND r.kind = 'rejection'
        AND json_extract(r.body, '$.event') = q.seq)
      ORDER BY q.seq`).all(...(params as never[])) as Record<string, unknown>[])
      .map(r => this.rowToEvent(r));
  }

  // ---- policies ----

  insertPolicy(scope: string, type: string, text: string, provenance: unknown): Policy {
    const r = this.db.prepare('INSERT INTO policies (scope, type, text, provenance) VALUES (?, ?, ?, ?)')
      .run(scope, type, text, provenance ? JSON.stringify(provenance) : null);
    return { id: `pol-${r.lastInsertRowid}`, scope, type, text,
      provenance: (provenance as Policy['provenance']) ?? null, active: true };
  }

  private rowToPolicy(r: Record<string, unknown>): Policy {
    return { id: `pol-${r.n}`, scope: r.scope as string, type: r.type as string, text: r.text as string,
      provenance: r.provenance ? JSON.parse(r.provenance as string) : null, active: !!(r.active as number) };
  }

  activePolicies(scopes: string[]): Policy[] {
    const q = scopes.map(() => '?').join(', ');
    return (this.db.prepare(`SELECT * FROM policies WHERE active = 1 AND scope IN (${q}) ORDER BY n`).all(...(scopes as never[])) as Record<string, unknown>[])
      .map(r => this.rowToPolicy(r));
  }

  // Every active policy, in the same insertion order `activePolicies` returns.
  // `activePolicies` is the right question for ONE item and is what
  // `policy.applicable` answers; an attention page asking it once per row is
  // the N+1 read §15's projections exist to remove (finding O-8). Policies are
  // operator-written standing rules — tens, not thousands — so a projection
  // reads them once and joins on scope in memory.
  allActivePolicies(): Policy[] {
    return (this.db.prepare(`SELECT * FROM policies WHERE active = 1 ORDER BY n`).all() as Record<string, unknown>[])
      .map(r => this.rowToPolicy(r));
  }

  retirePolicy(id: string): boolean {
    const n = Number(id.replace(/^pol-/, ''));
    return this.db.prepare('UPDATE policies SET active = 0 WHERE n = ?').run(n).changes === 1;
  }

  // ---- reground diffs ----

  insertDiff(session: string, project: string, kind: 'completed' | 'in_flight', payload: unknown): string {
    const r = this.db.prepare('INSERT INTO reground_diffs (session, project, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(session, project, kind, JSON.stringify(payload), now());
    return `rg-${r.lastInsertRowid}`;
  }

  private rowToDiff(r: Record<string, unknown>): RegroundDiffRow {
    return { id: `rg-${r.n}`, session: r.session as string, project: r.project as string,
      kind: r.kind as RegroundDiffRow['kind'], payload: JSON.parse(r.payload as string),
      status: r.status as RegroundDiffRow['status'], reason: r.reason as string | null,
      created_at: r.created_at as string };
  }

  getDiff(id: string): RegroundDiffRow | null {
    const n = Number(id.replace(/^rg-/, ''));
    const r = this.db.prepare('SELECT * FROM reground_diffs WHERE n = ?').get(n) as Record<string, unknown> | undefined;
    return r ? this.rowToDiff(r) : null;
  }

  pendingDiffs(): RegroundDiffRow[] {
    return (this.db.prepare(`SELECT * FROM reground_diffs WHERE status = 'pending' ORDER BY n`).all() as Record<string, unknown>[])
      .map(r => this.rowToDiff(r));
  }

  resolveDiff(id: string, status: 'accepted' | 'rejected', reason?: string): void {
    const n = Number(id.replace(/^rg-/, ''));
    this.db.prepare('UPDATE reground_diffs SET status = ?, reason = ? WHERE n = ?').run(status, reason ?? null, n);
  }

  // ---- audit (§18 SHOULD log verb calls) ----

  logVerb(actor: string, verb: string, args: unknown): void {
    this.db.prepare('INSERT INTO verb_log (at, actor, verb, args) VALUES (?, ?, ?, ?)')
      .run(now(), actor, verb, JSON.stringify(args ?? {}));
  }
}

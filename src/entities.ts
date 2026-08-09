// The entity plane — customers, lanes, drivers, carriers.
//
// THE RULING (v1 synthesis §6: "entity records … rejected: vocabulary").
// Ridgeline has forty customers, sixty lanes, thirty drivers and two hundred
// carriers, and every one of them outlives every deliverable that mentions it.
// They are not protocol records and never will be. Two mechanisms already in
// the protocol carry them, doing different jobs:
//
//   - the REFERENCE is a link entry (§7.3) — typed, round-tripped, replaced
//     wholesale per type, and carrying enough (`id`, `name`, `page`) to render
//     a board row without a second read. §12.1's "decide from the card",
//     applied to entities.
//   - the RECORD is a knowledge page (§13.2) — living markdown, edited in
//     place, provenance from the git it lives in, read on demand.
//
// The volume argument is the decisive one. §1.4 requires the working set to
// SHRINK as work completes; an entity table grows monotonically with the
// business. A protocol that grew one would guarantee the opposite of the
// property it exists to protect. Completed loads leave the surface; ACME Foods
// does not, because ACME Foods was never on it.
//
// This module is the maintenance library; `tools/entities.ts` is its CLI.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type EntityKind = 'customer' | 'lane' | 'driver' | 'carrier';

export const ENTITY_KINDS: EntityKind[] = ['customer', 'lane', 'driver', 'carrier'];

// One directory per family; the directory name is also the link type's plural.
const DIRS: Record<EntityKind, string> = {
  customer: 'customers', lane: 'lanes', driver: 'drivers', carrier: 'carriers',
};

// The repo's own knowledge plane. A deployment points `project.knowledge_dir`
// here, which is the whole of the surface's involvement: it greps, and that is
// all it is ever allowed to do with it (§13.2).
export const KNOWLEDGE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'knowledge');

export interface Entity {
  kind: EntityKind;
  id: string;                        // ACME, DEN-SLC, D-114 — the id the desk speaks
  name: string;
  fields: Record<string, string>;    // credit terms, miles, endorsements, insurance…
  facts: string[];                   // standing facts: the negative knowledge lives here too
  body: string;                      // prose
  page: string;                      // repo-relative path — a protocol record never carries a host path
}

export interface EntityLink {
  id: string; name: string; page: string | null;
  [k: string]: unknown;              // link entries are envelopes: extend freely (§3)
}

const slug = (id: string) => id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const pagePath = (kind: EntityKind, id: string) => `knowledge/${DIRS[kind]}/${slug(id)}.md`;

// ---------- read ----------

export function parseEntity(text: string, kind: EntityKind, page: string): Entity {
  const lines = text.split('\n');
  const fields: Record<string, string> = {};
  const facts: string[] = [];
  const body: string[] = [];
  let name = '';
  let section = '';
  for (const line of lines) {
    if (line.startsWith('# ')) { name ||= line.slice(2).trim(); continue; }
    if (line.startsWith('## ')) { section = line.slice(3).trim().toLowerCase(); continue; }
    if (section === 'standing facts') {
      if (line.startsWith('- ')) facts.push(line.slice(2).trim());
      continue;
    }
    const m = /^([a-z][a-z0-9_]*):\s*(.*)$/.exec(line);
    if (m && !section) { fields[m[1]] = m[2].trim(); continue; }
    if (line.trim() || body.length) body.push(line);
  }
  const id = fields.id ?? '';
  // The H1 is the display name; `kind`/`id` are the page's identity, not fields.
  const display = fields.name ?? name;
  delete fields.id; delete fields.kind; delete fields.name;
  return { kind, id, name: display, fields, facts, body: body.join('\n').trim(), page };
}

export function serializeEntity(e: Entity): string {
  const head = [`# ${e.name}`, '', `kind: ${e.kind}`, `id: ${e.id}`];
  for (const [k, v] of Object.entries(e.fields)) head.push(`${k}: ${v}`);
  const parts = [head.join('\n')];
  if (e.body) parts.push(e.body);
  if (e.facts.length) parts.push(['## Standing facts', ...e.facts.map(f => `- ${f}`)].join('\n'));
  return parts.join('\n\n') + '\n';
}

// `root` is the knowledge directory; `page` is always reported repo-relative,
// because a link entry that travelled to an operator's browser must not carry
// a host filesystem path.
const absPath = (root: string, kind: EntityKind, id: string) => join(root, DIRS[kind], `${slug(id)}.md`);

export function readEntity(root: string, kind: EntityKind, id: string): Entity | null {
  const abs = absPath(root, kind, id);
  if (!existsSync(abs)) return null;
  return parseEntity(readFileSync(abs, 'utf8'), kind, pagePath(kind, id));
}

export function listEntities(root: string, kind: EntityKind): Entity[] {
  const dir = join(root, DIRS[kind]);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => parseEntity(readFileSync(join(dir, f), 'utf8'), kind, `knowledge/${DIRS[kind]}/${f}`))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ---------- write: edited IN PLACE, never appended (§13.2) ----------

export interface EntityPatch {
  kind: EntityKind; id: string; name?: string;
  fields?: Record<string, string>;
  body?: string;
  facts?: string[];                  // merged, deduped
  retire?: string[];                 // facts that stopped being true — the diff carries what they replaced
}

export function upsertEntity(root: string, patch: EntityPatch): Entity {
  const existing = readEntity(root, patch.kind, patch.id);
  const e: Entity = existing ?? {
    kind: patch.kind, id: patch.id, name: patch.name ?? patch.id,
    fields: {}, facts: [], body: '', page: pagePath(patch.kind, patch.id),
  };
  if (patch.name) e.name = patch.name;
  if (patch.fields) Object.assign(e.fields, patch.fields);
  if (patch.body !== undefined) e.body = patch.body;
  if (patch.facts) for (const f of patch.facts) if (!e.facts.includes(f)) e.facts.push(f);
  if (patch.retire) e.facts = e.facts.filter(f => !patch.retire!.includes(f));
  const abs = absPath(root, e.kind, e.id);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, serializeEntity(e));
  return e;
}

// ---------- the link plane ----------

// The entry a deliverable carries. `page` is repo-relative and `name` is
// denormalized on purpose: a board row must render without opening the
// knowledge plane, and a link entry the surface round-trips is the cheapest
// place in the protocol to put that.
export function entityLink(root: string, kind: EntityKind, id: string, extra: Record<string, unknown> = {}): EntityLink {
  const e = readEntity(root, kind, id);
  return e
    ? { id: e.id, name: e.name, page: e.page, ...extra }
    // An unknown party is honest, not an error: a prospect's first RFQ arrives
    // before anyone has written the page. Writing it is part of the work.
    : { id, name: id, page: null, unknown: true, ...extra };
}

export interface FreightSelection {
  customer?: string;
  lane?: string;
  driver?: string;
  carrier?: string;
  shipment?: Record<string, unknown>;              // tender id, revenue, miles, weight
  documents?: { name: string; url?: string }[];
  references?: Record<string, unknown>[];
  evidence?: { claim: string }[];
  tracking?: Record<string, unknown>[];
}

// One load composes customer AND lane AND driver at once — the §3 corollary
// ("do not partition what should compose") is the normal case here, not an
// edge: the entity families do different jobs on the same deliverable.
export function freightLinks(root: string, sel: FreightSelection): Record<string, unknown[]> {
  const links: Record<string, unknown[]> = {};
  if (sel.customer) links.customer = [entityLink(root, 'customer', sel.customer)];
  if (sel.lane) links.lane = [entityLink(root, 'lane', sel.lane)];
  if (sel.driver) links.driver = [entityLink(root, 'driver', sel.driver)];
  if (sel.carrier) links.carrier = [entityLink(root, 'carrier', sel.carrier)];
  if (sel.shipment) links.shipment = [sel.shipment];
  if (sel.documents) links.documents = sel.documents;
  if (sel.references) links.references = sel.references;
  if (sel.evidence) links.evidence = sel.evidence;
  if (sel.tracking) links.tracking = sel.tracking;
  return links;
}

// Hydrate a deliverable's links back into pages — what an agent does before it
// quotes a lane it has not run in a year.
export function resolveEntities(root: string, links: Record<string, unknown[]>): Partial<Record<EntityKind, Entity>> {
  const out: Partial<Record<EntityKind, Entity>> = {};
  for (const kind of ENTITY_KINDS) {
    const entry = (links[kind] ?? [])[0] as { id?: string } | undefined;
    if (!entry?.id) continue;
    const e = readEntity(root, kind, entry.id);
    if (e) out[kind] = e;
  }
  return out;
}

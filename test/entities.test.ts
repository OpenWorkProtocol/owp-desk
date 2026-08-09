// The entity plane. Customers, lanes, drivers and carriers are recurring
// business objects — the thing a trucking company has most of — and none of
// them is a protocol record. Links reference them; the knowledge plane holds
// them; the surface never learns the word "customer".
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  KNOWLEDGE, entityLink, freightLinks, listEntities, readEntity, resolveEntities, upsertEntity,
} from '../src/entities.ts';
import { ridgeline } from './surface.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'ridgeline-knowledge-'));

test('one load composes customer, lane, driver and carrier at once — and the surface knows none of them', () => {
  const { op, as, register } = ridgeline();
  const s = register();
  const links = freightLinks(KNOWLEDGE, {
    customer: 'ACME', lane: 'DEN-SLC', driver: 'D-114', carrier: 'C-ARROW',
    shipment: { tender: 'T8804', revenue_usd: 2450, miles: 525, weight_lb: 38000 },
    documents: [{ name: 'BOL-T8804.pdf' }],
  });
  const { ref } = as(s)('work.create', {
    item: { title: 'Load T8804 · ACME DEN-SLC', intent: "ACME's freight moves.", kind: 'load', links },
    dispatch: true,
  });

  // Four entity families on one deliverable, each doing a different job — the
  // §3 corollary ("do not partition what should compose") is the normal case
  // on a freight desk, not an edge.
  const stored = op('work.view', { ref }).deliverable.links;
  assert.deepEqual(Object.keys(stored).sort(),
    ['carrier', 'customer', 'documents', 'driver', 'lane', 'shipment']);
  assert.equal(stored.customer[0].id, 'ACME');
  assert.equal(stored.customer[0].name, 'ACME Foods');
  assert.equal(stored.lane[0].page, 'knowledge/lanes/den-slc.md');

  // The link entry renders a board row on its own (§12.1 applied to entities);
  // the page is only opened when judgment needs it.
  const hydrated = resolveEntities(KNOWLEDGE, stored);
  assert.equal(hydrated.lane!.fields.miles, '525');
  assert.match(hydrated.lane!.facts[0], /Chains are required over Vail/);
  assert.match(hydrated.driver!.facts[1], /03:00 appointment/);

  // The surface round-trips a type it has never heard of, and one nobody has
  // registered anywhere (§19 must-preserve).
  as(s)('work.claim', { ref });
  as(s)('work.update', { ref, links: { escort: [{ permit: 'CO-88213', note: 'oversize on the return leg' }] } });
  assert.equal(op('work.view', { ref }).deliverable.links.escort[0].permit, 'CO-88213');
  // …and the published vocabulary is where a stranger client learns the rest.
  const vocab = op('surface.describe').projects[0].vocabulary;
  assert.ok(vocab.link_types.includes('lane'));
  assert.ok(vocab.kinds.includes('booking'));
});

test('the knowledge plane is the entity record: the surface only greps it, and pages are edited in place', () => {
  const { as, register } = ridgeline();
  const s = register();

  // §13.2's thin retrieval, doing exactly the job it is meant to do: the desk
  // asks the plane a question before it quotes a lane it has not run lately.
  const hits = as(s)('knowledge.query', { q: 'chains are required' });
  assert.equal(hits.results.length, 1);
  assert.match(hits.results[0].file, /lanes\/den-slc\.md$/);

  // Edited in place — never appended. A fact that stops being true LEAVES the
  // page; the git diff carries what it replaced, which is the whole of the
  // supersession model the protocol deliberately does not have.
  const root = scratch();
  try {
    upsertEntity(root, { kind: 'carrier', id: 'C-BLKM', name: 'Black Mesa Logistics',
      fields: { rating: 'conditional' }, facts: ['certificate verified annually'] });
    upsertEntity(root, { kind: 'carrier', id: 'C-BLKM', fields: { rating: 'suspended' },
      facts: ['certificate lapsed mid-contract on T8841'], retire: ['certificate verified annually'] });
    const page = readFileSync(join(root, 'carriers', 'c-blkm.md'), 'utf8');
    assert.equal(page.match(/rating:/g)!.length, 1);          // in place, not appended
    assert.ok(!page.includes('verified annually'));           // the retired fact is gone from the page
    const e = readEntity(root, 'carrier', 'C-BLKM')!;
    assert.equal(e.fields.rating, 'suspended');
    assert.deepEqual(e.facts, ['certificate lapsed mid-contract on T8841']);
    assert.equal(listEntities(root, 'carrier').length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('replace-wholesale: independent writers on different link types compose; on the same type, one wins', () => {
  const { op, as, register, gateway } = ridgeline();
  const s = register();
  const { ref } = as(s)('work.create', {
    item: { title: 'Load T8850 · PWG DEN-ABQ', intent: 'Grain moves.', kind: 'load',
      links: freightLinks(KNOWLEDGE, { customer: 'PWG', lane: 'DEN-ABQ', documents: [{ name: 'EDI204-T8850' }] }) },
    dispatch: true,
  });
  as(s)('work.claim', { ref });

  // Dispatch assigns a driver; telematics reports position. Different types,
  // different writers, no coordination needed (§7.3).
  as(s)('work.update', { ref, links: { driver: [entityLink(KNOWLEDGE, 'driver', 'D-127')] } });
  gateway('work.update', { ref, links: { tracking: [{ position: 'Trinidad CO', observed_at: new Date().toISOString() }] } });
  const links = op('work.view', { ref }).deliverable.links;
  assert.equal(links.driver[0].id, 'D-127');
  assert.equal(links.tracking[0].position, 'Trinidad CO');
  assert.equal(links.customer[0].id, 'PWG');                  // untouched types round-trip

  // Same type, two writers: the second write replaces the array wholesale and
  // the first writer's entry is gone. This is the spec working as written —
  // per-entry merge would need the surface to know an entry's identity key,
  // which is vocabulary. The remedy is the one §7.3 names: the client holds
  // the complete set in its own memory, or the deployment models finer items.
  gateway('work.update', { ref, links: { documents: [{ name: 'POD-T8850.pdf' }] } });
  assert.deepEqual(op('work.view', { ref }).deliverable.links.documents, [{ name: 'POD-T8850.pdf' }]);
});

test('an unknown party is honest: a prospect links as a stub, and the work that meets them writes the page', () => {
  const root = scratch();
  try {
    const { op, as, register } = ridgeline();
    const s = register();
    const stub = entityLink(root, 'customer', 'VERDE');
    assert.deepEqual(stub, { id: 'VERDE', name: 'VERDE', page: null, unknown: true });

    const { ref } = as(s)('work.create', {
      item: { title: 'Quote R9200 · VERDE DEN-ABQ', intent: 'A prospect gets a real number.', kind: 'quote',
        links: { customer: [stub], lane: [entityLink(KNOWLEDGE, 'lane', 'DEN-ABQ')] } },
      dispatch: true,
    });
    as(s)('work.claim', { ref });

    // Meeting a customer is how the entity plane grows: the work writes the
    // page, and the completion record says which page it edited.
    upsertEntity(root, { kind: 'customer', id: 'VERDE', name: 'Verde Produce',
      fields: { status: 'prospect', terms: 'prepay until credit is run' },
      facts: ['Reefer only — Ridgeline brokers this to Arrow rather than running it'] });
    as(s)('work.update', { ref, links: { customer: [entityLink(root, 'customer', 'VERDE')] } });
    as(s)('work.complete', { ref, record: {
      outcome: 'Quoted Verde Produce DEN-ABQ at $2.60/mi reefer, brokered to Arrow. Prepay until credit is run.',
      now_true: ['VERDE is a live prospect with a page'],
      knowledge_edits: ['knowledge/customers/verde.md'],
    } });

    const link = op('work.view', { ref }).deliverable.links.customer[0];
    assert.equal(link.name, 'Verde Produce');
    assert.equal(link.page, 'knowledge/customers/verde.md');
    assert.equal(link.unknown, undefined);
    assert.match(op('work.view', { ref }).completion.knowledge_edits[0], /verde/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

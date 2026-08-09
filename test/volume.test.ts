// THE VOLUME TEST. Every other world in the set is deep; this one is wide.
// A freight desk takes a couple of hundred inbound documents a day, most of
// them boring, a handful of them consequential, and the whole question is
// whether OWP survives that without either drowning the operator or quietly
// losing something.
//
// Two hundred and eighteen inbound documents become two hundred and eight
// deliverables, worked by one operator, six sessions and one review bot. What
// broke here was reported rather than patched: D-4, closed by §15's keyset
// cursor and asserted below, and D-5, still open.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refFor, runInbound, syntheticDay, type Inbound } from '../src/inbound.ts';
import { emptyState } from '../src/watcher.ts';
import { ridgeline, type World } from './surface.ts';

const DAY: Inbound[] = syntheticDay({ tenders: 120, spot: 60, rfq: 20, mail: 8, status: 10 });
const DISPATCHED = 120;                 // contract tenders go straight to the board
const PROPOSED = 88;                    // spot tenders + RFQs + back-office mail need a human

async function day(): Promise<World> {
  const w = ridgeline();
  const { actions } = await runInbound(w.gateway, 'RIDGE', DAY, emptyState());
  assert.equal(actions.length, DAY.length);
  return w;
}

// A page of the operator's queue, always from the head — see D-4.
const head = (w: World, limit = 25) => w.op('attention', { project: 'RIDGE', limit });

test('a day of inbound arrives as work wearing this world\'s words, and arriving twice changes nothing', async () => {
  const w = ridgeline();
  const state = emptyState();
  const first = await runInbound(w.gateway, 'RIDGE', DAY, state);
  assert.equal(first.actions.length, DAY.length);

  const port = w.op('portfolio', { project: 'RIDGE' })[0];
  assert.equal(port.working_set, DISPATCHED + PROPOSED);
  assert.equal(port.todo.length, DISPATCHED);
  assert.equal(port.proposed.length, PROPOSED);

  // D-1 closed. Nothing on this board is an ops `verify` — and nothing was
  // laundered into freight after the fact either. The borrowed watcher created
  // these wearing this world's words because the OBSERVATION carried them;
  // there is no longer a decorator between this desk and `work.create`.
  const kinds = new Set(Object.values(first.created).map(ref => w.op('work.view', { ref }).deliverable.kind));
  assert.deepEqual([...kinds].sort(), ['errand', 'load', 'quote']);

  // Every load carries its entities, straight off the knowledge plane.
  const tender = (DAY.find(i => i.channel === 'edi' && i.set === '204') as any).tender as string;
  // …and the desk finds the work by the DOCUMENT that caused it — the tender
  // id, which is the observation's own identity — never by matching a title.
  const ref = refFor(first.created, `tender:${tender}`, tender);
  assert.match(ref, /^RIDGE-\d+$/);
  const load = w.op('work.view', { ref }).deliverable;
  assert.equal(load.kind, 'load');
  assert.equal(load.priority, 2, 'a $4k+ tender is steered up at creation, on the observation');
  assert.ok(load.links.customer[0].id);
  assert.ok(load.links.lane[0].page.startsWith('knowledge/lanes/'));
  assert.equal(load.links.shipment[0].tender, tender);

  // The feed re-delivers all day. The watcher's own cursor — not a surface
  // read — is what makes the second pass free (§5).
  const second = await runInbound(w.gateway, 'RIDGE', DAY, state);
  assert.equal(second.actions.filter(a => /proposed|dispatched/.test(a)).length, 0);
  assert.equal(w.op('portfolio', { project: 'RIDGE' })[0].working_set, DISPATCHED + PROPOSED);
});

test('bounded attention walks a static queue exactly once — the §15 guarantee, at depth', async () => {
  const w = await day();
  const whole = (w.op('attention', { project: 'RIDGE' }) as any).rows;
  assert.equal(whole.length, PROPOSED);

  const walked: string[] = [];
  let cursor: string | undefined, more = true, pages = 0;
  while (more) {
    const page = w.op('attention', { project: 'RIDGE', limit: 25, ...(cursor ? { cursor } : {}) });
    walked.push(...page.rows.map((r: any) => r.target));
    cursor = page.cursor; more = page.more; pages++;
    assert.equal(page.total, PROPOSED);
  }
  assert.equal(pages, 4);
  assert.equal(walked.length, PROPOSED);
  assert.equal(new Set(walked).size, PROPOSED);                     // no repeats
  assert.deepEqual(walked, whole.map(r => r.target));               // and no reordering
});

test('D-4 resolved: the cursor is a PLACE — paging while clearing loses nothing', async () => {
  const w = await day();
  const queue = (w.op('attention', { project: 'RIDGE' }) as any).rows.map((r: any) => r.target);

  const page0 = w.op('attention', { project: 'RIDGE', limit: 25 });
  assert.deepEqual(page0.rows.map((r: any) => r.target), queue.slice(0, 25));

  // The operator does what an operator does with a page of routine tenders:
  // clears ten of them, then asks for the next page.
  for (const target of queue.slice(0, 10)) w.op('triage', { target, decision: 'accept' });
  const page1 = w.op('attention', { project: 'RIDGE', limit: 25, cursor: page0.cursor });

  // With an INDEX cursor the queue shifted underneath it and rows 25–34 were
  // silently jumped. §15 now requires a KEYED cursor — an opaque token naming
  // the last row served — so the same ten clearances cost nothing: page 1
  // resumes exactly after the row page 0 ended on.
  const seen = new Set([...page0.rows, ...page1.rows].map((r: any) => r.target));
  const skipped = queue.slice(25, 35).filter((t: string) => !seen.has(t));
  assert.deepEqual(skipped, [], 'a keyed cursor loses nothing when the operator clears while paging');

  // The head-only workaround Ridgeline used to need still works, and is now a
  // preference rather than a correctness requirement.
  const nothingSkipped = new Set<string>();
  let guard = 0;
  for (;;) {
    const page = head(w);
    if (!page.rows.length || guard++ > 20) break;
    for (const r of page.rows) { nothingSkipped.add(r.target); w.op('triage', { target: r.target, decision: 'accept' }); }
  }
  assert.equal(nothingSkipped.size, PROPOSED - 10);                 // the rest, every one of them
  assert.equal(w.op('attention', { project: 'RIDGE' }).rows.length, 0);
});

test('the operator clears a day from the head: bounded pages, one gesture per row, nothing lost', async () => {
  const w = await day();
  const cleared = new Set<string>();
  let pages = 0;
  for (;;) {
    const page = head(w);
    if (!page.rows.length) break;
    pages++;
    for (const row of page.rows) {
      assert.ok(!cleared.has(row.target), `${row.target} came round twice`);
      cleared.add(row.target);
      // Everything needed to decide is on the row — §15's obligation, and for
      // a tender that means the money and the evidence, not just a title.
      const p = row.detail.proposal;
      assert.ok(p.links.evidence.length >= 1);
      if (p.kind === 'load') assert.ok(p.links.shipment[0].revenue_usd > 0 && p.links.customer[0].id);
      const spot = p.links.evidence.some((e: any) => /spot tender/.test(e.claim));
      if (spot && p.links.shipment?.[0]?.revenue_usd < 1500) {
        w.op('triage', { target: row.target, decision: 'reject', reason: 'below the lane floor; we do not run this cheap', continuation: 'record-only' });
      } else {
        w.op('triage', { target: row.target, decision: 'accept' });
      }
    }
  }
  assert.equal(cleared.size, PROPOSED);
  assert.ok(pages <= Math.ceil(PROPOSED / 25) + 1, `${pages} pages for ${PROPOSED} rows`);
  assert.equal(w.op('attention', { project: 'RIDGE' }).rows.length, 0);
  // Rejections are not deletions: the reason survives as negative knowledge.
  const port = w.op('portfolio', { project: 'RIDGE' })[0];
  assert.ok(port.working_set < DISPATCHED + PROPOSED);
});

test('FINDING D-5: a bounded page is bounded on the wire, not on the surface', async (t) => {
  const w = await day();
  // A second feed lands on top of the first — a Monday after a long weekend.
  await runInbound(w.gateway, 'RIDGE', syntheticDay({ spot: 60, rfq: 20, mail: 8 }, 11), emptyState());

  const timeFirstPage = (n: number) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) w.op('attention', { project: 'RIDGE', limit: 25 });
    return (performance.now() - t0) / n;
  };
  const sample = () => {
    const rows = (w.op('attention', { project: 'RIDGE' }) as any[]).rows.map(r => r.target);
    return { depth: rows.length, ms: timeFirstPage(20), rows };
  };

  // Always the SAME first page of 25; only the queue behind it changes.
  const points: { depth: number; ms: number }[] = [];
  for (let s = sample(); ; s = sample()) {
    points.push({ depth: s.depth, ms: s.ms });
    if (s.depth <= 30) break;
    for (const target of s.rows.slice(0, 60)) w.op('triage', { target, decision: 'accept' });
  }
  t.diagnostic(`attention(limit:25), same first page — ${points.map(p => `${p.depth} rows: ${p.ms.toFixed(2)}ms`).join(' · ')}`);

  // The same first page costs materially more when the queue behind it is
  // longer: the surface builds every row, sorts them, and then slices. §15
  // bounded the RESPONSE in v1.0; the work is still O(queue), and each triage
  // row re-reads its item's whole worklog to decide whether it was sent back.
  // At two hundred rows nobody notices. The shape is the point, and the fix is
  // the keyed cursor D-4 already wants — a cursor a surface can seek from.
  assert.ok(points[0].ms > points[points.length - 1].ms,
    `expected the deeper queue to cost more (${points[0].ms.toFixed(2)} vs ${points[points.length - 1].ms.toFixed(2)})`);
  assert.ok(points[0].depth > 150);
});

test('six sessions drain the board exactly once, the bot clears the reviews, and the day ends smaller than it started', async () => {
  const w = await day();
  const before = w.op('portfolio', { project: 'RIDGE' })[0].working_set;
  const sessions = Array.from({ length: 6 }, () => w.register());

  // Atomic claim-on-next, under contention, at depth: no item is handed to two
  // sessions and none is left behind.
  const taken: string[] = [];
  for (let quiet = false; !quiet;) {
    quiet = true;
    for (const s of sessions) {
      const a = w.as(s)('work.next');
      if (!a) continue;
      quiet = false;
      taken.push(a.deliverable.ref);
      w.as(s)('event.append', { ref: a.deliverable.ref, kind: 'progress', body: { text: 'dispatched, driver assigned, appointment set' } });
      w.as(s)('work.complete', { ref: a.deliverable.ref, record: { outcome: `${a.deliverable.title} moved; POD in; invoice raised.` } });
    }
  }
  assert.equal(taken.length, DISPATCHED);
  assert.equal(new Set(taken).size, DISPATCHED);

  // Revenue first: the declared tiebreak held all the way down a 120-item board.
  const revenue = (ref: string) => w.op('work.view', { ref }).deliverable.links.shipment[0].revenue_usd as number;
  const firstSix = taken.slice(0, 6).map(revenue);
  const lastSix = taken.slice(-6).map(revenue);
  assert.ok(Math.min(...firstSix) > Math.max(...lastSix));

  // One hundred and twenty reviews, none of which the human should ever see.
  // The rate desk holds a triage grant scoped to review items in this project,
  // and — because §18 forbids deciding your own output — could not have
  // cleared a single one of these had it done the work itself.
  const bot = w.register('rate-desk');
  const reviews = (w.op('attention', { project: 'RIDGE' }) as any[]).rows.filter(r => r.kind === 'review');
  assert.equal(reviews.length, DISPATCHED);
  for (const r of reviews) w.rateDesk(bot)('triage', { target: r.target, decision: 'accept' });

  // §1.4: a productive day makes the surface SMALLER. Measured, at volume.
  const after = w.op('portfolio', { project: 'RIDGE' })[0].working_set;
  assert.equal(before, DISPATCHED + PROPOSED);
  assert.equal(after, PROPOSED);
  assert.equal((w.op('attention', { project: 'RIDGE' }) as any[]).rows.filter(r => r.kind === 'review').length, 0);
});

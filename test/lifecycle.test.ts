// Ridgeline Freight's spine: quote → booking → invoice, the authority policy
// at the moments that cost money, and the structural steering a freight desk
// does all day. Against the unchanged reference surface.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KNOWLEDGE, freightLinks, readEntity } from '../src/entities.ts';
import { HANDOFF, ridgeline } from './surface.ts';

const AUTHORITY =
  'Quotes at or above the lane tariff: send, and note the rate. Below tariff, or any accessorial waiver: ask. ' +
  'Carrier commitments under $2,000: book. At or above $2,000, or any carrier whose insurance certificate is not verified: ask with options. ' +
  'Claims: pay under $500 from the record; above that, ask. Never admit liability without an explicit answer.';

// ---------- 1. the chain ----------

test('the chain: a won quote BECOMES a booking — a new deliverable, never a mutation', () => {
  const { op, as, register } = ridgeline();
  const s = register();
  const links = freightLinks(KNOWLEDGE, {
    customer: 'ACME', lane: 'DEN-SLC', documents: [{ name: 'RFQ-R9107.pdf' }],
  });

  const { ref: quote } = as(s)('work.create', {
    item: { title: 'Quote R9107 · ACME DEN-SLC', intent: 'ACME gets a rate we can actually run at.', kind: 'quote', links },
    dispatch: true,
  });
  as(s)('work.claim', { ref: quote });
  as(s)('event.append', { ref: quote, kind: 'progress', body: { text: 'priced off the DEN-SLC page: 525 mi, tariff $2.35/mi, backhaul thin' } });
  const q = as(s)('event.append', {
    ref: quote, kind: 'question',
    body: {
      prompt: 'ACME wants 2 loads/week at a committed rate. Three rates, three different bets.',
      options: [
        { id: 'A', label: '$2.35/mi — the tariff', tradeoff: 'no volume concession', evidence: [{ claim: 'the March rate review set $2.35; three mid-year increases have been refused' }] },
        { id: 'B', label: '$2.28/mi committed 2/wk', tradeoff: 'gives up 3% for volume', evidence: [{ claim: 'two committed loads/week fills the Tuesday and Thursday slots D-114 already runs' }] },
        { id: 'C', label: '$2.15/mi', tradeoff: 'wins the lane, loses the margin', evidence: [{ claim: 'below the SLC-BOI triangle economics; standalone legs on this book have lost money twice' }] },
      ],
    },
  });
  op('answer', { ref: quote, question: q.seq, choice: 'B', text: 'B. Two committed slots are worth 3%. Never C.' });
  as(s)('work.complete', {
    ref: quote,
    record: {
      outcome: 'Quoted ACME DEN-SLC at $2.28/mi committed to 2 loads/week; ACME accepted on the portal.',
      now_true: ['ACME DEN-SLC committed rate is $2.28/mi for 2 loads/week'],
      rejected: [{ what: '$2.15/mi', reason: 'below the triangle economics; standalone legs lose money' }],
      knowledge_edits: ['knowledge/customers/acme.md'],
    },
  });

  // The win does NOT edit the quote. A booking is a promise we made; a quote is
  // a document we sent. Two records, chained by depends_on and references.
  const { ref: booking } = as(s)('work.create', {
    item: {
      title: 'Booking B4471 · ACME DEN-SLC ×2/wk', intent: 'The committed slots run and nobody has to re-agree the rate.',
      kind: 'booking', depends_on: [quote],
      links: freightLinks(KNOWLEDGE, {
        customer: 'ACME', lane: 'DEN-SLC', driver: 'D-114',
        shipment: { tender: 'B4471', revenue_usd: 2450, miles: 525, weight_lb: 38000 },
        references: [{ ref: quote }],
      }),
    },
    dispatch: true,
  });
  const { ref: invoice } = as(s)('work.create', {
    item: {
      title: 'Invoice B4471 · ACME', intent: 'ACME pays for what moved, with the paperwork attached.',
      kind: 'invoice', depends_on: [booking],
      links: freightLinks(KNOWLEDGE, { customer: 'ACME', references: [{ ref: booking }] }),
    },
    dispatch: true,
  });

  // The chain is enforced by the CHOOSER, not by a workflow engine: nothing
  // downstream is eligible while its predecessor is still in review.
  assert.equal(as(register())('work.next'), null);
  assert.throws(() => as(s)('work.claim', { ref: invoice }), /unmet dependencies/);

  op('triage', { target: quote, decision: 'accept' });                 // the quote exits
  assert.equal(as(register())('work.next').deliverable.ref, booking);  // the booking is now the work

  // The quote is untouched by the booking's existence — same title, same kind,
  // its own completion record, and the reason we did not run $2.15 is still on
  // the record next to the rate we won.
  const settled = op('work.view', { ref: quote });
  assert.equal(settled.deliverable.kind, 'quote');
  assert.equal(settled.deliverable.title, 'Quote R9107 · ACME DEN-SLC');
  assert.match(settled.completion.rejected[0].reason, /triangle economics/);
  assert.deepEqual(op('work.view', { ref: booking }).deliverable.links.references, [{ ref: quote }]);

  // …and the invoice waits on the booking exactly as the booking waited on the quote.
  const b = as(register())('work.next');
  assert.equal(b, null);                                               // booking is held by the previous session
  const owner = op('work.view', { ref: booking }).deliverable.owner_session;
  as(owner)('work.complete', { ref: booking, record: { outcome: 'Both slots ran; PODs in.', now_true: ['B4471 delivered'] } });
  op('triage', { target: booking, decision: 'accept' });
  assert.equal(as(register())('work.next').deliverable.ref, invoice);
});

// ---------- 2. graduated authority ----------

test('graduated authority: the tariff quote goes out on a note; the carrier commit asks, and asking does not stop the load', () => {
  const { op, as, register } = ridgeline();
  op('policy.set', { scope: 'RIDGE', type: 'authority', text: AUTHORITY });
  op('policy.set', { scope: 'RIDGE', type: 'tariff', text: 'Lane tariffs live on the lane pages in knowledge/lanes. The page is the rate; the quote is the exception.' });
  const s = register();
  const { ref } = as(s)('work.create', {
    item: {
      title: 'Load T8841 · NORLIT DEN-ABQ', intent: "Norlight's flatbed moves and the tarp gets billed.",
      kind: 'load',
      links: freightLinks(KNOWLEDGE, {
        customer: 'NORLIT', lane: 'DEN-ABQ',
        shipment: { tender: 'T8841', revenue_usd: 2940, miles: 448, weight_lb: 41000 },
      }),
    },
    dispatch: true,
  });
  as(s)('work.claim', { ref });

  // The policy is consulted at the decision point, not at the top of the shift.
  const authority = as(s)('policy.applicable', { ref }).filter((p: any) => p.type === 'authority');
  assert.equal(authority.length, 1);
  assert.match(authority[0].text, /\$2,000/);

  // Under the line: the desk acts, and the note IS the audit.
  as(s)('event.append', { ref, kind: 'note', body: { text: 'tarp billed at $75 per the NORLIT page (under authority; no ask)' } });

  // Over the line: a carrier commitment at $2,940, and one of the candidates
  // carries a standing fact that is exactly why this question exists. The
  // evidence comes off the carrier pages — the knowledge plane feeding §12.1.
  const blkm = readEntity(KNOWLEDGE, 'carrier', 'C-BLKM')!;
  const arrow = readEntity(KNOWLEDGE, 'carrier', 'C-ARROW')!;
  const q = as(s)('event.append', {
    ref, kind: 'question',
    body: {
      prompt: 'Flatbed capacity for T8841 — $2,940 commitment, over my authority.',
      options: [
        { id: 'A', label: 'Arrow Transfer — $2,940', tradeoff: 'preferred, costs the margin', evidence: [{ claim: `${arrow.name}: ${arrow.fields.insurance}` }, { claim: arrow.facts[0] }] },
        { id: 'B', label: 'Black Mesa — $2,610', tradeoff: '$330 cheaper, certificate unverified', evidence: [{ claim: blkm.facts[0] }] },
        { id: 'C', label: 'Our own D-127 next Tuesday', tradeoff: 'free, two days late', evidence: [{ claim: 'Norlight will not load after 16:00 Friday; Tuesday is the next honest slot' }] },
      ],
    },
  });
  assert.match(op('attention').rows.find((r: any) => r.kind === 'decision').detail.body.options[1].evidence[0].claim, /certificate has lapsed/);

  // A question never parks the item: the load keeps moving on everything the
  // answer does not touch.
  as(s)('event.append', { ref, kind: 'progress', body: { text: 'appointment confirmed for 08:00; tarps staged' } });
  assert.equal(op('work.view', { ref }).deliverable.state, 'in_progress');

  op('answer', { ref, question: q.seq, choice: 'A', text: 'A. Verify Black Mesa properly before we use them again.' });
  as(s)('work.complete', {
    ref,
    record: {
      outcome: 'T8841 committed to Arrow Transfer at $2,940 after the explicit answer; tarp billed at $75.',
      friction: ['Black Mesa quoted $330 under Arrow and could not produce a current cargo certificate inside two hours'],
      now_true: ['T8841 is on Arrow, picking up 08:00'],
      rejected: [{ what: 'Black Mesa at $2,610', reason: 'cargo certificate unverified at the commit moment' }],
      knowledge_edits: ['knowledge/carriers/c-blkm.md'],
    },
  });
  assert.equal(op('attention').rows.find((r: any) => r.kind === 'review').target, ref);
});

// ---------- 3. structure moves; voice does not ----------

test('steering: urgency, intent and dependencies are restatable — status_line stays with the owner', () => {
  const { op, as, register } = ridgeline();
  const s = register();
  const mk = (title: string, revenue: number) => as(s)('work.create', {
    item: { title, intent: 'It moves.', kind: 'load',
      links: freightLinks(KNOWLEDGE, { customer: 'PWG', lane: 'DEN-SLC', shipment: { tender: title, revenue_usd: revenue, miles: 525 } }) },
    dispatch: true,
  }).ref as string;
  const small = mk('T9001', 1400);
  const big = mk('T9002', 4800);

  // Revenue-first: the declared tiebreak hands out the money before the rest.
  const a = register();
  assert.equal(as(a)('work.next').deliverable.ref, big);

  // Then the customer calls: T9001 is now a hot load. Urgency is ASSIGNED —
  // owp-desk filed that this was unassignable after creation in v0.3; v1.0's
  // work.reprioritize is that finding cashed.
  op('work.reprioritize', { ref: small, urgency: 'blocking' });
  const third = mk('T9003', 9000);
  assert.equal(as(register())('work.next').deliverable.ref, small);   // urgency outranks the money
  assert.equal(as(register())('work.next').deliverable.ref, third);

  // Purpose narrows: one tender becomes the whole week's commitment.
  op('work.update', { ref: small, intent: "PWG's harvest week moves on time — all five loads, not just this one." });
  assert.match(op('work.view', { ref: small }).deliverable.intent, /harvest week/);

  // Ordering is discovered mid-flight: the invoice cannot go until the claim
  // settles, and the operator says so structurally rather than in prose.
  const claim = as(s)('work.create', { item: { title: 'Claim C4801 · PWG shortage', intent: 'The shortage is settled honestly.', kind: 'claim' }, dispatch: true }).ref;
  op('work.update', { ref: third, depends_on: [claim] });
  assert.deepEqual(op('work.view', { ref: third }).deliverable.depends_on, [claim]);

  // …but the record's VOICE is not the operator's to write.
  assert.throws(() => op('work.update', { ref: small, status_line: 'looks fine to me' }), /status_line/);
});

// ---------- 4. the claim: documents, a park, and a trigger that is not ours ----------

test('a claim runs on documents, parks on the carrier, and releases through the gateway that owns the trigger', async () => {
  const { op, as, register, gateway, portal } = ridgeline();
  const { runInbound } = await import('../src/inbound.ts');
  const { emptyState } = await import('../src/watcher.ts');
  const s = register();
  const { ref } = as(s)('work.create', {
    item: {
      title: 'Claim C4801 · ACME shortage DEN-SLC', intent: 'The shortage is settled honestly and the customer stays.',
      kind: 'claim',
      links: freightLinks(KNOWLEDGE, {
        customer: 'ACME', lane: 'DEN-SLC', carrier: 'C-ARROW',
        documents: [{ name: 'BOL-T8804-signed.pdf' }, { name: 'dock-photos.zip' }],
      }),
    },
    dispatch: true,
  });
  as(s)('work.claim', { ref });
  as(s)('event.append', { ref, kind: 'progress', body: { text: 'BOL shows 22 pallets signed at origin, 21 at destination; claim filed with Arrow' } });
  as(s)('work.park', {
    ref,
    park: {
      cause: 'external', trigger: 'claim:C4801 carrier response',
      handoff: HANDOFF({
        why: 'Arrow owns the next move and their adjuster runs on their clock',
        state_so_far: 'claim filed with Arrow, BOL + dock photos attached, ACME told we are on it',
        resume_point: 'read the adjuster letter before offering anything',
        on_release: 'if Arrow accepts: credit ACME and close; if they deny: escalate-human, this is a relationship call',
      }),
    },
  });
  assert.equal(as(s)('work.next'), null);                       // waiting never holds an agent

  // "Parked 9 days" is a FACT in the operator's queue, never an alarm.
  const row = op('attention').rows.find((r: any) => r.target === ref);
  assert.match(row.reason, /parked \(external\)/);
  assert.equal(row.action, 'unpark');

  // Each feed owns exactly one trigger family. The EDI gateway cannot release
  // a claim, and neither of them can touch a customer mailbox park — the
  // surface enforces the scope, not the client's good manners.
  assert.throws(() => gateway('work.unpark', { trigger: 'customer:ACME' }), /grant does not cover/);
  assert.throws(() => gateway('work.unpark', { trigger: 'claim:C4801' }), /grant does not cover/);

  // The adjuster's paperwork lands in the portal: inbound → observation →
  // owp-ops's watcher → release. Same mechanics as a maintenance window.
  const { actions } = await runInbound(portal, 'RIDGE',
    [{ channel: 'portal', form: 'claim-document', claim: 'C4801', document: 'arrow-adjuster-letter.pdf' }], emptyState());
  assert.match(actions[0], new RegExp(`released ${ref}`));

  // Any session resumes, from the handoff, at elevated rank.
  const resumed = as(register())('work.next');
  assert.equal(resumed.deliverable.ref, ref);
  const unparked = resumed.worklog.find((e: any) => e.kind === 'unparked');
  assert.match(unparked.body.park.handoff.on_release, /escalate-human/);
  assert.match(unparked.body.note, /arrow-adjuster-letter/);
});

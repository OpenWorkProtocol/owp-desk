// Back-office volume is the reason to delegate: nobody wants a human eyeballing
// four hundred routine invoices a week. §18's grants make that safe, and this
// is where a freight desk actually leans on the invariant no deployment can
// write for itself — no actor may decide its own output.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KNOWLEDGE, freightLinks } from '../src/entities.ts';
import { RIDGELINE_VOCABULARY, ridgeline } from './surface.ts';

test('discovery: every client learns its own authority and this world\'s words before it acts', () => {
  const { op, as, register, rateDesk, gateway } = ridgeline();

  const desk = op('surface.describe');
  assert.equal(desk.protocol.version, '1.0-rc2');
  assert.equal(desk.authority.class, 'operator');
  assert.equal(desk.authority.session, null);
  const project = desk.projects.find((p: any) => p.key === 'RIDGE');
  assert.deepEqual(project.vocabulary, RIDGELINE_VOCABULARY);
  assert.deepEqual(project.rank_tiebreak, { kind: 'link-number', type: 'shipment', field: 'revenue_usd', direction: 'desc' });
  assert.ok(desk.features.rank_tiebreak_kinds.includes('link-number'));
  assert.equal(desk.features.knowledge_query, 'grep');       // the entity plane is greppable, and says so

  // The rate desk reads its OWN grant rather than discovering it by eating a
  // FORBIDDEN — which is the entire reason §9 reports the caller's authority.
  const s = register('rate-desk');
  const bot = rateDesk(s)('surface.describe');
  assert.equal(bot.authority.class, 'agent');
  assert.deepEqual(bot.authority.grants, [{ verbs: ['triage'], project: 'RIDGE', states: ['review'] }]);
  assert.equal(bot.authority.session.project, 'RIDGE');

  // An ordinary session holds nothing extra; the EDI feed holds one prefix.
  assert.deepEqual(as(register())('surface.describe').authority.grants, []);
  assert.deepEqual(gateway('surface.describe').authority.grants,
    [{ verbs: ['work.unpark'], trigger_prefix: 'edi214:' }]);
});

test('delegation: the rate desk clears invoices it did not produce, inside its scope and nowhere else', () => {
  const { op, as, register, rateDesk } = ridgeline();
  const clerk = register();
  const bot = register('rate-desk');

  const { ref } = as(clerk)('work.create', {
    item: { title: 'Invoice T8804 · ACME', intent: 'ACME pays for what moved.', kind: 'invoice',
      links: freightLinks(KNOWLEDGE, { customer: 'ACME', documents: [{ name: 'POD-T8804.pdf' }] }) },
    dispatch: true,
  });
  as(clerk)('work.claim', { ref });
  as(clerk)('event.append', { ref, kind: 'progress', body: { text: 'POD attached, weight ticket attached, detention 0h' } });
  as(clerk)('work.complete', { ref, record: { outcome: 'Invoice T8804 raised at $2,450 with POD and weight ticket attached.' } });

  // Routine, produced by someone else, inside the grant: cleared at machine
  // speed, and the operator never saw it.
  assert.equal(rateDesk(bot)('triage', { target: ref, decision: 'accept' }).state, 'completed');

  // Outside the granted STATES: a proposal is not the rate desk's to accept.
  const proposal = op('work.create', {
    item: { project: 'RIDGE', title: 'Spot tender T9100 · BLUEBIRD', intent: 'Maybe.', kind: 'load' }, dispatch: false,
  }).ref;
  assert.throws(() => rateDesk(bot)('triage', { target: proposal, decision: 'accept' }), /grant covers review/);

  // Outside the granted PROJECT: another desk's review is another desk's.
  op('project.create', { key: 'DEPOT', name: 'the Denver depot', goal: 'The yard runs itself.' });
  const elsewhere = op('work.create', { item: { project: 'DEPOT', title: 'Yard audit', intent: 'i.', kind: 'errand' }, dispatch: false }).ref;
  assert.throws(() => rateDesk(bot)('triage', { target: elsewhere, decision: 'accept' }), /scoped to RIDGE/);
});

test('no actor may decide its own output — the half a deployment cannot write for itself', () => {
  const { op, as, register, rateDesk, creator } = ridgeline();
  const bot = register('rate-desk');

  // The rate desk both works and reviews, which is exactly the actor the
  // invariant exists to constrain.
  const { ref } = as(bot)('work.create', {
    item: { title: 'Invoice T8850 · PWG', intent: 'PWG pays.', kind: 'invoice' }, dispatch: true,
  });
  as(bot)('work.claim', { ref });
  as(bot)('event.append', { ref, kind: 'progress', body: { text: 'weight tickets attached; rebilled fuel surcharge at the index' } });
  as(bot)('work.complete', { ref, record: { outcome: 'Invoice T8850 raised at $1,980.' } });
  assert.throws(() => rateDesk(bot)('triage', { target: ref, decision: 'accept' }), /decide its own output/);
  // …and it still reaches the human, unharmed.
  assert.equal(op('attention').rows.find((r: any) => r.kind === 'review').target, ref);

  // The other half: a supervising client may answer questions, but not its own.
  const supervisor = creator('supervisor-bot', [{ verbs: ['answer'], project: 'RIDGE' }]);
  const clerk = register();
  const load = as(clerk)('work.create', { item: { title: 'Load T8899 · ACME', intent: 'It moves.', kind: 'load' }, dispatch: true }).ref;
  as(clerk)('work.claim', { ref: load });
  const asked = as(clerk)('event.append', {
    ref: load, kind: 'question',
    body: { prompt: 'Reconsign to the Ogden receiver?', options: [
      { id: 'A', label: 'Reconsign', evidence: [{ claim: 'the Salt Lake receiver closes at 15:00 and we arrive 15:40' }] },
      { id: 'B', label: 'Deliver tomorrow 08:00', evidence: [{ claim: 'driver has hours; no detention exposure' }] } ] },
  });
  assert.equal(supervisor('answer', { ref: load, question: asked.seq, choice: 'B' }).seq > 0, true);

  const own = supervisor('event.append', { ref: load, kind: 'question', body: { prompt: 'Should we bill the reconsignment?' } });
  assert.throws(() => supervisor('answer', { ref: load, question: own.seq, choice: 'yes' }), /asked the question/);
});

test('D-3 resolved: the pending record names its author, so self-triage is refused even with no worklog', () => {
  const { as, register, rateDesk } = ridgeline();
  const bot = register('rate-desk');

  // Volume produces single-shot items: claim, do it, complete. Nothing worth
  // narrating, so no progress event is written — the honest thing to do under
  // §7.4 ("the surface must not author prose"; narration is the client's
  // business, and there was none).
  const { ref } = as(bot)('work.create', {
    item: { title: 'Invoice T8851 · PWG', intent: 'PWG pays.', kind: 'invoice' }, dispatch: true,
  });
  as(bot)('work.claim', { ref });
  as(bot)('work.complete', { ref, record: { outcome: 'Invoice T8851 raised at $1,410 from the rate confirmation.' } });

  // §18 says a grant holder MUST NOT triage an item whose pending completion
  // record it authored — and this is the case that used to slip through, because
  // nothing recorded WHO wrote a record: the surface inferred authorship from
  // progress/completed events, and a single-shot item has neither.
  //
  // §13.1 now holds the record WITH its author (finding D-3), so the invariant
  // is a rule rather than a heuristic, and the desk no longer needs its
  // workaround of leaving a decorative progress event before completing.
  assert.throws(
    () => rateDesk(bot)('triage', { target: ref, decision: 'accept' }),
    /decide its own output/,
  );
  // A DIFFERENT grant holder clears it, which is the whole point of delegation.
  const reviewer = register('second-desk');
  assert.equal(rateDesk(reviewer)('triage', { target: ref, decision: 'accept' }).state, 'completed');
});

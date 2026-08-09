// The load board through its real delivery chain: board server → HTTP binding
// → surface. An operator client, never a gateway; and the thing a grid of
// columns needs that the projection used to withhold (finding D-6, closed).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { makeServer, Store, Surface } from './surface.ts';
import { makeLoadBoard } from '../tools/loadboard.ts';
import { httpCall, pourDay } from '../tools/seed.ts';

test('e2e: the board serves the grid, pages the day over the wire, dispatches, and is not a gateway', async () => {
  const surface = new Surface(new Store(':memory:'));
  const surfaceServer = makeServer(surface);
  await new Promise<void>(r => surfaceServer.listen(0, r));
  const surfaceUrl = `http://127.0.0.1:${(surfaceServer.address() as AddressInfo).port}`;
  const board = makeLoadBoard(surfaceUrl);
  await new Promise<void>(r => board.listen(0, r));
  const boardUrl = `http://127.0.0.1:${(board.address() as AddressInfo).port}`;
  const call = httpCall(boardUrl, 'load-board');           // everything through the board's own proxy

  try {
    const page = await fetch(`${boardUrl}/`);
    const html = await page.text();
    assert.match(html, /Ridgeline Freight/);
    assert.match(html, /load board/);

    const csrf = await fetch(`${boardUrl}/v0/project.create`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
    });
    assert.equal(csrf.status, 400, 'a form-compatible cross-origin request never reaches the operator token');
    assert.equal(((await csrf.json()) as any).error.code, 'VALIDATION');

    // A day of freight, poured through the adapter over HTTP.
    const actions = await pourDay(call, 'RIDGE', { tenders: 20, spot: 18, rfq: 6, mail: 2 });
    assert.equal(actions.length, 46);

    // Operator initialization and recurring feed authority are separate. Once
    // RIDGE exists, an inbound run must not attempt project.create again — a
    // production feed is agent-class and cannot hold that operator verb.
    const feedOnly = async (verb: string, args: unknown) => {
      assert.notEqual(verb, 'project.create');
      return call(verb, args);
    };
    const incremental = await pourDay(feedOnly, 'RIDGE', { tenders: 1, spot: 0, rfq: 0, mail: 0 }, 17, false);
    assert.equal(incremental.length, 1);

    // The board's first read is discovery: what surface, what words, what am I
    // allowed to do (§9). The wire drawer at the bottom of the page shows it.
    const describe = await call('surface.describe', {}) as any;
    assert.equal(describe.authority.class, 'operator');
    assert.ok(describe.projects[0].vocabulary.kinds.includes('quote'));

    // Bounded paging over the wire, from the head.
    const p0 = await call('attention', { project: 'RIDGE', limit: 10 }) as any;
    assert.equal(p0.rows.length, 10);
    assert.equal(p0.total, 26);                            // spot tenders + RFQs + mail need a human
    assert.equal(p0.more, true);

    // D-6/D-7 closed: a row now carries the deliverable's LINKS and an `item`
    // (title, kind, urgency) beside its detail payload, so a board with
    // customer / lane / driver / what columns renders off the queue read alone.
    // The triage payload carried the links all along; what changed is that
    // every kind does, and that the row names what it is about.
    const withLinks = p0.rows.filter((r: any) => r.detail?.proposal?.links?.customer);
    assert.equal(withLinks.length, p0.rows.length);        // triage rows: fine
    for (const r of p0.rows) {
      assert.ok(r.links?.customer?.[0]?.name, 'every row carries the deployment\'s nouns');
      assert.ok(r.item?.title && r.item?.kind, 'every row says what it is about');
    }

    // Dispatching a tender is one verb, and the row clears.
    const target = p0.rows[0].target;
    await call('triage', { target, decision: 'accept' });
    const after = await call('attention', { project: 'RIDGE', limit: 10 }) as any;
    assert.equal(after.total, 25);
    assert.ok(!after.rows.some((r: any) => r.target === target));

    // NOT A GATEWAY, twice over: a session verb with no session fails here as
    // it would anywhere, and a session id offered to the board is DROPPED on
    // the floor — agents talk to the surface, operators talk to the board.
    await assert.rejects(() => call('work.next', {}), /SESSION_REQUIRED/);
    const post = (base: string, verb: string, args: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/v0/${verb}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(args) })
        .then(r => r.json()) as Promise<any>;
    const idem = { 'idempotency-key': 'desk-e2e-once' };
    const once = await post(boardUrl, 'work.create', { item: { project: 'RIDGE', title: 'Idempotent tender', intent: 'One row.' }, dispatch: true }, idem);
    const twice = await post(boardUrl, 'work.create', { item: { project: 'RIDGE', title: 'Idempotent tender', intent: 'One row.' }, dispatch: true }, idem);
    assert.equal(twice.result.ref, once.result.ref, 'the proxy preserves Idempotency-Key');
    const agentSession = (await post(surfaceUrl, 'session.register', { tool: 'claude-code', host: 'desk', project: 'RIDGE' })).result;
    const worked = (await call('attention', { project: 'RIDGE', limit: 50 }) as any).rows[0].target;
    await call('triage', { target: worked, decision: 'accept' });
    const smuggled = await post(boardUrl, 'work.claim', { ref: worked }, { 'x-owp-session': agentSession.id });
    assert.equal(smuggled.error.code, 'SESSION_REQUIRED');

    // The same session, talking to the surface it is registered on, works.
    assert.equal((await post(surfaceUrl, 'work.claim', { ref: worked }, { 'x-owp-session': agentSession.id })).ok, true);
    await post(surfaceUrl, 'work.complete', { ref: worked, record: { outcome: 'Moved, POD in, invoiced.' } }, { 'x-owp-session': agentSession.id });

    // D-6 resolved: every row now carries the deliverable's links, so the grid's
    // customer and lane columns render from the queue read alone — no second
    // fetch per row, which is what made a dispatcher's board expensive.
    const review = ((await call('attention', { project: 'RIDGE', limit: 50 }) as any).rows)
      .find((r: any) => r.kind === 'review');
    assert.equal(review.target, worked);
    assert.ok(review.links.customer[0].name, 'the deployment\'s nouns ride the row');
    assert.ok((await call('work.view', { ref: worked }) as any).deliverable.links.customer[0].name);
  } finally {
    board.close(); surfaceServer.close();
  }
});

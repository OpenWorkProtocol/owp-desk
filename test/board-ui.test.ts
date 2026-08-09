// THE BOARD ITSELF, executed.
//
// The load board shipped broken and every test was green, which is its own
// finding about this repository rather than about the protocol: the UI was the
// one client in the set whose code nothing ever ran. `loadboard-e2e` proved the
// SERVER served and the verbs worked; it called `attention` the way a test
// calls it, never the way the page called it — and the page was passing an
// integer where §15 requires an opaque token, so the very first read failed
// with VALIDATION and the dispatcher was shown "the board is clear".
//
// So: run the page's actual script against the real board, over the real
// binding, with a DOM small enough to read in one screen. What it asserts is
// what the dispatcher sees — the rendered grid, the paging line, the state
// panel — never internal state.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { makeServer, Store, Surface } from './surface.ts';
import { makeLoadBoard } from '../tools/loadboard.ts';
import { httpCall, pourDay } from '../tools/seed.ts';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');
const script = () => {
  const html = readFileSync(UI, 'utf8');
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'ui/index.html has an inline script');
  return m![1];
};

// ---------- the smallest DOM that can hold a load board ----------
interface Fake { [k: string]: any }
function fakeDom(fetchImpl: (url: string, init: unknown) => Promise<Response>) {
  const els = new Map<string, Fake>();
  const el = (id: string): Fake => {
    if (!els.has(id)) {
      els.set(id, {
        id, innerHTML: '', textContent: '', value: '', disabled: false, className: '',
        style: {}, dataset: {},
        classList: { s: new Set<string>(), add(c: string) { this.s.add(c); }, remove(c: string) { this.s.delete(c); }, contains(c: string) { return this.s.has(c); } },
        focus() {}, blur() {}, setSelectionRange() {}, closest() { return null; },
      });
    }
    return els.get(id)!;
  };
  const document: Fake = {
    hidden: false,
    documentElement: { className: '' },
    addEventListener() {},
    querySelector(sel: string) {
      if (sel.startsWith('#')) return el(sel.slice(1));
      return null;                                   // the slip's own lookups; unused here
    },
  };
  const ctx: Fake = {
    document, el, els,
    location: { search: '' },
    localStorage: new Map<string, string>() as unknown as Fake,
    URLSearchParams, JSON, Math, Date, Number, String, Object, Array, Promise, Error, Set, Boolean, isNaN,
    console,
    setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval: () => {},     // the board's own polling stays out of the test
    prompt: () => null, confirm: () => true,
    fetch: (path: string, init: unknown) => fetchImpl(path, init),
  };
  ctx.localStorage = { getItem: () => null, setItem: () => {} };
  ctx.window = ctx;
  createContext(ctx);
  runInContext(script(), ctx, { filename: 'ui/index.html' });
  return ctx;
}

const settle = async (ctx: Fake, until: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) { if (until()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail(`the board never ${what} — live says "${ctx.el('livetext').textContent}"`);
};

async function boardUp(seed: { tenders: number; spot: number; rfq: number; mail: number } | null) {
  const surface = new Surface(new Store(':memory:'));
  const surfaceServer = makeServer(surface);
  await new Promise<void>(r => surfaceServer.listen(0, r));
  const surfaceUrl = `http://127.0.0.1:${(surfaceServer.address() as AddressInfo).port}`;
  const board = makeLoadBoard(surfaceUrl);
  await new Promise<void>(r => board.listen(0, r));
  const boardUrl = `http://127.0.0.1:${(board.address() as AddressInfo).port}`;
  if (seed) await pourDay(httpCall(boardUrl, 'load-board'), 'RIDGE', seed);
  const wire: { verb: string; args: any }[] = [];
  const ctx = fakeDom(async (path, init) => {
    wire.push({ verb: path.replace('/v0/', ''), args: JSON.parse((init as any).body) });
    return fetch(boardUrl + path, init as RequestInit);
  });
  return { ctx, wire, boardUrl, close: () => { board.close(); surfaceServer.close(); } };
}

// ---------- 1. the board loads at all ----------

test('the board loads, renders a grid, and never puts a number where §15 wants a token', async () => {
  const { ctx, wire, close } = await boardUp({ tenders: 20, spot: 30, rfq: 8, mail: 2 });
  try {
    await settle(ctx, () => /live/.test(ctx.el('livetext').textContent), 'came alive');

    // What the dispatcher sees in the first second.
    assert.match(ctx.el('livetext').textContent, /^live/, 'the connection reads as live');
    const grid = ctx.el('grid').innerHTML;
    assert.ok(grid.includes('<tr class="load'), 'there are rows on the board');
    assert.match(grid, /ACME|NORLIT|PWG|VERDE|BLUEBIRD/, 'the customer column is filled from the row itself');
    assert.match(ctx.el('paging').textContent, /^1–25 of 40 waiting/);
    assert.equal(ctx.el('state').innerHTML, '', 'no state panel while there are rows');

    // The regression, stated as a rule: a cursor is echoed, never counted.
    // Passing `cursor: 0` is what made the first read fail with VALIDATION and
    // the empty grid then said "the board is clear".
    for (const c of wire.filter(c => c.verb === 'attention')) {
      assert.ok(!('cursor' in c.args) || typeof c.args.cursor === 'string',
        `attention was called with a ${typeof c.args.cursor} cursor: ${JSON.stringify(c.args)}`);
    }
    // …and the rows carry their own links, so a grid of nine columns costs the
    // queue read and nothing else (§15 / D-6).
    assert.equal(wire.filter(c => c.verb === 'work.view').length, 0, 'no fan-out to render the page');
  } finally { close(); }
});

// ---------- 2. page two, which is where the old board died ----------

test('page two works, and the footer counts honestly across pages', async () => {
  const { ctx, wire, close } = await boardUp({ tenders: 20, spot: 30, rfq: 8, mail: 2 });
  try {
    await settle(ctx, () => /live/.test(ctx.el('livetext').textContent), 'came alive');
    const first = ctx.el('grid').innerHTML;
    assert.equal(ctx.el('next').disabled, false, 'there is more than one page');

    ctx.pageForward();
    await settle(ctx, () => /^26–/.test(ctx.el('paging').textContent), 'reached page two');
    assert.match(ctx.el('paging').textContent, /^26–40 of 40 waiting/);
    assert.notEqual(ctx.el('grid').innerHTML, first, 'page two is different work');
    assert.equal(ctx.el('livetext').textContent.startsWith('live'), true, 'still live, not "unreachable"');
    assert.equal(ctx.el('banner').innerHTML, '', 'nothing went wrong');

    const forward = wire.filter(c => c.verb === 'attention').pop()!;
    assert.equal(typeof forward.args.cursor, 'string', 'the token came back from the surface');

    ctx.pageBack();
    await settle(ctx, () => /^1–/.test(ctx.el('paging').textContent), 'got back to page one');
    assert.equal(ctx.el('prev').disabled, true);
  } finally { close(); }
});

// ---------- 3. the words on the glass ----------

test('no protocol word reaches the glass, and every row says what it wants', async () => {
  const { ctx, close } = await boardUp({ tenders: 12, spot: 20, rfq: 6, mail: 2 });
  try {
    await settle(ctx, () => /live/.test(ctx.el('livetext').textContent), 'came alive');
    // Only what is actually READABLE — tags and attributes are the machine's
    // business, the text between them is the dispatcher's.
    const text = (h: string) => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    const seen = text(ctx.el('grid').innerHTML + ctx.el('tiles').innerHTML + ctx.el('rail').innerHTML);
    // The brief for this world is explicit: the customer, the lane and the load
    // are the nouns. These are the words the operator must never meet.
    for (const word of ['deliverable', 'triage', 'proposal', 'unpark', 'continuation', 'parked', 'projection', 'envelope', 'session']) {
      assert.ok(!new RegExp(word, 'i').test(seen), `"${word}" leaked onto the board`);
    }
    assert.match(seen, /accept\?/, 'the chip says what the row is asking for');
    assert.match(ctx.el('tiles').innerHTML, /needs you/);
    assert.match(ctx.el('tiles').innerHTML, /on this page/, 'the money on the page is on the head board');
    assert.match(ctx.el('tiles').innerHTML, /\$[\d,]+/, '…and it is a dollar figure');
  } finally { close(); }
});

// ---------- 4. clearing a row keeps the operator's place ----------

test('a slip opens with its history, accepting clears the row, and the page does not jump', async () => {
  const { ctx, close } = await boardUp({ tenders: 12, spot: 30, rfq: 8, mail: 2 });
  try {
    await settle(ctx, () => /live/.test(ctx.el('livetext').textContent), 'came alive');
    ctx.pageForward();
    await settle(ctx, () => /^26–/.test(ctx.el('paging').textContent), 'reached page two');

    const ref = /data-ref="([A-Z]+-\d+)"/.exec(ctx.el('grid').innerHTML)![1];
    await ctx.openSlip(ref);
    await settle(ctx, () => /recent activity/.test(ctx.el('grid').innerHTML), 'opened the slip');
    const slip = ctx.el('grid').innerHTML;
    assert.match(slip, /If you do nothing:/, 'the slip says what happens if the operator walks away');
    assert.match(slip, /Put it on the board/, 'the action is in freight English');
    assert.match(ctx.el('livetext').textContent, /paused while you decide/, 'the board stops moving under a decision');

    await ctx.act('accept', ref);
    await settle(ctx, () => !ctx.el('grid').innerHTML.includes(`data-ref="${ref}"`), 'cleared the row');
    // A keyed cursor means clearing does not cost the operator their place —
    // the workaround the old board needed (always bounce to the head) is gone.
    assert.match(ctx.el('paging').textContent, /^26–/, 'still on page two after deciding');
    assert.match(ctx.el('flash').textContent, /on the board/);
  } finally { close(); }
});

// ---------- 5. the four empty-looking states are four different things ----------

test('an empty board and a broken board do not look the same', async () => {
  const clear = await boardUp({ tenders: 6, spot: 0, rfq: 0, mail: 0 });   // dispatched, so nothing waits
  try {
    await settle(clear.ctx, () => /live/.test(clear.ctx.el('livetext').textContent), 'came alive');
    assert.match(clear.ctx.el('state').innerHTML, /nothing needs you/i);
    assert.match(clear.ctx.el('state').innerHTML, /to dispatch|rolling/, 'and it proves it is not broken by counting the rest');
  } finally { clear.close(); }

  // The same page with nothing behind it must say so, loudly, and must NOT say
  // the board is clear — that is the sentence that costs a tender.
  const dead = fakeDom(async () => { throw new Error('ECONNREFUSED'); });
  await settle(dead, () => /not connected|cannot reach/i.test(dead.el('state').innerHTML), 'reported the outage');
  assert.match(dead.el('state').innerHTML, /this is not an empty board/i);
  assert.ok(!/nothing needs you/i.test(dead.el('state').innerHTML));
  assert.match(dead.el('livetext').textContent, /cannot reach the surface/i);
  assert.match(dead.el('banner').innerHTML, /try again/);
});

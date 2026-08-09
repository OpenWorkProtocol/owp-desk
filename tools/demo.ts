#!/usr/bin/env node
// One-command load board: reference surface + a synthetic freight day + UI.
import type { AddressInfo } from 'node:net';
import { httpCall, pourDay } from './seed.ts';
import { makeLoadBoard } from './loadboard.ts';
import { Surface } from '../vendor/owp-reference/src/surface.ts';
import { Store } from '../vendor/owp-reference/src/store.ts';
import { makeServer } from '../vendor/owp-reference/src/http.ts';

const surfaceServer = makeServer(new Surface(new Store(':memory:')));
await new Promise<void>(resolve => surfaceServer.listen(0, '127.0.0.1', resolve));
const surfaceUrl = `http://127.0.0.1:${(surfaceServer.address() as AddressInfo).port}`;
const count = Number(process.env.DEMO_ITEMS ?? 40);
await pourDay(httpCall(surfaceUrl), 'RIDGE', {
  tenders: Math.round(count * 0.55), spot: Math.round(count * 0.3),
  rfq: Math.round(count * 0.1), mail: Math.round(count * 0.05),
});
const port = Number(process.env.DEMO_PORT ?? 7121);
const board = makeLoadBoard(surfaceUrl);
board.listen(port, '127.0.0.1', () => console.log(`load board demo → http://127.0.0.1:${port}`));
const stop = () => { board.close(); surfaceServer.close(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);

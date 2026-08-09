#!/usr/bin/env node
// Pours a day of Ridgeline's traffic into a running surface, so the load board
// has something to dispatch. The same adapter the real feeds use — EDI in,
// observations out, the pinned generic watcher in the middle.
//
//   OWP_URL=http://127.0.0.1:7117 node tools/seed.ts 60
import { pathToFileURL } from 'node:url';
import { runInbound, syntheticDay, type DayCounts } from '../src/inbound.ts';
import { emptyState, type Call } from '../src/watcher.ts';
import { RIDGELINE_VOCABULARY } from '../src/vocabulary.ts';

// A verb caller over the HTTP binding (§17): POST /v0/<verb>, actor identity in
// a header, {ok, result} back.
export function httpCall(base: string, client = 'edi-gateway', token?: string): Call {
  const root = base.replace(/\/$/, '');
  return async (verb: string, args: unknown) => {
    const res = await fetch(`${root}/v0/${verb}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-owp-client': client,
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(args ?? {}),
    });
    const payload = await res.json() as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    if (!payload.ok) throw new Error(`${payload.error!.code}: ${payload.error!.message}`);
    return payload.result;
  };
}

export async function ensureProject(call: Call, project: string): Promise<void> {
  try {
    await call('project.create', {
      key: project, name: 'Ridgeline Freight',
      goal: 'Freight moves, invoices go out clean, and the judgment calls reach a human who can make them.',
      rank_tiebreak: { kind: 'link-number', type: 'shipment', field: 'revenue_usd', direction: 'desc' },
      vocabulary: RIDGELINE_VOCABULARY,
    });
  } catch (e) {
    if (!/CONFLICT/.test((e as Error).message)) throw e;      // already initialized
  }
}

export async function pourDay(
  call: Call, project: string, counts: DayCounts, seed = 7, initialize = true,
): Promise<string[]> {
  // Tests and embedders retain the self-contained default. The shipped CLI
  // separates operator initialization (`npm run init`, n=0) from recurring
  // inbound runs (`npm run seed -- N`), so a feed can use agent authority.
  if (initialize) await ensureProject(call, project);
  const { actions } = await runInbound(call, project, syntheticDay(counts, seed), emptyState());
  return actions;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.OWP_URL ?? 'http://127.0.0.1:7117';
  const n = Number(process.argv[2] ?? 60);
  const call = httpCall(url, 'edi-gateway', process.env.OWP_TOKEN);
  const project = process.env.OWP_PROJECT ?? 'RIDGE';
  if (n === 0) await ensureProject(call, project);
  const actions = await pourDay(
    call,
    project,
    { tenders: Math.round(n * 0.55), spot: Math.round(n * 0.3), rfq: Math.round(n * 0.1), mail: Math.round(n * 0.05) },
    7,
    false,
  );
  console.log(`${actions.length} inbound documents poured into ${url}`);
  console.log(actions.slice(0, 5).join('\n') + (actions.length > 5 ? `\n… and ${actions.length - 5} more` : ''));
}

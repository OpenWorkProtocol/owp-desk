// The inbound adapter — the freight desk's mouth.
//
// EDI tenders, portal RFQs, claim documents, telematics pings and plain mail
// arrive all day long. Every one of them becomes an OBSERVATION and goes
// through owp-ops's reference watcher (src/watcher.ts, imported, never
// forked). The watcher keeps its own cursor and its own clock; this file only
// translates freight into the observation vocabulary.
//
// D-1 is CLOSED, and this file is where it shows. The reference watcher used
// to compose ops's own deliverable kinds — §3's corollary (a vocabulary in the
// shared thing is a bug unless every world needs it) applies to reference
// CLIENTS as well as to the surface, and owp-publish filed the same defect
// independently as PUB-9. It is fixed upstream in owp-ops: an observation now
// carries its own `kind_label`, `links` and `priority`, and `runWatcher`
// returns the refs it minted keyed by the observation's identity.
//
// So this file translates freight into observations and stops. There is no
// decorator: `withFreightVocabulary` — which wrapped the watcher's `call` seam
// and matched deliverables by TITLE, because the observation's identity never
// reached `call` — is deleted. A load's customer, lane, shipment and documents
// ride on the observation that asked for it, where they belong.
import { freightLinks, KNOWLEDGE } from './entities.ts';
import { dueKey, runWatcher, type Call, type Observation, type WatcherState } from './watcher.ts';

// ---------- what arrives ----------

export type Inbound =
  // EDI 204 load tender: the bread and butter. Contract customers dispatch
  // straight to the board; spot tenders are judgment and land as proposals.
  | { channel: 'edi'; set: '204'; tender: string; customer: string; lane: string;
      revenue_usd: number; miles: number; weight_lb: number; contract: boolean }
  // EDI 214 shipment status: a world event. Releases whatever parked on it.
  | { channel: 'edi'; set: '214'; shipment: string; status: 'arrived' | 'loaded' | 'delivered'; note?: string }
  // The customer portal: an RFQ is a quote, always judgment, always a proposal.
  | { channel: 'portal'; form: 'quote-request'; rfq: string; customer: string; lane: string;
      loads_per_week: number; note?: string }
  // …and the document trail a claim runs on.
  | { channel: 'portal'; form: 'claim-document'; claim: string; document: string }
  // Mail: either a reply the desk is parked on, or new back-office churn.
  | { channel: 'mail'; from: string; subject: string; body: string;
      customer?: string; about?: string }
  // Telematics: the tractor reports where it is. The surface derives
  // `unreconciled` when the world has moved past the worklog (§8).
  | { channel: 'telematics'; ref: string; driver: string; position: string; eta_note: string };

export interface InboundPlan { observations: Observation[] }

// ---------- translation ----------

export function planInbound(batch: Inbound[], root: string = KNOWLEDGE): InboundPlan {
  const observations: Observation[] = [];

  for (const item of batch) {
    if (item.channel === 'edi' && item.set === '204') {
      observations.push({
        kind: 'due', kind_label: 'load',
        task: `tender:${item.tender}`, period: item.tender,   // the tender id IS the period key
        title: `Load ${item.tender} · ${item.customer} ${item.lane}`,
        intent: `${item.customer}'s freight moves ${item.lane} and the invoice goes out clean.`,
        dispatch: item.contract,
        urgency: item.revenue_usd >= 4000 ? 'elevated' : 'routine',
        priority: item.revenue_usd >= 4000 ? 2 : 3,
        evidence: [
          { claim: `EDI 204 tender ${item.tender}: ${item.miles} mi, ${item.weight_lb.toLocaleString('en-US')} lb, $${item.revenue_usd.toLocaleString('en-US')}` },
          { claim: item.contract ? 'contract customer — rate is on the tariff' : 'spot tender — no contract rate on file' },
        ],
        links: freightLinks(root, {
          customer: item.customer, lane: item.lane,
          shipment: { tender: item.tender, revenue_usd: item.revenue_usd, miles: item.miles, weight_lb: item.weight_lb },
          documents: [{ name: `EDI204-${item.tender}` }],
        }),
      });
    } else if (item.channel === 'edi' && item.set === '214') {
      observations.push({ kind: 'trigger', trigger: `edi214:${item.shipment}`, note: item.note ?? `214 ${item.status}` });
    } else if (item.channel === 'portal' && item.form === 'quote-request') {
      observations.push({
        kind: 'due', kind_label: 'quote',
        task: `rfq:${item.rfq}`, period: item.rfq,
        title: `Quote ${item.rfq} · ${item.customer} ${item.lane}`,
        intent: `${item.customer} gets a rate we can actually run at.`,
        dispatch: false,                                        // pricing is judgment: it proposes
        urgency: 'routine',
        evidence: [
          { claim: `portal RFQ ${item.rfq}: ${item.loads_per_week} loads/week on ${item.lane}` },
          ...(item.note ? [{ claim: item.note }] : []),
        ],
        links: freightLinks(root, {
          customer: item.customer, lane: item.lane,
          documents: [{ name: `RFQ-${item.rfq}` }],
        }),
      });
    } else if (item.channel === 'portal' && item.form === 'claim-document') {
      observations.push({ kind: 'trigger', trigger: `claim:${item.claim}`, note: `document received: ${item.document}` });
    } else if (item.channel === 'mail') {
      if (item.about) {
        // A reply on something the desk parked: the mail is the trigger stream.
        observations.push({ kind: 'trigger', trigger: `customer:${item.about}`, note: `${item.from}: ${item.subject}` });
      } else {
        observations.push({
          kind: 'due', kind_label: 'errand',
          task: `mail:${item.from}:${item.subject}`, period: item.subject,
          title: `Back office · ${item.subject}`,
          intent: 'The desk answers, and the customer stops chasing.',
          dispatch: false, urgency: 'routine',
          evidence: [{ claim: `mail from ${item.from}: ${item.body.slice(0, 120)}` }],
          ...(item.customer ? { links: freightLinks(root, { customer: item.customer }) } : {}),
        });
      }
    } else if (item.channel === 'telematics') {
      observations.push({
        kind: 'state', ref: item.ref, type: 'tracking',
        entry: { driver: item.driver, position: item.position, note: item.eta_note },
      });
    }
  }
  return { observations };
}

// ---------- the run ----------

// The whole adapter, now: translate, then hand the observations to the
// local generic watcher. No wrapper around `call`, because there is nothing left
// for a wrapper to do — the deliverable's kind, its nouns and its steering
// hint all ride on the observation, and the refs come back keyed by the
// tender, the RFQ or the mail that asked for them (`dueKey`), which is the
// desk's own memory of what it created (§5) and never a surface read.
export async function runInbound(
  call: Call, project: string, batch: Inbound[], state: WatcherState, root: string = KNOWLEDGE,
): Promise<{ actions: string[]; state: WatcherState; created: Record<string, string> }> {
  const { observations } = planInbound(batch, root);
  return runWatcher(call, project, observations, state);
}

/** What the desk calls the ref of the work an inbound document produced. */
export const refFor = (created: Record<string, string>, task: string, period: string) =>
  created[dueKey(task, period)];

// ---------- a day's traffic ----------

// Deterministic, because a volume test that cannot be replayed is an anecdote.
const rng = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const CONTRACT = ['ACME', 'NORLIT', 'PWG'];
const PROSPECT = ['VERDE', 'BLUEBIRD'];
const LANES = ['DEN-SLC', 'DEN-ABQ', 'SLC-BOI', 'CHI-DEN'];

export interface DayCounts {
  tenders?: number; spot?: number; rfq?: number; status?: number; claimdocs?: number; mail?: number;
}

export function syntheticDay(counts: DayCounts, seed = 7): Inbound[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const out: Inbound[] = [];
  let n = 8800;
  for (let i = 0; i < (counts.tenders ?? 0); i++) {
    out.push({ channel: 'edi', set: '204', tender: `T${n++}`, customer: pick(CONTRACT), lane: pick(LANES),
      revenue_usd: 1200 + Math.floor(r() * 4200), miles: 220 + Math.floor(r() * 900),
      weight_lb: 12000 + Math.floor(r() * 32000), contract: true });
  }
  for (let i = 0; i < (counts.spot ?? 0); i++) {
    out.push({ channel: 'edi', set: '204', tender: `T${n++}`, customer: pick([...CONTRACT, ...PROSPECT]), lane: pick(LANES),
      revenue_usd: 900 + Math.floor(r() * 5200), miles: 220 + Math.floor(r() * 900),
      weight_lb: 9000 + Math.floor(r() * 34000), contract: false });
  }
  for (let i = 0; i < (counts.rfq ?? 0); i++) {
    out.push({ channel: 'portal', form: 'quote-request', rfq: `R${n++}`, customer: pick([...CONTRACT, ...PROSPECT]),
      lane: pick(LANES), loads_per_week: 1 + Math.floor(r() * 8) });
  }
  for (let i = 0; i < (counts.status ?? 0); i++) {
    out.push({ channel: 'edi', set: '214', shipment: `T${8800 + Math.floor(r() * (counts.tenders ?? 1))}`,
      status: pick(['arrived', 'loaded', 'delivered'] as const) });
  }
  for (let i = 0; i < (counts.claimdocs ?? 0); i++) {
    out.push({ channel: 'portal', form: 'claim-document', claim: `C${4800 + i}`, document: `bol-scan-${i}.pdf` });
  }
  for (let i = 0; i < (counts.mail ?? 0); i++) {
    out.push({ channel: 'mail', from: `ap@${pick(CONTRACT).toLowerCase()}.example`,
      subject: `Invoice query ${n++}`, body: 'Your invoice shows detention we did not authorise.',
      customer: pick(CONTRACT) });
  }
  return out;
}

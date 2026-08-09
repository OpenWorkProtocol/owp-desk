// The reference watcher — the generic creator-client shape (spec §5, §10):
// observe the world, then propose, create, unpark, or report — each per its
// own policy, on its own authority. One shape, many worlds: pointed at
// releases and certs here, at a freight mailbox by owp-desk, at a source
// catalog by owp-research, at a manuscript by owp-publish.
//
// Three design rules, all load-bearing:
//
// 1. **The watcher owns its own memory.** Idempotency comes from a cursor the
//    watcher keeps (last proposed version per service; period keys for owed
//    work) — never from querying the surface. The surface is not the
//    watcher's memory, and a creator client needs no read authority to be
//    correct. (Finding O-3.)
// 2. **The watcher owns its own clock.** Cert expiry dates, verification
//    periods, maintenance windows — all calendar lives here and enters the
//    protocol as created work or fired triggers. The protocol never sees a
//    date. (Spec §1.)
// 3. **The watcher owns no vocabulary.** Every deliverable it can create takes
//    its `kind`, `title`, `intent`, `links` and `priority` from the caller. A
//    freight tender is not a `verify`; a research source is not an `upgrade`.
//    §3's first corollary — *a vocabulary in the shared thing is a bug unless
//    every world needs it* — is stated for the spec and the surface, and this
//    is a shared artifact, so it binds here too. (Findings PUB-9 / D-1, filed
//    independently by owp-publish and owp-desk; O-10 in this repo.) The one
//    block of world-specific words left in this file is `OPS_DEFAULTS`, and it
//    is a default, not a policy.

/** A link envelope: link type → entries. The watcher never looks inside one. */
export type Links = Record<string, unknown[]>;

export type Observation =
  // an upstream release the estate does not run yet → a PROPOSAL with evidence
  | { kind: 'release'; service: string; current: string; latest: string;
      url?: string; evidence: { claim: string }[];
      urgency?: 'blocking' | 'elevated' | 'routine';
      // The caller's own words. All optional, all defaulting to OPS_DEFAULTS,
      // so a caller that names none of them creates exactly what this watcher
      // created before they existed (§4.2).
      kind_label?: string; title?: string; intent?: string;
      links?: Links; priority?: number }
  // owed periodic work (backup verify, cert renewal) → fresh deliverable per period
  | { kind: 'due'; task: string; period: string; title: string; intent: string;
      dispatch: boolean; urgency?: 'blocking' | 'elevated' | 'routine';
      evidence?: { claim: string }[];
      // The batching key (§ policy, below). Forty containers observed one by
      // one, grouped by the thing an operator actually acts on: the stack.
      group?: string;
      // …and the caller's own words again: the deliverable's kind, the nouns
      // it carries, and the steering hint under urgency.
      kind_label?: string; links?: Links; priority?: number }
  // a world event fired → release every park carrying the trigger
  | { kind: 'trigger'; trigger: string; note?: string }
  // observed state for a tracked ref → link patch (surface derives unreconciled)
  | { kind: 'state'; ref: string; type: string; entry: Record<string, unknown> };

export interface WatcherState {
  proposed: Record<string, string>;   // service → last proposed version
  created: Record<string, string>;    // task:period → ref
}

export type Call = (verb: string, args: unknown) => Promise<any> | any;

export const emptyState = (): WatcherState => ({ proposed: {}, created: {} });

/** The cursor key for owed work — and the key a run's `created` refs come back
 *  under, so a caller can find the ref it just minted without matching on a
 *  title. (D-1: the observation's identity now reaches the caller.) */
export const dueKey = (task: string, period: string) => `${task}:${period}`;

// ---------- the only vocabulary left in this file ----------
//
// `upgrade`, `verify`, `incident` and the two sentences below are owp-ops's own
// words. They live here, in one named block, as DEFAULTS — every one of them is
// overridable per observation, and every other world overrides them. They are
// kept because deleting them would break callers written against yesterday's
// shape, which §4.2 forbids; they are not kept because the artifact has an
// opinion about what your world calls things.
type Release = Extract<Observation, { kind: 'release' }>;

export const OPS_DEFAULTS = {
  release_kind: 'upgrade',
  release_title: (o: Release) => `${o.service}: ${o.current} → ${o.latest}`,
  release_intent: 'Upgrade at machine time, before the missing capability blocks work.',
  release_source_title: (o: Release) => `${o.service} ${o.latest} release notes`,
  due_kind: 'verify',
  batch_kind: 'incident',
};

// The caller's link families REPLACE the watcher's composed ones family by
// family — the same rule §7.3 gives a link write on the wire. A caller that
// supplies `sources` in its own citation shape gets exactly that, and one that
// supplies nothing keeps the evidence the watcher assembled.
const withLinks = (composed: Links, caller?: Links): Links => ({ ...composed, ...(caller ?? {}) });

// ---------- the batching policy ----------
//
// The problem this exists for: forty containers on one host, a bad afternoon,
// and thirty-nine proposal rows waiting at breakfast. That is a violation of
// §1.2 dressed as diligence — the operator is not being informed, they are
// being buried.
//
// The rule is DECLARATIVE and lives in estate.json, not in the detection code,
// because grouping is policy and detection is not. Detection says "this
// container is unhealthy"; policy says "one card per stack".
//
// Idempotency survives batching, which is the part that is easy to get wrong.
// The batch's period key is a FINGERPRINT of its membership: the same six sick
// containers next run produce the same key and no second proposal; a seventh
// joining changes the key and earns a fresh card. The watcher's own memory
// (finding O-3) still answers "did I already say this?" — no surface read.
//
// The honest cost of that: a watcher with no read authority cannot know the
// earlier card was dealt with, so an identical situation recurring months
// later is "already proposed" until the state file's key is cleared. That is
// O-3's price, paid deliberately — a deployment that wants a card per occasion
// puts an occasion into the key (a week number in the group name) rather than
// giving a calendar job a view of the portfolio.

export interface BatchRule {
  /** Which observation kinds to batch. Only `due` today; `release` is left
   *  deliberately unbatched — a version decision is per service. */
  match?: 'due'[];
  /** Field to group on. `group` is the observation's own key (the stack). */
  group_by?: 'group' | 'task';
  /** Groups smaller than this pass through as individual proposals. */
  min?: number;
  /** Templates. {group} {n} {first} are substituted. */
  title: string;
  intent: string;
  /** The card's kind. Defaults to the members' own `kind_label` — a batch of
   *  freight loads is a freight noun, not an ops one — and only then to
   *  `OPS_DEFAULTS.batch_kind`. */
  kind?: string;
  /** `inherit-max` takes the worst urgency in the group. */
  urgency?: 'blocking' | 'elevated' | 'routine' | 'inherit-max';
  dispatch?: boolean;
  /** How many member claims ride on the card before "+N more". */
  max_evidence?: number;
}

export interface WatcherPolicy { batch?: BatchRule[] }

const URGENCY_ORDER = ['blocking', 'elevated', 'routine'] as const;

// A stable, short fingerprint of a group's membership — no crypto needed for
// an idempotency key, only determinism and a low collision rate over ~dozens.
function fingerprint(keys: string[]): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (const s of [...keys].sort()) {
    for (let i = 0; i < s.length; i++) {
      h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
      h2 = Math.imul(h2 + s.charCodeAt(i) + i, 2246822519) >>> 0;
    }
    h1 = (h1 ^ 0x2f) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12);
}

const fill = (tpl: string, vars: Record<string, string | number>) =>
  tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

type Due = Extract<Observation, { kind: 'due' }>;

/**
 * Apply the batching rules. Observations no rule claims pass through in order
 * and untouched — a watcher with no policy behaves exactly as it did before,
 * which is what keeps owp-desk's mailbox working.
 */
export function applyPolicy(observations: Observation[], policy?: WatcherPolicy): Observation[] {
  const rules = policy?.batch ?? [];
  if (!rules.length) return observations;

  const claimed = new Set<Observation>();
  const batches: Observation[] = [];

  for (const rule of rules) {
    const kinds = rule.match ?? ['due'];
    const groups = new Map<string, Due[]>();
    for (const o of observations) {
      if (claimed.has(o) || !kinds.includes(o.kind as 'due')) continue;
      const due = o as Due;
      const key = rule.group_by === 'task' ? due.task : due.group;
      if (!key) continue;                                  // ungrouped work is never batched
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(due);
    }
    for (const [group, members] of groups) {
      if (members.length < (rule.min ?? 2)) continue;       // one sick container is still one card
      for (const m of members) claimed.add(m);
      const claims = members.flatMap(m => m.evidence ?? []);
      const evidence = claims.slice(0, rule.max_evidence ?? 6);
      const hidden = claims.length - evidence.length;
      if (hidden > 0) evidence.push({ claim: `+${hidden} more in this stack — see the estate board` });
      const urgency = rule.urgency === 'inherit-max'
        ? URGENCY_ORDER.find(u => members.some(m => (m.urgency ?? 'routine') === u)) ?? 'routine'
        : rule.urgency ?? 'elevated';
      // The card is a new observation, so it composes the members' nouns the
      // same way it composes their evidence: one card, everything it is about.
      // Members that carry no links (owp-ops's own, today) compose to nothing.
      const links: Links = {};
      for (const m of members) {
        for (const [type, entries] of Object.entries(m.links ?? {})) {
          (links[type] ??= []).push(...entries);
        }
      }
      const vars = { group, n: members.length, first: members[0].title };
      batches.push({
        kind: 'due',
        // The membership fingerprint IS the period: same set, same card; new
        // member, new card. Recurring creation, applied to a moving set.
        task: `batch:${rule.group_by ?? 'group'}:${group}`,
        period: fingerprint(members.map(m => `${m.task}:${m.period}`)),
        title: fill(rule.title, vars),
        intent: fill(rule.intent, vars),
        dispatch: rule.dispatch ?? false,
        urgency,
        evidence,
        group,
        kind_label: rule.kind ?? members[0].kind_label ?? OPS_DEFAULTS.batch_kind,
        ...(Object.keys(links).length ? { links } : {}),
      });
    }
  }

  const passthrough = observations.filter(o => !claimed.has(o));
  return [...passthrough, ...batches];
}

/**
 * Observe, then propose / create / unpark / report.
 *
 * Returns the refs minted on THIS run as well as the cursor, keyed by the same
 * identity the cursor uses — `service` for a release, `dueKey(task, period)`
 * for owed work. Before that existed, a deployment that needed the ref of the
 * thing it had just asked for had to wrap `call` and match on the title
 * (D-1); the identity now comes back on the seam it went in on.
 */
export async function runWatcher(
  call: Call, project: string, observations: Observation[], state: WatcherState,
  policy?: WatcherPolicy,
): Promise<{ actions: string[]; state: WatcherState; created: Record<string, string> }> {
  const actions: string[] = [];
  const created: Record<string, string> = {};
  for (const obs of applyPolicy(observations, policy)) {
    if (obs.kind === 'release') {
      if (state.proposed[obs.service] === obs.latest) continue;   // own cursor, not a surface read
      const { ref } = await call('work.create', {
        item: {
          project,
          title: obs.title ?? OPS_DEFAULTS.release_title(obs),
          intent: obs.intent ?? OPS_DEFAULTS.release_intent,
          kind: obs.kind_label ?? OPS_DEFAULTS.release_kind,
          urgency: obs.urgency ?? 'routine',
          ...(obs.priority === undefined ? {} : { priority: obs.priority }),
          links: withLinks({
            evidence: obs.evidence,
            ...(obs.url ? { sources: [{ url: obs.url, title: OPS_DEFAULTS.release_source_title(obs) }] } : {}),
          }, obs.links),
        },
        dispatch: false,                                           // proposals cross the human gate
      });
      state.proposed[obs.service] = obs.latest;
      created[obs.service] = ref;
      actions.push(`proposed ${ref}: ${obs.service} ${obs.latest}${obs.urgency === 'blocking' ? ' [BLOCKING]' : ''}`);
    } else if (obs.kind === 'due') {
      const key = dueKey(obs.task, obs.period);
      if (state.created[key]) continue;                            // one deliverable per owed period
      const { ref } = await call('work.create', {
        item: {
          project, title: obs.title, intent: obs.intent,
          kind: obs.kind_label ?? OPS_DEFAULTS.due_kind,
          urgency: obs.urgency ?? 'routine',
          ...(obs.priority === undefined ? {} : { priority: obs.priority }),
          links: withLinks({ evidence: obs.evidence ?? [] }, obs.links),
        },
        dispatch: obs.dispatch,                                    // pure machine work dispatches; judgment proposes
      });
      state.created[key] = ref;
      created[key] = ref;
      actions.push(`${obs.dispatch ? 'dispatched' : 'proposed'} ${ref}: ${obs.title}`);
    } else if (obs.kind === 'trigger') {
      const r = await call('work.unpark', { trigger: obs.trigger, ...(obs.note ? { note: obs.note } : {}) });
      actions.push(`trigger ${obs.trigger} → released ${(r.released ?? []).join(', ') || 'nothing'}`);
    } else {
      await call('work.update', {
        ref: obs.ref,
        links: { [obs.type]: [{ ...obs.entry, observed_at: new Date().toISOString() }] },
      });
      actions.push(`reported ${obs.type} state on ${obs.ref}`);
    }
  }
  return { actions, state, created };
}

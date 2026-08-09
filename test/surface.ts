// Tests run against the pinned reference snapshot shipped in this repository.
// Every change these narratives would require of it remains a spec finding,
// recorded as evidence rather than patched into the runtime.
import { KNOWLEDGE } from '../src/entities.ts';
import { Surface, OwpError } from '../vendor/owp-reference/src/surface.ts';
import { Store } from '../vendor/owp-reference/src/store.ts';
import { makeServer } from '../vendor/owp-reference/src/http.ts';

export { Surface, Store, OwpError, makeServer };

// The deployment's published vocabulary and its declared tiebreak live in
// src/ — they are world code, not test fixtures, and the seeder publishes the
// same values over HTTP that these narratives publish in-process.
export { REVENUE_FIRST, RIDGELINE_VOCABULARY } from '../src/vocabulary.ts';
import { REVENUE_FIRST, RIDGELINE_VOCABULARY } from '../src/vocabulary.ts';

export interface World {
  surface: any;
  op: (verb: string, args?: unknown) => any;
  as: (session: string) => (verb: string, args?: unknown) => any;
  register: (tool?: string) => string;
  /** A creator client with an explicit grant set (§18). */
  creator: (client: string, grants: unknown[]) => (verb: string, args?: unknown) => any;
  /** The EDI feed: agent authority plus the one trigger prefix it owns. */
  gateway: (verb: string, args?: unknown) => any;
  /** The customer portal: claims documents, and nothing else. */
  portal: (verb: string, args?: unknown) => any;
  /** A grant-holding review bot: triage, in RIDGE, on review items only. */
  rateDesk: (session: string) => (verb: string, args?: unknown) => any;
}

// Ridgeline Freight: one project, one operator, N sessions.
export function ridgeline(opts: { knowledge_dir?: string } = {}): World {
  const surface = new Surface(new Store(':memory:'));
  const op = (verb: string, args: unknown = {}) => surface.call(verb, args, { client: 'load-board' }) as any;
  const as = (session: string) => (verb: string, args: unknown = {}) => surface.call(verb, args, { session }) as any;
  op('project.create', {
    key: 'RIDGE', name: 'Ridgeline Freight',
    goal: 'Freight moves, invoices go out clean, and the judgment calls reach a human who can make them.',
    knowledge_dir: opts.knowledge_dir ?? KNOWLEDGE,
    rank_tiebreak: REVENUE_FIRST,
    vocabulary: RIDGELINE_VOCABULARY,
  });
  const register = (tool = 'claude-code') =>
    op('session.register', { tool, host: 'desk', project: 'RIDGE' }).id as string;
  // Inbound feeds are creator clients: agent authority, plus the one trigger
  // prefix each actually owns. Neither can release a `customer:` park, because
  // the mailbox that owns those is a third client (§18).
  //
  // That they are two clients rather than one holding two grants is a modelling
  // choice now, not a workaround: finding D-2 (the reference surface consulted
  // only the FIRST grant naming a verb) closed in §18, and grants compose. The
  // EDI VAN and the customer portal are still two systems, so they stay two
  // clients — and keeping them apart is what makes the scope assertions below
  // mean something.
  const creator = (client: string, grants: unknown[]) => (verb: string, args: unknown = {}) =>
    surface.call(verb, args, { client, authority: 'agent', grants }) as any;
  const gateway = creator('edi-gateway', [{ verbs: ['work.unpark'], trigger_prefix: 'edi214:' }]);
  const portal = creator('portal-gateway', [{ verbs: ['work.unpark'], trigger_prefix: 'claim:' }]);
  // The rate desk works AND reviews — which is exactly the actor §18's
  // delegation invariant exists to constrain.
  const rateDesk = (session: string) => (verb: string, args: unknown = {}) => surface.call(verb, args, {
    session, authority: 'agent',
    grants: [{ verbs: ['triage'], project: 'RIDGE', states: ['review'] }],
  }) as any;
  return { surface, op, as, register, creator, gateway, portal, rateDesk };
}

export const HANDOFF = (over: Partial<Record<'why' | 'state_so_far' | 'resume_point' | 'on_release', string>> = {}) => ({
  why: 'the customer owns the next move',
  state_so_far: 'tendered, rate confirmed, driver assigned',
  resume_point: 'read the reply before touching the rate',
  on_release: 'if accepted: dispatch; if not: requote',
  ...over,
});

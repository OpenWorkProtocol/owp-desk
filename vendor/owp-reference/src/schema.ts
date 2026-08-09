// The one definition. Every binding (HTTP, CLI, later MCP) validates against
// these schemas; nothing else defines a record or verb shape.
//
// PROTOCOL_VERSION is the contract this surface implements — not the package
// version. It was hardcoded and went stale once already (the binding still
// advertised 0.2 while implementing 0.3), which is exactly why a released
// protocol needs the version to be asked for rather than assumed.
// Normative source: spec/owp-1.0-rc2.md in the owp repo (0.3 is withdrawn).
// Section refs below point there. Binding-level decisions: docs/decisions.md.
import { z } from 'zod';

export const PROTOCOL_VERSION = '1.0-rc2';
// ONLY 1.0-rc1. This list said ['1.0-rc1','0.3'] on the theory that every v1.0
// change was additive — and then three were not: `attention` returns a page
// envelope where 0.3 returned a bare array, its cursor became an opaque token
// where 0.3 used an index, and `work.view` moved to operator authority. A
// surface advertising a revision it cannot actually serve is the exact
// dishonesty §9 exists to prevent, so the claim is withdrawn rather than the
// breakage hidden. Release-candidate status is what makes those changes
// permissible at all (§4.3); after 1.0 they would require a major revision.
export const SUPPORTED_PROTOCOL_VERSIONS = ['1.0-rc2'] as const;

// ---------- identifiers ----------

export const ProjectKey = z.string().regex(/^[A-Z][A-Z0-9]{1,7}$/, 'project key: 2-8 chars, A-Z0-9, starts with a letter');
export const Ref = z.string().regex(/^[A-Z][A-Z0-9]{1,7}-[1-9][0-9]*$/, 'ref: KEY-N');
export const SessionId = z.string().min(1);

// ---------- §7.1 project ----------

// §11 declared rank tiebreak (finding P-1): applied between urgency
// and priority. `unblocks-others` is now OPT-IN — a coding deployment declares
// it; a manuscript declares link-number over manuscript.position instead.
// Surfaces MUST ignore kinds they do not understand (fall through to priority).
export const RankTiebreak = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unblocks-others') }),
  z.strictObject({
    kind: z.literal('link-number'),
    type: z.string().min(1),                       // link type, e.g. "manuscript"
    field: z.string().min(1),                      // numeric entry field, e.g. "position"
    direction: z.enum(['asc', 'desc']).default('asc'),
  }),
]);
export type RankTiebreak = z.infer<typeof RankTiebreak>;

// §20/§3: a conforming deployment publishes its vocabulary. v1.0 makes that
// obligation machine-readable instead of prose — the slots are the spec's, the
// values are the deployment's, and `surface.describe` serves them.
export const Vocabulary = z.looseObject({
  link_types: z.array(z.string()).optional(),
  kinds: z.array(z.string()).optional(),
  policy_types: z.array(z.string()).optional(),
  continuations: z.array(z.string()).optional(),
  triggers: z.array(z.string()).optional(),
});
export type Vocabulary = z.infer<typeof Vocabulary>;

export const Project = z.strictObject({
  key: ProjectKey,
  name: z.string().min(1),
  goal: z.string().min(1),
  // Binding addition: where this project's knowledge plane lives on disk
  // (plane 2 is git-carried markdown; the surface only ever searches it).
  knowledge_dir: z.string().optional(),
  rank_tiebreak: RankTiebreak.nullish(),
  vocabulary: Vocabulary.nullish(),
});
export type Project = z.infer<typeof Project>;

// ---------- §7.3 links: typed, extensible, round-tripped ----------

export const Links = z.record(z.string().min(1), z.array(z.unknown()));
export type Links = z.infer<typeof Links>;

// ---------- §7.4 event bodies ----------

// Every option carries evidence — a structured summary sufficient to decide
// from the card. The field is mandatory; an empty array is an honest "none".
export const Evidence = z.looseObject({ claim: z.string().min(1) });

export const QuestionOption = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  tradeoff: z.string().optional(),
  evidence: z.array(Evidence),
});

// Which way a question points (§12.6, §15). Until now this was INFERRED from
// one bit — "is the author a registered session?" — and that one bit was doing
// two independent jobs: the evidence obligation and the routing direction.
// They are not the same question, and a creator client is the proof: a watcher
// with its own clock and zero read authority is a MACHINE that needs to ask a
// HUMAN, and had no shape at all (finding PUB-7). The field is OPTIONAL and
// defaults to the old inference, so nothing already written changes meaning.
// The evidence obligation stays attached to the AUTHOR'S CLASS — the two body
// schemas below — never to the direction.
export const QuestionDirection = z.enum(['to_operator', 'to_session']);
export type QuestionDirection = z.infer<typeof QuestionDirection>;

export const QuestionBody = z.strictObject({
  prompt: z.string().min(1),
  options: z.array(QuestionOption).min(1),
  direction: QuestionDirection.optional(),
});

// §12.6 upstream questions (experimental): an operator MAY ask on an item.
// The evidence obligation is deliberately asymmetric — assembling options and
// evidence is cheap for machines and expensive for humans — so operator
// questions carry a prompt and, at most, optional bare options (D-25).
// This is the CLIENT-IDENTITY body, and "client identity" is not the same as
// "human": a creator client is a machine, and one that asks the operator
// SHOULD carry options and evidence exactly as a session does. The schema
// cannot tell the two apart, so it stays permissive here and the obligation
// stays a matter of the author's class, per §12.6.
export const OperatorQuestionBody = z.strictObject({
  prompt: z.string().min(1),
  options: z.array(QuestionOption).optional(),
  direction: QuestionDirection.optional(),
});

export const AnswerBody = z.strictObject({
  question: z.int().positive(),   // seq of the question event
  choice: z.string().min(1),      // option id, or free text for "other"
  text: z.string().optional(),
});

// The continuation ENVELOPE is normative (§12.3: every rejection names one);
// the vocabulary is open — the Family-A/links pattern applied to Family D
// (ruling: OWP-8 Q#4). `record-only` is the ONE registered value (§12.3, §19).
// owp-code's experience vocabulary (docs/decisions.md D-17): needs-info (send
// back with the operator's ask), redirect (this line is wrong; steer in reason),
// rework (review bounce). Only `record-only` closes a thing for good.
export const Continuation = z.string().min(1);

// §12.3: every rejection carries a reason and names its continuation.
export const RejectionBody = z.strictObject({
  reason: z.string().min(1),
  continuation: Continuation,
  what: z.string().optional(),         // the rejected path/plan/option, in words
  event: z.int().positive().optional(), // originating event (e.g. the question)
});

export const TextBody = z.strictObject({ text: z.string().min(1) });

export const AppendableEventKind = z.enum(['progress', 'note', 'question', 'answer', 'rejection']);
// State-transition events are appended by their verbs, never directly.
export const EventKind = z.enum(['progress', 'note', 'question', 'answer', 'rejection', 'unparked', 'completed', 'cancelled']);

export const Event = z.strictObject({
  seq: z.int().positive(),
  item: Ref,
  // v1.0: `actor` is normative (§7.4) — a registered session id OR a client
  // identity. `session` is emitted alongside it as a DEPRECATED alias for one
  // revision, which is the compatibility promise (§4) applied to itself: a
  // rename ships additively, and the old name is removed only at a revision
  // that says so.
  actor: z.string().min(1),
  session: z.string().min(1).optional(),
  kind: EventKind,
  body: z.unknown(),
  at: z.iso.datetime(),
});
export type Event = z.infer<typeof Event>;

// ---------- §7.5 parked ----------

// The handoff is what makes "any agent may resume" safe. All four fields required.
export const Handoff = z.strictObject({
  why: z.string().min(1),
  state_so_far: z.string().min(1),
  resume_point: z.string().min(1),
  on_release: z.string().min(1),
});

export const Park = z.strictObject({
  cause: z.enum(['decision', 'external']),
  trigger: z.string().min(1), // descriptive text; the protocol holds no clock
  // Binding addition (decisions.md D-4): for cause=decision, the seq of the
  // gating question. If absent, any answer on the item releases the park.
  question: z.int().positive().optional(),
  handoff: Handoff,
});
export type Park = z.infer<typeof Park>;

// ---------- §7.2 deliverable ----------

// §8's working set — the states an item passes through while it is live, and
// the only ones §7.2's record sketch enumerates.
export const WorkingState = z.enum(['proposed', 'todo', 'in_progress', 'parked', 'review']);
// §8's exits — "leaves the working set". `completed` is §8's own exit; the
// surface additionally labels a proposal closed with `record-only` as
// `rejected` (D-9), retained as negative knowledge.
//
// These are here because the enum above was the WHOLE published `State` while
// the surface demonstrably stored and returned both of these — complete an
// item, or reject a proposal, and read it back through `work.view`. A surface
// returning a value outside its own published enum is a plain defect: a client
// generating types from `schema/` got a union that its own valid responses
// failed to parse, and the honest fix is for the enum to name what the surface
// emits. This is a WIDENING (§4.2), not a change to §8's machine (§4.1): no
// transition moved, no projection changed, and every value that parsed before
// still parses.
export const ExitState = z.enum(['completed', 'rejected', 'cancelled']);
export const State = z.enum([...WorkingState.options, ...ExitState.options]);
export const Urgency = z.enum(['blocking', 'elevated', 'routine']);

export const Deliverable = z.strictObject({
  ref: Ref,
  project: ProjectKey,
  title: z.string().min(1),
  intent: z.string().min(1), // one line, operator altitude
  kind: z.string().min(1),   // feature | bug | chore | infra | … — open set
  state: State,
  owner_session: SessionId.nullable(),
  parent: Ref.nullable(),    // delegation only; depth ≤ 2
  depends_on: z.array(Ref),
  pin: z.int().positive().nullable(), // operator-set ordinal; 1 first; null = unpinned
  urgency: Urgency,          // assigned by operator/creator clients, never computed
  priority: z.int().min(1).max(5),    // 1 = highest (decisions.md D-5)
  status_line: z.string(),   // owner-maintained, edited in place
  next_checkpoint: z.string(),
  links: Links,
  park: Park.nullable(),
});
export type Deliverable = z.infer<typeof Deliverable>;

// ---------- §7.6 policy ----------

export const Policy = z.strictObject({
  id: z.string().min(1), // pol-N
  scope: z.string().min(1), // project key or ref — no global scope exists
  type: z.string().min(1),  // organizational tag; interpreted, never evaluated
  text: z.string().min(1),
  provenance: z.looseObject({}).nullable(),
  active: z.boolean(),
});
export type Policy = z.infer<typeof Policy>;

// ---------- §7.7 completion record ----------

export const CompletionRecord = z.looseObject({
  outcome: z.string().min(1), // operator-altitude paragraph
  friction: z.array(z.string()).default([]),
  now_true: z.array(z.string()).default([]),
  supersedes: z.array(z.string()).default([]),
  rejected: z.array(z.looseObject({ what: z.string().min(1), reason: z.string().min(1) })).default([]),
  knowledge_edits: z.array(z.string()).default([]),
});
export type CompletionRecord = z.infer<typeof CompletionRecord>;

// ---------- work.create payload ----------

// Strict on purpose: there is no due date, deadline, until, or estimate field,
// and unknown fields are rejected — the no-calendar rule is enforced at the schema.
export const CreateItem = z.strictObject({
  project: ProjectKey.optional(), // defaults to the session's project
  title: z.string().min(1),
  intent: z.string().min(1),
  kind: z.string().min(1).default('feature'),
  urgency: Urgency.default('routine'),
  priority: z.int().min(1).max(5).default(3),
  depends_on: z.array(Ref).default([]),
  parent: Ref.optional(),
  links: Links.default({}),
});
export type CreateItem = z.infer<typeof CreateItem>;

// ---------- §14 reground ----------

export const RegroundCompleted = z.strictObject({
  title: z.string().min(1),
  intent: z.string().min(1),
  kind: z.string().min(1).default('feature'),
  links: Links.default({}),
  record: CompletionRecord,
});

export const RegroundInFlight = z.strictObject({
  ref: Ref.optional(), // present = a claim about an existing item
  title: z.string().optional(),
  intent: z.string().optional(),
  kind: z.string().optional(),
  status_line: z.string().optional(),
  next_checkpoint: z.string().optional(),
  links: Links.optional(),
  park: Park.optional(), // v0.2: honestly report externally-gated work
});

export const RegroundPayload = z.strictObject({
  completed: z.array(RegroundCompleted).default([]),
  in_flight: z.array(RegroundInFlight).default([]),
  proposed: z.array(CreateItem).default([]),
});
export type RegroundPayload = z.infer<typeof RegroundPayload>;

// ---------- verb inputs ----------
// One entry per verb; the HTTP binding and the CLI both dispatch off this table.

export const VerbInputs = {
  // agent-side (§10) — require a registered session
  'session.register': z.strictObject({
    tool: z.string().min(1),
    host: z.string().min(1),
    project: ProjectKey,
    parent: SessionId.optional(), // lineage only; may point into another project
  }),
  'session.heartbeat': z.strictObject({}),
  'session.end': z.strictObject({}), // binding addition, decisions.md D-2
  'work.next': z.strictObject({ cursor: z.int().nonnegative().default(0) }),
  'work.claim': z.strictObject({ ref: Ref, cursor: z.int().nonnegative().default(0) }),
  'work.get': z.strictObject({
    ref: Ref,
    cursor: z.int().nonnegative().default(0),
    limit: z.int().positive().max(1000).optional(),   // long-lived items (§10)
  }),
  'work.create': z.strictObject({ item: CreateItem, dispatch: z.boolean() }),
  'event.append': z.strictObject({ ref: Ref, kind: AppendableEventKind, body: z.unknown() }),
  'work.park': z.strictObject({ ref: Ref, park: Park }),
  // v1.0: `intent` and `depends_on` join the edit-in-place set. Three worlds
  // hit the same wall — a field the protocol says a client owns that no verb
  // lets a client restate (research R-1, publish revision drift, code's
  // mid-flight dependencies). STRUCTURE is steerable by owner or operator;
  // `status_line`/`next_checkpoint` remain owner-only because they are the
  // record's VOICE (D-27 stands).
  //
  // `kind` joins them on the same argument (finding R-4): it was the last
  // structural field a client owned and could not restate. It is an OPEN LABEL
  // the surface never interprets, so there is no semantic cost — only the
  // question of whether a deliverable may change what it IS, which v1.0
  // already answered "yes" for what it is FOR. It bites hardest where 1.0
  // wanted reuse: import another world's creator client and everything it
  // mints arrives wearing that world's vocabulary, with `intent` restatable
  // and `kind` frozen — and the only workaround, delete and recreate, throws
  // away the ref, the worklog and the provenance a ref exists to keep.
  'work.update': z.strictObject({
    ref: Ref,
    status_line: z.string().optional(),
    next_checkpoint: z.string().optional(),
    intent: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    depends_on: z.array(Ref).optional(),
    links: Links.optional(), // per-type replace wholesale; unnamed types untouched
  }),
  'work.complete': z.strictObject({
    ref: Ref,
    record: CompletionRecord,
    // Agents stop at review unless project policy says otherwise (§13.1); the
    // *client* interprets that policy and passes finalize accordingly (D-3).
    finalize: z.boolean().default(false),
  }),
  'policy.applicable': z.strictObject({ ref: Ref }),
  'knowledge.query': z.strictObject({ q: z.string().min(1), project: ProjectKey.optional() }),
  'reground.submit': RegroundPayload,

  // operator / creator-client side (§10)
  // v1.0: projections join the protocol's own cursor discipline. Every other
  // read is bounded; these returned the whole surface (code + desk, at scale).
  'attention': z.strictObject({
    project: ProjectKey.optional(),
    limit: z.int().positive().max(500).optional(),
    // OPAQUE keyset token echoed from a previous call — never an index (§15).
    cursor: z.string().min(1).optional(),
  }),
  'portfolio': z.strictObject({ project: ProjectKey.optional() }),
  // Operator item projection (binding addition, decisions.md D-14): the
  // attention queue and portfolio speak refs; this is how a ref is inspected.
  'work.view': z.strictObject({
    ref: Ref,
    cursor: z.int().nonnegative().default(0),
    limit: z.int().positive().max(1000).optional(),   // items that live for quarters
    // Which END a bounded worklog is taken from (findings D-8 / owp-code).
    // Default preserves the v1.0-rc1 behaviour; an operator client opening a
    // quarter-old item wants 'newest'. Order within the page stays
    // chronological either way.
    order: z.enum(['oldest', 'newest']).default('oldest'),
  }),
  'answer': z.strictObject({
    ref: Ref,
    question: z.int().positive(),
    choice: z.string().min(1),
    text: z.string().optional(),
  }),
  'reject': z.strictObject({
    ref: Ref,
    reason: z.string().min(1),
    continuation: Continuation,
    what: z.string().optional(),
    event: z.int().positive().optional(),
  }),
  'triage': z.strictObject({
    target: z.string().min(1), // proposed ref | review ref | reground diff id (rg-N)
    decision: z.enum(['accept', 'reject']),
    reason: z.string().optional(), // required on reject; retained as negative knowledge
    // Reject only. Defaults: proposal → record-only (exit), review → rework
    // (bounce). A proposal exits ONLY on record-only; any other continuation
    // keeps it alive, awaiting machine-side enrichment (D-17).
    continuation: Continuation.optional(),
  }),
  'promote': z.strictObject({
    event: z.int().positive(),
    to: z.enum(['proposal', 'policy']),
    // proposal target:
    title: z.string().optional(),
    intent: z.string().optional(),
    kind: z.string().optional(),
    // policy target:
    scope: z.string().optional(), // defaults to the event's project
    type: z.string().optional(),
    text: z.string().optional(),
  }),
  // A trigger-owner addresses parks BY TRIGGER (D-28): the cron that owns
  // "window:sun-0300" releases every park carrying it without needing a read
  // to discover refs — the trigger IS the address. ref and trigger are
  // mutually exclusive; exactly one is required.
  'work.unpark': z.strictObject({
    ref: Ref.optional(),
    trigger: z.string().min(1).optional(),
    note: z.string().optional(),
  }).refine(a => !!a.ref !== !!a.trigger, { message: 'exactly one of ref or trigger' }),
  // Cancellation is an explicit, reasoned terminal transition. It is distinct
  // from rejecting a proposal (a verdict) and completing delivered work.
  'work.cancel': z.strictObject({ ref: Ref, reason: z.string().min(1) }),
  'work.release': z.strictObject({ ref: Ref, note: z.string().optional() }), // §5/§14; decisions.md D-1
  'policy.set': z.strictObject({
    scope: z.string().min(1),
    type: z.string().min(1),
    text: z.string().min(1),
    provenance: z.looseObject({}).optional(),
  }),
  'policy.retire': z.strictObject({ id: z.string().min(1) }),
  'work.pin': z.strictObject({ ref: Ref, pin: z.int().positive().nullable() }),
  // v1.0: urgency joins steering. §7.2 said clients own it and no verb assigned
  // it after creation (owp-desk). At least one of the two is required.
  'work.reprioritize': z.strictObject({
    ref: Ref,
    priority: z.int().min(1).max(5).optional(),
    urgency: Urgency.optional(),
  }).refine(a => a.priority !== undefined || a.urgency !== undefined,
    { message: 'reprioritize needs priority, urgency, or both' }),

  // v1.0 discovery: the one bootstrap read. Callable with or without a session
  // and with or without credentials — a client must be able to learn what it is
  // talking to, including its OWN authority, before it acts.
  'surface.describe': z.strictObject({}),

  // v1.0: the session projection §7.4 already assumed and never defined.
  'session.view': z.strictObject({ id: SessionId }),
  'sessions': z.strictObject({ project: ProjectKey.optional(), include_ended: z.boolean().default(false) }),

  // administrative plane (binding addition, decisions.md D-7; §10 in v1.0)
  'project.create': Project,
  'project.list': z.strictObject({}),
} as const;

export type VerbName = keyof typeof VerbInputs;
export const VERB_NAMES = Object.keys(VerbInputs) as VerbName[];

// Which verbs require a registered session vs. accept a bare client identity.
export const SESSION_VERBS = new Set<VerbName>([
  'session.heartbeat', 'session.end', 'work.next', 'work.claim', 'work.get',
  'work.park', 'work.complete', 'reground.submit',
]);
// work.update is session-preferred, but client actors may patch LINKS only
// (D-27): watchers report observed world-state into the link envelope, and
// operators curate links as steering. status_line/next_checkpoint stay
// owner-only — the voice of the surface record belongs to whoever holds it.
// event.append is session-preferred but client actors may append `note` events
// only — the operator's non-verdict voice (D-18, ruling OWP-8 Q#4 = C stage one).

// v1.0 generalized grants (§18): agent authority PLUS named verbs under an
// optional scope. Replaces v0.3's single mechanism (unpark trigger prefixes),
// and covers review delegation (code) and project-scoped creators (ops).
export const Grant = z.strictObject({
  verbs: z.array(z.string().min(1)).min(1),
  project: ProjectKey.optional(),
  trigger_prefix: z.string().min(1).optional(),
  // WORKING states only, deliberately: a grant bounds what an actor may act
  // ON, and no verb acts on an item that has exited. This stays exactly the
  // set it has always accepted, so widening `State` above changes nothing a
  // grant holder can express.
  states: z.array(WorkingState).optional(),
});
export type Grant = z.infer<typeof Grant>;

// AAA split (operator framing on OWPC-3 acceptance; spec §18; D-20):
// authentication = binding concern (tokens in http.ts); AUTHORIZATION = these
// authority classes, enforced at the surface; audit = verb_log incl. denials.
// Agent authority gets the non-destructive verbs: no triage, no policy write,
// no delete, no unpark (trigger-owner/operator grant), release own claims only
// (enforced in the verb). Operator authority: every verb.
// v1.0 ruling: `work.view` left this set. Spec and implementation disagreed,
// and the design principle settles it — agents read assignments, not boards.
// `surface.describe` is in it because every actor must be able to ask what it
// is talking to before it acts.
// `sessions` / `session.view` are in it because §18 RULED they must be, and
// this surface was behind the ruling (finding C-3): "An agent MAY resolve
// session identities **within its own project** (§15) — §7.4 requires every
// client to tell a session id from a client identity, and a session already
// sees peer ids in `owner_session`, so the resolution leaks nothing and the
// alternative is a MUST no agent can obey." Membership here only opens the
// door; the surface confines an agent-class caller to its own project.
// These two are the only READS in the set that are not about the caller's own
// assignment, and they stay narrow for that reason: identities, one project.
export const AGENT_VERBS = new Set<VerbName>([
  'session.register', 'session.heartbeat', 'session.end',
  'work.next', 'work.claim', 'work.get', 'work.create',
  'event.append', 'work.park', 'work.update', 'work.complete', 'work.release',
  'policy.applicable', 'knowledge.query', 'reground.submit', 'surface.describe',
  'sessions', 'session.view',
]);
// Everything else accepts either a session or a client identity (operator CLI,
// cron creators, watchers). M1 carries no credential scopes; see decisions.md D-8.

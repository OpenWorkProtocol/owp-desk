// The surface: verb semantics over the store. This is the layer both bindings
// (HTTP server, direct-mode CLI) and the conformance tests exercise.
//
// The v0.2 invariant, load-bearing throughout: the surface computes and
// reports; only clients mutate work state. Nothing in here runs on a timer,
// expires anything, or acts on an observation.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  AnswerBody, CompletionRecord, CreateItem, OperatorQuestionBody, QuestionBody, RejectionBody, TextBody,
  RegroundCompleted, RegroundInFlight,
  AGENT_VERBS, ExitState, SESSION_VERBS, VerbInputs, VERB_NAMES, PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS,
  type Deliverable, type Event, type Grant, type Links, type Park, type Policy,
  type QuestionDirection, type RankTiebreak, type VerbName,
} from './schema.ts';
import { EXITED, Store, type DeliverableRow, type SessionRow } from './store.ts';

export class OwpError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Resolved authority for one call: the class, plus any grants that apply
// (empty for operator authority, which passes everything).
interface Ctx { authority: 'agent' | 'operator'; grants: Grant[] }
const err = (code: string, msg: string) => new OwpError(code, msg);
// Zero-padded so string order equals numeric order (see the note on cursors).
const seqKey = (n: number) => `q${String(n).padStart(12, '0')}`;

// authority is AUTHORIZATION (D-20): set explicitly by an authenticating
// binding (token → class), or inferred in open/direct mode — session actors
// are agent-class, bare clients operator-class (local trust).
// grants (D-26) are §18's explicit per-trigger authority, concrete: an
// agent-class actor may additionally unpark parks whose trigger starts with a
// granted prefix — the window cron can release its window and nothing else.
export interface Actor {
  session?: string;
  client?: string;
  authority?: 'agent' | 'operator';
  // v1.0 (§18): generalized grants — agent authority plus named verbs under an
  // optional scope. `unpark_triggers` is accepted as the v0.3 spelling and
  // normalized into a grant, so existing creator clients keep working.
  grants?: Grant[];
  unpark_triggers?: string[];
}

function normalizeGrants(actor: Actor): Grant[] {
  const grants = [...(actor.grants ?? [])];
  if (actor.unpark_triggers?.length) {
    for (const prefix of actor.unpark_triggers) grants.push({ verbs: ['work.unpark'], trigger_prefix: prefix });
  }
  return grants;
}

export interface AttentionRow {
  kind: 'decision' | 'triage' | 'health' | 'review';
  target: string;          // ref, or rg-N for reground diffs
  reason: string;          // one line
  since: string;           // ISO
  // The discriminator that makes the row order TOTAL (§15). One target can
  // raise several rows of one kind at one instant — two open questions on an
  // item, two unreconciled link entries — and (kind, since, target) does not
  // separate them. Without it the cursor cannot name a single row: it resolves
  // to the first of the tie and serves that row forever, so the rest of the
  // queue is unreachable. Stable for as long as the row exists. Opaque to
  // clients, who only ever see it inside the cursor they echo back.
  key: string;
  elapsed_s: number;       // observation, never a deadline
  action: string;          // the single action that clears the row
  // The deployment's own nouns live here (§15, finding D-6): a dispatcher
  // needs the customer and lane, an editor the manuscript position. A row
  // without them is not "sufficient to decide from the row".
  links?: Links;
  // What the row is ABOUT (findings D-7 / PUB-10, filed independently by the
  // load board and the writing room). Three of the four row kinds forced a
  // client to call work.view just to learn the title: a dispatcher cannot
  // render "which load is this" and a novelist cannot tell whether a question
  // sits on chapter 17 or on a continuity item a watcher minted an hour ago.
  // The surface holds the deliverable at the moment it attaches `links`, so
  // withholding this bought every operator client an N+1 read per poll.
  // Absent on reground rows, which have no deliverable.
  item?: { title: string; kind: string; urgency: string };
  // The standing rules that govern this row's action, when that action cannot
  // be taken back (§10, §15, finding O-8). §10 makes an agent consult
  // `policy.applicable` before an irreversible act and hands it the applicable
  // policies in its assignment packet; the operator — slower, more
  // interruptible, and more likely to be holding a phone — was handed nothing,
  // and had to fetch them per row to render a confirm bar honestly. Absent
  // when nothing applies, and absent on rows whose action is reversible or
  // belongs to somebody else; see the note in attentionRows().
  policies?: Policy[];
  // Everything needed to decide from the card (D-15): the question body, the
  // pending completion record, the park payload, or the reground diff payload.
  detail?: unknown;
}

const TOOL_PREFIX: Record<string, string> = { 'claude-code': 'cc', codex: 'cx' };

const nowIso = () => new Date().toISOString();
const elapsedS = (iso: string) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
const truncate = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Spec-shaped view of a deliverable: internals stripped, park only when parked.
function publicView(d: DeliverableRow): Deliverable {
  return {
    ref: d.ref, project: d.project, title: d.title, intent: d.intent, kind: d.kind,
    state: d.state, owner_session: d.owner_session, parent: d.parent,
    depends_on: d.depends_on, pin: d.pin, urgency: d.urgency, priority: d.priority,
    status_line: d.status_line, next_checkpoint: d.next_checkpoint, links: d.links,
    park: d.state === 'parked' ? d.park : null,
  };
}

export class Surface {
  store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  // Single entry point for every binding.
  call(verb: string, args: unknown, actor: Actor): unknown {
    if (!(verb in VerbInputs)) throw err('UNKNOWN_VERB', `unknown verb: ${verb}`);
    const name = verb as VerbName;

    let parsed: unknown;
    try {
      parsed = VerbInputs[name].parse(args ?? {});
    } catch (e) {
      if (e instanceof z.ZodError) throw err('VALIDATION', `${verb}: ${z.prettifyError(e)}`);
      throw e;
    }

    let session: SessionRow | null = null;
    if (actor.session) {
      session = this.store.getSession(actor.session);
      if (!session) throw err('NOT_FOUND', `unknown session: ${actor.session}`);
      if (session.status === 'ended') throw err('STATE', `session ${session.id} has ended`);
    }
    if (SESSION_VERBS.has(name) && !session) {
      throw err('SESSION_REQUIRED', `${verb} requires a registered session`);
    }
    const actorId = session?.id ?? actor.client ?? 'client';

    // Authorization (§18): agent-class actors get the non-destructive verb set
    // — plus any explicit grant. Denials are audited (the third A).
    const authority = actor.authority ?? (session ? 'agent' : 'operator');
    const grants = normalizeGrants(actor);
    const granted = grants.some(g => g.verbs.includes(name));
    if (authority === 'agent' && !AGENT_VERBS.has(name) && !granted) {
      this.store.logVerb(actorId, `denied:${name}`, parsed);
      throw err('FORBIDDEN', `${verb} requires operator authority`);
    }

    if (session) this.store.touchSession(session.id); // heartbeat piggybacks on every verb
    this.store.logVerb(actorId, name, parsed);

    return this.dispatch(name, parsed, session, actorId, {
      authority,
      grants: authority === 'agent' ? grants : [],
    });
  }

  // Every grant covering this verb. Operator authority passes everything, so
  // callers treat an empty list as unrestricted.
  //
  // **Grants compose** (§18, finding D-2): a client holding
  // {work.unpark, edi214:} and {work.unpark, window:} owns both prefixes.
  // Returning only the first match — as this did — silently voided the second,
  // which is the opposite of what "the surface enforces their intersection"
  // means: union ACROSS grants, intersection WITHIN one.
  private grantsFor(ctx: Ctx, verb: VerbName): Grant[] {
    if (ctx.authority === 'operator' || !ctx.grants.length) return [];
    return ctx.grants.filter(g => g.verbs.includes(verb));
  }

  // True when the actor may use `verb` with operator-level authority: either it
  // is the operator, or it holds a grant naming that verb (§18/O-6 — a grant
  // confers operator-level use of the named verbs within its scope, including
  // verbs the agent class may already call in a narrower way).
  private hasOperatorUse(ctx: Ctx, verb: VerbName): boolean {
    return ctx.authority === 'operator' || this.grantsFor(ctx, verb).length > 0;
  }

  // §18, v1.0: **no actor may decide its own output.** A grant holder may not
  // triage an item whose pending completion record it authored, nor answer a
  // question it asked. This is the invariant that makes delegation safe, and
  // no deployment can express it for itself.
  private refuseSelfVerdict(ctx: Ctx, actorId: string, target: string, kind: 'triage' | 'answer', event?: number) {
    if (ctx.authority === 'operator') return;
    if (kind === 'triage') {
      const d = this.store.getDeliverable(target);
      // Exact, not inferred: the pending record names who authored it.
      const author = (d?.completion as { completed_by?: string } | null)?.completed_by;
      if (d?.state === 'review' && author && author === actorId) {
        throw err('FORBIDDEN', 'no actor may decide its own output: this actor authored the completion record under review');
      }
      // A proposal is an output too (finding R-3). Accepting your own proposal
      // is the same act as approving your own work — a grant that can both
      // propose and triage would otherwise be an unsupervised loop.
      if (d?.state === 'proposed' && d.created_by && d.created_by === actorId) {
        throw err('FORBIDDEN', 'no actor may decide its own output: this actor created the proposal');
      }
    } else if (event) {
      const q = this.store.getEvent(event);
      if (q && q.actor === actorId) {
        throw err('FORBIDDEN', 'no actor may decide its own output: this actor asked the question');
      }
    }
  }

  private dispatch(verb: VerbName, args: any, session: SessionRow | null, actorId: string, ctx: Ctx): unknown {
    switch (verb) {
      case 'session.register': return this.sessionRegister(args);
      case 'session.heartbeat': return { ok: true, at: nowIso() };
      case 'session.end': return this.sessionEnd(session!);
      case 'work.next': return this.workNext(session!, args.cursor);
      case 'work.claim': return this.workClaim(session!, args.ref, args.cursor);
      case 'work.get': return this.workGet(session!, args.ref, args.cursor, args.limit);
      case 'work.create': return this.workCreate(args.item, args.dispatch, session, actorId);
      case 'event.append': return this.eventAppend(ctx, session, actorId, args.ref, args.kind, args.body);
      case 'work.park': return this.workPark(session!, args.ref, args.park);
      case 'work.update': return this.workUpdate(session, actorId, ctx, args);
      case 'work.complete': return this.workComplete(session!, args.ref, args.record, args.finalize);
      case 'policy.applicable': return this.policyApplicable(args.ref);
      case 'knowledge.query': return this.knowledgeQuery(args.q, args.project ?? session?.project);
      case 'reground.submit': return this.regroundSubmit(session!, args);
      case 'attention': return this.attention(args);
      case 'portfolio': return this.portfolio(args.project);
      case 'work.view': return this.workView(args.ref, args.cursor, args.limit, args.order);
      case 'surface.describe': return this.describe(ctx, session, actorId);
      case 'session.view': return this.sessionView(ctx, session, args.id);
      case 'sessions': return this.sessionList(ctx, session, args.project, args.include_ended);
      case 'answer': {
        this.refuseSelfVerdict(ctx, actorId, args.ref, 'answer', args.question);
        return this.answer(actorId, args);
      }
      case 'reject': {
        // A rejection is a decision (§12.2): it resolves the question and
        // releases the park. Rejecting your own question, or your own
        // completion record, is deciding your own output just as much as
        // answering or accepting it is.
        this.refuseSelfVerdict(ctx, actorId, args.ref, args.event ? 'answer' : 'triage', args.event);
        return this.reject(actorId, args);
      }
      case 'triage': {
        this.refuseSelfVerdict(ctx, actorId, args.target, 'triage');
        // Composed grants: the call is allowed if ANY grant naming the verb
        // admits the target (union across grants, intersection within one).
        const grants = this.grantsFor(ctx, 'triage');
        if (grants.length) this.enforceAnyGrantScope(grants, args.target);
        return this.triage(actorId, args.target, args.decision, args.reason, args.continuation);
      }
      case 'promote': return this.promote(actorId, args);
      case 'work.unpark': return this.workUnpark(actorId, args, this.grantsFor(ctx, 'work.unpark'));
      case 'work.cancel': return this.workCancel(ctx, actorId, args.ref, args.reason);
      case 'work.release': return this.workRelease(ctx, session, actorId, args.ref, args.note);
      case 'policy.set': return this.store.insertPolicy(args.scope, args.type, args.text, args.provenance ?? null);
      case 'policy.retire': {
        if (!this.store.retirePolicy(args.id)) throw err('NOT_FOUND', `no policy ${args.id}`);
        return { ok: true };
      }
      case 'work.pin': return this.steer(args.ref, { pin: args.pin });
      case 'work.reprioritize': return this.steer(args.ref, {
        ...(args.priority !== undefined ? { priority: args.priority } : {}),
        ...(args.urgency !== undefined ? { urgency: args.urgency } : {}),
      });
      case 'project.create': {
        if (this.store.getProject(args.key)) throw err('CONFLICT', `project ${args.key} exists`);
        this.store.createProject(args);
        return { ok: true, key: args.key };
      }
      case 'project.list': return this.store.listProjects().map(({ counter, ...p }) => p);
    }
  }

  // ---------- sessions ----------

  private sessionRegister(args: { tool: string; host: string; project: string; parent?: string }) {
    if (!this.store.getProject(args.project)) throw err('NOT_FOUND', `no project ${args.project}`);
    const prefix = TOOL_PREFIX[args.tool] ?? (args.tool.replace(/[^a-z0-9]/gi, '').slice(0, 2).toLowerCase() || 'ag');
    let id = `${prefix}-${randomBytes(2).toString('hex')}`;
    while (this.store.getSession(id)) id = `${prefix}-${randomBytes(2).toString('hex')}`;
    const t = nowIso();
    const row: SessionRow = {
      id, tool: args.tool, host: args.host, project: args.project,
      parent_session: args.parent ?? null, started_at: t, last_seen: t,
      current_item: null, status: 'active',
    };
    this.store.insertSession(row);
    return row;
  }

  private sessionEnd(session: SessionRow) {
    const owned = this.store.deliverablesWhere(`owner_session = ?`, session.id).map(d => d.ref);
    this.store.touchSession(session.id, { status: 'ended', current_item: null });
    // Owned items are NOT auto-released — recovery is a client action (§8).
    return { ok: true, still_owned: owned };
  }

  // ---------- the §11 chooser ----------

  // Stage 1, hard filter: session's project, state todo, unheld, dependencies met.
  private eligible(project: string): DeliverableRow[] {
    return this.store
      .deliverablesWhere(`project = ? AND state = 'todo' AND owner_session IS NULL`, project)
      .filter(d => d.depends_on.every(ref => {
        const dep = this.store.getDeliverable(ref);
        return dep && dep.state === 'completed';
      }));
  }

  // The project's declared tiebreak (§11): 0 for "no opinion", so an
  // undeclared or unrecognized tiebreak falls through to priority.
  private tiebreakKey(d: DeliverableRow, tb: RankTiebreak | null | undefined): number {
    if (!tb) return 0;
    if (tb.kind === 'unblocks-others') return -this.store.unblocksCount(d.ref);
    if (tb.kind === 'link-number') {
      const entry = (d.links[tb.type] ?? [])[0] as Record<string, unknown> | undefined;
      const raw = entry?.[tb.field];
      if (typeof raw !== 'number') return Number.MAX_SAFE_INTEGER; // unpositioned sorts last
      return tb.direction === 'desc' ? -raw : raw;
    }
    return 0;
  }

  // Stage 2, soft rank: pin → urgency (recently-released parks count as
  // elevated) → declared tiebreak → priority → age. Tiers are normative;
  // only the tiebreak slot is the deployment's (finding P-1).
  private rank(items: DeliverableRow[], tiebreak?: RankTiebreak | null): DeliverableRow[] {
    const urgencyRank = (d: DeliverableRow) =>
      d.urgency === 'blocking' ? 0 : d.urgency === 'elevated' || d.elevated_release ? 1 : 2;
    const keys = new Map(items.map(d => [d.ref, [
      d.pin === null ? 1 : 0,
      d.pin ?? Number.MAX_SAFE_INTEGER,
      urgencyRank(d),
      this.tiebreakKey(d, tiebreak),
      d.priority,
      Date.parse(d.eligible_since ?? d.created_at),
    ]]));
    // Final tier (§11): the CREATION ORDINAL, which makes the ranking total.
    // Refs are KEY-N with N monotonic per project, and the chooser only ever
    // ranks within one project, so the numeric suffix is exactly that ordinal.
    // Lexicographic ref order would be wrong: PAY-10 sorts before PAY-2.
    const ordinal = (ref: string) => Number(ref.slice(ref.lastIndexOf('-') + 1));
    return [...items].sort((a, b) => {
      const ka = keys.get(a.ref)!, kb = keys.get(b.ref)!;
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
      return ordinal(a.ref) - ordinal(b.ref);
    });
  }

  // Which way a question points (§12.6, finding PUB-7).
  //
  // Until now this was inferred from a single bit — "is the author a
  // registered session?" — and that one bit decided TWO independent things:
  // the EVIDENCE OBLIGATION (machines assemble options and evidence; humans
  // must not be made to) and the ROUTING DIRECTION (to the operator's queue,
  // or to the agent's assignment packet). Those are not the same question, and
  // the gap between them had a real shape: a creator client — a watcher with
  // its own clock and zero read authority, §5's purest case — is a MACHINE
  // that needs to ask a HUMAN, and the protocol had no way for it to. One
  // deployment ran its continuity watcher as two actors from one process to
  // fake it, so its audit log showed a session id for the question and a
  // client identity for the observation that produced it, from the same
  // program in the same loop.
  //
  // The body may now SAY which way it points. When it does not, the answer is
  // exactly the old inference, so every question already written keeps its
  // meaning and no client that never sets the field can tell the difference.
  // The evidence obligation is unchanged and stays attached to the AUTHOR'S
  // CLASS in validateBody(): a machine asking a human still owes options and
  // evidence, and a human asking a machine still does not.
  private questionDirection(q: Event): QuestionDirection {
    const stated = (q.body as { direction?: string } | null | undefined)?.direction;
    if (stated === 'to_operator' || stated === 'to_session') return stated;
    return this.store.getSession(q.actor) ? 'to_operator' : 'to_session';
  }

  // Open questions as a client should read them: §12.6's direction is carried,
  // never left to be re-derived. The same shape `work.view` returns, because
  // an agent reading its packet and an operator reading the item are asking
  // the same thing about the same events.
  private openQuestionsWithDirection(ref?: string) {
    return this.store.openQuestions(ref).map(q => ({ ...q, direction: this.questionDirection(q) }));
  }

  private assignmentPacket(d: DeliverableRow, cursor: number) {
    const worklog = this.store.eventsSince(d.ref, cursor);
    return {
      deliverable: publicView(this.store.getDeliverable(d.ref)!),
      // §12.6 tells an agent to answer UPSTREAM questions from its packet,
      // where they arrive mixed in with questions earlier sessions asked, and
      // §18 forbids answering one it asked itself. Carrying `direction` is
      // what makes that separation readable rather than guessed: the previous
      // best an agent could do was a shape test on the options array, which
      // failed the moment an operator supplied options (finding C-3).
      open_questions: this.openQuestionsWithDirection(d.ref),
      policies: this.policyApplicable(d.ref),
      worklog,
      cursor: worklog.length ? worklog[worklog.length - 1].seq : cursor,
    };
  }

  private workNext(session: SessionRow, cursor: number) {
    const tiebreak = this.store.getProject(session.project)?.rank_tiebreak;
    return this.store.tx(() => {
      for (const d of this.rank(this.eligible(session.project), tiebreak)) {
        if (this.store.tryClaim(d.ref, session.id)) {
          this.store.touchSession(session.id, { current_item: d.ref });
          return this.assignmentPacket(d, cursor);
        }
      }
      return null; // no eligible work — the session ends cleanly or waits
    });
  }

  private workClaim(session: SessionRow, ref: string, cursor: number) {
    const d = this.mustGet(ref);
    if (d.project !== session.project) throw err('FORBIDDEN', `${ref} is in ${d.project}; session is bound to ${session.project}`);
    return this.store.tx(() => {
      if (!this.store.tryClaim(ref, session.id)) {
        const cur = this.store.getDeliverable(ref)!;
        if (cur.owner_session) throw err('CONFLICT', `${ref} is held by ${cur.owner_session}`);
        throw err('STATE', `${ref} is ${cur.state}, not claimable`);
      }
      const unmet = d.depends_on.filter(r => this.store.getDeliverable(r)?.state !== 'completed');
      if (unmet.length) throw new OwpError('STATE', `${ref} has unmet dependencies: ${unmet.join(', ')}`); // rolls back the claim
      this.store.touchSession(session.id, { current_item: ref });
      return this.assignmentPacket(d, cursor);
    });
  }

  // Operator/creator read of any item: spec-shaped record, pending completion
  // (review state), worklog, open questions. Read-only projection (D-14).
  // v1.0: bounded — items that live for quarters have long worklogs.
  private workView(ref: string, cursor: number, limit?: number, order: 'oldest' | 'newest' = 'oldest') {
    const d = this.mustGet(ref);
    const all = this.store.eventsSince(ref, cursor);
    // Findings D-8 / owp-code: `limit` bounded the worklog from the wrong end
    // for its only caller. An operator opening an item that has run for a
    // quarter wants the newest events; the agent resuming one wants the
    // oldest, from its cursor. Both clients were reading the same verb and
    // one of them was fetching the whole log to throw the front of it away.
    // Chronological order is preserved either way — `newest` selects the
    // TAIL, it does not reverse it.
    const worklog = limit ? (order === 'newest' ? all.slice(-limit) : all.slice(0, limit)) : all;
    return {
      deliverable: publicView(d),
      completion: d.completion,
      // §12.6 made the ROUTING normative — an operator's question goes to the
      // assignment packet, never to the operator's own queue — but left a
      // client no way to tell the two apart in this array. owp-research's
      // briefing room shipped the consequence: the analyst's own question came
      // back to them as a fork to decide. The surface already knows (attention
      // filters on exactly this); saying it costs nothing.
      open_questions: this.openQuestionsWithDirection(ref),
      worklog,
      cursor: worklog.length ? worklog[worklog.length - 1].seq : cursor,
      more: limit ? all.length > worklog.length : false,
    };
  }

  // ---------- v1.0 discovery (§9) ----------

  // The one bootstrap read: what protocol, what surface, what features, what
  // the CALLER may do, and the deployment's published vocabulary. Callable
  // with or without a session and with or without credentials — a client must
  // be able to learn what it is talking to before it acts.
  private describe(ctx: Ctx, session: SessionRow | null, actorId: string) {
    const projects = this.store.listProjects();
    return {
      protocol: { version: PROTOCOL_VERSION, supported: [...SUPPORTED_PROTOCOL_VERSIONS] },
      surface: { name: 'owp-code reference surface', version: '0.1.0' },
      features: {
        upstream_questions: true,          // §12.6
        grants: true,                      // §18 verb grants
        rank_tiebreak_kinds: ['unblocks-others', 'link-number'],
        knowledge_query: 'grep',           // retrieval strategy is the deployment's
        projection_cursors: true,
        complete_to_exit: true,            // finalize:true supported
        // §4.2/§9: everything additive is DECLARED, so a client learns what
        // this surface can do by asking rather than by trying and reading the
        // error. Each of these is one closed finding.
        attention_totals: true,            // §15 per-kind queue counts   (C-5)
        restatable_kind: true,             // §7.2 kind is structure      (R-4)
        question_direction: true,          // §12.6 stated, not inferred  (PUB-7)
        row_policies: true,                // §15 rules on irreversible rows (O-8)
        agent_identity_resolution: true,   // §18 within the own project  (C-3)
      },
      authority: {
        class: ctx.authority,
        grants: ctx.grants,
        session: session ? { id: session.id, project: session.project } : null,
        actor: actorId,
      },
      verbs: VERB_NAMES,
      projects: projects.map(p => ({
        key: p.key, name: p.name,
        rank_tiebreak: p.rank_tiebreak ?? null,
        vocabulary: p.vocabulary ?? null,
      })),
    };
  }

  // ---------- v1.0 session projection (§15) ----------
  // §7.4 required clients to distinguish a session actor from a client
  // identity and cited a projection that existed nowhere. Observations only.

  // §18, v1.0, ruled and until now not implemented here (finding C-3):
  //
  //   "An agent MAY resolve session identities **within its own project**
  //    (§15) — §7.4 requires every client to tell a session id from a client
  //    identity, and a session already sees peer ids in `owner_session`, so
  //    the resolution leaks nothing and the alternative is a MUST no agent
  //    can obey."
  //
  // Both verbs answered FORBIDDEN to a session actor, so §7.4's MUST was
  // unobeyable by the class that most needs it: §12.6 tells an agent to answer
  // upstream questions from its packet, where they arrive mixed in with
  // questions earlier SESSIONS asked, and §18 forbids answering one it asked
  // itself. What the fleet ran instead was a shape test on the options array,
  // sound only while §12.6's evidence exemption held in practice, and it
  // failed toward doing nothing the moment an operator supplied options.
  //
  // Returns the set of projects an agent-class caller may resolve within, or
  // null for unrestricted. An agent-authority actor with no session has no
  // "own project" and resolves nothing — the ruling scopes the CLASS to a
  // project, and a client that registered no session names none, which is the
  // same shape C-4's ruling took for own-claim release.
  private identityScope(ctx: Ctx, session: SessionRow | null, verb: VerbName): Set<string> | null {
    if (ctx.authority === 'operator') return null;
    // §18: a grant confers operator-level use of the verbs it names within its
    // scope. An unscoped grant naming the verb is therefore unrestricted; a
    // project-scoped one admits that project beside the caller's own.
    const grants = this.grantsFor(ctx, verb);
    if (grants.some(g => !g.project)) return null;
    const scope = new Set<string>();
    if (session) scope.add(session.project);
    for (const g of grants) if (g.project) scope.add(g.project);
    if (!scope.size) {
      throw err('FORBIDDEN', `${verb} at agent authority resolves identities within the caller's own project; this actor has no session and no grant naming one`);
    }
    return scope;
  }

  private sessionView(ctx: Ctx, session: SessionRow | null, id: string) {
    const scope = this.identityScope(ctx, session, 'session.view');
    const s = this.store.getSession(id);
    // Out of scope answers NOT_FOUND, not FORBIDDEN. A refusal would tell an
    // agent that a session it may not resolve EXISTS, which is precisely the
    // leak the project scope is there to prevent — the same reasoning as the
    // trigger sweep, which skips out-of-scope parks rather than refusing them.
    if (!s || (scope && !scope.has(s.project))) throw err('NOT_FOUND', `no session ${id}`);
    return this.sessionRow(s);
  }

  private sessionRow(s: SessionRow) {
    return {
      id: s.id, tool: s.tool, host: s.host, project: s.project,
      parent_session: s.parent_session, started_at: s.started_at,
      last_seen: s.last_seen, current_item: s.current_item, status: s.status,
      // an elapsed FACT, never a threshold and never an action (§8)
      idle_s: Math.max(0, Math.floor((Date.now() - Date.parse(s.last_seen)) / 1000)),
    };
  }

  private sessionList(ctx: Ctx, session: SessionRow | null, project?: string, includeEnded = false) {
    const scope = this.identityScope(ctx, session, 'sessions');
    // Naming another project is refused rather than silently emptied: project
    // keys are not secret (`surface.describe` lists them to every caller), and
    // a wrong answer is worse than a clear one. Which sessions are IN that
    // project stays hidden — that is what the filter below is for.
    if (scope && project && !scope.has(project)) {
      throw err('FORBIDDEN', `sessions at agent authority is scoped to ${[...scope].join('/')}; ${project} is another project`);
    }
    return this.store.listSessions(project, includeEnded)
      .filter(s => !scope || scope.has(s.project))
      .map(s => this.sessionRow(s));
  }

  // Allowed when ANY held grant admits the target (§18: grants compose).
  private enforceAnyGrantScope(grants: Grant[], target: string) {
    let last: unknown;
    for (const g of grants) {
      try { this.enforceGrantScope(g, target); return; } catch (e) { last = e; }
    }
    throw last as Error;
  }

  // A grant may be scoped to a project and to the states it may act on.
  private enforceGrantScope(g: Grant, target: string) {
    if (target.startsWith('rg-')) return;   // reground diffs carry no state
    const d = this.store.getDeliverable(target);
    if (!d) return;
    if (g.project && d.project !== g.project) {
      throw err('FORBIDDEN', `grant is scoped to ${g.project}; ${target} is in ${d.project}`);
    }
    // `g.states` names WORKING states; `d.state` may now be an EXIT, since the
    // published enum names those too. An exited item is in no grant's list,
    // which is exactly the answer wanted — a grant bounds what may be acted
    // on, and nothing acts on an item that has left the working set.
    if (g.states && !(g.states as readonly string[]).includes(d.state)) {
      throw err('FORBIDDEN', `grant covers ${g.states.join('/')}; ${target} is ${d.state}`);
    }
  }

  private workGet(session: SessionRow, ref: string, cursor: number, limit?: number) {
    const d = this.mustGet(ref);
    if (d.owner_session !== session.id) throw err('FORBIDDEN', `work.get is for the owner; ${ref} is ${d.owner_session ? `held by ${d.owner_session}` : 'unheld'}`);
    const all = this.store.eventsSince(ref, cursor);
    const worklog = limit ? all.slice(0, limit) : all;   // items that live for quarters (§10)
    return {
      deliverable: publicView(d), worklog,
      cursor: worklog.length ? worklog[worklog.length - 1].seq : cursor,
      more: limit ? all.length > worklog.length : false,
    };
  }

  // ---------- create ----------

  private workCreate(item: CreateItem, dispatch: boolean, session: SessionRow | null, actorId: string) {
    const project = item.project ?? session?.project;
    if (!project) throw err('VALIDATION', 'work.create without a session must name a project');
    if (!this.store.getProject(project)) throw err('NOT_FOUND', `no project ${project}`);
    // §6: cross-project flow is proposal-only; dispatch never crosses the boundary.
    if (session && project !== session.project && dispatch) {
      throw err('FORBIDDEN', `session is bound to ${session.project}; work for ${project} crosses as a proposal (dispatch:false) or via a session bound there`);
    }
    if (item.parent) {
      const parent = this.store.getDeliverable(item.parent);
      if (!parent) throw err('NOT_FOUND', `no parent ${item.parent}`);
      if (parent.project !== project) throw err('FORBIDDEN', `parent ${item.parent} is in ${parent.project}`);
      if (parent.parent) throw err('STATE', `delegation depth is capped at 2: ${item.parent} is itself a child`);
    }
    for (const dep of item.depends_on) {
      const d = this.store.getDeliverable(dep);
      if (!d) throw err('NOT_FOUND', `no dependency ${dep}`);
      if (d.project !== project) throw err('FORBIDDEN', `dependency ${dep} is in ${d.project}; dependencies do not cross projects`);
      if (d.state === 'rejected' || d.state === 'cancelled') {
        throw err('STATE', `dependency ${dep} exited as ${d.state} and can never satisfy depends_on`);
      }
    }
    return this.store.tx(() => {
      const ref = this.store.nextRef(project);
      this.store.insertDeliverable({
        ref, project, title: item.title, intent: item.intent, kind: item.kind,
        state: dispatch ? 'todo' : 'proposed', owner_session: null,
        parent: item.parent ?? null, depends_on: item.depends_on, pin: null,
        urgency: item.urgency, priority: item.priority,
        status_line: '', next_checkpoint: '', links: item.links,
      }, { eligible: dispatch, by: actorId });
      return { ref, state: dispatch ? 'todo' : 'proposed' };
    });
  }

  // ---------- events ----------

  private eventAppend(ctx: Ctx, session: SessionRow | null, actorId: string, ref: string, kind: string, body: unknown) {
    const d = this.mustGet(ref);
    // Client actors (operator, creators) get a non-verdict voice — notes (D-18)
    // and, per §12.6, upstream questions (D-25). Answers go through the
    // answer verb, verdicts through reject/triage.
    if (!session && kind !== 'note' && kind !== 'question') {
      throw err('FORBIDDEN', `client actors append notes and questions only; ${kind} is a session event`);
    }
    if (session && d.project !== session.project) throw err('FORBIDDEN', `${ref} is in ${d.project}; session is bound to ${session.project}`);
    const validated = this.validateBody(kind, body, !session);
    if (kind === 'answer') {
      const qSeq = (validated as z.infer<typeof AnswerBody>).question;
      const q = this.store.getEvent(qSeq);
      if (!q || q.item !== ref || q.kind !== 'question') throw err('NOT_FOUND', `no question #${qSeq} on ${ref}`);
      // The `answer` verb is guarded at dispatch; this is the same verdict
      // through the event door, and it releases the same park. Guarding one
      // and not the other made the invariant a matter of which call you chose.
      this.refuseSelfVerdict(ctx, actorId, ref, 'answer', qSeq);
    }
    if (kind === 'rejection') {
      const target = (validated as z.infer<typeof RejectionBody>).event;
      if (target) this.refuseSelfVerdict(ctx, actorId, ref, 'answer', target);
    }
    const ev = this.store.appendEvent(ref, actorId, kind, validated);
    if (kind === 'answer') this.maybeReleaseDecisionPark(d.ref, (validated as z.infer<typeof AnswerBody>).question, actorId);
    if (kind === 'rejection') {
      const target = (validated as z.infer<typeof RejectionBody>).event;
      const q = target ? this.store.getEvent(target) : null;
      if (q && q.item === ref && q.kind === 'question') this.maybeReleaseDecisionPark(d.ref, target!, actorId, 'rejection');
    }
    // A question never parks the item (§12.1) — no state change here.
    return { seq: ev.seq };
  }

  private validateBody(kind: string, body: unknown, clientActor = false): unknown {
    try {
      switch (kind) {
        // §12.6/D-25: the evidence obligation stays machine-side — agent
        // questions require options+evidence; operator questions do not.
        case 'question': return clientActor ? OperatorQuestionBody.parse(body) : QuestionBody.parse(body);
        case 'answer': return AnswerBody.parse(body);
        case 'rejection': return RejectionBody.parse(body);
        case 'progress': case 'note': return TextBody.parse(body);
        default: throw err('VALIDATION', `event kind ${kind} cannot be appended directly`);
      }
    } catch (e) {
      if (e instanceof z.ZodError) throw err('VALIDATION', `${kind} body: ${z.prettifyError(e)}`);
      throw e;
    }
  }

  // A decision releases a decision-park — and §12.2 says a decision chooses
  // AND/OR REJECTS, so a rejection targeting the gating question releases it
  // exactly like an answer (D-21; found live when a redirect deadlocked a park).
  private maybeReleaseDecisionPark(ref: string, questionSeq: number, actorId: string, how: 'answer' | 'rejection' = 'answer') {
    const d = this.store.getDeliverable(ref)!;
    if (d.state !== 'parked' || d.park?.cause !== 'decision') return;
    if (d.park.question && d.park.question !== questionSeq) return;
    this.releasePark(d, actorId, how);
  }

  // §7.5 rule 7: released items re-enter todo at elevated assignment rank.
  // The unparked event carries the park payload so the handoff survives into
  // the worklog — that is what makes any-agent-resume (rule 3) work: the
  // resuming session reads it from its assignment packet (rule 6).
  //
  // The body is DATA, never narration (§7.4 / finding P-4): what released
  // it, which question, and any note the *client* supplied — the surface adds
  // no prose of its own.
  private releasePark(d: DeliverableRow, actorId: string, released_by: 'answer' | 'rejection' | 'unpark', note?: string) {
    this.store.setState(d.ref, 'todo', {
      park: null, owner_session: null, elevated_release: true, eligible_since: nowIso(),
    });
    this.store.appendEvent(d.ref, actorId, 'unparked', {
      released_by, park: d.park,
      ...(d.park?.question ? { question: d.park.question } : {}),
      ...(note ? { note } : {}),
    });
  }

  // ---------- park ----------

  private workPark(session: SessionRow, ref: string, park: Park) {
    const d = this.mustGet(ref);
    if (d.owner_session !== session.id) throw err('FORBIDDEN', `only the owner parks; ${ref} is ${d.owner_session ? `held by ${d.owner_session}` : 'unheld'}`);
    if (park.cause === 'decision' && park.question) {
      const open = this.store.openQuestions(ref).some(q => q.seq === park.question);
      if (!open) throw err('STATE', `no open question #${park.question} on ${ref}`);
    }
    // Parking releases ownership (§7.5 rule 1); the handoff (validated by
    // schema) is what makes any-agent-resume safe (rules 2-3).
    // The transition is recorded as state; the surface writes no prose about it
    // (§7.4 / P-4). Clients that want narration append their own note.
    this.store.setState(ref, 'parked', { park, owner_session: null });
    if (session.current_item === ref) this.store.touchSession(session.id, { current_item: null });
    return { ok: true, state: 'parked' };
  }

  private workUnpark(actorId: string, args: { ref?: string; trigger?: string; note?: string }, grants: Grant[]) {
    // An ungranted caller (operator authority) passes everything; a grant
    // holder is confined to its prefixes — but to ALL of them, since grants
    // compose (§18, finding D-2): holding {lock:} and {window:} means both.
    // A grant is a conjunction: every field it names must hold. Checking the
    // prefix alone let a grant scoped to one project unpark another's parks —
    // so the two things grants exist to bound, a janitor and a cron, were
    // both unbounded. `project` is checked per-deliverable below; here the
    // trigger form filters the sweep.
    const admits = (g: Grant, trigger: string, project?: string) =>
      (!g.trigger_prefix || trigger.startsWith(g.trigger_prefix))
      && (!g.project || !project || g.project === project);
    const allowed = (trigger: string, project?: string) =>
      !grants.length || grants.some(g => admits(g, trigger, project));

    // Trigger-addressed form (D-28): release every park carrying the trigger.
    // The trigger is the address — its owner needs no read to discover refs.
    if (args.trigger) {
      if (!allowed(args.trigger)) throw err('FORBIDDEN', `grant does not cover trigger "${args.trigger}"`);
      const released: string[] = [];
      for (const d of this.store.deliverablesWhere(`state = 'parked'`)) {
        if (d.park?.cause !== 'external') continue;
        if (!d.park.trigger.startsWith(args.trigger)) continue;
        // Out-of-scope parks are skipped, not refused: the trigger is an
        // address, and its owner should not learn what sits behind it in
        // projects it cannot see.
        if (!allowed(d.park.trigger, d.project)) continue;
        this.releasePark(d, actorId, 'unpark', args.note);
        released.push(d.ref);
      }
      return { ok: true, released };
    }

    const d = this.mustGet(args.ref!);
    if (d.state !== 'parked') throw err('STATE', `${d.ref} is ${d.state}, not parked`);
    if (d.park?.cause === 'decision') {
      // Recovery path (D-21): a decision-park whose gating question was already
      // decided (rejected before the release logic existed, or otherwise stale)
      // may be unparked; a live gating question still refuses.
      const stillOpen = d.park.question
        ? this.store.openQuestions(d.ref).some(q => q.seq === d.park!.question)
        : this.store.openQuestions(d.ref).length > 0;
      if (stillOpen) throw err('STATE', `${d.ref} is decision-parked on an open question; the decision releases it`);
    }
    if (!allowed(d.park?.trigger ?? '', d.project)) {
      throw err('FORBIDDEN', `grant does not cover trigger "${d.park?.trigger}" in project ${d.project}`);
    }
    // Called by whoever owns the trigger — cron, watcher, operator. The
    // surface does not know what the trigger means and never calls this itself.
    this.releasePark(d, actorId, 'unpark', args.note);
    return { ok: true, state: 'todo' };
  }

  private workCancel(ctx: Ctx, actorId: string, ref: string, reason: string) {
    const d = this.mustGet(ref);
    if (ExitState.options.includes(d.state as never)) {
      throw err('STATE', `${ref} already exited as ${d.state}`);
    }
    const grants = this.grantsFor(ctx, 'work.cancel');
    if (grants.length) this.enforceAnyGrantScope(grants, ref);

    // An exited dependency makes every live dependent permanently ineligible.
    // Refuse that foot-gun: the operator must cancel or rewire downstream work
    // first, leaving each disposition explicit and reviewable.
    const dependents = this.store.openDependents(ref);
    if (dependents.length) {
      throw err('STATE', `cannot cancel ${ref}; live dependents: ${dependents.join(', ')}`);
    }

    const holder = d.owner_session;
    this.store.appendEvent(ref, actorId, 'cancelled', { reason });
    this.store.setState(ref, 'cancelled', {
      owner_session: null,
      park: null,
      completion: null,
      eligible_since: null,
      elevated_release: false,
    });
    if (holder) {
      const session = this.store.getSession(holder);
      if (session?.current_item === ref) this.store.touchSession(holder, { current_item: null });
    }
    return { ok: true, state: 'cancelled' };
  }

  // ---------- update / complete ----------

  private workUpdate(session: SessionRow | null, actorId: string, ctx: Ctx, args: {
    ref: string; status_line?: string; next_checkpoint?: string;
    intent?: string; kind?: string; depends_on?: string[]; links?: Record<string, unknown[]>;
  }) {
    const d = this.mustGet(args.ref);
    const isOwner = !!session && d.owner_session === session.id;
    if (session && !isOwner) {
      throw err('FORBIDDEN', `only the owner edits; ${args.ref} is ${d.owner_session ? `held by ${d.owner_session}` : 'unheld'}`);
    }
    if (!session) {
      // Client actors patch LINKS and STRUCTURE (D-27 + v1.0): watchers report
      // the observed world; operators steer. The record's VOICE
      // (status_line/next_checkpoint) stays owner-only — that is what D-27
      // protects, and structure is not voice.
      if (args.status_line !== undefined || args.next_checkpoint !== undefined) {
        throw err('FORBIDDEN', 'client actors patch links and structure only; status_line/next_checkpoint belong to the owner');
      }
      // Restating purpose, ordering or kind is a STEERING act — operator
      // authority, or a grant naming this verb, which confers operator-level
      // use within its scope (§18/O-6: for a verb the agent class already
      // calls, a grant that meant nothing would make the grant model
      // incoherent).
      if (args.intent !== undefined || args.depends_on !== undefined || args.kind !== undefined) {
        if (!this.hasOperatorUse(ctx, 'work.update')) {
          throw err('FORBIDDEN', 'restating intent, kind or dependencies requires operator authority or a grant naming work.update');
        }
        const grants = this.grantsFor(ctx, 'work.update');
        if (grants.length) this.enforceAnyGrantScope(grants, args.ref);
      }
    }
    const patch: Record<string, unknown> = {};
    if (args.status_line !== undefined) patch.status_line = args.status_line;
    if (args.next_checkpoint !== undefined) patch.next_checkpoint = args.next_checkpoint;
    if (args.intent !== undefined) patch.intent = args.intent;
    // An OPEN LABEL the surface never interprets (§7.2) — it is stored and
    // handed back, and no chooser tier, projection or verb branches on it. So
    // restating it costs the surface nothing and buys the case R-4 filed:
    // import another world's creator client and everything it mints wears that
    // world's vocabulary, with `intent` restatable and `kind` frozen.
    if (args.kind !== undefined) patch.kind = args.kind;
    if (args.depends_on !== undefined) {
      for (const dep of args.depends_on) {
        if (dep === args.ref) throw err('VALIDATION', 'an item cannot depend on itself');
        const target = this.store.getDeliverable(dep);
        if (!target) throw err('NOT_FOUND', `no dependency ${dep}`);
        if (target.project !== d.project) throw err('FORBIDDEN', `dependency ${dep} is in ${target.project}; dependencies do not cross projects`);
        if (target.state === 'rejected' || target.state === 'cancelled') {
          throw err('STATE', `dependency ${dep} exited as ${target.state} and can never satisfy depends_on`);
        }
      }
      patch.depends_on = args.depends_on;
    }
    if (args.links) {
      // Per-type REPLACE WHOLESALE; types not named round-trip untouched (§7.3).
      // Per-entry merge would require the surface to know an entry's identity
      // key — which is vocabulary, and therefore out.
      patch.links = { ...d.links, ...args.links };
    }
    this.store.patchDeliverable(args.ref, patch);
    return { ok: true };
  }

  private workComplete(session: SessionRow, ref: string, record: CompletionRecord, finalize: boolean) {
    const d = this.mustGet(ref);
    if (d.owner_session !== session.id) throw err('FORBIDDEN', `only the owner completes; ${ref} is ${d.owner_session ? `held by ${d.owner_session}` : 'unheld'}`);
    if (d.state !== 'in_progress') throw err('STATE', `${ref} is ${d.state}`);
    // The pending record carries its AUTHOR (§13.1, finding D-3). §18's
    // delegation invariant — no actor may decide its own output — is the one
    // rule no deployment can express for itself; without an author a surface
    // can only infer it from event history.
    this.store.patchDeliverable(ref, { completion: { ...record, completed_by: session.id } });
    if (finalize) {
      this.finalizeCompletion(ref, session.id);
    } else {
      // Agents stop at review unless project policy says otherwise (§13.1);
      // the client interprets that policy via finalize. No narration event —
      // the state IS the record (P-4): on an editorial desk, a surface-written
      // "submitted for review" note is indistinguishable from an editor's note.
      this.store.setState(ref, 'review', { owner_session: null });
    }
    if (session.current_item === ref) this.store.touchSession(session.id, { current_item: null });
    return { ok: true, state: finalize ? 'completed' : 'review' };
  }

  // The exit: the completed event carries the record; the deliverable and its
  // worklog leave the working set (every projection filters exited states).
  private finalizeCompletion(ref: string, actorId: string) {
    const d = this.store.getDeliverable(ref)!;
    this.store.appendEvent(ref, actorId, 'completed', d.completion ?? {});
    this.store.setState(ref, 'completed', { owner_session: null });
  }

  // ---------- policies / knowledge ----------

  private policyApplicable(ref: string) {
    const d = this.mustGet(ref);
    return this.store.activePolicies([d.project, ref]);
  }

  private knowledgeQuery(q: string, project?: string) {
    if (!project) throw err('VALIDATION', 'knowledge.query needs a project');
    const p = this.store.getProject(project);
    if (!p) throw err('NOT_FOUND', `no project ${project}`);
    if (!p.knowledge_dir) return { results: [], note: `project ${project} has no knowledge_dir configured` };
    const results: { file: string; line: number; text: string }[] = [];
    const needle = q.toLowerCase();
    let files: { parentPath?: string; name: string; isFile(): boolean }[] = [];
    try {
      files = readdirSync(p.knowledge_dir, { recursive: true, withFileTypes: true }) as never[];
    } catch {
      return { results: [], note: `knowledge_dir not readable: ${p.knowledge_dir}` };
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.md')) continue;
      const path = join(f.parentPath ?? p.knowledge_dir, f.name);
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.forEach((text, i) => {
        if (results.length < 40 && text.toLowerCase().includes(needle)) {
          results.push({ file: path, line: i + 1, text: text.trim() });
        }
      });
    }
    return { results };
  }

  // ---------- reground (§14) ----------

  // Never mutates directly: proposed[] land as `proposed` deliverables (their
  // triage gate IS the proposal state); completed[]/in_flight[] land as
  // operator-triaged diffs.
  private regroundSubmit(session: SessionRow, payload: { completed: unknown[]; in_flight: unknown[]; proposed: CreateItem[] }) {
    const proposed: string[] = [];
    for (const item of payload.proposed) {
      const r = this.workCreate(item, false, session, session.id) as { ref: string };
      proposed.push(r.ref);
    }
    const diffs: string[] = [];
    for (const c of payload.completed) diffs.push(this.store.insertDiff(session.id, session.project, 'completed', c));
    for (const f of payload.in_flight) diffs.push(this.store.insertDiff(session.id, session.project, 'in_flight', f));
    return { proposed, diffs };
  }

  private applyDiff(diffId: string, actorId: string) {
    const diff = this.store.getDiff(diffId)!;
    if (diff.kind === 'completed') {
      const p = diff.payload as z.infer<typeof RegroundCompleted>;
      const { ref } = this.workCreate(CreateItem.parse({
        project: diff.project, title: p.title, intent: p.intent, kind: p.kind, links: p.links,
      }), true, null, actorId) as { ref: string };
      this.store.patchDeliverable(ref, { completion: p.record });
      this.finalizeCompletion(ref, actorId);
      return { ref, state: 'completed' };
    }
    // in_flight
    const p = diff.payload as z.infer<typeof RegroundInFlight>;
    if (p.ref) {
      const d = this.mustGet(p.ref);
      const patch: Record<string, unknown> = {};
      if (p.status_line !== undefined) patch.status_line = p.status_line;
      if (p.next_checkpoint !== undefined) patch.next_checkpoint = p.next_checkpoint;
      if (p.links) patch.links = { ...d.links, ...p.links };
      this.store.patchDeliverable(p.ref, patch);
      if (p.park && d.state !== 'parked') {
        this.store.setState(p.ref, 'parked', { park: p.park, owner_session: null });
      }
      return { ref: p.ref, state: this.store.getDeliverable(p.ref)!.state };
    }
    // New in-flight claim with no session holding it lands honestly: parked if
    // gated, todo otherwise — never in_progress with no owner.
    const { ref } = this.workCreate(CreateItem.parse({
      project: diff.project, title: p.title ?? 'Regrounded work',
      intent: p.intent ?? p.status_line ?? 'Recovered by reground', kind: p.kind ?? 'feature',
      links: p.links ?? {},
    }), true, null, actorId) as { ref: string };
    const patch: Record<string, unknown> = { status_line: p.status_line ?? '', next_checkpoint: p.next_checkpoint ?? '' };
    this.store.patchDeliverable(ref, patch);
    if (p.park) this.store.setState(ref, 'parked', { park: p.park, owner_session: null });
    return { ref, state: this.store.getDeliverable(ref)!.state };
  }

  // ---------- projections (§15) ----------

  // §15: the page envelope, ALWAYS — a client must never branch on response
  // shape. `cursor` is an OPAQUE KEYSET token identifying the last row served,
  // never an index: two worlds measured that an offset skips exactly as many
  // rows as the operator cleared between pages, and clearing is the normal use
  // of an attention queue (findings D-4 / C-1).
  private attention(args: { project?: string; limit?: number; cursor?: string } = {}) {
    const all = this.attentionRows(args.project);
    const start = args.cursor ? this.resumeAfter(all, args.cursor) : 0;
    const rows = all.slice(start, args.limit ? start + args.limit : undefined);
    const last = rows[rows.length - 1];
    // Per-kind counts over the WHOLE scoped queue, never the page (finding
    // C-5). `total` and `more` are here so an operator client can honestly say
    // "23 of 400"; the console's first screen has to answer a narrower
    // question in five seconds — *does anything need me, and of what sort?* —
    // and "23" is not an answer, because 3 decisions and 40 in review carry
    // entirely different urgency and only one of them means an agent is
    // waiting on a human.
    //
    // There is exactly one honest derivation without this, and it is expensive
    // in the wrong place: rows arrive in kind order, so every kind that ends
    // before the last loaded row is exact and everything after it is a floor
    // rendered as "12+". The number a manager most needs at volume is review
    // load — the LAST kind — so it is never exact without paging the entire
    // queue: a dozen round trips from a tablet to learn something this method
    // already computed and threw away. `all` is materialised and sorted here
    // to produce `total` at all, so the breakdown is free on this side and
    // impossible on the other. That asymmetry is §15's own test for whether
    // withholding a computed value makes operator clients unportable.
    const totals = { decision: 0, triage: 0, health: 0, review: 0 };
    for (const r of all) totals[r.kind]++;
    return {
      rows,
      cursor: last ? this.encodeCursor(last) : (args.cursor ?? null),
      total: all.length,
      totals,
      more: start + rows.length < all.length,
    };
  }

  // Row keys are compared as STRINGS (they travel inside an opaque cursor and
  // sort beside two other string fields), so a numeric discriminator must be
  // padded or `q10` sorts before `q5` — putting the tenth question on an item
  // ahead of the fifth. owp-research's R-2 reproduction caught exactly this in
  // the first cut of the tie fix, which is the same lexicographic trap the
  // §11 chooser's final tier hit earlier.
  private static seqKeyWidth = 12;

  // The token names a PLACE in the total order (§15), so churn between pages
  // cannot shift it. Opaque by contract: clients must not parse or construct it.
  private encodeCursor(row: AttentionRow): string {
    return Buffer.from(
      `${row.kind}\u0000${row.since}\u0000${row.target}\u0000${row.key}`,
      'utf8').toString('base64url');
  }

  private resumeAfter(all: AttentionRow[], cursor: string): number {
    let parts: string[];
    try {
      parts = Buffer.from(cursor, 'base64url').toString('utf8').split('\u0000');
    } catch {
      throw err('VALIDATION', 'cursor is opaque and must be echoed from a previous attention() call');
    }
    // Four parts since the tie fix (finding R-2). A three-part token predates
    // it: it names a tie group it cannot resolve, so it takes the
    // strictly-after path instead of the exact one. That may skip the rest of
    // its own tie group — the old behaviour — but it always advances.
    if (parts.length !== 3 && parts.length !== 4) throw err('VALIDATION', 'malformed cursor');
    const [kind, since, target, key] = parts;
    // Exact row still present → resume after it. Otherwise resume at the first
    // row that sorts AFTER the remembered key, so a cleared row costs nothing.
    if (key !== undefined) {
      const exact = all.findIndex(r =>
        r.kind === kind && r.since === since && r.target === target && r.key === key);
      if (exact >= 0) return exact + 1;
    }
    const order = { decision: 0, triage: 1, health: 2, review: 3 } as Record<string, number>;
    const rank = (k: string) => order[k] ?? 99;
    // Strictly-after in the SAME total order attentionRows() sorts by: each
    // tier decides only when every earlier tier compares equal.
    const after = all.findIndex(r => {
      if (rank(r.kind) !== rank(kind)) return rank(r.kind) > rank(kind);
      if (r.since !== since) return r.since > since;
      if (r.target !== target) return r.target > target;
      return key !== undefined && r.key > key;
    });
    return after >= 0 ? after : all.length;
  }

  private attentionRows(project?: string): AttentionRow[] {
    const rows: AttentionRow[] = [];
    const inScope = (ref: string) => !project || ref.startsWith(`${project}-`);
    // 1. open decisions, oldest first. Questions pointing the OTHER way are
    // §12.6's upstream direction: they route to the agent's assignment packet,
    // not back into the operator's own queue (D-25).
    //
    // The test is the question's DIRECTION, not the author's shape (finding
    // PUB-7). For everything written before this it is the same test, because
    // an unstated direction resolves to the old inference — but a creator
    // client that says `to_operator` now reaches the human it is asking,
    // instead of having to register a second identity to be heard.
    for (const q of this.store.openQuestions()) {
      if (this.questionDirection(q) !== 'to_operator') continue; // → the agent's packet
      const d = this.store.getDeliverable(q.item);
      if (!d || ExitState.options.includes(d.state as never)) continue;   // exits leave the working set (§8)
      const prompt = (q.body as { prompt?: string })?.prompt ?? '';
      rows.push({ kind: 'decision', target: q.item, key: seqKey(q.seq),
        reason: `Q#${q.seq} ${truncate(prompt)}`,
        since: q.at, elapsed_s: elapsedS(q.at), action: 'answer',
        detail: { question: q.seq, actor: q.actor, body: q.body } });
    }
    // 2. triage: proposals, then reground diffs, oldest first
    for (const d of this.store.deliverablesWhere(`state = 'proposed' ORDER BY state_since`)) {
      // A sent-back proposal (rejection with a non-closing continuation, no
      // session-authored event after it) is waiting on the machine side, not
      // the operator — the row says so instead of reading as untouched.
      const evs = this.store.eventsSince(d.ref, 0);
      const sendback = [...evs].reverse().find(e =>
        e.kind === 'rejection' && (e.body as { continuation?: string })?.continuation !== 'record-only');
      // The machine-side responses ride on the card too — the operator decides
      // from the enriched card, not by archaeology (D-15).
      const responses = sendback ? evs.filter(e => e.seq > sendback.seq && this.store.getSession(e.actor)) : [];
      const awaiting = !!sendback && !responses.length;
      rows.push({ kind: 'triage', target: d.ref, key: 'proposal',
        reason: `${awaiting ? 'sent back, awaiting enrichment' : sendback ? 'sent back, enriched' : 'proposal'}: ${truncate(d.title)}`,
        since: d.state_since, elapsed_s: elapsedS(d.state_since), action: 'triage',
        detail: { proposal: publicView(d),
          ...(sendback ? { sendback: sendback.body, sendback_seq: sendback.seq, awaiting_enrichment: awaiting, responses } : {}) } });
    }
    for (const g of this.store.pendingDiffs()) {
      const label = g.kind === 'completed'
        ? `reground: completed "${truncate((g.payload as { title?: string }).title ?? '', 60)}"`
        : `reground: in-flight ${(g.payload as { ref?: string }).ref ?? truncate((g.payload as { title?: string }).title ?? '', 60)}`;
      rows.push({ kind: 'triage', target: g.id, key: 'reground', reason: label,
        since: g.created_at, elapsed_s: elapsedS(g.created_at), action: 'triage',
        detail: { reground: g.kind, session: g.session, project: g.project, payload: g.payload } });
    }
    // 3. health — observations only; each row's clearing action is a client's.
    //    No thresholds here: what reads as "stalled" is client configuration.
    for (const d of this.store.deliverablesWhere(`state = 'in_progress'`)) {
      const owner = d.owner_session ? this.store.getSession(d.owner_session) : null;
      const lastEvent = this.store.lastEventAt(d.ref);
      const lastActivity = [owner?.last_seen, lastEvent].filter(Boolean).sort().pop() ?? d.state_since;
      rows.push({ kind: 'health', target: d.ref, key: 'progress',
        reason: `in progress, last activity ${Math.floor(elapsedS(lastActivity) / 60)}m ago (${d.owner_session ?? 'unheld'})`,
        since: lastActivity, elapsed_s: elapsedS(lastActivity), action: 'release',
        // Enough for a recovery client to apply its policy from the row (D-15) —
        // notably whether the owner ended without releasing.
        detail: { owner_session: d.owner_session, owner_status: owner?.status ?? null, last_activity: lastActivity } });
      // §8 unreconciled, reference implementation (D-27): a watcher-updated
      // link entry carrying observed_at newer than the item's last worklog
      // event means the world has moved past the record. An observation, never
      // an action — reconciling it is a client's job.
      for (const [type, entries] of Object.entries(d.links)) {
        for (const [i, entry] of (entries as { observed_at?: string }[]).entries()) {
          if (!entry?.observed_at) continue;
          if (!lastEvent || entry.observed_at > lastEvent) {
            rows.push({ kind: 'health', target: d.ref, key: `link:${type}:${String(i).padStart(12, '0')}`,
              reason: `unreconciled: ${type} reports state newer than the worklog`,
              since: entry.observed_at, elapsed_s: elapsedS(entry.observed_at), action: 'reconcile',
              detail: { link_type: type, entry, last_event_at: lastEvent } });
          }
        }
      }
    }
    for (const d of this.store.deliverablesWhere(`state = 'parked' ORDER BY state_since`)) {
      rows.push({ kind: 'health', target: d.ref, key: 'parked',
        reason: `parked (${d.park?.cause}): ${truncate(d.park?.trigger ?? '', 60)}`,
        since: d.state_since, elapsed_s: elapsedS(d.state_since),
        action: d.park?.cause === 'external' ? 'unpark' : 'answer',
        detail: { park: d.park } });
    }
    // 4. review
    for (const d of this.store.deliverablesWhere(`state = 'review' ORDER BY state_since`)) {
      rows.push({ kind: 'review', target: d.ref, key: 'review', reason: `review: ${truncate(d.title)}`,
        since: d.state_since, elapsed_s: elapsedS(d.state_since), action: 'triage',
        detail: { title: d.title, intent: d.intent, completion: d.completion } });
    }
    const order = { decision: 0, triage: 1, health: 2, review: 3 };
    // Total ordering: kind → age → target → key. The first three are not
    // enough and saying they were is what shipped finding R-2: one item can
    // raise two decision rows at one instant (two open questions) or two
    // unreconciled rows (two link entries), and a cursor naming only the
    // first three resolves to the head of that tie every time — serving the
    // same row forever instead of draining the queue. `key` separates them.
    // Every row carries the deliverable's links (§15, D-6) — the one envelope
    // a deployment's own nouns live in. Reground rows have no deliverable.
    //
    // …and the standing rules for the acts that cannot be taken back (§10,
    // finding O-8). §10 makes an agent consult `policy.applicable` before an
    // irreversible action and hands it the applicable policies in its
    // assignment packet; the operator's projections handed them nothing, so
    // for the one class of decision an ops deployment exists to make safe, the
    // payload §15 calls "sufficient to decide from the row" was missing the
    // rules the operator wrote themselves. The asymmetry runs backwards from
    // §1.3: the machine is briefed and the human is not.
    //
    // WHICH ROWS, and why not all of them. A row carries policies when the
    // action that clears it cannot be undone by another verb call:
    //   triage — accept exits an item (completed) or dispatches a proposal,
    //            and a record-only reject exits it;
    //   answer — §12.2 resolves the question for good and releases the park,
    //            and the agent acts on the answer at machine speed;
    //   unpark — the work starts running now; this is O-8's own case, an
    //            operator releasing a window park outside its window.
    // Left out on purpose: `release`, which is REVERSIBLE (the item returns to
    // todo, keeps its worklog, and can be reclaimed) and is a recovery act
    // rather than an irreversible one; and `reconcile`, whose action belongs
    // to the session holding the item and which the reader cannot perform at
    // all (finding C-6).
    //
    // COST: one read for the whole page, not one per row. Policies are
    // operator-written standing rules — tens, not thousands — so the surface
    // reads them once, lazily (a queue with no irreversible row never asks),
    // and joins on scope in memory. The field is omitted when nothing applies,
    // which is the common case, so a thousand-row queue in a deployment with
    // no policies is byte-for-byte what it was.
    const IRREVERSIBLE = new Set(['triage', 'answer', 'unpark']);
    let active: Policy[] | null = null;
    for (const r of rows) {
      const d = r.target.startsWith('rg-') ? null : this.store.getDeliverable(r.target);
      if (d) {
        if (Object.keys(d.links).length) r.links = d.links;
        r.item = { title: d.title, kind: d.kind, urgency: d.urgency };
      }
      if (!IRREVERSIBLE.has(r.action)) continue;
      // §7.6: a policy is scoped to a project key or a ref, and there is no
      // global scope. A reground row names no deliverable, but its diff names
      // the project it lands in, and accepting it creates completed items.
      const scope = d?.project ?? (r.detail as { project?: string } | undefined)?.project;
      active ??= this.store.allActivePolicies();
      // Same order `policy.applicable` returns, so a client that opens the row
      // and a client that renders it see the same list in the same sequence.
      const applicable = active.filter(p => p.scope === r.target || (!!scope && p.scope === scope));
      if (applicable.length) r.policies = applicable;
    }
    return rows
      .filter(r => inScope(r.target) || (r.detail as { project?: string })?.project === project)
      .sort((a, b) => order[a.kind] - order[b.kind]
        || a.since.localeCompare(b.since)
        || a.target.localeCompare(b.target)
        || a.key.localeCompare(b.key));
  }

  private portfolio(project?: string) {
    return this.store.listProjects().filter(p => !project || p.key === project).map(p => {
      const open = this.store.deliverablesWhere(`project = ? AND state NOT IN ${EXITED}`, p.key);
      const by = (s: string) => open.filter(d => d.state === s);
      return {
        key: p.key, name: p.name, goal: p.goal,
        working_set: open.length,
        in_flight: by('in_progress').map(d => ({
          ref: d.ref, title: d.title, owner_session: d.owner_session,
          status_line: d.status_line, next_checkpoint: d.next_checkpoint,
        })),
        parked: by('parked').map(d => ({
          ref: d.ref, title: d.title, cause: d.park?.cause, trigger: d.park?.trigger,
          elapsed_s: elapsedS(d.state_since),
        })),
        review: by('review').map(d => ({ ref: d.ref, title: d.title })),
        // depends_on + a derived `blocked` (§15): the surface already computes
        // this for §11's hard filter, and withholding it made every deployment
        // with staged work write the same N+1 loop (findings O-5, desk).
        // An observation — reported, never acted on.
        todo: by('todo').map(d => ({
          ref: d.ref, title: d.title, urgency: d.urgency,
          depends_on: d.depends_on,
          blocked: d.depends_on.some(r => this.store.getDeliverable(r)?.state !== 'completed'),
        })),
        proposed: by('proposed').map(d => ({ ref: d.ref, title: d.title })),
      };
    });
  }

  // ---------- operator verbs ----------

  private answer(actorId: string, args: { ref: string; question: number; choice: string; text?: string }) {
    const d = this.mustGet(args.ref);
    const q = this.store.getEvent(args.question);
    if (!q || q.item !== args.ref || q.kind !== 'question') throw err('NOT_FOUND', `no question #${args.question} on ${args.ref}`);
    const body: Record<string, unknown> = { question: args.question, choice: args.choice };
    if (args.text) body.text = args.text;
    const ev = this.store.appendEvent(args.ref, actorId, 'answer', body);
    this.maybeReleaseDecisionPark(d.ref, args.question, actorId);
    return { seq: ev.seq };
  }

  private reject(actorId: string, args: { ref: string; reason: string; continuation: string; what?: string; event?: number }) {
    this.mustGet(args.ref);
    const body: Record<string, unknown> = { reason: args.reason, continuation: args.continuation };
    if (args.what) body.what = args.what;
    if (args.event) body.event = args.event;
    const ev = this.store.appendEvent(args.ref, actorId, 'rejection', body);
    if (args.event) {
      const q = this.store.getEvent(args.event);
      if (q && q.item === args.ref && q.kind === 'question') this.maybeReleaseDecisionPark(args.ref, args.event, actorId, 'rejection');
    }
    return { seq: ev.seq };
  }

  private triage(actorId: string, target: string, decision: 'accept' | 'reject', reason?: string, continuation?: string) {
    if (decision === 'reject' && !reason) throw err('VALIDATION', 'triage reject requires a reason — rejection reasons are retained');
    if (target.startsWith('rg-')) {
      const diff = this.store.getDiff(target);
      if (!diff) throw err('NOT_FOUND', `no reground diff ${target}`);
      if (diff.status !== 'pending') throw err('STATE', `${target} already ${diff.status}`);
      if (decision === 'reject') {
        this.store.resolveDiff(target, 'rejected', reason);
        return { ok: true, target, resolution: 'rejected' };
      }
      const applied = this.applyDiff(target, actorId);
      this.store.resolveDiff(target, 'accepted');
      return { ok: true, target, resolution: 'accepted', applied };
    }
    const d = this.mustGet(target);
    if (d.state === 'proposed') {
      if (decision === 'accept') {
        this.store.setState(target, 'todo', { eligible_since: nowIso() });
        return { ok: true, target, resolution: 'accepted', state: 'todo' };
      }
      // Only record-only closes a proposal for good; any other continuation is
      // a send-back — the item stays proposed, carrying the operator's ask in
      // the rejection, awaiting machine-side enrichment (D-17).
      const cont = continuation ?? 'record-only';
      if (cont === 'record-only') {
        const dependents = this.store.openDependents(target);
        if (dependents.length) {
          throw err('STATE', `cannot reject ${target}; live dependents: ${dependents.join(', ')}`);
        }
        this.store.appendEvent(target, actorId, 'rejection', { reason, continuation: cont, what: `proposal ${target}` });
        this.store.setState(target, 'rejected'); // exit; retained as negative knowledge
        return { ok: true, target, resolution: 'rejected' };
      }
      this.store.appendEvent(target, actorId, 'rejection', { reason, continuation: cont, what: `proposal ${target}` });
      return { ok: true, target, resolution: 'sent-back', state: 'proposed', continuation: cont };
    }
    if (d.state === 'review') {
      if (decision === 'accept') {
        this.finalizeCompletion(target, actorId);
        return { ok: true, target, resolution: 'accepted', state: 'completed' };
      }
      const cont = continuation ?? 'rework';
      this.store.appendEvent(target, actorId, 'rejection', { reason, continuation: cont, what: 'review outcome' });
      this.store.setState(target, 'todo', { eligible_since: nowIso(), completion: null });
      return { ok: true, target, resolution: 'rejected', state: 'todo', continuation: cont };
    }
    throw err('STATE', `${target} is ${d.state}; triage applies to proposals, review items, and reground diffs`);
  }

  // §12.4: one mechanism, two targets, provenance attached.
  private promote(actorId: string, args: { event: number; to: 'proposal' | 'policy'; title?: string; intent?: string; kind?: string; scope?: string; type?: string; text?: string }) {
    const ev = this.store.getEvent(args.event);
    if (!ev) throw err('NOT_FOUND', `no event #${args.event}`);
    const item = this.mustGet(ev.item);
    const provenance = { event: ev.seq, item: ev.item };
    if (args.to === 'policy') {
      const body = ev.body as Record<string, unknown>;
      const text = args.text ?? (typeof body?.text === 'string' ? body.text : undefined) ?? (typeof body?.reason === 'string' ? body.reason : undefined);
      if (!text) throw err('VALIDATION', 'promote to policy: no text on the event; pass text explicitly');
      return this.store.insertPolicy(args.scope ?? item.project, args.type ?? 'note', text, provenance);
    }
    const body = ev.body as Record<string, unknown>;
    const fallback = typeof body?.text === 'string' ? body.text : typeof body?.prompt === 'string' ? body.prompt : `event #${ev.seq}`;
    return this.workCreate(CreateItem.parse({
      project: item.project,
      title: args.title ?? truncate(fallback, 80),
      intent: args.intent ?? `Promoted from ${ev.kind} event #${ev.seq} on ${ev.item}`,
      kind: args.kind ?? 'feature',
      links: { references: [provenance] },
    }), false, null, actorId);
  }

  private workRelease(ctx: Ctx, session: SessionRow | null, actorId: string, ref: string, note?: string) {
    const d = this.mustGet(ref);
    if (d.state !== 'in_progress') throw err('STATE', `${ref} is ${d.state}, not in_progress`);
    // §18, enforced (finding C-4): agent authority releases its OWN claim.
    // Releasing another session's is an operator act, or a grant naming
    // work.release — which is what makes the janitor grant mean something
    // rather than restate a power the class already had. The hole this
    // replaces tested `session &&`, so an agent-token client that simply
    // registered no session held no claim to violate and could sweep the
    // whole estate.
    if (ctx.authority === 'agent') {
      const own = !!session && d.owner_session === session.id;
      if (!own) {
        const grants = this.grantsFor(ctx, 'work.release');
        if (!grants.length) {
          throw err('FORBIDDEN', session
            ? `sessions release only their own claims; ${ref} is held by ${d.owner_session}`
            : `releasing another session's claim needs operator authority or a grant naming work.release`);
        }
        this.enforceAnyGrantScope(grants, ref);
      }
    }
    const holder = d.owner_session;
    this.store.setState(ref, 'todo', { owner_session: null, eligible_since: nowIso() });
    // Only the client's own words reach the worklog (P-4).
    if (note) this.store.appendEvent(ref, actorId, 'note', { text: note });
    if (holder) {
      const s = this.store.getSession(holder);
      if (s?.current_item === ref) this.store.touchSession(holder, { current_item: null });
    }
    return { ok: true, state: 'todo' };
  }

  private steer(ref: string, patch: Record<string, unknown>) {
    this.mustGet(ref);
    this.store.patchDeliverable(ref, patch);
    return { ok: true };
  }

  private mustGet(ref: string): DeliverableRow {
    const d = this.store.getDeliverable(ref);
    if (!d) throw err('NOT_FOUND', `no deliverable ${ref}`);
    return d;
  }
}

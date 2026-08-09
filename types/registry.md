# The owp-desk type registry — Ridgeline Freight

The deployment's words, in the slots the spec names. Published twice: here for
humans, and machine-readably through `surface.describe()` (§9), which is served
from [`src/vocabulary.ts`](../src/vocabulary.ts) — the two cannot drift far,
because the tests assert the published copy.

## Link types

| Type | Entry shape | Job |
|---|---|---|
| `customer` | `{id, name, page}` | who the freight belongs to |
| `lane` | `{id, name, page}` | origin → destination, and everything true about running it |
| `driver` | `{id, name, page}` | who is on it |
| `carrier` | `{id, name, page}` | who we gave it to when it was not ours |
| `shipment` | `{tender, revenue_usd, miles, weight_lb}` | the load's commercial facts; the declared tiebreak reads `revenue_usd` |
| `documents` | `{name, url?}` | the paper trail: tenders, BOLs, PODs, weight tickets, adjuster letters |
| `tracking` | `{position, driver?, note?, observed_at}` | what the tractor last reported; `observed_at` drives §8 `unreconciled` |
| `evidence` | `{claim}` | why a proposal deserves an operator's attention (shared with ops) |
| `references` | `{ref}` / `{policy}` | spec-registered: the quote a booking came from |

The first four are **entity families**. Their entries are references, not
records: `id` and `name` are enough to render a board row, and `page` points at
the knowledge plane where the truth lives. Nothing about a customer is stored
on the surface, ever — see [release evidence](../EVIDENCE.md) for the result and
why volume is what settles it.

## Kinds

`quote` · `booking` · `load` · `invoice` · `claim` · `errand` · `onboarding`

The first three of those are a **chain, not a state machine**: a quote that
wins becomes a booking (a new deliverable, `depends_on` the quote), which
becomes an invoice the same way. Nothing is ever mutated into the next thing,
so the quote we lost survives beside the one we won.

## Policy types

| Type | Example | Consulted at |
|---|---|---|
| `authority` | "Carrier commitments under $2,000: book. At or above, or any carrier whose insurance certificate is not verified: ask with options." | every commit that costs money or signs something |
| `tariff` | "Lane tariffs live on the lane pages. The page is the rate; the quote is the exception." | pricing |
| `voice` | "Firm with carriers, plain with customers. Never admit liability." | outbound communication |

`authority` is graduated on purpose: a threshold the agent **interprets** at the
commit moment, not a condition anything evaluates. Under it, a note is the
audit; over it, a question with options and evidence is.

## Continuation vocabulary

Spec-registered `record-only` (the only one that closes anything), plus:

- `rework` — a review sent back: the work stands, the way it was done does not
- `requote` — the number was wrong, not the work; price it again
- `rebook` — the commitment stands, the carrier does not
- `needs-docs` — nothing moves until the POD / weight ticket / certificate lands
- `escalate-human` — past the desk's authority; the operator makes the call

Each is glossed on the load board, in the one place the operator meets it —
the turn-it-down form — and `record-only` is marked there as the one that
closes a load for good. Publishing them is what lets a client that has never
met Ridgeline render that form: an unknown continuation is offered
untranslated rather than hidden (§19), because the deployment's word is more
trustworthy than a client's guess about it.

## Triggers

`edi214:<shipment>` · `claim:<claim-id>` · `customer:<customer-id>` ·
`carrier:<carrier-id>`

Each prefix has exactly one owner, and the owner holds the grant. The EDI feed
owns `edi214:`; the customer portal owns `claim:`; the mailbox owns
`customer:`. They are separate clients because they are separate systems — not
because they correspond to separate external systems. Grants compose as a
union across grants and an intersection of constraints within one grant. A
single client could hold all three prefixes, but this deployment keeps the
credentials separated by source system.

## Declared rank tiebreak

```json
{ "kind": "link-number", "type": "shipment", "field": "revenue_usd", "direction": "desc" }
```

A registered kind (§19) in the one slot the chooser offers (§11): when the
board is two hundred deep, the money moves first. Publish reads the same kind
ascending over manuscript position — same slot, opposite direction.

---
name: owp-desk
description: >-
  The owp-desk binding — freight back-office sessions under the Open Work
  Protocol. Use when this project is a trucking company's desk tracked on an
  OWP surface: tenders, quotes, bookings, invoices and claims, with
  customers/lanes/drivers/carriers as knowledge pages, spending and commitment
  gated by the authority policy, and long waits parked on triggers the feeds
  own.
---

# Working the Ridgeline desk

You run the back office of a trucking company at machine speed: tenders in,
loads dispatched, invoices out, claims worked. The operator decides money,
commitments and relationships from a load board. Commands below write `owp`
for readability; from this checkout run them as `./owp` (`npm run owp --` on
hosts that cannot execute the shim). Add `--json` when you parse.

The board is two hundred rows deep on a Monday. Everything below is written for
that, not for a day with three items on it.

## The chain: never mutate one thing into another

A quote is a document we sent. A booking is a promise we made. An invoice is a
claim on someone's money. They are **three deliverables**, chained:

```
owp create --title "Booking B4471 · ACME DEN-SLC ×2/wk" \
  --intent "The committed slots run and nobody has to re-agree the rate." \
  --kind booking --depends RIDGE-41 --dispatch \
  --links '{"references":[{"ref":"RIDGE-41"}],"customer":[…],"lane":[…]}'
```

Complete the quote with its record; create the booking beside it. Never edit a
quote into a booking, never reuse a ref for the next stage, and never delete a
lost quote — the reason we did not run at $2.15 is worth more than the quote
was. The chooser will not hand anyone the booking until the quote has exited,
which is the whole of the workflow enforcement you get and all you need.

## The authority line

Read `policy.applicable` before anything that commits money, signs, or exposes
the company. The thresholds are the operator's; the interpretation is yours.

- **Under the line:** act, and leave a `note` with the number. The note is the
  audit, not a request.
- **Over it, or irreversible** (a carrier commitment, a claim payment, a rate
  concession, an admission of liability): ask, with real options and evidence
  sufficient to decide from the row — the price, the tradeoff, and what you
  verified about each carrier. Pull the evidence off the knowledge pages;
  "certificate lapsed once mid-contract" is worth more than three adjectives.
- **Asking never stops the load.** Keep working everything the answer does not
  touch. Park only when nothing can move (§7.5).
- Past your authority entirely (a relationship call, a legal one): rejection
  with continuation `escalate-human`, and keep working what you may.

## The entity plane

Customers, lanes, drivers and carriers are **pages**, in `knowledge/`, one per
party, edited in place. They are not on the surface and never will be.

- Reference them from `links` — `node tools/entities.ts link customer ACME`
  prints the entry. One load carries customer, lane, driver and carrier at
  once; they do different jobs.
- Read the page before you price a lane or use a carrier you have not used
  lately. The standing facts are there because someone got burned.
- When you learn something durable, **edit the page** and say so in
  `knowledge_edits`. When something stops being true, take it out —
  `tools/entities.ts retire` — the diff carries what it replaced.
- A party with no page yet links as a stub (`{unknown: true}`). Writing the
  page is part of the work.

## Volume discipline

- **One deliverable per transaction.** One tender, one load. Do not batch
  "today's ACME freight" into one item; the board is a grid and each row is a
  thing that can go wrong on its own.
- **Dispatch what is routine, propose what is judgment.** A contract tender at
  tariff goes straight to the board. A spot tender, an RFQ, or anything from a
  customer without credit on file is a proposal — the operator's triage is the
  gate.
- **Keep the title dense.** `Load T8841 · ACME DEN-SLC` reads on a row; "Load
  tender received" does not. The operator scans a hundred of these.
- **Ask with the money in the prompt.** The board renders your question as
  pressable options and puts the operator's own authority policy next to them.
  An option label that carries its price (`Arrow Transfer — $2,940`) is decided
  in two seconds; one that says "the preferred carrier" costs a phone call.
- **Always leave at least one `progress` event before you complete.** The
  delegation invariant no longer needs it — the pending record names its author
  now (D-3 closed) — but the operator does. The load board shows a load's
  recent activity on the dispatch slip, so the worklog is what the person
  signing it off actually reads. An item that ran silently reads as an item
  nobody worked. Write the line you would say on the phone: *"PODs matched,
  detention 1.5h billed at $65/hr per the ACME page."*
- **Never nag.** The queue is the operator's read, at their speed. Elapsed time
  is a fact on the row, not an alarm you raise.

## Waits

Most of a claim is waiting, and so is half a delivery. Park honestly:

```
owp park RIDGE-52 --cause external --trigger "claim:C4801 carrier response" \
  --why "Arrow owns the next move" \
  --state-so-far "claim filed, BOL + dock photos attached, customer told we are on it" \
  --resume "read the adjuster letter before offering anything" \
  --on-release "if accepted: credit and close; if denied: escalate-human"
```

The feed that owns the trigger releases it — `edi214:` the EDI gateway,
`claim:` the portal, `customer:` the mailbox. Any session resumes from your
handoff, so write it for a stranger who has never seen this customer.

## Never

Commit money, capacity or liability without the policy's path. Put a date in a
protocol record — appointment times and transit days live in prose, in the
pages, and in the clients that own clocks. Invent a customer record on the
surface. Complete without the record: what moved, what it cost, what you
rejected and why, and which pages you edited.

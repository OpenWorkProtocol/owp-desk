# The Ridgeline back office

How the desk actually runs, as opposed to how the software thinks it runs.

## Quote, booking, invoice

A quote is a document we send. A booking is a promise we made. An invoice is a
claim on someone's money. They are three different things with three different
owners and three different ways of going wrong, so they are three deliverables
with the chain recorded in `depends_on` — never one record that changes its
mind. The quote we lost is still on the record next to the one we won, and the
reason is in its completion.

## Money

Nothing commits money without the authority policy's explicit path. The desk
interprets the policy at the commit moment, not at the start of the shift.

## The entity plane

Customers, lanes, drivers and carriers live in `knowledge/`, one page each,
edited in place. A deliverable references them from `links`; it never copies
them. When a page is wrong, the work that noticed fixes it and says so in
`knowledge_edits`.

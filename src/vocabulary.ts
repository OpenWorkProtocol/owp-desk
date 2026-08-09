// Ridgeline's words. This file is the whole of what the deployment adds to the
// protocol, and §9/§19 say it must be published rather than documented: every
// project this world creates carries it, and `surface.describe()` serves it to
// any client that asks — including clients nobody here has met.
//
// types/registry.md is the same table in prose, for the humans.
export const RIDGELINE_VOCABULARY = {
  // Four entity families + the load's own commercial facts + the paper trail.
  // `references` and `evidence` are the spec's; the rest are ours.
  link_types: ['customer', 'lane', 'driver', 'carrier', 'shipment', 'documents', 'tracking', 'evidence', 'references'],
  // The lifecycle is three kinds, not three states: a quote that wins becomes a
  // booking, which becomes an invoice, each a deliverable of its own.
  kinds: ['quote', 'booking', 'load', 'invoice', 'claim', 'errand', 'onboarding'],
  policy_types: ['authority', 'tariff', 'voice'],
  // `rework` is here because the desk uses it — it is what a review sent back
  // means, and §20 makes publishing what you use part of conformance, not a
  // courtesy. A client that renders a send-back dialog from `surface.describe`
  // (§9) was previously offered every word except the one it needed most.
  continuations: ['record-only', 'rework', 'requote', 'rebook', 'needs-docs', 'escalate-human'],
  triggers: ['edi214:', 'claim:', 'customer:', 'carrier:'],
};

// The one steering opinion, in the one slot the protocol offers (§11), using a
// REGISTERED tiebreak kind (§19) over this world's own link type: when the
// board is two hundred deep, the money moves first. Publish reads `link-number`
// ascending over manuscript position; Ridgeline reads it descending over
// revenue. Same slot, same kind, opposite direction — which is the evidence
// that the slot was cut at the right joint.
export const REVENUE_FIRST = {
  kind: 'link-number' as const, type: 'shipment', field: 'revenue_usd', direction: 'desc' as const,
};

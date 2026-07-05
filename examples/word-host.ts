// A Word document as a Nervo host — the proof that Nervo is domain-agnostic.
//
// PowderMonkey's plan (src/host/powdermonkey.ts) and this document editor share ZERO
// vocabulary — no tasks, no phases, no sessions, no git — yet both drive the exact same
// Nervo core (XState-backed FSM engine, command bus with permission + cost, undo,
// proposals). If Nervo leaked a single plan-shaped assumption, this file couldn't compile
// against it. That's the whole point of the seam: a domain the core has never heard of
// plugs straight in.
//
// This is the minimal "example host" others copy to build their own. It depends only on
// Nervo's public surface (src/nervo) and XState — never on PowderMonkey — which the
// boundary lint enforces (scripts/lint-boundaries.ts).

import { createMachine } from "xstate";
import { type Change, defineHost, type HostContract } from "../src/nervo/index.ts";

// ── Entity/FSM definitions (XState) ──────────────────────────────────────────

/** A document: drafted → in review → published, sendable back to draft from review. */
const documentMachine = createMachine({
  initial: "draft",
  states: {
    draft: { on: { SUBMIT: "in-review" } },
    "in-review": { on: { PUBLISH: "published", SEND_BACK: "draft" } },
    published: { on: { UNPUBLISH: "draft" } },
  },
});

/** A comment thread on the document: open ↔ resolved. */
const commentMachine = createMachine({
  initial: "open",
  states: {
    open: { on: { RESOLVE: "resolved" } },
    resolved: { on: { REOPEN: "open" } },
  },
});

// ── The action catalog ───────────────────────────────────────────────────────

export const wordHost: HostContract = defineHost({
  name: "word-document",
  entities: { document: documentMachine, comment: commentMachine },
  actions: [
    {
      id: "submit-for-review",
      title: "Submit for review",
      entity: "document",
      event: "SUBMIT",
      cost: () => ({ unit: "review-round", amount: 1 }),
    },
    { id: "publish", title: "Publish", entity: "document", event: "PUBLISH" },
    { id: "send-back", title: "Send back to author", entity: "document", event: "SEND_BACK" },
    { id: "unpublish", title: "Unpublish", entity: "document", event: "UNPUBLISH" },
    { id: "resolve-comment", title: "Resolve comment", entity: "comment", event: "RESOLVE" },
    { id: "reopen-comment", title: "Reopen comment", entity: "comment", event: "REOPEN" },
  ],
});

/** A sample proposal in the document domain: insert a new section with two paragraphs
 *  under it (a create-subtree), plus an edit to the title. Nervo's proposals model groups
 *  the section + its paragraphs into one decidable unit — see tests/nervo.test.ts. */
export const sampleProposal: Change[] = [
  { op: "add", kind: "section", ref: "s1", fields: { heading: "Introduction" } },
  { op: "add", kind: "paragraph", parentRef: "s1", fields: { text: "First paragraph." } },
  { op: "add", kind: "paragraph", parentRef: "s1", fields: { text: "Second paragraph." } },
  { op: "edit", kind: "document", id: 1, fields: { title: "Untitled → Draft One" } },
];

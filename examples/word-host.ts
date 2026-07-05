// A Word document as a Nervo host — the proof that Nervo is domain-agnostic.
//
// PowderMonkey's plan (src/host/powdermonkey.ts) and this document editor share ZERO
// vocabulary — no tasks, no phases, no sessions, no git — yet both drive the exact same
// Nervo core (FSM engine, command bus with permission + cost, undo, proposals). If Nervo
// leaked a single plan-shaped assumption, this file couldn't compile against it. That's
// the whole point of the seam: a domain the core has never heard of plugs straight in.
//
// This is the minimal "example host" others copy to build their own. It lives under
// examples/ (outside src/) precisely because it is NOT part of PowderMonkey — it depends
// only on Nervo's public surface (src/nervo). Run the shared engine against it in
// tests/nervo.test.ts.

import { type Change, defineHost, type HostContract, type Permit } from "../src/nervo/index.ts";

// ── Entity/FSM definitions ───────────────────────────────────────────────────

/** A document: drafted → in review → published, sendable back to draft from review. */
const documentFsm = {
  initial: "draft",
  transitions: {
    draft: ["in-review"],
    "in-review": ["published", "draft"],
    published: ["draft"],
  },
};

/** A comment thread on the document: open ↔ resolved. */
const commentFsm = {
  initial: "open",
  transitions: {
    open: ["resolved"],
    resolved: ["open"],
  },
};

const from =
  (states: string[], reason: string) =>
  ({ entity }: { entity: { state: string } }): Permit =>
    states.includes(entity.state) ? { ok: true } : { ok: false, reason };

// ── The action catalog ───────────────────────────────────────────────────────

export const wordHost: HostContract = defineHost({
  name: "word-document",
  entities: { document: documentFsm, comment: commentFsm },
  actions: [
    {
      id: "submit-for-review",
      title: "Submit for review",
      entity: "document",
      permit: from(["draft"], "only a draft can be submitted"),
      cost: () => ({ unit: "review-round", amount: 1 }),
      target: () => "in-review",
    },
    {
      id: "publish",
      title: "Publish",
      entity: "document",
      permit: from(["in-review"], "a document must be reviewed before publishing"),
      target: () => "published",
    },
    {
      id: "send-back",
      title: "Send back to author",
      entity: "document",
      permit: from(["in-review"], "only a document in review can be sent back"),
      target: () => "draft",
    },
    {
      id: "unpublish",
      title: "Unpublish",
      entity: "document",
      permit: from(["published"], "only a published document can be unpublished"),
      target: () => "draft",
    },
    {
      id: "resolve-comment",
      title: "Resolve comment",
      entity: "comment",
      permit: from(["open"], "comment is already resolved"),
      target: () => "resolved",
    },
    {
      id: "reopen-comment",
      title: "Reopen comment",
      entity: "comment",
      permit: from(["resolved"], "comment is already open"),
      target: () => "open",
    },
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

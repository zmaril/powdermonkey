// Shared bits for the "Proposed: …" review strips (EditStrips / GhostStrip /
// TaskProposalStrips) — kept here so the three one-per-file strip components don't
// each redefine them.

/** The "From proposal P…: …" hint every proposal strip shows on hover. */
export const hintFor = (proposalId: number, proposalTitle: string) =>
  `From proposal P${proposalId}: ${proposalTitle}`;

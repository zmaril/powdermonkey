import { type PlanTree, buildTree } from "../shared/tree.ts";
import { goalRepo, milestoneRepo, phaseRepo, sessionRepo, taskRepo } from "./crud.ts";

/** Load the flat vocab tables and roll them up into the nested plan tree. By
 * default only live rows are included; `includeArchived` mirrors the CRUD lists. */
export async function getTree(opts?: { includeArchived?: boolean }): Promise<PlanTree> {
  const o = { includeArchived: opts?.includeArchived ?? false };
  const [goals, milestones, tasks, phases, sessions] = await Promise.all([
    goalRepo.list(o),
    milestoneRepo.list(o),
    taskRepo.list(o),
    phaseRepo.list(o),
    sessionRepo.list(o),
  ]);
  return buildTree({ goals, milestones, tasks, phases, sessions });
}

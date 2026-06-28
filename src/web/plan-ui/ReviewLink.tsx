import { Anchor } from "@mantine/core";
import type { Task } from "../../server/schema.ts";
import { useStore } from "../store.ts";

/** PR number out of a GitHub PR url (…/pull/123 → 123), or null if it doesn't look
 *  like one. */
export function prNumberFromUrl(url: string | null | undefined): number | null {
  const m = url?.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** "Review" affordance for a task whose PR we can review in-app — opens the diff +
 *  inline-comment pane (ReviewPane) instead of bouncing out to github.com. Renders
 *  nothing when the task has no parseable PR url. */
export function ReviewLink({ task }: { task: Task }) {
  const openReview = useStore((s) => s.openReview);
  const number = prNumberFromUrl(task.prUrl);
  if (number == null) return null;
  return (
    <Anchor
      component="button"
      size="sm"
      fw={500}
      onClick={() => openReview(number, task.title)}
      title="Review this PR's diff and inline comments in-app"
    >
      Review
    </Anchor>
  );
}

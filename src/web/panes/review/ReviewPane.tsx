import { Anchor, Box, Button, Group, SegmentedControl, Text } from "@mantine/core";
import { IconExternalLink, IconX } from "@tabler/icons-react";
import { DockviewReact, type DockviewReadyEvent } from "dockview-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PrReview, ReviewEvent } from "../../../server/pr-review.ts";
import { api } from "../../client.ts";
import { openExternal } from "../../open-external.ts";
import { useActiveTheme } from "../../store.ts";
import { useRunEffect } from "../../use-run-effect.ts";
import { ReviewCtx, type ReviewCtxValue } from "./context.ts";
import { DescriptionPanel } from "./DescriptionPanel.tsx";
import { FilesPanel } from "./FilesPanel.tsx";
import { keyOf } from "./helpers.ts";
import { ReviewBar } from "./ReviewBar.tsx";
import type { DraftComment, LineAnchor } from "./types.ts";

// The in-app PR review pane: a PR's diff with inline review comments threaded under
// the lines they anchor to — so a review happens here, in the single pane of glass,
// instead of bouncing out to github.com. The server (pr-review.ts) does the GitHub
// I/O via `gh`; this is rendering off the /prs/:n/review payload.
//
// New comments accumulate into a local DRAFT and are submitted as ONE GitHub review
// (Approve / Request changes / Comment) via the footer bar — one webhook event for
// the whole pass instead of one per comment. (Replies to an existing thread still
// post immediately, since the reviews API can't express a reply.)
//
// Two layouts, toggled: Unified (one column, +/- interleaved) and Split (old left,
// new right). Comments anchor the same way in both — RIGHT/new-line for added or
// context lines, LEFT/old-line for removed — so the thread + composer code is shared.

// The two panels inside the review overlay's own dockview. The operator can drag /
// resize / re-tab them; the layout is rebuilt fresh each time the overlay opens.
const REVIEW_DOCK = { desc: DescriptionPanel, filesdiff: FilesPanel };

// Default: Description on the left (~1/3), the Files (tree + diff) panel filling the
// rest (~2/3). Sized after creation off the dockview width.
function buildReviewLayout(event: DockviewReadyEvent) {
  const api = event.api;
  api.addPanel({ id: "desc", component: "desc", title: "Description" });
  api.addPanel({
    id: "filesdiff",
    component: "filesdiff",
    title: "Diff",
    position: { direction: "right", referencePanel: "desc" },
  });
  const w = api.width || window.innerWidth;
  api.getPanel("desc")?.api.setSize({ width: Math.round(w / 3) });
}

/** Load the persisted "viewed files" set from localStorage once the PR key is known. */
function useLoadPersistedViewed(
  viewedKey: string | null,
  setViewed: (s: Set<string>) => void,
): void {
  useEffect(() => {
    if (!viewedKey) return;
    try {
      const raw = localStorage.getItem(viewedKey);
      setViewed(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch {
      setViewed(new Set());
    }
  }, [viewedKey, setViewed]);
}

export function ReviewPane({ number, onClose }: { number: number; onClose?: () => void }) {
  const [review, setReview] = useState<PrReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"unified" | "split">("unified");
  const [posting, setPosting] = useState(false);
  // The review hosts its own nested dockview; theme it with the active editor theme
  // so the review surface matches the rest of the app instead of a fixed dark dock.
  const dockTheme = useActiveTheme().dockTheme;
  // The line currently being commented on: `${path}::${side}::${line}`, plus the
  // resolved anchor so we know what to draft.
  const [compose, setCompose] = useState<{
    key: string;
    path: string;
    anchor: LineAnchor;
    startLine?: number;
  } | null>(null);
  // The pending review: drafted inline comments + an overall summary, held locally
  // and sent as ONE GitHub review on submit (one event, not one-per-comment).
  const [draft, setDraft] = useState<DraftComment[]>([]);
  const [summary, setSummary] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const nextId = useRef(1);
  // Per-file "viewed" state (GitHub's mechanic), persisted per PR+head so it
  // survives a reload. The diff collapses a viewed file; the sidebar shows the count.
  const [viewed, setViewed] = useState<Set<string>>(new Set());
  const viewedKey = review ? `pm-review-viewed:${number}:${review.headSha}` : null;
  // Scroll-to-file: each file's wrapper registers here, the tree scrolls to it.
  const fileEls = useRef(new Map<string, HTMLDivElement>());
  const scrollToFile = (path: string) =>
    fileEls.current.get(path)?.scrollIntoView({ block: "start", behavior: "smooth" });

  // Load persisted viewed state once the PR (and its head sha) is known.
  useLoadPersistedViewed(viewedKey, setViewed);

  const toggleViewed = (path: string) =>
    setViewed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      if (viewedKey) {
        try {
          localStorage.setItem(viewedKey, JSON.stringify([...next]));
        } catch {}
      }
      return next;
    });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error } = await api.prs({ number }).review.get();
    if (error) setError(String((error.value as { error?: string })?.error ?? error.status));
    else setReview(data as PrReview);
    setLoading(false);
  }, [number]);

  useRunEffect(load);

  // Index drafts by line anchor so each line can show its pending comments.
  const draftByKey = useMemo(() => {
    const m = new Map<string, DraftComment[]>();
    for (const d of draft) {
      const k = keyOf(d.path, { side: d.side, line: d.line });
      const list = m.get(k) ?? [];
      list.push(d);
      m.set(k, list);
    }
    return m;
  }, [draft]);

  const addDraft = (body: string, anchor: LineAnchor, path: string, startLine?: number) => {
    if (!body.trim()) return;
    setDraft((d) => [
      ...d,
      { id: nextId.current++, path, line: anchor.line, side: anchor.side, startLine, body },
    ]);
    setCompose(null);
  };
  const removeDraft = (id: number) => setDraft((d) => d.filter((x) => x.id !== id));

  // A reply to an existing thread posts immediately (the reviews API can't express
  // replies); fresh line comments are batched into the pending review instead.
  const reply = async (body: string, anchor: LineAnchor, path: string, inReplyTo: number) => {
    if (!review) return;
    setPosting(true);
    try {
      const { error } = await api.prs({ number }).comments.post({
        body,
        commitId: review.headSha,
        path,
        line: anchor.line,
        side: anchor.side,
        inReplyTo,
      });
      if (error) {
        setError(String((error.value as { error?: string })?.error ?? error.status));
        return;
      }
      await load();
    } finally {
      setPosting(false);
    }
  };

  // Submit the whole pending review in one call: every draft comment + the verdict.
  const submit = async (event: ReviewEvent) => {
    if (!review) return;
    setSubmitting(true);
    setError(null);
    try {
      const { error } = await api.prs({ number })["review-submit"].post({
        event,
        body: summary,
        commitId: review.headSha,
        comments: draft.map(({ path, line, side, startLine, body }) => ({
          path,
          line,
          side,
          ...(startLine != null ? { startLine, startSide: side } : {}),
          body,
        })),
      });
      if (error) {
        setError(String((error.value as { error?: string })?.error ?? error.status));
        return;
      }
      setDraft([]);
      setSummary("");
      await load(); // the submitted comments now come back as posted threads
    } finally {
      setSubmitting(false);
    }
  };

  // Everything the dockview panels (Description, Files) need, rebuilt each render so
  // the portaled panels re-render as state changes. null until the PR has loaded.
  const ctx: ReviewCtxValue | null = review
    ? {
        review,
        view,
        draftByKey,
        removeDraft,
        composeKey: compose?.key ?? null,
        composeStartLine: compose?.startLine ?? null,
        onAdd: (path, anchor, startLine) =>
          setCompose({ key: keyOf(path, anchor), path, anchor, startLine }),
        onCancelCompose: () => setCompose(null),
        onSubmitCompose: (body) => {
          if (compose) addDraft(body, compose.anchor, compose.path, compose.startLine);
        },
        onReply: (inReplyTo, body) => {
          // A reply reuses the parent's anchor only for the (unused) line/side; the
          // server ignores them when in_reply_to is set.
          const parent = review.comments.find((c) => c.id === inReplyTo);
          const anchor: LineAnchor = { side: parent?.side ?? "RIGHT", line: parent?.line ?? 1 };
          return reply(body, anchor, parent?.path ?? "", inReplyTo);
        },
        posting,
        viewed,
        toggleViewed,
        registerFileEl: (path, el) => {
          if (el) fileEls.current.set(path, el);
          else fileEls.current.delete(path);
        },
        scrollToFile,
      }
    : null;

  return (
    <Box
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--pm-pane-bg)",
      }}
    >
      <Group justify="space-between" px="md" py="cozy" style={{ flex: "0 0 auto" }} wrap="nowrap">
        <Group gap="cozy" style={{ minWidth: 0 }}>
          <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5, flexShrink: 0 }}>
            REVIEW
          </Text>
          <Text size="sm" fw={500} truncate>
            {review ? `#${review.number} ${review.title}` : `PR #${number}`}
          </Text>
          {review?.url && (
            <Anchor
              href={review.url}
              target="_blank"
              onClick={(e) => {
                e.preventDefault();
                openExternal(review.url);
              }}
              c="dimmed"
              style={{ flexShrink: 0, display: "inline-flex", lineHeight: 1 }}
            >
              <IconExternalLink size={14} />
            </Anchor>
          )}
        </Group>
        <Group gap="cozy" wrap="nowrap">
          <SegmentedControl
            size="xs"
            value={view}
            onChange={(v) => setView(v as "unified" | "split")}
            data={[
              { label: "Unified", value: "unified" },
              { label: "Split", value: "split" },
            ]}
          />
          <Button size="compact-xs" variant="default" onClick={load} loading={loading}>
            Refresh
          </Button>
          {onClose && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              onClick={onClose}
              title="Close review (Esc)"
              leftSection={<IconX size={14} />}
            >
              Close
            </Button>
          )}
        </Group>
      </Group>

      {error && (
        <Text c="red" size="sm" px="md" py="xs" style={{ flex: "0 0 auto" }}>
          {error}
        </Text>
      )}

      {/* The overlay hosts its OWN dockview — Description (1/3) + Files=tree+diff
          (2/3) — so the operator can drag/resize/re-tab the review surface. */}
      {!ctx ? (
        <Box style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Text c="dimmed" size="sm">
            {loading ? "Loading diff…" : "No PR loaded."}
          </Text>
        </Box>
      ) : (
        <ReviewCtx.Provider value={ctx}>
          <Box style={{ flex: 1, minHeight: 0 }}>
            <DockviewReact components={REVIEW_DOCK} onReady={buildReviewLayout} theme={dockTheme} />
          </Box>
          <ReviewBar
            draft={draft}
            summary={summary}
            setSummary={setSummary}
            submit={submit}
            submitting={submitting}
          />
        </ReviewCtx.Provider>
      )}
    </Box>
  );
}

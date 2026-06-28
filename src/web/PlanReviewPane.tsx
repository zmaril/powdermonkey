import { markdown } from "@codemirror/lang-markdown";
import { unifiedMergeView } from "@codemirror/merge";
import { oneDark } from "@codemirror/theme-one-dark";
import { Box, Button, Group, Select, Text } from "@mantine/core";
import { EditorView, basicSetup } from "codemirror";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./client.ts";

// The Plan pane is a real markdown EDITOR (CodeMirror 6), not a diff:
//   • "Current plan" → an editable markdown editor on the live plan; Save writes it
//     back through the markdown roundtrip (POST /plan/markdown).
//   • a pending proposal → CodeMirror's `unifiedMergeView`: a unified diff of the
//     proposal against the live plan with built-in Accept / Reject controls per
//     chunk. You triage chunks (you don't free-type in a diff); Save writes the
//     curated result. A single save, so no whole-plan churn.
// (GitHub PR review still uses @pierre/diffs in its own overlay — a diff is a diff.)

const CURRENT = "current";

type Pending = { id: number; title: string };

// Fill the pane and scroll internally; monospace for the markdown source.
const heightTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
});

export function PlanReviewPane() {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [baseline, setBaseline] = useState("");
  const [proposed, setProposed] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [source, setSource] = useState<string>(CURRENT);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPending = useCallback(async () => {
    const props = await api.proposals.pending.get();
    setPending(
      ((props.data ?? []) as Array<{ id: number; title: string }>).map((p) => ({
        id: p.id,
        title: p.title,
      })),
    );
  }, []);

  // Fetch the content for a source: the live plan (always), plus a proposal's
  // projection when one is selected. The editor effect rebuilds off these.
  const load = useCallback(async (src: string) => {
    const planRes = await api.plan.markdown.get();
    const md = typeof planRes.data === "string" ? planRes.data : "";
    setBaseline(md);
    if (src === CURRENT) {
      setProposed("");
      return;
    }
    const proposedRes = await api.proposals({ id: Number(src) }).markdown.get();
    setProposed(typeof proposedRes.data === "string" ? proposedRes.data : md);
  }, []);

  useEffect(() => {
    loadPending();
    load(CURRENT);
  }, [loadPending, load]);

  // (Re)build the editor whenever the source or its content changes. Plain markdown
  // editor for the live plan; unifiedMergeView (diff + Accept/Reject chunks) for a
  // proposal, with the live plan as the original.
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const isMerge = source !== CURRENT;
    const doc = isMerge ? proposed : baseline;
    const extensions = [
      basicSetup,
      markdown(),
      oneDark,
      heightTheme,
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) setDirty(true);
      }),
    ];
    if (isMerge) {
      // original = the live plan; doc = the proposal. Accept keeps the proposal's
      // chunk, Reject restores the live plan's.
      extensions.push(unifiedMergeView({ original: baseline, mergeControls: true }));
    }
    const view = new EditorView({ doc, extensions, parent });
    viewRef.current = view;
    setDirty(false);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [source, baseline, proposed]);

  const chooseSource = async (val: string | null) => {
    const next = val ?? CURRENT;
    setSource(next);
    setStatus(null);
    setError(null);
    await load(next);
  };

  const save = async () => {
    const view = viewRef.current;
    if (!view) return;
    const md = view.state.doc.toString();
    setBusy(true);
    setError(null);
    setStatus(null);
    const { data, error: err } = await api.plan.markdown.post({ markdown: md });
    if (err) {
      setError(String((err.value as { error?: string })?.error ?? err.status));
    } else if (data) {
      const r = data as { created: number; updated: number; archived: number };
      setStatus(`saved — +${r.created} created · ${r.updated} updated · ${r.archived} archived`);
      setSource(CURRENT);
      await Promise.all([load(CURRENT), loadPending()]);
    }
    setBusy(false);
  };

  const isMerge = source !== CURRENT;

  return (
    <Box
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "#1a1b1e" }}
    >
      <Group justify="space-between" px="md" py={8} style={{ flex: "0 0 auto" }} wrap="nowrap">
        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
            PLAN
          </Text>
          <Select
            size="xs"
            w={260}
            value={source}
            onChange={chooseSource}
            data={[
              { value: CURRENT, label: "Current plan (edit)" },
              ...pending.map((p) => ({
                value: String(p.id),
                label: `Review P${p.id} · ${p.title}`,
              })),
            ]}
            aria-label="Plan source"
          />
          <Text size="xs" c="dimmed">
            {isMerge
              ? "review — Accept / Reject each chunk, then Save"
              : "edit the plan as markdown"}
          </Text>
          {error && (
            <Text size="xs" c="red" truncate maw={240} title={error}>
              {error}
            </Text>
          )}
          {status && (
            <Text size="xs" c="teal" truncate maw={320}>
              {status}
            </Text>
          )}
        </Group>
        <Group gap={6} wrap="nowrap">
          <Button
            size="compact-xs"
            color="green"
            variant="light"
            loading={busy}
            disabled={busy || (!dirty && !isMerge)}
            onClick={save}
          >
            {isMerge ? "Save reviewed plan" : "Save"}
          </Button>
        </Group>
      </Group>

      <Box ref={host} style={{ flex: 1, minHeight: 0, overflow: "hidden" }} />
    </Box>
  );
}

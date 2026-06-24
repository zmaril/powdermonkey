// The global scratchpad: one catchall note for loose ideas. Autosaves; the
// supervisor reads it (injected into its context) and can propose edits.

import { Box, Group, Text, Textarea } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { useBoard } from "../store.ts";

export function ScratchpadView() {
  const [content, setContent] = useState("");
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState(true);
  const savedRef = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // pick up external (supervisor-approved) edits via the live action feed
  const lastSpId = useBoard((s) => s.actions.find((a) => a.entityType === "scratchpad")?.id);

  useEffect(() => {
    fetch("/api/scratchpad")
      .then((r) => r.json())
      .then((d) => {
        setContent(d.content ?? "");
        setReady(true);
      });
  }, []);

  useEffect(() => {
    if (ready && savedRef.current) {
      fetch("/api/scratchpad")
        .then((r) => r.json())
        .then((d) => setContent(d.content ?? ""));
    }
  }, [lastSpId, ready]);

  const onChange = (v: string) => {
    setContent(v);
    setSaved(false);
    savedRef.current = false;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      await fetch("/api/scratchpad", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: v }),
      });
      setSaved(true);
      savedRef.current = true;
    }, 600);
  };

  return (
    <Box style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Group
        justify="space-between"
        px="xl"
        py="md"
        style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}
      >
        <Text size="xs" c="dimmed" tt="uppercase">
          Scratchpad
        </Text>
        <Text size="xs" c={saved ? "dimmed" : "orange"}>
          {saved ? "saved" : "saving…"}
        </Text>
      </Group>
      <Box style={{ flex: 1, minHeight: 0, padding: "14px 24px" }}>
        <Textarea
          value={content}
          onChange={(e) => onChange(e.currentTarget.value)}
          placeholder="Jot anything — scattered ideas, links, todos. The supervisor can read this and propose edits or base plans on it."
          styles={{
            root: { height: "100%" },
            wrapper: { height: "100%" },
            input: {
              height: "100%",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 13,
              lineHeight: 1.65,
            },
          }}
        />
      </Box>
    </Box>
  );
}

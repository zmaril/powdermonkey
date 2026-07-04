import { Group, Text } from "@mantine/core";
import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useRef, useState } from "react";
import { notesCollection } from "../collections.ts";
import { useStore } from "../store.ts";

/** The scratchpad's note state: one note seeded once from the server so the 4s
 *  background poll can't clobber in-flight keystrokes; edits update the draft
 *  immediately and debounce a PATCH. Out-of-band edits (another tab, or the
 *  supervisor editing @notes) are adopted only when nothing local is pending. */
export function useScratchNote() {
  const { ensureScratch, saveNote } = useStore();
  const [id, setId] = useState<number | null>(null);
  const [body, setBody] = useState("");
  const [saved, setSaved] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The server value we're synced with. We only adopt an incoming change when the
  // local draft still equals this — i.e. there are no unsaved keystrokes to lose.
  const serverBody = useRef("");
  const notes = useLiveQuery(() => notesCollection);
  const storeBody = id == null ? undefined : notes.data?.find((n) => n.id === id)?.body;

  useEffect(() => {
    let active = true;
    ensureScratch().then((note) => {
      if (!active || !note) return;
      setId(note.id);
      setBody(note.body);
      serverBody.current = note.body;
    });
    return () => {
      active = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [ensureScratch]);

  // Adopt a server-side change (poll / out-of-band CRUD) only when nothing local
  // is pending — if the draft has diverged, the operator is mid-edit; don't clobber.
  useEffect(() => {
    if (storeBody != null && storeBody !== body && body === serverBody.current) {
      setBody(storeBody);
      serverBody.current = storeBody;
    }
  }, [storeBody, body]);

  const onChange = (next: string) => {
    setBody(next);
    if (id == null) return;
    setSaved(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      saveNote(id, { body: next }).then(() => {
        serverBody.current = next;
        setSaved(true);
      });
    }, 500);
  };

  return { id, body, saved, onChange };
}

// The scratchpad: one note, one big textarea. Holds its own draft state seeded
// once from the server so the 4s background poll can't clobber what you're typing;
// edits update the draft immediately and debounce a PATCH. The supervisor reads it
// on "check @notes" (GET /notes). All the load/sync logic lives in useScratchNote.
export function ScratchPad() {
  const { id, body, saved, onChange } = useScratchNote();

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--pm-pane-bg)",
      }}
    >
      <Group justify="space-between" px="sm" py="snug" style={{ flex: "0 0 auto" }}>
        <Text
          size="xs"
          c="dimmed"
          fw={700}
          style={{ letterSpacing: 0.5 }}
          title="Durable and synced; the supervisor reads this as @notes"
        >
          NOTES
        </Text>
        <Text size="xs" c="dimmed">
          {id == null ? "…" : saved ? "saved" : "saving…"}
        </Text>
      </Group>
      <textarea
        value={body}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder="Stray thoughts…"
        spellCheck={false}
        style={{
          flex: 1,
          width: "100%",
          resize: "none",
          border: "none",
          outline: "none",
          background: "var(--pm-pane-bg)",
          color: "var(--pm-text)",
          padding: "4px 12px 12px",
          fontFamily: "var(--mantine-font-family-monospace)",
          fontSize: "0.8125rem",
          lineHeight: 1.5,
        }}
      />
    </div>
  );
}

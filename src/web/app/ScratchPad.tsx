import { Group, Text } from "@mantine/core";
import { useLiveQuery } from "@tanstack/react-db";
import { type RefObject, useEffect, useRef, useState } from "react";
import { notesCollection } from "../collections.ts";
import { useStore } from "../store.ts";
import { resolveActive } from "../windows.ts";

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

/** Each window keeps its own CURSOR into the (global) Scratch note — the content
 *  is shared and durable, but where you were reading/writing is a per-window,
 *  device-local thing (windows.ts ScratchCursor). Restore re-runs on window switch
 *  AND whenever `body` settles: the pane seeds from a cached note snapshot, and
 *  when the live collection value replaces it the DOM yanks the caret to the end —
 *  re-applying on body change undoes that. It never fights the operator: a focused
 *  textarea is being typed in, so restore is skipped. Saves listen on the textarea
 *  directly and write through getState(), not a subscription, so moving the caret
 *  never re-renders the pane. */
export function useWindowScratchCursor(
  ref: RefObject<HTMLTextAreaElement | null>,
  ready: boolean,
  body: string,
): void {
  const activeWindowId = useStore((s) => s.activeWindowId);
  useEffect(() => {
    const ta = ref.current;
    if (!ta || !ready || document.activeElement === ta) return;
    const cur = resolveActive(useStore.getState().windows, activeWindowId)?.scratchCursor;
    if (cur) {
      // Clamp to the rendered body — the stored cursor can outlive an edit that
      // shortened the note (another window, or the supervisor writing @notes).
      const max = body.length;
      ta.setSelectionRange(Math.min(cur.start, max), Math.min(cur.end, max));
      ta.scrollTop = cur.scroll;
    }
  }, [ref, ready, activeWindowId, body]);
  useEffect(() => {
    const ta = ref.current;
    if (!ta || !ready) return;
    const save = () => {
      const s = useStore.getState();
      s.setScratchCursor(s.activeWindowId, {
        start: ta.selectionStart,
        end: ta.selectionEnd,
        scroll: ta.scrollTop,
      });
    };
    // selection moves on click/keys/select; scroll is its own event. All passive —
    // and the writes are cheap store patches, no server round-trip.
    const events = ["select", "keyup", "click", "scroll"] as const;
    for (const e of events) ta.addEventListener(e, save, { passive: true });
    return () => {
      for (const e of events) ta.removeEventListener(e, save);
    };
  }, [ref, ready]);
}

// The scratchpad: ONE global note, one big textarea — the same content in every
// window (a window only remembers its cursor into it, so closing a window loses
// nothing). Holds its own draft state seeded once from the server so the 4s
// background poll can't clobber what you're typing; edits update the draft
// immediately and debounce a PATCH. The supervisor reads it on "check @notes"
// (GET /notes). All the load/sync logic lives in useScratchNote.
export function ScratchPad() {
  const { id, body, saved, onChange } = useScratchNote();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useWindowScratchCursor(taRef, id != null, body);

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
          title="One global pad — durable, synced, the supervisor reads it as @notes; each window keeps its own cursor"
        >
          SCRATCH
        </Text>
        <Text size="xs" c="dimmed">
          {id == null ? "…" : saved ? "saved" : "saving…"}
        </Text>
      </Group>
      <textarea
        ref={taRef}
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

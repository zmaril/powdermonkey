// The chat runtime: a persistent, multi-thread runtime backed by PowderMonkey's
// HTTP API. Threads + messages live in PGlite; each thread resumes its own
// claude session. A thread can also be bound to a goal/workspace (supervisor chat).

import {
  type ChatModelAdapter,
  ExportedMessageRepository,
  type RemoteThreadListAdapter,
  RuntimeAdapterProvider,
  type ThreadHistoryAdapter,
  useAui,
  useLocalRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import { createAssistantStream } from "assistant-stream";
import { Match } from "effect";
import { type PropsWithChildren, useMemo } from "react";
import { useBind } from "./bind.ts";
import { useRunStatus } from "./run-status.ts";
import { useView, View } from "./view.ts";

const PLAN_FENCE = /```propose_plan\s*([\s\S]*?)```/;
const PLAN_STRIP = /```propose_plan[\s\S]*?(?:```|$)/g;
const MS_FENCE = /```propose_milestones\s*([\s\S]*?)```/;
const MS_STRIP = /```propose_milestones[\s\S]*?(?:```|$)/g;
const SP_FENCE = /```propose_scratchpad\s*([\s\S]*?)```/;
const SP_STRIP = /```propose_scratchpad[\s\S]*?(?:```|$)/g;
const J = { "content-type": "application/json" };

// The NDJSON events the chat backend streams (mirrors chat.ts send()).
type StreamEvent =
  | { t: "text"; v: string }
  | { t: "tool"; id: string; name: string }
  | { t: "tool_done"; id: string }
  | { t: "session"; id: string }
  | { t: "error"; v: string }
  | { t: "done" };

type Aui = ReturnType<typeof useAui>;

function lastUserText(messages: readonly any[]): string {
  const m = [...messages].reverse().find((x) => x.role === "user");
  if (!m) return "";
  return (m.content as any[])
    .filter((p) => p?.type === "text")
    .map((p) => p.text)
    .join("\n");
}

// The active thread's server id (== client id == remoteId), initializing if needed.
async function threadIdFor(aui: Aui): Promise<string> {
  const item = aui.threadListItem();
  return item.getState().remoteId ?? (await item.initialize()).remoteId;
}

function makeClaudeAdapter(aui: Aui): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const text = lastUserText(messages);
      const threadId = await threadIdFor(aui);
      const bind = useBind.getState().pending;
      if (bind) useBind.setState({ pending: null });
      const screen = View.$match(useView.getState().view, {
        None: () => ({ kind: "none" }),
        Scratchpad: () => ({ kind: "scratchpad" }),
        Workspaces: () => ({ kind: "none" }),
        Workspace: ({ id }) => ({ kind: "workspace", id }),
        Goal: ({ id }) => ({ kind: "goal", id }),
        Task: ({ id }) => ({ kind: "task", id }),
      });
      useRunStatus.setState({ running: true, startedAt: Date.now(), hasText: false, tools: [] });

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: J,
        body: JSON.stringify({ threadId, text, bind, screen }),
        signal: abortSignal,
      });
      if (!res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let full = "";
      const frame = () => {
        const display = full
          .replace(PLAN_STRIP, "")
          .replace(MS_STRIP, "")
          .replace(SP_STRIP, "")
          .trimEnd();
        const content: any[] = [{ type: "text", text: display }];
        const m = full.match(PLAN_FENCE);
        if (m) {
          try {
            const args = JSON.parse(m[1].trim());
            content.push({
              type: "tool-call",
              toolCallId: "propose_plan-0",
              toolName: "propose_plan",
              args,
              argsText: m[1].trim(),
            });
          } catch {
            /* still streaming */
          }
        }
        const mm = full.match(MS_FENCE);
        if (mm) {
          try {
            const arr = JSON.parse(mm[1].trim());
            content.push({
              type: "tool-call",
              toolCallId: "propose_milestones-0",
              toolName: "propose_milestones",
              args: { milestones: arr },
              argsText: mm[1].trim(),
            });
          } catch {
            /* still streaming */
          }
        }
        const sp = full.match(SP_FENCE);
        if (sp) {
          try {
            const args = JSON.parse(sp[1].trim());
            content.push({
              type: "tool-call",
              toolCallId: "propose_scratchpad-0",
              toolName: "propose_scratchpad",
              args,
              argsText: sp[1].trim(),
            });
          } catch {
            /* still streaming */
          }
        }
        return { content } as any;
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (;;) {
          const nl = buf.indexOf("\n");
          if (nl < 0) break;
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: StreamEvent;
          try {
            ev = JSON.parse(line) as StreamEvent;
          } catch {
            continue;
          }
          // Exhaustive over StreamEvent; handlers mutate run-status/full and
          // return whether a new frame should be flushed (yield can't cross the
          // Match callback boundary, so we yield on the result here).
          const flush = Match.value(ev).pipe(
            Match.when({ t: "text" }, (e) => {
              if (!useRunStatus.getState().hasText) useRunStatus.setState({ hasText: true });
              full += e.v;
              return true;
            }),
            Match.when({ t: "tool" }, (e) => {
              useRunStatus.setState((st) => ({
                tools: [...st.tools, { id: e.id, name: e.name, done: false }],
              }));
              return false;
            }),
            Match.when({ t: "tool_done" }, (e) => {
              useRunStatus.setState((st) => ({
                tools: st.tools.map((t) => (t.id === e.id ? { ...t, done: true } : t)),
              }));
              return false;
            }),
            Match.when({ t: "error" }, (e) => {
              full += `\n\n_⚠️ ${e.v}_`;
              return true;
            }),
            Match.when({ t: "session" }, () => false),
            Match.when({ t: "done" }, () => false),
            Match.exhaustive,
          );
          if (flush) yield frame();
        }
      }
      useRunStatus.setState({ running: false });
      yield frame();
    },
  };
}

function usePmHistory(): ThreadHistoryAdapter {
  const aui = useAui();
  return useMemo<ThreadHistoryAdapter>(
    () => ({
      async load() {
        const remoteId = aui.threadListItem().getState().remoteId;
        if (!remoteId) return { messages: [] };
        const rows = await fetch(`/api/threads/${remoteId}/messages`).then((r) => r.json());
        return ExportedMessageRepository.fromArray(rows as any);
      },
      async append({ message }) {
        const { remoteId } = await aui.threadListItem().initialize();
        await fetch(`/api/threads/${remoteId}/messages`, {
          method: "POST",
          headers: J,
          body: JSON.stringify({ message }),
        });
      },
    }),
    [aui],
  );
}

function HistoryProvider({ children }: PropsWithChildren) {
  const history = usePmHistory();
  return <RuntimeAdapterProvider adapters={{ history }}>{children}</RuntimeAdapterProvider>;
}

// Per-thread message runtime, with an adapter that knows the active thread.
function useThreadChatRuntime() {
  const aui = useAui();
  const adapter = useMemo(() => makeClaudeAdapter(aui), [aui]);
  return useLocalRuntime(adapter);
}

export function useChatRuntime() {
  const adapter = useMemo<RemoteThreadListAdapter>(
    () => ({
      async list() {
        const rows = await fetch("/api/threads").then((r) => r.json());
        return {
          threads: (rows as any[]).map((t) => ({
            status: (t.archived ? "archived" : "regular") as "archived" | "regular",
            remoteId: t.id as string,
            title: (t.title ?? undefined) as string | undefined,
            lastMessageAt: t.lastMessageAt ? new Date(t.lastMessageAt) : undefined,
          })),
        };
      },
      async initialize(threadId) {
        const t = await fetch("/api/threads", {
          method: "POST",
          headers: J,
          body: JSON.stringify({ clientId: threadId }),
        }).then((r) => r.json());
        return { remoteId: t.id as string, externalId: undefined };
      },
      async fetch(threadId) {
        const t = await fetch(`/api/threads/${threadId}`).then((r) => r.json());
        return {
          status: (t?.archived ? "archived" : "regular") as "archived" | "regular",
          remoteId: threadId,
          title: (t?.title ?? undefined) as string | undefined,
        };
      },
      async rename(remoteId, newTitle) {
        await fetch(`/api/threads/${remoteId}`, {
          method: "PATCH",
          headers: J,
          body: JSON.stringify({ title: newTitle }),
        });
      },
      async archive(remoteId) {
        await fetch(`/api/threads/${remoteId}`, {
          method: "PATCH",
          headers: J,
          body: JSON.stringify({ archived: true }),
        });
      },
      async unarchive(remoteId) {
        await fetch(`/api/threads/${remoteId}`, {
          method: "PATCH",
          headers: J,
          body: JSON.stringify({ archived: false }),
        });
      },
      async delete(remoteId) {
        await fetch(`/api/threads/${remoteId}`, { method: "DELETE" });
      },
      async generateTitle(remoteId) {
        const t = await fetch(`/api/threads/${remoteId}`).then((r) => r.json());
        const title = (t?.title as string) || "New chat";
        return createAssistantStream((c) => {
          c.appendText(title);
        });
      },
      unstable_Provider: HistoryProvider,
    }),
    [],
  );

  return useRemoteThreadListRuntime({ adapter, runtimeHook: useThreadChatRuntime });
}

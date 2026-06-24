// The app shell: left = navigation + needs-reviews, middle = the work surface
// (workspace/goal/task views; a task is the worker chat), right = the always-on
// assistant/supervisor chat.

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { AppShell } from "@mantine/core";
import { useEffect } from "react";
import { useBoard } from "../store.ts";
import { EntityView } from "./EntityViews.tsx";
import { ProposeMilestonesToolUI } from "./ProposeMilestonesToolUI.tsx";
import { ProposePlanToolUI } from "./ProposePlanToolUI.tsx";
import { ProposeScratchpadToolUI } from "./ProposeScratchpadToolUI.tsx";
import { RightPane } from "./RightPane.tsx";
import { useChatRuntime } from "./runtime.tsx";
import { LeftSidebar } from "./Sidebar.tsx";
import { useView, useViewUrlSync } from "./view.ts";

function WorkPane() {
  const view = useView((s) => s.view);
  return <EntityView view={view} />;
}

export function ChatApp() {
  useViewUrlSync();
  const load = useBoard((s) => s.load);
  const connect = useBoard((s) => s.connect);
  useEffect(() => {
    void load();
    connect();
  }, [load, connect]);

  const runtime = useChatRuntime();
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ProposePlanToolUI />
      <ProposeMilestonesToolUI />
      <ProposeScratchpadToolUI />
      <AppShell
        navbar={{ width: 260, breakpoint: "sm" }}
        aside={{ width: 400, breakpoint: "sm" }}
        padding={0}
        h="100vh"
      >
        <AppShell.Navbar>
          <LeftSidebar />
        </AppShell.Navbar>
        <AppShell.Main h="100vh" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <WorkPane />
        </AppShell.Main>
        <AppShell.Aside
          h="100vh"
          style={{ display: "flex", flexDirection: "column", minHeight: 0 }}
        >
          <RightPane />
        </AppShell.Aside>
      </AppShell>
    </AssistantRuntimeProvider>
  );
}

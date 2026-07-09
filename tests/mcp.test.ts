import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, expect, test } from "bun:test";
import { setupTestDb, tmp } from "./db-harness.ts";

// The `pm mcp` surface, exercised over the real MCP protocol machinery via the SDK's
// in-memory transport (a linked Client<->Server pair — the same request/response path
// as stdio, minus the OS pipe). We assert the op-table projects to tools (tools/list)
// and that a tool call actually round-trips through the SHARED op handler into the
// store — the same store the REST routes write to (both go through buildContext()).
//
// In-memory (not a spawned `pm mcp`) is deliberate: PGlite is single-writer per
// process, and this test process already holds the scratch store's writer lock (from
// setupTestDb), so the handlers run here and the effect is assertable in-process.

process.env.PM_REPO_DIR = tmp("pm-repo-");
process.env.PM_EXE_DRY_RUN = "1"; // never open a real disponent engine

const { ready } = await setupTestDb();
const { buildMcpServer } = await import("../src/server/mcp.ts");
const { ops } = await import("../src/server/ops/index.ts");
const { taskRepo } = await import("../src/server/crud.ts");

/** A connected MCP client talking to a fresh server over an in-memory transport. */
async function connect(): Promise<Client> {
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "pm-mcp-test", version: "0" });
  await client.connect(clientTransport);
  return client;
}

/** The text of a tool result's first content block. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  if (!block || block.type !== "text" || block.text == null) {
    throw new Error(`expected a text content block, got ${JSON.stringify(result.content)}`);
  }
  return block.text;
}

beforeAll(async () => {
  await ready();
});

test("tools/list projects every op, each with an object inputSchema + honest annotations", async () => {
  const client = await connect();
  const { tools } = await client.listTools();

  expect(tools.map((t) => t.name).sort()).toEqual(ops.map((o) => o.name).sort());
  for (const tool of tools) {
    // TypeBox emits JSON Schema, so the MCP inputSchema is a bona fide object schema.
    expect(tool.inputSchema.type).toBe("object");
    expect(typeof tool.description).toBe("string");
    expect((tool.description ?? "").length).toBeGreaterThan(0);
  }

  // Annotations reflect the op flags: a destructive write and a pure read.
  const cancel = tools.find((t) => t.name === "task.cancel");
  expect(cancel?.annotations?.destructiveHint).toBe(true);
  const list = tools.find((t) => t.name === "tasks.list");
  expect(list?.annotations?.readOnlyHint).toBe(true);

  await client.close();
});

test("write tool plan.load + read tool tasks.list round-trip through the shared store", async () => {
  const client = await connect();

  // Control/write tool: load a plan tree.
  const loaded = await client.callTool({
    name: "plan.load",
    arguments: {
      goals: [
        {
          title: "Recon",
          milestones: [
            {
              title: "m",
              tasks: [{ title: "tables", phases: [{ name: "a" }] }, { title: "endpoints" }],
            },
          ],
        },
      ],
    },
  });
  expect(loaded.isError).toBeFalsy();
  expect(JSON.parse(textOf(loaded as never))).toMatchObject({
    goals: 1,
    milestones: 1,
    tasks: 2,
    phases: 1,
  });

  // The effect landed in the store the op handler shares with the REST routes.
  const stored = await taskRepo.list();
  expect(stored.map((t) => t.title).sort()).toEqual(["endpoints", "tables"]);

  // Read tool: the MCP surface sees the same rows.
  const listed = await client.callTool({ name: "tasks.list", arguments: {} });
  expect(listed.isError).toBeFalsy();
  const rows = JSON.parse(textOf(listed as never)) as Array<{ title: string }>;
  expect(rows.map((r) => r.title).sort()).toEqual(["endpoints", "tables"]);

  await client.close();
});

test("honest edges: unknown tool and invalid arguments return isError, never fake success", async () => {
  const client = await connect();

  const unknown = await client.callTool({ name: "does.not.exist", arguments: {} });
  expect(unknown.isError).toBe(true);
  expect(textOf(unknown as never)).toContain("unknown tool");

  // plan.load with a shape its TypeBox schema rejects (goals must be an array).
  const bad = await client.callTool({ name: "plan.load", arguments: { goals: "nope" } });
  expect(bad.isError).toBe(true);
  expect(textOf(bad as never)).toContain("invalid arguments");

  await client.close();
});

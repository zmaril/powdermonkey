import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Value } from "@sinclair/typebox/value";
import pkg from "../../package.json" with { type: "json" };
import { buildContext, ops } from "./ops/index.ts";
import type { Op } from "./ops/types.ts";

// `pm mcp` — a stdio Model Context Protocol server exposing pm's control ops as
// tools, for an external supervising agent to drive the plan model directly.
//
// Every tool here is projected from the SAME op-table (src/server/ops) that backs
// the Elysia REST routes: one handler, two surfaces. The browser keeps talking REST
// over Eden + the /sync WebSocket, unchanged; this is purely an additional surface
// for programmatic clients. The pivot is the op's TypeBox `input` schema — TypeBox
// emits JSON Schema, which is exactly what an MCP tool's `inputSchema` requires.

/** Turn an op into an MCP tool descriptor. The `input` schema is a TypeBox schema,
 *  which is JSON Schema already; a JSON round-trip drops TypeBox's non-JSON `Symbol`
 *  metadata (`[Kind]`, `[Optional]`, …) so the SDK sees a plain JSON-Schema object. */
export function opToTool(op: Op): Tool {
  const inputSchema = JSON.parse(JSON.stringify(op.input)) as Tool["inputSchema"];
  return {
    name: op.name,
    title: op.title,
    description: op.description,
    inputSchema,
    annotations: {
      title: op.title,
      readOnlyHint: op.readOnly ?? false,
      destructiveHint: op.destructive ?? false,
    },
  };
}

/** Build the MCP server: register tools/list and tools/call over the op-table.
 *  Each tools/call validates the arguments against the op's TypeBox schema (applying
 *  defaults / coercion) before invoking the shared handler with a fresh context. A
 *  bad tool name or invalid arguments returns an honest `isError` result — it never
 *  fakes success. */
export function buildMcpServer(): Server {
  const server = new Server(
    { name: "powdermonkey", version: pkg.version },
    { capabilities: { tools: {} } },
  );
  const byName = new Map(ops.map((op) => [op.name, op]));

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: ops.map(opToTool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const op = byName.get(req.params.name);
    if (!op) {
      return {
        isError: true,
        content: [{ type: "text", text: `unknown tool "${req.params.name}"` }],
      };
    }
    // Validate + coerce the arguments against the op's own TypeBox schema — the same
    // schema Elysia validates the REST body against — so both surfaces enforce one
    // contract. Value.Parse throws on a shape it can't satisfy.
    let input: unknown;
    try {
      input = Value.Parse(op.input, req.params.arguments ?? {});
    } catch (e) {
      const errors = [...Value.Errors(op.input, req.params.arguments ?? {})].map(
        (err) => `${err.path || "/"}: ${err.message}`,
      );
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `invalid arguments for "${op.name}": ${
              errors.length ? errors.join("; ") : e instanceof Error ? e.message : String(e)
            }`,
          },
        ],
      };
    }

    try {
      // biome-ignore lint/suspicious/noExplicitAny: input is validated above against op.input.
      const result = await op.handler(buildContext(), input as any);
      return { content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }] };
    } catch (e) {
      return {
        isError: true,
        content: [
          { type: "text", text: `op "${op.name}" failed: ${e instanceof Error ? e.message : e}` },
        ],
      };
    }
  });

  return server;
}

/** Boot the stdio MCP server. The caller must have opened the store (`ready()`) and
 *  loaded settings first — same bring-up as the HTTP supervisor (see index.ts). */
export async function serveMcpStdio(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

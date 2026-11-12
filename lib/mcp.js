// Minimal, dependency-free MCP server core (JSON-RPC 2.0 over Streamable HTTP, stateless).
// Spec: https://modelcontextprotocol.io/specification/2025-06-18
//
// handleJsonRpc(message, ctx) -> response object | null (null for notifications)

import { listToolsPayload, toolIndex } from "./tools.js";

export const SERVER_INFO = { name: "ssa-upload-mcp", version: "1.0.0" };
export const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const JSONRPC = "2.0";
const E = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

function ok(id, result) {
  return { jsonrpc: JSONRPC, id, result };
}
function err(id, code, message, data) {
  const e = { code, message };
  if (data !== undefined) e.data = data;
  return { jsonrpc: JSONRPC, id: id ?? null, error: e };
}

function validateArgs(schema, args) {
  // Light validation: required keys + basic types. Enough to give the model useful errors.
  const a = args ?? {};
  if (typeof a !== "object" || Array.isArray(a)) return "arguments must be an object";
  for (const k of schema.required || []) {
    if (a[k] === undefined || a[k] === null || a[k] === "") return `missing required argument: ${k}`;
  }
  for (const [k, v] of Object.entries(a)) {
    const prop = schema.properties?.[k];
    if (!prop) {
      if (schema.additionalProperties === false) return `unknown argument: ${k}`;
      continue;
    }
    if (prop.type === "string" && typeof v !== "string") return `argument ${k} must be a string`;
    if (prop.type === "integer" && !Number.isInteger(v)) return `argument ${k} must be an integer`;
    if (prop.type === "number" && typeof v !== "number") return `argument ${k} must be a number`;
    if (prop.type === "boolean" && typeof v !== "boolean") return `argument ${k} must be true/false`;
    if (prop.type === "array" && !Array.isArray(v)) return `argument ${k} must be an array`;
    if (prop.enum && !prop.enum.includes(v)) return `argument ${k} must be one of ${prop.enum.join(", ")}`;
  }
  return null;
}

export async function handleJsonRpc(msg, ctx) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return err(null, E.INVALID_REQUEST, "Invalid request");
  if (msg.jsonrpc !== JSONRPC) return err(msg.id, E.INVALID_REQUEST, "jsonrpc must be '2.0'");
  const { id, method, params } = msg;
  const isNotification = id === undefined;

  try {
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
        return ok(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "SSA upload connector for Legend Roofs (classic SSA at crm.ssacapp.com). Use ssa_upload_file to put an original file (PDF, photo, invoice) into a folder on a job, " +
            "from a direct https file link or base64 bytes. Find client_id and job_id with the SSA connector's search tool first. " +
            "Never upload into client/ folders unless Jon says the customer should see the file. This connector cannot delete anything.",
        });
      }
      case "ping":
        return ok(id, {});
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/progress":
      case "notifications/roots/list_changed":
        return null;
      case "tools/list":
        return ok(id, { tools: listToolsPayload() });
      case "tools/call": {
        const name = params?.name;
        const tool = toolIndex[name];
        if (!tool) return err(id, E.INVALID_PARAMS, `Unknown tool: ${name}`);
        const problem = validateArgs(tool.inputSchema, params?.arguments);
        if (problem) {
          return ok(id, { content: [{ type: "text", text: `Invalid arguments: ${problem}` }], isError: true });
        }
        try {
          const result = await tool.handler(ctx.ssa, params?.arguments ?? {}, ctx.deps);
          return ok(id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          });
        } catch (e) {
          const text = e?.name === "SsaError" ? e.message : `Tool error: ${e?.message || String(e)}`;
          return ok(id, { content: [{ type: "text", text }], isError: true });
        }
      }
      case "resources/list":
        return ok(id, { resources: [] });
      case "resources/templates/list":
        return ok(id, { resourceTemplates: [] });
      case "prompts/list":
        return ok(id, { prompts: [] });
      default:
        if (isNotification) return null;
        return err(id, E.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch (e) {
    if (isNotification) return null;
    return err(id, E.INTERNAL, e?.message || "Internal error");
  }
}

// Handle a single message or a batch; returns the response payload (or null if nothing to send).
export async function handleBody(body, ctx) {
  if (Array.isArray(body)) {
    if (body.length === 0) return err(null, E.INVALID_REQUEST, "Empty batch");
    const results = (await Promise.all(body.map((m) => handleJsonRpc(m, ctx)))).filter(Boolean);
    return results.length ? results : null;
  }
  return handleJsonRpc(body, ctx);
}

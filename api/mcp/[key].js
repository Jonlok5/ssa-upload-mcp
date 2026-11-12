// Vercel serverless function: POST https://<your-app>.vercel.app/api/mcp/<MCP_SECRET>
//
// Environment variables (Vercel → Project → Settings → Environment Variables):
//   SSA_USERNAME  – the SSA (crm.ssacapp.com) login name
//   SSA_PASSWORD  – the SSA password
//   MCP_SECRET    – long random string; becomes the last path segment of the connector URL

import { timingSafeEqual } from "node:crypto";
import { createClient } from "../../lib/ssa.js";
import { handleBody } from "../../lib/mcp.js";

export const config = { maxDuration: 60 };

function keyMatches(given) {
  const expected = process.env.MCP_SECRET || "";
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(payload === undefined ? "" : JSON.stringify(payload));
}

async function readJson(req) {
  if (req.body !== undefined && req.body !== null && req.body !== "") {
    if (typeof req.body === "string") return JSON.parse(req.body);
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8"));
    return req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : null;
}

export default async function handler(req, res) {
  const key = req.query?.key;

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version");
    return res.end();
  }

  if (!keyMatches(key)) return send(res, 404, { error: "not found" });

  if (req.method === "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST, DELETE, OPTIONS");
    return res.end();
  }
  if (req.method === "DELETE") {
    res.statusCode = 200;
    return res.end();
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST, DELETE, OPTIONS");
    return res.end();
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  if (!body) return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Empty body" } });

  const ctx = {
    ssa: createClient({ username: process.env.SSA_USERNAME, password: process.env.SSA_PASSWORD }),
    deps: {},
  };
  const result = await handleBody(body, ctx);
  if (result === null) {
    res.statusCode = 202;
    return res.end();
  }
  return send(res, 200, result);
}

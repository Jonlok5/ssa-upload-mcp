// SSA upload connector, desktop edition: a stdio MCP server that runs on Jon's office computer
// inside the Claude desktop app, so SSA sees requests from the office connection it already accepts.
//
// Environment (filled in by the extension's install screen, see manifest.json):
//   SSA_USERNAME, SSA_PASSWORD

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { createClient, SsaError } from "../lib/ssa.js";
import { handleBody } from "../lib/mcp.js";

const MAX_BYTES = 20 * 1024 * 1024;

async function readLocalFile(p) {
  const full = path.resolve(String(p).replace(/^~(?=$|[\\/])/, process.env.USERPROFILE || process.env.HOME || "~"));
  let info;
  try {
    info = await stat(full);
  } catch {
    throw new SsaError(`No file at ${full}.`);
  }
  if (!info.isFile()) throw new SsaError(`${full} is not a file.`);
  if (info.size > MAX_BYTES) throw new SsaError("File is larger than 20 MB.");
  return new Uint8Array(await readFile(full));
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  // A fresh SSA session per request keeps things simple and avoids stale logins.
  const ctx = {
    ssa: createClient({ username: process.env.SSA_USERNAME, password: process.env.SSA_PASSWORD }),
    deps: { readLocalFile },
  };
  try {
    const out = await handleBody(msg, ctx);
    if (out !== null) send(out);
  } catch (e) {
    send({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32603, message: e?.message || "Internal error" } });
  }
});

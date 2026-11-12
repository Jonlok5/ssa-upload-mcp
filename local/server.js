// SSA upload connector, desktop edition: a stdio MCP server that runs on Jon's office computer
// inside the Claude desktop app, so SSA sees requests from the office connection it already accepts.
//
// Environment (filled in by the extension's install screen, see manifest.json):
//   SSA_USERNAME, SSA_PASSWORD

import { readFile, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { createClient, SsaError } from "../lib/ssa.js";
import { handleBody } from "../lib/mcp.js";

const MAX_BYTES = 20 * 1024 * 1024;

// Only files inside the user's Downloads folder may be uploaded. Anything else is refused,
// so a tricked request can't pull private files from elsewhere on this computer.
const HOME = process.env.USERPROFILE || process.env.HOME || "";
const ALLOWED_ROOT = path.join(HOME, "Downloads");

function inside(child, parent) {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function readLocalFile(p) {
  if (!HOME) throw new SsaError("Can't find the home folder on this computer.");
  const given = String(p).replace(/^~(?=$|[\\/])/, HOME);
  const full = path.resolve(path.isAbsolute(given) ? given : path.join(ALLOWED_ROOT, given));
  let real, root;
  try {
    root = await realpath(ALLOWED_ROOT);
    real = await realpath(full);
  } catch {
    throw new SsaError(`No file at ${full}.`);
  }
  if (!inside(real, root)) {
    throw new SsaError(`Only files in ${ALLOWED_ROOT} can be uploaded. Move the file to Downloads first.`);
  }
  const info = await stat(real);
  if (!info.isFile()) throw new SsaError(`${real} is not a file.`);
  if (info.size > MAX_BYTES) throw new SsaError("File is larger than 20 MB.");
  return new Uint8Array(await readFile(real));
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

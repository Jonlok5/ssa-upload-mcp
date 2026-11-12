// Run: npm test   (node --test, no dependencies)
// Exercises the JSON-RPC layer and the SSA client against a fake SSA site.

import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBody } from "../lib/mcp.js";
import { createClient, parseFolders } from "../lib/ssa.js";

const BASE = "https://crm.ssacapp.com/";
const LOGIN_HTML = `<form action="?" method="post"><input type="hidden" name="action" value="login"><input name="username"><input type="password" name="password"></form>`;
const jobHtml = (files) => `<html><a>Logout</a>
<form action="?" method="post" enctype="multipart/form-data">
<input type="hidden" name="action" value="upload_job_file">
<select name="efolder"><option value=""></option><option value="Eagleview/">Eagleview/</option>
<option value="client/">client/ (accessible by client)</option>
<option value="client/Completion Photos/">&nbsp;- Completion Photos/ (accessible by client)</option>
<option value="crew/">crew/</option><option value="invoices/">invoices/</option>
${files.some((f) => f.folder === "estimates/") ? '<option value="estimates/">estimates/</option>' : ""}
</select><input type="file" name="file_upload"></form>
${files.map((f) => `<a href="/x/${encodeURIComponent(f.name)}">${f.name}</a>`).join("")}</html>`;

function fakeSsa({ password = "pw" } = {}) {
  const state = { files: [], uploads: [], loginAttempts: 0 };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const cookie = init.headers?.Cookie || "";
    const authed = cookie.includes("PHPSESSID=abc") && state.authed;
    if (u.hostname === "docrenderer.example.com") {
      const pdf = new TextEncoder().encode("%PDF-1.4 fake estimate");
      return new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } });
    }
    if (u.hostname === "web.example.com") {
      return new Response("<html>not a pdf</html>", { status: 200, headers: { "content-type": "text/html" } });
    }
    if (init.method === "GET" && u.search === "") {
      return new Response(LOGIN_HTML, { status: 200, headers: { "set-cookie": "PHPSESSID=abc; path=/" } });
    }
    if (init.method === "POST" && typeof init.body === "string") {
      state.loginAttempts++;
      const p = new URLSearchParams(init.body);
      if (p.get("action") === "login" && p.get("password") === password) {
        state.authed = true;
        return new Response("", { status: 302, headers: { location: "?action=dashboard" } });
      }
      return new Response(LOGIN_HTML, { status: 200 });
    }
    if (init.method === "GET" && u.searchParams.get("action") === "dashboard") {
      return new Response(authed ? "<html>Dashboard Logout</html>" : LOGIN_HTML, { status: 200 });
    }
    if (init.method === "GET" && u.searchParams.get("action") === "view_job") {
      if (!authed) return new Response(LOGIN_HTML, { status: 200 });
      return new Response(jobHtml(state.files), { status: 200 });
    }
    if (init.method === "POST" && init.body instanceof FormData) {
      if (!authed) return new Response(LOGIN_HTML, { status: 200 });
      const fd = init.body;
      const file = fd.get("file_upload");
      const folder = fd.get("newfolder") === "e" ? fd.get("efolder") : fd.get("nfolder") + "/";
      state.uploads.push({ client: fd.get("client"), job: fd.get("job"), action: fd.get("action"), newfolder: fd.get("newfolder"), folder, name: file.name, type: file.type, size: file.size });
      state.files.push({ folder, name: file.name });
      return new Response("", { status: 302, headers: { location: `?action=view_job&client=${fd.get("client")}&job=${fd.get("job")}` } });
    }
    return new Response("not found", { status: 404 });
  };
  return { state, fetchImpl };
}

function ctxFor(fake, password = "pw") {
  return { ssa: createClient({ username: "jon", password, fetchImpl: fake.fetchImpl, base: BASE }), deps: { fetchImpl: fake.fetchImpl } };
}

const call = (name, args, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("initialize and tools/list", async () => {
  const fake = fakeSsa();
  const init = await handleBody({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, ctxFor(fake));
  assert.equal(init.result.serverInfo.name, "ssa-upload-mcp");
  const list = await handleBody({ jsonrpc: "2.0", id: 2, method: "tools/list" }, ctxFor(fake));
  assert.deepEqual(list.result.tools.map((t) => t.name), ["ssa_list_job_folders", "ssa_upload_file"]);
});

test("parseFolders marks customer-visible folders", () => {
  const f = parseFolders(jobHtml([]));
  assert.ok(f.find((x) => x.value === "client/Completion Photos/").customer_visible);
  assert.equal(f.find((x) => x.value === "invoices/").customer_visible, false);
});

test("lists folders after logging in", async () => {
  const fake = fakeSsa();
  const r = await handleBody(call("ssa_list_job_folders", { client_id: "54812", job_id: "71740" }), ctxFor(fake));
  assert.ok(!r.result.isError, r.result.content[0].text);
  assert.ok(r.result.structuredContent.folders.some((f) => f.value === "invoices/"));
});

test("uploads a PDF from a URL into a new estimates folder", async () => {
  const fake = fakeSsa();
  const r = await handleBody(
    call("ssa_upload_file", {
      client_id: "54812", job_id: "71740", folder: "estimates", create_folder: true,
      filename: "Oblander 3706 Reid Pryor - Anderson Renovation siding estimate 177.pdf",
      source_url: "https://docrenderer.example.com/v1/public_documents/x.pdf",
    }),
    ctxFor(fake),
  );
  assert.ok(!r.result.isError, r.result.content[0].text);
  const out = r.result.structuredContent;
  assert.equal(out.folder_created, true);
  assert.equal(out.verified_on_job_page, true);
  const up = fake.state.uploads[0];
  assert.equal(up.action, "upload_job_file");
  assert.equal(up.newfolder, "n");
  assert.equal(up.folder, "estimates/");
  assert.equal(up.type, "application/pdf");
});

test("uploads base64 into an existing folder", async () => {
  const fake = fakeSsa();
  const b64 = Buffer.from("%PDF-1.7 receipt").toString("base64");
  const r = await handleBody(call("ssa_upload_file", { client_id: "1", job_id: "2", folder: "invoices/", filename: "x.pdf", content_base64: b64 }), ctxFor(fake));
  assert.ok(!r.result.isError, r.result.content[0].text);
  assert.equal(fake.state.uploads[0].newfolder, "e");
  assert.equal(fake.state.uploads[0].folder, "invoices/");
});

test("refuses customer-visible folders unless allowed", async () => {
  const fake = fakeSsa();
  const b64 = Buffer.from("%PDF-1.7").toString("base64");
  const r = await handleBody(call("ssa_upload_file", { client_id: "1", job_id: "2", folder: "client/", filename: "x.pdf", content_base64: b64 }), ctxFor(fake));
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /visible to the customer/);
  assert.equal(fake.state.uploads.length, 0);
});

test("refuses a missing folder unless create_folder", async () => {
  const fake = fakeSsa();
  const b64 = Buffer.from("%PDF-1.7").toString("base64");
  const r = await handleBody(call("ssa_upload_file", { client_id: "1", job_id: "2", folder: "estimates/", filename: "x.pdf", content_base64: b64 }), ctxFor(fake));
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /does not exist/);
});

test("refuses a web page saved as .pdf", async () => {
  const fake = fakeSsa();
  const r = await handleBody(call("ssa_upload_file", { client_id: "1", job_id: "2", folder: "invoices/", filename: "x.pdf", source_url: "https://web.example.com/page" }), ctxFor(fake));
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /not a PDF/);
});

test("reports a failed login clearly", async () => {
  const fake = fakeSsa({ password: "right" });
  const r = await handleBody(call("ssa_list_job_folders", { client_id: "1", job_id: "2" }), ctxFor(fake, "wrong"));
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /login failed/);
});

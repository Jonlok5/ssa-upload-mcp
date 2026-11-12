import { test } from "node:test";
import assert from "node:assert/strict";
import { parseForms, findForm, fill, pageText } from "../lib/forms.js";
import { handleBody } from "../lib/mcp.js";
import { createClient } from "../lib/ssa.js";

const NEW_CLIENT = `<html><form action="?" method="get"><input name="q"></form>
<form action="?" method="POST"><input type="hidden" name="latitude" value="">
<input type="text" name="name"><input type="text" name="city"><input type="text" name="client_password" value="Xk9pQ2">
<input type="hidden" name="id" value=""><input type="hidden" name="action" value="add_new_client">
<input type="submit" name="clients_submit" value="   Add New Client   "></form></html>`;

const NEW_JOB = `<form action="?" method="POST"><input type="hidden" name="old_job_status" value="">
<select name="job_status"><option value=""></option><option value="Appointment">Appointment</option><option value="Contract" selected>Contract</option></select>
<select name="salesman"><option value=""></option><option value="701">Jon Giuliano</option><option value="1299">Chance Clemens</option></select>
<input type="checkbox" name="email_all" value="email_all"><input type="checkbox" name="add_note" value="add_note"><textarea name="note"></textarea>
<input type="hidden" name="client" value="54812"><input type="hidden" name="action" value="insert_new_job"><input type="submit" name="jobs_submit" value="Add New Job"></form>`;

const NOTE = `<form action="?" method="post" enctype="multipart/form-data"><input type="hidden" name="action" value="insert_job_note">
<input type="hidden" name="client" value="1"><input type="hidden" name="job" value="2"><input type="hidden" name="reply" value="">
<textarea name="note"></textarea><input type="file" name="file_upload"><input type="submit" class="btn" value="   Add Note   " name="action"></form>`;

const BLOCK = new Set(["client_password", "email_all", "id", "client", "action"]);

test("keeps SSA's prefilled values and hidden fields; picks the right form", () => {
  const f = findForm(NEW_CLIENT, "client_password");
  const pairs = fill(f, { name: "Pat Smith", city: "Norman" }, { blocked: BLOCK });
  const m = Object.fromEntries(pairs);
  assert.equal(m.client_password, "Xk9pQ2");
  assert.equal(m.action, "add_new_client");
  assert.equal(m.clients_submit, "   Add New Client   ");
  assert.equal(m.name, "Pat Smith");
});

test("blocks protected fields and unknown fields", () => {
  const f = findForm(NEW_CLIENT, "client_password");
  assert.throws(() => fill(f, { client_password: "x" }, { blocked: BLOCK }), /can't be set/);
  assert.throws(() => fill(f, { nickname: "x" }, { blocked: BLOCK }), /Unknown field/);
});

test("dropdowns take the visible text, checkboxes stay off unless asked, email_all can't be set", () => {
  const f = findForm(NEW_JOB, "job_status");
  const m = Object.fromEntries(fill(f, { job_status: "appointment", salesman: "Chance Clemens", add_note: true, note: "hi" }, { blocked: BLOCK }));
  assert.equal(m.job_status, "Appointment");
  assert.equal(m.salesman, "1299");
  assert.equal(m.add_note, "add_note");
  assert.ok(!("email_all" in m));
  assert.throws(() => fill(f, { email_all: true }, { blocked: BLOCK }), /can't be set/);
  assert.throws(() => fill(f, { salesman: "Nobody" }, { blocked: BLOCK }), /not a choice/);
  assert.equal(Object.fromEntries(fill(f, {}, { blocked: BLOCK })).job_status, "Contract");
});

test("note form sends both action values in browser order", () => {
  const f = findForm(NOTE, "reply");
  const pairs = fill(f, { note: "Called homeowner" }, { blocked: BLOCK });
  assert.deepEqual(pairs.filter(([k]) => k === "action").map(([, v]) => v), ["insert_job_note", "   Add Note   "]);
});

test("pageText strips markup", () => {
  assert.match(pageText("<script>x</script><table><tr><td>Status</td><td>Contract</td></tr></table>"), /Status \| Contract/);
});

test("write tools refuse without confirmed=true, and submit after it", async () => {
  let posted = null;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (init.method === "GET" && !u.search) return new Response("<form><input type='hidden' name='action' value='login'><input name='password'></form>", { headers: { "set-cookie": "PHPSESSID=a" } });
    if (init.method === "POST" && typeof init.body === "string" && init.body.includes("action=login")) return new Response("ok Logout");
    if (u.searchParams.get("action") === "add_job_note") return new Response(NOTE);
    if (init.method === "POST") { posted = init.body; return new Response("<p>Note added</p>", { status: 302, headers: { location: "?action=view_job&client=1&job=2" } }); }
    if (u.searchParams.get("action") === "view_job") return new Response("<p>Note added</p>");
    return new Response("?", { status: 404 });
  };
  const ctx = { ssa: createClient({ username: "u", password: "p", fetchImpl, base: "https://crm.ssacapp.com/" }), deps: {} };
  const call = (args) => handleBody({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ssa_add_job_note", arguments: args } }, ctx);
  const no = await call({ client_id: "1", job_id: "2", note: "x", confirmed: false });
  assert.equal(no.result.isError, true);
  assert.equal(posted, null);
  const yes = await call({ client_id: "1", job_id: "2", note: "Called homeowner", confirmed: true });
  assert.ok(!yes.result.isError, yes.result.content[0].text);
  assert.equal(posted.get("note"), "Called homeowner");
  assert.equal(yes.result.structuredContent.job_id, "2");
});

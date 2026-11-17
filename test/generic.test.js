// Generic "anything in SSA" tools against a fake SSA site.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBody } from "../lib/mcp.js";
import { createClient } from "../lib/ssa.js";

const BASE = "https://crm.ssacapp.com/";
const LOGIN_HTML = `<form action="?" method="post"><input type="hidden" name="action" value="login"><input name="username"><input type="password" name="password"></form>`;
const ACCOUNTING = `<html><h1>Job Accounting</h1><table><tr><td>Lowe's</td><td>$120.00</td></tr></table>
<a href="?action=view_job&client=1&job=2">Back to job</a>
<a href="?action=delete_expense&client=1&job=2&expense=9">Delete</a>
<form action="?" method="post" enctype="multipart/form-data">
<input type="hidden" name="action" value="insert_job_expense"><input type="hidden" name="client" value="1"><input type="hidden" name="job" value="2">
<input name="name"><input name="date" value="11/16/2026"><input name="amount"><input name="sales_tax">
<select name="type"><option value="">--</option><option value="Materials">Materials</option><option value="Labor">Labor</option></select>
<textarea name="note"></textarea><input type="file" name="image"><input type="submit" value="Add Expense"></form>
<form action="?" method="post"><input type="hidden" name="action" value="insert_job_payment"><input name="amount"><input type="checkbox" name="email_receipt" value="1"><input type="submit" value="Add Payment"></form></html>`;

function fake() {
  const state = { posts: [], gets: [], s3Cookie: null };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const cookie = init.headers?.Cookie || "";
    if (u.host === "ssacapp-east.s3.amazonaws.com") {
      state.s3Cookie = cookie || null;
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { "content-type": "image/png" } });
    }
    const authed = cookie.includes("PHPSESSID=abc") && state.authed;
    if (init.method === "GET" && u.search === "") return new Response(LOGIN_HTML, { status: 200, headers: { "set-cookie": "PHPSESSID=abc; path=/" } });
    if (init.method === "POST" && typeof init.body === "string" && new URLSearchParams(init.body).get("action") === "login") {
      state.authed = true;
      return new Response("", { status: 302, headers: { location: "?action=dashboard" } });
    }
    if (!authed) return new Response(LOGIN_HTML, { status: 200 });
    const act = u.searchParams.get("action");
    if (init.method === "GET") {
      state.gets.push(u.search);
      if (act === "dashboard") return new Response("<html>Dashboard</html>");
      if (act === "job_accounting") return new Response(ACCOUNTING);
      if (act === "get_file") return new Response("", { status: 302, headers: { location: "https://ssacapp-east.s3.amazonaws.com/44/1/2/invoices/r.png?sig=x" } });
      if (act === "complete_task") return new Response("<html>Task updated</html>");
      if (act === "delete_expense") return new Response("<html>Expense deleted</html>");
      return new Response("<html>ok</html>");
    }
    const fd = init.body;
    const entries = fd instanceof FormData ? [...fd.entries()] : [...new URLSearchParams(fd).entries()];
    state.posts.push(Object.fromEntries(entries.map(([k, v]) => [k, typeof v === "string" ? v : { name: v.name, type: v.type, size: v.size }])));
    return new Response("", { status: 302, headers: { location: "?action=job_accounting&client=1&job=2" } });
  };
  return { state, fetchImpl };
}
const ctx = (f) => ({ ssa: createClient({ username: "jon", password: "pw", fetchImpl: f.fetchImpl, base: BASE }), deps: { fetchImpl: f.fetchImpl } });
const call = (name, args) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

test("reads any page with its forms and links", async () => {
  const f = fake();
  const r = await handleBody(call("ssa_read_page", { page: "action=job_accounting&client=1&job=2" }), ctx(f));
  assert.ok(!r.result.isError, r.result.content[0].text);
  const out = r.result.structuredContent;
  assert.match(out.text, /Lowe's/);
  assert.equal(out.forms[0].action_value, "insert_job_expense");
  assert.ok(out.forms[0].takes_files);
  assert.ok(out.forms[0].fields.find((x) => x.name === "type").choices.includes("Materials"));
  assert.ok(out.links.some((l) => l.query.startsWith("action=delete_expense")));
});

test("refuses to open an action link as a read", async () => {
  const f = fake();
  const r = await handleBody(call("ssa_read_page", { page: "action=delete_expense&client=1&job=2&expense=9" }), ctx(f));
  assert.equal(r.result.isError, true);
  assert.ok(!f.state.gets.some((g) => g.includes("delete_expense")));
});

test("adds a Job Accounting expense with the receipt image attached", async () => {
  const f = fake();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const r = await handleBody(
    call("ssa_submit_form", {
      page: "action=job_accounting&client=1&job=2",
      form: "insert_job_expense",
      fields: { name: "ABC Supply 5512", amount: "1834.22", type: "Materials" },
      files: [{ field: "image", filename: "ABC 5512.png", content_base64: png }],
      confirmed: true,
    }),
    ctx(f),
  );
  assert.ok(!r.result.isError, r.result.content[0].text);
  const p = f.state.posts[0];
  assert.equal(p.action, "insert_job_expense");
  assert.equal(p.client, "1");
  assert.equal(p.date, "11/16/2026"); // SSA's prefilled value kept
  assert.equal(p.type, "Materials");
  assert.equal(p.image.name, "ABC 5512.png");
  assert.equal(p.image.type, "image/png");
});

test("needs send_approved when a form would email someone", async () => {
  const f = fake();
  const args = { page: "action=job_accounting&client=1&job=2", form: "insert_job_payment", fields: { amount: "500", email_receipt: true }, confirmed: true };
  const r = await handleBody(call("ssa_submit_form", args), ctx(f));
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /send_approved/);
  assert.equal(f.state.posts.length, 0);
  const r2 = await handleBody(call("ssa_submit_form", { ...args, send_approved: true }), ctx(f));
  assert.ok(!r2.result.isError, r2.result.content[0].text);
});

test("follow_link: plain actions go; deletes need delete_approved", async () => {
  const f = fake();
  const ok = await handleBody(call("ssa_follow_link", { page: "action=complete_task&task=5", confirmed: true }), ctx(f));
  assert.ok(!ok.result.isError, ok.result.content[0].text);
  const no = await handleBody(call("ssa_follow_link", { page: "action=delete_expense&client=1&job=2&expense=9", confirmed: true }), ctx(f));
  assert.equal(no.result.isError, true);
  assert.match(no.result.content[0].text, /delete_approved/);
  assert.ok(!f.state.gets.some((g) => g.includes("delete_expense")));
  const yes = await handleBody(call("ssa_follow_link", { page: "https://crm.ssacapp.com/?action=delete_expense&client=1&job=2&expense=9", confirmed: true, delete_approved: true }), ctx(f));
  assert.ok(!yes.result.isError);
});

test("refuses login and logout pages", async () => {
  const f = fake();
  const r = await handleBody(call("ssa_follow_link", { page: "action=logout", confirmed: true }), ctx(f));
  assert.equal(r.result.isError, true);
});

test("get_file returns the image and never sends the SSA cookie to S3", async () => {
  const f = fake();
  const r = await handleBody(call("ssa_get_file", { client_id: "1", job_id: "2", file: "invoices/r.png" }), ctx(f));
  assert.ok(!r.result.isError, JSON.stringify(r.result.content));
  assert.equal(r.result.content[0].type, "image");
  assert.equal(r.result.content[0].mimeType, "image/png");
  assert.equal(f.state.s3Cookie, null);
});

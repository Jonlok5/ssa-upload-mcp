// Minimal client for the classic SSA CRM (https://crm.ssacapp.com).
// SSA has no API, so this does what the web page does: log in with a form post,
// keep the PHPSESSID cookie, read the job page, and post the job's "New File" form.
//
// createClient({ username, password, fetchImpl, base })

export class SsaError extends Error {
  constructor(message) {
    super(message);
    this.name = "SsaError";
  }
}

const DEFAULT_BASE = "https://crm.ssacapp.com/";
const UA = "Mozilla/5.0 (Legend Roofs SSA upload connector)";

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

// Read the folder choices out of the job page's upload form (<select name="efolder">).
export function parseFolders(html) {
  const sel = /<select[^>]*name=["']?efolder["']?[^>]*>([\s\S]*?)<\/select>/i.exec(html);
  if (!sel) return null;
  const out = [];
  const re = /<option[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = re.exec(sel[1]))) {
    const value = decodeEntities(m[1]).trim();
    if (!value) continue;
    const label = decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim();
    out.push({ value, customer_visible: /accessible by client/i.test(label) || value.toLowerCase().startsWith("client/") });
  }
  return out;
}

export function looksLikeLoginPage(html) {
  return /name=["']?password["']?/i.test(html) && /value=["']login["']/i.test(html);
}

function normFolder(f) {
  let s = String(f || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (s && !s.endsWith("/")) s += "/";
  return s;
}

export function createClient({ username, password, fetchImpl = fetch, base = DEFAULT_BASE } = {}) {
  let cookies = {};
  let loggedIn = false;

  function cookieHeader() {
    return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  }
  function keepCookies(res) {
    const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    const single = list.length ? list : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
    for (const c of single) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  }
  async function req(url, init = {}) {
    const headers = { "User-Agent": UA, ...(init.headers || {}) };
    const ch = cookieHeader();
    if (ch) headers.Cookie = ch;
    let res = await fetchImpl(url, { ...init, headers, redirect: "manual" });
    keepCookies(res);
    // Follow redirects by hand so cookies set along the way are kept.
    let hops = 0;
    while (res.status >= 300 && res.status < 400 && res.headers.get("location") && hops < 5) {
      const next = new URL(res.headers.get("location"), url).toString();
      const h2 = { "User-Agent": UA };
      const c2 = cookieHeader();
      if (c2) h2.Cookie = c2;
      res = await fetchImpl(next, { method: "GET", headers: h2, redirect: "manual" });
      keepCookies(res);
      url = next;
      hops++;
    }
    return res;
  }

  async function login() {
    if (loggedIn) return;
    if (!username || !password) throw new SsaError("SSA_USERNAME / SSA_PASSWORD are not set in Vercel.");
    await req(base, { method: "GET" }); // pick up a session cookie first
    const body = new URLSearchParams({ action: "login", login_action: "", username, password });
    const res = await req(base, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const html = await res.text();
    if (looksLikeLoginPage(html)) throw new SsaError("SSA login failed. Check SSA_USERNAME and SSA_PASSWORD in Vercel.");
    loggedIn = true;
  }

  async function jobPage(clientId, jobId) {
    await login();
    const url = `${base}?action=view_job&client=${encodeURIComponent(clientId)}&job=${encodeURIComponent(jobId)}`;
    const res = await req(url, { method: "GET" });
    const html = await res.text();
    if (looksLikeLoginPage(html)) throw new SsaError("SSA sent the login page; the session was not accepted.");
    const folders = parseFolders(html);
    if (!folders) throw new SsaError(`Could not find the upload form on job ${jobId} (client ${clientId}). Check the IDs.`);
    return { html, folders };
  }

  async function listFolders(clientId, jobId) {
    const { folders } = await jobPage(clientId, jobId);
    return folders;
  }

  async function uploadFile({ clientId, jobId, folder, createFolder = false, allowCustomerVisible = false, filename, bytes, contentType }) {
    const want = normFolder(folder);
    if (!want) throw new SsaError("folder is required, e.g. 'estimates/' or 'invoices/'.");
    const { folders } = await jobPage(clientId, jobId);
    const existing = folders.find((f) => f.value.toLowerCase() === want.toLowerCase());
    const visible = existing ? existing.customer_visible : want.toLowerCase().startsWith("client/");
    if (visible && !allowCustomerVisible) {
      throw new SsaError(`'${want}' is visible to the customer in their portal. Set allow_customer_visible to true only if Jon said the customer should see this file.`);
    }
    if (!existing && !createFolder) {
      throw new SsaError(`Folder '${want}' does not exist on this job. Existing folders: ${folders.map((f) => f.value).join(", ")}. Set create_folder to true to make it.`);
    }

    const fd = new FormData();
    fd.append("client", String(clientId));
    fd.append("job", String(jobId));
    fd.append("action", "upload_job_file");
    if (existing) {
      fd.append("newfolder", "e");
      fd.append("efolder", existing.value);
      fd.append("nfolder", "");
    } else {
      fd.append("newfolder", "n");
      fd.append("efolder", "");
      fd.append("nfolder", want.replace(/\/$/, ""));
    }
    fd.append("file_upload", new Blob([bytes], { type: contentType || "application/octet-stream" }), filename);

    const res = await req(base, { method: "POST", body: fd });
    if (res.status >= 400) throw new SsaError(`SSA answered ${res.status} to the upload.`);
    await res.text();

    // Verify: the file name should now be listed on the job page.
    const after = await jobPage(clientId, jobId);
    const listed = after.html.includes(filename) || after.html.includes(encodeURIComponent(filename)) || after.html.includes(filename.replace(/ /g, "+"));
    return {
      uploaded: true,
      verified_on_job_page: listed,
      client_id: String(clientId),
      job_id: String(jobId),
      folder: existing ? existing.value : want,
      folder_created: !existing,
      customer_visible: visible,
      filename,
      bytes: bytes.byteLength,
      content_type: contentType || "application/octet-stream",
    };
  }

  return { login, listFolders, uploadFile };
}

const MAX_BYTES = 20 * 1024 * 1024;

// Get the file bytes from a URL (server-side, so no browser CORS or file-picker limits).
export async function fetchSource(url, fetchImpl = fetch) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new SsaError("source_url is not a valid URL.");
  }
  if (u.protocol !== "https:") throw new SsaError("source_url must be https.");
  const res = await fetchImpl(u.toString(), { method: "GET", redirect: "follow", headers: { "User-Agent": UA } });
  if (!res.ok) throw new SsaError(`Could not download source_url (HTTP ${res.status}).`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_BYTES) throw new SsaError("File is larger than 20 MB.");
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new SsaError("File is larger than 20 MB.");
  if (buf.byteLength === 0) throw new SsaError("source_url returned an empty file.");
  const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
  return { bytes: buf, contentType: ct || undefined };
}

export function guessType(filename, fallback) {
  const ext = String(filename).toLowerCase().split(".").pop();
  const map = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", gif: "image/gif", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", csv: "text/csv", txt: "text/plain" };
  return map[ext] || fallback || "application/octet-stream";
}

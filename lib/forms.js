// Tiny, dependency-free HTML form reader/writer for SSA pages.
// Reads the real form from the page (so SSA's own defaults and hidden values are kept),
// applies only the fields we were asked to change, and builds the request body the browser would send.

export class FormError extends Error {
  constructor(message) {
    super(message);
    this.name = "SsaError"; // surfaced to the model as a plain message
  }
}

export function decode(s) {
  return String(s ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attrs(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const inner = tag.replace(/^<\s*[a-zA-Z]+/, "").replace(/\/?>$/, "");
  let m;
  while ((m = re.exec(inner))) {
    const name = m[1].toLowerCase();
    if (name in out) continue;
    out[name] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

// Returns [{ action, method, enctype, fields: [...], submits: [...] }]
export function parseForms(html) {
  const forms = [];
  const formRe = /<form\b[^>]*>([\s\S]*?)<\/form>/gi;
  let fm;
  while ((fm = formRe.exec(html))) {
    const open = fm[0].match(/^<form\b[^>]*>/i)[0];
    const fa = attrs(open);
    const body = fm[1];
    const fields = [];
    const submits = [];
    const tagRe = /<(input|button)\b[^>]*>|<select\b[^>]*>[\s\S]*?<\/select>|<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi;
    let tm;
    while ((tm = tagRe.exec(body))) {
      const t = tm[0];
      const kind = t.slice(1).match(/^[a-zA-Z]+/)[0].toLowerCase();
      if (kind === "select") {
        const a = attrs(t.match(/^<select\b[^>]*>/i)[0]);
        if (!a.name) continue;
        const options = [];
        const oRe = /<option\b([^>]*)>([\s\S]*?)(?=<option\b|<\/select>|<\/option>)/gi;
        let om;
        while ((om = oRe.exec(t))) {
          const oa = attrs("<option " + om[1] + ">");
          const text = decode(om[2].replace(/<[^>]+>/g, "")).trim();
          options.push({ value: decode(oa.value ?? text), text, selected: "selected" in oa });
        }
        fields.push({ name: decode(a.name), type: "select", options, value: (options.find((o) => o.selected) || options[0] || { value: "" }).value });
      } else if (kind === "textarea") {
        const a = attrs(t.match(/^<textarea\b[^>]*>/i)[0]);
        if (!a.name) continue;
        const text = t.replace(/^<textarea\b[^>]*>/i, "").replace(/<\/textarea>$/i, "");
        fields.push({ name: decode(a.name), type: "textarea", value: decode(text) });
      } else {
        const a = attrs(t);
        const type = (a.type || (kind === "button" ? "submit" : "text")).toLowerCase();
        if (type === "submit" || type === "image") {
          submits.push({ name: a.name ? decode(a.name) : "", value: decode(a.value ?? "") });
          continue;
        }
        if (kind === "button" || !a.name || type === "reset" || type === "button") continue;
        fields.push({ name: decode(a.name), type, value: decode(a.value ?? (type === "checkbox" || type === "radio" ? "on" : "")), checked: "checked" in a });
      }
    }
    forms.push({ action: decode(fa.action ?? ""), method: (fa.method || "get").toUpperCase(), enctype: (fa.enctype || "application/x-www-form-urlencoded").toLowerCase(), fields, submits });
  }
  return forms;
}

export function findForm(html, hasField) {
  const forms = parseForms(html);
  return forms.find((f) => f.fields.some((x) => x.name === hasField)) || null;
}

// Describe the editable fields of a form (for error messages and tool output).
export function describe(form, blocked = new Set()) {
  return form.fields
    .filter((f) => f.type !== "hidden" && f.type !== "file" && !blocked.has(f.name))
    .filter((f, i, arr) => arr.findIndex((g) => g.name === f.name) === i)
    .map((f) => (f.type === "select" ? `${f.name} (one of: ${f.options.map((o) => o.text || o.value).filter(Boolean).join(", ")})` : f.type === "checkbox" ? `${f.name} (true/false)` : f.name));
}

// Build the request body. `changes` maps field name -> value (string, number or boolean).
export function fill(form, changes = {}, { blocked = new Set(), submitIndex = 0 } = {}) {
  const names = new Set(form.fields.map((f) => f.name));
  for (const k of Object.keys(changes)) {
    if (blocked.has(k)) throw new FormError(`The field '${k}' can't be set by this tool.`);
    if (!names.has(k)) throw new FormError(`Unknown field '${k}'. Fields on this form: ${describe(form, blocked).join("; ")}`);
  }
  const pairs = [];
  for (const f of form.fields) {
    if (f.type === "file") continue;
    const has = Object.prototype.hasOwnProperty.call(changes, f.name);
    const want = changes[f.name];
    if (f.type === "checkbox" || f.type === "radio") {
      let on = f.checked;
      if (has) {
        if (f.type === "checkbox") on = want === true || want === "true" || want === "on" || want === f.value;
        else on = String(want) === f.value;
      }
      if (on) pairs.push([f.name, f.value]);
      continue;
    }
    if (f.type === "select" && has) {
      const w = String(want).trim().toLowerCase();
      const opt = f.options.find((o) => o.value.toLowerCase() === w) || f.options.find((o) => o.text.toLowerCase() === w);
      if (!opt) throw new FormError(`'${want}' is not a choice for ${f.name}. Choices: ${f.options.map((o) => o.text || o.value).filter(Boolean).join(", ")}`);
      pairs.push([f.name, opt.value]);
      continue;
    }
    pairs.push([f.name, has ? String(want ?? "") : f.value]);
  }
  const sub = form.submits[submitIndex];
  if (sub && sub.name) pairs.push([sub.name, sub.value]);
  return pairs;
}

export function encodeBody(form, pairs) {
  if (form.enctype.includes("multipart")) {
    const fd = new FormData();
    for (const [k, v] of pairs) fd.append(k, v);
    return { body: fd, headers: {} };
  }
  const p = new URLSearchParams();
  for (const [k, v] of pairs) p.append(k, v);
  return { body: p.toString(), headers: { "Content-Type": "application/x-www-form-urlencoded" } };
}

// Readable text of a page for the model: drops scripts, menus' markup and form controls' clutter.
export function pageText(html, max = 20000) {
  let s = String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<select\b[\s\S]*?<\/select>/gi, " ")
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, (f) => (/upload_job_file|insert_job_note|chat/i.test(f) ? " " : f))
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d|\/table)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ");
  s = decode(s)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").replace(/(\s*\|\s*)+$/g, "").trim())
    .filter(Boolean)
    .join("\n");
  return s.length > max ? s.slice(0, max) + "\n…(cut)" : s;
}

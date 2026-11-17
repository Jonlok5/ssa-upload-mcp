// MCP tools for uploading files into the classic SSA CRM.

import { SsaError, fetchSource, guessType, pageText } from "./ssa.js";
import { pickForm, formActionValue } from "./forms.js";

const CLIENT = { type: "string", description: "SSA client (customer) id, e.g. '54812'. The SSA connector's search tool returns it as customer_id." };
const JOB = { type: "string", description: "SSA job id, e.g. '71740'. The SSA connector's search tool returns it as job_id." };

function cleanName(name) {
  const n = String(name || "").trim().replace(/[\\/:*?"<>|]+/g, "-");
  if (!n) throw new SsaError("filename is required, with its extension, e.g. 'Smith 123 Main - ABC invoice 5512.pdf'.");
  if (!/\.[a-z0-9]{2,5}$/i.test(n)) throw new SsaError("filename needs an extension such as .pdf or .jpg.");
  return n;
}

const CONFIRMED = { type: "boolean", description: "Must be true. True means Jon asked for this change or approved it: his request in chat is the approval, so don't ask him again for a save he asked for. Ask first only when you would be guessing values he didn't give." };

// Fields this connector never touches: IDs, SSA's own bookkeeping, the customer's portal password,
// map coordinates, and the 'email everyone' switch.
const BLOCKED = new Set([
  "client_password", "email_all", "id", "client", "job", "action", "old_email", "old_job_status",
  "permit_needed_old", "job_total_old", "latitude", "longitude", "from", "trade", "invoice", "type", "reply", "filename", "mortgage",
]);

const FORMS = {
  new_client: { query: () => "action=new_client", hasField: "client_password" },
  edit_client: { query: (a) => `action=edit_client&client=${encodeURIComponent(need(a.client_id, "client_id"))}`, hasField: "client_password" },
  new_job: { query: (a) => `action=new_job&client=${encodeURIComponent(need(a.client_id, "client_id"))}`, hasField: "job_status" },
  edit_job: { query: (a) => `action=edit_job&client=${encodeURIComponent(need(a.client_id, "client_id"))}&job=${encodeURIComponent(need(a.job_id, "job_id"))}`, hasField: "job_status" },
  new_lead: { query: () => "action=new_lead", hasField: "lead_status" },
};

function need(v, name) {
  if (!v) throw new SsaError(`${name} is required for that form.`);
  return v;
}

function needYes(a) {
  if (a.confirmed !== true) throw new SsaError("Not saved. Call again with confirmed=true once Jon has asked for or approved this change.");
}

function writeTool(name, description, formKey, needsClient, needsJob) {
  const properties = {
    fields: { type: "object", description: "Field name -> new value. Dropdowns accept the choice's text or value; checkboxes take true/false. Use ssa_form_fields to see the fields and choices." },
    confirmed: CONFIRMED,
  };
  const required = ["fields", "confirmed"];
  if (needsClient) { properties.client_id = CLIENT; required.unshift("client_id"); }
  if (needsJob) { properties.job_id = JOB; required.unshift("job_id"); }
  return {
    name,
    description: description + " Pass confirmed=true when Jon asked for or approved the change. This tool cannot delete anything.",
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    handler: async (ssa, a) => {
      needYes(a);
      if (!a.fields || typeof a.fields !== "object" || Array.isArray(a.fields) || !Object.keys(a.fields).length) throw new SsaError("fields must be an object with at least one field.");
      const spec = FORMS[formKey];
      return ssa.submitForm({ query: spec.query(a), hasField: spec.hasField, changes: a.fields, blocked: BLOCKED });
    },
  };
}


// Get file bytes from exactly one of source_path / source_url / content_base64.
async function loadBytes(a, deps = {}) {
  const given = [a.source_url, a.source_path, a.content_base64].filter(Boolean).length;
  if (given === 0) throw new SsaError("Give source_url, source_path or content_base64.");
  if (given > 1) throw new SsaError("Give only one of source_url, source_path or content_base64.");
  if (a.source_path) {
    if (!deps.readLocalFile) throw new SsaError("source_path only works in the desktop extension running on Jon's computer.");
    return { bytes: await deps.readLocalFile(a.source_path) };
  }
  if (a.source_url) {
    const got = await fetchSource(a.source_url, deps.fetchImpl);
    return { bytes: got.bytes, fetchedType: got.contentType };
  }
  const b64 = a.content_base64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (!bytes.byteLength) throw new SsaError("content_base64 decoded to an empty file.");
  return { bytes };
}

// ---- Safety for the generic tools ----
// Jon's standing rules: nothing gets deleted and nothing gets sent to anyone without his specific yes.
const DESTRUCTIVE = /(delet|remov|trash|void|purge|erase|destroy|archiv|merge|cancel|unassign|clear_)/i;
const SENDS = /(e-?mail|send|sms|text_msg|notify|notif|message|invite|portal_link)/i;
const SESSION = /^(login|logout|reset_password|change_password|password)$/i;
const CHANGES = /^(insert|add|update|save|upload|complete|approve|mark|set|change|assign|create|submit|convert|copy|move|sign|pay|refund|import|reopen|close|post|delete|remove|void|merge|archive|cancel|send|email)/i;

function pageQuery(page) {
  let q = String(page || "").trim();
  if (!q) throw new SsaError("page is required, e.g. 'action=job_accounting&client=54622&job=71371'.");
  if (/^https?:/i.test(q)) {
    const u = new URL(q);
    if (u.host !== "crm.ssacapp.com") throw new SsaError("Only crm.ssacapp.com pages.");
    q = u.search.slice(1);
  }
  return q.replace(/^\?/, "");
}
function actionOf(q) {
  return new URLSearchParams(q).get("action") || "";
}
function truthy(v) {
  return v === true || v === "true" || v === "on" || v === 1 || v === "1" || (typeof v === "string" && v.length > 0 && v !== "false" && v !== "0");
}
function guard({ words, changes = {}, a }) {
  const text = words.filter(Boolean).join(" ");
  if (words.some((w) => SESSION.test(String(w || "")))) throw new SsaError("Login, logout and password pages are off limits (they would break the session).");
  if (DESTRUCTIVE.test(text) && a.delete_approved !== true) {
    throw new SsaError("This deletes, voids or removes something in SSA. Tell Jon exactly what will be removed and that it may not come back; only after his yes to that specific item, call again with delete_approved=true.");
  }
  const sendsByField = Object.entries(changes).some(([k, v]) => SENDS.test(k) && truthy(v) && !/^(email|email2|e_mail|client_email)$/i.test(k));
  if ((SENDS.test(text) || sendsByField) && a.send_approved !== true) {
    throw new SsaError("This sends an email, text or notice to someone. Show Jon who gets it and what it says; only after his yes, call again with send_approved=true.");
  }
}
const PAGE = { type: "string", description: "The SSA page as its query string (or a full crm.ssacapp.com link), e.g. 'action=job_accounting&client=54622&job=71371'. Get pages from links listed by ssa_read_page." };
const DELETE_OK = { type: "boolean", description: "Only true after Jon said yes to deleting/voiding/removing this specific item. Never set it on your own." };
const SEND_OK = { type: "boolean", description: "Only true after Jon said yes to sending this email/text/notice. Never set it on your own." };
const FILE_SOURCE = {
  source_path: { type: "string", description: "A file in the SSA Uploads folder on the office computer (full path or just the name)." },
  source_url: { type: "string", description: "https link that downloads the file itself." },
  content_base64: { type: "string", description: "The file's bytes, base64-encoded." },
};
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp)$/i;

export const tools = [
  {
    name: "ssa_list_job_folders",
    description:
      "List the file folders on one SSA job (from the job page's upload form), and which ones the customer can see in their portal. Use before uploading to pick the right folder.",
    inputSchema: {
      type: "object",
      properties: { client_id: CLIENT, job_id: JOB },
      required: ["client_id", "job_id"],
      additionalProperties: false,
    },
    handler: async (ssa, a) => ({ client_id: a.client_id, job_id: a.job_id, folders: await ssa.listFolders(a.client_id, a.job_id) }),
  },

  {
    name: "ssa_upload_file",
    description:
      "Upload a file into a folder on an SSA job, server-side, exactly as the job page's New File form does. Give the file as source_path (a file in the SSA Uploads folder on this computer; desktop extension only), source_url (an https link to the file itself, e.g. a Joist docrenderer PDF link, an S3 link or a supplier invoice link) or content_base64 (for a file already in hand, such as a downloaded Gmail attachment). " +
      "Folders under client/ are visible to the customer; those need allow_customer_visible=true and should only be used when Jon says the customer should see the file. " +
      "A folder that doesn't exist yet is only created with create_folder=true. The result says whether the file name was found on the job page afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        client_id: CLIENT,
        job_id: JOB,
        folder: { type: "string", description: "Target folder, e.g. 'estimates/', 'invoices/', 'material/', 'crew/'." },
        filename: { type: "string", description: "Name to save it under, with extension, e.g. 'Oblander 3706 Reid Pryor - Anderson Renovation siding estimate 177.pdf'." },
        source_url: { type: "string", description: "https link that downloads the file itself (not a web page about it)." },
        source_path: { type: "string", description: "A file in the SSA Uploads folder on this computer (C:\\Users\\<you>\\SSA Uploads), as a full path or just the file name, e.g. estimate.pdf. Files anywhere else are refused; copy them into SSA Uploads first. Desktop extension only." },
        content_base64: { type: "string", description: "The file's bytes, base64-encoded. Use instead of source_url." },
        content_type: { type: "string", description: "Optional MIME type; guessed from the file name if left out." },
        create_folder: { type: "boolean", description: "Create the folder if the job doesn't have it yet (default false)." },
        allow_customer_visible: { type: "boolean", description: "Required true to upload into client/ or its subfolders (customer can see them). Default false." },
      },
      required: ["client_id", "job_id", "folder", "filename"],
      additionalProperties: false,
    },
    handler: async (ssa, a, deps = {}) => {
      const filename = cleanName(a.filename);
      const given = [a.source_url, a.source_path, a.content_base64].filter(Boolean).length;
      if (given === 0) throw new SsaError("Give source_url, source_path or content_base64.");
      if (given > 1) throw new SsaError("Give only one of source_url, source_path or content_base64.");
      const { bytes, fetchedType } = await loadBytes(a, deps);
      const isPdfBytes = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
      if (/\.pdf$/i.test(filename) && !isPdfBytes) {
        throw new SsaError("The file name ends in .pdf but the downloaded bytes are not a PDF (the link may point to a web page). Use a direct file link.");
      }
      const contentType = a.content_type || (fetchedType && fetchedType !== "application/octet-stream" && fetchedType !== "binary/octet-stream" ? fetchedType : guessType(filename));
      return ssa.uploadFile({
        clientId: a.client_id,
        jobId: a.job_id,
        folder: a.folder,
        createFolder: a.create_folder === true,
        allowCustomerVisible: a.allow_customer_visible === true,
        filename,
        bytes,
        contentType,
      });
    },
  },
  {
    name: "ssa_read_job",
    description:
      "Read one SSA job as plain text: the job page (status, type, salesman, dates, address, notes, trades, files) and, with include_accounting, the Job Accounting page (expenses, payments, totals). Read-only.",
    inputSchema: {
      type: "object",
      properties: { client_id: CLIENT, job_id: JOB, include_accounting: { type: "boolean", description: "Also read the Job Accounting page (default false)." } },
      required: ["client_id", "job_id"],
      additionalProperties: false,
    },
    handler: async (ssa, a) => {
      const q = `client=${encodeURIComponent(a.client_id)}&job=${encodeURIComponent(a.job_id)}`;
      const job = pageText(await ssa.getPage(`action=view_job&${q}`));
      const out = { client_id: a.client_id, job_id: a.job_id, job_page: job };
      if (a.include_accounting) out.accounting_page = pageText(await ssa.getPage(`action=job_accounting&${q}`));
      return out;
    },
  },

  {
    name: "ssa_read_client",
    description: "Read one SSA client (customer) record as plain text: contact details and their jobs. Read-only.",
    inputSchema: { type: "object", properties: { client_id: CLIENT }, required: ["client_id"], additionalProperties: false },
    handler: async (ssa, a) => ({ client_id: a.client_id, client_page: pageText(await ssa.getPage(`action=view_client&client=${encodeURIComponent(a.client_id)}`)) }),
  },

  {
    name: "ssa_form_fields",
    description:
      "List the fields (and the allowed choices for dropdowns) on an SSA form before filling it: new_client, edit_client, new_job, edit_job or new_lead. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        form: { type: "string", enum: ["new_client", "edit_client", "new_job", "edit_job", "new_lead"] },
        client_id: { type: "string", description: "Needed for edit_client, new_job and edit_job." },
        job_id: { type: "string", description: "Needed for edit_job." },
      },
      required: ["form"],
      additionalProperties: false,
    },
    handler: async (ssa, a) => {
      const spec = FORMS[a.form];
      return { form: a.form, fields: await ssa.formFields(spec.query(a), spec.hasField, BLOCKED) };
    },
  },

  {
    name: "ssa_add_job_note",
    description: "Add a note to an SSA job (the job's Add Note form). Pass confirmed=true when Jon asked for the note. Cannot edit or delete notes.",
    inputSchema: {
      type: "object",
      properties: { client_id: CLIENT, job_id: JOB, note: { type: "string", description: "The note text." }, confirmed: CONFIRMED },
      required: ["client_id", "job_id", "note", "confirmed"],
      additionalProperties: false,
    },
    handler: async (ssa, a) => {
      needYes(a);
      return ssa.submitForm({ query: `action=add_job_note&client=${encodeURIComponent(a.client_id)}&job=${encodeURIComponent(a.job_id)}`, hasField: "reply", changes: { note: a.note }, blocked: BLOCKED });
    },
  },

  {
    name: "ssa_read_page",
    description:
      "Open ANY page in SSA (crm.ssacapp.com) and read it: the page text, every form on it (fields, current values, dropdown choices, buttons) and the SSA links on it. " +
      "Use this to reach anything the specific tools don't cover: Job Accounting, tasks, calendar, trades/scheduling, paperwork, reports, leads, lists. Start from a page you know " +
      "(e.g. 'action=view_job&client=ID&job=ID', 'action=job_accounting&client=ID&job=ID', 'action=dashboard', 'action=search&search=NAME') and follow its links. " +
      "Read-only: pages whose action changes something (delete, complete, approve, send...) are refused here; use ssa_follow_link or ssa_submit_form for those.",
    inputSchema: {
      type: "object",
      properties: {
        page: PAGE,
        show: { type: "array", items: { type: "string", enum: ["text", "forms", "links"] }, description: "What to return (default all three)." },
      },
      required: ["page"],
      additionalProperties: false,
    },
    handler: async (ssa, a) => {
      const q = pageQuery(a.page);
      const act = actionOf(q);
      if (SESSION.test(act)) throw new SsaError("Login, logout and password pages are off limits.");
      if (act && (CHANGES.test(act) || DESTRUCTIVE.test(act) || SENDS.test(act)) && !/^(edit_|new_|view_)/i.test(act)) {
        throw new SsaError(`'${act}' looks like it changes something, so it isn't opened by ssa_read_page. Use ssa_follow_link (with confirmed=true) if Jon wants that done.`);
      }
      if (act === "get_file") throw new SsaError("Use ssa_get_file for files.");
      const r = await ssa.readPage(q);
      const show = new Set(a.show && a.show.length ? a.show : ["text", "forms", "links"]);
      const out = { page: q };
      if (show.has("text")) out.text = r.text;
      if (show.has("forms")) out.forms = r.forms;
      if (show.has("links")) out.links = r.links;
      return out;
    },
  },

  {
    name: "ssa_submit_form",
    description:
      "Fill in and submit ANY form on any SSA page, exactly like clicking its button in the browser: Job Accounting expenses and payments (with the receipt image), tasks, trades, " +
      "paperwork, lead and job edits, anything. Read the page with ssa_read_page first to see its forms. Only the fields you give change; SSA's own prefilled and hidden values are kept. " +
      "Attach files to the form's file fields with files[] (receipt photo, PDF). confirmed=true when Jon asked for or approved the change; his request is the approval. " +
      "Deleting/voiding needs delete_approved=true and sending email/texts needs send_approved=true, each only after Jon's specific yes. The customer portal password can't be touched.",
    inputSchema: {
      type: "object",
      properties: {
        page: PAGE,
        form: { type: "string", description: "Which form: its number from ssa_read_page, its action_value (e.g. 'insert_job_expense'), or the name of a field only it has. Optional if the page has one form." },
        fields: { type: "object", description: "Field name -> value. Dropdowns take the choice's text or value; checkboxes true/false. Dates as SSA shows them (MM/DD/YYYY)." },
        files: {
          type: "array",
          description: "Files for the form's file fields.",
          items: {
            type: "object",
            properties: { field: { type: "string", description: "The form's file field name, e.g. 'image' or 'file_upload'." }, filename: { type: "string" }, content_type: { type: "string" }, ...FILE_SOURCE },
            required: ["field", "filename"],
            additionalProperties: false,
          },
        },
        button: { type: "string", description: "Which submit button, by its label, when the form has more than one." },
        confirmed: CONFIRMED,
        delete_approved: DELETE_OK,
        send_approved: SEND_OK,
      },
      required: ["page", "confirmed"],
      additionalProperties: false,
    },
    handler: async (ssa, a, deps = {}) => {
      needYes(a);
      const q = pageQuery(a.page);
      if (SESSION.test(actionOf(q))) throw new SsaError("Login, logout and password pages are off limits.");
      const changes = a.fields && typeof a.fields === "object" && !Array.isArray(a.fields) ? a.fields : {};
      const html = await ssa.getPage(q);
      const form = pickForm(html, a.form);
      const words = [actionOf(q), form ? formActionValue(form) : "", a.button || (form && form.submits[0] ? form.submits[0].value : "")];
      guard({ words, changes, a });
      const files = [];
      for (const f of a.files || []) {
        const name = cleanName(f.filename);
        const { bytes, fetchedType } = await loadBytes(f, deps);
        files.push({ field: f.field, filename: name, bytes, contentType: f.content_type || (fetchedType && !/octet-stream/.test(fetchedType) ? fetchedType : guessType(name)) });
      }
      return ssa.submitAny({ query: q, form: a.form, changes, files, button: a.button, blocked: new Set(["client_password"]) });
    },
  },

  {
    name: "ssa_follow_link",
    description:
      "Open an SSA link that does something when clicked (mark a task done, approve, change a status, delete...). Take the link's query from ssa_read_page's links. " +
      "confirmed=true when Jon asked for it. Links that delete, void or remove need delete_approved=true; links that send email/texts need send_approved=true, each only after Jon's specific yes.",
    inputSchema: {
      type: "object",
      properties: { page: PAGE, confirmed: CONFIRMED, delete_approved: DELETE_OK, send_approved: SEND_OK },
      required: ["page", "confirmed"],
      additionalProperties: false,
    },
    handler: async (ssa, a) => {
      needYes(a);
      const q = pageQuery(a.page);
      guard({ words: [actionOf(q), q], a });
      return ssa.followLink(q);
    },
  },

  {
    name: "ssa_get_file",
    description:
      "Open a file stored on an SSA job (receipt photos, invoices, PDFs) so you can see it. Images come back as images you can read. " +
      "Give the folder and file name as the job page lists them, e.g. 'invoices/ABC 5512.jpg'. With save_to_computer, a copy is saved to the 'SSA Downloads' folder on the office computer.",
    inputSchema: {
      type: "object",
      properties: {
        client_id: CLIENT,
        job_id: JOB,
        file: { type: "string", description: "Folder and file name, e.g. 'invoices/receipt.jpg' or 'client/contract.pdf'." },
        save_to_computer: { type: "boolean", description: "Also save a copy in the office computer's 'SSA Downloads' folder (desktop extension only)." },
      },
      required: ["client_id", "job_id", "file"],
      additionalProperties: false,
    },
    handler: async (ssa, a, deps = {}) => {
      const q = `action=get_file&client=${encodeURIComponent(a.client_id)}&job=${encodeURIComponent(a.job_id)}&filename=${encodeURIComponent(a.file)}`;
      const { bytes, contentType } = await ssa.getFile(q);
      const name = String(a.file).split("/").pop();
      const type = contentType && !/octet-stream/.test(contentType) ? contentType : guessType(name);
      const info = { client_id: a.client_id, job_id: a.job_id, file: a.file, content_type: type, bytes: bytes.byteLength };
      if (a.save_to_computer) {
        if (!deps.writeLocalFile) throw new SsaError("save_to_computer only works in the desktop extension.");
        info.saved_to = await deps.writeLocalFile(name, bytes);
      }
      const b64 = Buffer.from(bytes).toString("base64");
      if (IMAGE_TYPES.test(type)) {
        return { ...info, __content: [{ type: "image", data: b64, mimeType: type }, { type: "text", text: JSON.stringify(info) }] };
      }
      return { ...info, __content: [{ type: "resource", resource: { uri: `ssa://job/${a.job_id}/${encodeURIComponent(a.file)}`, mimeType: type, blob: b64 } }, { type: "text", text: JSON.stringify(info) }] };
    },
  },

  writeTool("ssa_create_client", "Create a new SSA client (customer). Check for duplicates first (SSA connector search by name and street). The customer's portal password is left exactly as SSA fills it. Returns the new client_id when SSA reports it.", "new_client", false, false),
  writeTool("ssa_update_client", "Change fields on an existing SSA client. Only the fields you give are changed; everything else stays as it is in SSA.", "edit_client", true, false),
  writeTool("ssa_create_job", "Add a new job to an existing SSA client. Typical fields: job_status, job_type, job_name, address1, city, state, zip, salesman, inquiry_date, how_was_the_lead_generated, referred_from; add_note=true plus note for a first note.", "new_job", true, false),
  writeTool("ssa_update_job", "Change fields on an existing SSA job (status, type, dates, salesman, address, etc.). Only the fields you give are changed.", "edit_job", true, true),
  writeTool("ssa_create_lead", "Create a new SSA lead (prospect / door knock). Typical fields: lead_status, name, address1, city, state, zip, phone, cell, email, salesman, inquiry_date, how_was_the_lead_generated.", "new_lead", false, false),
];

export const toolIndex = Object.fromEntries(tools.map((t) => [t.name, t]));

export function listToolsPayload() {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

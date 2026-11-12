// MCP tools for uploading files into the classic SSA CRM.

import { SsaError, fetchSource, guessType, pageText } from "./ssa.js";

const CLIENT = { type: "string", description: "SSA client (customer) id, e.g. '54812'. The SSA connector's search tool returns it as customer_id." };
const JOB = { type: "string", description: "SSA job id, e.g. '71740'. The SSA connector's search tool returns it as job_id." };

function cleanName(name) {
  const n = String(name || "").trim().replace(/[\\/:*?"<>|]+/g, "-");
  if (!n) throw new SsaError("filename is required, with its extension, e.g. 'Smith 123 Main - ABC invoice 5512.pdf'.");
  if (!/\.[a-z0-9]{2,5}$/i.test(n)) throw new SsaError("filename needs an extension such as .pdf or .jpg.");
  return n;
}

const CONFIRMED = { type: "boolean", description: "Must be true: set it only after showing Jon exactly what will be saved and getting his yes." };

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
  if (a.confirmed !== true) throw new SsaError("Not saved. Show Jon exactly what will be saved, get his yes, then call again with confirmed=true.");
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
    description: description + " Show Jon the values first; pass confirmed=true only after his yes. This tool cannot delete anything.",
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    handler: async (ssa, a) => {
      needYes(a);
      if (!a.fields || typeof a.fields !== "object" || Array.isArray(a.fields) || !Object.keys(a.fields).length) throw new SsaError("fields must be an object with at least one field.");
      const spec = FORMS[formKey];
      return ssa.submitForm({ query: spec.query(a), hasField: spec.hasField, changes: a.fields, blocked: BLOCKED });
    },
  };
}


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
      let bytes, fetchedType;
      if (a.source_path) {
        if (!deps.readLocalFile) throw new SsaError("source_path only works in the desktop extension running on Jon's computer.");
        bytes = await deps.readLocalFile(a.source_path);
      } else if (a.source_url) {
        const got = await fetchSource(a.source_url, deps.fetchImpl);
        bytes = got.bytes;
        fetchedType = got.contentType;
      } else {
        const b64 = a.content_base64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
        bytes = new Uint8Array(Buffer.from(b64, "base64"));
        if (!bytes.byteLength) throw new SsaError("content_base64 decoded to an empty file.");
      }
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
    description: "Add a note to an SSA job (the job's Add Note form). Show Jon the exact note text first and pass confirmed=true only after he says yes. Cannot edit or delete notes.",
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

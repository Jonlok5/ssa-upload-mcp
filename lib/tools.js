// MCP tools for uploading files into the classic SSA CRM.

import { SsaError, fetchSource, guessType } from "./ssa.js";

const CLIENT = { type: "string", description: "SSA client (customer) id, e.g. '54812'. The SSA connector's search tool returns it as customer_id." };
const JOB = { type: "string", description: "SSA job id, e.g. '71740'. The SSA connector's search tool returns it as job_id." };

function cleanName(name) {
  const n = String(name || "").trim().replace(/[\\/:*?"<>|]+/g, "-");
  if (!n) throw new SsaError("filename is required, with its extension, e.g. 'Smith 123 Main - ABC invoice 5512.pdf'.");
  if (!/\.[a-z0-9]{2,5}$/i.test(n)) throw new SsaError("filename needs an extension such as .pdf or .jpg.");
  return n;
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
];

export const toolIndex = Object.fromEntries(tools.map((t) => [t.name, t]));

export function listToolsPayload() {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

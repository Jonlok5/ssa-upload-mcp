# SSA upload → Claude connector

A tiny MCP server that lets Claude put original files (PDFs, photos, invoices, sub estimates) straight into
a job's folders in the classic SSA CRM at **crm.ssacapp.com**. No browser, no file picker, no screenshots.

- **Zero dependencies.** One Vercel serverless function, plain Node.
- **Your login stays with you.** The SSA username and password live only in Vercel's environment variables.
- **Locked down.** The connector URL contains a long secret; without it the server answers 404.
- **Guard rails.** Deleting, voiding or removing anything needs `delete_approved=true`, and anything that emails or texts someone needs `send_approved=true`; each is set only after Jon's specific yes. Login, logout and password pages are off limits, and the customer portal password is never touched.

## Tools

| Tool | What it does |
|---|---|
| `ssa_read_page` | Opens **any** SSA page by its query string and returns the text, every form (fields, current values, dropdown choices, buttons) and the links. Read-only; action links are refused here. |
| `ssa_submit_form` | Fills in and submits **any** form on any SSA page, with file attachments (e.g. a Job Accounting expense with the receipt image). Only the given fields change; SSA's prefilled and hidden values are kept. |
| `ssa_follow_link` | Opens an SSA link that does something (mark done, approve, change status). |
| `ssa_get_file` | Opens a file stored on a job (receipt photo, PDF); images come back viewable. Optional copy to `SSA Downloads` on the office computer. The SSA session cookie is never sent to S3. |
| `ssa_list_job_folders` | Lists a job's folders and which ones the customer can see. |
| `ssa_upload_file` | Uploads a file to a job folder from a direct https link (`source_url`) or base64 bytes (`content_base64`). Creates the folder only with `create_folder: true`. Refuses `client/` folders unless `allow_customer_visible: true`. Checks the job page afterwards. |

Get `client_id` and `job_id` from the SSA connector's `search` tool (customer_id / job_id).

## Deploy

1. Import this repo at <https://vercel.com/new>. Framework preset: **Other**.
2. Environment variables:

   | Name | Value |
   |---|---|
   | `SSA_USERNAME` | Your crm.ssacapp.com login name |
   | `SSA_PASSWORD` | Your crm.ssacapp.com password |
   | `MCP_SECRET` | A long random string (<https://generate-secret.vercel.app/48>) |

3. Deploy. Connector URL: `https://<your-app>.vercel.app/api/mcp/<MCP_SECRET>`
4. Claude → **Settings → Connectors → Add custom connector**, name `SSA Upload`, paste the URL.

## Rotating / revoking

Change `MCP_SECRET` (or the SSA password) in Vercel and redeploy.

## Tests

`npm test` runs against a fake SSA site; nothing touches the real CRM.

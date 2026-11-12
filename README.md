# SSA upload → Claude connector

A tiny MCP server that lets Claude put original files (PDFs, photos, invoices, sub estimates) straight into
a job's folders in the classic SSA CRM at **crm.ssacapp.com**. No browser, no file picker, no screenshots.

- **Zero dependencies.** One Vercel serverless function, plain Node.
- **Your login stays with you.** The SSA username and password live only in Vercel's environment variables.
- **Locked down.** The connector URL contains a long secret; without it the server answers 404.
- **Can't delete.** It only reads the job page and posts the New File form.

## Tools

| Tool | What it does |
|---|---|
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

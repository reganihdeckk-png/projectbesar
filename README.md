# Premium store

The store loads the Premku catalog, creates QR payments, checks payment status,
submits product orders, and displays returned accounts. Both Node.js and
Cloudflare Worker backends keep Premku credentials on the server.

## Deploy to Cloudflare Workers with GitHub

The Worker backend stores checkout records in Cloudflare D1. The repository
must contain the Worker, Wrangler config, and D1 migration before connecting
it to GitHub.

1. In Cloudflare, create a D1 database named `premium-orders` and copy its
   database ID.
2. Replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc` with that ID,
   then commit and push the change to your GitHub repository.
3. In **Workers & Pages**, choose **Create application → Connect to Git**, then
   authorize GitHub and select the repository.
4. Configure the Git build:
   - Build command: `npm run build:worker`
   - Deploy command: `npm run deploy:remote`
   - Root directory: repository root
5. Add `PREMKU_API_KEY` and `PREMKU_API_SECRET` as Worker secrets in the
   Cloudflare dashboard. Never add credential values to GitHub or source files.
6. Deploy, open the assigned `workers.dev` URL, and verify
   `/api/premium/health` returns `{"ready":true}` before testing the catalog.

The free Workers plan has usage limits. Check Cloudflare's current limits before
using this for real payments. The checkout uses a polling endpoint, so it
generates requests while a payment/order is pending.

The database ID is account-specific. You must create the D1 database in your
Cloudflare account, put its ID in `wrangler.jsonc`, and push that configuration
before the first deploy. Cloudflare/GitHub authentication is completed in your
own dashboard session; never share account passwords or tokens.

### Connect GitHub and deploy from the Cloudflare dashboard

You must sign in and approve GitHub access in your own browser. Do not share
your GitHub password, recovery code, or Cloudflare token in chat. Repository
contents must already be pushed to GitHub before Cloudflare can import them.

## Run locally on Windows

1. Revoke the API key that was previously shared and create a replacement.
2. Install Node.js 18 or newer, or Deno.
3. Double-click `start-store.cmd` and enter both the active **API KEY** and
   **API SECRET** in the hidden prompts. The launcher starts the backend and opens `http://localhost:3000`.
   Do not open `index.html` directly; `file://` pages cannot reach the backend.
   If port 3000 is already in use, close the previous store-server window and
   run the launcher again so the newly entered API key is used.

## Deploy to a Node.js host

The `.cmd` launcher is only for local Windows use. On a Node.js hosting
provider, configure these environment variables in the provider dashboard:

- `NODE_ENV=production`
- `PREMKU_API_KEY` = active Premku API key
- `PREMKU_API_SECRET` = active Premku API secret
- `HOST=0.0.0.0` only if the provider requires an explicit bind address

Use Node.js 18 or newer, set the build command to `npm install` (or omit it
because there are no external packages), and set the start command to `npm
start`. The server uses the host-provided `PORT` automatically. Deploy the
whole project, including `index.html`, `desain.css`, `animasi.js`, and
`order-app.js`; static-only hosting cannot run the payment backend.

Use a persistent disk for the `data` directory so in-progress checkout records
survive restarts. Enable HTTPS and the host's private-access control if this
store should not be public. Never put API credentials in frontend files or
source-control settings.

This implementation expects a single Node server process; do not run multiple
instances against the same store without adding a shared database and
distributed locking.

### Pterodactyl

Pterodactyl works with a Node.js egg (Node.js 18 or newer). Upload the project
files, set the server startup command to `npm start`, and make sure the egg
passes its allocated port as `SERVER_PORT` or `PORT`. The server binds to
`0.0.0.0` when `NODE_ENV=production`.

Add `PREMKU_API_KEY`, `PREMKU_API_SECRET`, and `NODE_ENV=production` in the
panel's Startup environment variables. Do not put credentials in the Startup
command. If the panel uses an ephemeral filesystem, mount persistent storage
for the `data` directory. The allocated port must be reachable through the
node's firewall; keep the store private or put access control in front of it.

The API calls follow the Premku integration already present in the supplied
WhatsApp bot: `products`, `pay`, `pay_status`, `order`, and `status`. Both the
API key and secret are sent as `api_key` and `api_secret` from the server only.
The web checkout intentionally
does not send a WhatsApp number. If Premku requires
that field, the API will reject the order and the checkout will show an error;
confirm the current API requirements with Premku before accepting live
payments.

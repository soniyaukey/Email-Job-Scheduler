# ReachInbox email scheduler

A React dashboard and TypeScript/Express API for scheduling email through BullMQ, Redis, PostgreSQL, and Ethereal SMTP.

## Requirements

- Node.js 20.19 or later, or 22.12 or later
- Docker Desktop, or compatible local PostgreSQL and Redis services
- Google OAuth web application credentials
- Ethereal SMTP credentials (optional for local development; one test account is created automatically)

## Local setup

1. Install dependencies from the repository root:

   ```powershell
   npm install
   ```

2. Create the local environment file and set Google OAuth values:

   ```powershell
   Copy-Item .env.example server/.env
   ```

   In Google Cloud Console, create an OAuth client for a web application. Add `http://localhost:5173` as an authorized JavaScript origin and `http://localhost:3000/api/auth/google/callback` as an authorized redirect URI. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and a long random `SESSION_SECRET` in `server/.env`.

3. Start PostgreSQL and Redis:

   ```powershell
   docker compose up -d
   ```

4. Start the API, worker, and frontend:

   ```powershell
   npm run dev:all
   ```

   The dashboard is at `http://localhost:5173`; the API is at `http://localhost:3000`. The API creates its tables on startup. Stop the local infrastructure with `docker compose down`; persisted database and Redis data remain in Docker volumes.

If `SMTP_SENDERS_JSON` is empty, the server creates an Ethereal test account and saves its credentials in Redis so a restart reuses the same sender. To configure multiple senders, set `SMTP_SENDERS_JSON` to a JSON array in `server/.env`:

```json
[{"email":"sender@example.test","host":"smtp.ethereal.email","port":587,"secure":false,"user":"ethereal-user","pass":"ethereal-password","name":"ReachInbox"}]
```

Ethereal accepts test messages but does not deliver them to real inboxes. Each successful test send logs an Ethereal preview URL in the API terminal.

## Delivery controls

`WORKER_CONCURRENCY` sets the BullMQ worker concurrency. `MIN_SEND_DELAY_MS` sets the minimum global gap between sends; the default is **2 seconds**. The BullMQ limiter is shared through Redis across worker instances. `MAX_EMAILS_PER_HOUR_PER_SENDER` sets the configurable upper bound, defaulting to **200**. A schedule can request a lower per-job sender limit. An atomic Redis Lua counter reserves a slot for the current UTC hour and sender. When the limit is full, a job is moved to the next UTC hour rather than failed or discarded. Jobs use stable BullMQ IDs and are reconstructed from PostgreSQL at startup, which also covers a process stopping between a database commit and queue insertion.

The API stores the schedule before enqueueing and uses a unique `(user, idempotency key, recipient)` constraint. The dashboard retains its idempotency key after a failed request so submitting again will not create duplicates. Pending emails are recovered after restart. If a process stops while an SMTP send is in progress, the delivery result is inherently ambiguous because SMTP offers no transactional/idempotent handoff; on restart that record is marked failed and is **not resent**, preferring no duplicate over a possible missed message. Review such cases manually.

For batches of 1,000 or more emails, PostgreSQL holds the durable records and BullMQ holds delayed jobs; workers process only at configured concurrency, and Redis pacing and hourly counters push overflow into later windows. This avoids loading the full batch into worker memory, though it does not guarantee strict FIFO ordering between independently scheduled jobs at an hour boundary.

## API

- `GET /api/health` - service health
- `GET /api/auth/google` - begin real Google OAuth sign-in
- `GET /api/auth/me` - return the signed-in profile
- `POST /api/auth/logout` - clear the session
- `GET /api/emails/config` - return configured delivery limits (requires a session)
- `POST /api/emails` - schedule a batch (`idempotencyKey`, `subject`, `body`, `recipients`, `startsAt`, `sendDelayMs`, `hourlyLimit`)
- `GET /api/emails?status=scheduled` - scheduled and in-progress emails
- `GET /api/emails?status=sent` - sent and failed emails

All email endpoints require the Google session cookie. Scheduling accepts up to 5,000 unique recipient addresses per request.

## Scripts

- `npm run dev` - frontend dev server
- `npm run dev:server` - API and worker with TypeScript watch mode
- `npm run dev:all` - frontend and backend together
- `npm run build` - frontend production build
- `npm run build:server` - backend TypeScript build
- `npm run lint` - frontend lint

## Deploy to Render

The repository includes a [`render.yaml`](render.yaml) Blueprint for the API, static frontend, PostgreSQL, and persistent Redis-compatible Key Value service. It deploys the API as an always-on Node web service because the BullMQ worker must remain running. The managed PostgreSQL, Redis-compatible storage, and always-on API use paid plans; Render's free Key Value plan has no persistence and is not suitable for this queue.

1. Push the repository to a Git provider supported by Render, then create a Blueprint from its root `render.yaml`.
2. Enter `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` when prompted. The Blueprint generates `SESSION_SECRET` and connects the app to its database and Key Value service.
3. Add custom domains under the same registered domain, for example `app.example.com` for the static site and `api.example.com` for the API. This matters because the session cookie uses `SameSite=Lax`.
4. In the Render dashboard, set the API's `FRONTEND_URL` to `https://app.example.com` and `GOOGLE_CALLBACK_URL` to `https://api.example.com/api/auth/google/callback`. Set the static site's `VITE_API_URL` to `https://api.example.com`, then redeploy both services.
5. In Google Cloud Console, set the authorized JavaScript origin to `https://app.example.com` and the redirect URI to `https://api.example.com/api/auth/google/callback`.
6. Optionally set `SMTP_SENDERS_JSON` on the API service. Otherwise, it creates an Ethereal test account and persists the credentials in Key Value. Ethereal is for previews only, not real inbox delivery.

The Blueprint links `VITE_API_URL` and the initial `FRONTEND_URL` to Render's generated service URLs. Replace them with your custom-domain URLs as above before using Google sign-in. The API derives its initial callback from Render's generated URL; explicitly set `GOOGLE_CALLBACK_URL` to the custom API URL for production.

After deployment, verify `https://api.example.com/api/health`. Check the API service logs for startup and queue recovery messages. Creating the Blueprint requires a connected Render account, and the API, PostgreSQL, and persistent Key Value plans incur provider charges.

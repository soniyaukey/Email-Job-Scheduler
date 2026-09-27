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

The repository includes a [`render.yaml`](render.yaml) Blueprint for a no-cost demo of the API, static frontend, PostgreSQL, and Redis-compatible Key Value service. All Render compute and datastore plans in this Blueprint are Free. This is for preview/demo use only and does **not** preserve the production scheduling guarantees described above.

1. Push the repository to a Git provider supported by Render, then create a Blueprint from its root `render.yaml`.
2. Enter `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` when prompted. The Blueprint generates `SESSION_SECRET` and connects the app to its database and Key Value service.
3. In Google Cloud Console, add the Render frontend URL as an authorized JavaScript origin and the API URL plus `/api/auth/google/callback` as an authorized redirect URI. The Blueprint wires the service URLs between its resources.
6. Optionally set `SMTP_SENDERS_JSON` on the API service. Otherwise, it creates an Ethereal test account and persists the credentials in Key Value. Ethereal is for previews only, not real inbox delivery.

The Blueprint links `VITE_API_URL` and `FRONTEND_URL` to Render's generated service URLs. The API derives its callback URL from Render's generated API URL. If you later add custom domains, update the frontend origin and OAuth redirect URI in both Render and Google Cloud Console.

Free-plan limitations: the API sleeps after 15 minutes without inbound traffic, so a queued email can be delayed until it wakes; free Postgres expires after 30 days; free Key Value is in-memory and loses queue data on restart; and Render blocks outbound SMTP ports 25, 465, and 587 on free web services. Therefore this setup is not suitable for reliable scheduled email delivery. Review Render's current plan limits before creating the Blueprint. After deployment, verify the API's `/api/health` endpoint and check the worker logs.

Dashboard: reachinbox-frontend-ltma.onrender.com
API health check: reachinbox-api-vrsz.onrender.com/api/health returned HTTP 200.

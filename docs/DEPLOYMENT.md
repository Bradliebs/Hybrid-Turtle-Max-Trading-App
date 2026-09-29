# HybridTurtle Deployment

## Phase 13 Scope

Phase 13 packages the current runtime, adds CI, and documents stable startup commands.

Important constraint: the checked-in Prisma schema is still SQLite-backed. The stable deployment path in this workspace therefore uses the existing SQLite database file. A Postgres service is included in Docker Compose as a migration scaffold, not as the active database for the current app image.

## Local Mode

### Prerequisites

- Docker Desktop
- A populated `.env` file

### Stable app runtime

```bash
docker compose up --build app
```

This starts the Next.js app on `http://localhost:3000` and persists the SQLite database through the mounted `prisma` directory.

### First run in Docker (single-user desktop mode)

1. Create `.env` in the repo folder. `docker compose` reads it at runtime; it is **not** copied into the image. Copying `.env.example` is fine: the compose file forces `DISABLE_API_AUTH=true` and `BROKER_ADAPTER=disabled` for the container. Do replace the placeholder `NEXTAUTH_SECRET`, `ENCRYPTION_SECRET` and `CRON_SECRET` with long random values. `ENCRYPTION_SECRET` protects saved Trading 212 keys, so keep it the same between rebuilds or the keys must be re-entered. Delete or fill in the placeholder `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` lines: `.env` values take priority over the ones saved in **Settings → Notifications**, so placeholders stop Telegram working.
2. Run `docker compose up --build app`. On first start, the container applies migrations and seeds the stock universe (about 1,350 tickers) if it's empty. Later starts skip the seed, so edits to your universe are kept. It also prints a warning for any placeholder values still in `.env`.
3. Open <http://localhost:3000>. The port is published on the host's `127.0.0.1` only, so no login is needed and other devices on your network can't reach it.
4. On the **Scan** page, the first scan shows **"First-time setup: Market data needed"**. Click **Download Market Data** once, then run the scan.

Data lives in the mounted `prisma/` (database), `data/` (runtime state) and `reports/` folders.

> **Never run Docker and the Windows install against the same folder.** Both would share `prisma/dev.db`, a SQLite database in WAL mode. Two processes on different operating systems (Windows and the Docker Linux VM) writing to it at once can corrupt it, and the container also runs database migrations at every start. Use Docker from its own copy of the repository. `start.bat` also stops whatever is listening on port 3000, including a running container.

To expose the app on your network deliberately, set `DISABLE_API_AUTH: 'false'` and change the port to `'3000:3000'` in `docker-compose.yml`. Users then need to register and sign in. In this mode the in-memory rate limiter allows 3 scan runs per minute; reads such as the Scan page's progress polling are not limited.

### What does not run in Docker

The scheduled jobs are Windows Task Scheduler tasks registered by `register-all-tasks.bat`. None of them run inside the container:

- nightly stop updates and the nightly Telegram report
- midday Trading 212 sync (stop-out detection)
- auto-trade sessions (scan and buy)
- watchdog, briefings and the weekly digest

In Docker, Trading 212 syncs only when you click **Sync All Connected Accounts** in **Settings → Broker**, and stops only move when you review them yourself. For automatic trading or automatic stop management, use the native Windows install (`install.bat`).

### App + optional model service

```bash
docker compose --profile model up --build
```

The optional model service listens on `http://localhost:8000` and exposes `/healthz` and `/versions` for deployment checks.

### Postgres scaffold

```bash
docker compose --profile postgres up -d postgres
```

Use this only for future migration work. The current application container is not yet switched to a Postgres Prisma provider.

## Cloud Mode

### Recommended topology

- Linux VM or VPS
- Reverse proxy such as Caddy or Nginx for HTTPS
- One app process running `npm run start`
- Scheduled jobs triggered by Task Scheduler equivalents, cron, or systemd timers
- External Postgres only after the Prisma provider migration is completed

### Baseline commands

```bash
npm ci
npm run db:generate
npm run db:auto-migrate
npm run build
npm run start
```

### Reverse proxy notes

- Terminate TLS at the proxy
- Forward traffic to `localhost:3000`
- Keep `NEXTAUTH_URL` aligned with the public HTTPS origin

### Scheduled jobs

- Nightly run: call the existing nightly script or schedule the current nightly route workflow used by this workspace
- Broker/data refresh: keep existing scheduler scripts as separate supervised jobs
- Watchdog: retain the daily heartbeat check if Telegram alerts are enabled

Windows Task Scheduler audit and repair steps are documented in [SCHEDULER-AUDIT.md](SCHEDULER-AUDIT.md).

## CI

The Phase 13 CI workflow runs:

```bash
npm run test:unit
npm run build
```

## Manual Verification

```bash
npm run test:unit
npm run build
```

If `npm run build` fails after future changes, treat it as a hardening blocker before relying on the container image.
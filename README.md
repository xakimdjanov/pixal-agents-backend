# Pixel Agents backend

Node/TypeScript API + Socket.IO server that runs Claude agents in-process, backed by Postgres.

## Environment (see `.env.example`)
`POSTGRES_PASSWORD`, `JWT_SECRET` (>=32 chars), `CONNECTOR_KEY` (64 hex), `DOMAIN`, `DEFAULT_FOUNDER_PASSWORD`, `NODE_ENV`, `PORT`, `DATA_DIR`.
Generate secrets with `openssl rand -hex 32`. `.env` is git-ignored — never commit it.

## Run
```
cp .env.example .env   # fill in values
mkdir -p frontend-dist # optional: drop a built frontend here
docker compose up -d --build
```
nginx listens on :80 and proxies `/api` and `/socket.io` to the backend; HTTPS notes are in `deploy/nginx.conf` (certbot-friendly).

## First founder
On first boot, if no founder exists, one is created: `visitca@founder` with `DEFAULT_FOUNDER_PASSWORD` (default `visitca`). **Change it immediately** after logging in.

## Backup / restore
`pgbackup` writes a daily dump to the `pgbackups` volume (7 days kept).
Restore: `docker compose exec -T postgres pg_restore -U studio -d studio --clean --if-exists < studio-YYYYMMDD-HHMM.dump`
**Back up `CONNECTOR_KEY`** — without it stored connector secrets are unreadable. Also back up the `agentdata` volume.

## Claude login per agent
Each agent has its own Claude login under `/data/claude/<agent_id>` (volume `agentdata`). Log in per agent via the app/CLI inside the backend container (`docker compose exec backend claude`) with `CLAUDE_CONFIG_DIR` set to that agent's directory.

## Tests
`npm ci && npm test` (needs a Postgres, see test fixtures) · `npx tsc --noEmit`

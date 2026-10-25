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
Dump manually: `docker compose exec -T postgres pg_dump -U studio -Fc studio > studio.dump`.
Restore: `docker compose exec -T postgres pg_restore -U studio -d studio --clean --if-exists < studio.dump`
**Back up `CONNECTOR_KEY`** — without it stored connector secrets are unreadable. Also back up the `agentdata` volume.

## Private repositories and re-queueing tasks
- **Git credentials**: for `https://github.com/...` repos the agent uses the token of an enabled `github` connector (project-scoped preferred, else global; `git_token` if set, else `token`). It is passed to git only via a temporary `GIT_ASKPASS` helper and the child's environment, never in the URL, argv, logs or `.git/config`. ssh URLs get no credentials.
- **No/invalid credentials**: the task goes to `BLOCKED` (not `FAILED`) with a note to add a GitHub connector and move it back to `PENDING`.
- **Re-queue**: a reviewer moving a task to `PENDING` or `ACCEPTED` sends the assignee a fresh `TASK_ASSIGNMENT` (idempotency key `task-assign:<task>:<attempt>`); a running task is never started twice.

## Task moves
`POST` status change rules: a **reviewer** (founder, the task's `reply_to` agent, or a `pm` who created the task / is a project member) can move a task from any status to any status. The **assignee** can only move it to `ACCEPTED`, `IN_PROGRESS`, `REVIEW` or `BLOCKED` (agent-token assignees may also report `FAILED`). Anyone else gets 403.

## Project members
- `GET /api/projects/:id/members` – members `[{user_id, name, email, role, agent_id}]` (any project member/founder; 404 for non-members).
- `POST /api/projects/:id/members` `{user_id}` – founder only; 201.
- `DELETE /api/projects/:id/members/:userId` – founder only; 400 for the creator, 404 if not a member, 409 if the member has open tasks unless `?force=1`.

## Claude login per agent
Each agent has its own Claude login under `/data/claude/<agent_id>` (volume `agentdata`). Log in per agent via the app/CLI inside the backend container (`docker compose exec backend claude`) with `CLAUDE_CONFIG_DIR` set to that agent's directory.

## Tests
`npm ci && npm test` (needs a Postgres, see test fixtures) · `npx tsc --noEmit`

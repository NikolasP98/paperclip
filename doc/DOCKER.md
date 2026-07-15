# Docker Quickstart

Run Paperclip in Docker without installing Node or pnpm locally.

All commands below assume you are in the **project root** (the directory containing `package.json`), not inside `docker/`.

## Building the image

```sh
docker build -t paperclip-local .
```

The Dockerfile installs common agent tools (`git`, `gh`, `curl`, `wget`, `ripgrep`, `python3`) and the Claude, Codex, and OpenCode CLIs.

Build arguments:

| Arg | Default | Purpose |
|-----|---------|---------|
| `USER_UID` | `1000` | UID for the container `node` user (match your host UID to avoid permission issues on bind mounts) |
| `USER_GID` | `1000` | GID for the container `node` group |

```sh
docker build -t paperclip-local \
  --build-arg USER_UID=$(id -u) --build-arg USER_GID=$(id -g) .
```

## One-liner (build + run)

```sh
docker build -t paperclip-local . && \
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Open: `http://localhost:3100`

Data persistence:

- Embedded PostgreSQL data
- uploaded assets
- local secrets key
- local agent workspace data

All persisted under your bind mount (`./data/docker-paperclip` in the example above).

## Docker Compose

### Quickstart (embedded SQLite)

Single container, no external database. Data persists via a bind mount.

```sh
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

Defaults:

- host port: `3100`
- persistent data dir: `./data/docker-paperclip`

Optional overrides:

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=../data/pc \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

**Note:** `PAPERCLIP_DATA_DIR` is resolved relative to the compose file (`docker/`), so `../data/pc` maps to `data/pc` in the project root.

If you change host port or use a non-local domain, set `PAPERCLIP_PUBLIC_URL` to the external URL you will use in browser/auth flows.

Pass `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` to enable local adapter runs.

### Full stack (with PostgreSQL)

Paperclip server + PostgreSQL 17. The database is health-checked before the server starts.

```sh
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  docker compose -f docker/docker-compose.yml up --build
```

PostgreSQL data persists in a named Docker volume (`pgdata`). Paperclip data persists in `paperclip-data`.

### Untrusted PR review

Isolated container for reviewing untrusted pull requests with Codex or Claude, without exposing your host machine. See `doc/UNTRUSTED-PR-REVIEW.md` for the full workflow.

```sh
docker compose -f docker/docker-compose.untrusted-review.yml build
docker compose -f docker/docker-compose.untrusted-review.yml run --rm --service-ports review
```

## Authenticated Compose (Single Public URL)

For authenticated deployments, set one canonical public URL and let Paperclip derive auth/callback defaults:

```yaml
services:
  paperclip:
    environment:
      PAPERCLIP_DEPLOYMENT_MODE: authenticated
      PAPERCLIP_DEPLOYMENT_EXPOSURE: private
      PAPERCLIP_PUBLIC_URL: https://desk.koker.net
```

`PAPERCLIP_PUBLIC_URL` is used as the primary source for:

- auth public base URL
- Better Auth base URL defaults
- bootstrap invite URL defaults
- hostname allowlist defaults (hostname extracted from URL)

For fresh `authenticated/private` Docker or appliance-style installs, the first
admin can now be claimed entirely from the browser after sign-in. Open the
Paperclip URL, sign in or create an account, then choose `Claim this instance`
on the setup screen. This browser claim is disabled for `authenticated/public`;
public deployments should run the high-entropy CLI invite fallback instead:

```sh
pnpm paperclipai auth bootstrap-ceo
```

Granular overrides remain available if needed (`PAPERCLIP_AUTH_PUBLIC_BASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, `PAPERCLIP_ALLOWED_HOSTNAMES`).

Set `PAPERCLIP_ALLOWED_HOSTNAMES` explicitly only when you need additional hostnames beyond the public URL host (for example Tailscale/LAN aliases or multiple private hostnames).

## Claude + Codex Local Adapters in Docker

The image pre-installs:

- `claude` (Anthropic Claude Code CLI)
- `codex` (OpenAI Codex CLI)

If you want local adapter runs inside the container, pass API keys when starting the container:

```sh
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e OPENAI_API_KEY=... \
  -e ANTHROPIC_API_KEY=... \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Notes:

- Without API keys, the app still runs normally.
- Adapter environment checks in Paperclip will surface missing auth/CLI prerequisites.

## GitHub Bug Webhook and Stage-Task Intake

Pass GitHub intake variables into the Paperclip container explicitly (with
Compose `environment`, `env_file`, or equivalent deployment configuration).
The webhook route is mounted only when all four base variables are non-empty:

| Variable | Purpose |
|----------|---------|
| `GITHUB_WEBHOOK_SECRET` | Secret used to verify GitHub's `X-Hub-Signature-256`; do not commit its value |
| `GITHUB_BUGS_COMPANY_ID` | Company that owns ingested issues |
| `GITHUB_BUGS_AGENT_ID` | Active legacy/fallback bug-fixer assignee; still required to mount the route when stage-task intake is enabled |
| `GITHUB_BUG_REPO` | Exact accepted GitHub repository in `owner/repo` form |

Classified stage-task intake is an additional all-or-nothing configuration. If
`GITHUB_BUGS_STAGE_TASKS_PIPELINE_ID` is set, also set:

| Variable | Purpose |
|----------|---------|
| `GITHUB_BUGS_INTAKE_PROJECT_ID` | Safe fallback project for low-confidence or unresolved routing |
| `GITHUB_BUGS_CLASSIFIER_AGENT_ID` | Active company agent using the `minion_drone` adapter with drone id `portfolio-issue-classifier-v1` |
| `GITHUB_BUGS_STAGE_TASK_ROUTES_JSON` | Operator-owned JSON route array emitted by the MINION Code seed |
| `GITHUB_BUGS_CLASSIFIER_MIN_CONFIDENCE` | Optional `0..1` confidence floor; defaults to `0.7` |

`GITHUB_BUGS_CLASSIFIER_AGENT_ID` is distinct from the legacy
`GITHUB_BUGS_AGENT_ID`: the former owns the bounded classification heartbeat,
while the latter remains the webhook mount/fallback assignee. The MINION Code
seed prints the stage-task pipeline id, intake project id, classifier agent id,
and routes JSON for deployment configuration:

```sh
pnpm seed:minion-code -- --help
```

Keep `GITHUB_WEBHOOK_SECRET` in the deployment secret store. The ids, repository
name, confidence threshold, and routes are configuration metadata and contain no
credential values.

## Podman Quadlet (systemd)

The `docker/quadlet/` directory contains unit files to run Paperclip + PostgreSQL as systemd services via Podman Quadlet.

| File | Purpose |
|------|---------|
| `docker/quadlet/paperclip.pod` | Pod definition — groups containers into a shared network namespace |
| `docker/quadlet/paperclip.container` | Paperclip server — joins the pod, connects to Postgres at `127.0.0.1` |
| `docker/quadlet/paperclip-db.container` | PostgreSQL 17 — joins the pod, health-checked |

### Setup

1. Build the image (see above).

2. Copy quadlet files to your systemd directory:

   ```sh
   # Rootless (recommended)
   cp docker/quadlet/*.pod docker/quadlet/*.container \
     ~/.config/containers/systemd/

   # Or rootful
   sudo cp docker/quadlet/*.pod docker/quadlet/*.container \
     /etc/containers/systemd/
   ```

3. Create a secrets env file (keep out of version control):

   ```sh
   cat > ~/.config/containers/systemd/paperclip.env <<EOL
   BETTER_AUTH_SECRET=$(openssl rand -hex 32)
   POSTGRES_USER=paperclip
   POSTGRES_PASSWORD=paperclip
   POSTGRES_DB=paperclip
   DATABASE_URL=postgres://paperclip:paperclip@127.0.0.1:5432/paperclip
   # OPENAI_API_KEY=sk-...
   # ANTHROPIC_API_KEY=sk-...
   EOL
   ```

4. Create the data directory and start:

   ```sh
   mkdir -p ~/.local/share/paperclip
   systemctl --user daemon-reload
   systemctl --user start paperclip-pod
   ```

### Quadlet management

```sh
journalctl --user -u paperclip -f        # App logs
journalctl --user -u paperclip-db -f     # DB logs
systemctl --user status paperclip-pod    # Pod status
systemctl --user restart paperclip-pod   # Restart all
systemctl --user stop paperclip-pod      # Stop all
```

### Quadlet notes

- **First boot**: Unlike Docker Compose's `condition: service_healthy`, Quadlet's `After=` only waits for the DB unit to *start*, not for PostgreSQL to be ready. On a cold first boot you may see one or two restart attempts in `journalctl --user -u paperclip` while PostgreSQL initialises — this is expected and resolves automatically via `Restart=on-failure`.
- Containers in a pod share `localhost`, so Paperclip reaches Postgres at `127.0.0.1:5432`.
- PostgreSQL data persists in the `paperclip-pgdata` named volume.
- Paperclip data persists at `~/.local/share/paperclip`.
- For rootful quadlet deployment, remove `%h` prefixes and use absolute paths.

## Onboard Smoke Test (Ubuntu + npm only)

Use this when you want to mimic a fresh machine that only has Ubuntu + npm and verify:

- `npx paperclipai onboard --yes` completes
- the server binds to `0.0.0.0:3100` so host access works
- onboard/run banners and startup logs are visible in your terminal

Build + run:

```sh
./scripts/docker-onboard-smoke.sh
```

Open: `http://localhost:3131` (default smoke host port)

Useful overrides:

```sh
HOST_PORT=3200 PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_DEPLOYMENT_EXPOSURE=private ./scripts/docker-onboard-smoke.sh
SMOKE_DETACH=true SMOKE_METADATA_FILE=/tmp/paperclip-smoke.env PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

Notes:

- Persistent data is mounted at `./data/docker-onboard-smoke` by default.
- Container runtime user id defaults to your local `id -u` so the mounted data dir stays writable while avoiding root runtime.
- Smoke script defaults to `authenticated/private` mode so `HOST=0.0.0.0` can be exposed to the host.
- Smoke script defaults host port to `3131` to avoid conflicts with local Paperclip on `3100`.
- Smoke script also defaults `PAPERCLIP_PUBLIC_URL` to `http://localhost:<HOST_PORT>` so bootstrap invite URLs and auth callbacks use the reachable host port instead of the container's internal `3100`.
- In authenticated mode, the smoke script defaults `SMOKE_AUTO_BOOTSTRAP=true` and drives the real bootstrap path automatically: it signs up a real user, runs `paperclipai auth bootstrap-ceo` inside the container to mint a real bootstrap invite, accepts that invite over HTTP, and verifies board session access.
- Run the script in the foreground to watch the onboarding flow; stop with `Ctrl+C` after validation.
- Set `SMOKE_DETACH=true` to leave the container running for automation and optionally write shell-ready metadata to `SMOKE_METADATA_FILE`.
- The image definition is in `docker/Dockerfile.onboard-smoke`.

## General Notes

- The `docker-entrypoint.sh` adjusts the container `node` user UID/GID at startup to match the values passed via `USER_UID`/`USER_GID`, avoiding permission issues on bind-mounted volumes.
- Paperclip data persists via Docker volumes/bind mounts (compose) or at `~/.local/share/paperclip` (quadlet).

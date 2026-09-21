# workspace-extension

A standalone abc-protocol **extension server** with three surfaces:

- **`sandbox-*` lifecycle** — create/list/status/delete easyworker sandboxes on
  demand via the [**worker-manager**](../worker-manager) service (Connect RPC).
- **`sandbox-*` execution** — run commands and read/write files in a named
  sandbox (direct Connect RPC over `worker.v1.WorkerService`).
- **`repo-*`** — read and commit files in a **Forgejo** repository (direct
  REST), with branches, tags, history, diffs and pull requests.
- **`sandbox-checkout` / `sandbox-port`** — move a repository tree into a
  sandbox and commit sandbox changes back. This is the "worker is scratch, the
  repo is the durable workspace" model.

Unlike easylab's `ops-extension` / `repo-extension` (which go through the
easylab gateway), this extension is a deliberately small **direct client**.

> **Alternative:** for a single, stable worker (no dynamic sandboxes, no git),
> use the sibling [`worker-extension`](../worker-extension) instead. They are
> alternatives: pick `worker-extension` when one fixed worker is enough, and
> this one when you need many workspaces with durable files in git and scratch
> files in a sandbox.

## Design

- **Own process, own repo.** The agent discovers it over `abc.discover` plus an
  `abc-presence` heartbeat; no agent/easylab code change is required.
- **Dynamic workers, by name.** `sandbox-create` asks the worker-manager for a
  sandbox (image + resources) and waits up to 60s for readiness; every execution
  tool takes a required **`worker-name`** and resolves its URL + per-sandbox
  token from the manager. `sandbox-list`/`sandbox-status`/`sandbox-delete`
  round out the lifecycle. There is no fixed `worker-url`/`worker-token`.
- **URLs as config.** `manager-url`/`manager-token` for the sandbox backend;
  `forgejo-url` + auth for the repo. Tools declare their needs via
  `required_config`, so the agent **hard-disables** a tool until its backend is
  configured.
- **Direct backends.** worker.v1 + worker_manager.v1 descriptors are vendored
  under `src/gen/`; Forgejo is a small typed REST client (`src/forgejo.ts`).
- **Files route through the agent.** `sandbox-upload`/`sandbox-download` use the
  agent file RPCs; the **agent derives the MIME**. `sandbox-read` never ingests:
  binary content is rejected, text is windowed with line numbers.
- **Localized end to end.** Tool/config descriptions carry an English
  `description` + a `descriptions.zh` map (resolved agent-side). Runtime text is
  localized through a typed catalog (`src/i18n.ts`) using the agent-projected
  session locale (`vars.agent.locale`). Failures use `TypedToolError` so the
  agent receives a real code (`invalid_argument` / `not_found` / `retryable` /
  `permission_denied`).

## Localization (i18n)

| Surface | Mechanism | Source |
|---|---|---|
| Tool / config **descriptions** | `description` + `descriptions[locale]` | `src/index.ts` `TOOL_META`, agent resolves via `pickDescription` |
| Runtime **content** + **errors** | typed catalog + `tr(locale, key, params)` | `src/i18n.ts` |

The session locale is read once per tool call by `localeOf(...)` from the
agent-projected `vars.agent.locale` KV entry (falling back to `en`). The catalog
is an OPEN map: add a language by adding a column to each entry — no code change.

## Tools

### sandbox-* (easyworker)

Every `sandbox-*` tool requires `manager-url` + `manager-token`. The four
lifecycle tools talk to the worker-manager; every execution tool additionally
takes a required **`worker-name`**.

**Lifecycle (worker-manager)**

| Tool | Notes |
|---|---|
| `sandbox-create` | create a sandbox from an `image` (must contain easyworker) with optional `cpu`/`memory`/`workspace`/`env`; waits up to 60s for readiness |
| `sandbox-list` | list managed sandboxes (name, phase, image, url, created, creator) |
| `sandbox-status` | one sandbox's live state (`worker-name`) |
| `sandbox-delete` | delete a sandbox + its pod/service/secret (`worker-name`) |

**Execution (easyworker, `worker-name` required)**

| Tool | Worker RPC | Notes |
|---|---|---|
| `sandbox-info` | `Info` | os/arch/shell/workspace/boot_id |
| `sandbox-exec` | `Execute` + `JobWait` loops + `JobOutput` | short tasks; waits ≤ `timeout` s (default 5, max 60). Always returns `job-id`; on completion up to 1000 lines, on timeout the **oldest 200** lines + "still running" |
| `sandbox-job-start` | `Execute` | fire-and-forget long task; returns `job-id` only |
| `sandbox-job-output` | `JobOutput` | `offset` (negative = from end) + `limit` (default 200, max 1000), `stream`; display capped at 1000 lines / 120 KiB |
| `sandbox-job-wait` | `JobWait` loops | waits ≤ `timeout` s (default 60, max 600); returns the latest 200 lines |
| `sandbox-job-kill` | `JobKill` | process-tree kill |
| `sandbox-job-stdin` | `JobStdin` | write/close a job's stdin |
| `sandbox-job-list` | `ListJobs` | id/state/exit/command |

**Files (`worker-name` required)**

| Tool | Notes |
|---|---|
| `sandbox-read` | text-only, `offset`/`limit` (default 200, max 1000), **line-numbered**, truncation marker; binary → error. Records the displayed lines as "seen" |
| `sandbox-write` | overwrite with full content; rejected over 120 KiB; returns the numbered **whole** file; marks the whole file as "seen" |
| `sandbox-edit` | 1-based line edit; `end-line < start-line` inserts, else replaces `[start-line, end-line]`; out-of-range clamps; returns a summary + unified diff. Enforces **read-before-edit** |
| `sandbox-ls` | breadth-first tree levels 1..`depth` (default 3), `limit` default 200 / max 1000 |
| `sandbox-download` | agent `file:<code>` → workspace path |
| `sandbox-upload` | workspace path → agent `file:<code>` (agent derives the MIME) |
| `sandbox-checkout` | Forgejo archive(`.tar.gz`) → worker `SyncFolder`; `clean=false` (default) keeps sandbox-only files |
| `sandbox-port` | sandbox file/dir → Forgejo commit; a directory is ported as **new files only** (refused if any target exists) |

### repo-* (Forgejo)

Every `repo-*` tool requires `forgejo-url`; auth is `forgejo-token` (PAT), or
`forgejo-user` + `forgejo-password`. Address args: `org`, `repo`, and optional
`ref` (branch / sha / tag; omitted = the repository default branch).

**Content**

| Tool | Notes |
|---|---|
| `repo-explore` | list orgs, or an org's repos + branches (private included); optional `keyword` |
| `repo-create-org` | create an organization (needs a credential allowed to create orgs) |
| `repo-create-repo` | create a repository under an org or user; optional `auto-init` + `default-branch` |
| `repo-read` | line-numbered text window; records seen lines + blob sha |
| `repo-write` | create/overwrite one file (one commit), optimistic lock by blob sha |
| `repo-edit` | 1-based line edit (one commit) with read-before-edit guard + unified diff |
| `repo-delete` | delete one file (one commit) |
| `repo-list` | list a directory (or a file) at a ref |
| `repo-commit` | commit several files **atomically** (create/update/delete), optional `new-branch` |

**History / refs / collaboration**

| Tool | Notes |
|---|---|
| `repo-log` | commit history (optional `path`/`ref` filter) |
| `repo-show` | one commit's metadata + patch |
| `repo-diff` | compare two refs (`base...head`) |
| `repo-branches` / `repo-branch-create` | list / create branches |
| `repo-tags` / `repo-tag-create` | list / create tags |
| `repo-mr-create` / `repo-mr-list` / `repo-mr-comment` / `repo-mr-merge` | pull requests |

## Read-before-edit

Both `sandbox-edit` and `repo-edit` are guarded so a session can only change
what it has actually seen:

- **Seen required.** The file must have been `read` (or `write`n) in this
  session — otherwise `permission_denied` ("call read first").
- **Range-limited.** Only the line ranges the session has seen may be edited.
- **Freshness.** If the file changed since that read, the edit is refused with
  `retryable` ("read again"). The token is the sandbox file's sha256 / the repo
  file's git blob sha.
- **Invalidate on edit.** A successful edit clears the file's seen state, so the
  next edit requires a fresh read.

State is one KV entry per `(tenant, session)` in the `workspace-edit-state`
bucket, keyed `t.<tenant>.<sessionToken>`, holding `{key → {sha256, ranges}}`
where `key` is the sandbox path or `org/repo@ref:path`. Shared across replicas,
restart-safe, deleted on session deletion.

## Configuration

| Config | Used by | Meaning |
|---|---|---|
| `manager-url` | sandbox-*, bridge | worker-manager base URL |
| `manager-token` | sandbox-*, bridge | worker-manager shared bearer |
| `forgejo-url` | repo-*, bridge | Forgejo base URL |
| `forgejo-token` | repo-* auth | personal access token (preferred) |
| `forgejo-user` / `forgejo-password` | repo-* auth | HTTP Basic (used when no token) |

## Build

```bash
npm install
npm run build          # tsc declarations + esbuild -> dist/main.js
npm run check          # tsc --noEmit
npm test               # vitest (needs nats-server on PATH or ABC_NATS_SERVER_BIN)
./build-image.sh       # buildkitd -> forgejo OCI
```

## Serve

```bash
NATS_URL=nats://nats:4222 node dist/main.js
```

Probes: `GET /api/v1/health`.

## Live end-to-end tests

`tests/e2e.live.test.ts` drives the `sandbox-*` tools against a **real**
easyworker over a **real** NATS broker; `tests/e2e.repo.live.test.ts` drives the
`repo-*` tools against a **real** Forgejo (and the bridge against both). Both are
skipped unless their env vars are set. They serve the extension exactly as
production does and use a real `Agent` role to discover it and push config
through the config authority.

```bash
# sandbox
LIVE_NATS_URL=nats://<nats>:4222 WORKER_URL=http://<easyworker> WORKER_TOKEN=<bearer> \
  npx vitest run tests/e2e.live.test.ts

# repo (+ optional bridge)
LIVE_NATS_URL=nats://<nats>:4222 FORGEJO_URL=http://<forgejo> FORGEJO_TOKEN=<pat> \
  E2E_ORG=<org> E2E_REPO=<repo> \
  [WORKER_URL=http://<easyworker> WORKER_TOKEN=<bearer>] \
  npx vitest run tests/e2e.repo.live.test.ts
```

The worker must run with a bearer token set (`WORKER_TOKEN`) so the auth gate is
exercised; `WORKER_REQUIRE_AUTH=0` dev workers also work with an empty token.

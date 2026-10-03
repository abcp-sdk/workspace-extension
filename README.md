# workspace-extension

A standalone abc-protocol **extension server** for the workspace stack. It has
four surfaces:

- **`sandbox-*` lifecycle** — create/list/status/delete sandboxes on demand via
  the **workspace gateway** (`workspace.v1.BranchSessionService`), which owns the
  Kubernetes sandbox backend in-process.
- **`sandbox-*` execution** — run commands and read/write files in a named
  sandbox (direct Connect RPC over `worker.v1.WorkerService`).
- **`sandbox-computer-*`** — drive a **GUI** sandbox's native apps through the
  platform accessibility tree (xa11y/AT-SPI2 on Linux, UI Automation on Windows,
  AXUIElement on macOS; adb/uiautomator on Android). Requires a GUI image.
- **`repo-*` / `service-*` / `helm-*` / `pvc-*`** — read a Forgejo repository,
  build images, and run long-lived workloads (services, Helm releases, PVCs) —
  all via the workspace gateway, which owns the credentials and enforces tenant
  ownership.
- **`sandbox-checkout` / `sandbox-submit-mr`** — check a repository tree into a
  sandbox, edit it there, and submit the changes as a change request. This is the
  ONLY way branch content changes: there is no tool that writes a branch
  directly. Edits happen in a sandbox; the gateway materializes the diff onto an
  immutable `mr/...` head branch and opens the MR.

> **Alternative:** for a fixed set of config-registered workers (no dynamic
> sandboxes, no git), use the sibling [`worker-extension`](../worker-extension)
> instead. This one is for many workspaces with durable files in git and scratch
> files in a sandbox.

## Design

- **Own process, own repo.** The agent discovers it over `abc.discover` plus an
  `abc-presence` heartbeat; no agent/easylab code change is required.
- **Dynamic sandboxes, by name.** `sandbox-create` asks the **workspace gateway**
  for a sandbox (image + resources) and waits up to 60s for readiness; every
  execution tool takes a required **`worker-name`** and resolves its URL +
  per-sandbox token from the gateway. `sandbox-list`/`sandbox-status`/
  `sandbox-delete` round out the lifecycle. There is no fixed
  `worker-url`/`worker-token`.
- **Pre-built, worker-bundled images.** The gateway does **NOT** inject the
  worker at launch: a sandbox runs a pre-built image that already bundles
  `agent-worker`, and only images from the deployment's sandbox org
  (`SANDBOX_ORG`, default `sandbox`) are accepted. Those images are built by
  **`abc-protocol/worker`**'s `sandbox-images/build.sh` (an
  `agent-toolchain/toolchain-<lang>` base + the cross-compiled worker). A worker
  change therefore requires **rebuilding the `sandbox-*` images** — see
  `DEVELOP.md`.
- **Gateway as config.** `gateway-url`/`gateway-token` are the ONLY config: the
  gateway fronts Forgejo (repo), Kubernetes (sandboxes/services/PVCs/Helm) and
  the worker resolution. Tools declare their needs via `required_config`, so the
  agent **hard-disables** a tool until the gateway is configured.
- **Direct worker RPC.** `worker.v1` descriptors are vendored under
  `src/gen/worker/v1` (see `src/gen/README.md` for the regeneration recipe); the
  extension talks to a resolved sandbox directly over Connect RPC.
- **Files route through the agent.** `sandbox-file-upload`/`sandbox-file-download`
  use the agent file RPCs; the **agent derives the MIME**. `sandbox-file-read`
  never ingests: binary content is rejected, text is windowed with line numbers.
- **Localized end to end.** Tool/config descriptions carry an English
  `description` + a `descriptions.zh` map (resolved agent-side). Runtime text is
  localized through a typed catalog (`src/i18n.ts`) using the agent-projected
  session locale (`vars.agent.locale`). Failures use `TypedToolError` so the
  agent receives a real code (`invalid_argument` / `not_found` / `retryable` /
  `permission_denied`).

## Localization (i18n)

| Surface | Mechanism | Source |
|---|---|---|
| Tool / config **descriptions** | `description` + `descriptions[locale]` | `manifest.yaml`, agent resolves via `pickDescription` |
| Runtime **content** + **errors** | typed catalog + `tr(locale, key, params)` | `src/i18n.ts` |

The session locale is read once per tool call by `localeOf(...)` from the
agent-projected `vars.agent.locale` KV entry (falling back to `en`). The catalog
is an OPEN map: add a language by adding a column to each entry — no code change.

## Tools

### sandbox-* lifecycle (workspace gateway)

| Tool | Notes |
|---|---|
| `sandbox-create` | create a sandbox from a pre-built worker-bundled `image` (must be from the sandbox org; omit for the deployment default) with optional `cpu`/`memory`/`kvm`/`gpu-count`/`env`; waits up to 60s for readiness. A name is never reused. |
| `sandbox-list` | list managed sandboxes (name, phase, image, url, created, creator) |
| `sandbox-status` | one sandbox's live state (`worker-name`), with pod diagnostics (restarts, failure reason) |
| `sandbox-delete` | delete a sandbox (pod + service + secret) |
| `list-oci-images` | browse OCI images; `owner="sandbox"` lists the deployable sandbox images |

### sandbox-* execution (agent-worker, `worker-name` required)

| Tool | Worker RPC | Notes |
|---|---|---|
| `sandbox-info` | `Info` | os/arch/shell/workspace/home/boot_id **+ probed capabilities** (desktop/display, noVNC, `xa11y`, distro) |
| `sandbox-exec` | `Execute` + `JobWait` loops + `JobOutput` | short tasks; waits ≤ `timeout` s (default 5, max 60). Always returns `job-id`; on completion up to 1000 lines, on timeout the **oldest 200** lines + "still running" |
| `sandbox-job-start` | `Execute` | fire-and-forget long task; returns `job-id` only |
| `sandbox-job-output` | `JobOutput` | `offset` (negative = from end) + `limit` (default 200, max 1000), `stream`; display capped at 1000 lines / 120 KiB |
| `sandbox-job-wait` | `JobWait` loops | waits ≤ `timeout` s (default 60, max 300); returns the latest 200 lines |
| `sandbox-job-kill` | `JobKill` | process-tree kill |
| `sandbox-job-stdin` | `JobStdin` | write/close a job's stdin |
| `sandbox-job-list` | `ListJobs` | id/state/exit/command |

### sandbox-* files (`worker-name` required)

| Tool | Notes |
|---|---|
| `sandbox-file-read` | text-only, `offset`/`limit` (default 200, max 1000), **line-numbered**, truncation marker; binary → error |
| `sandbox-file-patch` | apply a multi-file `*** Begin Patch`/`*** End Patch` patch in ONE call — the way to create, edit, and delete files; atomic (all hunks must match) |
| `sandbox-file-ls` | breadth-first tree levels 1..`depth` (default 3), `limit` default 200 / max 1000 |
| `sandbox-file-download` | agent `file:<code>` → workspace path |
| `sandbox-file-upload` | workspace path → agent `file:<code>` (agent derives the MIME) |
| `sandbox-checkout` | Forgejo archive(`.tar.gz`) → worker `SyncFolder`; `clean=false` (default) keeps sandbox-only files |
| `sandbox-submit-mr` | diff the sandbox repo dir (`path`) vs `base` and submit the change set as an MR — the ONLY write path; honors `.gitignore`, caps at 20 MiB total |

### sandbox-computer-* (GUI, `worker-name` required)

Drive a GUI sandbox's **native apps** through the platform accessibility tree —
prefer these over pixel coordinates. They require a GUI image (see
`sandbox-info` `capabilities`); on a plain `sandbox-<lang>` image the call fails
with an actionable error.

| Tool | Notes |
|---|---|
| `sandbox-computer-apps` | running apps whose a11y tree is visible (focused marked); Android = foreground package/activity |
| `sandbox-computer-snapshot` | a11y tree of an app (or the whole desktop); each element gets a stable `ref` — **prefer over a screenshot to locate elements** |
| `sandbox-computer-find` | match a CSS-like a11y selector; optional `center`/`bounds` output |
| `sandbox-computer-action` | a11y action on a `ref`/selector (press/focus/toggle/select/expand/collapse/set-value/type-text/scroll-into-view) |
| `sandbox-computer-click` / `-scroll` / `-drag` | coordinate input (fallback for canvas/unknown widgets) |
| `sandbox-computer-type` / `-key` | keyboard input |
| `sandbox-computer-screenshot` | PNG → `file:<code>` (use to SEE rendering, not to locate elements) |

### repo-* (Forgejo, via the gateway)

Address args: `org`, `repo`, and optional `ref` (branch / sha / tag; omitted =
the repository default branch).

**Content (read-only + MR)**

| Tool | Notes |
|---|---|
| `repo-explore` | list orgs, or an org's repos + branches (private included); optional `keyword` |
| `repo-create-org` / `repo-create-repo` | create an organization / a repository (optional `auto-init` + `default-branch`) |
| `repo-import` / `repo-remove` | import a remote repo / delete a repo |
| `repo-set-push-mirror` / `repo-list-push-mirrors` / `repo-delete-push-mirror` | manage push mirrors |
| `repo-build-image` / `oci-import` | build an image from a repo Dockerfile / mirror an upstream image |
| `repo-file-read` / `repo-file-list` | line-numbered text window / list a directory (or a file) at a ref |

**History / refs / collaboration**

| Tool | Notes |
|---|---|
| `repo-log` / `repo-show` / `repo-diff` | commit history / one commit + patch / compare two refs (`base...head`) |
| `repo-branches` / `repo-tags` / `repo-tag-create` | branches / tags |
| `repo-mr-list` / `repo-mr-comment` / `repo-mr-merge` / `repo-mr-close` | pull requests; merge/close allowed ONLY when the MR's `base` is your own branch |
| `repo-mail-send` | message any real branch session (peers; cross-repo allowed; never an `mr/...` branch) |

### service-* / helm-* / pvc-* (via the gateway)

| Tool | Notes |
|---|---|
| `service-deploy` / `service-list` / `service-delete` / `service-logs` | run a user image as a long-lived Deployment + Service; blue/green slots |
| `service-promote` / `service-rollback` | switch the service's public address between blue/green slots |
| `helm-deploy` / `helm-list` / `helm-history` / `helm-rollback` / `helm-uninstall` | render + apply a repo chart as a Helm release (one object per revision) |
| `helm-promote` / `helm-rollback-release` | blue/green slot promotion for a Helm release |
| `pvc-create` / `pvc-list` / `pvc-delete` | admin-managed storage for services |

## Configuration

| Config | Used by | Meaning |
|---|---|---|
| `gateway-url` | every tool | workspace-gateway base URL |
| `gateway-token` | every tool | service token the gateway requires |

The gateway owns the Forgejo credentials and the Kubernetes backend, so no other
config is needed.

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
agent-worker over a **real** NATS broker; `tests/e2e.repo.live.test.ts` drives
the `repo-*` tools against a **real** Forgejo (and the bridge against both).
Both are skipped unless their env vars are set. They serve the extension exactly
as production does and use a real `Agent` role to discover it and push config
through the config authority.

```bash
# sandbox
LIVE_NATS_URL=nats://<nats>:4222 WORKER_URL=http://<agent-worker> WORKER_TOKEN=<bearer> \
  npx vitest run tests/e2e.live.test.ts

# repo (+ optional bridge)
LIVE_NATS_URL=nats://<nats>:4222 FORGEJO_URL=http://<forgejo> FORGEJO_TOKEN=<pat> \
  E2E_ORG=<org> E2E_REPO=<repo> \
  [WORKER_URL=http://<agent-worker> WORKER_TOKEN=<bearer>] \
  npx vitest run tests/e2e.repo.live.test.ts
```

The worker must run with a bearer token set (`WORKER_TOKEN`) so the auth gate is
exercised; `WORKER_REQUIRE_AUTH=0` dev workers also work with an empty token.

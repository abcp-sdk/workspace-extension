# Developing workspace-extension

Developer notes for this repo. See `README.md` for the user/deployer view.

## Build & test

```bash
npm install
npm run check          # tsc --noEmit
npm test               # vitest run (needs nats-server on PATH or ABC_NATS_SERVER_BIN)
npm run build          # tsc --emitDeclarationOnly + esbuild -> dist/main.js
./build-image.sh       # buildkitd -> forgejo OCI (in-cluster only; see below)
```

`npm test` needs a real `nats-server` binary: `tests/registration.test.ts` boots
one in-process via the SDK. In a sandbox with no package, fetch it once (the
public GitHub release is reachable directly; the SDK accepts `ABC_NATS_SERVER_BIN`
too):

```sh
curl -fsSL -o /tmp/nats.tar.gz \
  https://github.com/nats-io/nats-server/releases/download/v2.10.22/nats-server-v2.10.22-linux-amd64.tar.gz
tar -xzf /tmp/nats.tar.gz -C /tmp && cp /tmp/nats-server-v2.10.22-linux-amd64/nats-server /usr/local/bin/
```

`build-image.sh` needs the in-cluster `buildkitd` (not reachable from a sandbox).
To build the image from a sandbox, use the platform's `repo-build-image` (the
gateway runs buildkitd server-side) with the same Dockerfile and these build
args: `REGISTRY`, `HTTP_PROXY`/`HTTPS_PROXY` (mihomo), and a `NO_PROXY` that
includes `.svc.cluster.local`.

## Vendored protos (the worker contract can drift)

`src/gen/` holds three vendored `@bufbuild/protobuf` `codegenv2` TS outputs:

| File | Source of truth | How to regenerate |
|---|---|---|
| `worker/v1/worker_pb.ts` | **`abc-protocol/worker`** `proto/worker/v1/worker.proto` | `npx @bufbuild/buf generate` with a `buf.build/bufbuild/es` (`target=ts`) template in that repo's `proto/`; copy the output |
| `workspace/v1/workspace_pb.ts` | `coding-workspace/workspace-gateway` `proto/workspace/v1/workspace.proto` | `buf generate --template buf.gen.es.yaml` in the gateway's `proto/`; copy `gen/es/workspace/v1/` |
| `agent/v1/agent_pb.ts` | the agent proto the gateway vendors | regenerate with the gateway's `buf.gen.es.yaml` (it imports `agent.v1`) |

**Do NOT** vendor `worker_pb.ts` from `workspace-gateway`'s `gen/es/worker/v1`:
that mirror can lag the worker repo (it lacked `InfoResponse.capabilities` at
one point, so `sandbox-info` could not report capabilities). Always regenerate
from `abc-protocol/worker`. See `src/gen/README.md` for the exact command.

Regenerating `worker_pb.ts` also bumps the `protoc-gen-es` version in the header
and rewrites the embedded `fileDesc` — that is expected.

## The sandbox image chain (a worker change needs new images)

```
abc-protocol/worker
  agent-toolchain/toolchain-<lang>   (generic dev image, NO worker)
        │  sandbox-images/build.sh  (cross-compiles agent-worker, bakes it in)
        ▼
  sandbox/sandbox-<lang>:debian-trixie   (the ONLY images a sandbox may run)
```

The workspace gateway refuses any sandbox image whose registry org is not
`SANDBOX_ORG` (default `sandbox`), because only those carry `agent-worker`. So
**any worker change requires rebuilding the `sandbox-*` images** (`build.sh`),
not just the toolchain ones. The gateway never injects the worker at launch.

`sandbox-desktop:openbox`, `sandbox-windows:*`, `sandbox-macos:*` and
`sandbox-android:*` are built by `abc-protocol/worker`'s
`agent-toolchain/{desktop,vm,android}` trees (KVM via the device plugin; see
that repo's `AGENTS.md`).

## Capabilities & computer-use (a11y)

The worker probes its IMAGE at request time and returns `InfoResponse.capabilities`
(`desktop`, `display`, `novnc`, `novnc_port`, `xa11y`, `distro`). This is the
supported way to decide whether a sandbox can be driven graphically:

- `xa11y=true` — the `xa11y` accessibility CLI is on PATH (Linux X11/AT-SPI2;
  Windows UI Automation; macOS AXUIElement). Present in `sandbox-desktop:openbox`
  and the Windows/macOS VM images.
- `desktop`/`display` — an X11 or Wayland desktop is up (jobs inherit `DISPLAY`
  / `WAYLAND_DISPLAY`).
- Android sandboxes expose `adb`/`uiautomator` instead of `xa11y`.

`sandbox-info` surfaces these; a missing capability means "not detected", not
"impossible". The `worker-extension` repo holds the reference `computer-*`
implementation (`src/computer/`) if the GUI tools are ported here.

## Artifact package-source injection (gateway-owned)

Sandboxes fetch packages from the in-cluster **artifact** registry instead of the
public internet, injected by the **workspace gateway** (not this extension):

- `internal/runtimeprofiles.PackageEnv` → env vars (pip/npm/go/cargo/pub/hex);
- `internal/sandboxbootstrap.Build` → an init container that writes config files
  (apt/apk/maven/gradle/pip/cargo/SPM/nuget/git) into shared emptyDirs overlaid
  on the worker's config dirs.

Controlled by the deployment value `gateway.sandbox.packageUpstream` (in
`coding-workspace/deploy`). Empty = no injection. Changing the URL is a values
change only (no image rebuild); it needs a gateway image that implements it.
Nothing in this repo needs to change to enable it.

## Conventions

- **All tool/config metadata lives in `manifest.yaml`** (descriptions + JSON
  schemas + `required_config`); `src/index.ts` supplies only `execute` handlers.
  `parseManifest`/`manifestConfig` join them. Bump the manifest `version` (and
  `EXT_VERSION` in `src/index.ts`) on a behavior change.
- **Every tool requires `gateway-url`/`gateway-token`** — the gateway is the only
  backend (Forgejo + Kubernetes + worker resolution). Do not add a config that
  holds a Forgejo token or worker URL.
- **Localize runtime text** through `src/i18n.ts` (`tr(locale, key, params)`);
  the catalog is typed, so a typo fails `tsc`. Tool descriptions are localized
  in `manifest.yaml` (`description` + `descriptions.zh`).
- **Typed failures** via `TypedToolError` (`invalid_argument` / `not_found` /
  `retryable` / `permission_denied` / `business` / `internal`), never a raw throw.
- **`~` is expanded client-side** (`expandPathArgs` + `workerAnchors`) before a
  path reaches the worker, which does not expand it.
- **A branch changes ONLY via `sandbox-submit-mr`**; there is no direct-write
  tool. `main` changes only by merging an MR.

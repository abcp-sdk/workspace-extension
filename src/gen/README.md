# Generated code (vendored)

- `worker/v1/worker_pb.ts` — the easyworker Connect contract (`WorkerService`).
  Vendored verbatim from `easylab-platform/proto/gen/es/worker/v1/worker_pb.ts`
  (only the `fileDesc` go_package string differs). Used by the sandbox
  execution tools (execute/jobs/files/sync).
- `workspace/v1/workspace_pb.ts` — the workspace gateway contract. The gateway
  owns the sandbox + service lifecycle IN-PROCESS (the old standalone
  worker-manager was folded into it), so `sandbox-*`/`service-*` lifecycle
  tools call `workspace.v1`. Regenerate from `workspace-gateway/proto`
  (`buf generate --template buf.gen.es.yaml`) and copy
  `gen/es/workspace/v1/workspace_pb.ts` here. It imports `agent.v1`, so
  `agent/v1/agent_pb.ts` is vendored too.
- `agent/v1/agent_pb.ts` — `agent.v1` message types imported by
  `workspace_pb.ts` (for the forwarded chat/config/file RPCs).

# Generated code (vendored)

- `worker/v1/worker_pb.ts` — the `worker.v1` Connect contract (`WorkerService`).
  Vendored from the SOURCE repo **`abc-protocol/worker`**
  (`proto/worker/v1/worker.proto`), regenerated with
  `buf generate --template buf.gen.worker.yaml` using the `buf.build/bufbuild/es`
  plugin (`target=ts`). Only the `fileDesc` go_package string differs from the Go
  output. Used by the sandbox execution tools (execute/jobs/files/sync) and by
  `sandbox-info` (which reads `InfoResponse.capabilities`).

  Do NOT vendor this from `workspace-gateway`'s `gen/es/worker/v1` — that copy is
  a convenience mirror that can lag the worker repo (it lacked `Capabilities` at
  one point). Regenerate from `abc-protocol/worker`:

  ```sh
  # in a checkout of abc-protocol/worker
  cd proto
  cat > /tmp/buf.gen.es.yaml <<'EOF'
  version: v2
  plugins:
    - remote: buf.build/bufbuild/es
      out: ../gen/es
      opt: target=ts
  EOF
  npx --yes @bufbuild/buf generate --template /tmp/buf.gen.es.yaml
  # copy gen/es/worker/v1/worker_pb.ts into this directory
  ```

- `workspace/v1/workspace_pb.ts` — the workspace-gateway contract. The gateway
  owns the sandbox + service lifecycle IN-PROCESS (the old standalone
  worker-manager was folded into it), so `sandbox-*`/`service-*` lifecycle tools
  call `workspace.v1`. Regenerate from `coding-workspace/workspace-gateway/proto`
  (`buf generate --template buf.gen.es.yaml`) and copy
  `gen/es/workspace/v1/workspace_pb.ts` here. It imports `agent.v1`, so
  `agent/v1/agent_pb.ts` is vendored too.
- `agent/v1/agent_pb.ts` — `agent.v1` message types imported by
  `workspace_pb.ts` (for the forwarded chat/config/file RPCs).

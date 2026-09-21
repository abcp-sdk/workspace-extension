# syntax=docker/dockerfile:1
# The extension talks Connect RPC to a REMOTE easyworker over HTTP, so the
# image only needs Node + the bundled ESM entrypoint. The build runs esbuild so
# the runtime image needs no transpiler: `@abc-protocol/sdk` is a git dependency
# that ships raw `.ts`, which the container's Node cannot execute directly.
ARG REGISTRY=docker.io
FROM ${REGISTRY}/root/node:26-alpine AS build
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    NO_PROXY=localhost,127.0.0.1,.svc.cluster.local,.svc
WORKDIR /build
# git fetches the public `github:` git dependencies (the SDK ships raw TS and
# is not on a registry); the https rewrite means no SSH key is needed.
RUN apk add --no-cache git \
    && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
    && git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/"
COPY package.json package-lock.json .npmrc tsconfig.json ./
COPY scripts scripts
COPY src src
RUN npm install --no-audit --strict-ssl=false && npm run build

FROM ${REGISTRY}/root/alpine:3.24
# Keep the official CDN (no aliyun swap: it benchmarked ~25 KB/s and stalled the
# build). `apk` honors the LOWERCASE proxy variables.
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV http_proxy=${HTTP_PROXY} https_proxy=${HTTPS_PROXY}
RUN apk add --no-cache ca-certificates nodejs
WORKDIR /app
COPY --from=build /build/dist/main.js dist/main.js
COPY --from=build /build/package.json package.json
EXPOSE 8080
CMD ["node", "dist/main.js"]

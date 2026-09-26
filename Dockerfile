# Build the UI static export
FROM --platform=$BUILDPLATFORM node:26-alpine AS ui-builder
WORKDIR /ui

# Install deps first (layer cached unless package.json changes)
COPY ui/package*.json ui/tsconfig*.json ./
COPY ui/next.config.* ./
RUN npm ci

# Build the UI
COPY ui/ .
RUN npm run build

# Build the manager binary
FROM --platform=$BUILDPLATFORM golang:1.26 AS builder
ARG TARGETOS
ARG TARGETARCH
# Build identity — stamped into every served endpoint (GetSystemStatus,
# paprika_build_info, MCP initialize). Release builds pass the tag.
ARG VERSION=dev
ARG GIT_COMMIT=none
ARG BUILD_DATE=unknown

WORKDIR /workspace
# Copy the Go Modules manifests
COPY go.mod go.mod
COPY go.sum go.sum
# cache deps before building and copying source so that we don't need to re-download as much
# and so that source changes don't invalidate our downloaded layer
RUN go mod download

# Copy the Go source (relies on .dockerignore to filter)
COPY . .

# Copy the UI static export into the embed directory
COPY --from=ui-builder /ui/out/ internal/api/uistatic/

# Build
# Docker buildx supplies TARGETARCH in CI. The amd64 fallback keeps local builds
# compatible with the current VKE node architecture.
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build -trimpath -ldflags="-s -w -X github.com/benebsworth/paprika/internal/version.Version=${VERSION} -X github.com/benebsworth/paprika/internal/version.Commit=${GIT_COMMIT} -X github.com/benebsworth/paprika/internal/version.Date=${BUILD_DATE}" -a -o manager ./cmd

# Alpine: runtime needs ca-certificates for outbound TLS and tar (busybox)
# for S3 archives. All git/helm work is in-process (go-git, Helm SDK) — no
# binaries are exec'd.
FROM alpine:3.24
WORKDIR /
RUN apk add --no-cache ca-certificates && \
    addgroup -S -g 65532 nonroot && \
    adduser -S -D -H -u 65532 -G nonroot nonroot
COPY --from=builder /workspace/manager .
COPY --from=builder /workspace/charts /charts
ENV HELM_CACHE_HOME=/tmp/helm/cache \
    HELM_CONFIG_HOME=/tmp/helm/config \
    HELM_DATA_HOME=/tmp/helm/data
USER 65532:65532

ENTRYPOINT ["/manager"]

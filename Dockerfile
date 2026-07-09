# Build the UI static export
FROM node:26-alpine AS ui-builder
WORKDIR /ui

# Install deps first (layer cached unless package.json changes)
COPY ui/package*.json ui/tsconfig*.json ./
COPY ui/next.config.* ./
RUN npm ci

# Build the UI
COPY ui/ .
RUN npm run build

# Build the manager binary
FROM golang:1.26 AS builder
ARG TARGETOS
ARG TARGETARCH

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
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build -trimpath -ldflags="-s -w" -a -o manager ./cmd

# Install helm in a separate stage
FROM alpine:3.24 AS helm-builder
RUN apk add --no-cache curl && \
    ARCH=$(uname -m | sed 's/aarch64/arm64/' | sed 's/x86_64/amd64/') && \
    curl -fsSL https://get.helm.sh/helm-v3.16.1-linux-${ARCH}.tar.gz -o /tmp/helm.tar.gz && \
    tar -xzf /tmp/helm.tar.gz -C /tmp && \
    mv /tmp/linux-${ARCH}/helm /helm

# Use Alpine so the repo-backed renderer can execute git while keeping the
# runtime image small and non-root.
FROM alpine:3.24
WORKDIR /
RUN apk add --no-cache ca-certificates git && \
    addgroup -S -g 65532 nonroot && \
    adduser -S -D -H -u 65532 -G nonroot nonroot
COPY --from=builder /workspace/manager .
COPY --from=builder /workspace/charts /charts
COPY --from=helm-builder /helm /usr/local/bin/helm
ENV HELM_CACHE_HOME=/tmp/helm/cache \
    HELM_CONFIG_HOME=/tmp/helm/config \
    HELM_DATA_HOME=/tmp/helm/data
USER 65532:65532

ENTRYPOINT ["/manager"]

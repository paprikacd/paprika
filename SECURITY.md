# Security Policy

## Reporting a Vulnerability

We take the security of paprika seriously. If you discover a security vulnerability, please report it privately.

**Do not report security vulnerabilities via public GitHub issues.**

Instead, send an email to **benebsworth@gmail.com** with:

- A description of the vulnerability
- Steps to reproduce it
- Affected versions (if known)
- Any potential mitigations

You should receive a response within 48 hours. If you don't, please follow up.

## What to Expect

- We will acknowledge receipt of your report within 48 hours
- We will investigate and provide a timeline for a fix
- We will notify you when the fix is deployed
- We will credit you in the release notes (unless you prefer to remain anonymous)

## Scope

This security policy covers the paprika operator and its components:

- The operator binary (`/manager`)
- API server mode (`--mode=api`)
- All CRDs and webhooks
- The Next.js dashboard UI (`ui/`)
- The Helm chart and Kustomize deployment manifests

## Out of Scope

- Dependencies with known CVEs (reported to the respective maintainers)
- Kubernetes cluster misconfiguration (follow [CIS benchmarks](https://www.cisecurity.org/benchmark/kubernetes))
- Issues requiring physical access to the cluster

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| latest  | :white_check_mark: |
| < latest| :x:                |

We only support the latest release. Always upgrade to the most recent version.

## Security Best Practices

When deploying paprika in production:

1. **Enable webhooks** — Admission validation prevents misconfigured CRDs
2. **Use TLS** — Webhook certificates are managed by cert-manager
3. **Restrict RBAC** — The operator requires specific permissions; don't grant cluster-admin
4. **Set resource limits** — Default limits are `500m CPU / 128Mi memory` per container
5. **Run as non-root** — The container runs as `uid:65532` with `readOnlyRootFilesystem: true`
6. **Pin image tags** — Use specific version tags, not `latest`, in production
7. **Network policies** — Restrict egress from the operator namespace
8. **Audit logging** — Enable Kubernetes audit logging to track operator API calls

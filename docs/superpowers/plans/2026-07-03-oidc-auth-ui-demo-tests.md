# OIDC Auth + UI + Demo + E2E Tests — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google OIDC login (PKCE), improve UI, build a demo app, add E2E tests.

**Architecture:** PKCE flow — frontend initiates OIDC via backend `/auth/login`, callback handled client-side, token exchange proxied through backend `/auth/token` to keep client secret server-side. Existing `OIDCAuthenticator` validates Bearer ID tokens. Demo app upgraded to multi-version HTTP server deployed via Paprika resources.

**Tech Stack:** Go (net/http + OIDC), Next.js 16 static export, shadcn/ui, Playwright, ginkgo

---

## Chunk 1: Backend Auth Handlers

**Files:**
- Create: `internal/api/auth/token_handler.go`
- Create: `internal/api/auth/login_handler.go`
- Modify: `internal/api/auth/middleware.go` (public routes)
- Modify: `internal/api/server.go` (register handlers)

- [ ] Write `login_handler.go` — `GET /auth/login` generates PKCE params, returns Google auth URL
- [ ] Write `token_handler.go` — `POST /auth/token` proxies code exchange to Google, returns tokens
- [ ] Update `middleware.go` — add public route exception list (auth/login, auth/token, healthz, readyz, /)
- [ ] Update `server.go` — register auth handlers when auth.enabled && oidc.enabled
- [ ] Run `make test` to verify backend tests pass

## Chunk 2: Demo App Upgrade

**Files:**
- Modify: `demo/main.go` — multiversion, X-Version header, HTML root page
- Modify: `demo/Dockerfile` — update for new app
- Create: `demo/k8s/` manifests

- [ ] Rewrite `demo/main.go` with `--version` flag, health endpoint, HTML root
- [ ] Update `demo/Dockerfile` if needed
- [ ] Create `demo/k8s/deployment.yaml`, `service.yaml`
- [ ] Create `demo/k8s/application.yaml`, `pipeline.yaml`
- [ ] Build and verify: `docker build -t paprika-demo demo/`

## Chunk 3: Frontend Auth

**Files:**
- Create: `ui/src/lib/auth-context.tsx`
- Create: `ui/src/app/login/page.tsx`
- Create: `ui/src/app/auth/callback/page.tsx`
- Modify: `ui/src/components/layout/nav.tsx`
- Modify: `ui/src/app/layout.tsx`
- Modify: `ui/src/app/dashboard/page.tsx`

- [ ] Create `auth-context.tsx` — AuthProvider, useAuth hook, token management
- [ ] Create login page — "Sign in with Google" button → backend `/auth/login`
- [ ] Create callback page — exchange code for token via `/auth/token`
- [ ] Update `layout.tsx` — wrap with AuthProvider
- [ ] Update `nav.tsx` — user menu / sign-in button
- [ ] Update dashboard — auth gate
- [ ] Run `npm test` in ui/ to verify existing tests still pass

## Chunk 4: E2E Tests + Deploy

**Files:**
- Create: `test/e2e/auth_test.go`
- Create: `ui/e2e/login.spec.ts`
- Modify: `deploy/test-values.yaml`
- Modify: `hack/e2e-vultr.sh`

- [ ] Write Go e2e test for `/auth/token` endpoint
- [ ] Set up Playwright in ui/ and write login spec
- [ ] Update test-values.yaml with auth + demo app enabled
- [ ] Deploy to VKE and verify end-to-end

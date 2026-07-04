# OIDC Auth + Improved UI + Demo App + E2E Tests

## Overview

Add Google OIDC login (PKCE), polish the frontend, build a useful demo app, and add E2E tests for the full auth flow and UI functionality.

## 1. Google OIDC Login (PKCE flow)

### Architecture

```
Browser                         Google                     Backend
  │                               │                          │
  │── GET /auth/login ────────────│─────────────────────────►│  (generate state + PKCE)
  │◄── 302 Google accounts URL ──│──────────────────────────│
  │── Redirect───────────────────│                          │
  │                               │                          │
  │◄── Redirect /auth/callback?code=X&state=Y              │
  │                                                          │
  │── POST /auth/token ──────────│─────────────────────────►│  (backchannel: code + secret)
  │                              │── code+secret+verifier ──│
  │◄── {id_token, access_token} ─│──────────────────────────│
  │                                                          │
  │── GET /api/* (Bearer id_token) ───────────────────────►│  (OIDCAuthenticator validates)
```

### Backend changes (`internal/api/auth/`)

**New file: `token_handler.go`**
- `POST /auth/token` — accepts `{code, code_verifier, redirect_uri}`, exchanges with Google token endpoint using client_secret
- Returns `{id_token, access_token, expires_in}`
- Validates the ID token before returning it (ensures it's valid at exchange time)

**New file: `login_handler.go`**
- `GET /auth/login` — generates PKCE challenge + state, returns JSON `{url, code_verifier, state}` (or redirects)
- This is called by the frontend before redirecting to Google

**Changes to existing files:**
- `middleware.go` — add public routes (no auth required): `/auth/login`, `/auth/callback`, `/auth/token`, `/healthz`, `/readyz`, `/` (landing page assets)
- `oidc_auth.go` — already validates Bearer ID tokens via JWKS; no changes needed

### Frontend changes (`ui/`)

**New: `src/lib/auth-context.tsx`**
- `AuthProvider` wrapping connection context
- `useAuth()` hook returning: `{user, isAuthenticated, login, logout, getToken}`
- Stores ID token in memory (not localStorage — XSS-safe)
- On 401 responses, clears token, redirects to `/login`

**New: `src/app/login/page.tsx`**
- Shows "Sign in with Google" button
- Calls backend `/auth/login` to get the Google auth URL + PKCE params
- Redirects to Google (stores PKCE verifier in sessionStorage for callback)

**New: `src/app/auth/callback/page.tsx`**
- Reads `code` + `state` from URL params
- Exchanges code for token via `POST /auth/token` (sends code_verifier from sessionStorage)
- Stores ID token in AuthContext
- Redirects to `/dashboard`

**Modified: `src/components/layout/nav.tsx`**
- When authenticated: show user avatar, name, dropdown with logout
- When not: show "Sign in" button

**Modified: `src/app/dashboard/page.tsx`**
- Auth-gated: redirect to `/login` if not authenticated (when auth is enabled)
- When auth disabled: works as before (no gate)

### Token expiry
- Backend returns `expires_in` from the token exchange
- Frontend sets a timer to refresh (using the access_token or re-login)
- On 401 from any API call, redirect to `/login`

## 2. Improved UI

### Auth gate pattern
- `auth.enabled=true` in config → frontend requires login for `/dashboard/*`
- `auth.enabled=false` → no auth gate, current behavior unchanged
- Landing page (`/`) always public (marketing content)

### Dashboard polish
- Loading skeletons for dashboard stat cards (replace current empty flash)
- Empty states for pipelines/applications lists
- Error boundaries with retry buttons
- User menu in nav bar showing OIDC claims (name, email, avatar)

### Responsiveness
- Ensure nav collapses on mobile
- Dashboard cards reflow to single column on small screens

## 3. Demo App

### Upgraded `demo/main.go`
- Multiversion: accepts `--version` flag
- Returns `X-Version` response header
- Configurable health endpoint: `GET /health` returns `{"status":"ok","version":"X.Y.Z"}`
- Root returns an HTML page showing version + app name (for visual verification)

### Kubernetes manifests (`demo/k8s/`)
- `deployment.yaml` — Deployment with image tag, version env var
- `service.yaml` — ClusterIP service
- `application.yaml` — Paprika Application CRD (references the service + deployment)
- `pipeline.yaml` — Paprika Pipeline with a simple rollout stage

### Helm integration
- New chart values section for demo app
- Optional deployment alongside paprika (disabled by default, enabled in test-values)
- Deploy to same namespace

## 4. E2E Tests

### Go tests (`test/e2e/`)
- **auth_test.go** — tests `POST /auth/token` with mock/mimicked Google response
- Uses the existing ginkgo suite
- Validates: token endpoint returns proper response, invalid codes rejected

### Playwright tests (`ui/e2e/`)
- Install Playwright as dev dependency
- **login.spec.ts** — login page renders, redirect URL contains Google accounts
- **dashboard-auth.spec.ts** — unauthenticated access redirected to login, authenticated access shows dashboard
- **user-menu.spec.ts** — user menu shows OIDC claims after login
- Mock the OIDC token exchange for tests (no real Google dependency)

### VKE e2e harness update (`hack/e2e-vultr.sh`)
- Enable auth in test-values.yaml
- Add test step: deploy demo app via Paprika API (authenticated request)
- Verify: demo app returns expected version, canary rollout succeeds

## Files to Create/Modify

### New files
- `internal/api/auth/token_handler.go` — POST /auth/token endpoint
- `internal/api/auth/login_handler.go` — GET /auth/login endpoint
- `ui/src/lib/auth-context.tsx` — React auth context + provider
- `ui/src/app/login/page.tsx` — Login page
- `ui/src/app/auth/callback/page.tsx` — OIDC callback handler
- `demo/main.go` — (replace) upgraded demo app
- `demo/k8s/deployment.yaml` — demo k8s manifest
- `demo/k8s/service.yaml`
- `demo/k8s/application.yaml` — Paprika Application CR
- `demo/k8s/pipeline.yaml` — Paprika Pipeline CR
- `ui/e2e/login.spec.ts` — Playwright auth test
- `test/e2e/auth_test.go` — Go auth endpoint test

### Modified files
- `internal/api/server.go` — register auth handlers (when auth enabled)
- `internal/api/auth/middleware.go` — add public routes exception list
- `ui/src/components/layout/nav.tsx` — user menu / sign in
- `ui/src/app/dashboard/page.tsx` — auth gate
- `ui/src/app/layout.tsx` — wrap with AuthProvider
- `deploy/test-values.yaml` — enable auth, demo app
- `charts/chart/values.yaml` — demo app section
- `hack/e2e-vultr.sh` — demo app deploy step
- `charts/chart/NOTES.txt` — auth section

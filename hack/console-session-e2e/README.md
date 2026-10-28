# Console session browser validation

Run from `ui/`:

```sh
npm run test:e2e:session
```

The runner builds this Go fixture into a private temporary directory and starts
its own Next dev server, console server, and OIDC issuer on dynamically assigned
`127.0.0.1` ports. It prints those three URLs. It does not use port 3015, a
Kubernetes context, a real Google account, an existing Chrome profile, or a
production token. Owned processes and private session files are cleaned up when
the run finishes.

To validate the production static export, as CI does:

```sh
npm run build
SESSION_E2E_STATIC=1 npm run test:e2e:session
```

To reuse an existing **loopback** frontend server, set
`SESSION_E2E_UI_URL=http://127.0.0.1:<port>`. Set `PLAYWRIGHT_BROWSERS_PATH` to an
existing Playwright browser cache when needed. Results and screenshots go to
`ui/test-results/console-session/`; override with `SESSION_E2E_OUTPUT`. During
debugging, `SESSION_E2E_FILTER=<scenario name substring>` runs only matching
scenarios. CI always runs the full suite.

The console login, callback exchange, refresh, logout, public configuration, and
JWT verification use production handlers. The issuer signs real RS256 JWTs,
checks PKCE, rotates refresh tokens, and records request counts. Private fixture
controls simulate expired access tokens, revoked grants, delayed refreshes, and
temporary provider failures. Browser contexts start with no authentication;
storage-state restoration uses only the session created by that test.

Dashboard data is intentionally empty. This suite validates session behavior,
not provider queries. The Observe consent endpoint is a destination fixture
used to verify exact return URL preservation; the separate Observe/MCP E2E
suite validates real consent and authoring behavior.

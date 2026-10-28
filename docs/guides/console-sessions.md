# Returning to the Paprika console

Paprika remembers the last successful sign-in method and the account name, email,
and HTTPS avatar in this browser. The login screen marks the method **Last used**,
offers **Continue as…**, and lets the user choose another account or forget the
remembered profile. This preference is display-only; it never grants access.
Paprika cannot inspect the private Chrome profile. For Google, the remembered
email is sent as `login_hint`, while account switching requests the provider's
account chooser.

A valid console bearer token opens the requested page directly. The shared browser
session manager renews an expiring session before protected requests, and on focus
or reconnect. Concurrent requests share renewal; supported browsers coordinate
across tabs with Web Locks. A temporary network or provider failure offers retry
without deleting the remembered profile. Definitively expired grants return to
sign-in with the original dashboard, filters, time range, fragment, or Observe
consent destination preserved.

## Refresh credentials

The console's `/auth/token` exchange may issue a persistent HttpOnly cookie scoped
to `/auth`. Its provider refresh credential is AES-GCM encrypted with a
purpose-separated key derived from the existing server token secret and bound to
the OIDC issuer and client. HTTPS deployments set Secure; SameSite is Lax. Browser
refresh and logout require the configured UI origin and `X-Paprika-Session: 1`.
Responses are `Cache-Control: no-store`; refresh credentials never appear in
browser JavaScript or JSON responses.

The cookie expires seven days after sign-in; renewal and provider credential
rotation do not extend that deadline. Every returned ID token is verified and must
retain the grant's issuer, subject, and audience. Invalid grants clear the cookie.
Provider and verification-service outages retain it while withholding any new
bearer token. Deployments without a configured signing secret do not offer renewal.
No database or chart configuration is required beyond the existing token secret
and trusted OIDC callback URL.

Google offline access may require existing users to approve a new grant once.
Consent is requested when a browser has no usable renewal grant or explicitly
switches accounts, rather than on every returning visit. Other OIDC providers use
`offline_access` when advertised or configured. Providers that do not issue a
refresh token continue to work with normal interactive sign-in.

Logout clears the browser's cookie and protected client data, retaining the
non-authoritative **Last used** preference until the user forgets it. It does not
revoke an already issued bearer token, a copied cookie, or the provider's entire
grant. Provider revocation or server token-secret rotation invalidates renewal
outside this browser. The console refresh mechanism is separate from MCP OAuth
clients, scopes, token audiences, and refresh grants.

## Dashboard requests

Protected requests wait for session bootstrap. A renewed session may retry one
explicitly read-only request, including Insights provider queries. Mutating calls
are never automatically replayed: the user receives a retry message, and the
original document ETag still protects the next write. Snapshots survive ordinary
token rotation, but logout, account switches, and changes to identity or permission
claims invalidate protected caches. Anonymous example dashboards remain available.

## Verification

Run `npm run test:e2e:session` from `ui/` for the isolated browser suite. It uses
real Paprika auth handlers with a local signed OIDC issuer, PKCE, and private
fixture controls; no production credentials or Kubernetes cluster are used. See
`hack/console-session-e2e/README.md` for fixture modes and coverage boundaries.

Provider references:

- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [Google web-server OAuth and offline access](https://developers.google.com/identity/protocols/oauth2/web-server)
- [OpenID Connect refresh-token validation](https://openid.net/specs/openid-connect-core-1_0.html#RefreshTokens)

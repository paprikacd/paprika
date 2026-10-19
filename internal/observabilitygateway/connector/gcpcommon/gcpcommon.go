// Package gcpcommon carries the configuration, credential and HTTP mechanics
// shared by the Google Cloud observability connectors (Cloud Logging, Cloud
// Monitoring, Cloud Trace). It exists so each connector package holds only
// its backend's query-shape logic.
//
// Credentials are a Google credential JSON restricted to the service_account,
// external_account and impersonated_service_account types — the same
// restriction the GKE cluster provider applies (internal/clusterprovider/
// gke.go), checked before the document is loaded, which is the mitigation
// x/oauth2's deprecated untyped loader asks callers to perform — or empty for
// ambient identity (GKE Workload Identity, the metadata server, or
// GOOGLE_APPLICATION_CREDENTIALS).
//
// Project resolution: an explicit config projectId always wins. Otherwise
// the credential document's own project_id is used — service-account keys
// and external_account configs both carry one, which also covers ambient
// identity whose ADC resolution parses a JSON file. Pure-metadata ambient
// identity (a Workload-Identity pod without any JSON in-process) exposes no
// project without a metadata-server call, so that combination reports
// connector.ErrNotConfigured with a fixed sentence: operators there should
// set projectId in the provider config, which is also what pins cross-project
// queries to the intended project.
package gcpcommon

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// scopes is the read-only scope list requested for every GCP connector
// credential, so one token is valid whichever observability surface a query
// hits. The full list travels with every credential construction.
var scopes = []string{
	"https://www.googleapis.com/auth/logging.read",
	"https://www.googleapis.com/auth/monitoring.read",
	"https://www.googleapis.com/auth/trace.readonly",
}

// Keys the strict connector configuration document may carry. Anything else
// is a typo and fails fast at validation time.
const (
	configKeyProjectID       = "projectId"
	configKeyEndpoint        = "endpoint"
	configKeyInsecureSkipTLS = "insecureSkipTLS"
)

// Config is the decoded connector configuration document shared by the GCP
// connectors. ProjectID pins the GCP project when the credential document
// cannot supply one. Endpoint overrides the service's default
// www.googleapis.com base URL — it exists so in-cluster fakes and proxies
// can stand in for the real API, notably in the connector tests. The GCP
// connectors do not send extra request headers, so no "headers" key exists
// here; add it deliberately if a backend ever needs one.
//
// InsecureSkipTLS makes this connector's requests accept whatever
// certificate the backend presents, self-signed included. WARNING: this
// trades MITM protection for compatibility with self-signed in-cluster
// backends — never set it for endpoints outside the cluster.
type Config struct {
	ProjectID       string
	Endpoint        string
	InsecureSkipTLS bool
}

// ParseConfig decodes the strict GCP connector configuration document —
// the optional "projectId" string, the optional "endpoint" absolute http(s)
// URL and the optional "insecureSkipTLS" bool — and returns it as a Config.
// Unknown keys, wrong types and unusable values are errors naming the key
// but never its value: configuration values can carry credential material,
// so errors must stay safe to print.
//
// An absent document is valid: projectId can come from the credential
// document and every connector stores its service's default endpoint, so
// the zero Config is meaningful.
func ParseConfig(config json.RawMessage) (Config, error) {
	if len(bytes.TrimSpace(config)) == 0 {
		return Config{}, nil
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(config, &raw); err != nil {
		return Config{}, fmt.Errorf("config: invalid JSON document: %w", err)
	}
	for key := range raw {
		if !allowedConfigKey(key) {
			return Config{}, fmt.Errorf("config: unknown key %q", key)
		}
	}
	return decodeKeys(raw)
}

// allowedConfigKey reports whether key belongs to the strict document.
func allowedConfigKey(key string) bool {
	switch key {
	case configKeyProjectID, configKeyEndpoint, configKeyInsecureSkipTLS:
		return true
	default:
		return false
	}
}

// decodeKeys decodes the three known keys from raw into cfg, naming the key
// but never its value on a decode failure.
func decodeKeys(raw map[string]json.RawMessage) (Config, error) {
	var cfg Config
	if value, ok := raw[configKeyProjectID]; ok {
		if err := json.Unmarshal(value, &cfg.ProjectID); err != nil {
			return Config{}, fmt.Errorf("config: key %q must be a string", configKeyProjectID)
		}
	}
	if value, ok := raw[configKeyEndpoint]; ok {
		endpoint, err := decodeEndpoint(value)
		if err != nil {
			return Config{}, err
		}
		cfg.Endpoint = endpoint
	}
	if value, ok := raw[configKeyInsecureSkipTLS]; ok {
		if err := json.Unmarshal(value, &cfg.InsecureSkipTLS); err != nil {
			return Config{}, fmt.Errorf("config: key %q must be a bool", configKeyInsecureSkipTLS)
		}
	}
	return cfg, nil
}

// ValidateConfig checks the strict connector configuration document ahead
// of use, before it is ever passed to a Query call.
func ValidateConfig(config json.RawMessage) error {
	_, err := ParseConfig(config)
	return err
}

// decodeEndpoint validates the endpoint key's value: a string holding an
// absolute http(s) URL. The parse error text can quote the URL itself, which
// may embed userinfo credential material — so it is deliberately dropped and
// errors name only the key.
func decodeEndpoint(value json.RawMessage) (string, error) {
	var endpoint string
	if err := json.Unmarshal(value, &endpoint); err != nil {
		return "", fmt.Errorf("config: key %q must be a string", configKeyEndpoint)
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", fmt.Errorf("config: key %q must be an absolute http(s) URL", configKeyEndpoint)
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("config: key %q must not contain userinfo, query or fragment", configKeyEndpoint)
	}
	return endpoint, nil
}

// ResolveProject picks the GCP project a query targets. An explicit config
// projectId wins — it is also the only project source under pure-metadata
// ambient identity. Otherwise the credential document's own project_id is
// used; service-account keys and external_account configs both carry one.
// Neither available is connector.ErrNotConfigured: the integration is
// selected but no project can be named.
func ResolveProject(configured string, credentials []byte) (string, error) {
	if configured != "" {
		return configured, nil
	}
	var head struct {
		ProjectID string `json:"project_id"` //nolint:tagliatelle // Google credential documents use snake_case wire fields.
	}
	if err := json.Unmarshal(credentials, &head); err == nil && head.ProjectID != "" {
		return head.ProjectID, nil
	}
	return "", fmt.Errorf("%w: a projectId must be configured", connector.ErrNotConfigured)
}

// findDefaultCredentials is the ambient-identity lookup, behind a variable
// so tests can force its failure hermetically: the real probe consults the
// process environment and the link-local metadata address, which no env
// manipulation can neutralize on every host (setting GCE_METADATA_HOST
// makes metadata.OnGCE report true unconditionally, and a host on a real
// GCE VM would probe true regardless).
var findDefaultCredentials = google.FindDefaultCredentials

// Client turns the credential document into an HTTP client that carries a
// bearer token on every request. An empty document selects ambient identity
// via google.FindDefaultCredentials (GKE Workload Identity, the metadata
// server, or GOOGLE_APPLICATION_CREDENTIALS). A non-empty document must
// declare one of the accepted types on its head — checked before the
// document is loaded, per the x/oauth2 deprecation guidance — and is then
// loaded by google.CredentialsFromJSONWithType, which re-checks the declared
// type instead of accepting any document.
//
// ErrNoAmbientCredentials marks the case where no credential document was
// configured and the ambient lookup (GKE Workload Identity, metadata
// server, GOOGLE_APPLICATION_CREDENTIALS) found nothing. Connectors map it
// to StateNotConfigured: the backend was never contacted, so reporting a
// refusal would misdescribe what happened.
var ErrNoAmbientCredentials = errors.New("no Google application-default credentials found")

// ErrAmbientEndpointRefused marks a provider that names no credential
// document but points the connector at a host outside googleapis.com, over
// plain HTTP, or with TLS verification off. Ambient identity is the
// gateway's own, so its token goes only to Google over verified TLS; a
// custom endpoint needs its own credentialsSecretRef. Connectors map it to
// StateNotConfigured: nothing was sent.
var ErrAmbientEndpointRefused = errors.New("ambient Google credentials are sent only to googleapis.com over verified TLS")

// Token-source failures (an unreachable token endpoint, a refused grant)
// surface as request errors from the returned client, classified by Do —
// that is the honest report of what happened.
//
// cfg.InsecureSkipTLS applies only to backend API calls. OAuth token
// exchanges always verify certificates, including when the backend uses a
// local self-signed certificate.
func Client(ctx context.Context, cfg Config, credentials []byte) (*http.Client, error) {
	// Token exchanges must not follow redirects either: a 307/308 could
	// otherwise replay a signed JWT or federated credential to another host.
	ctx = context.WithValue(ctx, oauth2.HTTPClient, secureHTTPClient)
	var tokenSource oauth2.TokenSource
	var err error
	if len(bytes.TrimSpace(credentials)) == 0 {
		tokenSource, err = ambientTokenSource(ctx, cfg)
	} else {
		tokenSource, err = documentTokenSource(ctx, credentials)
	}
	if err != nil {
		return nil, err
	}

	client := oauth2.NewClient(ctx, tokenSource)
	if cfg.InsecureSkipTLS {
		client.Transport = &oauth2.Transport{Source: tokenSource, Base: insecureTransport}
	}
	client.CheckRedirect = httphelp.RejectRedirect
	return client, nil
}

// ambientTokenSource resolves the gateway's own Google identity, once
// checkAmbientEndpoint has established that cfg sends it only to Google.
func ambientTokenSource(ctx context.Context, cfg Config) (oauth2.TokenSource, error) {
	if err := checkAmbientEndpoint(cfg); err != nil {
		return nil, err
	}
	adc, err := findDefaultCredentials(ctx, scopes...)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrNoAmbientCredentials, err)
	}
	return adc.TokenSource, nil
}

// documentTokenSource loads a credential document of one of the accepted
// types, after checkFederatedCredential has pinned its token-bearing URLs.
func documentTokenSource(ctx context.Context, credentials []byte) (oauth2.TokenSource, error) {
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(credentials, &head); err != nil {
		return nil, fmt.Errorf("credential document is not valid JSON: %w", err)
	}
	switch head.Type {
	case string(google.ServiceAccount), string(google.ExternalAccount),
		string(google.ImpersonatedServiceAccount):
	default:
		return nil, errors.New("unsupported credential type; expected service_account, external_account or impersonated_service_account")
	}
	if err := checkFederatedCredential(credentials, 0); err != nil {
		return nil, err
	}
	creds, err := google.CredentialsFromJSONWithType(ctx, credentials, google.CredentialsType(head.Type), scopes...)
	if err != nil {
		// Credential loaders may quote a token URL or other fields.
		return nil, errors.New("parsing credential document failed")
	}
	return creds.TokenSource, nil
}

// checkAmbientEndpoint refuses to attach ambient identity to anything but a
// Google API host over verified TLS. Without it, a provider with no
// credentials and a custom endpoint would hand the gateway's own Google
// token to whatever host the endpoint names.
func checkAmbientEndpoint(cfg Config) error {
	if cfg.InsecureSkipTLS {
		return ErrAmbientEndpointRefused
	}
	if cfg.Endpoint == "" {
		return nil
	}
	u, err := url.Parse(cfg.Endpoint)
	if err != nil || u.Scheme != "https" || !googleAPIsHost(u.Hostname()) {
		return ErrAmbientEndpointRefused
	}
	return nil
}

func googleAPIsHost(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	return host == "googleapis.com" || strings.HasSuffix(host, ".googleapis.com")
}

// federatedCredential holds the fields of an external_account or
// impersonated_service_account document that decide where x/oauth2 sends
// tokens and what it runs. x/oauth2 does not validate them, and its
// documentation asks callers that accept a credential document from
// elsewhere to do so.
//
//nolint:tagliatelle // Google credential documents use snake_case wire fields.
type federatedCredential struct {
	Type                           string          `json:"type"`
	TokenURL                       string          `json:"token_url"`
	TokenInfoURL                   string          `json:"token_info_url"`
	ServiceAccountImpersonationURL string          `json:"service_account_impersonation_url"`
	UniverseDomain                 string          `json:"universe_domain"`
	CredentialSource               json.RawMessage `json:"credential_source"`
	SourceCredentials              json.RawMessage `json:"source_credentials"`
}

// maxFederatedCredentialDepth bounds impersonation chains: a document
// impersonating through a federated source is one level deep.
const maxFederatedCredentialDepth = 2

// checkFederatedCredential pins every token-bearing URL of a federated
// credential document to a Google API host over HTTPS, keeps the universe
// domain on googleapis.com (x/oauth2 derives the default STS host from it),
// and refuses executable credential sources. A document naming another
// token_url could otherwise make the gateway read a local file — its own
// service-account token — and post it to that host. Errors name the field,
// never its value. Service-account keys are not federated: their token_uri
// only ever receives a JWT signed by the document's own key.
func checkFederatedCredential(document []byte, depth int) error {
	var doc federatedCredential
	if err := json.Unmarshal(document, &doc); err != nil {
		return errors.New("credential document is not valid JSON")
	}
	if doc.Type != string(google.ExternalAccount) && doc.Type != string(google.ImpersonatedServiceAccount) {
		return nil
	}
	if doc.UniverseDomain != "" && doc.UniverseDomain != "googleapis.com" {
		return errors.New("credential document universe_domain must be googleapis.com")
	}
	if err := checkGoogleURLFields(&doc); err != nil {
		return err
	}
	if err := checkCredentialSource(doc.CredentialSource); err != nil {
		return err
	}
	if !jsonPresent(doc.SourceCredentials) {
		return nil
	}
	if depth+1 >= maxFederatedCredentialDepth {
		return errors.New("credential document impersonation chain is too deep")
	}
	return checkFederatedCredential(doc.SourceCredentials, depth+1)
}

// checkGoogleURLFields requires every token-bearing URL a federated document
// sets to be an https googleapis.com URL.
func checkGoogleURLFields(doc *federatedCredential) error {
	for field, value := range map[string]string{
		"token_url":                         doc.TokenURL,
		"token_info_url":                    doc.TokenInfoURL,
		"service_account_impersonation_url": doc.ServiceAccountImpersonationURL,
	} {
		if value == "" {
			continue
		}
		u, err := url.Parse(value)
		if err != nil || u.Scheme != "https" || u.User != nil || !googleAPIsHost(u.Hostname()) {
			return fmt.Errorf("credential document %s must be an https googleapis.com URL", field)
		}
	}
	return nil
}

// checkCredentialSource refuses an executable credential source: the
// gateway never runs commands named by a credential document.
func checkCredentialSource(raw json.RawMessage) error {
	if !jsonPresent(raw) {
		return nil
	}
	var source struct {
		Executable json.RawMessage `json:"executable"`
	}
	if err := json.Unmarshal(raw, &source); err != nil {
		return errors.New("credential document credential_source is not a JSON object")
	}
	if jsonPresent(source.Executable) {
		return errors.New("credential document credential_source.executable is not supported")
	}
	return nil
}

// jsonPresent reports whether a raw JSON field was set to something other
// than null.
func jsonPresent(raw json.RawMessage) bool {
	return len(raw) > 0 && string(raw) != "null"
}

// insecureTransport serves connectors whose config sets InsecureSkipTLS. It
// mirrors the shared dial and idle-connection knobs and layers
// InsecureSkipVerify on top, keeping the opt-in scoped to this one client's
// pool rather than the shared default.
//
//nolint:gosec // G402: opt-in per connector config; the Config doc carries the MITM trade-off warning.
var insecureTransport = &http.Transport{
	Proxy:                 http.ProxyFromEnvironment,
	MaxIdleConns:          32,
	MaxIdleConnsPerHost:   8,
	IdleConnTimeout:       90 * time.Second,
	TLSHandshakeTimeout:   10 * time.Second,
	ExpectContinueTimeout: time.Second,
	TLSClientConfig:       &tls.Config{InsecureSkipVerify: true},
}

var secureHTTPClient = &http.Client{CheckRedirect: httphelp.RejectRedirect}

// URL joins the configured endpoint — or serviceDefault when the config
// carries none — with path and the optional query values. The endpoint may
// carry a base path and a trailing slash; path must start with "/".
func URL(cfg Config, serviceDefault, path string, params url.Values) string {
	base := cfg.Endpoint
	if base == "" {
		base = serviceDefault
	}
	u := strings.TrimRight(base, "/") + path
	if len(params) > 0 {
		u += "?" + params.Encode()
	}
	return u
}

// Do executes req with client and returns the response body as JSON. The
// body is capped at httphelp.MaxResponseBytes — read one byte past the cap,
// so a body over the limit is rejected rather than silently truncated — and
// the backend's status is classified onto the sentinel errors: 401/403 wrap
// connector.ErrForbidden, 404 wraps connector.ErrNotAvailable, and other
// non-2xx statuses report a sanitized fixed message. A 2xx body is returned
// as-is when it parses as JSON and wrapped as {"raw": "..."} when it does
// not, so a backend answering plain text is still surfaced honestly.
//
// Transport and token-source failures can quote the request URL or the token
// endpoint's response body — both can carry credential material — so those
// wrappers are stripped to their sanitized cause before the error returns.
//
// There is no client-side timeout beyond req's context: the caller sets the
// deadline.
func Do(req *http.Request, client *http.Client) (json.RawMessage, error) {
	resp, err := httphelp.DoReadRequest(req, client)
	if err != nil {
		return nil, fmt.Errorf("querying observability backend: %w", withoutSensitiveDetail(err))
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // best-effort body close
	return readResponse(resp)
}

// readResponse consumes the body under the size cap and classifies the
// backend's status. It mirrors httphelp's response handling; the two must
// stay in step so every connector reports backend failures the same way.
func readResponse(resp *http.Response) (json.RawMessage, error) {
	body, err := io.ReadAll(io.LimitReader(resp.Body, httphelp.MaxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("reading backend response: %w", err)
	}
	if len(body) > httphelp.MaxResponseBytes {
		return nil, fmt.Errorf("backend response exceeds the %d byte limit", httphelp.MaxResponseBytes)
	}

	switch {
	case resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices:
		return decodeBody(body)
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return nil, fmt.Errorf("%w: backend returned %d", connector.ErrForbidden, resp.StatusCode)
	case resp.StatusCode == http.StatusNotFound:
		return nil, fmt.Errorf("%w: backend returned 404", connector.ErrNotAvailable)
	default:
		// Sanitized on purpose: the endpoint URL and the response body can
		// both carry credential material, so neither is echoed.
		return nil, fmt.Errorf("backend returned status %d", resp.StatusCode)
	}
}

// decodeBody returns a 2xx body as-is when it parses as JSON and wraps it as
// {"raw": "..."} when it does not, so a backend answering plain text is
// still surfaced honestly.
func decodeBody(body []byte) (json.RawMessage, error) {
	if json.Valid(body) {
		return json.RawMessage(body), nil
	}
	wrapped, err := json.Marshal(struct {
		Raw string `json:"raw"`
	}{Raw: string(body)})
	if err != nil {
		return nil, fmt.Errorf("wrapping non-JSON backend response: %w", err)
	}
	return wrapped, nil
}

// withoutSensitiveDetail reduces a request failure to its safe cause. The
// *url.Error wrapper quotes the full request URL — endpoint URLs can carry
// credential material — and *oauth2.RetrieveError quotes the token
// endpoint's response body, so both are stripped to a wrapper-free,
// body-free error.
func withoutSensitiveDetail(err error) error {
	var retrieveErr *oauth2.RetrieveError
	if errors.As(err, &retrieveErr) {
		return errors.New("obtaining backend access token failed")
	}
	for {
		var urlErr *url.Error
		if !errors.As(err, &urlErr) {
			return err
		}
		// OAuth can nest the token endpoint's URL error inside the API
		// request's URL error. Remove every URL-bearing wrapper.
		err = urlErr.Err
	}
}

// ClassifyState maps an error returned by Do onto the connector state
// vocabulary. It delegates to httphelp so every connector reports the same
// classification for the same backend failure.
func ClassifyState(err error) connector.State {
	return httphelp.ClassifyState(err)
}

// reasonNoAmbientCredentials is the fixed sentence for the missing-ambient-
// identity case: the provider names no credential Secret and the cluster
// offers no application-default credentials, so nothing was ever sent to the
// backend. Naming the two ways forward is operator guidance, not detail.
const reasonNoAmbientCredentials = "no Google credentials are configured; " +
	"set a credentialsSecretRef or attach Workload Identity"

// reasonAmbientEndpointRefused is the fixed sentence for a provider whose
// ambient identity would have gone to a non-Google or unverified endpoint.
const reasonAmbientEndpointRefused = "ambient Google credentials are sent only to googleapis.com over verified TLS; " +
	"set a credentialsSecretRef to use a custom endpoint"

// CredentialState classifies a credential-construction failure onto the
// state and fixed sentence status reports. The absence of ambient identity,
// and ambient identity refused for the configured endpoint, are
// StateNotConfigured: the backend was never contacted, so the refusal
// StateForbidden would claim misdescribes what happened.
func CredentialState(err error) (state connector.State, reason string) {
	switch {
	case errors.Is(err, ErrNoAmbientCredentials):
		return connector.StateNotConfigured, reasonNoAmbientCredentials
	case errors.Is(err, ErrAmbientEndpointRefused):
		return connector.StateNotConfigured, reasonAmbientEndpointRefused
	default:
		return connector.StateForbidden, ReasonFor(connector.StateForbidden)
	}
}

// CredentialError converts a credential-construction failure into its dual
// result and error, the way every GCP connector reports one: the result
// carries CredentialState's verdict for status, the error travels through
// unchanged for the caller to wrap with connector context (it already
// carries the sentinel or parse detail). A refused, malformed or
// unparseable credential document is a caller bug, so — unlike backend
// failures — the error is non-nil.
func CredentialError(err error) (*connector.QueryResult, error) {
	state, reason := CredentialState(err)
	return &connector.QueryResult{State: state, Reason: reason}, err
}

// ReasonFor returns the fixed user-facing sentence for a classified state.
// It delegates to httphelp so every connector reports the same sentence for
// the same backend failure.
func ReasonFor(state connector.State) string {
	return httphelp.ReasonFor(state)
}

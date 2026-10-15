// Package httphelp carries the request and response mechanics shared by the
// observability connectors: strict configuration documents, credential
// header selection, response classification and size capping. It exists so
// each connector package holds only its backend's query-shape logic.
//
// The sanitizing discipline lives here. Returned errors keep detail for
// logs, but nothing that could carry credential material — endpoint URLs,
// response bodies — is ever echoed into an error string, because the same
// errors are expected to travel into logs adjacent to results whose
// user-facing Reason is a fixed sentence.
package httphelp

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
	"slices"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/http/httpguts"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// MaxResponseBytes caps how much of a backend response body is read, so one
// unbounded backend reply cannot exhaust the gateway. The cap is checked by
// reading one byte past it: a body at the limit is honored, a body over it
// is rejected rather than silently truncated.
const MaxResponseBytes = 8 << 20 // 8 MiB

// Keys the strict connector configuration document may carry. Anything
// else is a typo and fails fast at validation time.
const (
	configKeyEndpoint        = "endpoint"
	configKeyHeaders         = "headers"
	configKeyInsecureSkipTLS = "insecureSkipTLS"
)

// Header shaping limits for the "headers" key. The count cap and the
// combined-size budget keep one config document from bloating every
// outbound request with an unbounded header block.
const (
	maxConfigHeaders     = 16
	maxConfigHeaderBytes = 4 << 10 // 4 KiB combined names and values
)

// Config is the decoded connector configuration document. Endpoint is the
// backend's absolute http(s) URL; the other fields are the two optional
// request-shaping keys shared by every connector.
//
// Headers carries extra request headers sent on every backend call. It
// exists so operators can pass the vendor-specific headers multi-tenant
// backends demand — the canonical example is the X-Scope-OrgID tenancy
// header Loki and Mimir require per tenant. Empty-string values are
// allowed: some proxies treat an explicitly empty header as clearing a
// value they would otherwise inherit.
//
// InsecureSkipTLS makes this connector's requests accept whatever
// certificate the backend presents, self-signed included. WARNING: this
// trades MITM protection for compatibility with self-signed in-cluster
// backends — never set it for endpoints outside the cluster.
type Config struct {
	Endpoint        string
	Headers         map[string]string
	InsecureSkipTLS bool
}

// sharedTransport holds the dial and idle-connection knobs every connector
// shares; it is a separate variable so the insecure variant can clone it.
var sharedTransport = &http.Transport{
	Proxy:                 http.ProxyFromEnvironment,
	MaxIdleConns:          32,
	MaxIdleConnsPerHost:   8,
	IdleConnTimeout:       90 * time.Second,
	TLSHandshakeTimeout:   10 * time.Second,
	ExpectContinueTimeout: time.Second,
}

// insecureTransport serves connectors whose config sets InsecureSkipTLS. It
// clones the shared transport so every knob stays identical and layers
// InsecureSkipVerify on top, keeping the opt-in scoped to this one client
// rather than the process-wide shared pool.
//
//nolint:gosec // G402: opt-in per connector config; the Config doc carries the MITM trade-off warning.
var insecureTransport = func() *http.Transport {
	transport := sharedTransport.Clone()
	transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	return transport
}()

// sharedClient serves every connector that does not opt into
// InsecureSkipTLS. It deliberately sets no overall timeout: a query's
// deadline belongs to the caller's context, so one slow backend cannot
// force a process-wide latency budget on the rest.
var sharedClient = &http.Client{Transport: sharedTransport, CheckRedirect: RejectRedirect}

// insecureClient serves connectors whose config sets InsecureSkipTLS. It
// has its own connection pool so verified and unverified TLS sessions
// never share keepalive state.
var insecureClient = &http.Client{Transport: insecureTransport, CheckRedirect: RejectRedirect}

// ParseConfig decodes the strict connector configuration document — the
// "endpoint" key holding an absolute http(s) URL, plus the optional
// "headers" and "insecureSkipTLS" keys — and returns it as a Config.
// Unknown keys, wrong types and unusable values are errors naming the key
// but never its value: configuration values can carry credential material,
// so errors must stay safe to print.
//
// An absent endpoint — empty document, or one without the key — reports
// connector.ErrNotConfigured so callers can distinguish "no integration
// configured" from "configured wrong".
func ParseConfig(config json.RawMessage) (Config, error) {
	return parseConfig(config, nil)
}

// ParseConfigWithKeys is ParseConfig for connectors whose document admits
// connector-specific keys beyond the shared ones: extraKeys pass the
// strictness check but are left undecoded here, for the caller to
// interpret. That keeps a key like prometheus' "step" valid on exactly one
// connector while a typo such as "step" on a loki provider still fails as
// an unknown key.
func ParseConfigWithKeys(config json.RawMessage, extraKeys []string) (Config, error) {
	return parseConfig(config, extraKeys)
}

// parseConfig implements the shared strictness check and decodes the three
// known keys; extraKeys are tolerated in the document and ignored.
func parseConfig(config json.RawMessage, extraKeys []string) (Config, error) {
	if len(bytes.TrimSpace(config)) == 0 {
		return Config{}, fmt.Errorf("%w: an endpoint must be configured", connector.ErrNotConfigured)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(config, &raw); err != nil {
		return Config{}, fmt.Errorf("config: invalid JSON document: %w", err)
	}
	for key := range raw {
		if !allowedConfigKey(key, extraKeys) {
			return Config{}, fmt.Errorf("config: unknown key %q", key)
		}
	}

	value, ok := raw[configKeyEndpoint]
	if !ok {
		return Config{}, fmt.Errorf("%w: config key %q is required", connector.ErrNotConfigured, configKeyEndpoint)
	}
	endpoint, err := decodeEndpoint(value)
	if err != nil {
		return Config{}, err
	}
	return decodeOptions(raw, Config{Endpoint: endpoint})
}

// decodeOptions decodes the two optional request-shaping keys present in
// raw, overlaying them on cfg.
func decodeOptions(raw map[string]json.RawMessage, cfg Config) (Config, error) {
	if value, ok := raw[configKeyHeaders]; ok {
		headers, err := decodeHeaders(value)
		if err != nil {
			return Config{}, err
		}
		cfg.Headers = headers
	}
	if value, ok := raw[configKeyInsecureSkipTLS]; ok {
		if err := json.Unmarshal(value, &cfg.InsecureSkipTLS); err != nil {
			return Config{}, fmt.Errorf("config: key %q must be a bool", configKeyInsecureSkipTLS)
		}
	}
	return cfg, nil
}

// allowedConfigKey reports whether key belongs to the strict document:
// one of the shared keys, or one of the caller's connector-specific extras.
func allowedConfigKey(key string, extraKeys []string) bool {
	switch key {
	case configKeyEndpoint, configKeyHeaders, configKeyInsecureSkipTLS:
		return true
	}
	return slices.Contains(extraKeys, key)
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

// decodeHeaders validates the headers key's value: an object of header
// field names to values sent on every backend call. Names must be valid
// header field names and values must carry no CR or LF, so a config
// document cannot smuggle a request-smuggling injection into the gateway's
// outbound requests; the count cap and combined-size budget keep one
// document from bloating every request. Entries are never echoed — names
// and values can both carry credential material — so errors stay safe to
// print.
func decodeHeaders(value json.RawMessage) (map[string]string, error) {
	var headers map[string]string
	if err := json.Unmarshal(value, &headers); err != nil {
		return nil, fmt.Errorf("config: key %q must be an object of string values", configKeyHeaders)
	}
	if len(headers) > maxConfigHeaders {
		return nil, fmt.Errorf("config: key %q allows at most %d entries", configKeyHeaders, maxConfigHeaders)
	}
	total := 0
	for name, val := range headers {
		switch strings.ToLower(name) {
		case "authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "api-key", "x-auth-token", "x-access-token", "x-goog-api-key":
			return nil, fmt.Errorf("config: key %q must not contain credential headers; use credentialsSecretRef", configKeyHeaders)
		}
		if !httpguts.ValidHeaderFieldName(name) {
			return nil, fmt.Errorf("config: key %q names must be valid header field names", configKeyHeaders)
		}
		if !httpguts.ValidHeaderFieldValue(val) {
			return nil, fmt.Errorf("config: key %q values must be valid header values", configKeyHeaders)
		}
		total += len(name) + len(val)
	}
	if total > maxConfigHeaderBytes {
		return nil, fmt.Errorf("config: key %q entries combined exceed the %d byte budget", configKeyHeaders, maxConfigHeaderBytes)
	}
	return headers, nil
}

// ValidateConfig checks the strict connector configuration document ahead
// of use, before it is ever passed to a Query call.
func ValidateConfig(config json.RawMessage) error {
	_, err := ParseConfig(config)
	return err
}

// Get performs one authenticated GET against cfg.Endpoint joined with path
// and returns the response body as JSON. The endpoint may carry a base path
// and a trailing slash; path must start with "/". The configured headers
// are applied after the credential header, so an operator-declared header
// wins a collision; the backend's status is classified onto the sentinel
// errors — 401/403 wrap ErrForbidden, 404 wraps ErrNotAvailable — so
// callers can map it with ClassifyState; other non-2xx statuses report a
// sanitized fixed message.
//
// There is no client-side timeout beyond ctx: the caller sets the deadline.
func Get(ctx context.Context, cfg Config, path string, params url.Values, credentials []byte) (json.RawMessage, error) {
	u := strings.TrimRight(cfg.Endpoint, "/") + path
	if len(params) > 0 {
		u += "?" + params.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, http.NoBody)
	if err != nil {
		// The URL is not echoed: with a validated endpoint and a fixed path
		// this is unreachable, and if it is reached the message must not
		// carry the endpoint.
		return nil, errors.New("building backend request: invalid endpoint or path")
	}
	setAuth(req, credentials)
	for name, value := range cfg.Headers {
		// Config documents are validated, so the names and values are
		// already known-safe for the wire.
		req.Header.Set(name, value)
	}

	client := sharedClient
	if cfg.InsecureSkipTLS {
		client = insecureClient
	}
	resp, err := DoReadRequest(req, client)
	if err != nil {
		// *url.Error quotes the full request URL — endpoint URLs can carry
		// credential material — so the wrapper is stripped and only the
		// cause (timeout, refused connection, context error) is kept.
		return nil, fmt.Errorf("querying observability backend: %w", withoutRequestURL(err))
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // best-effort body close

	return readResponse(resp)
}

// RejectRedirect keeps backend credentials and tenancy headers on the
// configured endpoint. Even same-host redirects can switch schemes or
// replay POST bodies; operators should configure the final API URL.
func RejectRedirect(_ *http.Request, _ []*http.Request) error {
	return http.ErrUseLastResponse
}

// DoReadRequest executes an explicitly read-only backend request. GET APIs
// and GCP's entries:list POST are safe to replay after transient statuses;
// callers must never use this helper for mutations. It makes at most three
// attempts with bounded, context-cancellable backoff, honoring Retry-After
// only when it fits within the one-second retry budget. Transport errors
// and credential denials are not retried.
func DoReadRequest(req *http.Request, client *http.Client) (*http.Response, error) {
	// Enforce this at the shared seam too, including clients supplied by
	// OAuth and tests. A shallow client copy preserves connection pooling.
	boundedClient := *client
	boundedClient.CheckRedirect = RejectRedirect
	for attempt := 0; ; attempt++ {
		if err := req.Context().Err(); err != nil {
			return nil, err
		}
		attemptReq := req
		if attempt > 0 {
			attemptReq = req.Clone(req.Context())
			if req.Body != nil && req.Body != http.NoBody {
				if req.GetBody == nil {
					return nil, errors.New("backend request body cannot be replayed")
				}
				body, err := req.GetBody()
				if err != nil {
					return nil, errors.New("recreating backend request body failed")
				}
				attemptReq.Body = body
			}
		}
		resp, err := boundedClient.Do(attemptReq)
		if err != nil {
			return nil, err
		}
		delay, retry := retryDelay(resp, attempt)
		if !retry || (req.Body != nil && req.Body != http.NoBody && req.GetBody == nil) {
			return resp, nil
		}
		// Do not read an unbounded error body just to reuse the connection.
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 8<<10))
		_ = resp.Body.Close()
		timer := time.NewTimer(delay)
		select {
		case <-req.Context().Done():
			timer.Stop()
			return nil, req.Context().Err()
		case <-timer.C:
		}
	}
}

func retryDelay(resp *http.Response, attempt int) (time.Duration, bool) {
	if attempt >= 2 {
		return 0, false
	}
	switch resp.StatusCode {
	case http.StatusTooManyRequests, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
	default:
		return 0, false
	}
	delay := 100 * time.Millisecond * time.Duration(1<<attempt)
	if value := resp.Header.Get("Retry-After"); value != "" {
		if seconds, err := strconv.Atoi(value); err == nil {
			if seconds < 0 || seconds > 1 {
				return 0, false
			}
			delay = time.Duration(seconds) * time.Second
		} else if when, err := http.ParseTime(value); err == nil {
			delay = time.Until(when)
			if delay > time.Second {
				return 0, false
			}
			if delay < 0 {
				delay = 0
			}
		}
	}
	return delay, true
}

// setAuth selects the Authorization header from the credential document:
// nil or empty sends none, a colon selects HTTP Basic (user:password), and
// anything else is sent verbatim as a bearer token.
func setAuth(req *http.Request, credentials []byte) {
	if len(credentials) == 0 {
		return
	}
	raw := string(credentials)
	if user, password, ok := strings.Cut(raw, ":"); ok {
		req.SetBasicAuth(user, password)
		return
	}
	req.Header.Set("Authorization", "Bearer "+raw)
}

// readResponse consumes the body under the size cap and classifies the
// backend's status. Two hundred-level bodies are returned as-is when they
// parse as JSON and wrapped as {"raw": "..."} when they do not, so a
// backend answering plain text is still surfaced honestly.
func readResponse(resp *http.Response) (json.RawMessage, error) {
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("reading backend response: %w", err)
	}
	if len(body) > MaxResponseBytes {
		return nil, fmt.Errorf("backend response exceeds the %d byte limit", MaxResponseBytes)
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
// {"raw": "..."} when it does not, so a backend answering plain text is still
// surfaced honestly.
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

// withoutRequestURL drops the *url.Error wrapper, whose message quotes the
// request URL, keeping only the underlying cause.
func withoutRequestURL(err error) error {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return urlErr.Err
	}
	return err
}

// ClassifyState maps an error returned by Get onto the connector state
// vocabulary. Anything that is not a recognized sentinel — transport
// failures, size-cap hits, unexpected statuses — is a StateError.
func ClassifyState(err error) connector.State {
	switch {
	case errors.Is(err, connector.ErrForbidden):
		return connector.StateForbidden
	case errors.Is(err, connector.ErrNotAvailable):
		return connector.StateNotAvailable
	case errors.Is(err, connector.ErrNotConfigured):
		return connector.StateNotConfigured
	default:
		return connector.StateError
	}
}

// ReasonFor returns the fixed user-facing sentence for a classified state.
// The sentences are deliberately generic: the detail an operator needs for
// diagnosis belongs in logs, not in a status Reason.
func ReasonFor(state connector.State) string {
	switch state {
	case connector.StateOK:
		return ""
	case connector.StateForbidden:
		return "the observability backend refused the supplied credentials"
	case connector.StateNotAvailable:
		return "the observability backend does not provide the requested data"
	case connector.StateNotConfigured:
		return "no observability backend endpoint is configured"
	case connector.StateError:
		return "the observability backend query failed"
	default:
		return ""
	}
}

// ClampLimit normalizes a caller-supplied result limit: non-positive falls
// back to def, anything above ceiling is clamped, so one request cannot ask a
// backend for an unbounded result set.
func ClampLimit(limit, def, ceiling int) int {
	switch {
	case limit <= 0:
		return def
	case limit > ceiling:
		return ceiling
	default:
		return limit
	}
}

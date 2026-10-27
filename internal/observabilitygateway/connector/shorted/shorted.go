// Package shorted implements bounded, read-only Shorted application data queries.
// Routes and response fields are fixed by operation; callers cannot select URLs,
// headers, arbitrary RPCs, response paths or mutation methods.
package shorted

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/benebsworth/paprika/internal/dataframe"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

const (
	maxQueryBytes    = 16 << 10
	maxResponseBytes = 2 << 20
	maxRows          = 1000
	queryTimeout     = 10 * time.Second
)

type config struct {
	Endpoint           string `json:"endpoint"`
	MarketDataEndpoint string `json:"marketDataEndpoint,omitempty"`
}

type credentials struct {
	APIToken        string `json:"apiToken,omitempty"` // #nosec G117 -- decoded only from credentialsSecretRef; never exposed in output.
	MarketDataToken string `json:"marketDataToken,omitempty"`
	AdminToken      string `json:"adminToken,omitempty"`
}

type query struct {
	Operation  string                     `json:"operation"`
	Args       map[string]json.RawMessage `json:"args,omitempty"`
	Projection *dataframe.Projection      `json:"projection,omitempty"`
}

// Shorted is stateless; requests supply their configuration and credentials.
type Shorted struct{}

// New returns a read-only Shorted connector.
func New() connector.Connector { return Shorted{} }

// Descriptor advertises scalar records and explicit numeric projections.
func (Shorted) Descriptor() connector.Descriptor {
	return connector.Descriptor{Name: "shorted", Signals: []connector.Signal{connector.SignalMetrics, connector.Signal("records")}, NeedsEgress: true}
}

// ValidateConfig permits only explicitly configured API origins.
func (Shorted) ValidateConfig(raw json.RawMessage) error {
	_, err := parseConfig(raw)
	return err
}

func parseConfig(raw json.RawMessage) (config, error) {
	var cfg config
	if len(raw) == 0 {
		return cfg, connector.ErrNotConfigured
	}
	if len(raw) > 4096 || decodeStrict(raw, &cfg) != nil {
		return cfg, errors.New("shorted config must contain only endpoint and optional marketDataEndpoint")
	}
	if cfg.Endpoint == "" {
		return cfg, connector.ErrNotConfigured
	}
	for _, endpoint := range []string{cfg.Endpoint, cfg.MarketDataEndpoint} {
		if endpoint != "" && !validOrigin(endpoint) {
			return cfg, errors.New("shorted endpoints must be absolute HTTP(S) origins without paths, userinfo, queries or fragments")
		}
	}
	return cfg, nil
}

func validOrigin(endpoint string) bool {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || !slices.Contains([]string{"http", "https"}, u.Scheme) {
		return false
	}
	return u.User == nil && u.RawQuery == "" && !u.ForceQuery && u.Fragment == "" && (u.Path == "" || u.Path == "/") && u.Opaque == ""
}

func parseCredentials(raw []byte) (credentials, error) {
	var c credentials
	if len(raw) == 0 {
		return c, nil
	}
	if len(raw) > 16<<10 || decodeStrict(raw, &c) != nil {
		return c, errors.New("invalid shorted credential document")
	}
	for _, token := range []string{c.APIToken, c.MarketDataToken, c.AdminToken} {
		if len(token) > 8192 || strings.ContainsAny(token, "\r\n\t ") {
			return c, errors.New("invalid shorted credential document")
		}
	}
	return c, nil
}

// Query executes one allowlisted read and returns a scalar frame or Prometheus
// projection. Backend errors never include response bodies or request URLs.
//
//nolint:gocritic // Connector interface passes the per-call request by value.
func (Shorted) Query(ctx context.Context, req connector.QueryRequest) (*connector.QueryResult, error) {
	if reason := queryShapeError(&req); reason != "" {
		return unsupported(reason)
	}
	cfg, err := parseConfig(req.Config)
	if err != nil {
		return nil, fmt.Errorf("shorted config: %w", err)
	}
	creds, err := parseCredentials(req.Credentials)
	if err != nil {
		return failure(connector.StateForbidden), nil
	}
	q, op, body, err := prepare(req.Query, req.Signal)
	if err != nil {
		return unsupported(err.Error())
	}
	endpoint, token := querySource(&cfg, &creds, &op)
	if endpoint == "" {
		return failure(connector.StateNotConfigured), nil
	}
	ctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()
	raw, err := readOperation(ctx, endpoint, token, &op, body)
	if err != nil {
		return failure(httphelp.ClassifyState(err)), nil
	}
	limit := httphelp.ClampLimit(req.Limit, maxRows, maxRows)
	frame, err := decodeFrame(raw, &q, &op, limit)
	if err != nil {
		return failure(connector.StateError), nil
	}
	return result(frame, q.Projection, req.Range.End)
}

func queryShapeError(req *connector.QueryRequest) string {
	if req.Signal != connector.SignalMetrics && req.Signal != connector.Signal("records") {
		return "shorted supplies metrics and records only"
	}
	if req.TraceID != "" || req.PageToken != "" || req.Limit < 0 {
		return "shorted does not accept trace IDs, page tokens or negative limits"
	}
	return ""
}

func result(frame dataframe.Frame, projection *dataframe.Projection, end time.Time) (*connector.QueryResult, error) {
	if err := dataframe.Validate(&frame); err != nil {
		return failure(connector.StateError), nil
	}
	var data json.RawMessage
	var err error
	if projection != nil {
		data, err = dataframe.Prometheus(&frame, *projection, end)
	} else {
		data, err = json.Marshal(frame)
	}
	if err != nil {
		return unsupported("shorted projection does not match the returned scalar columns")
	}
	return &connector.QueryResult{State: connector.StateOK, Data: data}, nil
}

var client = &http.Client{Timeout: queryTimeout, CheckRedirect: httphelp.RejectRedirect}

func read(ctx context.Context, endpoint, token, path string, body []byte) (json.RawMessage, error) {
	req, err := backendRequest(ctx, endpoint, token, path, body)
	if err != nil {
		return nil, err
	}
	resp, err := httphelp.DoReadRequest(req, client)
	if err != nil {
		return nil, errors.New("shorted request failed")
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // Best-effort close after bounded response read.
	return responseBody(resp)
}

func backendRequest(ctx context.Context, endpoint, token, path string, body []byte) (*http.Request, error) {
	if token != "" && !credentialTransportAllowed(endpoint) {
		return nil, connector.ErrForbidden
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(endpoint, "/")+path, bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("shorted request could not be created")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; PaprikaShorted/1.0)")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return req, nil
}

func responseBody(resp *http.Response) (json.RawMessage, error) {
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, connector.ErrForbidden
	}
	if resp.StatusCode == http.StatusNotFound {
		return nil, connector.ErrNotAvailable
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, errors.New("shorted backend returned an unsuccessful status")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil || len(data) > maxResponseBytes || !json.Valid(data) {
		return nil, errors.New("shorted response is invalid or exceeds the size limit")
	}
	return data, nil
}

func failure(state connector.State) *connector.QueryResult {
	return &connector.QueryResult{State: state, Reason: httphelp.ReasonFor(state)}
}

func unsupported(reason string) (*connector.QueryResult, error) {
	return &connector.QueryResult{State: connector.StateNotAvailable, Reason: reason}, fmt.Errorf("%w: %s", connector.ErrUnsupported, reason)
}

func credentialTransportAllowed(endpoint string) bool {
	u, err := url.Parse(endpoint)
	if err != nil {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	ip := net.ParseIP(u.Hostname())
	return ip != nil && ip.IsLoopback()
}

func decodeStrict(raw []byte, target any) error {
	if trimmed := bytes.TrimSpace(raw); len(trimmed) == 0 || trimmed[0] != '{' {
		return errors.New("expected JSON object")
	}
	if err := exactKeys(raw, target); err != nil {
		return err
	}
	if err := uniqueObjects(raw); err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	d.UseNumber()
	if err := d.Decode(target); err != nil {
		return errors.New("invalid JSON object")
	}
	if err := d.Decode(new(any)); !errors.Is(err, io.EOF) {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

func uniqueObjects(raw []byte) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	if err := uniqueValue(d, 0); err != nil {
		return err
	}
	if _, err := d.Token(); !errors.Is(err, io.EOF) {
		return errors.New("invalid JSON document")
	}
	return nil
}

func uniqueValue(d *json.Decoder, depth int) error {
	if depth > 16 {
		return errors.New("JSON nesting is too deep")
	}
	t, err := d.Token()
	if err != nil {
		return errors.New("invalid JSON document")
	}
	delim, ok := t.(json.Delim)
	if !ok {
		return nil
	}
	if !strings.ContainsRune("{[", rune(delim)) {
		return errors.New("invalid JSON document")
	}
	seen := map[string]bool{}
	for d.More() {
		if delim == '{' {
			if err := uniqueKey(d, seen); err != nil {
				return err
			}
		}
		if err := uniqueValue(d, depth+1); err != nil {
			return err
		}
	}
	if _, err := d.Token(); err != nil {
		return errors.New("invalid JSON document")
	}
	return nil
}

func exactKeys(raw []byte, target any) error {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil {
		return errors.New("invalid JSON object")
	}
	typ := reflect.TypeOf(target).Elem()
	allowed := map[string]bool{}
	for i := 0; i < typ.NumField(); i++ {
		allowed[strings.Split(typ.Field(i).Tag.Get("json"), ",")[0]] = true
	}
	for key := range object {
		if !allowed[key] {
			return errors.New("unsupported JSON property")
		}
	}
	if value, exists := object["args"]; exists && !bytes.HasPrefix(bytes.TrimSpace(value), []byte("{")) {
		return errors.New("args must be an object")
	}
	if value, exists := object["projection"]; exists {
		var projection dataframe.Projection
		return decodeStrict(value, &projection)
	}
	return nil
}

func uniqueKey(d *json.Decoder, seen map[string]bool) error {
	key, err := d.Token()
	if err != nil {
		return errors.New("invalid JSON document")
	}
	name, ok := key.(string)
	if !ok || seen[name] {
		return errors.New("duplicate JSON property")
	}
	seen[name] = true
	return nil
}

func querySource(cfg *config, creds *credentials, op *operation) (endpoint, token string) {
	if op.marketData {
		return cfg.MarketDataEndpoint, creds.MarketDataToken
	}
	if op.admin {
		if creds.AdminToken == "" {
			return "", ""
		}
		return cfg.Endpoint, creds.AdminToken
	}
	return cfg.Endpoint, creds.APIToken
}

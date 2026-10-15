package observabilitygateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"connectrpc.com/connect"
	"github.com/go-logr/logr"

	"github.com/benebsworth/paprika/internal/observabilitygateway/catalog"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// validateBodyLimit caps the validate request body: the request carries a
// config document and, optionally, a raw credential document, and a health
// probe needs neither to be large.
const validateBodyLimit = 64 << 10 // 64 KiB

// Fixed sentences the catalog and validate endpoints report. They are
// deliberately closed — never derived from connector error text, which can
// quote credential material — and shared by the HTTP handlers and the MCP
// tools so every surface of this gateway speaks one vocabulary.
const (
	reasonUnknownProviderType     = "unknown provider type"
	reasonProviderTypeUnavailable = "provider type is not available in this gateway build"
	reasonValidateRequestInvalid  = "request body is not a valid provider validation request"
)

// errProviderTypeUnavailable marks the deployment bug this gateway answers
// 500 for: a type the catalog covers but New cannot build in this binary.
// It is logged with the construction error's detail; only the fixed
// sentence reaches the caller.
var errProviderTypeUnavailable = errors.New(reasonProviderTypeUnavailable)

// CatalogHandler serves GET <routePrefix>/api/catalog: the provider-type
// library list the console's library browser renders — one light summary
// per backend the gateway can connect to, in the catalog's deterministic
// Vendor-then-DisplayName order. Protection is RequireObserveScope, applied
// by the caller; entries are read-only metadata, safe to serialize as-is.
func CatalogHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeGatewayJSON(w, http.StatusOK, map[string]any{"types": catalog.Summaries()})
	})
}

// CatalogTypeHandler serves GET <routePrefix>/api/catalog/{type}: the full
// TypeInfo for one provider type — display metadata, config-field schema,
// credential shape, onboarding steps and the probe shape the onboarding
// wizard renders. An unknown type answers 404 with the gateway's
// RFC 6749-shaped error JSON rather than leaking anything else; protection
// is RequireObserveScope, applied by the caller.
func CatalogTypeHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		info, ok := catalog.Get(r.PathValue("type"))
		if !ok {
			writeGatewayJSON(w, http.StatusNotFound,
				gatewayError{Error: "invalid_request", ErrorDescription: reasonUnknownProviderType})
			return
		}
		writeGatewayJSON(w, http.StatusOK, info)
	})
}

// validateRequest is the POST <routePrefix>/api/validate body: the provider
// type to probe, its connector config document, and an optional raw
// credential document. Config stays raw so it can be re-marshaled into the
// canonical connector document after the object check.
type validateRequest struct {
	Type        string          `json:"type"`
	Config      json.RawMessage `json:"config"`
	Credentials string          `json:"credentials"`
}

// validateResponse is the POST <routePrefix>/api/validate answer: the
// health probe's state verdict and its fixed-sentence reason. A Forbidden
// verdict is data answered 200, not an HTTP error — mirroring the query
// tools, where a backend refusal travels inside the result.
type validateResponse struct {
	State  connector.State `json:"state"`
	Reason string          `json:"reason,omitempty"`
}

// ValidateHandler serves POST <routePrefix>/api/validate: the health probe
// the onboarding wizard runs before a provider is created, proving a config
// (and credential) is reachable and authorized before it lands in a CR.
// Protection is RequireObserveScope, applied by the caller. The request
// body and the credential document are never logged — at most the provider
// type and the resulting state.
func ValidateHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log := logr.FromContextOrDiscard(r.Context())

		var req validateRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, validateBodyLimit)).Decode(&req); err != nil {
			writeGatewayJSON(w, http.StatusBadRequest,
				gatewayError{Error: "invalid_request", ErrorDescription: reasonValidateRequestInvalid})
			return
		}
		if req.Type == "" {
			writeGatewayJSON(w, http.StatusBadRequest,
				gatewayError{Error: "invalid_request", ErrorDescription: reasonValidateRequestInvalid})
			return
		}
		cfg, err := canonicalConfig(req.Config)
		if err != nil {
			writeGatewayJSON(w, http.StatusBadRequest,
				gatewayError{Error: "invalid_request", ErrorDescription: reasonValidateRequestInvalid})
			return
		}
		var credentials []byte
		if req.Credentials != "" {
			credentials = []byte(req.Credentials)
		}

		result, err := runProbe(r.Context(), req.Type, cfg, credentials)
		if err != nil {
			// A catalog miss and an unavailable connector carry different
			// HTTP statuses but the same closed vocabulary: the caller
			// learns nothing a catalog listing would not tell them.
			status := http.StatusInternalServerError
			description := reasonProviderTypeUnavailable
			if connect.CodeOf(err) == connect.CodeNotFound {
				status = http.StatusNotFound
				description = reasonUnknownProviderType
			} else {
				log.Error(err, "observability provider validation failed", "type", req.Type)
			}
			writeGatewayJSON(w, status, gatewayError{Error: "invalid_request", ErrorDescription: description})
			return
		}
		log.Info("observability provider validated", "type", req.Type, "state", string(result.State))
		writeGatewayJSON(w, http.StatusOK, validateResponse{State: result.State, Reason: result.Reason})
	})
}

// canonicalConfig checks that raw, when present, is a JSON object and
// returns it re-marshaled into its canonical form. An absent or null
// config yields nil, which the connectors read as "not configured" — the
// probe then answers with the NotConfigured verdict rather than an HTTP
// error, because a missing document is a validation outcome, not a
// malformed request.
func canonicalConfig(raw json.RawMessage) (json.RawMessage, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &obj); err != nil {
		return nil, errors.New("config is not a JSON object")
	}
	cfg, err := json.Marshal(obj)
	if err != nil {
		// Unreachable for a document that decoded into obj, but the wire
		// answer stays the same fixed sentence either way.
		return nil, fmt.Errorf("marshal config: %w", err)
	}
	return cfg, nil
}

// runProbe executes the catalog entry's health probe for providerType
// against a config (and optional credential) document that has not been
// committed to a CR yet. The verdict travels as data — a probe is a
// query, so backend refusals and failures come back inside the
// QueryResult exactly as Query reports them. The error return is reserved
// for caller bugs and deployment bugs: a type the catalog does not cover
// (CodeNotFound) and a catalog-covered type this build has no connector
// for (errProviderTypeUnavailable, answered 500 by the HTTP surface).
func runProbe(ctx context.Context, providerType string, cfg json.RawMessage, credentials []byte) (*connector.QueryResult, error) {
	log := logr.FromContextOrDiscard(ctx)

	entry, ok := catalog.Get(providerType)
	if !ok {
		return nil, connect.NewError(connect.CodeNotFound,
			fmt.Errorf("observability provider type %q is not in the catalog", providerType))
	}
	conn, err := New(providerType)
	if err != nil {
		log.Error(err, "observability provider type is in the catalog but has no connector in this build", "type", providerType)
		return nil, errProviderTypeUnavailable
	}

	result, err := conn.Query(ctx, connector.QueryRequest{
		Signal:      entry.Probe.Signal,
		Query:       probeQuery(providerType),
		Limit:       1,
		Config:      cfg,
		Credentials: credentials,
	})
	return finishQuery(log, providerType, providerType, result, err)
}

// probeQuery is the health probe's query expression for one provider type.
// The Google Cloud and AWS connectors read an empty query as their
// documented probe path; the HTTP-based open-source connectors (loki,
// prometheus, tempo) reject an empty query as a caller bug, so the probe
// carries the cheapest valid expression each backend accepts — an answer
// of "no data" is still a reachability proof.
func probeQuery(providerType string) string {
	switch providerType {
	case connector.ProviderPrometheus:
		return "up"
	case connector.ProviderLoki:
		return `{app="paprika"}`
	case connector.ProviderTempo:
		return "{}"
	default:
		return ""
	}
}

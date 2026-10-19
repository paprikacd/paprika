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
// config document; offline validation does not need a large payload.
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
// type and its connector config document. The legacy credentials field is
// retained only to reject payloads explicitly. Config is re-marshaled into the
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

// ValidateHandler serves POST <routePrefix>/api/validate: an offline
// configuration shape check. It never establishes connectivity or accepts
// credentials; active queries require an approved provider and caller RBAC.
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
		if req.Credentials != "" {
			writeGatewayJSON(w, http.StatusBadRequest,
				gatewayError{Error: "invalid_request", ErrorDescription: "credential payloads are not accepted; use the secure administration flow"})
			return
		}
		cfg, err := canonicalConfig(req.Config)
		if err != nil {
			writeGatewayJSON(w, http.StatusBadRequest,
				gatewayError{Error: "invalid_request", ErrorDescription: reasonValidateRequestInvalid})
			return
		}
		result, err := validateProviderConfig(r.Context(), req.Type, cfg, nil)
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

// validateProviderConfig deliberately performs no I/O. Observe-scoped callers
// may describe prospective configuration, but cannot direct the gateway's
// ambient cloud identity or network access to an arbitrary endpoint. Active
// validation uses Query on an approved provider and its RBAC/Secret boundary.
func validateProviderConfig(ctx context.Context, providerType string, cfg json.RawMessage, credentials []byte) (*connector.QueryResult, error) {
	log := logr.FromContextOrDiscard(ctx)

	_, ok := catalog.Get(providerType)
	if !ok {
		return nil, connect.NewError(connect.CodeNotFound,
			fmt.Errorf("observability provider type %q is not in the catalog", providerType))
	}
	conn, err := New(providerType)
	if err != nil {
		log.Error(err, "observability provider type is in the catalog but has no connector in this build", "type", providerType)
		return nil, errProviderTypeUnavailable
	}

	if len(credentials) != 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("credential payloads are not accepted; configure a provider through the secure administration flow"))
	}
	if err := conn.ValidateConfig(cfg); err != nil {
		return &connector.QueryResult{State: sentinelState(err), Reason: reasonNotConfigured}, nil
	}
	return &connector.QueryResult{State: connector.StateOK, Reason: "configuration is valid; backend connectivity and credentials have not been tested"}, nil
}

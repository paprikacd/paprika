package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"

	"k8s.io/apimachinery/pkg/types"
)

const (
	AdminSessionHeader   = "X-Paprika-Admin-Session"
	maxExchangeBodyBytes = 1024
	adminListenerHost    = "127.0.0.1:3001"
)

var (
	ErrInvalidHTTPConfig       = errors.New("invalid admin HTTP configuration")
	errRotationIdentityChanged = errors.New("admin session rotation identity changed")
)

type IdentityReviewer interface {
	Verify(context.Context, string) (ReviewedIdentity, error)
}

type HTTPConfig struct {
	Store          *Store
	Review         IdentityReviewer
	PodUID         types.UID
	HealthHandler  http.Handler
	ReadyHandler   http.Handler
	ConnectHandler http.Handler
	UIHandler      http.Handler
}

type ExchangeResponse struct {
	Token   string             `json:"token"`
	Session SessionDescription `json:"session"`
}

type httpSurface struct {
	store  *Store
	review IdentityReviewer
	podUID types.UID
}

func NewHTTPHandler(config *HTTPConfig) (http.Handler, error) {
	if err := validateHTTPConfig(config); err != nil {
		return nil, err
	}

	surface := &httpSurface{
		store:  config.Store,
		review: config.Review,
		podUID: config.PodUID,
	}
	mux := http.NewServeMux()
	mux.Handle("/events", http.NotFoundHandler())
	mux.Handle("/healthz", config.HealthHandler)
	mux.Handle("/readyz", config.ReadyHandler)
	mux.HandleFunc("/admin/session/exchange", surface.exchange)
	mux.HandleFunc("/admin/session", surface.session)
	mux.Handle(
		"/paprika.v1.PaprikaService/",
		surface.requireSession(config.ConnectHandler),
	)
	mux.Handle("/", surface.requireSession(config.UIHandler))

	return surface.enforceTransport(mux), nil
}

func validateHTTPConfig(config *HTTPConfig) error {
	switch {
	case config == nil:
		return ErrInvalidHTTPConfig
	case config.Store == nil, config.Review == nil, config.PodUID == "":
		return ErrInvalidHTTPConfig
	case config.HealthHandler == nil, config.ReadyHandler == nil:
		return ErrInvalidHTTPConfig
	case config.ConnectHandler == nil, config.UIHandler == nil:
		return ErrInvalidHTTPConfig
	default:
		return nil
	}
}

func (surface *httpSurface) enforceTransport(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/events" {
			http.NotFound(w, request)
			return
		}
		if err := ValidateLoopbackHost(request); err != nil ||
			request.Host != adminListenerHost {
			http.Error(w, "invalid request host", http.StatusBadRequest)
			return
		}
		next.ServeHTTP(w, request)
	})
}

func (surface *httpSurface) exchange(w http.ResponseWriter, request *http.Request) {
	setNoStore(w)
	bearer, ok := validateExchangeRequest(w, request)
	if !ok {
		return
	}
	identity, err := surface.review.Verify(request.Context(), bearer)
	if err != nil {
		status := http.StatusUnauthorized
		if errors.Is(err, ErrKubernetesAccessDenied) {
			status = http.StatusForbidden
		}
		http.Error(w, http.StatusText(status), status)
		return
	}

	token, description, err := surface.exchangeSession(request.Header, identity)
	if errors.Is(err, errRotationIdentityChanged) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if errors.Is(err, ErrInvalidSession) || errors.Is(err, ErrSessionExpired) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err != nil {
		http.Error(w, "session exchange failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, ExchangeResponse{
		Token:   token,
		Session: description,
	})
}

func validateExchangeRequest(w http.ResponseWriter, request *http.Request) (string, bool) {
	if request.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return "", false
	}
	if !validMutationOrigin(w, request) {
		return "", false
	}
	if status := validateExchangeBody(w, request); status != 0 {
		http.Error(w, http.StatusText(status), status)
		return "", false
	}
	bearer, ok := strictBearer(request.Header)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return "", false
	}
	return bearer, true
}

func (surface *httpSurface) exchangeSession(
	header http.Header,
	identity ReviewedIdentity,
) (string, SessionDescription, error) {
	current, present, valid := optionalSessionToken(header)
	switch {
	case !valid:
		return "", SessionDescription{}, ErrInvalidSession
	case present:
		currentSession, validateErr := surface.store.Validate(current, surface.podUID)
		if validateErr != nil {
			return "", SessionDescription{}, validateErr
		}
		if !reflect.DeepEqual(identity, currentSession.Identity()) {
			return "", SessionDescription{}, errRotationIdentityChanged
		}
		return surface.store.Rotate(current, surface.podUID)
	default:
		return surface.store.Create(identity, surface.podUID)
	}
}

func (surface *httpSurface) session(w http.ResponseWriter, request *http.Request) {
	setNoStore(w)
	switch request.Method {
	case http.MethodGet:
		surface.describeSession(w, request)
	case http.MethodDelete:
		surface.revokeSession(w, request)
	default:
		w.Header().Set("Allow", http.MethodGet+", "+http.MethodDelete)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (surface *httpSurface) describeSession(w http.ResponseWriter, request *http.Request) {
	token, ok := requiredSessionToken(request.Header)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	session, err := surface.store.Validate(token, surface.podUID)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	writeJSON(w, http.StatusOK, session.Description())
}

func (surface *httpSurface) revokeSession(w http.ResponseWriter, request *http.Request) {
	token, ok := requiredSessionToken(request.Header)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if !validMutationOrigin(w, request) {
		return
	}
	err := surface.store.Revoke(token, surface.podUID)
	if err == nil || errors.Is(err, ErrSessionExpired) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	http.Error(w, "unauthorized", http.StatusUnauthorized)
}

func (surface *httpSurface) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		token, ok := requiredSessionToken(request.Header)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		session, err := surface.store.Validate(token, surface.podUID)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if mutationMethod(request.Method) && !validMutationOrigin(w, request) {
			return
		}

		forward := request.Clone(WithValidatedSession(request.Context(), &session))
		forward.Header = request.Header.Clone()
		forward.Header.Del("Authorization")
		forward.Header.Del(AdminSessionHeader)
		next.ServeHTTP(w, forward)
	})
}

func validateExchangeBody(w http.ResponseWriter, request *http.Request) int {
	if request.Body == nil {
		return 0
	}
	request.Body = http.MaxBytesReader(w, request.Body, maxExchangeBodyBytes)
	body, err := io.ReadAll(request.Body)
	if err != nil {
		return exchangeBodyReadErrorStatus(err)
	}
	if len(body) == 0 {
		return 0
	}
	if !strictJSONContentType(request.Header) {
		return http.StatusUnsupportedMediaType
	}
	if !emptyJSONObject(body) {
		return http.StatusBadRequest
	}
	return 0
}

func exchangeBodyReadErrorStatus(err error) int {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return http.StatusRequestEntityTooLarge
	}
	return http.StatusBadRequest
}

func strictJSONContentType(header http.Header) bool {
	contentTypes := header.Values("Content-Type")
	return len(contentTypes) == 1 && contentTypes[0] == "application/json"
}

func emptyJSONObject(body []byte) bool {
	var object map[string]json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(&object); err != nil {
		return false
	}
	return object != nil && len(object) == 0 && decoderAtEOF(decoder)
}

func decoderAtEOF(decoder *json.Decoder) bool {
	return errors.Is(decoder.Decode(&struct{}{}), io.EOF)
}

func strictBearer(header http.Header) (string, bool) {
	values := header.Values("Authorization")
	if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") {
		return "", false
	}
	bearer := strings.TrimPrefix(values[0], "Bearer ")
	if bearer == "" || strings.TrimSpace(bearer) != bearer ||
		strings.ContainsAny(bearer, " \t\r\n") {
		return "", false
	}
	return bearer, true
}

func optionalSessionToken(header http.Header) (token string, present, valid bool) {
	values := header.Values(AdminSessionHeader)
	if len(values) == 0 {
		return "", false, true
	}
	if len(values) != 1 || values[0] == "" || strings.TrimSpace(values[0]) != values[0] {
		return "", true, false
	}
	return values[0], true, true
}

func requiredSessionToken(header http.Header) (string, bool) {
	token, present, valid := optionalSessionToken(header)
	return token, present && valid
}

func mutationMethod(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}

func validMutationOrigin(w http.ResponseWriter, request *http.Request) bool {
	if err := ValidateAndRewriteMutationOrigin(request, AdminListenerOrigin); err != nil {
		http.Error(w, "invalid request origin", http.StatusForbidden)
		return false
	}
	return true
}

func setNoStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		return
	}
}

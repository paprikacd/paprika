package insights

import (
	"errors"
	"net/http"
	"strings"
	"time"
)

func (s *Server) listProviderConfigs(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]any{"providers": s.providers.configs()})
}

func (s *Server) putProviderConfig(w http.ResponseWriter, r *http.Request) {
	if s.isSharedProviderID(r.PathValue("id")) {
		writeError(w, 409, "shared observability providers are managed in Observability")
		return
	}
	var config ProviderConfig
	if decodeBody(w, r, &config, maxProviderConfigBytes) != nil || config.ID != r.PathValue("id") {
		writeError(w, 400, "invalid provider configuration or mismatched id")
		return
	}
	if existing, ok := s.providers.get(config.ID); ok && !existing.public.Managed {
		providerStoreError(w, errProvisioned)
		return
	}
	// Validate before persistence so operator-facing configuration errors are 400.
	entry, err := makeProviderEntry(&config, true)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	entry.client.client.CloseIdleConnections()
	s.mutations.Lock()
	defer s.mutations.Unlock()
	if s.providerTypeInUse(&config) {
		writeError(w, 409, "provider is used by saved queries; remove those queries before changing its type")
		return
	}
	view, err := s.providers.put(&config, r.Header.Get("If-Match"), r.Header.Get("If-None-Match"))
	if err != nil {
		providerStoreError(w, err)
		return
	}
	w.Header().Set("ETag", view.ETag)
	writeJSON(w, 200, view)
}

func (s *Server) deleteProviderConfig(w http.ResponseWriter, r *http.Request) {
	if s.isSharedProviderID(r.PathValue("id")) {
		writeError(w, 409, "shared observability providers are managed in Observability")
		return
	}
	s.mutations.Lock()
	defer s.mutations.Unlock()
	if s.savedQueries.usesProvider(r.PathValue("id")) {
		writeError(w, 409, "provider is used by saved queries; remove those queries before deleting it")
		return
	}
	if err := s.providers.remove(r.PathValue("id"), r.Header.Get("If-Match")); err != nil {
		providerStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func providerStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errProvisioned):
		writeError(w, 409, err.Error())
	case errors.Is(err, ErrConflict):
		writeError(w, 412, "provider changed; reload its configuration before saving")
	case errors.Is(err, ErrNotFound):
		writeError(w, 404, "provider not found")
	case errors.Is(err, ErrCapacity):
		writeError(w, 507, "at most 32 providers may be configured")
	default:
		writeError(w, 500, "provider storage operation failed")
	}
}

func (s *Server) providerOperation(w http.ResponseWriter, r *http.Request) (provider *providerClient, release func()) {
	p, err := s.resolveProvider(r, r.PathValue("id"))
	if err != nil {
		writeProviderError(w, err)
		return nil, nil
	}
	select {
	case s.queries <- struct{}{}:
		return p, func() { <-s.queries }
	default:
		w.Header().Set("Retry-After", "1")
		writeError(w, 429, "too many active provider requests; retry shortly")
		return nil, nil
	}
}

func (s *Server) testProvider(w http.ResponseWriter, r *http.Request) {
	p, done := s.providerOperation(w, r)
	if p == nil {
		return
	}
	defer done()
	started := time.Now()
	if err := p.testConnection(r.Context()); err != nil {
		if p.remote != nil {
			writeProviderError(w, err)
		} else {
			writeError(w, 502, "provider connection failed; check its URL and credentials")
		}
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "durationMs": time.Since(started).Milliseconds(), "message": "Connected"})
}

func (s *Server) providerMetadata(w http.ResponseWriter, r *http.Request) {
	p, done := s.providerOperation(w, r)
	if p == nil {
		return
	}
	defer done()
	params := r.URL.Query()
	result, err := p.metadata(r.Context(), params.Get("kind"), params.Get("label"), params.Get("metric"))
	if err != nil {
		var remoteErr *observeError
		if errors.As(err, &remoteErr) {
			writeProviderError(w, err)
		} else if errors.Is(err, errUpstream) {
			writeError(w, 502, "provider metadata is unavailable")
		} else {
			writeError(w, 400, err.Error())
		}
		return
	}
	writeJSON(w, 200, result)
}

func (s *Server) isSharedProviderID(id string) bool {
	return s.observe != nil && strings.HasPrefix(id, observeProviderPrefix)
}

func (s *Server) providerTypeInUse(config *ProviderConfig) bool {
	existing, ok := s.providers.get(config.ID)
	return ok && existing.public.Type != config.Type && s.savedQueries.usesProvider(config.ID)
}

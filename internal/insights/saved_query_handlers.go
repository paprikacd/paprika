package insights

import (
	"encoding/json"
	"errors"
	"net/http"
)

func (s *Server) listSavedQueries(w http.ResponseWriter, r *http.Request) {
	providerID := r.URL.Query().Get("providerId")
	if providerID != "" && !validID.MatchString(providerID) {
		writeError(w, 400, "invalid provider ID")
		return
	}
	documents := s.savedQueries.list(providerID)
	if r.URL.Query().Get("summary") == "true" {
		documents = summarizeDocuments(documents, []string{"id", "name", "description", "tags", "providerId", "kind", "etag"}, false)
	}
	writeCollectionJSON(w, r, map[string]any{"queries": documents})
}

func (s *Server) getSavedQuery(w http.ResponseWriter, r *http.Request) {
	document, tag, err := s.savedQueries.get(r.PathValue("id"))
	if err != nil {
		savedQueryStoreError(w, err)
		return
	}
	w.Header().Set("ETag", tag)
	if match := r.Header.Get("If-None-Match"); match == "*" || match == tag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(w, 200, document)
}

func (s *Server) putSavedQuery(w http.ResponseWriter, r *http.Request) {
	var document json.RawMessage
	if err := decodeBody(w, r, &document, maxSavedQueryBytes); err != nil {
		writeError(w, 400, "invalid saved query document")
		return
	}
	query, err := validateSavedQuery(r.PathValue("id"), document)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	shared := s.isSharedProviderID(query.ProviderID)
	// Local provider validation must remain atomic with deletion/type changes.
	// Shared providers live in the gateway, so authorize them before taking
	// the store lock; slow network requests must not block unrelated writes.
	if !shared {
		s.mutations.Lock()
		defer s.mutations.Unlock()
	}
	provider, err := s.resolveProvider(r, query.ProviderID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeError(w, 400, "saved query provider does not exist")
		} else {
			writeProviderError(w, err)
		}
		return
	}
	if provider.public.Capabilities[0] != query.Kind {
		writeError(w, 400, "saved query provider does not support this query kind")
		return
	}
	if shared {
		s.mutations.Lock()
		defer s.mutations.Unlock()
	}
	if updateErr := s.validateSavedQueryUpdate(&query, r.Header.Get("If-Match"), r.Header.Get("If-None-Match")); updateErr != nil {
		savedQueryStoreError(w, updateErr)
		return
	}
	tag, err := s.savedQueries.put(query.ID, document, r.Header.Get("If-Match"), r.Header.Get("If-None-Match"))
	if err != nil {
		savedQueryStoreError(w, err)
		return
	}
	w.Header().Set("ETag", tag)
	writeJSON(w, 200, document)
}

func (s *Server) deleteSavedQuery(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("If-Match") == "" {
		writeError(w, http.StatusPreconditionRequired, "If-Match is required to delete a saved query")
		return
	}
	s.mutations.Lock()
	defer s.mutations.Unlock()
	id := r.PathValue("id")
	previous, _, err := s.savedQueries.get(id)
	if err != nil {
		savedQueryStoreError(w, err)
		return
	}
	if err := preconditions(previous, true, r.Header.Get("If-Match"), ""); err != nil {
		savedQueryStoreError(w, err)
		return
	}
	if s.store.usesSavedQuery(id) {
		writeError(w, 409, "saved query is in use by a persisted dashboard; remove its widget and tooltip references before deleting")
		return
	}
	if err := s.savedQueries.remove(id, r.Header.Get("If-Match")); err != nil {
		savedQueryStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func savedQueryStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		writeError(w, 404, "saved query not found")
	case errors.Is(err, ErrConflict):
		writeError(w, 412, "saved query changed; reload it before saving or deleting")
	case errors.Is(err, ErrCapacity):
		writeError(w, 507, "at most 256 saved queries may be stored")
	case errors.Is(err, errSavedQueryIdentity), errors.Is(err, errSavedQueryCompatibility):
		writeError(w, 409, err.Error())
	default:
		writeError(w, 500, "saved query storage operation failed")
	}
}

func (s *Server) validateSavedQueryUpdate(query *SavedQuery, ifMatch, ifNoneMatch string) error {
	previous, _, err := s.savedQueries.get(query.ID)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := preconditions(previous, true, ifMatch, ifNoneMatch); err != nil {
		return err
	}
	var old SavedQuery
	if json.Unmarshal(previous, &old) != nil {
		return errors.New("invalid stored saved query")
	}
	if old.ProviderID != query.ProviderID || old.Kind != query.Kind {
		return errSavedQueryIdentity
	}
	return s.store.validateSavedQueryReplacement(&old, query)
}

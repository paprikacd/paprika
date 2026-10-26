package insights

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

const maxSavedQueries = 256

var errSavedQueryIdentity = errors.New("saved query provider and kind cannot change; create a new saved query instead")

type savedQueryStore struct {
	mu        sync.RWMutex
	dir       string
	documents map[string]json.RawMessage
}

func openSavedQueryStore(dataDir string) (*savedQueryStore, error) {
	s := &savedQueryStore{dir: filepath.Join(dataDir, "saved-queries"), documents: map[string]json.RawMessage{}}
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return nil, fmt.Errorf("create saved query store: %w", err)
	}
	files, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, fmt.Errorf("read saved query store: %w", err)
	}
	for _, file := range files {
		if !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(file.Name(), ".json")
		if !validID.MatchString(id) || !file.Type().IsRegular() {
			return nil, errors.New("invalid file in saved query store")
		}
		document, err := readStoreDocument(s.dir, file.Name(), maxSavedQueryBytes)
		if err != nil {
			return nil, fmt.Errorf("read saved query document: %w", err)
		}
		if _, err := validateSavedQuery(id, document); err != nil {
			return nil, fmt.Errorf("invalid saved query %s: %w", id, err)
		}
		if len(s.documents) >= maxSavedQueries {
			return nil, ErrCapacity
		}
		s.documents[id] = document
	}
	return s, nil
}

func (s *savedQueryStore) list(providerID string) []json.RawMessage {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := make([]string, 0, len(s.documents))
	for id := range s.documents {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	result := make([]json.RawMessage, 0, len(ids))
	for _, id := range ids {
		var fields map[string]json.RawMessage
		_ = json.Unmarshal(s.documents[id], &fields) //nolint:errcheck // Stored documents passed strict saved query validation before entering the map.
		var provider string
		_ = json.Unmarshal(fields["providerId"], &provider) //nolint:errcheck // Validation requires a string providerId.
		if providerID != "" && providerID != provider {
			continue
		}
		fields["etag"], _ = json.Marshal(etag(s.documents[id])) //nolint:errcheck // A string always has a valid JSON encoding.
		view, _ := json.Marshal(fields)                         //nolint:errcheck // All RawMessages originate from validated JSON or the encoded string above.
		result = append(result, view)
	}
	return result
}

func (s *savedQueryStore) get(id string) (json.RawMessage, string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	document, exists := s.documents[id]
	if !exists {
		return nil, "", ErrNotFound
	}
	return bytes.Clone(document), etag(document), nil
}

func (s *savedQueryStore) put(id string, document json.RawMessage, ifMatch, ifNoneMatch string) (string, error) {
	query, err := validateSavedQuery(id, document)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, exists := s.documents[id]
	if err := preconditions(previous, exists, ifMatch, ifNoneMatch); err != nil {
		return "", err
	}
	if exists {
		var old SavedQuery
		_ = json.Unmarshal(previous, &old) //nolint:errcheck // Every stored query passed validateSavedQuery.
		if old.ProviderID != query.ProviderID || old.Kind != query.Kind {
			return "", errSavedQueryIdentity
		}
	} else if len(s.documents) >= maxSavedQueries {
		return "", ErrCapacity
	}
	if err := persistFile(s.dir, id, document); err != nil {
		return "", err
	}
	s.documents[id] = bytes.Clone(document)
	return etag(document), nil
}

func (s *savedQueryStore) remove(id, ifMatch string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, exists := s.documents[id]
	if !exists {
		return ErrNotFound
	}
	if err := preconditions(previous, true, ifMatch, ""); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(s.dir, id+".json")); err != nil { //nolint:gosec // Only IDs already validated and stored in documents reach deletion.
		return fmt.Errorf("delete saved query: %w", err)
	}
	delete(s.documents, id)
	return syncDirectory(s.dir)
}

func (s *savedQueryStore) usesProvider(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, raw := range s.documents {
		var query SavedQuery
		_ = json.Unmarshal(raw, &query) //nolint:errcheck // Every stored query passed validateSavedQuery.
		if query.ProviderID == id {
			return true
		}
	}
	return false
}

func (s *Store) usesSavedQuery(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, raw := range s.documents {
		var dashboard struct {
			Widgets []struct {
				QueryRef struct{ ID string } `json:"queryRef"`
				Options  struct {
					TooltipView struct {
						Source struct {
							Type string
							Ref  struct{ ID string }
						}
					} `json:"tooltipView"`
				}
			}
		}
		_ = json.Unmarshal(raw, &dashboard) //nolint:errcheck // Every stored dashboard passed validateDashboard.
		for _, widget := range dashboard.Widgets {
			if widget.QueryRef.ID == id || (widget.Options.TooltipView.Source.Type == "saved" && widget.Options.TooltipView.Source.Ref.ID == id) {
				return true
			}
		}
	}
	return false
}

package insights

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

const maxProviders = 32
const maxProviderConfigBytes = 16 << 10

var errProvisioned = errors.New("provisioned providers are read-only; update the service configuration")
var validProviderEnv = regexp.MustCompile(`^PAPRIKA_PROVIDER_[A-Z0-9_]{1,100}$`)

type registeredProvider struct {
	config   ProviderConfig
	client   *providerClient
	managed  bool
	document []byte
}

type providerRegistry struct {
	mu      sync.RWMutex
	dir     string
	entries map[string]*registeredProvider
}

func openProviderRegistry(dataDir string, provisioned []ProviderConfig) (*providerRegistry, error) {
	r := &providerRegistry{dir: filepath.Join(dataDir, "providers"), entries: make(map[string]*registeredProvider)}
	if err := r.addProvisioned(provisioned); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(r.dir, 0700); err != nil {
		return nil, fmt.Errorf("create provider store: %w", err)
	}
	files, err := os.ReadDir(r.dir)
	if err != nil {
		return nil, fmt.Errorf("read provider store: %w", err)
	}
	for _, file := range files {
		if !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(file.Name(), ".json")
		if !validStoreEntry(id, file) {
			return nil, errors.New("invalid file in provider store")
		}
		if _, exists := r.entries[id]; exists {
			return nil, fmt.Errorf("managed provider %s conflicts with provisioned configuration", id)
		}
		entry, err := readProviderEntry(r.dir, file.Name(), id)
		if err != nil {
			return nil, err
		}
		r.entries[id] = entry
	}
	if len(r.entries) > maxProviders {
		return nil, errors.New("at most 32 providers may be configured")
	}
	return r, nil
}

func makeProviderEntry(source *ProviderConfig, managed bool) (*registeredProvider, error) {
	config := *source
	config.HeadersEnv = maps.Clone(config.HeadersEnv)
	if managed {
		refs := []string{}
		if config.BearerTokenEnv != "" {
			refs = append(refs, config.BearerTokenEnv)
		}
		for _, ref := range config.HeadersEnv {
			refs = append(refs, ref)
		}
		for _, ref := range refs {
			if !validProviderEnv.MatchString(ref) {
				return nil, errors.New("managed provider credentials must reference PAPRIKA_PROVIDER_* environment variables")
			}
		}
	}
	client, err := newProvider(&config)
	if err != nil {
		return nil, err
	}
	client.public.Managed = managed
	document, err := json.Marshal(config)
	if err != nil || len(document) > maxProviderConfigBytes {
		return nil, errors.New("provider configuration is too large")
	}
	return &registeredProvider{config: config, client: client, managed: managed, document: document}, nil
}

func (r *providerRegistry) get(id string) (*providerClient, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	entry, ok := r.entries[id]
	if !ok {
		return nil, false
	}
	return entry.client, true
}

func (r *providerRegistry) list() []Provider {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make([]Provider, 0, len(r.entries))
	for _, entry := range r.entries {
		result = append(result, entry.client.public)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

func (entry *registeredProvider) view() ProviderConfigView {
	config := entry.config
	config.HeadersEnv = maps.Clone(config.HeadersEnv)
	return ProviderConfigView{ProviderConfig: config, Managed: entry.managed, ETag: etag(entry.document)}
}

func (r *providerRegistry) configs() []ProviderConfigView {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make([]ProviderConfigView, 0, len(r.entries))
	for _, entry := range r.entries {
		result = append(result, entry.view())
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

func (r *providerRegistry) put(config *ProviderConfig, ifMatch, ifNoneMatch string) (ProviderConfigView, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	previous, exists := r.entries[config.ID]
	if exists && !previous.managed {
		return ProviderConfigView{}, errProvisioned
	}
	var previousDocument []byte
	if exists {
		previousDocument = previous.document
	}
	if err := preconditions(previousDocument, exists, ifMatch, ifNoneMatch); err != nil {
		return ProviderConfigView{}, err
	}
	if !exists && len(r.entries) >= maxProviders {
		return ProviderConfigView{}, ErrCapacity
	}
	entry, err := makeProviderEntry(config, true)
	if err != nil {
		return ProviderConfigView{}, err
	}
	if err := persistFile(r.dir, config.ID, entry.document); err != nil {
		return ProviderConfigView{}, fmt.Errorf("persist provider: %w", err)
	}
	r.entries[config.ID] = entry
	if previous != nil {
		previous.client.client.CloseIdleConnections()
	}
	return entry.view(), nil
}

func (r *providerRegistry) remove(id, ifMatch string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	previous, exists := r.entries[id]
	if !exists {
		return ErrNotFound
	}
	if !previous.managed {
		return errProvisioned
	}
	if err := preconditions(previous.document, true, ifMatch, ""); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(r.dir, id+".json")); err != nil { //nolint:gosec // Only IDs already validated and stored in entries reach deletion.
		return fmt.Errorf("delete provider: %w", err)
	}
	delete(r.entries, id)
	previous.client.client.CloseIdleConnections()
	return syncDirectory(r.dir)
}

func readProviderEntry(dir, filename, id string) (*registeredProvider, error) {
	data, err := readStoreDocument(dir, filename, maxProviderConfigBytes)
	if err != nil {
		return nil, fmt.Errorf("read provider configuration: %w", err)
	}
	var config ProviderConfig
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decodeErr := decoder.Decode(&config); decodeErr != nil || config.ID != id {
		return nil, fmt.Errorf("invalid persisted provider %s", id)
	}
	if decodeErr := decoder.Decode(new(any)); !errors.Is(decodeErr, io.EOF) {
		return nil, fmt.Errorf("invalid persisted provider %s", id)
	}
	return makeProviderEntry(&config, true)
}

func (r *providerRegistry) addProvisioned(provisioned []ProviderConfig) error {
	for _, config := range provisioned {
		if _, exists := r.entries[config.ID]; exists {
			return errors.New("provider ids must be unique")
		}
		entry, err := makeProviderEntry(&config, false)
		if err != nil {
			return err
		}
		r.entries[config.ID] = entry
	}
	return nil
}

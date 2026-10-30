package insights

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"unicode/utf16"
)

const maxDocumentBytes = 256 << 10
const maxDashboards = 100
const maxStoreBytes = 32 << 20

var (
	ErrNotFound = errors.New("dashboard not found")
	ErrConflict = errors.New("dashboard changed since it was loaded; reload before saving")
	ErrCapacity = errors.New("dashboard storage capacity reached")
)

type Store struct {
	mu        sync.RWMutex
	dir       string
	documents map[string]Dashboard
}

// OpenStore uses a single-writer, atomic-file store suitable for a single
// service replica with a persistent volume. Multiple replicas require a shared
// transactional store and are intentionally unsupported.
func OpenStore(dir string) (*Store, error) {
	if dir == "" {
		return nil, errors.New("dashboard data directory is required")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create dashboard store: %w", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read dashboard store: %w", err)
	}
	s := &Store{dir: dir, documents: make(map[string]Dashboard)}
	totalBytes := 0
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		if !validStoreEntry(id, entry) {
			return nil, errors.New("invalid file in dashboard store")
		}
		data, err := readStoreDocument(dir, entry.Name(), maxDocumentBytes)
		if err != nil {
			return nil, fmt.Errorf("read dashboard document: %w", err)
		}
		if err := validateDashboard(id, data); err != nil {
			return nil, fmt.Errorf("invalid saved dashboard %s: %w", id, err)
		}
		totalBytes += len(data)
		if dashboardStoreFull(len(s.documents), totalBytes) {
			return nil, ErrCapacity
		}
		s.documents[id] = data
	}
	return s, nil
}

func (s *Store) List() []Dashboard {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := make([]string, 0, len(s.documents))
	for id := range s.documents {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	documents := make([]Dashboard, 0, len(ids))
	for _, id := range ids {
		documents = append(documents, bytes.Clone(s.documents[id]))
	}
	return documents
}

func (s *Store) Get(id string) (document Dashboard, version string, err error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	doc, ok := s.documents[id]
	if !ok {
		return nil, "", ErrNotFound
	}
	return bytes.Clone(doc), etag(doc), nil
}

// Put checks HTTP preconditions while holding the same lock used by persistence.
// If-Match is optional for clients that intentionally choose last-write-wins.
func (s *Store) Put(id string, document Dashboard, ifMatch, ifNoneMatch string) (string, error) {
	if err := validateDashboard(id, document); err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, exists := s.documents[id]
	if err := preconditions(previous, exists, ifMatch, ifNoneMatch); err != nil {
		return "", err
	}
	if !exists && len(s.documents) >= maxDashboards {
		return "", ErrCapacity
	}
	total := len(document)
	for key, doc := range s.documents {
		if key != id {
			total += len(doc)
		}
	}
	if total > maxStoreBytes {
		return "", ErrCapacity
	}
	if err := s.persist(id, document); err != nil {
		return "", err
	}
	s.documents[id] = bytes.Clone(document)
	return etag(document), nil
}

func (s *Store) Delete(id, ifMatch string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, exists := s.documents[id]
	if !exists {
		return ErrNotFound
	}
	if err := preconditions(previous, exists, ifMatch, ""); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(s.dir, id+".json")); err != nil { //nolint:gosec // The ID must already exist in the map populated only by strict ID validation.
		return fmt.Errorf("delete dashboard: %w", err)
	}
	delete(s.documents, id)
	return syncDirectory(s.dir)
}

func (s *Store) persist(id string, document Dashboard) error {
	return persistFile(s.dir, id, document)
}

func persistFile(dir, id string, document []byte) error {
	f, err := os.CreateTemp(dir, ".document-*")
	if err != nil {
		return fmt.Errorf("create dashboard file: %w", err)
	}
	defer func() {
		// #nosec G703 -- This filename is created by os.CreateTemp in the configured store.
		if removeErr := os.Remove(f.Name()); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			slog.Debug("could not remove temporary insights document")
		}
	}()
	if _, err = f.Write(document); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return fmt.Errorf("write dashboard file: %w", err)
	}
	if closeErr != nil {
		return fmt.Errorf("close dashboard file: %w", closeErr)
	}
	if err := os.Rename(f.Name(), filepath.Join(dir, id+".json")); err != nil { //nolint:gosec // Callers validate IDs before persistence; dir is operator-configured.
		return fmt.Errorf("replace dashboard file: %w", err)
	}
	return syncDirectory(dir)
}

func syncDirectory(dir string) error {
	f, err := os.Open(dir) //nolint:gosec // The directory is the operator-configured persistent store, never a request path.
	if err != nil {
		return fmt.Errorf("open store directory: %w", err)
	}
	syncErr := f.Sync()
	closeErr := f.Close()
	if err := errors.Join(syncErr, closeErr); err != nil {
		return fmt.Errorf("sync store directory: %w", err)
	}
	return nil
}

func etag(document Dashboard) string {
	sum := sha256.Sum256(document)
	return `"` + hex.EncodeToString(sum[:]) + `"`
}

func preconditions(previous Dashboard, exists bool, ifMatch, ifNoneMatch string) error {
	if ifMatch != "" && (!exists || (ifMatch != "*" && ifMatch != etag(previous))) {
		return ErrConflict
	}
	if ifNoneMatch != "" && exists && (ifNoneMatch == "*" || ifNoneMatch == etag(previous)) {
		return ErrConflict
	}
	return nil
}

func validateDashboard(id string, document Dashboard) error {
	if !validID.MatchString(id) || len(document) > maxDocumentBytes {
		return errors.New("dashboard id or size is invalid")
	}
	root, err := requireObjectShape(document, []string{"schemaVersion", "id", "title", "timeRange", "refreshInterval", "widgets"}, []string{"description", "folder", "customTimeRange", "variables"})
	if err != nil {
		return err
	}
	if err := validateDashboardExtensions(root); err != nil {
		return err
	}
	if err := validateDashboardWidgetShapes(root["widgets"]); err != nil {
		return err
	}
	var d dashboardDocument
	if json.Unmarshal(document, &d) != nil {
		return errors.New("dashboard must be a valid JSON object")
	}
	if err := validateDashboardIdentity(&d, id); err != nil {
		return err
	}
	return validateDashboardWidgets(d.Widgets)
}

var validWidgetColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// Match the frontend's strict-object contract, including required zero-valued
// properties and absent-vs-null semantics. Documents accepted through another
// API client must remain readable by the dashboard builder.
func requireObjectShape(data json.RawMessage, required, optional []string) (map[string]json.RawMessage, error) {
	var object map[string]json.RawMessage
	if json.Unmarshal(data, &object) != nil || object == nil {
		return nil, errors.New("dashboard fields must be JSON objects")
	}
	allowed := make(map[string]bool, len(required)+len(optional))
	for _, key := range required {
		allowed[key] = true
		if _, ok := object[key]; !ok {
			return nil, fmt.Errorf("required dashboard field %q is missing", key)
		}
	}
	for _, key := range optional {
		allowed[key] = true
	}
	for key, value := range object {
		if !allowed[key] {
			return nil, fmt.Errorf("unknown dashboard field %q", key)
		}
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, fmt.Errorf("dashboard field %q must not be null", key)
		}
	}
	return object, nil
}

// JavaScript string length counts UTF-16 code units, including surrogate pairs.
func stringUnits(value string) int { return len(utf16.Encode([]rune(value))) }

func trimJS(value string) string {
	return strings.Trim(value, "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}

func readStoreDocument(dir, name string, limit int64) ([]byte, error) {
	// Each caller validates the filename as a regular <validID>.json entry.
	f, err := os.Open(filepath.Join(dir, name)) //nolint:gosec // Only validated store entries beneath the configured directory are read.
	if err != nil {
		return nil, fmt.Errorf("open document: %w", err)
	}
	data, readErr := io.ReadAll(io.LimitReader(f, limit+1))
	closeErr := f.Close()
	if err := errors.Join(readErr, closeErr); err != nil {
		return nil, fmt.Errorf("read document: %w", err)
	}
	if int64(len(data)) > limit {
		return nil, errors.New("document exceeds its size limit")
	}
	return data, nil
}

func validateDashboardWidgetShape(raw json.RawMessage) error {
	widget, err := requireObjectShape(raw, []string{"id", "title", "type", "providerId", "query", "unit", "layout"}, []string{"description", "color", "options", "pluginId", "dataKind", "config", "drilldowns", "queryRef", "selectionBindings", "annotationSource"})
	if err != nil {
		return err
	}
	if err := validateWidgetExtensions(widget); err != nil {
		return err
	}
	if _, err := requireObjectShape(widget["layout"], []string{"x", "y", "w", "h"}, nil); err != nil {
		return err
	}
	if color, exists := widget["color"]; exists {
		var value string
		if json.Unmarshal(color, &value) != nil || !validWidgetColor.MatchString(value) {
			return errors.New("widget color must be a six-digit hex color")
		}
	}
	return nil
}

type dashboardDocument struct {
	SchemaVersion   int               `json:"schemaVersion"`
	ID              string            `json:"id"`
	Title           string            `json:"title"`
	Description     string            `json:"description"`
	TimeRange       string            `json:"timeRange"`
	RefreshInterval int               `json:"refreshInterval"`
	Widgets         []dashboardWidget `json:"widgets"`
}

type dashboardWidget struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Type        string `json:"type"`
	ProviderID  string `json:"providerId"`
	Query       string `json:"query"`
	Unit        string `json:"unit"`
	Description string `json:"description"`
	Color       string `json:"color"`
	Layout      struct {
		X int `json:"x"`
		Y int `json:"y"`
		W int `json:"w"`
		H int `json:"h"`
	} `json:"layout"`
}

func validateDashboardWidget(w *dashboardWidget, seen map[string]bool) error {
	if !validID.MatchString(w.ID) || seen[w.ID] {
		return errors.New("widget ids must be valid and unique")
	}
	seen[w.ID] = true
	if err := validateWidgetText(w); err != nil {
		return err
	}
	switch w.Type {
	case "timeseries", "bar", "stat", "table", "traces", "heatmap", "plugin":
	default:
		return errors.New("unsupported widget type")
	}
	return validateWidgetLayout(w)
}

func validateWidgetText(w *dashboardWidget) error {
	if trimJS(w.Title) == "" || stringUnits(trimJS(w.Title)) > 120 || stringUnits(w.Description) > 500 || stringUnits(w.Unit) > 24 {
		return errors.New("widget title or metadata is invalid")
	}
	if !validID.MatchString(w.ProviderID) || trimJS(w.Query) == "" || stringUnits(trimJS(w.Query)) > 8192 {
		return errors.New("widget provider and query are required")
	}
	return nil
}

func validateWidgetLayout(w *dashboardWidget) error {
	minHeight := 2
	if w.Type == "stat" {
		minHeight = 1
	}
	if w.Layout.X < 0 || w.Layout.Y < 0 || w.Layout.Y > 1000 || w.Layout.W < 1 || w.Layout.W > 12 || w.Layout.X+w.Layout.W > 12 || w.Layout.H < minHeight || w.Layout.H > 12 {
		return errors.New("widget layout is outside the dashboard grid")
	}
	return nil
}

func validateDashboardIdentity(d *dashboardDocument, id string) error {
	if d.SchemaVersion != 1 || d.ID != id {
		return errors.New("dashboard schemaVersion must be 1 and id must match the path")
	}
	if trimJS(d.Title) == "" || stringUnits(trimJS(d.Title)) > 120 || stringUnits(d.Description) > 500 {
		return errors.New("dashboard title or description is invalid")
	}
	switch d.TimeRange {
	case "15m", "30m", "1h", "6h", "24h", "7d", "30d":
	default:
		return errors.New("unsupported dashboard time range")
	}
	switch d.RefreshInterval {
	case 0, 15, 30, 60:
	default:
		return errors.New("unsupported refresh interval")
	}
	return nil
}

func validStoreEntry(id string, entry os.DirEntry) bool {
	return validID.MatchString(id) && entry.Type().IsRegular()
}

func dashboardStoreFull(count, bytes int) bool {
	return count >= maxDashboards || bytes > maxStoreBytes
}

func validateDashboardWidgetShapes(raw json.RawMessage) error {
	var rawWidgets []json.RawMessage
	if json.Unmarshal(raw, &rawWidgets) != nil {
		return errors.New("widgets must be an array")
	}
	for _, raw := range rawWidgets {
		if err := validateDashboardWidgetShape(raw); err != nil {
			return err
		}
	}
	return nil
}

func validateDashboardWidgets(widgets []dashboardWidget) error {
	if widgets == nil || len(widgets) > 48 {
		return errors.New("dashboard requires an array of at most 48 widgets")
	}
	seen := make(map[string]bool)
	for i := range widgets {
		if err := validateDashboardWidget(&widgets[i], seen); err != nil {
			return err
		}
	}
	return nil
}

package fleet

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"k8s.io/apimachinery/pkg/types"
)

const (
	// DefaultApplicationPageSize is used when a query omits its page size.
	DefaultApplicationPageSize uint32 = 100
	// MaxApplicationPageSize bounds one fleet response.
	MaxApplicationPageSize uint32 = 500
	// MaxCursorBytes bounds both the encoded cursor accepted from a caller and
	// its decoded JSON payload. The encoded bound is checked before allocation.
	MaxCursorBytes = 4 * 1024

	querySchemaVersion  = 1
	cursorSchemaVersion = 1
)

// SortField is the provider-neutral application ordering requested by a
// caller. Unspecified normalizes to Name.
type SortField uint8

const (
	SortFieldUnspecified    SortField = 0
	SortFieldName           SortField = 1
	SortFieldProject        SortField = 2
	SortFieldCluster        SortField = 3
	SortFieldStage          SortField = 4
	SortFieldHealth         SortField = 5
	SortFieldSync           SortField = 6
	SortFieldRelease        SortField = 7
	SortFieldRollout        SortField = 8
	SortFieldResourceCount  SortField = 9
	SortFieldLastTransition SortField = 10
	SortFieldImpact         SortField = 11
	SortFieldRelevance      SortField = 12
)

// SortDirection controls the selected sort tuple. Search relevance remains a
// best-first primary tuple regardless of this value.
type SortDirection uint8

const (
	SortDirectionUnspecified SortDirection = 0
	SortDirectionAsc         SortDirection = 1
	SortDirectionDesc        SortDirection = 2
)

// ApplicationQuery is the complete user-controlled input bound into a page
// cursor. Authorization scope, capabilities, and snapshot generation are
// intentionally absent.
type ApplicationQuery struct {
	Filter    ApplicationFilter
	Search    string
	Sort      SortField
	Direction SortDirection
	PageSize  uint32
}

// Normalized validates a query and returns its canonical, deterministic form.
func (q *ApplicationQuery) Normalized() (ApplicationQuery, error) {
	filter := q.Filter.Normalized()
	if err := validateApplicationFilter(&filter); err != nil {
		return ApplicationQuery{}, err
	}

	search, err := NormalizeSearch(q.Search)
	if err != nil {
		return ApplicationQuery{}, err
	}

	sortField, err := normalizeSortField(q.Sort)
	if err != nil {
		return ApplicationQuery{}, err
	}
	direction, err := normalizeSortDirection(q.Direction)
	if err != nil {
		return ApplicationQuery{}, err
	}
	pageSize, err := normalizePageSize(q.PageSize)
	if err != nil {
		return ApplicationQuery{}, err
	}

	return ApplicationQuery{
		Filter: filter, Search: search, Sort: sortField,
		Direction: direction, PageSize: pageSize,
	}, nil
}

func validateApplicationFilter(filter *ApplicationFilter) error {
	if err := validateIdentityFilters(filter); err != nil {
		return err
	}
	return validateStateFilters(filter)
}

func validateIdentityFilters(filter *ApplicationFilter) error {
	if err := validateObjectKeyFilters(filter.Projects, "project"); err != nil {
		return err
	}
	if err := validateObjectKeyFilters(filter.Clusters, "cluster"); err != nil {
		return err
	}
	if err := validateStringFilters(filter.Namespaces, "namespace"); err != nil {
		return err
	}
	return validateStringFilters(filter.Stages, "stage")
}

func validateStateFilters(filter *ApplicationFilter) error {
	if err := validateEnumFilters(filter.Health, HealthHealthy, HealthMissing, "health"); err != nil {
		return err
	}
	if err := validateEnumFilters(filter.Sync, SyncStateSynced, SyncStateUnknown, "sync"); err != nil {
		return err
	}
	if err := validateEnumFilters(
		filter.ReleaseStates, ReleaseStatePending, ReleaseStateAwaitingApproval, "release",
	); err != nil {
		return err
	}
	if err := validateEnumFilters(filter.RolloutStates, RolloutStatePending, RolloutStateAborted, "rollout"); err != nil {
		return err
	}
	return validateEnumFilters(filter.SourceTypes, SourceTypeGit, SourceTypeInline, "source type")
}

func normalizeSortField(field SortField) (SortField, error) {
	if field == SortFieldUnspecified {
		return SortFieldName, nil
	}
	if field < SortFieldName || field > SortFieldRelevance {
		return SortFieldUnspecified, errors.New("invalid fleet sort field")
	}
	return field, nil
}

func normalizeSortDirection(direction SortDirection) (SortDirection, error) {
	if direction == SortDirectionUnspecified {
		return SortDirectionAsc, nil
	}
	if direction != SortDirectionAsc && direction != SortDirectionDesc {
		return SortDirectionUnspecified, errors.New("invalid fleet sort direction")
	}
	return direction, nil
}

func normalizePageSize(size uint32) (uint32, error) {
	if size == 0 {
		return DefaultApplicationPageSize, nil
	}
	if size > MaxApplicationPageSize {
		return 0, errors.New("fleet page size exceeds maximum")
	}
	return size, nil
}

func validateObjectKeyFilters(keys []types.NamespacedName, dimension string) error {
	for i := range keys {
		if !completeObjectKey(keys[i]) {
			return fmt.Errorf("invalid %s filter identity", dimension)
		}
	}
	return nil
}

func validateStringFilters(values []string, dimension string) error {
	for _, value := range values {
		if value == "" {
			return fmt.Errorf("invalid empty %s filter", dimension)
		}
	}
	return nil
}

func validateEnumFilters[T ~uint8](values []T, minimum, maximum T, dimension string) error {
	for _, value := range values {
		if value < minimum || value > maximum {
			return fmt.Errorf("invalid %s filter", dimension)
		}
	}
	return nil
}

type canonicalObjectKey struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

type canonicalApplicationFilter struct {
	Projects      []canonicalObjectKey `json:"projects"`
	Namespaces    []string             `json:"namespaces"`
	Clusters      []canonicalObjectKey `json:"clusters"`
	Stages        []string             `json:"stages"`
	Health        []Health             `json:"health"`
	Sync          []SyncState          `json:"sync"`
	ReleaseStates []ReleaseState       `json:"releaseStates"`
	RolloutStates []RolloutState       `json:"rolloutStates"`
	SourceTypes   []SourceType         `json:"sourceTypes"`
}

type canonicalApplicationQuery struct {
	Version   uint8                      `json:"v"`
	Filter    canonicalApplicationFilter `json:"filter"`
	Search    string                     `json:"search"`
	Sort      SortField                  `json:"sort"`
	Direction SortDirection              `json:"direction"`
	PageSize  uint32                     `json:"pageSize"`
}

func canonicalQueryJSON(query *ApplicationQuery) ([]byte, error) {
	normalized, err := query.Normalized()
	if err != nil {
		return nil, err
	}
	canonical := canonicalApplicationQuery{
		Version: querySchemaVersion,
		Filter: canonicalApplicationFilter{
			Projects:      canonicalObjectKeys(normalized.Filter.Projects),
			Namespaces:    append([]string{}, normalized.Filter.Namespaces...),
			Clusters:      canonicalObjectKeys(normalized.Filter.Clusters),
			Stages:        append([]string{}, normalized.Filter.Stages...),
			Health:        append([]Health{}, normalized.Filter.Health...),
			Sync:          append([]SyncState{}, normalized.Filter.Sync...),
			ReleaseStates: append([]ReleaseState{}, normalized.Filter.ReleaseStates...),
			RolloutStates: append([]RolloutState{}, normalized.Filter.RolloutStates...),
			SourceTypes:   append([]SourceType{}, normalized.Filter.SourceTypes...),
		},
		Search: normalized.Search, Sort: normalized.Sort,
		Direction: normalized.Direction, PageSize: normalized.PageSize,
	}
	payload, err := json.Marshal(canonical)
	if err != nil {
		return nil, fmt.Errorf("marshal canonical fleet query: %w", err)
	}
	return payload, nil
}

func canonicalObjectKeys(keys []types.NamespacedName) []canonicalObjectKey {
	result := make([]canonicalObjectKey, len(keys))
	for i := range keys {
		result[i] = canonicalObjectKey{Namespace: keys[i].Namespace, Name: keys[i].Name}
	}
	return result
}

// QueryHash returns the lowercase hexadecimal SHA-256 digest of canonical
// user query inputs.
//
//nolint:gocritic // Queries are immutable value objects throughout the fleet API.
func QueryHash(query ApplicationQuery) (string, error) {
	payload, err := canonicalQueryJSON(&query)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:]), nil
}

// RelevanceKey preserves exact search ordering without floats.
type RelevanceKey struct {
	Tier   SearchTier `json:"tier"`
	Shared uint32     `json:"shared"`
	Union  uint32     `json:"union"`
}

// ImpactKey is the complete lexicographic impact tuple.
type ImpactKey struct {
	UnhealthySeverity    uint8  `json:"unhealthySeverity"`
	BlockedGates         uint32 `json:"blockedGates"`
	ActiveChange         bool   `json:"activeChange"`
	ResourceCount        uint32 `json:"resourceCount"`
	LastTransitionUnixMS int64  `json:"lastTransitionUnixMs"`
}

// PageKey contains every deterministic value required to resume any supported
// sort without consulting a process-local generation.
type PageKey struct {
	Relevance            RelevanceKey `json:"relevance"`
	Name                 string       `json:"name"`
	Project              ProjectKey   `json:"project"`
	Cluster              ClusterKey   `json:"cluster"`
	Stage                string       `json:"stage"`
	Health               Health       `json:"health"`
	Sync                 SyncState    `json:"sync"`
	Release              ReleaseState `json:"release"`
	Rollout              RolloutState `json:"rollout"`
	ResourceCount        uint32       `json:"resourceCount"`
	LastTransitionUnixMS int64        `json:"lastTransitionUnixMs"`
	Impact               ImpactKey    `json:"impact"`
}

// PageBoundary is the replica-independent last item embedded in a cursor.
// Identity is always the final deterministic tie-breaker.
type PageBoundary struct {
	Key      PageKey
	Identity types.NamespacedName
}

type cursorEnvelope struct {
	Version   uint8   `json:"v"`
	QueryHash string  `json:"queryHash"`
	Tuple     PageKey `json:"tuple"`
	Namespace string  `json:"namespace"`
	Name      string  `json:"name"`
}

// InvalidCursorReason is a safe, enumerable cursor rejection reason.
type InvalidCursorReason string

const (
	InvalidCursorMalformed     InvalidCursorReason = "malformed"
	InvalidCursorNonCanonical  InvalidCursorReason = "non_canonical"
	InvalidCursorOversized     InvalidCursorReason = "oversized"
	InvalidCursorVersion       InvalidCursorReason = "unsupported_version"
	InvalidCursorQueryMismatch InvalidCursorReason = "query_mismatch"
	InvalidCursorIdentity      InvalidCursorReason = "invalid_identity"
	InvalidCursorTuple         InvalidCursorReason = "invalid_tuple"
)

// ErrInvalidCursor is returned for all caller-controlled cursor failures. It
// deliberately retains neither the raw cursor nor decoder details.
type ErrInvalidCursor struct {
	Reason InvalidCursorReason
}

func (e *ErrInvalidCursor) Error() string {
	return "invalid cursor: " + string(e.Reason)
}

// EncodePageCursor encodes a canonical, raw URL-safe v1 page cursor.
//
//nolint:gocritic // Queries and boundaries are immutable value objects at this API seam.
func EncodePageCursor(query ApplicationQuery, boundary PageBoundary) (string, error) {
	if err := validatePageBoundary(&boundary); err != nil {
		return "", err
	}
	hash, err := QueryHash(query)
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(cursorEnvelope{
		Version: cursorSchemaVersion, QueryHash: hash, Tuple: boundary.Key,
		Namespace: boundary.Identity.Namespace, Name: boundary.Identity.Name,
	})
	if err != nil {
		return "", &ErrInvalidCursor{Reason: InvalidCursorMalformed}
	}
	if err := validateCursorPayloadSize(payload); err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	if len(encoded) > MaxCursorBytes {
		return "", &ErrInvalidCursor{Reason: InvalidCursorOversized}
	}
	return encoded, nil
}

// DecodePageCursor validates a cursor against the current canonical query.
//
//nolint:gocritic // Queries are immutable value objects throughout the fleet API.
func DecodePageCursor(query ApplicationQuery, encoded string) (PageBoundary, error) {
	payload, err := decodeCursorPayload(encoded)
	if err != nil {
		return PageBoundary{}, err
	}

	envelope, err := decodeCursorEnvelope(payload)
	if err != nil {
		return PageBoundary{}, err
	}
	if envelope.Version != cursorSchemaVersion {
		return PageBoundary{}, &ErrInvalidCursor{Reason: InvalidCursorVersion}
	}
	if !validQueryHash(envelope.QueryHash) {
		return PageBoundary{}, &ErrInvalidCursor{Reason: InvalidCursorMalformed}
	}
	expected, err := QueryHash(query)
	if err != nil {
		return PageBoundary{}, err
	}
	if subtle.ConstantTimeCompare([]byte(envelope.QueryHash), []byte(expected)) != 1 {
		return PageBoundary{}, &ErrInvalidCursor{Reason: InvalidCursorQueryMismatch}
	}

	boundary := PageBoundary{
		Key:      envelope.Tuple,
		Identity: types.NamespacedName{Namespace: envelope.Namespace, Name: envelope.Name},
	}
	if err := validatePageBoundary(&boundary); err != nil {
		return PageBoundary{}, err
	}
	return boundary, nil
}

func decodeCursorPayload(encoded string) ([]byte, error) {
	if len(encoded) > MaxCursorBytes {
		return nil, &ErrInvalidCursor{Reason: InvalidCursorOversized}
	}
	if encoded == "" {
		return nil, &ErrInvalidCursor{Reason: InvalidCursorMalformed}
	}
	payload, decodeErr := base64.RawURLEncoding.DecodeString(encoded)
	if decodeErr != nil || base64.RawURLEncoding.EncodeToString(payload) != encoded {
		return nil, &ErrInvalidCursor{Reason: InvalidCursorMalformed}
	}
	if sizeErr := validateCursorPayloadSize(payload); sizeErr != nil {
		return nil, sizeErr
	}
	return payload, nil
}

func decodeCursorEnvelope(payload []byte) (cursorEnvelope, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var envelope cursorEnvelope
	if err := decoder.Decode(&envelope); err != nil {
		return cursorEnvelope{}, &ErrInvalidCursor{Reason: InvalidCursorMalformed}
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return cursorEnvelope{}, &ErrInvalidCursor{Reason: InvalidCursorMalformed}
	}
	canonical, err := json.Marshal(envelope)
	if err != nil || !bytes.Equal(canonical, payload) {
		return cursorEnvelope{}, &ErrInvalidCursor{Reason: InvalidCursorNonCanonical}
	}
	return envelope, nil
}

func validateCursorPayloadSize(payload []byte) error {
	if len(payload) > MaxCursorBytes {
		return &ErrInvalidCursor{Reason: InvalidCursorOversized}
	}
	return nil
}

func validQueryHash(value string) bool {
	if len(value) != sha256.Size*2 || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func validatePageBoundary(boundary *PageBoundary) error {
	if !validBoundaryIdentity(boundary) {
		return &ErrInvalidCursor{Reason: InvalidCursorIdentity}
	}
	if !validTupleIdentities(&boundary.Key) || !validRelevanceKey(boundary.Key.Relevance) ||
		!validTupleStates(&boundary.Key) || boundary.Key.Impact.UnhealthySeverity > uint8(HealthMissing) {
		return &ErrInvalidCursor{Reason: InvalidCursorTuple}
	}
	return nil
}

func validBoundaryIdentity(boundary *PageBoundary) bool {
	return completeObjectKey(boundary.Identity) && boundary.Key.Name != "" &&
		boundary.Key.Name == boundary.Identity.Name
}

func validTupleIdentities(key *PageKey) bool {
	return completeObjectKey(key.Project) && emptyOrCompleteObjectKey(key.Cluster)
}

func validTupleStates(key *PageKey) bool {
	return key.Health <= HealthMissing && key.Sync <= SyncStateUnknown &&
		key.Release <= ReleaseStateAwaitingApproval && key.Rollout <= RolloutStateAborted
}

func completeObjectKey(key types.NamespacedName) bool {
	return key.Namespace != "" && key.Name != ""
}

func emptyOrCompleteObjectKey(key types.NamespacedName) bool {
	return (key.Namespace == "" && key.Name == "") || completeObjectKey(key)
}

func validRelevanceKey(key RelevanceKey) bool {
	switch key.Tier {
	case SearchTierNeutral, SearchTierExact, SearchTierPrefix, SearchTierSubstring:
		return key.Shared == 0 && key.Union == 0
	case SearchTierTrigram:
		return key.Union > 0 && key.Shared <= key.Union
	default:
		return false
	}
}

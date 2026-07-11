package fleet

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/types"
)

func TestCursorQueryNormalizationAndHashing(t *testing.T) {
	t.Parallel()

	first := ApplicationQuery{
		Filter: ApplicationFilter{
			Projects: []ProjectKey{
				{Namespace: "z", Name: "payments"},
				{Namespace: "a", Name: "payments"},
				{Namespace: "z", Name: "payments"},
			},
			Namespaces:    []string{"z", "a", "z"},
			Clusters:      []ClusterKey{{Namespace: "z", Name: "prod"}, {Namespace: "a", Name: "dev"}},
			Stages:        []string{"prod", "dev", "prod"},
			Health:        []Health{HealthFailed, HealthHealthy, HealthFailed},
			Sync:          []SyncState{SyncStateOutOfSync, SyncStateSynced},
			ReleaseStates: []ReleaseState{ReleaseStateFailed, ReleaseStatePending},
			RolloutStates: []RolloutState{RolloutStateFailed, RolloutStatePending},
			SourceTypes:   []SourceType{SourceTypeOCI, SourceTypeGit},
		},
		Search: "  ALPHA--Service._ ",
	}
	second := ApplicationQuery{
		Filter: ApplicationFilter{
			Projects:      []ProjectKey{{Namespace: "a", Name: "payments"}, {Namespace: "z", Name: "payments"}},
			Namespaces:    []string{"a", "z"},
			Clusters:      []ClusterKey{{Namespace: "a", Name: "dev"}, {Namespace: "z", Name: "prod"}},
			Stages:        []string{"dev", "prod"},
			Health:        []Health{HealthHealthy, HealthFailed},
			Sync:          []SyncState{SyncStateSynced, SyncStateOutOfSync},
			ReleaseStates: []ReleaseState{ReleaseStatePending, ReleaseStateFailed},
			RolloutStates: []RolloutState{RolloutStatePending, RolloutStateFailed},
			SourceTypes:   []SourceType{SourceTypeGit, SourceTypeOCI},
		},
		Search:    "alpha service",
		Sort:      SortFieldName,
		Direction: SortDirectionAsc,
		PageSize:  100,
	}

	firstNormalized, err := first.Normalized()
	require.NoError(t, err)
	require.Equal(t, second, firstNormalized)
	require.NotNil(t, firstNormalized.Filter.Projects)
	require.NotNil(t, firstNormalized.Filter.Namespaces)

	firstHash, err := QueryHash(first)
	require.NoError(t, err)
	secondHash, err := QueryHash(second)
	require.NoError(t, err)
	require.Equal(t, firstHash, secondHash)
	require.Len(t, firstHash, 64)
	_, err = hex.DecodeString(firstHash)
	require.NoError(t, err)
	require.Equal(t, strings.ToLower(firstHash), firstHash)

	canonical, err := canonicalQueryJSON(&first)
	require.NoError(t, err)
	require.Contains(t, string(canonical), `"v":1`)
	require.Contains(t, string(canonical), `"projects":[`)
	require.Contains(t, string(canonical), `"stages":[`)
	require.NotContains(t, string(canonical), "null")
	require.NotContains(t, string(canonical), "generation")
	require.NotContains(t, string(canonical), "capabil")
}

func TestCursorQueryHashChangesForEverySemanticInput(t *testing.T) {
	t.Parallel()

	base := ApplicationQuery{
		Filter: ApplicationFilter{Projects: []ProjectKey{{Namespace: "apps", Name: "payments"}}},
		Search: "alpha", Sort: SortFieldName, Direction: SortDirectionAsc, PageSize: 25,
	}
	baseHash, err := QueryHash(base)
	require.NoError(t, err)

	tests := map[string]ApplicationQuery{
		"filters":   {Filter: ApplicationFilter{Projects: []ProjectKey{{Namespace: "apps", Name: "orders"}}}, Search: "alpha", Sort: SortFieldName, Direction: SortDirectionAsc, PageSize: 25},
		"search":    {Filter: base.Filter, Search: "beta", Sort: SortFieldName, Direction: SortDirectionAsc, PageSize: 25},
		"sort":      {Filter: base.Filter, Search: "alpha", Sort: SortFieldHealth, Direction: SortDirectionAsc, PageSize: 25},
		"direction": {Filter: base.Filter, Search: "alpha", Sort: SortFieldName, Direction: SortDirectionDesc, PageSize: 25},
		"page size": {Filter: base.Filter, Search: "alpha", Sort: SortFieldName, Direction: SortDirectionAsc, PageSize: 26},
	}
	for name, changed := range tests {
		changed := changed
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			got, hashErr := QueryHash(changed)
			require.NoError(t, hashErr)
			require.NotEqual(t, baseHash, got)
		})
	}
}

func TestCursorBindsEverySemanticQueryDimension(t *testing.T) {
	t.Parallel()

	base := ApplicationQuery{
		Filter: ApplicationFilter{
			Projects: []ProjectKey{
				{Namespace: "apps", Name: "orders"},
				{Namespace: "apps", Name: "payments"},
			},
			Namespaces: []string{"backoffice", "storefront"},
			Clusters: []ClusterKey{
				{Namespace: "clusters", Name: "development"},
				{Namespace: "clusters", Name: "production"},
			},
			Stages:        []string{"development", "production"},
			Health:        []Health{HealthHealthy, HealthDegraded},
			Sync:          []SyncState{SyncStateSynced, SyncStateOutOfSync},
			ReleaseStates: []ReleaseState{ReleaseStatePending, ReleaseStateComplete},
			RolloutStates: []RolloutState{RolloutStatePending, RolloutStateHealthy},
			SourceTypes:   []SourceType{SourceTypeGit, SourceTypeOCI},
		},
		Search: "Alpha--Service",
		Sort:   SortFieldProject, Direction: SortDirectionDesc, PageSize: 25,
	}
	encoded, err := EncodePageCursor(base, validCursorBoundary())
	require.NoError(t, err)

	tests := []struct {
		name   string
		mutate func(*ApplicationQuery)
	}{
		{name: "projects", mutate: func(query *ApplicationQuery) {
			query.Filter.Projects = []ProjectKey{{Namespace: "apps", Name: "inventory"}}
		}},
		{name: "namespaces", mutate: func(query *ApplicationQuery) {
			query.Filter.Namespaces = []string{"platform"}
		}},
		{name: "clusters", mutate: func(query *ApplicationQuery) {
			query.Filter.Clusters = []ClusterKey{{Namespace: "clusters", Name: "staging"}}
		}},
		{name: "stages", mutate: func(query *ApplicationQuery) {
			query.Filter.Stages = []string{"staging"}
		}},
		{name: "health", mutate: func(query *ApplicationQuery) {
			query.Filter.Health = []Health{HealthFailed}
		}},
		{name: "sync", mutate: func(query *ApplicationQuery) {
			query.Filter.Sync = []SyncState{SyncStateUnknown}
		}},
		{name: "release", mutate: func(query *ApplicationQuery) {
			query.Filter.ReleaseStates = []ReleaseState{ReleaseStateFailed}
		}},
		{name: "rollout", mutate: func(query *ApplicationQuery) {
			query.Filter.RolloutStates = []RolloutState{RolloutStateFailed}
		}},
		{name: "source type", mutate: func(query *ApplicationQuery) {
			query.Filter.SourceTypes = []SourceType{SourceTypeHelm}
		}},
		{name: "search", mutate: func(query *ApplicationQuery) {
			query.Search = "beta service"
		}},
		{name: "sort", mutate: func(query *ApplicationQuery) {
			query.Sort = SortFieldHealth
		}},
		{name: "direction", mutate: func(query *ApplicationQuery) {
			query.Direction = SortDirectionAsc
		}},
		{name: "page size", mutate: func(query *ApplicationQuery) {
			query.PageSize = 26
		}},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			changed := base
			test.mutate(&changed)

			_, decodeErr := DecodePageCursor(changed, encoded)
			require.Error(t, decodeErr)
			var invalid *ErrInvalidCursor
			require.True(t, errors.As(decodeErr, &invalid))
			require.Equal(t, InvalidCursorQueryMismatch, invalid.Reason)
		})
	}

	equivalent := ApplicationQuery{
		Filter: ApplicationFilter{
			Projects: []ProjectKey{
				{Namespace: "apps", Name: "payments"},
				{Namespace: "apps", Name: "orders"},
				{Namespace: "apps", Name: "payments"},
			},
			Namespaces: []string{"storefront", "backoffice", "storefront"},
			Clusters: []ClusterKey{
				{Namespace: "clusters", Name: "production"},
				{Namespace: "clusters", Name: "development"},
				{Namespace: "clusters", Name: "production"},
			},
			Stages:        []string{"production", "development", "production"},
			Health:        []Health{HealthDegraded, HealthHealthy, HealthDegraded},
			Sync:          []SyncState{SyncStateOutOfSync, SyncStateSynced, SyncStateOutOfSync},
			ReleaseStates: []ReleaseState{ReleaseStateComplete, ReleaseStatePending, ReleaseStateComplete},
			RolloutStates: []RolloutState{RolloutStateHealthy, RolloutStatePending, RolloutStateHealthy},
			SourceTypes:   []SourceType{SourceTypeOCI, SourceTypeGit, SourceTypeOCI},
		},
		Search: "  ALPHA._service  ",
		Sort:   SortFieldProject, Direction: SortDirectionDesc, PageSize: 25,
	}
	decoded, err := DecodePageCursor(equivalent, encoded)
	require.NoError(t, err)
	require.Equal(t, validCursorBoundary(), decoded)
}

func TestCursorQueryValidation(t *testing.T) {
	t.Parallel()

	tests := map[string]ApplicationQuery{
		"empty project":      {Filter: ApplicationFilter{Projects: []ProjectKey{{}}}},
		"partial project":    {Filter: ApplicationFilter{Projects: []ProjectKey{{Namespace: "apps"}}}},
		"empty cluster":      {Filter: ApplicationFilter{Clusters: []ClusterKey{{}}}},
		"partial cluster":    {Filter: ApplicationFilter{Clusters: []ClusterKey{{Name: "prod"}}}},
		"empty namespace":    {Filter: ApplicationFilter{Namespaces: []string{""}}},
		"empty stage":        {Filter: ApplicationFilter{Stages: []string{""}}},
		"unknown health":     {Filter: ApplicationFilter{Health: []Health{99}}},
		"unspecified health": {Filter: ApplicationFilter{Health: []Health{HealthUnspecified}}},
		"unknown sync":       {Filter: ApplicationFilter{Sync: []SyncState{99}}},
		"unknown release":    {Filter: ApplicationFilter{ReleaseStates: []ReleaseState{99}}},
		"unknown rollout":    {Filter: ApplicationFilter{RolloutStates: []RolloutState{99}}},
		"unknown source":     {Filter: ApplicationFilter{SourceTypes: []SourceType{99}}},
		"unknown sort":       {Sort: SortField(99)},
		"unknown direction":  {Direction: SortDirection(99)},
		"oversized page":     {PageSize: 501},
		"oversized search":   {Search: strings.Repeat("界", MaxSearchRunes+1)},
	}
	for name, query := range tests {
		query := query
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := query.Normalized()
			require.Error(t, err)
		})
	}
}

func TestCursorRoundTripsCompleteDeterministicBoundary(t *testing.T) {
	t.Parallel()

	query := ApplicationQuery{Search: "checkout", Sort: SortFieldImpact, Direction: SortDirectionDesc, PageSize: 37}
	boundary := PageBoundary{
		Key: PageKey{
			Relevance: RelevanceKey{Tier: SearchTierTrigram, Shared: 17, Union: 29},
			Name:      "checkout-api",
			Project:   ProjectKey{Namespace: "tenant", Name: "payments"},
			Cluster:   ClusterKey{Namespace: "clusters", Name: "prod"},
			Stage:     "production",
			Health:    HealthFailed, Sync: SyncStateOutOfSync,
			Release: ReleaseStateAwaitingApproval, Rollout: RolloutStatePaused,
			ResourceCount: 431, LastTransitionUnixMS: 1_752_000_000_123,
			Impact: ImpactKey{UnhealthySeverity: 4, BlockedGates: 3, ActiveChange: true, ResourceCount: 431, LastTransitionUnixMS: 1_752_000_000_123},
		},
		Identity: types.NamespacedName{Namespace: "apps", Name: "checkout-api"},
	}

	encoded, err := EncodePageCursor(query, boundary)
	require.NoError(t, err)
	require.NotContains(t, encoded, "=")
	require.NotContains(t, encoded, "+")
	require.NotContains(t, encoded, "/")

	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	require.NoError(t, err)
	require.NotContains(t, string(payload), "generation")
	require.NotContains(t, string(payload), "epoch")

	decoded, err := DecodePageCursor(query, encoded)
	require.NoError(t, err)
	require.Equal(t, boundary, decoded)
}

func TestCursorRejectsMalformedNonCanonicalAndMismatchedData(t *testing.T) {
	t.Parallel()

	query := ApplicationQuery{Sort: SortFieldName, Direction: SortDirectionAsc, PageSize: 10}
	boundary := validCursorBoundary()
	valid, err := EncodePageCursor(query, boundary)
	require.NoError(t, err)
	payload, err := base64.RawURLEncoding.DecodeString(valid)
	require.NoError(t, err)

	changedQuery := query
	changedQuery.PageSize++
	tests := map[string]struct {
		cursor string
		query  ApplicationQuery
		reason InvalidCursorReason
	}{
		"empty":              {cursor: "", query: query, reason: InvalidCursorMalformed},
		"padding":            {cursor: valid + "=", query: query, reason: InvalidCursorMalformed},
		"standard base64":    {cursor: base64.StdEncoding.EncodeToString(payload), query: query, reason: InvalidCursorMalformed},
		"invalid alphabet":   {cursor: "***", query: query, reason: InvalidCursorMalformed},
		"leading whitespace": {cursor: base64.RawURLEncoding.EncodeToString(append([]byte(" "), payload...)), query: query, reason: InvalidCursorNonCanonical},
		"duplicate field":    {cursor: encodeCursorFixture(strings.Replace(string(payload), `{"v":1`, `{"v":1,"v":1`, 1)), query: query, reason: InvalidCursorNonCanonical},
		"unknown field":      {cursor: encodeCursorFixture(strings.TrimSuffix(string(payload), "}") + `,"extra":true}`), query: query, reason: InvalidCursorMalformed},
		"unknown version":    {cursor: mutateCursorFixture(t, payload, func(value *cursorEnvelope) { value.Version = 2 }), query: query, reason: InvalidCursorVersion},
		"bad hash":           {cursor: mutateCursorFixture(t, payload, func(value *cursorEnvelope) { value.QueryHash = strings.Repeat("g", 64) }), query: query, reason: InvalidCursorMalformed},
		"query mismatch":     {cursor: valid, query: changedQuery, reason: InvalidCursorQueryMismatch},
		"missing namespace":  {cursor: mutateCursorFixture(t, payload, func(value *cursorEnvelope) { value.Namespace = "" }), query: query, reason: InvalidCursorIdentity},
		"missing name":       {cursor: mutateCursorFixture(t, payload, func(value *cursorEnvelope) { value.Name = "" }), query: query, reason: InvalidCursorIdentity},
	}
	for name, test := range tests {
		test := test
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, decodeErr := DecodePageCursor(test.query, test.cursor)
			require.Error(t, decodeErr)
			var invalid *ErrInvalidCursor
			require.True(t, errors.As(decodeErr, &invalid))
			require.Equal(t, test.reason, invalid.Reason)
			if test.cursor != "" {
				require.NotContains(t, decodeErr.Error(), test.cursor)
			}
		})
	}
}

func TestCursorRejectsInvalidTupleRanges(t *testing.T) {
	t.Parallel()

	query := ApplicationQuery{}
	valid := validCursorBoundary()
	tests := map[string]func(*PageBoundary){
		"unknown tier":        func(value *PageBoundary) { value.Key.Relevance.Tier = SearchTier(99) },
		"direct shared count": func(value *PageBoundary) { value.Key.Relevance.Shared = 1 },
		"direct union count":  func(value *PageBoundary) { value.Key.Relevance.Union = 1 },
		"trigram zero union": func(value *PageBoundary) {
			value.Key.Relevance = RelevanceKey{Tier: SearchTierTrigram, Shared: 0, Union: 0}
		},
		"trigram shared over union": func(value *PageBoundary) {
			value.Key.Relevance = RelevanceKey{Tier: SearchTierTrigram, Shared: 5, Union: 4}
		},
		"partial project": func(value *PageBoundary) { value.Key.Project = ProjectKey{Name: "payments"} },
		"partial cluster": func(value *PageBoundary) { value.Key.Cluster = ClusterKey{Namespace: "clusters"} },
		"unknown health":  func(value *PageBoundary) { value.Key.Health = Health(99) },
		"unknown sync":    func(value *PageBoundary) { value.Key.Sync = SyncState(99) },
		"unknown release": func(value *PageBoundary) { value.Key.Release = ReleaseState(99) },
		"unknown rollout": func(value *PageBoundary) { value.Key.Rollout = RolloutState(99) },
		"impact severity": func(value *PageBoundary) { value.Key.Impact.UnhealthySeverity = 7 },
	}
	for name, mutate := range tests {
		mutate := mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			boundary := valid
			mutate(&boundary)
			_, err := EncodePageCursor(query, boundary)
			require.Error(t, err)
			var invalid *ErrInvalidCursor
			require.True(t, errors.As(err, &invalid))
			require.Equal(t, InvalidCursorTuple, invalid.Reason)
		})
	}
}

func TestCursorSizeBoundChecksEncodedAndDecodedData(t *testing.T) {
	t.Parallel()

	query := ApplicationQuery{}
	_, err := DecodePageCursor(query, strings.Repeat("a", MaxCursorBytes))
	require.Error(t, err)
	var atBoundary *ErrInvalidCursor
	require.True(t, errors.As(err, &atBoundary))
	require.NotEqual(t, InvalidCursorOversized, atBoundary.Reason)

	_, err = DecodePageCursor(query, strings.Repeat("a", MaxCursorBytes+1))
	require.Error(t, err)
	var oversized *ErrInvalidCursor
	require.True(t, errors.As(err, &oversized))
	require.Equal(t, InvalidCursorOversized, oversized.Reason)

	err = validateCursorPayloadSize(make([]byte, MaxCursorBytes))
	require.NoError(t, err)
	err = validateCursorPayloadSize(make([]byte, MaxCursorBytes+1))
	require.Error(t, err)
	require.True(t, errors.As(err, &oversized))
}

func validCursorBoundary() PageBoundary {
	return PageBoundary{
		Key: PageKey{
			Relevance: RelevanceKey{Tier: SearchTierNeutral},
			Name:      "checkout",
			Project:   ProjectKey{Namespace: "apps", Name: "payments"},
			Health:    HealthHealthy,
			Sync:      SyncStateSynced,
			Impact:    ImpactKey{UnhealthySeverity: 0},
		},
		Identity: types.NamespacedName{Namespace: "apps", Name: "checkout"},
	}
}

func encodeCursorFixture(payload string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(payload))
}

func mutateCursorFixture(t *testing.T, payload []byte, mutate func(*cursorEnvelope)) string {
	t.Helper()
	var value cursorEnvelope
	require.NoError(t, json.Unmarshal(payload, &value))
	mutate(&value)
	mutated, err := json.Marshal(value)
	require.NoError(t, err)
	return base64.RawURLEncoding.EncodeToString(mutated)
}

package insights

import (
	"net/url"
	"reflect"
	"testing"
)

func TestProviderQueryParametersPreserveWireContract(t *testing.T) {
	cases := []struct {
		name   string
		query  Query
		path   string
		params url.Values
	}{
		{"metrics", Query{Kind: "metrics", Query: "up", Start: 100.5, End: 200.5, Step: 5}, "/api/v1/query_range", url.Values{"start": {"100.5"}, "end": {"200.5"}, "query": {"up"}, "step": {"5"}, "timeout": {"15s"}, "limit": {"100"}}},
		{"trace detail ignores search window", Query{Kind: "traces", TraceID: "abc", Start: 100.5, End: 200.5}, "/api/traces/abc", url.Values{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path, params := providerQueryParameters(&tc.query)
			if path != tc.path || !reflect.DeepEqual(params, tc.params) {
				t.Fatalf("got %q %v, want %q %v", path, params, tc.path, tc.params)
			}
		})
	}
}

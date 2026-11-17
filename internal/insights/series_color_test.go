package insights

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTimeSeriesColorRulesValidation(t *testing.T) {
	for _, tc := range []struct {
		name  string
		raw   string
		valid bool
	}{
		{"valid", `{"seriesColors":[{"label":"window","value":"1h","color":"#348cf0"},{"label":"window","value":"6h","color":"#15c7a1"}]}`, true},
		{"duplicate", `{"seriesColors":[{"label":"window","value":"1h","color":"#348cf0"},{"label":"window","value":"1h","color":"#15c7a1"}]}`, false},
		{"invalid label", `{"seriesColors":[{"label":"bad label","value":"1h","color":"#348cf0"}]}`, false},
		{"empty value", `{"seriesColors":[{"label":"window","value":"","color":"#348cf0"}]}`, false},
		{"invalid color", `{"seriesColors":[{"label":"window","value":"1h","color":"blue"}]}`, false},
		{"null rules", `{"seriesColors":null}`, false},
		{"extra property", `{"seriesColors":[{"label":"window","value":"1h","color":"#348cf0","extra":true}]}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateWidgetOptions(json.RawMessage(tc.raw))
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v; error=%v", tc.valid, err)
			}
		})
	}
}

func TestSeriesColorRoleRules(t *testing.T) {
	for _, tc := range []struct {
		name  string
		raw   string
		valid bool
	}{
		{"role", `{"seriesColors":[{"label":"quantile","value":"p95","role":"p95"}]}`, true},
		{"color and role", `{"seriesColors":[{"label":"quantile","value":"p95","color":"#348cf0","role":"p95"}]}`, false},
		{"neither", `{"seriesColors":[{"label":"quantile","value":"p95"}]}`, false},
		{"unknown role", `{"seriesColors":[{"label":"code","value":"500","role":"error-5xx"}]}`, false},
		{"status is not a role", `{"seriesColors":[{"label":"code","value":"500","role":"critical"}]}`, false},
		{"null role", `{"seriesColors":[{"label":"quantile","value":"p95","role":null}]}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateWidgetOptions(json.RawMessage(tc.raw))
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v; error=%v", tc.valid, err)
			}
		})
	}
}

// A role that is not a known name must say which roles are allowed, never demand a hex colour.
func TestSeriesColorRoleErrorsNameTheRoles(t *testing.T) {
	for _, raw := range []string{
		`{"seriesColors":[{"label":"quantile","value":"p95","role":5}]}`,
		`{"seriesColors":[{"label":"quantile","value":"p95","role":"error-5xx"}]}`,
	} {
		err := validateWidgetOptions(json.RawMessage(raw))
		if err == nil || !strings.Contains(err.Error(), "series color role must be one of traffic, success, client-error, server-error, p50, p95, p99") {
			t.Fatalf("%s: error %v", raw, err)
		}
	}
}

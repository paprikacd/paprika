package insights

import (
	"encoding/json"
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

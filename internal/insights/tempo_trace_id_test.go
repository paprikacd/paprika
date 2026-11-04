package insights

import (
	"strings"
	"testing"
)

// Tempo may return short hexadecimal IDs when high-order bytes are zero.
// Detail queries and the browser use canonical 128-bit IDs.
func TestTempoSearchCanonicalTraceID(t *testing.T) {
	for _, test := range []struct {
		name, id, want string
		invalid        bool
	}{
		{name: "leading zero lost", id: "604e767b95d0eb71536e7cb2833ce42", want: "0604e767b95d0eb71536e7cb2833ce42"},
		{name: "64-bit id", id: "1234567890abcdef", want: "00000000000000001234567890abcdef"},
		{name: "canonical", id: "00112233445566778899aabbccddeeff", want: "00112233445566778899aabbccddeeff"},
		{name: "uppercase", id: "AABB", want: "0000000000000000000000000000aabb"},
		{name: "nonhex", id: "not-a-trace", invalid: true},
		{name: "empty", id: "", invalid: true},
		{name: "too long", id: strings.Repeat("a", 33), invalid: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := decodeTempoTrace(tempoTrace{TraceID: test.id, StartTimeUnixNano: "1700000000123000000", DurationMs: 12})
			if test.invalid {
				if err == nil {
					t.Fatalf("expected invalid trace ID %q to be rejected", test.id)
				}
				return
			}
			if err != nil || got.TraceID != test.want {
				t.Fatalf("got ID %q error %v; want %q", got.TraceID, err, test.want)
			}
		})
	}
}

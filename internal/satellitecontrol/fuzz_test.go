package satellitecontrol

import (
	"encoding/json"
	"testing"
)

// FuzzDecodeReport covers the control plane's untrusted-input boundary: a
// satellite report arrives over the network from a binary deployed
// independently of the control plane it talks to.
//
// The contract is narrow and worth fuzzing rather than sampling: decoding must
// never panic, and the result must be either a report that passed validation or
// an error. Nothing downstream re-checks the shape.
func FuzzDecodeReport(f *testing.F) {
	seeds := []string{
		`{}`,
		`{"protocolVersion":1,"clusterNamespace":"paprika-system","clusterName":"edge","sessionId":"s","sequence":1,"snapshot":true}`,
		`{"protocolVersion":1,"sessionId":"s","sequence":1,"applications":[{"namespace":"checkout","name":"web","health":"Healthy"}]}`,
		`{"protocolVersion":1,"sessionId":"s","sequence":1,"applications":[{"namespace":"../etc","name":".."}]}`,
		`{"protocolVersion":1,"sessionId":"s","sequence":1,"capacity":{"cpuMillicores":{"allocatable":-1}}}`,
		`{"protocolVersion":1,"sessionId":"s","sequence":1}{"trailing":true}`,
		`null`,
		`[]`,
	}
	for _, seed := range seeds {
		f.Add([]byte(seed))
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		report, err := decodeReport(data)
		if err != nil {
			if report != nil {
				t.Fatalf("decodeReport returned a report alongside an error: %+v", report)
			}
			return
		}
		if report == nil {
			t.Fatal("decodeReport succeeded without a report")
		}
		// An accepted report is re-encoded on the link path and persisted into
		// status, so it must survive both.
		if _, marshalErr := json.Marshal(report); marshalErr != nil {
			t.Fatalf("accepted report cannot be re-encoded: %v", marshalErr)
		}
		if validateErr := validateReport(report); validateErr != nil {
			t.Fatalf("accepted report fails validation on the second pass: %v", validateErr)
		}
	})
}

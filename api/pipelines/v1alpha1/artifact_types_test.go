package v1alpha1

import (
	"testing"
)

func TestArtifactProvenanceStep(t *testing.T) {
	provenance := ArtifactProvenance{
		Pipeline: "my-pipeline",
		Build:    "build-123",
		Step:     "build",
	}

	if provenance.Step != "build" {
		t.Errorf("expected step 'build', got %q", provenance.Step)
	}
}

func TestArtifactSpecTypeValues(t *testing.T) {
	cases := []struct {
		specType string
	}{
		{"oci"},
		{"configmap"},
	}

	for _, tc := range cases {
		spec := ArtifactSpec{Type: tc.specType, Reference: "example"}
		if spec.Type != tc.specType {
			t.Errorf("expected type %q, got %q", tc.specType, spec.Type)
		}
	}
}

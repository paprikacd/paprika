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

	if provenance.Pipeline != "my-pipeline" {
		t.Errorf("expected pipeline 'my-pipeline', got %q", provenance.Pipeline)
	}
	if provenance.Build != "build-123" {
		t.Errorf("expected build 'build-123', got %q", provenance.Build)
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
		spec := ArtifactSpec{Type: tc.specType}
		if spec.Type != tc.specType {
			t.Errorf("expected type %q, got %q", tc.specType, spec.Type)
		}
	}
}

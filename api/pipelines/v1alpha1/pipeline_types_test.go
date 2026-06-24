package v1alpha1

import (
	"encoding/json"
	"testing"
)

func TestPipelineStepOutputs(t *testing.T) {
	step := PipelineStep{
		Outputs: []PipelineOutput{{Name: "binary", Path: "oci://registry.io/repo:tag"}},
	}

	if len(step.Outputs) != 1 {
		t.Fatalf("expected 1 output, got %d", len(step.Outputs))
	}
	if step.Outputs[0].Name != "binary" {
		t.Errorf("expected output name 'binary', got %q", step.Outputs[0].Name)
	}
	if step.Outputs[0].Path != "oci://registry.io/repo:tag" {
		t.Errorf("expected output path 'oci://registry.io/repo:tag', got %q", step.Outputs[0].Path)
	}
}

func TestPipelineOutputStep(t *testing.T) {
	output := PipelineOutput{
		Name: "binary",
		Path: "oci://registry.io/repo:tag",
		Step: "build",
	}

	if output.Name != "binary" {
		t.Errorf("expected name 'binary', got %q", output.Name)
	}
	if output.Path != "oci://registry.io/repo:tag" {
		t.Errorf("expected path 'oci://registry.io/repo:tag', got %q", output.Path)
	}
	if output.Step != "build" {
		t.Errorf("expected step 'build', got %q", output.Step)
	}

	data, err := json.Marshal(output)
	if err != nil {
		t.Fatalf("failed to marshal PipelineOutput: %v", err)
	}

	var got map[string]interface{}
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("failed to unmarshal PipelineOutput JSON: %v", err)
	}
	if got["step"] != "build" {
		t.Errorf("expected JSON step 'build', got %v", got["step"])
	}
}

func TestPipelineArtifactPhaseConstants(t *testing.T) {
	cases := []struct {
		phase    PipelineArtifactPhase
		expected string
	}{
		{PipelineArtifactPhasePending, "Pending"},
		{PipelineArtifactPhaseReady, "Ready"},
		{PipelineArtifactPhaseFailed, "Failed"},
	}

	for _, tc := range cases {
		if string(tc.phase) != tc.expected {
			t.Errorf("expected phase %q, got %q", tc.expected, string(tc.phase))
		}
	}
}

func TestPipelineArtifactRef(t *testing.T) {
	ref := PipelineArtifactRef{
		Name:          "my-pipeline-build-binary",
		Kind:          "oci",
		Reference:     "oci://registry.io/repo:tag",
		Phase:         PipelineArtifactPhasePending,
		ProducingStep: "build",
		CreatedAt:     1782000000,
	}

	if ref.Name != "my-pipeline-build-binary" {
		t.Errorf("expected name 'my-pipeline-build-binary', got %q", ref.Name)
	}
	if ref.Kind != "oci" {
		t.Errorf("expected kind 'oci', got %q", ref.Kind)
	}
	if ref.Reference != "oci://registry.io/repo:tag" {
		t.Errorf("expected reference 'oci://registry.io/repo:tag', got %q", ref.Reference)
	}
	if ref.Phase != PipelineArtifactPhasePending {
		t.Errorf("expected phase Pending, got %q", ref.Phase)
	}
	if ref.ProducingStep != "build" {
		t.Errorf("expected producing step 'build', got %q", ref.ProducingStep)
	}
	if ref.CreatedAt != 1782000000 {
		t.Errorf("expected created at 1782000000, got %d", ref.CreatedAt)
	}
}

func TestPipelineStatusArtifactRefs(t *testing.T) {
	status := PipelineStatus{
		ArtifactRefs: []PipelineArtifactRef{
			{Name: "artifact-1", Phase: PipelineArtifactPhaseReady},
		},
	}

	if len(status.ArtifactRefs) != 1 {
		t.Fatalf("expected 1 artifact ref, got %d", len(status.ArtifactRefs))
	}
	if status.ArtifactRefs[0].Name != "artifact-1" {
		t.Errorf("expected artifact ref name 'artifact-1', got %q", status.ArtifactRefs[0].Name)
	}
}

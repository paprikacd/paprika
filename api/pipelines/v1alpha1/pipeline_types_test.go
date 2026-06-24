package v1alpha1

import (
	"encoding/json"
	"testing"
)

func TestPipelineStepOutputs(t *testing.T) {
	step := PipelineStep{
		Name:    "build",
		Image:   "alpine:latest",
		Script:  "echo hello",
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

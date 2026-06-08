package engine

import (
	"context"
	"testing"

	paprika "github.com/benebsworth/paprika/api/v1alpha1"
)

func TestSanitizeRepoName(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"https://charts.example.com", "charts-example-com"},
		{"https://charts.bitnami.com/bitnami", "charts-bitnami-com-bitnami"},
		{"oci://registry.example.com", "oci---registry-example-com"},
	}
	for _, tt := range tests {
		result := sanitizeRepoName(tt.input)
		if result != tt.expected {
			t.Fatalf("sanitizeRepoName(%q) = %q, want %q", tt.input, result, tt.expected)
		}
	}
}

func TestRenderAll_NoTemplates(t *testing.T) {
	renderer := NewTemplateRenderer("/tmp")
	output, err := renderer.RenderAll(context.Background(), nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(output) != 0 {
		t.Fatalf("expected empty output, got %d bytes", len(output))
	}
}

func TestRenderAll_EmptyTemplates(t *testing.T) {
	renderer := NewTemplateRenderer("/tmp")
	output, err := renderer.RenderAll(context.Background(), []paprika.Template{}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(output) != 0 {
		t.Fatalf("expected empty output, got %d bytes", len(output))
	}
}

func TestRender_UnsupportedType(t *testing.T) {
	renderer := NewTemplateRenderer("/tmp")
	tmpl := &paprika.Template{
		Spec: paprika.TemplateSpec{Type: "kustomize"},
	}
	_, err := renderer.Render(context.Background(), tmpl, nil)
	if err == nil {
		t.Fatal("expected error for unsupported type, got nil")
	}
}

func TestTemplateRenderer_New(t *testing.T) {
	r := NewTemplateRenderer("/tmp/helm-work")
	if r.WorkDir != "/tmp/helm-work" {
		t.Fatalf("expected /tmp/helm-work, got %q", r.WorkDir)
	}
}

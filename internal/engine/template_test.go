package engine

import (
	"testing"
)

func TestSplitYAMLDocuments(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		input    string
		wantDocs int
	}{
		{
			name: "three documents",
			input: `apiVersion: v1
kind: ConfigMap
metadata:
  name: foo
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bar
---
apiVersion: v1
kind: Service
metadata:
  name: baz
`,
			wantDocs: 3,
		},
		{
			name:     "empty input",
			input:    "",
			wantDocs: 0,
		},
		{
			name: "single document",
			input: `apiVersion: v1
kind: ConfigMap
metadata:
  name: single
`,
			wantDocs: 1,
		},
		{
			name: "empty separators ignored",
			input: `---
apiVersion: v1
kind: ConfigMap
metadata:
  name: foo
---
---
apiVersion: v1
kind: Service
metadata:
  name: baz
`,
			wantDocs: 2,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			docs := SplitYAMLDocuments([]byte(tc.input))
			if len(docs) != tc.wantDocs {
				t.Fatalf("expected %d documents, got %d", tc.wantDocs, len(docs))
			}
		})
	}
}

func TestSanitizeRepoName(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input    string
		expected string
	}{
		{"https://charts.helm.sh/stable", "charts-helm-sh-stable"},
		{"http://repo.example.com", "repo-example-com"},
		{"simple-repo", "simple-repo"},
	}

	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			t.Parallel()
			result := sanitizeRepoName(tc.input)
			if result != tc.expected {
				t.Errorf("sanitizeRepoName(%q) = %q, want %q", tc.input, result, tc.expected)
			}
		})
	}
}

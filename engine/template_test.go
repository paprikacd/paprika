package engine

import (
	"testing"
)

func TestSplitYAMLDocuments(t *testing.T) {
	input := []byte(`apiVersion: v1
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
`)
	docs := SplitYAMLDocuments(input)
	if len(docs) != 3 {
		t.Fatalf("expected 3 documents, got %d", len(docs))
	}
}

func TestSplitYAMLDocuments_Empty(t *testing.T) {
	input := []byte("")
	docs := SplitYAMLDocuments(input)
	if len(docs) != 0 {
		t.Fatalf("expected 0 documents, got %d", len(docs))
	}
}

func TestSplitYAMLDocuments_SingleDoc(t *testing.T) {
	input := []byte(`apiVersion: v1
kind: ConfigMap
metadata:
  name: single
`)
	docs := SplitYAMLDocuments(input)
	if len(docs) != 1 {
		t.Fatalf("expected 1 document, got %d", len(docs))
	}
}

func TestSplitYAMLDocuments_WithEmptyDocs(t *testing.T) {
	input := []byte(`---
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
`)
	docs := SplitYAMLDocuments(input)
	if len(docs) != 2 {
		t.Fatalf("expected 2 non-empty documents, got %d", len(docs))
	}
}

func TestSanitizeRepoName(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"https://charts.helm.sh/stable", "charts-helm-sh-stable"},
		{"http://repo.example.com", "repo-example-com"},
		{"simple-repo", "simple-repo"},
	}

	for _, tc := range tests {
		result := sanitizeRepoName(tc.input)
		if result != tc.expected {
			t.Errorf("sanitizeRepoName(%q) = %q, want %q", tc.input, result, tc.expected)
		}
	}
}

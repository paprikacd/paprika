package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadTemplateSpecPreservesMetadataForTemplateCR(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "template.yaml")
	if err := os.WriteFile(path, []byte(`
apiVersion: pipelines.paprika.io/v1alpha1
kind: Template
metadata:
  name: brandbrain-api-template
  namespace: paprika-e2e
spec:
  type: git
  git:
    repoUrl: https://github.com/skunkworq/brandbrain.git
    revision: main
    path: deploy/kubernetes/chart
    secretRef: skunkworq-git-read-token
`), 0o600); err != nil {
		t.Fatalf("write template: %v", err)
	}

	_, sourceType, name, namespace, err := readTemplateSpec(path)
	if err != nil {
		t.Fatalf("readTemplateSpec() error: %v", err)
	}
	if sourceType != "git" {
		t.Fatalf("sourceType = %q, want git", sourceType)
	}
	if name != "brandbrain-api-template" {
		t.Fatalf("name = %q, want brandbrain-api-template", name)
	}
	if namespace != "paprika-e2e" {
		t.Fatalf("namespace = %q, want paprika-e2e", namespace)
	}
}

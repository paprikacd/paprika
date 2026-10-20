package agent

import (
	"testing"
)

// TestSplitYAMLDocumentsRejectsABrokenBundle pins the difference between "this
// bundle is smaller than expected" and "this bundle is broken".
//
// Truncating at the first undecodable document made Apply report success with
// nothing applied, which the control plane read as a completed release and the
// satellite remembered as the state to enforce.
func TestSplitYAMLDocumentsRejectsABrokenBundle(t *testing.T) {
	t.Parallel()

	valid := []byte("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: b\n")
	docs, err := splitYAMLDocuments(valid)
	if err != nil {
		t.Fatalf("valid bundle: %v", err)
	}
	if len(docs) != 2 {
		t.Fatalf("documents = %d, want 2", len(docs))
	}

	if _, parseErr := splitYAMLDocuments([]byte("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: [unclosed\n")); parseErr == nil {
		t.Fatal("a malformed bundle must be an error, not an empty apply")
	}

	if _, parseErr := splitYAMLDocuments([]byte("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ok\n---\n\tbroken: [\n")); parseErr == nil {
		t.Fatal("a bundle that breaks after a valid document must be an error")
	}

	docs, err = splitYAMLDocuments([]byte("\n\n# only comments\n"))
	if err != nil {
		t.Fatalf("empty bundle: %v", err)
	}
	if len(docs) != 0 {
		t.Fatalf("documents = %d, want none", len(docs))
	}
}

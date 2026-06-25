package pipelines

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
)

func TestParseArtifactReference(t *testing.T) {
	t.Parallel()

	cases := []struct {
		path     string
		wantKind string
		wantRef  string
	}{
		{"oci://registry.io/repo:tag", "oci", "registry.io/repo:tag"},
		{"configmap://my-cm/my-key", "configmap", "my-cm/my-key"},
		{"configmap://my-cm", "configmap", "my-cm"},
	}

	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			t.Parallel()
			kind, ref, err := parseArtifactReference(tc.path)
			if err != nil {
				t.Fatalf("path %q: %v", tc.path, err)
			}
			if kind != tc.wantKind || ref != tc.wantRef {
				t.Fatalf("path %q: got (%s, %s), want (%s, %s)", tc.path, kind, ref, tc.wantKind, tc.wantRef)
			}
		})
	}
}

func TestParseConfigMapReference(t *testing.T) {
	t.Parallel()

	cases := []struct {
		ref      string
		wantName string
		wantKey  string
		wantErr  bool
	}{
		{"my-cm/my-key", "my-cm", "my-key", false},
		{"my-cm", "my-cm", "", false},
		{"", "", "", true},
	}

	for _, tc := range cases {
		t.Run(tc.ref, func(t *testing.T) {
			t.Parallel()
			name, key, err := parseConfigMapReference(tc.ref)
			if (err != nil) != tc.wantErr {
				t.Fatalf("ref %q: unexpected error status: %v", tc.ref, err)
			}
			if name != tc.wantName || key != tc.wantKey {
				t.Fatalf("ref %q: got (%s, %s), want (%s, %s)", tc.ref, name, key, tc.wantName, tc.wantKey)
			}
		})
	}
}

func TestResolveConfigMapKey(t *testing.T) {
	t.Parallel()

	t.Run("returns error when key is empty and multiple keys exist", func(t *testing.T) {
		t.Parallel()
		cm := &corev1.ConfigMap{
			Data: map[string]string{"a": "1", "b": "2"},
		}
		if _, err := resolveConfigMapKey(cm, ""); err == nil {
			t.Fatalf("expected ambiguous error")
		}
	})

	t.Run("returns single key when key is empty", func(t *testing.T) {
		t.Parallel()
		single := &corev1.ConfigMap{Data: map[string]string{"only": "x"}}
		key, err := resolveConfigMapKey(single, "")
		if err != nil || key != "only" {
			t.Fatalf("expected only key, got %q %v", key, err)
		}
	})

	t.Run("returns requested key from Data", func(t *testing.T) {
		t.Parallel()
		cm := &corev1.ConfigMap{Data: map[string]string{"a": "1", "b": "2"}}
		key, err := resolveConfigMapKey(cm, "b")
		if err != nil || key != "b" {
			t.Fatalf("expected key b, got %q %v", key, err)
		}
	})

	t.Run("returns error when requested key is missing", func(t *testing.T) {
		t.Parallel()
		cm := &corev1.ConfigMap{Data: map[string]string{"a": "1"}}
		if _, err := resolveConfigMapKey(cm, "missing"); err == nil {
			t.Fatalf("expected key not found error")
		}
	})
}

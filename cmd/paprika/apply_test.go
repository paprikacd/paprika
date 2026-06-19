package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestLoadPath(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name            string
		setup           func(t *testing.T) (path string, wantSuggested string)
		wantErr         bool
		wantErrContains string
		wantContains    []string
	}{
		{
			name: "single file",
			setup: func(t *testing.T) (string, string) {
				dir := t.TempDir()
				path := filepath.Join(dir, "deploy.yaml")
				if err := os.WriteFile(path, []byte("apiVersion: v1\nkind: ConfigMap"), 0o644); err != nil {
					t.Fatalf("write file: %v", err)
				}
				return path, "deploy"
			},
			wantContains: []string{"apiVersion: v1\nkind: ConfigMap"},
		},
		{
			name: "directory with yaml files",
			setup: func(t *testing.T) (string, string) {
				dir := t.TempDir()
				if err := os.WriteFile(filepath.Join(dir, "a.yaml"), []byte("a: 1"), 0o644); err != nil {
					t.Fatalf("write file: %v", err)
				}
				if err := os.WriteFile(filepath.Join(dir, "b.yml"), []byte("b: 2"), 0o644); err != nil {
					t.Fatalf("write file: %v", err)
				}
				return dir, filepath.Base(dir)
			},
			wantContains: []string{"a: 1", "b: 2"},
		},
		{
			name: "empty directory",
			setup: func(t *testing.T) (string, string) {
				dir := t.TempDir()
				return dir, filepath.Base(dir)
			},
			wantContains: []string{},
		},
		{
			name: "missing file",
			setup: func(t *testing.T) (string, string) {
				return filepath.Join(t.TempDir(), "missing.yaml"), ""
			},
			wantErr:         true,
			wantErrContains: "stat path",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			path, wantSuggested := tt.setup(t)
			docs, suggested, err := loadPath(path)
			if (err != nil) != tt.wantErr {
				t.Fatalf("loadPath() error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr {
				if !strings.Contains(err.Error(), tt.wantErrContains) {
					t.Fatalf("error %q does not contain %q", err.Error(), tt.wantErrContains)
				}
				return
			}
			if suggested != wantSuggested {
				t.Errorf("suggested name = %q, want %q", suggested, wantSuggested)
			}
			if len(docs) != len(tt.wantContains) {
				t.Errorf("got %d docs, want %d", len(docs), len(tt.wantContains))
			}
			for i, want := range tt.wantContains {
				if i >= len(docs) {
					break
				}
				if docs[i] != want {
					t.Errorf("doc[%d] = %q, want %q", i, docs[i], want)
				}
			}
		})
	}
}

func TestLoadManifestBundle(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name            string
		setup           func(t *testing.T) (paths []string, wantSuggested string)
		wantErr         bool
		wantErrContains string
		wantContains    []string
	}{
		{
			name: "single file",
			setup: func(t *testing.T) ([]string, string) {
				dir := t.TempDir()
				path := filepath.Join(dir, "deploy.yaml")
				if err := os.WriteFile(path, []byte("apiVersion: v1\nkind: ConfigMap"), 0o644); err != nil {
					t.Fatalf("write file: %v", err)
				}
				return []string{path}, "deploy"
			},
			wantContains: []string{"apiVersion: v1\nkind: ConfigMap"},
		},
		{
			name: "directory",
			setup: func(t *testing.T) ([]string, string) {
				dir := t.TempDir()
				if err := os.WriteFile(filepath.Join(dir, "a.yaml"), []byte("a: 1"), 0o644); err != nil {
					t.Fatalf("write file: %v", err)
				}
				if err := os.WriteFile(filepath.Join(dir, "b.yml"), []byte("b: 2"), 0o644); err != nil {
					t.Fatalf("write file: %v", err)
				}
				return []string{dir}, filepath.Base(dir)
			},
			wantContains: []string{"a: 1", "b: 2"},
		},
		{
			name: "multiple files",
			setup: func(t *testing.T) ([]string, string) {
				dir := t.TempDir()
				f1 := filepath.Join(dir, "x.yaml")
				f2 := filepath.Join(dir, "y.yaml")
				if err := os.WriteFile(f1, []byte("x: 1"), 0o644); err != nil {
					t.Fatalf("write file: %v", err)
				}
				if err := os.WriteFile(f2, []byte("y: 2"), 0o644); err != nil {
					t.Fatalf("write file: %v", err)
				}
				return []string{f1, f2}, "x"
			},
			wantContains: []string{"x: 1", "y: 2"},
		},
		{
			name: "missing file",
			setup: func(t *testing.T) ([]string, string) {
				return []string{filepath.Join(t.TempDir(), "missing.yaml")}, ""
			},
			wantErr:         true,
			wantErrContains: "stat path",
		},
		{
			name: "empty directory",
			setup: func(t *testing.T) ([]string, string) {
				return []string{t.TempDir()}, filepath.Base(t.TempDir())
			},
			wantErr:         true,
			wantErrContains: "no manifests found",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			paths, wantSuggested := tt.setup(t)
			bundle, suggested, err := loadManifestBundle(paths)
			if (err != nil) != tt.wantErr {
				t.Fatalf("loadManifestBundle() error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr {
				if !strings.Contains(err.Error(), tt.wantErrContains) {
					t.Fatalf("error %q does not contain %q", err.Error(), tt.wantErrContains)
				}
				return
			}
			if suggested != wantSuggested {
				t.Errorf("suggested name = %q, want %q", suggested, wantSuggested)
			}
			got := string(bundle)
			for _, want := range tt.wantContains {
				if !strings.Contains(got, want) {
					t.Errorf("bundle does not contain %q:\n%s", want, got)
				}
			}
		})
	}
}

func TestDeriveAppName(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		bundle        []byte
		firstPath     string
		suggestedName string
		want          string
	}{
		{
			name:          "from manifest metadata",
			bundle:        []byte("metadata:\n  name: my-app\nspec: {}"),
			firstPath:     "",
			suggestedName: "",
			want:          "my-app",
		},
		{
			name:          "from suggested name when no metadata",
			bundle:        []byte("apiVersion: v1\nkind: ConfigMap"),
			firstPath:     "/tmp/app.yaml",
			suggestedName: "suggested-app",
			want:          "suggested-app",
		},
		{
			name:          "from file path fallback",
			bundle:        []byte("apiVersion: v1\nkind: ConfigMap"),
			firstPath:     "/tmp/app.yaml",
			suggestedName: "",
			want:          "app",
		},
		{
			name:          "first doc metadata wins",
			bundle:        []byte("metadata:\n  name: first\n---\nmetadata:\n  name: second"),
			firstPath:     "",
			suggestedName: "",
			want:          "first",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := deriveAppName(tt.bundle, tt.firstPath, tt.suggestedName)
			if err != nil {
				t.Fatalf("deriveAppName() unexpected error: %v", err)
			}
			if got != tt.want {
				t.Errorf("deriveAppName() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestParsePolicyOverrides(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name            string
		in              []string
		want            map[string]string
		wantErr         bool
		wantErrContains string
	}{
		{
			name: "valid enforce",
			in:   []string{"security=enforce"},
			want: map[string]string{"security": "enforce"},
		},
		{
			name: "valid warn mixed case",
			in:   []string{"Lint=Warn"},
			want: map[string]string{"Lint": "warn"},
		},
		{
			name: "multiple overrides",
			in:   []string{"a=enforce", "b=warn"},
			want: map[string]string{"a": "enforce", "b": "warn"},
		},
		{
			name:            "invalid format missing equals",
			in:              []string{"security"},
			wantErr:         true,
			wantErrContains: "invalid policy override",
		},
		{
			name:            "invalid action",
			in:              []string{"security=block"},
			wantErr:         true,
			wantErrContains: "invalid policy override action",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := parsePolicyOverrides(tt.in)
			if (err != nil) != tt.wantErr {
				t.Fatalf("parsePolicyOverrides() error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr {
				if !strings.Contains(err.Error(), tt.wantErrContains) {
					t.Fatalf("error %q does not contain %q", err.Error(), tt.wantErrContains)
				}
				return
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("parsePolicyOverrides() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestCurrentNamespace(t *testing.T) {
	t.Setenv("KUBECONFIG", filepath.Join(t.TempDir(), "nonexistent"))

	got := currentNamespace()
	if got != "default" {
		t.Fatalf("currentNamespace() = %q, want %q", got, "default")
	}
}

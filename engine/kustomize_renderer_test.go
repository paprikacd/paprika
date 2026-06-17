package engine

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	paprika "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestRenderKustomize_Standalone(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "deployment.yaml"), []byte(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
spec:
  replicas: 1
`), 0o640))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "kustomization.yaml"), []byte(`
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- deployment.yaml
`), 0o640))

	renderer := NewHelmSDKRenderer(t.TempDir())
	tmpl := &paprika.Template{
		Spec: paprika.TemplateSpec{
			Type:      sourceTypeKustomize,
			Kustomize: &paprika.KustomizeSourceSpec{Path: dir},
		},
	}

	out, err := renderer.Render(context.Background(), tmpl, nil)
	require.NoError(t, err)
	assert.Contains(t, string(out), "kind: Deployment")
	assert.Contains(t, string(out), "name: nginx")
}

func TestRenderKustomize_WithTransformations(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "deployment.yaml"), []byte(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
spec:
  replicas: 1
`), 0o640))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "kustomization.yaml"), []byte(`
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- deployment.yaml
`), 0o640))

	renderer := NewHelmSDKRenderer(t.TempDir())
	tmpl := &paprika.Template{
		Spec: paprika.TemplateSpec{
			Type: sourceTypeKustomize,
			Kustomize: &paprika.KustomizeSourceSpec{
				Path:       dir,
				NamePrefix: "prod-",
				Namespace:  "prod",
				CommonLabels: map[string]string{
					"env": "prod",
				},
			},
		},
	}

	out, err := renderer.Render(context.Background(), tmpl, nil)
	require.NoError(t, err)
	rendered := string(out)
	assert.Contains(t, rendered, "name: prod-nginx")
	assert.Contains(t, rendered, "namespace: prod")
	assert.Contains(t, rendered, "env: prod")
}

func TestRenderAll_LayeredHelmToKustomize(t *testing.T) {
	workDir := t.TempDir()
	chartDir := filepath.Join(workDir, "chart")
	require.NoError(t, os.MkdirAll(filepath.Join(chartDir, "templates"), 0o750))
	require.NoError(t, os.WriteFile(filepath.Join(chartDir, "Chart.yaml"), []byte(`
apiVersion: v2
name: test-chart
version: 0.1.0
`), 0o640))
	require.NoError(t, os.WriteFile(filepath.Join(chartDir, "templates", "configmap.yaml"), []byte(`
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "test-chart.fullname" . }}
data:
  key: value
`), 0o640))
	require.NoError(t, os.WriteFile(filepath.Join(chartDir, "templates", "_helpers.tpl"), []byte(`
{{- define "test-chart.fullname" -}}
{{ .Release.Name }}-test-chart
{{- end -}}
`), 0o640))

	renderer := NewHelmSDKRenderer(workDir)
	templates := []paprika.Template{
		{
			ObjectMeta: metav1.ObjectMeta{Name: "helm-base"},
			Spec: paprika.TemplateSpec{
				Type: sourceTypeHelm,
				Chart: paprika.ChartRef{
					Path: chartDir,
				},
			},
		},
		{
			ObjectMeta: metav1.ObjectMeta{Name: "kustomize-overlay"},
			Spec: paprika.TemplateSpec{
				Type: sourceTypeKustomize,
				Kustomize: &paprika.KustomizeSourceSpec{
					InputFromPrevious: true,
					NamePrefix:        "layered-",
					CommonLabels: map[string]string{
						"layer": "kustomize",
					},
				},
			},
		},
	}

	out, err := renderer.RenderAll(context.Background(), templates, map[string]string{
		"release-name": "myrelease",
	})
	require.NoError(t, err)
	rendered := string(out)
	assert.Contains(t, rendered, "name: layered-myrelease-test-chart")
	assert.Contains(t, rendered, "layer: kustomize")
	assert.False(t, strings.Contains(rendered, "helm-base"))
	assert.False(t, strings.Contains(rendered, "kustomize-overlay"))
}

func TestRenderKustomize_InputFromPreviousWithoutPrevious(t *testing.T) {
	renderer := NewHelmSDKRenderer(t.TempDir())
	tmpl := &paprika.Template{
		Spec: paprika.TemplateSpec{
			Type: sourceTypeKustomize,
			Kustomize: &paprika.KustomizeSourceSpec{
				InputFromPrevious: true,
			},
		},
	}

	_, err := renderer.Render(context.Background(), tmpl, nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no previous render output available")
}

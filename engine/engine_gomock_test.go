package engine_test

import (
	"context"
	"errors"
	"testing"

	"go.uber.org/mock/gomock"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/engine"
	enginemocks "github.com/benebsworth/paprika/engine/mocks"
)

func TestTemplateRendererMock(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		setupMock func(m *enginemocks.MockTemplateRenderer)
		wantErr   bool
	}{
		{
			name: "successful render",
			setupMock: func(m *enginemocks.MockTemplateRenderer) {
				m.EXPECT().Render(gomock.Any(), gomock.Any(), gomock.Any()).
					Return([]byte("apiVersion: v1\nkind: ConfigMap\n"), nil).Times(1)
			},
			wantErr: false,
		},
		{
			name: "render error",
			setupMock: func(m *enginemocks.MockTemplateRenderer) {
				m.EXPECT().Render(gomock.Any(), gomock.Any(), gomock.Any()).
					Return(nil, errors.New("render failed")).Times(1)
			},
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			mockRenderer := enginemocks.NewMockTemplateRenderer(ctrl)
			tc.setupMock(mockRenderer)

			tmpl := &paprikav1.Template{
				ObjectMeta: metav1.ObjectMeta{Name: "test-template"},
				Spec: paprikav1.TemplateSpec{
					Type: "helm",
				},
			}
			result, err := mockRenderer.Render(context.Background(), tmpl, map[string]string{"key": "value"})

			if tc.wantErr {
				if err == nil {
					t.Error("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Errorf("unexpected error: %v", err)
			}
			if result == nil {
				t.Error("expected result, got nil")
			}
		})
	}
}

func TestDiffEngineMock(t *testing.T) {
	t.Parallel()

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockEngine := enginemocks.NewMockDiffEngine(ctrl)

	desired := []unstructured.Unstructured{
		{Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "ConfigMap",
			"metadata": map[string]interface{}{
				"name":      "test-cm",
				"namespace": "default",
			},
		}},
	}

	expectedResult := &engine.DiffResult{
		Added: []engine.ResourceDiff{
			{Kind: "ConfigMap", Name: "test-cm", Namespace: "default", Action: "Added"},
		},
		Summary: "+1 ~0 -0",
	}

	opts := engine.DiffOptions{Namespace: "default"}
	mockEngine.EXPECT().ComputeDiff(gomock.Any(), desired, opts).
		Return(expectedResult, nil).Times(1)

	result, err := mockEngine.ComputeDiff(context.Background(), desired, opts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Fatal("expected result, got nil")
	}
	if len(result.Added) != 1 {
		t.Errorf("expected 1 added resource, got %d", len(result.Added))
	}
	if result.Added[0].Name != "test-cm" {
		t.Errorf("expected name 'test-cm', got '%s'", result.Added[0].Name)
	}
	if result.Summary != "+1 ~0 -0" {
		t.Errorf("expected summary '+1 ~0 -0', got '%s'", result.Summary)
	}
}

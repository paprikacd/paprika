package governance

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func makeAppProject() *corev1alpha1.AppProject {
	return &corev1alpha1.AppProject{
		Spec: corev1alpha1.AppProjectSpec{
			SourceRepos:  []string{"https://github.com/acme/*"},
			Repositories: []string{"payments-repo"},
			Destinations: []corev1alpha1.AppProjectDestination{
				{Server: "https://kubernetes.default.svc", Namespace: "payments-*"},
			},
			Kinds: []string{"Deployment", "Service"},
		},
	}
}

func TestProjectValidator_Validate_AllowsCompliant(t *testing.T) {
	v := NewProjectValidator(nil, &clusterResolver{}, nil)
	app := &pipelinesv1alpha1.Application{
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Project: "payments",
			Source: pipelinesv1alpha1.ApplicationSource{
				Type:    pipelinesv1alpha1.SourceTypeGit,
				RepoURL: "https://github.com/acme/payments.git",
				RepoRef: "payments-repo",
			},
			Stages: []pipelinesv1alpha1.ApplicationPromotionStage{
				{Name: "prod", Ring: 1, Cluster: pipelinesv1alpha1.ClusterRef{Server: "https://kubernetes.default.svc"}},
			},
		},
	}
	violations, err := v.Validate(context.Background(), app, nil, makeAppProject())
	require.NoError(t, err)
	assert.Empty(t, violations)
}

func TestProjectValidator_Validate_RejectsBadKind(t *testing.T) {
	v := NewProjectValidator(nil, &clusterResolver{}, nil)
	app := &pipelinesv1alpha1.Application{
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Project: "payments",
			Source: pipelinesv1alpha1.ApplicationSource{
				Type:    pipelinesv1alpha1.SourceTypeGit,
				RepoURL: "https://github.com/acme/payments.git",
			},
			Stages: []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}},
		},
	}
	manifests := []*unstructured.Unstructured{
		{Object: map[string]interface{}{"apiVersion": "v1", "kind": "Secret", "metadata": map[string]interface{}{"name": "app", "namespace": "payments-prod"}}},
	}
	violations, err := v.Validate(context.Background(), app, manifests, makeAppProject())
	require.NoError(t, err)
	require.Len(t, violations, 1)
	assert.True(t, violations[0].Blocking())
}

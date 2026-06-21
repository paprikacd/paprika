/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package v1alpha1

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/governance"
)

// newQuotaRelease builds a minimal valid Release labelled with the given project.
func newQuotaRelease(name, project string) *pipelinesv1alpha1.Release {
	return &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: "default",
			Labels:    map[string]string{projectLabelKey: project},
		},
		Spec: pipelinesv1alpha1.ReleaseSpec{Target: "prod"},
	}
}

func TestReleaseCustomValidator_Quota(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, corev1alpha1.AddToScheme(scheme))
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))

	buildValidator := func(project *corev1alpha1.AppProject, existing ...*pipelinesv1alpha1.Release) *ReleaseCustomValidator {
		objs := make([]client.Object, 0, 1+len(existing))
		objs = append(objs, project)
		for _, r := range existing {
			objs = append(objs, r)
		}
		c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).Build()
		resolver := governance.NewProjectResolver(c)
		validator := governance.NewProjectValidator(resolver, governance.NewClusterResolver(c), nil)
		return &ReleaseCustomValidator{validator: validator, client: c}
	}

	t.Run("allowed when under the limit", func(t *testing.T) {
		project := &corev1alpha1.AppProject{
			ObjectMeta: metav1.ObjectMeta{Name: "quota", Namespace: "default"},
			Spec: corev1alpha1.AppProjectSpec{
				SourceRepos: []string{"*"},
				Destinations: []corev1alpha1.AppProjectDestination{
					{Server: "*", Namespace: "*"},
				},
				Kinds:  []string{"*"},
				Limits: &corev1alpha1.ProjectLimits{MaxReleases: 2},
			},
		}
		existing := newQuotaRelease("rel-1", "quota")
		v := buildValidator(project, existing)
		_, err := v.ValidateCreate(context.Background(), newQuotaRelease("rel-2", "quota"))
		require.NoError(t, err)
	})

	t.Run("rejected when at the limit", func(t *testing.T) {
		project := &corev1alpha1.AppProject{
			ObjectMeta: metav1.ObjectMeta{Name: "quota", Namespace: "default"},
			Spec: corev1alpha1.AppProjectSpec{
				SourceRepos: []string{"*"},
				Destinations: []corev1alpha1.AppProjectDestination{
					{Server: "*", Namespace: "*"},
				},
				Kinds:  []string{"*"},
				Limits: &corev1alpha1.ProjectLimits{MaxReleases: 2},
			},
		}
		existing := []*pipelinesv1alpha1.Release{
			newQuotaRelease("rel-1", "quota"),
			newQuotaRelease("rel-2", "quota"),
		}
		v := buildValidator(project, existing...)
		_, err := v.ValidateCreate(context.Background(), newQuotaRelease("rel-3", "quota"))
		require.Error(t, err)
		assert.Contains(t, err.Error(), "MaxReleases limit")
	})

	t.Run("allowed when no limit set (Limits nil)", func(t *testing.T) {
		project := &corev1alpha1.AppProject{
			ObjectMeta: metav1.ObjectMeta{Name: "nolimits", Namespace: "default"},
			Spec: corev1alpha1.AppProjectSpec{
				SourceRepos: []string{"*"},
				Destinations: []corev1alpha1.AppProjectDestination{
					{Server: "*", Namespace: "*"},
				},
				Kinds: []string{"*"},
			},
		}
		existing := []*pipelinesv1alpha1.Release{
			newQuotaRelease("rel-1", "nolimits"),
			newQuotaRelease("rel-2", "nolimits"),
		}
		v := buildValidator(project, existing...)
		_, err := v.ValidateCreate(context.Background(), newQuotaRelease("rel-3", "nolimits"))
		require.NoError(t, err)
	})

	t.Run("allowed when MaxReleases is zero (unlimited)", func(t *testing.T) {
		project := &corev1alpha1.AppProject{
			ObjectMeta: metav1.ObjectMeta{Name: "zero", Namespace: "default"},
			Spec: corev1alpha1.AppProjectSpec{
				SourceRepos: []string{"*"},
				Destinations: []corev1alpha1.AppProjectDestination{
					{Server: "*", Namespace: "*"},
				},
				Kinds:  []string{"*"},
				Limits: &corev1alpha1.ProjectLimits{MaxReleases: 0},
			},
		}
		existing := []*pipelinesv1alpha1.Release{
			newQuotaRelease("rel-1", "zero"),
			newQuotaRelease("rel-2", "zero"),
		}
		v := buildValidator(project, existing...)
		_, err := v.ValidateCreate(context.Background(), newQuotaRelease("rel-3", "zero"))
		require.NoError(t, err)
	})
}

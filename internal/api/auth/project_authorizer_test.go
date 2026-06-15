package auth

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
)

func init() {
	_ = corev1alpha1.AddToScheme(scheme.Scheme)
}

func TestProjectAuthorizer_AllowsWhenProjectEmpty(t *testing.T) {
	authz := NewProjectAuthorizer(fake.NewClientBuilder().Build())
	require.NoError(t, authz.Authorize(context.Background(), &Principal{Subject: "any"}, ActionRead, ResourceApplications, "ns", ""))
}

func TestProjectAuthorizer_AllowsDefaultMissingProject(t *testing.T) {
	authz := NewProjectAuthorizer(fake.NewClientBuilder().Build())
	require.NoError(t, authz.Authorize(context.Background(), &Principal{Subject: "any"}, ActionRead, ResourceApplications, "ns", "default"))
}

func TestProjectAuthorizer_MatchingRole(t *testing.T) {
	ap := &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Name: "payments", Namespace: "default"},
		Spec: corev1alpha1.AppProjectSpec{
			Roles: []corev1alpha1.AppProjectRole{{
				Subjects: []string{"alice"},
				Actions:  []string{"read"},
			}},
		},
	}
	authz := NewProjectAuthorizer(fake.NewClientBuilder().WithObjects(ap).Build())
	require.NoError(t, authz.Authorize(context.Background(), &Principal{Subject: "alice"}, ActionRead, ResourceApplications, "default", "payments"))
}

func TestProjectAuthorizer_DeniesNonMatchingSubject(t *testing.T) {
	ap := &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Name: "payments", Namespace: "default"},
		Spec: corev1alpha1.AppProjectSpec{
			Roles: []corev1alpha1.AppProjectRole{{
				Subjects: []string{"alice"},
				Actions:  []string{"read"},
			}},
		},
	}
	authz := NewProjectAuthorizer(fake.NewClientBuilder().WithObjects(ap).Build())
	assert.Error(t, authz.Authorize(context.Background(), &Principal{Subject: "bob"}, ActionRead, ResourceApplications, "default", "payments"))
}

func TestProjectAuthorizer_GroupSubject(t *testing.T) {
	ap := &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Name: "payments", Namespace: "default"},
		Spec: corev1alpha1.AppProjectSpec{
			Roles: []corev1alpha1.AppProjectRole{{
				Subjects: []string{"group:payments"},
				Actions:  []string{"*"},
			}},
		},
	}
	authz := NewProjectAuthorizer(fake.NewClientBuilder().WithObjects(ap).Build())
	require.NoError(t, authz.Authorize(context.Background(), &Principal{Subject: "bob", Groups: []string{"payments"}}, ActionWrite, ResourceApplications, "default", "payments"))
}

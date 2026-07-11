package auth

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
)

func init() {
	_ = corev1alpha1.AddToScheme(scheme.Scheme)
}

func TestProjectAuthorizer(t *testing.T) {
	paymentsProject := &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Name: "payments", Namespace: "default"},
		Spec: corev1alpha1.AppProjectSpec{
			Roles: []corev1alpha1.AppProjectRole{{
				Subjects: []string{"alice"},
				Actions:  []string{"read"},
			}},
		},
	}

	groupProject := &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Name: "payments", Namespace: "default"},
		Spec: corev1alpha1.AppProjectSpec{
			Roles: []corev1alpha1.AppProjectRole{{
				Subjects: []string{"group:payments"},
				Actions:  []string{"*"},
			}},
		},
	}

	tests := []struct {
		name      string
		objs      []client.Object
		principal *Principal
		action    Action
		ns        string
		project   string
		wantErr   bool
	}{
		{
			name:      "allows when project empty",
			principal: &Principal{Subject: "any"},
			action:    ActionRead,
			ns:        "ns",
			project:   "",
			wantErr:   false,
		},
		{
			name:      "allows default missing project",
			principal: &Principal{Subject: "any"},
			action:    ActionRead,
			ns:        "ns",
			project:   "default",
			wantErr:   false,
		},
		{
			name:      "matching role allows",
			objs:      []client.Object{paymentsProject},
			principal: &Principal{Subject: "alice"},
			action:    ActionRead,
			ns:        "default",
			project:   "payments",
			wantErr:   false,
		},
		{
			name:      "non-matching subject denies",
			objs:      []client.Object{paymentsProject},
			principal: &Principal{Subject: "bob"},
			action:    ActionRead,
			ns:        "default",
			project:   "payments",
			wantErr:   true,
		},
		{
			name:      "group subject allows",
			objs:      []client.Object{groupProject},
			principal: &Principal{Subject: "bob", Groups: []string{"payments"}},
			action:    ActionWrite,
			ns:        "default",
			project:   "payments",
			wantErr:   false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			authz := NewProjectAuthorizer(fake.NewClientBuilder().WithObjects(tc.objs...).Build())
			err := authz.Authorize(context.Background(), tc.principal, tc.action, ResourceApplications, tc.ns, tc.project)
			if tc.wantErr {
				assert.Error(t, err)
			} else {
				require.NoError(t, err)
			}
		})
	}
}

func TestAuthorizedProjectsProjectAuthorizerPreservesNamespacedIdentity(t *testing.T) {
	t.Parallel()
	objects := []client.Object{
		appProject("tenant-a", "payments", "alice"),
		appProject("tenant-b", "payments", "bob"),
		appProject("tenant-a", "orders", "alice"),
	}
	authorizer := NewProjectAuthorizer(fake.NewClientBuilder().WithObjects(objects...).Build())
	candidates := []ProjectRef{
		{Namespace: "tenant-b", Name: "payments"},
		{Namespace: "tenant-a", Name: "payments"},
		{Namespace: "tenant-a", Name: "orders"},
	}

	got, err := authorizer.AuthorizedProjects(
		context.Background(), &Principal{Subject: "alice"},
		ActionRead, ResourceApplications, candidates,
	)
	require.NoError(t, err)
	assert.Equal(t, []ProjectRef{
		{Namespace: "tenant-a", Name: "payments"},
		{Namespace: "tenant-a", Name: "orders"},
	}, got)
}

func TestAuthorizedProjectsProjectAuthorizerAllowsMissingDefaultCompatibility(t *testing.T) {
	t.Parallel()
	authorizer := NewProjectAuthorizer(fake.NewClientBuilder().Build())
	candidates := []ProjectRef{{Namespace: "tenant-a", Name: "default"}}

	got, err := authorizer.AuthorizedProjects(
		context.Background(), &Principal{Subject: "alice"},
		ActionRead, ResourceApplications, candidates,
	)
	require.NoError(t, err)
	assert.Equal(t, candidates, got)
}

func TestAuthorizedProjectsProjectAuthorizerOmitsMissingNonDefaultCandidate(t *testing.T) {
	t.Parallel()
	valid := appProject("tenant-a", "payments", "alice")
	authorizer := NewProjectAuthorizer(fake.NewClientBuilder().WithObjects(valid).Build())
	candidates := []ProjectRef{
		{Namespace: "tenant-a", Name: "deleted-project"},
		{Namespace: "tenant-a", Name: "payments"},
	}

	got, err := authorizer.AuthorizedProjects(
		context.Background(), &Principal{Subject: "alice"},
		ActionRead, ResourceApplications, candidates,
	)
	require.NoError(t, err)
	assert.Equal(t, []ProjectRef{{Namespace: "tenant-a", Name: "payments"}}, got)
}

func TestAuthorizedProjectsProjectAuthorizerReflectsRevocationImmediately(t *testing.T) {
	t.Parallel()
	project := appProject("tenant-a", "payments", "alice")
	reader := fake.NewClientBuilder().WithObjects(project).Build()
	authorizer := NewProjectAuthorizer(reader)
	candidates := []ProjectRef{{Namespace: "tenant-a", Name: "payments"}}

	got, err := authorizer.AuthorizedProjects(
		context.Background(), &Principal{Subject: "alice"},
		ActionRead, ResourceApplications, candidates,
	)
	require.NoError(t, err)
	require.Equal(t, candidates, got)

	var stored corev1alpha1.AppProject
	require.NoError(t, reader.Get(context.Background(), client.ObjectKeyFromObject(project), &stored))
	stored.Spec.Roles = nil
	require.NoError(t, reader.Update(context.Background(), &stored))

	got, err = authorizer.AuthorizedProjects(
		context.Background(), &Principal{Subject: "alice"},
		ActionRead, ResourceApplications, candidates,
	)
	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestAuthorizedProjectsProjectAuthorizerShortCircuitsEmptyCandidates(t *testing.T) {
	t.Parallel()
	reader := &failingProjectReader{err: errors.New("must not read")}
	authorizer := NewProjectAuthorizer(reader)

	got, err := authorizer.AuthorizedProjects(
		context.Background(), &Principal{Subject: "alice"},
		ActionRead, ResourceApplications, nil,
	)
	require.NoError(t, err)
	assert.Empty(t, got)
	assert.Zero(t, reader.getCalls)
	assert.Zero(t, reader.listCalls)
}

func TestAuthorizedProjectsProjectAuthorizerPropagatesOperationalErrors(t *testing.T) {
	t.Parallel()
	operationalErr := errors.New("cache unavailable")
	reader := &failingProjectReader{err: operationalErr}
	authorizer := NewProjectAuthorizer(reader)

	got, err := authorizer.AuthorizedProjects(
		context.Background(), &Principal{Subject: "alice"},
		ActionRead, ResourceApplications,
		[]ProjectRef{{Namespace: "tenant-a", Name: "payments"}},
	)
	assert.Nil(t, got)
	assert.ErrorIs(t, err, operationalErr)
	assert.Equal(t, 1, reader.getCalls)
	assert.Zero(t, reader.listCalls, "candidate filtering must never list or invent projects")
}

func appProject(namespace, name, subject string) *corev1alpha1.AppProject {
	return &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
		Spec: corev1alpha1.AppProjectSpec{Roles: []corev1alpha1.AppProjectRole{{
			Subjects: []string{subject},
			Actions:  []string{"read"},
		}}},
	}
}

type failingProjectReader struct {
	err       error
	getCalls  int
	listCalls int
}

func (r *failingProjectReader) Get(
	_ context.Context,
	_ client.ObjectKey,
	_ client.Object,
	_ ...client.GetOption,
) error {
	r.getCalls++
	return r.err
}

func (r *failingProjectReader) List(
	_ context.Context,
	_ client.ObjectList,
	_ ...client.ListOption,
) error {
	r.listCalls++
	return r.err
}

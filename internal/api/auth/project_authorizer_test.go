package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/scheme"
	toolscache "k8s.io/client-go/tools/cache"
	crcache "sigs.k8s.io/controller-runtime/pkg/cache"
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

func TestAppProjectFromIndexer(t *testing.T) {
	t.Parallel()
	indexer := toolscache.NewIndexer(toolscache.MetaNamespaceKeyFunc, toolscache.Indexers{})
	project := appProject("tenant-a", "payments", "alice")
	require.NoError(t, indexer.Add(project))

	got, err := appProjectFromIndexer(indexer, "tenant-a", "payments")
	require.NoError(t, err)
	assert.Same(t, project, got, "indexer reads return the shared store object")

	_, err = appProjectFromIndexer(indexer, "tenant-a", "missing")
	assert.True(t, apierrors.IsNotFound(err), "missing key must map to NotFound, got %v", err)
}

// informerBackedReader pairs a client.Reader with an informer source, like
// crcache.Cache does in production.
type informerBackedReader struct {
	client.Reader
	informer crcache.Informer
}

func (r *informerBackedReader) GetInformer(
	context.Context, client.Object, ...crcache.InformerGetOption,
) (crcache.Informer, error) {
	return r.informer, nil
}

// stubInformer is a synced SharedIndexInformer over a hand-seeded indexer —
// enough for the authorizer's GetIndexer/HasSynced path without a running
// reflector.
type stubInformer struct {
	indexer toolscache.Indexer
}

func newStubInformer(t *testing.T, projects ...*corev1alpha1.AppProject) *stubInformer {
	t.Helper()
	indexer := toolscache.NewIndexer(toolscache.MetaNamespaceKeyFunc, toolscache.Indexers{})
	for _, p := range projects {
		require.NoError(t, indexer.Add(p))
	}
	return &stubInformer{indexer: indexer}
}

func (s *stubInformer) GetIndexer() toolscache.Indexer { return s.indexer }
func (s *stubInformer) HasSynced() bool                { return true }
func (s *stubInformer) IsStopped() bool                { return false }
func (s *stubInformer) GetStore() toolscache.Store     { return s.indexer }

func (s *stubInformer) AddEventHandler(toolscache.ResourceEventHandler) (toolscache.ResourceEventHandlerRegistration, error) {
	panic("unimplemented")
}
func (s *stubInformer) AddEventHandlerWithResyncPeriod(toolscache.ResourceEventHandler, time.Duration) (toolscache.ResourceEventHandlerRegistration, error) {
	panic("unimplemented")
}
func (s *stubInformer) AddEventHandlerWithOptions(toolscache.ResourceEventHandler, toolscache.HandlerOptions) (toolscache.ResourceEventHandlerRegistration, error) {
	panic("unimplemented")
}
func (s *stubInformer) RemoveEventHandler(toolscache.ResourceEventHandlerRegistration) error {
	panic("unimplemented")
}
func (s *stubInformer) AddIndexers(toolscache.Indexers) error    { panic("unimplemented") }
func (s *stubInformer) GetController() toolscache.Controller     { panic("unimplemented") }
func (s *stubInformer) Run(<-chan struct{})                      { panic("unimplemented") }
func (s *stubInformer) RunWithContext(context.Context)           { panic("unimplemented") }
func (s *stubInformer) HasSyncedChecker() toolscache.DoneChecker { panic("unimplemented") }
func (s *stubInformer) LastSyncResourceVersion() string          { panic("unimplemented") }
func (s *stubInformer) SetWatchErrorHandler(toolscache.WatchErrorHandler) error {
	panic("unimplemented")
}
func (s *stubInformer) SetWatchErrorHandlerWithContext(toolscache.WatchErrorHandlerWithContext) error {
	panic("unimplemented")
}
func (s *stubInformer) SetTransform(toolscache.TransformFunc) error { panic("unimplemented") }

var _ toolscache.SharedIndexInformer = (*stubInformer)(nil)

func TestProjectAuthorizerReadsFromInformerStore(t *testing.T) {
	t.Parallel()
	project := appProject("tenant-a", "payments", "alice")
	failing := &failingProjectReader{err: errors.New("must not read via client.Get")}
	reader := &informerBackedReader{
		Reader:   failing,
		informer: newStubInformer(t, project),
	}
	authorizer := NewProjectAuthorizer(reader)

	require.NoError(t, authorizer.Authorize(
		context.Background(), &Principal{Subject: "alice"},
		ActionRead, ResourceApplications, "tenant-a", "payments",
	))
	assert.Error(t, authorizer.Authorize(
		context.Background(), &Principal{Subject: "bob"},
		ActionRead, ResourceApplications, "tenant-a", "payments",
	))
	assert.Zero(t, failing.getCalls, "informer-backed reads must never hit client.Get")
	assert.Zero(t, failing.listCalls)
}

func BenchmarkProjectAuthorizerAuthorizedProjects(b *testing.B) {
	const projects = 20
	objects := make([]client.Object, 0, projects)
	informerObjs := make([]*corev1alpha1.AppProject, 0, projects)
	candidates := make([]ProjectRef, 0, projects)
	for i := 0; i < projects; i++ {
		ns := "tenant-" + string(rune('a'+i%26)) + string(rune('a'+i/26))
		p := appProject(ns, "payments", "alice")
		objects = append(objects, p)
		informerObjs = append(informerObjs, p)
		candidates = append(candidates, ProjectRef{Namespace: ns, Name: "payments"})
	}
	principal := &Principal{Subject: "alice"}

	b.Run("client get", func(b *testing.B) {
		authz := NewProjectAuthorizer(fake.NewClientBuilder().WithObjects(objects...).Build())
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			if _, err := authz.AuthorizedProjects(
				context.Background(), principal, ActionRead, ResourceApplications, candidates,
			); err != nil {
				b.Fatal(err)
			}
		}
	})

	b.Run("informer store", func(b *testing.B) {
		indexer := toolscache.NewIndexer(toolscache.MetaNamespaceKeyFunc, toolscache.Indexers{})
		for _, p := range informerObjs {
			require.NoError(b, indexer.Add(p))
		}
		authz := NewProjectAuthorizer(&informerBackedReader{
			Reader:   fake.NewClientBuilder().Build(),
			informer: &stubInformer{indexer: indexer},
		})
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			if _, err := authz.AuthorizedProjects(
				context.Background(), principal, ActionRead, ResourceApplications, candidates,
			); err != nil {
				b.Fatal(err)
			}
		}
	})
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

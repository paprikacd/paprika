package apiserver

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlfake "sigs.k8s.io/controller-runtime/pkg/client/fake"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

func newArtifactTestScheme() *runtime.Scheme {
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	_ = pipelinesv1alpha1.AddToScheme(scheme)
	return scheme
}

func newArtifactTestClient(objs ...client.Object) client.Client {
	return ctrlfake.NewClientBuilder().
		WithScheme(newArtifactTestScheme()).
		WithObjects(objs...).
		WithStatusSubresource(&pipelinesv1alpha1.Artifact{}).
		Build()
}

func pipelineOwnerRef(name string) []metav1.OwnerReference {
	controller := true
	return []metav1.OwnerReference{{
		APIVersion: "pipelines.paprika.io/v1alpha1",
		Kind:       "Pipeline",
		Name:       name,
		UID:        types.UID("owner-uid"),
		Controller: &controller,
	}}
}

func TestListArtifacts_ListsArtifactsInNamespace(t *testing.T) {
	cl := newArtifactTestClient(
		artifact("a1", "default", map[string]string{projectLabelKey: "default"}, nil),
		artifact("a2", "default", map[string]string{projectLabelKey: "default"}, nil),
		artifact("a3", "other", map[string]string{projectLabelKey: "default"}, nil),
	)
	srv := NewPaprikaServer(cl, nil)

	resp, err := srv.ListArtifacts(context.Background(), connect.NewRequest(&paprikav1.ListArtifactsRequest{
		Namespace: "default",
	}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.Artifacts, 2)
}

func TestListArtifacts_FiltersByPipelineOwnerRef(t *testing.T) {
	cl := newArtifactTestClient(
		artifactWithOwner("a1", "default", map[string]string{projectLabelKey: "default"}, "pipe1"),
		artifactWithOwner("a2", "default", map[string]string{projectLabelKey: "default"}, "pipe2"),
	)
	srv := NewPaprikaServer(cl, nil)

	resp, err := srv.ListArtifacts(context.Background(), connect.NewRequest(&paprikav1.ListArtifactsRequest{
		Namespace:    "default",
		PipelineName: ptr("pipe1"),
	}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.Artifacts, 1)
	require.Equal(t, "a1", resp.Msg.Artifacts[0].Name)
}

func TestListArtifacts_SkipsArtifactsWithoutProjectLabel(t *testing.T) {
	cl := newArtifactTestClient(
		artifact("a1", "default", map[string]string{projectLabelKey: "default"}, nil),
		artifact("a2", "default", nil, nil),
	)
	srv := NewPaprikaServer(cl, nil)

	resp, err := srv.ListArtifacts(context.Background(), connect.NewRequest(&paprikav1.ListArtifactsRequest{
		Namespace: "default",
	}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.Artifacts, 1)
	require.Equal(t, "a1", resp.Msg.Artifacts[0].Name)
}

func TestListArtifacts_AuthorizesByProjectLabel(t *testing.T) {
	cl := newArtifactTestClient(
		artifact("a1", "default", map[string]string{projectLabelKey: "allowed"}, nil),
		artifact("a2", "default", map[string]string{projectLabelKey: "denied"}, nil),
	)
	authorizer := auth.NewRBACAuthorizer([]auth.RBACRule{{
		Subjects:   []string{"alice"},
		Actions:    []string{"read"},
		Resources:  []string{"artifacts"},
		Namespaces: []string{"*"},
		Projects:   []string{"allowed"},
	}})
	srv := NewPaprikaServer(cl, nil, WithAuthorizer(authorizer))

	ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "alice"})
	resp, err := srv.ListArtifacts(ctx, connect.NewRequest(&paprikav1.ListArtifactsRequest{
		Namespace: "default",
	}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.Artifacts, 1)
	require.Equal(t, "a1", resp.Msg.Artifacts[0].Name)
}

func TestListArtifacts_FiltersAllWhenNoPrincipal(t *testing.T) {
	cl := newArtifactTestClient(
		artifact("a1", "default", map[string]string{projectLabelKey: "default"}, nil),
	)
	authorizer := auth.NewRBACAuthorizer([]auth.RBACRule{{
		Subjects:   []string{"alice"},
		Actions:    []string{"read"},
		Resources:  []string{"artifacts"},
		Namespaces: []string{"*"},
		Projects:   []string{"*"},
	}})
	srv := NewPaprikaServer(cl, nil, WithAuthorizer(authorizer))

	// No principal in context: every artifact is filtered out, matching the
	// ListPipelines behaviour of silently skipping unauthorized items.
	resp, err := srv.ListArtifacts(context.Background(), connect.NewRequest(&paprikav1.ListArtifactsRequest{
		Namespace: "default",
	}))
	require.NoError(t, err)
	require.Empty(t, resp.Msg.Artifacts)
}

func TestGetArtifact_MapsOCIFields(t *testing.T) {
	cl := newArtifactTestClient(
		&pipelinesv1alpha1.Artifact{
			ObjectMeta: metav1.ObjectMeta{
				Name: "a1", Namespace: "default",
				Labels: map[string]string{projectLabelKey: "default"},
			},
			Spec: pipelinesv1alpha1.ArtifactSpec{
				Type:      "oci",
				Reference: "registry.io/repo:tag",
				Digest:    "sha256:specdigest",
				Provenance: pipelinesv1alpha1.ArtifactProvenance{
					Pipeline: "pipe1",
					Step:     "build",
				},
			},
			Status: pipelinesv1alpha1.ArtifactStatus{
				Verified:       true,
				ResolvedDigest: "sha256:resolveddigest",
				Conditions: []metav1.Condition{{
					Type: conditionTypeReady, Status: metav1.ConditionTrue, Reason: "Verified",
				}},
			},
		},
	)
	srv := NewPaprikaServer(cl, nil)

	resp, err := srv.GetArtifact(context.Background(), connect.NewRequest(&paprikav1.GetArtifactRequest{
		Namespace: "default", Name: "a1",
	}))
	require.NoError(t, err)
	require.NotNil(t, resp.Msg.Artifact)
	a := resp.Msg.Artifact
	require.Equal(t, "a1", a.Name)
	require.Equal(t, "oci", a.Kind)
	require.Equal(t, "registry.io/repo:tag", a.Reference)
	require.Equal(t, "oci://registry.io/repo:tag", a.Path)
	require.Equal(t, "Ready", a.Phase)
	require.Equal(t, "oci://registry.io/repo:tag@sha256:resolveddigest", a.ResolvedReference)
	require.Equal(t, "sha256:resolveddigest", a.Digest)
	require.Equal(t, "build", a.ProducingStep)
	require.Empty(t, resp.Msg.DownloadUrl, "oci artifacts have no download url")
}

func TestGetArtifact_FailedArtifactIncludesReason(t *testing.T) {
	cl := newArtifactTestClient(
		&pipelinesv1alpha1.Artifact{
			ObjectMeta: metav1.ObjectMeta{
				Name: "a1", Namespace: "default",
				Labels: map[string]string{projectLabelKey: "default"},
			},
			Spec: pipelinesv1alpha1.ArtifactSpec{
				Type:      "oci",
				Reference: "registry.io/repo:tag",
			},
			Status: pipelinesv1alpha1.ArtifactStatus{
				Conditions: []metav1.Condition{{
					Type: conditionTypeReady, Status: metav1.ConditionFalse, Reason: "VerificationFailed",
				}},
			},
		},
	)
	srv := NewPaprikaServer(cl, nil)

	resp, err := srv.GetArtifact(context.Background(), connect.NewRequest(&paprikav1.GetArtifactRequest{
		Namespace: "default", Name: "a1",
	}))
	require.NoError(t, err)
	require.Equal(t, "Failed", resp.Msg.Artifact.Phase)
	require.Equal(t, "VerificationFailed", resp.Msg.Artifact.FailedReason)
}

func TestGetArtifact_ConfigMap_BuildsDownloadURL(t *testing.T) {
	cl := newArtifactTestClient(
		&pipelinesv1alpha1.Artifact{
			ObjectMeta: metav1.ObjectMeta{
				Name: "a1", Namespace: "default",
				Labels: map[string]string{projectLabelKey: "default"},
			},
			Spec: pipelinesv1alpha1.ArtifactSpec{
				Type:      "configmap",
				Reference: "my-cm/my-key",
			},
			Status: pipelinesv1alpha1.ArtifactStatus{
				Conditions: []metav1.Condition{{
					Type: conditionTypeReady, Status: metav1.ConditionTrue, Reason: "Verified",
				}},
			},
		},
		&corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: "my-cm", Namespace: "default"},
			Data:       map[string]string{"my-key": "value"},
		},
	)
	srv := NewPaprikaServer(cl, nil)

	resp, err := srv.GetArtifact(context.Background(), connect.NewRequest(&paprikav1.GetArtifactRequest{
		Namespace: "default", Name: "a1",
	}))
	require.NoError(t, err)
	require.Equal(t, "configmap", resp.Msg.Artifact.Kind)
	require.Equal(t, "configmap://default/my-cm/my-key", resp.Msg.Artifact.ResolvedReference)
	require.NotEmpty(t, resp.Msg.DownloadUrl)
	require.True(t, strings.HasPrefix(resp.Msg.DownloadUrl, "data:application/json;base64,"))
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(resp.Msg.DownloadUrl, "data:application/json;base64,"))
	require.NoError(t, err)
	require.JSONEq(t, `{"my-key":"value"}`, string(decoded))
}

func TestGetArtifact_ConfigMap_OverLimitOmitsDownloadURL(t *testing.T) {
	cl := newArtifactTestClient(
		&pipelinesv1alpha1.Artifact{
			ObjectMeta: metav1.ObjectMeta{
				Name: "a1", Namespace: "default",
				Labels: map[string]string{projectLabelKey: "default"},
			},
			Spec: pipelinesv1alpha1.ArtifactSpec{
				Type:      "configmap",
				Reference: "big-cm/the-key",
			},
			Status: pipelinesv1alpha1.ArtifactStatus{
				Conditions: []metav1.Condition{{
					Type: conditionTypeReady, Status: metav1.ConditionTrue, Reason: "Verified",
				}},
			},
		},
		&corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: "big-cm", Namespace: "default"},
			Data:       map[string]string{"the-key": strings.Repeat("x", configMapDownloadLimit+1)},
		},
	)
	srv := NewPaprikaServer(cl, nil)

	resp, err := srv.GetArtifact(context.Background(), connect.NewRequest(&paprikav1.GetArtifactRequest{
		Namespace: "default", Name: "a1",
	}))
	require.NoError(t, err)
	require.Empty(t, resp.Msg.DownloadUrl, "oversized values must not get a download url")
}

func TestGetArtifact_NotFound(t *testing.T) {
	cl := newArtifactTestClient()
	srv := NewPaprikaServer(cl, nil)

	_, err := srv.GetArtifact(context.Background(), connect.NewRequest(&paprikav1.GetArtifactRequest{
		Namespace: "default", Name: "missing",
	}))
	require.Error(t, err)
	var connErr *connect.Error
	require.True(t, errors.As(err, &connErr))
	require.Equal(t, connect.CodeNotFound, connErr.Code())
}

func TestGetArtifact_PermissionDeniedWithoutProjectLabel(t *testing.T) {
	cl := newArtifactTestClient(
		artifact("a1", "default", nil, nil),
	)
	srv := NewPaprikaServer(cl, nil)

	_, err := srv.GetArtifact(context.Background(), connect.NewRequest(&paprikav1.GetArtifactRequest{
		Namespace: "default", Name: "a1",
	}))
	require.Error(t, err)
	var connErr *connect.Error
	require.True(t, errors.As(err, &connErr))
	require.Equal(t, connect.CodePermissionDenied, connErr.Code())
}

func TestGetArtifact_PermissionDeniedByAuthorizer(t *testing.T) {
	cl := newArtifactTestClient(
		artifact("a1", "default", map[string]string{projectLabelKey: "denied"}, nil),
	)
	authorizer := auth.NewRBACAuthorizer([]auth.RBACRule{{
		Subjects:   []string{"alice"},
		Actions:    []string{"read"},
		Resources:  []string{"artifacts"},
		Namespaces: []string{"*"},
		Projects:   []string{"allowed"},
	}})
	srv := NewPaprikaServer(cl, nil, WithAuthorizer(authorizer))

	ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "alice"})
	_, err := srv.GetArtifact(ctx, connect.NewRequest(&paprikav1.GetArtifactRequest{
		Namespace: "default", Name: "a1",
	}))
	require.Error(t, err)
	var connErr *connect.Error
	require.True(t, errors.As(err, &connErr))
	require.Equal(t, connect.CodePermissionDenied, connErr.Code())
}

// artifact builds a minimal ready OCI artifact for list/filter tests.
func artifact(name, namespace string, labels map[string]string, _ map[string]string) *pipelinesv1alpha1.Artifact {
	return artifactWithSpec(name, namespace, labels, pipelinesv1alpha1.ArtifactSpec{
		Type: "oci", Reference: "registry.io/repo:tag",
	})
}

func artifactWithOwner(name, namespace string, labels map[string]string, pipelineName string) *pipelinesv1alpha1.Artifact {
	a := artifactWithSpec(name, namespace, labels, pipelinesv1alpha1.ArtifactSpec{
		Type: "oci", Reference: "registry.io/repo:tag",
	})
	a.OwnerReferences = pipelineOwnerRef(pipelineName)
	return a
}

func artifactWithSpec(name, namespace string, labels map[string]string, spec pipelinesv1alpha1.ArtifactSpec) *pipelinesv1alpha1.Artifact {
	return &pipelinesv1alpha1.Artifact{
		ObjectMeta: metav1.ObjectMeta{
			Name: name, Namespace: namespace, Labels: labels,
		},
		Spec: spec,
		Status: pipelinesv1alpha1.ArtifactStatus{
			Conditions: []metav1.Condition{{
				Type: conditionTypeReady, Status: metav1.ConditionTrue, Reason: "Verified",
			}},
		},
	}
}

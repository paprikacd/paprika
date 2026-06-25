package pipelines

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/go-logr/logr"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/events"
	"github.com/benebsworth/paprika/internal/clock"
	"github.com/benebsworth/paprika/internal/controller/pipelines/progress"
)

type mockPipelineRunner struct {
	statuses []pipelinesv1alpha1.StepStatus
	err      error
}

func (m *mockPipelineRunner) RunPipeline(_ context.Context, _ *pipelinesv1alpha1.Pipeline, _ progress.StepProgressCallback) ([]pipelinesv1alpha1.StepStatus, error) {
	return m.statuses, m.err
}

func TestCreateArtifact_SetsLabelsAndOwnerRef(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))

	pipeline := &pipelinesv1alpha1.Pipeline{
		ObjectMeta: metav1.ObjectMeta{
			Name:       "my-pipeline",
			Namespace:  "default",
			UID:        "uid-1",
			Finalizers: []string{pipelineFinalizer},
		},
		Spec: pipelinesv1alpha1.PipelineSpec{
			Steps: []pipelinesv1alpha1.PipelineStep{
				{
					Name: "build",
					Outputs: []pipelinesv1alpha1.PipelineOutput{
						{Name: "image", Path: "oci://repo:tag"},
					},
				},
			},
		},
		Status: pipelinesv1alpha1.PipelineStatus{
			Phase:           pipelinesv1alpha1.PipelineRunning,
			LastExecutionID: "run-1",
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pipeline).WithStatusSubresource(&pipelinesv1alpha1.Pipeline{}).Build()
	r := &PipelineReconciler{
		client:         c,
		Scheme:         scheme,
		WorkflowEngine: &mockPipelineRunner{statuses: []pipelinesv1alpha1.StepStatus{{Name: "build", Phase: pipelinesv1alpha1.StepSucceeded}}},
	}

	_, err := r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Name: "my-pipeline", Namespace: "default"}})
	require.NoError(t, err)

	var artifacts pipelinesv1alpha1.ArtifactList
	require.NoError(t, c.List(context.Background(), &artifacts))
	require.Len(t, artifacts.Items, 1)

	a := artifacts.Items[0]
	assert.Equal(t, "my-pipeline-build-image", a.Name)
	assert.Equal(t, "my-pipeline", a.Labels[PipelineLabelKey])
	assert.Equal(t, "build", a.Labels[StepLabelKey])
	assert.Equal(t, "image", a.Labels[OutputLabelKey])
	assert.Equal(t, "oci", a.Spec.Type)
	assert.Equal(t, "repo:tag", a.Spec.Reference)
	assert.Equal(t, "my-pipeline", a.Spec.Provenance.Pipeline)
	assert.Equal(t, "run-1", a.Spec.Provenance.Build)
	assert.Equal(t, "build", a.Spec.Provenance.Step)
	require.Len(t, a.OwnerReferences, 1)
	assert.Equal(t, "uid-1", string(a.OwnerReferences[0].UID))
	assert.True(t, *a.OwnerReferences[0].Controller)
}

func TestCreateArtifact_ConfigMapReference(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))

	pipeline := &pipelinesv1alpha1.Pipeline{
		ObjectMeta: metav1.ObjectMeta{
			Name:       "my-pipeline",
			Namespace:  "default",
			UID:        "uid-1",
			Finalizers: []string{pipelineFinalizer},
		},
		Spec: pipelinesv1alpha1.PipelineSpec{
			Steps: []pipelinesv1alpha1.PipelineStep{
				{
					Name: "build",
					Outputs: []pipelinesv1alpha1.PipelineOutput{
						{Name: "config", Path: "configmap://my-cm/my-key"},
					},
				},
			},
		},
		Status: pipelinesv1alpha1.PipelineStatus{
			Phase:           pipelinesv1alpha1.PipelineRunning,
			LastExecutionID: "run-1",
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pipeline).WithStatusSubresource(&pipelinesv1alpha1.Pipeline{}).Build()
	r := &PipelineReconciler{
		client:         c,
		Scheme:         scheme,
		WorkflowEngine: &mockPipelineRunner{statuses: []pipelinesv1alpha1.StepStatus{{Name: "build", Phase: pipelinesv1alpha1.StepSucceeded}}},
	}

	_, err := r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Name: "my-pipeline", Namespace: "default"}})
	require.NoError(t, err)

	var artifacts pipelinesv1alpha1.ArtifactList
	require.NoError(t, c.List(context.Background(), &artifacts))
	require.Len(t, artifacts.Items, 1)

	a := artifacts.Items[0]
	assert.Equal(t, "configmap", a.Spec.Type)
	assert.Equal(t, "my-cm/my-key", a.Spec.Reference)
}

func TestCreateArtifact_DeterministicNamesWithCollisionSuffix(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))

	pipeline := &pipelinesv1alpha1.Pipeline{
		ObjectMeta: metav1.ObjectMeta{
			Name:       "my-pipeline",
			Namespace:  "default",
			UID:        "uid-1",
			Finalizers: []string{pipelineFinalizer},
		},
		Spec: pipelinesv1alpha1.PipelineSpec{
			Steps: []pipelinesv1alpha1.PipelineStep{
				{
					Name: "build",
					Outputs: []pipelinesv1alpha1.PipelineOutput{
						{Name: "my-image", Path: "oci://repo:tag1"},
						{Name: "my_image", Path: "oci://repo:tag2"},
					},
				},
			},
		},
		Status: pipelinesv1alpha1.PipelineStatus{
			Phase:           pipelinesv1alpha1.PipelineRunning,
			LastExecutionID: "run-1",
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pipeline).WithStatusSubresource(&pipelinesv1alpha1.Pipeline{}).Build()
	r := &PipelineReconciler{
		client:         c,
		Scheme:         scheme,
		WorkflowEngine: &mockPipelineRunner{statuses: []pipelinesv1alpha1.StepStatus{{Name: "build", Phase: pipelinesv1alpha1.StepSucceeded}}},
	}

	_, err := r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Name: "my-pipeline", Namespace: "default"}})
	require.NoError(t, err)

	var artifacts pipelinesv1alpha1.ArtifactList
	require.NoError(t, c.List(context.Background(), &artifacts))
	require.Len(t, artifacts.Items, 2)

	names := make([]string, 2)
	for i, a := range artifacts.Items {
		names[i] = a.Name
	}
	assert.NotEqual(t, names[0], names[1], "expected disambiguated artifact names")
	for _, name := range names {
		assert.True(t, len(name) <= 63, "artifact name %q exceeds 63 chars", name)
	}
}

func TestReconcilePipeline_UpsertsArtifactRefs(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))

	pipeline := &pipelinesv1alpha1.Pipeline{
		ObjectMeta: metav1.ObjectMeta{
			Name:       "my-pipeline",
			Namespace:  "default",
			UID:        "uid-1",
			Finalizers: []string{pipelineFinalizer},
		},
		Spec: pipelinesv1alpha1.PipelineSpec{
			Steps: []pipelinesv1alpha1.PipelineStep{
				{
					Name: "build",
					Outputs: []pipelinesv1alpha1.PipelineOutput{
						{Name: "image", Path: "oci://repo:tag"},
					},
				},
			},
		},
		Status: pipelinesv1alpha1.PipelineStatus{
			Phase:           pipelinesv1alpha1.PipelineRunning,
			LastExecutionID: "run-1",
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pipeline).WithStatusSubresource(&pipelinesv1alpha1.Pipeline{}).Build()
	r := &PipelineReconciler{
		client:         c,
		Scheme:         scheme,
		WorkflowEngine: &mockPipelineRunner{statuses: []pipelinesv1alpha1.StepStatus{{Name: "build", Phase: pipelinesv1alpha1.StepSucceeded}}},
	}

	_, err := r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Name: "my-pipeline", Namespace: "default"}})
	require.NoError(t, err)

	var got pipelinesv1alpha1.Pipeline
	require.NoError(t, c.Get(context.Background(), types.NamespacedName{Name: "my-pipeline", Namespace: "default"}, &got))
	require.Len(t, got.Status.ArtifactRefs, 1)

	ref := got.Status.ArtifactRefs[0]
	assert.Equal(t, "my-pipeline-build-image", ref.Name)
	assert.Equal(t, "oci", ref.Kind)
	assert.Equal(t, "oci://repo:tag", ref.Reference)
	assert.Equal(t, pipelinesv1alpha1.PipelineArtifactPhasePending, ref.Phase)
	assert.Equal(t, "build", ref.ProducingStep)
	assert.NotZero(t, ref.CreatedAt)
}

func TestReconcilePipeline_SyncsArtifactStatus(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))

	pipeline := &pipelinesv1alpha1.Pipeline{
		ObjectMeta: metav1.ObjectMeta{
			Name:       "my-pipeline",
			Namespace:  "default",
			UID:        "uid-1",
			Finalizers: []string{pipelineFinalizer},
		},
		Spec: pipelinesv1alpha1.PipelineSpec{
			Steps: []pipelinesv1alpha1.PipelineStep{
				{
					Name: "build",
					Outputs: []pipelinesv1alpha1.PipelineOutput{
						{Name: "image", Path: "oci://repo:tag"},
					},
				},
			},
		},
		Status: pipelinesv1alpha1.PipelineStatus{
			Phase:           pipelinesv1alpha1.PipelineSucceeded,
			LastExecutionID: "run-1",
			ArtifactRefs: []pipelinesv1alpha1.PipelineArtifactRef{
				{Name: "my-pipeline-build-image", Kind: "oci", Phase: pipelinesv1alpha1.PipelineArtifactPhasePending, ProducingStep: "build"},
			},
		},
	}
	artifact := &pipelinesv1alpha1.Artifact{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "my-pipeline-build-image",
			Namespace: "default",
			OwnerReferences: []metav1.OwnerReference{
				{APIVersion: "pipelines.paprika.io/v1alpha1", Kind: "Pipeline", Name: "my-pipeline", UID: "uid-1", Controller: boolPtr(true)},
			},
		},
		Spec: pipelinesv1alpha1.ArtifactSpec{Type: "oci", Reference: "repo:tag"},
		Status: pipelinesv1alpha1.ArtifactStatus{
			Verified:       true,
			ResolvedDigest: "sha256:abc",
			Conditions: []metav1.Condition{
				{Type: "Ready", Status: metav1.ConditionTrue, Reason: "Verified"},
			},
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pipeline, artifact).WithStatusSubresource(&pipelinesv1alpha1.Pipeline{}, &pipelinesv1alpha1.Artifact{}).Build()
	r := &PipelineReconciler{
		client: c,
		Scheme: scheme,
		WorkflowEngine: &mockPipelineRunner{
			statuses: []pipelinesv1alpha1.StepStatus{{Name: "build", Phase: pipelinesv1alpha1.StepSucceeded}},
		},
	}

	_, err := r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Name: "my-pipeline", Namespace: "default"}})
	require.NoError(t, err)

	var got pipelinesv1alpha1.Pipeline
	require.NoError(t, c.Get(context.Background(), types.NamespacedName{Name: "my-pipeline", Namespace: "default"}, &got))
	require.Len(t, got.Status.ArtifactRefs, 1)

	ref := got.Status.ArtifactRefs[0]
	assert.Equal(t, pipelinesv1alpha1.PipelineArtifactPhaseReady, ref.Phase)
	assert.Equal(t, "sha256:abc", ref.Digest)
	assert.Equal(t, "repo:tag@sha256:abc", ref.ResolvedReference)
}

func TestReconcilePipeline_DeletesStaleArtifacts(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))

	pipeline := &pipelinesv1alpha1.Pipeline{
		ObjectMeta: metav1.ObjectMeta{
			Name:       "my-pipeline",
			Namespace:  "default",
			UID:        "uid-1",
			Finalizers: []string{pipelineFinalizer},
		},
		Spec: pipelinesv1alpha1.PipelineSpec{
			Steps: []pipelinesv1alpha1.PipelineStep{
				{
					Name: "build",
					Outputs: []pipelinesv1alpha1.PipelineOutput{
						{Name: "image", Path: "oci://repo:tag"},
					},
				},
			},
		},
		Status: pipelinesv1alpha1.PipelineStatus{
			Phase:           pipelinesv1alpha1.PipelineSucceeded,
			LastExecutionID: "run-1",
			ArtifactRefs: []pipelinesv1alpha1.PipelineArtifactRef{
				{Name: "my-pipeline-build-image", Kind: "oci", Phase: pipelinesv1alpha1.PipelineArtifactPhaseReady, ProducingStep: "build"},
				{Name: "my-pipeline-build-stale", Kind: "oci", Phase: pipelinesv1alpha1.PipelineArtifactPhasePending, ProducingStep: "build"},
			},
		},
	}
	stale := &pipelinesv1alpha1.Artifact{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "my-pipeline-build-stale",
			Namespace: "default",
			Labels: map[string]string{
				PipelineLabelKey: "my-pipeline",
				StepLabelKey:     "build",
				OutputLabelKey:   "stale",
			},
			OwnerReferences: []metav1.OwnerReference{
				{APIVersion: "pipelines.paprika.io/v1alpha1", Kind: "Pipeline", Name: "my-pipeline", UID: "uid-1", Controller: boolPtr(true)},
			},
		},
		Spec: pipelinesv1alpha1.ArtifactSpec{Type: "oci", Reference: "repo:stale"},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pipeline, stale).WithStatusSubresource(&pipelinesv1alpha1.Pipeline{}).Build()
	r := &PipelineReconciler{
		client: c,
		Scheme: scheme,
		WorkflowEngine: &mockPipelineRunner{
			statuses: []pipelinesv1alpha1.StepStatus{{Name: "build", Phase: pipelinesv1alpha1.StepSucceeded}},
		},
	}

	_, err := r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Name: "my-pipeline", Namespace: "default"}})
	require.NoError(t, err)

	var artifacts pipelinesv1alpha1.ArtifactList
	require.NoError(t, c.List(context.Background(), &artifacts))
	require.Len(t, artifacts.Items, 1)
	assert.Equal(t, "my-pipeline-build-image", artifacts.Items[0].Name)

	var got pipelinesv1alpha1.Pipeline
	require.NoError(t, c.Get(context.Background(), types.NamespacedName{Name: "my-pipeline", Namespace: "default"}, &got))
	require.Len(t, got.Status.ArtifactRefs, 1)
	assert.Equal(t, "my-pipeline-build-image", got.Status.ArtifactRefs[0].Name)
}

func TestReconcilePipeline_PublishesArtifactSSE(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))

	pipeline := &pipelinesv1alpha1.Pipeline{
		ObjectMeta: metav1.ObjectMeta{
			Name:       "my-pipeline",
			Namespace:  "default",
			UID:        "uid-1",
			Finalizers: []string{pipelineFinalizer},
		},
		Spec: pipelinesv1alpha1.PipelineSpec{
			Steps: []pipelinesv1alpha1.PipelineStep{
				{
					Name: "build",
					Outputs: []pipelinesv1alpha1.PipelineOutput{
						{Name: "image", Path: "oci://repo:tag"},
					},
				},
			},
		},
		Status: pipelinesv1alpha1.PipelineStatus{
			Phase:           pipelinesv1alpha1.PipelineSucceeded,
			LastExecutionID: "run-1",
			ArtifactRefs: []pipelinesv1alpha1.PipelineArtifactRef{
				{Name: "my-pipeline-build-image", Kind: "oci", Phase: pipelinesv1alpha1.PipelineArtifactPhasePending, ProducingStep: "build"},
			},
		},
	}
	artifact := &pipelinesv1alpha1.Artifact{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "my-pipeline-build-image",
			Namespace: "default",
			OwnerReferences: []metav1.OwnerReference{
				{APIVersion: "pipelines.paprika.io/v1alpha1", Kind: "Pipeline", Name: "my-pipeline", UID: "uid-1", Controller: boolPtr(true)},
			},
		},
		Spec: pipelinesv1alpha1.ArtifactSpec{Type: "oci", Reference: "repo:tag", Provenance: pipelinesv1alpha1.ArtifactProvenance{Step: "build"}},
		Status: pipelinesv1alpha1.ArtifactStatus{
			Verified:       true,
			ResolvedDigest: "sha256:abc",
			Conditions: []metav1.Condition{
				{Type: "Ready", Status: metav1.ConditionTrue, Reason: "Verified"},
			},
		},
	}
	broker := events.NewBroker(logr.Discard())
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pipeline, artifact).WithStatusSubresource(&pipelinesv1alpha1.Pipeline{}, &pipelinesv1alpha1.Artifact{}).Build()
	r := &PipelineReconciler{
		client:         c,
		Scheme:         scheme,
		Clock:          clock.Real{},
		EventBroker:    broker,
		WorkflowEngine: &mockPipelineRunner{statuses: []pipelinesv1alpha1.StepStatus{{Name: "build", Phase: pipelinesv1alpha1.StepSucceeded}}},
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dashboardCh := broker.Subscribe(ctx, events.TopicDashboard)
	pipelineTopic := "pipeline/default/my-pipeline"
	pipelineCh := broker.Subscribe(ctx, pipelineTopic)

	_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "my-pipeline", Namespace: "default"}})
	require.NoError(t, err)

	for _, ch := range []struct {
		name string
		c    <-chan *events.Event
	}{
		{"dashboard", dashboardCh},
		{"pipeline", pipelineCh},
	} {
		select {
		case evt := <-ch.c:
			require.Equal(t, events.TypePipelineArtifact, evt.Type, ch.name)
			var payload PipelineArtifactEventPayload
			require.NoError(t, json.Unmarshal(evt.Payload, &payload), ch.name)
			assert.Equal(t, events.TypePipelineArtifact, payload.ResourceType, ch.name)
			assert.Equal(t, "my-pipeline", payload.Pipeline, ch.name)
			assert.Equal(t, "default", payload.Namespace, ch.name)
			assert.Equal(t, "my-pipeline-build-image", payload.Name, ch.name)
			assert.Equal(t, "oci", payload.Kind, ch.name)
			assert.Equal(t, "Ready", payload.Phase, ch.name)
			assert.Equal(t, "Pending", payload.PreviousPhase, ch.name)
			assert.Equal(t, "oci://repo:tag", payload.Reference, ch.name)
			assert.Equal(t, "sha256:abc", payload.Digest, ch.name)
			assert.Equal(t, "build", payload.ProducingStep, ch.name)
		case <-time.After(2 * time.Second):
			t.Fatalf("expected pipeline-artifact SSE event on %s topic", ch.name)
		}
	}
}

func boolPtr(b bool) *bool {
	return &b
}

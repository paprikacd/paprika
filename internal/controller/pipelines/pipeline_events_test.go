package pipelines

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/go-logr/logr"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/events"
	"github.com/benebsworth/paprika/internal/clock"
)

func TestPublishPipelineEvents(t *testing.T) {
	broker := events.NewBroker(logr.Discard())
	r := &PipelineReconciler{
		EventBroker: broker,
		Clock:       clock.Real{},
	}
	pipeline := &pipelinesv1alpha1.Pipeline{
		ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "ns"},
		Status: pipelinesv1alpha1.PipelineStatus{
			Phase: pipelinesv1alpha1.PipelineRunning,
			StepStatuses: []pipelinesv1alpha1.StepStatus{
				{Name: "build", Phase: pipelinesv1alpha1.StepSucceeded},
				{Name: "test", Phase: pipelinesv1alpha1.StepRunning},
			},
		},
	}

	ctx := context.Background()
	ch := broker.Subscribe(ctx, "pipeline/ns/p")

	r.publishPipelineEvents(ctx, pipeline)

	received := make(map[string]bool)
	done := time.After(2 * time.Second)
forLoop:
	for {
		select {
		case evt := <-ch:
			require.Equal(t, events.TypePipeline, evt.Type)
			received[string(evt.Payload)] = true
		case <-done:
			break forLoop
		}
	}

	require.Len(t, received, 3, "expected pipeline + 2 step events")
}

func TestPublishPipelineEvent_IncludesTimestamps(t *testing.T) {
	broker := events.NewBroker(logr.Discard())
	r := &PipelineReconciler{EventBroker: broker, Clock: clock.Real{}}
	pipeline := &pipelinesv1alpha1.Pipeline{
		ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "ns"},
		Status: pipelinesv1alpha1.PipelineStatus{
			Phase: pipelinesv1alpha1.PipelineRunning,
			StepStatuses: []pipelinesv1alpha1.StepStatus{
				{
					Name:        "build",
					Phase:       pipelinesv1alpha1.StepSucceeded,
					StartedAt:   &metav1.Time{Time: time.Unix(1000, 0)},
					CompletedAt: &metav1.Time{Time: time.Unix(1010, 0)},
				},
			},
		},
	}

	ctx := context.Background()
	ch := broker.Subscribe(ctx, "pipeline/ns/p")
	r.publishPipelineEvent(ctx, pipeline, "build")

	select {
	case evt := <-ch:
		require.Equal(t, events.TypePipeline, evt.Type)
		var payload events.EventPayload
		require.NoError(t, json.Unmarshal(evt.Payload, &payload))
		require.Equal(t, "build", payload.Name)
		require.Equal(t, "Succeeded", payload.Phase)
		require.NotNil(t, payload.StartedAt)
		require.Equal(t, int64(1000), *payload.StartedAt)
		require.NotNil(t, payload.CompletedAt)
		require.Equal(t, int64(1010), *payload.CompletedAt)
	case <-time.After(2 * time.Second):
		t.Fatal("expected pipeline event")
	}
}

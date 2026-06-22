package pipelines

import (
	"context"
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

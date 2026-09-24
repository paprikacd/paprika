package health

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func TestResourceHealthChecker_CheckCronJob(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	require.NoError(t, batchv1.AddToScheme(scheme))

	suspended := true
	checker := NewResourceHealthChecker(fake.NewClientBuilder().WithScheme(scheme).WithObjects(&batchv1.CronJob{
		ObjectMeta: metav1.ObjectMeta{Name: "search-index-sync", Namespace: "default"},
		Spec:       batchv1.CronJobSpec{Schedule: "0 3 * * *", Suspend: &suspended},
	}).Build())

	health := checker.Check(context.Background(), "CronJob", "search-index-sync", "default")
	assert.Equal(t, "Healthy", string(health.Health))
	assert.Equal(t, "cronjob suspended", health.Message)
}

func TestResourceHealthChecker_CheckActiveCronJob(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	require.NoError(t, batchv1.AddToScheme(scheme))

	checker := NewResourceHealthChecker(fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&batchv1.CronJob{}).WithObjects(&batchv1.CronJob{
		ObjectMeta: metav1.ObjectMeta{Name: "search-index-sync", Namespace: "default"},
		Spec:       batchv1.CronJobSpec{Schedule: "0 3 * * *"},
		Status: batchv1.CronJobStatus{Active: []corev1.ObjectReference{{
			Kind:      "Job",
			Name:      "search-index-sync-123",
			Namespace: "default",
			UID:       types.UID("job-uid"),
		}}},
	}).Build())

	health := checker.Check(context.Background(), "CronJob", "search-index-sync", "default")
	assert.Equal(t, "Progressing", string(health.Health))
	assert.Equal(t, "1 active jobs", health.Message)
}

func assessable(kind, name string, fields map[string]interface{}) *unstructured.Unstructured {
	obj := &unstructured.Unstructured{Object: map[string]interface{}{}}
	obj.SetKind(kind)
	obj.SetName(name)
	obj.SetNamespace("default")
	for key, value := range fields {
		obj.Object[key] = value
	}
	return obj
}

func TestAssessObjectHealthMatrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		obj         *unstructured.Unstructured
		wantHealth  string
		wantMessage string
	}{
		{
			name:       "service account exists and is healthy",
			obj:        assessable("ServiceAccount", "web", nil),
			wantHealth: "Healthy",
		},
		{
			name: "certificate ready",
			obj: assessable("Certificate", "tls", map[string]interface{}{
				"status": map[string]interface{}{"conditions": []interface{}{
					map[string]interface{}{"type": "Ready", "status": "True", "message": "Certificate is up to date"},
				}},
			}),
			wantHealth: "Healthy",
		},
		{
			name: "certificate still issuing is progressing not unknown",
			obj: assessable("Certificate", "tls", map[string]interface{}{
				"status": map[string]interface{}{"conditions": []interface{}{
					map[string]interface{}{"type": "Ready", "status": "False", "reason": "Issuing", "message": "issuance in flight"},
				}},
			}),
			wantHealth:  "Progressing",
			wantMessage: "Ready: issuance in flight",
		},
		{
			name: "certificate failed is degraded with the controller message",
			obj: assessable("Certificate", "tls", map[string]interface{}{
				"status": map[string]interface{}{"conditions": []interface{}{
					map[string]interface{}{"type": "Ready", "status": "False"},
					map[string]interface{}{"type": "Issuing", "status": "False"},
					map[string]interface{}{"type": "Failed", "status": "True", "message": "ACME challenge timed out"},
				}},
			}),
			wantHealth:  "Degraded",
			wantMessage: "Failed: ACME challenge timed out",
		},
		{
			name: "httproute accepted and programmed",
			obj: assessable("HTTPRoute", "web", map[string]interface{}{
				"status": map[string]interface{}{"conditions": []interface{}{
					map[string]interface{}{"type": "Accepted", "status": "True"},
					map[string]interface{}{"type": "ResolvedRefs", "status": "True"},
				}},
			}),
			wantHealth: "Healthy",
		},
		{
			name: "httproute rejected is progressing with the reason",
			obj: assessable("HTTPRoute", "web", map[string]interface{}{
				"status": map[string]interface{}{"conditions": []interface{}{
					map[string]interface{}{"type": "Accepted", "status": "False", "reason": "NoMatchingListenerHostname", "message": "no listener matched hostname"},
				}},
			}),
			wantHealth:  "Progressing",
			wantMessage: "Accepted: no listener matched hostname",
		},
		{
			name: "statefulset short on replicas",
			obj: assessable("StatefulSet", "db", map[string]interface{}{
				"spec":   map[string]interface{}{"replicas": int64(3)},
				"status": map[string]interface{}{"readyReplicas": int64(1)},
			}),
			wantHealth:  "Progressing",
			wantMessage: "1/3 replicas available",
		},
		{
			name: "statefulset ready",
			obj: assessable("StatefulSet", "db", map[string]interface{}{
				"spec":   map[string]interface{}{"replicas": int64(3)},
				"status": map[string]interface{}{"readyReplicas": int64(3), "updatedReplicas": int64(3)},
			}),
			wantHealth: "Healthy",
		},
		{
			name: "workload scaled to zero is healthy",
			obj: assessable("Deployment", "idle", map[string]interface{}{
				"spec":   map[string]interface{}{"replicas": int64(0)},
				"status": map[string]interface{}{"availableReplicas": int64(0)},
			}),
			wantHealth: "Healthy",
		},
		{
			name: "pvc bound",
			obj: assessable("PersistentVolumeClaim", "data", map[string]interface{}{
				"status": map[string]interface{}{"phase": "Bound"},
			}),
			wantHealth:  "Healthy",
			wantMessage: "phase Bound",
		},
		{
			name: "pvc pending",
			obj: assessable("PersistentVolumeClaim", "data", map[string]interface{}{
				"status": map[string]interface{}{"phase": "Pending"},
			}),
			wantHealth: "Progressing",
		},
		{
			name: "job complete",
			obj: assessable("Job", "migrate", map[string]interface{}{
				"status": map[string]interface{}{"succeeded": int64(1)},
			}),
			wantHealth: "Healthy",
		},
		{
			name: "job failed",
			obj: assessable("Job", "migrate", map[string]interface{}{
				"status": map[string]interface{}{"conditions": []interface{}{
					map[string]interface{}{"type": "Failed", "status": "True", "message": "backoffLimit exceeded"},
				}},
			}),
			wantHealth:  "Degraded",
			wantMessage: "Failed: backoffLimit exceeded",
		},
		{
			name:       "unrecognised kind with no status is healthy",
			obj:        assessable("SealedSecret", "creds", nil),
			wantHealth: "Healthy",
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			health := AssessObject(test.obj)
			assert.Equal(t, test.wantHealth, string(health.Health))
			if test.wantMessage != "" {
				assert.Equal(t, test.wantMessage, health.Message)
			}
		})
	}
}

func TestAssessObjectTerminatingIsProgressing(t *testing.T) {
	t.Parallel()

	obj := assessable("StatefulSet", "db", nil)
	now := metav1.Now()
	obj.SetDeletionTimestamp(&now)

	health := AssessObject(obj)
	assert.Equal(t, "Progressing", string(health.Health))
	assert.Equal(t, "terminating", health.Message)
}

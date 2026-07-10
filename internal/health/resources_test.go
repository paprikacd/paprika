package health

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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

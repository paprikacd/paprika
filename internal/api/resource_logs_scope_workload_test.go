package apiserver

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/go-logr/logr"
	"github.com/go-logr/logr/funcr"
	"github.com/stretchr/testify/require"
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	k8stesting "k8s.io/client-go/testing"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/log"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// logsScopeWorkloadObjects is the destination with pods that a workload's
// selector matches but that the workload does not own. The foreign pods are in
// the tree through the managed CronJob and sort before the workload's own pod.
func logsScopeWorkloadObjects() []runtime.Object {
	objects := logsScopeDestination()
	objects = append(objects,
		&appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: logsScopeNamespace},
			Spec: appsv1.StatefulSetSpec{Selector: logsScopeSelector("app", "db")}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "db-z", Namespace: logsScopeNamespace,
			Labels: map[string]string{"app": "db"}, OwnerReferences: logsScopeOwned("StatefulSet", "db")}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "db-a-00", Namespace: logsScopeNamespace,
			Labels: map[string]string{"app": "db"}, OwnerReferences: logsScopeOwned("Job", "nightly-28")}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "api-00-x", Namespace: logsScopeNamespace,
			Labels: map[string]string{"app": "api"}, OwnerReferences: logsScopeOwned("Job", "nightly-28")}},
	)
	return objects
}

// TestResourceLogsScopeResolvesTheRequestedWorkloadsPod checks that a workload's
// pod is one the workload owns, not the first in-tree pod its selector matches.
func TestResourceLogsScopeResolvesTheRequestedWorkloadsPod(t *testing.T) {
	t.Parallel()
	app := logsScopeApplication(nil)
	app.Status.Resources = append(app.Status.Resources,
		pipelinesv1alpha1.ResourceSync{Kind: "StatefulSet", Name: "db", Namespace: logsScopeNamespace, Status: "Synced"})

	cases := []struct{ kind, name, want string }{
		{"Deployment", "api", "api-7d9-x1"},
		{"StatefulSet", "db", "db-z"},
	}
	for _, tc := range cases {
		t.Run(tc.kind+"/"+tc.name, func(t *testing.T) {
			t.Parallel()
			pod, err := resolveApplicationLogsPod(t.Context(), logsScopeClientset(logsScopeWorkloadObjects()...), app,
				tc.kind, tc.name, logsScopeNamespace)
			require.NoError(t, err)
			require.Equal(t, tc.want, pod.Name)
		})
	}
}

// TestResourceLogsScopeFindsTheWorkloadPodPastForeignPods checks that many
// selector matches owned by other workloads do not use up the read budget
// before the workload's own pod is reached.
func TestResourceLogsScopeFindsTheWorkloadPodPastForeignPods(t *testing.T) {
	t.Parallel()
	objects := logsScopeDestination()
	for i := range 20 {
		job := fmt.Sprintf("backfill-%02d", i)
		objects = append(objects,
			&batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: job, Namespace: logsScopeNamespace}},
			&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("api-00-%02d", i), Namespace: logsScopeNamespace,
				Labels: map[string]string{"app": "api"}, OwnerReferences: logsScopeOwned("Job", job)}})
	}
	cs := logsScopeClientset(objects...)

	pod, err := resolveApplicationLogsPod(t.Context(), cs, logsScopeApplication(nil), "Deployment", "api", logsScopeNamespace)
	require.NoError(t, err)
	require.Equal(t, "api-7d9-x1", pod.Name)
	require.Zero(t, getsOf(cs, "jobs"), "a pod owned by another kind of owner must not be read")
}

// TestResourceLogsScopeReportsAManagedResourceThatIsGone checks that a managed
// resource missing from the cluster keeps its own message, as the tree shows it.
func TestResourceLogsScopeReportsAManagedResourceThatIsGone(t *testing.T) {
	t.Parallel()
	app := logsScopeApplication(nil)
	app.Status.Resources = append(app.Status.Resources,
		pipelinesv1alpha1.ResourceSync{Kind: "Pod", Name: "gone-pod", Namespace: logsScopeNamespace, Status: "Synced"},
		pipelinesv1alpha1.ResourceSync{Kind: "Deployment", Name: "gone-deploy", Namespace: logsScopeNamespace, Status: "Synced"})
	client := logsScopeServer(t, app, nil, WithK8sClient(logsScopeClientset(logsScopeDestination()...)))

	for _, tc := range []struct{ kind, name string }{{"Pod", "gone-pod"}, {"Deployment", "gone-deploy"}} {
		want := fmt.Sprintf("%s %s/%s not found", tc.kind, logsScopeNamespace, tc.name)

		unary, err := client.GetResourceLogs(t.Context(), connect.NewRequest(&paprikav1.GetResourceLogsRequest{
			ApplicationNamespace: "platform", ApplicationName: "shop-app",
			ResourceKind: tc.kind, ResourceName: tc.name, ResourceNamespace: logsScopeNamespace,
		}))
		require.NoError(t, err, tc.name)
		require.Equal(t, want, unary.Msg.Error, tc.name)

		stream, err := client.StreamResourceLogs(t.Context(), connect.NewRequest(&paprikav1.StreamResourceLogsRequest{
			ApplicationNamespace: "platform", ApplicationName: "shop-app",
			ResourceKind: tc.kind, ResourceName: tc.name, ResourceNamespace: logsScopeNamespace,
		}))
		require.NoError(t, err, tc.name)
		require.False(t, stream.Receive(), tc.name)
		streamErr := stream.Err()
		require.NoError(t, stream.Close())
		require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(streamErr), tc.name)
		require.Equal(t, want, logsScopeMessage(t, streamErr), tc.name)
	}
}

// TestResourceLogsScopeRejectsMalformedIdentifiers checks that a request the
// cluster could never match is refused before any read.
func TestResourceLogsScopeRejectsMalformedIdentifiers(t *testing.T) {
	t.Parallel()
	cases := []struct{ name, kind, resource, namespace string }{
		{"empty name", "Pod", "", logsScopeNamespace},
		{"name with a path separator", "Pod", "a/b", logsScopeNamespace},
		{"dot-dot name", "Deployment", "..", logsScopeNamespace},
		{"namespace with a path separator", "Pod", "api-7d9-x1", "bad/ns"},
		{"empty kind", "", "api", logsScopeNamespace},
		{"unsupported kind", "ConfigMap", "api", logsScopeNamespace},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			// Each subtest builds its own application: the fake client builder
			// writes resource versions into the objects it is given.
			app := logsScopeApplication(nil)
			cs := logsScopeClientset(logsScopeDestination()...)
			_, err := resolveApplicationLogsPod(t.Context(), cs, app, tc.kind, tc.resource, tc.namespace)
			require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
			require.Empty(t, cs.Actions(), "a malformed request must not reach the cluster")

			client := logsScopeServer(t, app, nil, WithK8sClient(cs))
			unary, err := client.GetResourceLogs(t.Context(), connect.NewRequest(&paprikav1.GetResourceLogsRequest{
				ApplicationNamespace: "platform", ApplicationName: "shop-app",
				ResourceKind: tc.kind, ResourceName: tc.resource, ResourceNamespace: tc.namespace,
			}))
			require.NoError(t, err, "unary handler answers in the response")
			require.NotEmpty(t, unary.Msg.Error)

			stream, err := client.StreamResourceLogs(t.Context(), connect.NewRequest(&paprikav1.StreamResourceLogsRequest{
				ApplicationNamespace: "platform", ApplicationName: "shop-app",
				ResourceKind: tc.kind, ResourceName: tc.resource, ResourceNamespace: tc.namespace,
			}))
			require.NoError(t, err)
			require.False(t, stream.Receive())
			streamErr := stream.Err()
			require.NoError(t, stream.Close())
			require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(streamErr), "stream handler")
			require.Empty(t, cs.Actions(), "a malformed request must not reach the cluster")
		})
	}
}

// logSink records the text of every log line a request writes.
type logSink struct {
	mu    sync.Mutex
	lines []string
}

func (s *logSink) logger() logr.Logger {
	return funcr.New(func(_, args string) {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.lines = append(s.lines, args)
	}, funcr.Options{})
}

func (s *logSink) count(text string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, line := range s.lines {
		if strings.Contains(line, text) {
			n++
		}
	}
	return n
}

// TestResourceLogsScopeReportsACancelledReadAsCanceled checks that a read the
// caller abandoned returns CodeCanceled and is not logged as a server error,
// while a real failure is still logged.
func TestResourceLogsScopeReportsACancelledReadAsCanceled(t *testing.T) {
	t.Parallel()
	app := logsScopeApplication(nil)
	const logged = "reading a resource failed"

	t.Run("cancelled caller gets CodeCanceled and no log line", func(t *testing.T) {
		t.Parallel()
		sink := &logSink{}
		ctx, cancel := context.WithCancel(log.IntoContext(t.Context(), sink.logger()))
		cancel()
		cs := logsScopeClientset(logsScopeDestination()...)
		cs.PrependReactor("get", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
			return true, nil, context.Canceled
		})

		_, err := resolveApplicationLogsPod(ctx, cs, app, "Pod", "api-7d9-x1", logsScopeNamespace)
		require.Equal(t, connect.CodeCanceled, connect.CodeOf(err))
		require.Zero(t, sink.count(logged))
	})

	t.Run("failed read is logged and answered generically", func(t *testing.T) {
		t.Parallel()
		sink := &logSink{}
		ctx := log.IntoContext(t.Context(), sink.logger())
		cs := logsScopeClientset(logsScopeDestination()...)
		cs.PrependReactor("get", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
			return true, nil, apierrors.NewInternalError(errors.New("boom"))
		})

		_, err := resolveApplicationLogsPod(ctx, cs, app, "Pod", "api-7d9-x1", logsScopeNamespace)
		require.Equal(t, errLogsReadFailed, err)
		require.Equal(t, 1, sink.count(logged))
	})
}

// verboseLogger returns a logger at verbosity 1, so V(1) lines are recorded too.
func (s *logSink) verboseLogger() logr.Logger {
	return funcr.New(func(_, args string) {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.lines = append(s.lines, args)
	}, funcr.Options{Verbosity: 1})
}

// TestResourceLogsScopeReportsForbiddenReadsByWhetherTheTreeShowsThem checks how
// a forbidden read is answered. A managed resource the tree shows gets the
// generic read failure, and the server logs it. An owner the credential cannot
// read puts its child outside the tree, and the server logs that at verbosity 1.
func TestResourceLogsScopeReportsForbiddenReadsByWhetherTheTreeShowsThem(t *testing.T) {
	t.Parallel()
	app := logsScopeApplication(nil)
	forbidden := func(resource, name string) error {
		return apierrors.NewForbidden(schema.GroupResource{Group: "apps", Resource: resource}, name, errors.New("denied"))
	}
	cs := logsScopeClientset(append(logsScopeDestination(),
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "locked-owner", Namespace: logsScopeNamespace,
			OwnerReferences: logsScopeOwned("ReplicaSet", "locked-rs")}},
	)...)
	cs.PrependReactor("get", "deployments", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if getActionName(action) == "api" {
			return true, nil, forbidden("deployments", "api")
		}
		return false, nil, nil
	})
	cs.PrependReactor("get", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if getActionName(action) == "bootstrap-0" {
			return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, "bootstrap-0", errors.New("denied"))
		}
		return false, nil, nil
	})
	cs.PrependReactor("get", "replicasets", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if getActionName(action) == "locked-rs" {
			return true, nil, forbidden("replicasets", "locked-rs")
		}
		return false, nil, nil
	})
	const failed = "reading a resource failed"
	const owner = "owner read forbidden"

	t.Run("managed deployment is a logged read failure", func(t *testing.T) {
		t.Parallel()
		sink := &logSink{}
		ctx := log.IntoContext(t.Context(), sink.verboseLogger())
		_, err := resolveApplicationLogsPod(ctx, cs, app, "Deployment", "api", logsScopeNamespace)
		require.Equal(t, errLogsReadFailed, err)
		require.Equal(t, 1, sink.count(failed))
	})
	t.Run("managed pod is a logged read failure", func(t *testing.T) {
		t.Parallel()
		sink := &logSink{}
		ctx := log.IntoContext(t.Context(), sink.verboseLogger())
		_, err := resolveApplicationLogsPod(ctx, cs, app, "Pod", "bootstrap-0", logsScopeNamespace)
		require.Equal(t, errLogsReadFailed, err)
		require.Equal(t, 1, sink.count(failed))
	})
	t.Run("owner the credential cannot read is outside the tree and logged at verbosity 1", func(t *testing.T) {
		t.Parallel()
		sink := &logSink{}
		ctx := log.IntoContext(t.Context(), sink.verboseLogger())
		_, err := resolveApplicationLogsPod(ctx, cs, app, "Pod", "locked-owner", logsScopeNamespace)
		require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
		require.Equal(t, logsScopeOutsideMessage("Pod", logsScopeNamespace, "locked-owner"), logsScopeMessage(t, err))
		require.Equal(t, 1, sink.count(owner))
		require.Zero(t, sink.count(failed))
	})
	t.Run("owner forbidden line is not written at the default verbosity", func(t *testing.T) {
		t.Parallel()
		sink := &logSink{}
		ctx := log.IntoContext(t.Context(), sink.logger())
		_, err := resolveApplicationLogsPod(ctx, cs, app, "Pod", "locked-owner", logsScopeNamespace)
		require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
		require.Zero(t, sink.count(owner))
	})
}

// TestResourceLogsScopeAppliesTheWorkloadPodLimit pins logsWorkloadPodLimit (50)
// with literal counts, so changing the constant fails this test: a workload's
// own pod is found only within the first 50 pods its selector matches. Foreign
// pods sort first, so 50 of them fill the page.
func TestResourceLogsScopeAppliesTheWorkloadPodLimit(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		foreign int
		found   bool
	}{
		{49, true},
		{50, false},
	} {
		t.Run(fmt.Sprintf("%d foreign pods", tc.foreign), func(t *testing.T) {
			t.Parallel()
			objects := logsScopeDestination()
			for i := range tc.foreign {
				objects = append(objects, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
					Name: fmt.Sprintf("api-00-%03d", i), Namespace: logsScopeNamespace,
					Labels: map[string]string{"app": "api"}, OwnerReferences: logsScopeOwned("Job", "backfill")}})
			}
			_, err := resolveApplicationLogsPod(t.Context(), logsScopeClientset(objects...), logsScopeApplication(nil),
				"Deployment", "api", logsScopeNamespace)
			if tc.found {
				require.NoError(t, err)
				return
			}
			require.EqualError(t, err, noPodsMessage("Deployment", "api"))
		})
	}
}

// TestResourceLogsScopeTreatsInvalidOwnerNamesAsOutsideTheTree checks that an
// owner name the cluster could never hold counts as no owner, with no read.
// Every ReplicaSet read fails here, so any read would show up as a log line.
func TestResourceLogsScopeTreatsInvalidOwnerNamesAsOutsideTheTree(t *testing.T) {
	t.Parallel()
	const logged = "reading a resource failed"

	t.Run("pod whose owner name is invalid", func(t *testing.T) {
		t.Parallel()
		sink := &logSink{}
		ctx := log.IntoContext(t.Context(), sink.logger())
		cs := logsScopeClientset(append(logsScopeDestination(),
			&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "bad-owner", Namespace: logsScopeNamespace,
				OwnerReferences: logsScopeOwned("ReplicaSet", "a/b")}})...)
		cs.PrependReactor("get", "replicasets", func(action k8stesting.Action) (bool, runtime.Object, error) {
			return true, nil, apierrors.NewInternalError(errors.New("boom"))
		})

		_, err := resolveApplicationLogsPod(ctx, cs, logsScopeApplication(nil), "Pod", "bad-owner", logsScopeNamespace)
		require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
		require.Equal(t, logsScopeOutsideMessage("Pod", logsScopeNamespace, "bad-owner"), logsScopeMessage(t, err))
		require.Zero(t, getsOf(cs, "replicasets"))
		require.Zero(t, sink.count(logged))
	})

	t.Run("workload candidate whose owner name is invalid", func(t *testing.T) {
		t.Parallel()
		sink := &logSink{}
		ctx := log.IntoContext(t.Context(), sink.logger())
		cs := logsScopeClientset(append(logsScopeDestination(),
			&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "wide", Namespace: logsScopeNamespace},
				Spec: appsv1.DeploymentSpec{Selector: logsScopeSelector("app", "wide")}},
			&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "wide-bad", Namespace: logsScopeNamespace,
				Labels: map[string]string{"app": "wide"}, OwnerReferences: logsScopeOwned("ReplicaSet", "a/b")}})...)
		cs.PrependReactor("get", "replicasets", func(action k8stesting.Action) (bool, runtime.Object, error) {
			return true, nil, apierrors.NewInternalError(errors.New("boom"))
		})
		managed := logsScopeApplication(nil)
		managed.Status.Resources = append(managed.Status.Resources,
			pipelinesv1alpha1.ResourceSync{Kind: "Deployment", Name: "wide", Namespace: logsScopeNamespace, Status: "Synced"})

		_, err := resolveApplicationLogsPod(ctx, cs, managed, "Deployment", "wide", logsScopeNamespace)
		require.EqualError(t, err, noPodsMessage("Deployment", "wide"))
		require.Zero(t, getsOf(cs, "replicasets"))
		require.Zero(t, sink.count(logged))
	})
}

// TestResourceLogsScopeReportsAnExpiredDeadlineAsDeadlineExceeded checks that a
// read cut short by the caller's deadline returns CodeDeadlineExceeded, is not
// logged as a server error, and passes through the unary handler unchanged.
func TestResourceLogsScopeReportsAnExpiredDeadlineAsDeadlineExceeded(t *testing.T) {
	t.Parallel()
	sink := &logSink{}
	ctx, cancel := context.WithDeadline(log.IntoContext(t.Context(), sink.logger()), time.Now().Add(-time.Second))
	defer cancel()
	cs := logsScopeClientset(logsScopeDestination()...)
	cs.PrependReactor("get", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, context.DeadlineExceeded
	})

	_, err := resolveApplicationLogsPod(ctx, cs, logsScopeApplication(nil), "Pod", "api-7d9-x1", logsScopeNamespace)
	require.Equal(t, connect.CodeDeadlineExceeded, connect.CodeOf(err))
	require.Zero(t, sink.count("reading a resource failed"))

	scheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(scheme))
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(logsScopeApplication(nil)).
		WithStatusSubresource(&pipelinesv1alpha1.Application{}).Build()
	srv := NewPaprikaServer(c, nil, WithK8sClient(cs))
	_, handlerErr := srv.GetResourceLogs(ctx, connect.NewRequest(&paprikav1.GetResourceLogsRequest{
		ApplicationNamespace: "platform", ApplicationName: "shop-app",
		ResourceKind: "Pod", ResourceName: "api-7d9-x1", ResourceNamespace: logsScopeNamespace,
	}))
	require.Equal(t, connect.CodeDeadlineExceeded, connect.CodeOf(handlerErr))
	// The stream handler returns the same resolve error unchanged. The nil stream
	// is never used, because the handler returns before it sends anything.
	streamErr := srv.StreamResourceLogs(ctx, connect.NewRequest(&paprikav1.StreamResourceLogsRequest{
		ApplicationNamespace: "platform", ApplicationName: "shop-app",
		ResourceKind: "Pod", ResourceName: "api-7d9-x1", ResourceNamespace: logsScopeNamespace,
	}), nil)
	require.Equal(t, connect.CodeDeadlineExceeded, connect.CodeOf(streamErr))
	require.Zero(t, sink.count("reading a resource failed"))
}

// TestResourceLogsScopeCountsOnlyValidOwnersTowardTheBound pins the owner-name
// guards at the two places that count owner references against
// logsTreeMaxOwnerRefs. Eight invalid owners come first, so a guard that counted
// them would end the walk before the valid owner, and the pod would be denied.
func TestResourceLogsScopeCountsOnlyValidOwnersTowardTheBound(t *testing.T) {
	t.Parallel()
	invalidThenValid := func() []metav1.OwnerReference {
		var owners []metav1.OwnerReference
		for i := range logsTreeMaxOwnerRefs {
			owners = append(owners, logsScopeOwned("ReplicaSet", fmt.Sprintf("bad/%d", i))...)
		}
		return append(owners, logsScopeOwned("ReplicaSet", "api-7d9")...)
	}

	t.Run("pod owned by a managed chain", func(t *testing.T) {
		t.Parallel()
		cs := logsScopeClientset(append(logsScopeDestination(),
			&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "crowded", Namespace: logsScopeNamespace,
				OwnerReferences: invalidThenValid()}})...)
		pod, err := resolveApplicationLogsPod(t.Context(), cs, logsScopeApplication(nil), "Pod", "crowded", logsScopeNamespace)
		require.NoError(t, err)
		require.Equal(t, "crowded", pod.Name)
	})

	t.Run("workload pod owned by a managed chain", func(t *testing.T) {
		t.Parallel()
		// api-0-crowded sorts before api-7d9-x1, so the workload reaches it first.
		cs := logsScopeClientset(append(logsScopeDestination(),
			&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "api-0-crowded", Namespace: logsScopeNamespace,
				Labels: map[string]string{"app": "api"}, OwnerReferences: invalidThenValid()}})...)
		pod, err := resolveApplicationLogsPod(t.Context(), cs, logsScopeApplication(nil), "Deployment", "api", logsScopeNamespace)
		require.NoError(t, err)
		require.Equal(t, "api-0-crowded", pod.Name)
	})
}

// A StatefulSet resolves only to a pod it owns that the tree shows. Two managed
// StatefulSets and an unmanaged one share selector app=db, so selector matching
// alone would return a sibling's pod or the unmanaged one's.
func TestResourceLogsScopeResolvesEachStatefulSetToItsOwnPod(t *testing.T) {
	app := logsScopeApplication(nil)
	app.Status.Resources = append(app.Status.Resources,
		pipelinesv1alpha1.ResourceSync{Kind: "StatefulSet", Name: "db", Namespace: logsScopeNamespace, Status: "Synced"},
		pipelinesv1alpha1.ResourceSync{Kind: "StatefulSet", Name: "db-canary", Namespace: logsScopeNamespace, Status: "Synced"})
	objects := append(logsScopeDestination(),
		&appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: logsScopeNamespace},
			Spec: appsv1.StatefulSetSpec{Selector: logsScopeSelector("app", "db")}},
		&appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Name: "db-canary", Namespace: logsScopeNamespace},
			Spec: appsv1.StatefulSetSpec{Selector: logsScopeSelector("app", "db")}},
		&appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Name: "db-shadow", Namespace: logsScopeNamespace},
			Spec: appsv1.StatefulSetSpec{Selector: logsScopeSelector("app", "db")}},
		// Pod names sort so that the wrong answers come first.
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "db-0-shadow", Namespace: logsScopeNamespace,
			Labels: map[string]string{"app": "db"}, OwnerReferences: logsScopeOwned("StatefulSet", "db-shadow")}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "db-1-canary", Namespace: logsScopeNamespace,
			Labels: map[string]string{"app": "db"}, OwnerReferences: logsScopeOwned("StatefulSet", "db-canary")}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "db-z", Namespace: logsScopeNamespace,
			Labels: map[string]string{"app": "db"}, OwnerReferences: logsScopeOwned("StatefulSet", "db")}},
	)

	t.Run("each managed StatefulSet resolves to its own pod", func(t *testing.T) {
		pod, err := resolveApplicationLogsPod(t.Context(), logsScopeClientset(objects...), app, "StatefulSet", "db", logsScopeNamespace)
		require.NoError(t, err)
		require.Equal(t, "db-z", pod.Name)
	})

	t.Run("through GetResourceLogs", func(t *testing.T) {
		client := logsScopeServer(t, app, nil, WithK8sClient(logsScopeClientset(objects...)))
		unary, err := client.GetResourceLogs(t.Context(), connect.NewRequest(&paprikav1.GetResourceLogsRequest{
			ApplicationNamespace: "platform", ApplicationName: "shop-app",
			ResourceKind: "StatefulSet", ResourceName: "db-canary", ResourceNamespace: logsScopeNamespace,
		}))
		require.NoError(t, err)
		require.Equal(t, "db-1-canary", unary.Msg.PodName)
	})
}

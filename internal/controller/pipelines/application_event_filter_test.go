package pipelines

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/api/equality"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/watch"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/predicate"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/health"
)

func observedApplication() *paprikav1.Application {
	checked := metav1.NewTime(time.Unix(1800000000, 0).UTC())
	return &paprikav1.Application{
		ObjectMeta: metav1.ObjectMeta{
			Name: "promotion-demo", Namespace: "paprika-promotion-prod",
			ResourceVersion: "27472674", Generation: 2,
			Annotations: map[string]string{"example": "kept"},
			Finalizers:  []string{applicationFinalizer},
		},
		Status: paprikav1.ApplicationStatus{
			Phase:      paprikav1.ApplicationHealthy,
			Health:     paprikav1.HealthHealthy,
			ReleaseRef: "promotion-demo-release-53f873b974",
			HealthChecks: []paprikav1.HealthCheckResult{{
				Name: "internal-http", Status: paprikav1.HealthHealthy, Message: "check passed",
				CheckedAt: &checked, DurationMillis: 5, HTTPStatusCode: 200, HTTPBody: `{"timestamp":"04:45:35"}`,
				ConfigurationHash: "abc",
			}},
			DeploymentObservation: &paprikav1.ApplicationDeploymentObservation{
				Release: "promotion-demo-release-53f873b974", ReleaseUID: "uid", Revision: "a9bd20fb",
				ObservedGeneration: 2, ObservedAt: checked,
			},
		},
	}
}

func TestApplicationUpdateFilter(t *testing.T) {
	t.Parallel()

	later := metav1.NewTime(time.Unix(1800000005, 0).UTC())
	cases := []struct {
		name   string
		mutate func(*paprikav1.Application)
		want   bool
	}{
		{
			// The live diff between two promotion-demo writes five seconds apart.
			name: "next health observation of an unchanged check",
			mutate: func(a *paprikav1.Application) {
				a.Status.HealthChecks[0].CheckedAt = &later
				a.Status.HealthChecks[0].DurationMillis = 6
				a.Status.HealthChecks[0].HTTPBody = `{"timestamp":"04:45:40"}`
				a.ManagedFields = []metav1.ManagedFieldsEntry{{Manager: "manager"}}
			},
			want: false,
		},
		{
			name:   "deployment observation bucket moved",
			mutate: func(a *paprikav1.Application) { a.Status.DeploymentObservation.ObservedAt = later },
			want:   false,
		},
		{
			name:   "sync annotation set by a deploy",
			mutate: func(a *paprikav1.Application) { a.Annotations[syncAnnotation] = "29a3f4074-1" },
			want:   true,
		},
		{
			name:   "spec change",
			mutate: func(a *paprikav1.Application) { a.Generation = 3 },
			want:   true,
		},
		{
			name:   "label change",
			mutate: func(a *paprikav1.Application) { a.Labels = map[string]string{"team": "x"} },
			want:   true,
		},
		{
			name: "deletion",
			mutate: func(a *paprikav1.Application) {
				a.DeletionTimestamp = &later
			},
			want: true,
		},
		{
			name:   "health check outcome changed",
			mutate: func(a *paprikav1.Application) { a.Status.HealthChecks[0].Status = paprikav1.HealthDegraded },
			want:   true,
		},
		{
			name:   "consecutive failures counted",
			mutate: func(a *paprikav1.Application) { a.Status.HealthChecks[0].ConsecutiveFailures = 1 },
			want:   true,
		},
		{
			name:   "release reference set by the release controller or a publisher",
			mutate: func(a *paprikav1.Application) { a.Status.ReleaseRef = "promotion-demo-release-next" },
			want:   true,
		},
		{
			name: "gate approved through the API",
			mutate: func(a *paprikav1.Application) {
				a.Status.Gates = []paprikav1.GateStatus{{Name: "approve", Status: paprikav1.GateStatusApproved}}
			},
			want: true,
		},
		{
			name:   "deployment observation of a new release",
			mutate: func(a *paprikav1.Application) { a.Status.DeploymentObservation.Release = "next" },
			want:   true,
		},
		{
			name:   "deployment observation dropped",
			mutate: func(a *paprikav1.Application) { a.Status.DeploymentObservation = nil },
			want:   true,
		},
	}

	filter := applicationUpdateFilter()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			oldApp := observedApplication()
			newApp := oldApp.DeepCopy()
			newApp.ResourceVersion = "27472718"
			tc.mutate(newApp)
			require.Equal(t, tc.want, filter.Update(event.UpdateEvent{ObjectOld: oldApp, ObjectNew: newApp}))
		})
	}

	t.Run("informer resync of an unchanged object still reconciles", func(t *testing.T) {
		t.Parallel()
		app := observedApplication()
		require.True(t, filter.Update(event.UpdateEvent{ObjectOld: app, ObjectNew: app.DeepCopy()}))
	})
	t.Run("create, delete and generic events pass", func(t *testing.T) {
		t.Parallel()
		app := observedApplication()
		require.True(t, filter.Create(event.CreateEvent{Object: app}))
		require.True(t, filter.Delete(event.DeleteEvent{Object: app}))
		require.True(t, filter.Generic(event.GenericEvent{Object: app}))
	})
}

// steadyStateReconciles drives the real Reconcile of a Healthy application with
// a 5s health check for one simulated minute. The fake client's watch stands in
// for the informer, filter for the controller's event filter, and a single
// delaying-queue slot for controller-runtime's workqueue: an event that passes
// the filter reconciles at once, RequeueAfter keeps the earliest pending time.
func steadyStateReconciles(t *testing.T, filter predicate.Predicate) (reconciles, probes int) {
	t.Helper()
	var probeCalls atomic.Int32
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		probeCalls.Add(1)
		_, _ = w.Write([]byte("ok"))
	}))
	t.Cleanup(endpoint.Close)

	app := newRolloutApp("stable-app")
	app.Finalizers = []string{applicationFinalizer}
	app.Spec.Source.PollInterval = "60s"
	app.Spec.HealthChecks = []paprikav1.HealthCheck{{
		Name: "internal-http", Interval: "5s",
		Expression: "http.statusCode == 200 && http.body == 'ok'",
		HTTPProbe:  &paprikav1.HTTPProbe{URL: endpoint.URL, Method: http.MethodGet, ExpectedStatus: http.StatusOK, Timeout: 5},
	}}
	fx := newRolloutFixture(t, app)

	// Roll the application out to a steady Healthy state, playing the Release
	// controller, before measuring.
	for i := 0; ; i++ {
		require.Less(t, i, 12, "application never settled Healthy")
		current := fx.reconcile()
		if ref := current.Status.ReleaseRef; ref != "" && fx.release(ref).Status.Phase != paprikav1.ReleaseComplete {
			fx.setReleasePhase(ref, paprikav1.ReleaseComplete)
			continue
		}
		if current.Status.Phase == paprikav1.ApplicationHealthy && current.Status.Revision != "" {
			if again := fx.reconcile(); again.Status.Phase == paprikav1.ApplicationHealthy && again.Status.ReleaseRef == current.Status.ReleaseRef {
				break
			}
		}
	}

	now := time.Unix(1800000000, 0).UTC() // a 5s boundary
	fx.r.HealthEval = health.NewCELEvaluator()
	fx.r.now = func() time.Time { return now }

	ctx := context.Background()
	watcher, ok := fx.c.(client.WithWatch)
	require.True(t, ok, "the fake client must support watches")
	w, err := watcher.Watch(ctx, &paprikav1.ApplicationList{}, client.InNamespace(app.Namespace))
	require.NoError(t, err)
	t.Cleanup(w.Stop)
	last := fx.fetch()

	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: app.Namespace, Name: app.Name}}
	end := now.Add(time.Minute)
	dirty := true // the informer's initial add
	var waiting *time.Time
	for {
		if !dirty {
			if waiting == nil || !waiting.Before(end) {
				break
			}
			now, waiting = *waiting, nil
		}
		dirty = false
		res, err := fx.r.Reconcile(ctx, req)
		require.NoError(t, err)
		reconciles++
		require.Less(t, reconciles, 500, "hot loop: reconciles did not settle")

	drain:
		for {
			select {
			case ev := <-w.ResultChan():
				if ev.Type != watch.Modified {
					dirty = true
					continue
				}
				updated, ok := ev.Object.(*paprikav1.Application)
				require.True(t, ok)
				if filter.Update(event.UpdateEvent{ObjectOld: last, ObjectNew: updated}) {
					dirty = true
				}
				last = updated
			default:
				break drain
			}
		}
		if res.RequeueAfter > 0 {
			if at := now.Add(res.RequeueAfter); waiting == nil || at.Before(*waiting) {
				waiting = &at
			}
		}
	}
	return reconciles, int(probeCalls.Load())
}

// A Healthy application whose 5s health check keeps passing is observed twelve
// times a minute. Each observation is one reconcile; its status write must not
// buy a second one. Measured on omega-ha before the filter: 24 reconciles a
// minute for promotion-demo in dev, 36 in stg and prod.
func TestStableApplicationDoesNotReconcileInAHotLoop(t *testing.T) {
	t.Parallel()

	filtered, probes := steadyStateReconciles(t, applicationUpdateFilter())
	t.Logf("with the update filter: %d reconciles, %d probes in one simulated minute", filtered, probes)
	require.Equal(t, 12, probes, "one probe per 5s interval")
	require.LessOrEqual(t, filtered, probes+1, "one reconcile per observation, plus the initial add")

	unfiltered, unfilteredProbes := steadyStateReconciles(t, predicate.Funcs{})
	t.Logf("without it: %d reconciles, %d probes", unfiltered, unfilteredProbes)
	require.Equal(t, 12, unfilteredProbes)
	require.GreaterOrEqual(t, unfiltered, 2*unfilteredProbes, "each observation's status write echoed into a second reconcile")
}

// The fields observationOnlyUpdate may ignore, by the struct they belong to.
// Adding one here is the deliberate act that lets the filter drop an update.
var (
	ignoredHealthCheckResultFields = map[string]bool{
		"CheckedAt": true, "DurationMillis": true, "HTTPBody": true, "BodyTruncated": true,
	}
	ignoredDeploymentObservationFields = map[string]bool{"ObservedAt": true}
	// ResourceVersion differs on every write; ManagedFields is server
	// bookkeeping.
	ignoredObjectMetaFields = map[string]bool{"ResourceVersion": true, "ManagedFields": true}
)

var (
	reflectTimeType     = reflect.TypeOf(time.Time{})
	reflectQuantityType = reflect.TypeOf(resource.Quantity{})
)

// nonZeroValue builds a value of t with every exported field it can reach set,
// so it differs from both the zero value and the fixture's values. ok is false
// for a type it cannot populate (an interface, a func, a struct of unexported
// fields it does not know).
func nonZeroValue(t reflect.Type, depth int) (reflect.Value, bool) {
	if depth > 12 {
		return reflect.Value{}, false
	}
	switch t {
	case reflectTimeType:
		return reflect.ValueOf(time.Unix(1700000123, 0).UTC()), true
	case reflectQuantityType:
		return reflect.ValueOf(resource.MustParse("7")), true
	}
	if v, ok := nonZeroScalar(t); ok {
		return v, true
	}
	return nonZeroComposite(t, depth)
}

// nonZeroScalar sets a string, bool or number of type t.
func nonZeroScalar(t reflect.Type) (reflect.Value, bool) {
	v := reflect.New(t).Elem()
	switch {
	case t.Kind() == reflect.String:
		v.SetString("mutated")
	case t.Kind() == reflect.Bool:
		v.SetBool(true)
	case v.CanInt():
		v.SetInt(7)
	case v.CanUint() && t.Kind() != reflect.Uintptr:
		v.SetUint(7)
	case v.CanFloat():
		v.SetFloat(7.5)
	default:
		return v, false
	}
	return v, true
}

// nonZeroComposite builds a pointer, slice, map or struct of type t whose
// elements nonZeroValue can populate. Arrays, channels, funcs, interfaces and
// complex numbers are not used by the Application API: a field of one of those
// kinds fails the test until this builder learns it.
func nonZeroComposite(t reflect.Type, depth int) (reflect.Value, bool) {
	v := reflect.New(t).Elem()
	switch t.Kind() { //nolint:exhaustive // every other kind is unsupported, see above
	case reflect.Pointer:
		elem, ok := nonZeroValue(t.Elem(), depth+1)
		if !ok {
			return v, false
		}
		ptr := reflect.New(t.Elem())
		ptr.Elem().Set(elem)
		return ptr, true
	case reflect.Slice:
		elem, ok := nonZeroValue(t.Elem(), depth+1)
		if !ok {
			return v, false
		}
		slice := reflect.MakeSlice(t, 1, 1)
		slice.Index(0).Set(elem)
		return slice, true
	case reflect.Map:
		key, okKey := nonZeroValue(t.Key(), depth+1)
		elem, okElem := nonZeroValue(t.Elem(), depth+1)
		if !okKey || !okElem {
			return v, false
		}
		m := reflect.MakeMap(t)
		m.SetMapIndex(key, elem)
		return m, true
	case reflect.Struct:
		populated := false
		for i := range t.NumField() {
			if !t.Field(i).IsExported() {
				continue
			}
			if fv, ok := nonZeroValue(t.Field(i).Type, depth+1); ok {
				v.Field(i).Set(fv)
				populated = true
			}
		}
		return v, populated
	default:
		return v, false
	}
}

// assertEveryFieldReconciles sets each exported field of the struct target
// returns, one at a time and except those in ignored, and requires the filter
// to pass the update.
func assertEveryFieldReconciles(t *testing.T, structType reflect.Type, ignored map[string]bool,
	target func(*paprikav1.Application) reflect.Value,
) {
	t.Helper()
	filter := applicationUpdateFilter()
	for i := range structType.NumField() {
		field := structType.Field(i)
		if !field.IsExported() || ignored[field.Name] {
			continue
		}
		t.Run(structType.Name()+"."+field.Name, func(t *testing.T) {
			oldApp := observedApplication()
			newApp := oldApp.DeepCopy()
			newApp.ResourceVersion = "27472718"
			fv := target(newApp).FieldByName(field.Name)
			value, ok := nonZeroValue(field.Type, 0)
			require.True(t, ok, "cannot build a value of %s for %s.%s; teach nonZeroValue this type", field.Type, structType.Name(), field.Name)
			require.False(t, equality.Semantic.DeepEqual(fv.Interface(), value.Interface()), "the mutation must change %s", field.Name)
			fv.Set(value)
			require.True(t, filter.Update(event.UpdateEvent{ObjectOld: oldApp, ObjectNew: newApp}),
				"an update changing only %s.%s was dropped; add it to the ignored fields only on purpose", structType.Name(), field.Name)
		})
	}
}

func TestApplicationUpdateFilterReconcilesEveryOtherField(t *testing.T) {
	t.Parallel()

	assertEveryFieldReconciles(t, reflect.TypeOf(metav1.ObjectMeta{}), ignoredObjectMetaFields,
		func(a *paprikav1.Application) reflect.Value { return reflect.ValueOf(&a.ObjectMeta).Elem() })
	assertEveryFieldReconciles(t, reflect.TypeOf(paprikav1.ApplicationSpec{}), nil,
		func(a *paprikav1.Application) reflect.Value { return reflect.ValueOf(&a.Spec).Elem() })
	assertEveryFieldReconciles(t, reflect.TypeOf(paprikav1.ApplicationStatus{}), nil,
		func(a *paprikav1.Application) reflect.Value { return reflect.ValueOf(&a.Status).Elem() })
	assertEveryFieldReconciles(t, reflect.TypeOf(paprikav1.HealthCheckResult{}), ignoredHealthCheckResultFields,
		func(a *paprikav1.Application) reflect.Value { return reflect.ValueOf(&a.Status.HealthChecks[0]).Elem() })
	assertEveryFieldReconciles(t, reflect.TypeOf(paprikav1.ApplicationDeploymentObservation{}), ignoredDeploymentObservationFields,
		func(a *paprikav1.Application) reflect.Value {
			return reflect.ValueOf(a.Status.DeploymentObservation).Elem()
		})
}

// The converse: each ignored field changed on its own is dropped, so the
// ignore list holds exactly what the filter ignores.
func TestApplicationUpdateFilterDropsEachIgnoredField(t *testing.T) {
	t.Parallel()

	filter := applicationUpdateFilter()
	cases := map[string]struct {
		structType reflect.Type
		ignored    map[string]bool
		target     func(*paprikav1.Application) reflect.Value
	}{
		"HealthCheckResult": {reflect.TypeOf(paprikav1.HealthCheckResult{}), ignoredHealthCheckResultFields,
			func(a *paprikav1.Application) reflect.Value { return reflect.ValueOf(&a.Status.HealthChecks[0]).Elem() }},
		"ApplicationDeploymentObservation": {reflect.TypeOf(paprikav1.ApplicationDeploymentObservation{}), ignoredDeploymentObservationFields,
			func(a *paprikav1.Application) reflect.Value {
				return reflect.ValueOf(a.Status.DeploymentObservation).Elem()
			}},
		"ObjectMeta": {reflect.TypeOf(metav1.ObjectMeta{}), map[string]bool{"ManagedFields": true},
			func(a *paprikav1.Application) reflect.Value { return reflect.ValueOf(&a.ObjectMeta).Elem() }},
	}
	for name, tc := range cases {
		for field := range tc.ignored {
			t.Run(name+"."+field, func(t *testing.T) {
				oldApp := observedApplication()
				newApp := oldApp.DeepCopy()
				newApp.ResourceVersion = "27472718"
				fv := tc.target(newApp).FieldByName(field)
				require.True(t, fv.IsValid(), "%s has no field %s", name, field)
				value, ok := nonZeroValue(fv.Type(), 0)
				require.True(t, ok)
				fv.Set(value)
				require.False(t, filter.Update(event.UpdateEvent{ObjectOld: oldApp, ObjectNew: newApp}),
					"an update changing only %s.%s must be dropped", name, field)
			})
		}
	}
}

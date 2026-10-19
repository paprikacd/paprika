package satellite

import (
	"encoding/json"
	"reflect"
	"strings"
	"sync"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/cache"
)

func healthyDeployment(namespace, name, application string) *appsv1.Deployment {
	replicas := int32(1)
	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace, UID: types.UID(namespace + "/" + name), Generation: 1, Labels: map[string]string{"app.kubernetes.io/part-of": application}},
		Spec:       appsv1.DeploymentSpec{Replicas: &replicas},
		Status:     appsv1.DeploymentStatus{ObservedGeneration: 1, UpdatedReplicas: 1, AvailableReplicas: 1, ReadyReplicas: 1},
	}
}

func TestObservationGroupingInventoryAndPaprikaPrecedence(t *testing.T) {
	state := newObservationState()
	state.upsert(healthyDeployment("prod", "frontend", "shop"))
	backend := healthyDeployment("prod", "backend", "shop")
	backend.Status.AvailableReplicas = 0
	state.upsert(backend)
	state.upsert(healthyDeployment("test", "frontend", "shop"))
	state.upsert(&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "node", Labels: map[string]string{"topology.kubernetes.io/zone": "zone-a"}}, Status: corev1.NodeStatus{NodeInfo: corev1.NodeSystemInfo{KubeletVersion: "v1.36"}, Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}}})
	state.upsert(&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "pod", Namespace: "prod"}, Status: corev1.PodStatus{Phase: corev1.PodRunning}})
	state.upsert(&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "prod"}})
	inventory, apps := state.snapshot()
	if len(apps) != 2 {
		t.Fatalf("namespace isolation lost: %#v", apps)
	}
	if app := apps["prod/shop"]; app.ResourceCount != 2 || app.Health != "Degraded" || app.SyncKnown {
		t.Fatalf("workload aggregation = %#v", app)
	}
	if inventory.NodeCount != 1 || inventory.ReadyNodeCount != 1 || inventory.PodCount != 1 || inventory.RunningPodCount != 1 || inventory.NamespaceCount != 1 {
		t.Fatalf("inventory = %#v", inventory)
	}
	if len(inventory.Zones) != 1 || inventory.Zones[0] != "zone-a" {
		t.Fatalf("topology = %#v", inventory)
	}
	state.upsert(&unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": "shop", "namespace": "prod", "labels": map[string]any{"app.paprika.io/identity": "store"}},
		"spec":     map[string]any{"project": "sales"},
		"status":   map[string]any{"health": "Healthy", "phase": "Healthy", "outOfSync": int64(3), "sourceRevision": "abcd", "resources": []any{map[string]any{"kind": "Deployment"}}},
	}})
	_, apps = state.snapshot()
	app := apps["prod/shop"]
	if app.Health != "Healthy" || app.OutOfSync != 3 || !app.SyncKnown || app.ResourceCount != 1 || app.Project != "sales" || app.Identity != "store" || app.SourceRevision != "abcd" {
		t.Fatalf("Paprika projection = %#v", app)
	}
}

func TestApplicationSyncKnownRequiresAComparison(t *testing.T) {
	for _, test := range []struct {
		name   string
		status map[string]any
		want   bool
	}{
		{name: "pending", status: map[string]any{"phase": "Pending"}, want: false},
		{name: "synced", status: map[string]any{"synced": true}, want: true},
		{name: "drift", status: map[string]any{"outOfSync": int64(2)}, want: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			app := &unstructured.Unstructured{Object: map[string]any{"metadata": map[string]any{"name": "app", "namespace": "prod"}, "status": test.status}}
			compact, err := compactObject(app)
			if err != nil {
				t.Fatal(err)
			}
			observation, _ := projectObject(compact)
			if observation.app.SyncKnown != test.want {
				t.Fatalf("syncKnown = %v, want %v", observation.app.SyncKnown, test.want)
			}
		})
	}
}

//nolint:gosec // Deliberate credential sentinels verify that caches never retain secret fields.
func TestProjectionNeverRetainsSpecCredentialsOrAnnotations(t *testing.T) {
	workload := healthyDeployment("prod", "app", "app")
	workload.Annotations = map[string]string{"sensitive": "annotation-secret"}
	workload.Labels["secret"] = "label-secret"
	workload.Spec.Template.Spec.Containers = []corev1.Container{{Name: "app", Env: []corev1.EnvVar{{Name: "TOKEN", Value: "environment-secret"}}}}
	application := &unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": "app", "namespace": "prod", "annotations": map[string]any{"token": "annotation-secret"}},
		"spec":     map[string]any{"source": map[string]any{"url": "https://user:source-secret@example.com"}, "project": "sales"},
		"status":   map[string]any{"health": "Healthy", "resources": []any{map[string]any{"message": "status-secret"}}},
	}}
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "app", Annotations: map[string]string{"token": "annotation-secret"}}, Spec: corev1.PodSpec{Containers: workload.Spec.Template.Spec.Containers}}
	for _, object := range []any{workload, application, pod} {
		compact, err := compactObject(object)
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(compact)
		if err != nil {
			t.Fatal(err)
		}
		for _, secret := range []string{"annotation-secret", "label-secret", "environment-secret", "source-secret", "status-secret"} {
			if strings.Contains(string(encoded), secret) {
				t.Fatalf("cache retained %q in %T", secret, object)
			}
		}
	}
}

func TestObservationDeletesHandleTombstoneAndRecreatedUID(t *testing.T) {
	state := newObservationState()
	old := healthyDeployment("prod", "app", "app")
	newObject := old.DeepCopy()
	newObject.UID = "replacement"
	state.upsert(old)
	state.upsert(newObject)
	state.delete(cache.DeletedFinalStateUnknown{Obj: old})
	_, apps := state.snapshot()
	if len(apps) != 1 {
		t.Fatal("old tombstone deleted replacement instance")
	}
	state.delete(cache.DeletedFinalStateUnknown{Obj: newObject})
	_, apps = state.snapshot()
	if len(apps) != 0 {
		t.Fatalf("tombstone was not removed: %#v", apps)
	}
}

func TestApplicationDeltaCoalescesIdentityChange(t *testing.T) {
	previous := map[string]Application{"prod/app": {Namespace: "prod", Name: "app", Identity: "old"}, "prod/removed": {Namespace: "prod", Name: "removed"}}
	current := map[string]Application{"prod/app": {Namespace: "prod", Name: "app", Identity: "new"}}
	changed, deleted := applicationDelta(previous, current)
	if len(changed) != 1 || changed[0].Identity != "new" || len(deleted) != 1 || deleted[0] != "prod/removed" {
		t.Fatalf("delta = %#v, %#v", changed, deleted)
	}
}

func TestWorkloadRolloutHealthRemainsAccurate(t *testing.T) {
	two, one := int32(2), int32(1)
	stateful := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: "prod", Generation: 2},
		Spec:       appsv1.StatefulSetSpec{Replicas: &two},
		Status:     appsv1.StatefulSetStatus{ObservedGeneration: 2, CurrentReplicas: 2, ReadyReplicas: 2, UpdatedReplicas: 1},
	}
	project := func(object any) Application {
		t.Helper()
		compact, err := compactObject(object)
		if err != nil {
			t.Fatal(err)
		}
		observation, _ := projectObject(compact)
		return observation.app
	}
	if app := project(stateful); app.Health != "Progressing" {
		t.Fatalf("old ready replicas masked pending update: %#v", app)
	}
	stateful.Spec.UpdateStrategy.RollingUpdate = &appsv1.RollingUpdateStatefulSetStrategy{Partition: &one}
	if app := project(stateful); app.Health != "Healthy" {
		t.Fatalf("partitioned rollout did not converge: %#v", app)
	}
	stateful.Spec.UpdateStrategy.Type = appsv1.OnDeleteStatefulSetStrategyType
	stateful.Status.UpdatedReplicas = 0
	if app := project(stateful); app.Health != "Healthy" {
		t.Fatalf("OnDelete rollout requires unwanted replacement: %#v", app)
	}
	deployment := healthyDeployment("prod", "web", "shop")
	deployment.Status.Conditions = []appsv1.DeploymentCondition{{Type: appsv1.DeploymentProgressing, Status: corev1.ConditionFalse, Reason: "ProgressDeadlineExceeded"}}
	if app := project(deployment); app.Health != "Degraded" {
		t.Fatalf("failed rollout masked by ready old replicas: %#v", app)
	}
}

func TestObservationSnapshotsReuseUnchangedStateAndRemainImmutable(t *testing.T) {
	state := newObservationState()
	workload := healthyDeployment("prod", "web", "shop")
	node := &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "node", UID: "node", Labels: map[string]string{"topology.kubernetes.io/zone": "zone-a"}}, Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}}}
	state.upsert(workload)
	state.upsert(node)
	firstInventory, firstApps := state.snapshot()
	mapPointer := reflect.ValueOf(firstApps).Pointer()
	workload.ResourceVersion = "later"
	workload.Annotations = map[string]string{"irrelevant": "changed"}
	workload.Spec.Template.Spec.Containers = []corev1.Container{{Name: "web", Image: "later"}}
	state.upsert(workload)
	node.ResourceVersion = "later"
	node.Status.Conditions[0].LastHeartbeatTime = metav1.Now()
	state.upsert(node)
	secondInventory, secondApps := state.snapshot()
	if reflect.ValueOf(secondApps).Pointer() != mapPointer || &firstInventory.Zones[0] != &secondInventory.Zones[0] {
		t.Fatal("unreported watch changes rebuilt an unchanged cluster snapshot")
	}
	workload.Status.AvailableReplicas = 0
	state.upsert(workload)
	_, changedApps := state.snapshot()
	if reflect.ValueOf(changedApps).Pointer() == mapPointer || changedApps["prod/shop"].Health != "Degraded" {
		t.Fatal("visible health change did not invalidate cached state")
	}
	if firstApps["prod/shop"].Health != "Healthy" {
		t.Fatal("cached snapshot mutated a previously acknowledged baseline")
	}
	node.Labels["topology.kubernetes.io/zone"] = "zone-b"
	node.Status.Conditions[0].Status = corev1.ConditionFalse
	state.upsert(node)
	changedInventory, _ := state.snapshot()
	if changedInventory.ReadyNodeCount != 0 || changedInventory.Zones[0] != "zone-b" || firstInventory.ReadyNodeCount != 1 || firstInventory.Zones[0] != "zone-a" {
		t.Fatal("inventory update reused or mutated an old snapshot")
	}
	state.delete(workload)
	_, deletedApps := state.snapshot()
	if len(deletedApps) != 0 || len(firstApps) != 1 {
		t.Fatal("deletion did not install an independent snapshot")
	}
}

func TestObservationCacheSupportsConcurrentWatchesAndSnapshots(t *testing.T) {
	state := newObservationState()
	state.upsert(healthyDeployment("prod", "web", "shop"))
	var group sync.WaitGroup
	for worker := 0; worker < 4; worker++ {
		group.Add(1)
		go func(worker int) {
			defer group.Done()
			if worker == 0 {
				workload := healthyDeployment("prod", "web", "shop")
				for iteration := 0; iteration < 200; iteration++ {
					workload.Status.AvailableReplicas = int32(iteration % 2)
					state.upsert(workload)
				}
				return
			}
			for iteration := 0; iteration < 200; iteration++ {
				_, apps := state.snapshot()
				if len(apps) != 1 {
					t.Error("concurrent snapshot lost observed application")
				}
				for _, app := range apps {
					if app.Health != "Healthy" && app.Health != "Degraded" {
						t.Error("concurrent snapshot mixed health states")
					}
				}
			}
		}(worker)
	}
	group.Wait()
}

func TestNativeWorkloadGroupingFailsClosedForAssociationConflicts(t *testing.T) {
	for _, test := range []struct {
		name                      string
		projects                  []string
		identities                []string
		wantPresent               bool
		wantProject, wantIdentity string
	}{
		{name: "different projects", projects: []string{"sales", "payments", "sales"}},
		{name: "default is a separate project", projects: []string{"", "sales"}},
		{name: "empty and explicit default agree", projects: []string{"", "default"}, wantPresent: true, wantProject: "default"},
		{name: "same project agrees", projects: []string{"sales", "sales"}, wantPresent: true, wantProject: "sales"},
		{name: "different identities", identities: []string{"store", "billing", "store"}},
		{name: "empty identity does not imply a different explicit identity", identities: []string{"", "store"}},
		{name: "empty and name identity agree", identities: []string{"", "shop"}, wantPresent: true, wantProject: "default"},
		{name: "same explicit identity agrees", identities: []string{"store", "store"}, wantPresent: true, wantProject: "default", wantIdentity: "store"},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := newObservationState()
			count := max(len(test.projects), len(test.identities))
			for index := 0; index < count; index++ {
				component := healthyDeployment("prod", "component-"+string(rune('a'+index)), "shop")
				if index < len(test.projects) {
					component.Labels["app.paprika.io/project"] = test.projects[index]
				}
				if index < len(test.identities) {
					component.Labels["app.paprika.io/identity"] = test.identities[index]
				}
				if index == 1 {
					component.Status.AvailableReplicas = 0
				}
				state.upsert(component)
			}
			_, apps := state.snapshot()
			app, present := apps["prod/shop"]
			if present != test.wantPresent {
				t.Fatalf("ambiguous group visibility = %v, want %v; applications %#v", present, test.wantPresent, apps)
			}
			if present && (app.Project != test.wantProject || app.Identity != test.wantIdentity || app.ResourceCount != positiveCount(int64(count)) || app.Health != "Degraded") {
				t.Fatalf("compatible group = %#v", app)
			}
			if !present && len(apps) != 0 {
				t.Fatalf("conflicting components escaped through another group: %#v", apps)
			}
		})
	}
}

func TestPaprikaApplicationOverridesConflictingNativeGroup(t *testing.T) {
	state := newObservationState()
	for index, project := range []string{"sales", "payments"} {
		component := healthyDeployment("prod", "component-"+string(rune('a'+index)), "shop")
		component.Labels["app.paprika.io/project"] = project
		component.Labels["app.paprika.io/identity"] = project
		component.Status.AvailableReplicas = 0
		state.upsert(component)
	}
	_, before := state.snapshot()
	if len(before) != 0 {
		t.Fatal("conflicting native group was not suppressed")
	}
	state.upsert(&unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": "shop", "namespace": "prod", "labels": map[string]any{"app.paprika.io/identity": "authoritative"}},
		"spec":     map[string]any{"project": "governed"},
		"status":   map[string]any{"health": "Healthy", "phase": "Healthy", "synced": true, "resources": []any{map[string]any{"kind": "Deployment"}}},
	}})
	_, apps := state.snapshot()
	app, present := apps["prod/shop"]
	if !present || len(apps) != 1 || app.Project != "governed" || app.Identity != "authoritative" || app.Health != "Healthy" || app.ResourceCount != 1 || !app.SyncKnown {
		t.Fatalf("native conflict changed authoritative application status: %#v", apps)
	}
	state.clearApplications()
	_, apps = state.snapshot()
	if len(apps) != 0 {
		t.Fatalf("losing authoritative CR exposed conflicting native state: %#v", apps)
	}
}

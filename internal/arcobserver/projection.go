package arcobserver

import (
	"sort"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Observation is the entire outbound payload. Raw objects, logs, job titles,
// repositories, service accounts and credential metadata cannot be serialized.
type Observation struct {
	ObservedAt      time.Time `json:"observedAt"`
	State           string    `json:"state"`
	ControllerReady bool      `json:"controllerReady"`
	ListenerReady   bool      `json:"listenerReady"`
	Workers         int       `json:"workers"`
	Busy            int       `json:"busy"`
	Nodes           []string  `json:"nodes,omitempty"`
}

func number(o *unstructured.Unstructured, fields ...string) int64 {
	v, _, _ := unstructured.NestedInt64(o.Object, fields...)
	return v
}
func str(o *unstructured.Unstructured, fields ...string) string {
	v, _, _ := unstructured.NestedString(o.Object, fields...)
	return v
}
func belongs(o *unstructured.Unstructured, namespace, pool string) bool {
	return o.GetNamespace() == namespace && o.GetLabels()[scaleSetLabel] == pool
}
func terminal(phase string) bool { return phase == "Succeeded" || phase == "Failed" }
func readyPod(o *unstructured.Unstructured) bool {
	if o.GetDeletionTimestamp() != nil || str(o, "status", "phase") != "Running" {
		return false
	}
	conditions, _, _ := unstructured.NestedSlice(o.Object, "status", "conditions")
	for _, c := range conditions {
		m, ok := c.(map[string]any)
		if ok && m["type"] == "Ready" && m["status"] == "True" {
			return true
		}
	}
	return false
}

func listenerOwned(o *unstructured.Unstructured) bool {
	for _, ref := range o.GetOwnerReferences() {
		if ref.Kind == "AutoscalingListener" && ref.APIVersion == "actions.github.com/v1alpha1" && ref.UID != "" && ref.Controller != nil && *ref.Controller {
			return true
		}
	}
	return false
}

// Project unions live reservations and surviving execution pods. ARC's ER
// phase Running means assigned work; Pod phase Running alone does not.
// A missing or partial read returns no sample, allowing the previous one to expire.
func Project(s Source, snap Snapshot, now time.Time) (Observation, error) {
	if !snap.Complete || snap.ObservedAt.IsZero() || now.Sub(snap.ObservedAt) > ReadDeadline || snap.ObservedAt.After(now) || snap.RunnerSet == nil || snap.Controller == nil {
		return Observation{}, ErrIncomplete
	}
	rs := snap.RunnerSet
	min, _, minErr := unstructured.NestedInt64(rs.Object, "spec", "minRunners")
	max, hasMax, err := unstructured.NestedInt64(rs.Object, "spec", "maxRunners")
	if rs.GetName() != s.PoolName || rs.GetNamespace() != s.RunnerNamespace || minErr != nil || min != s.ExpectedMinRunners || err != nil || !hasMax || max != s.ExpectedMaxRunners || snap.SystemPods == nil || snap.RunnerPods == nil || snap.EphemeralRunners == nil {
		return Observation{}, ErrIncomplete
	}
	o := Observation{ObservedAt: snap.ObservedAt, State: "healthy"}
	d := snap.Controller
	desired := int64(1)
	if n, ok, _ := unstructured.NestedInt64(d.Object, "spec", "replicas"); ok {
		desired = n
	}
	o.ControllerReady = d.GetDeletionTimestamp() == nil && d.GetName() == s.ControllerDeployment && d.GetNamespace() == s.SystemNamespace && desired > 0 && number(d, "status", "observedGeneration") >= d.GetGeneration() && number(d, "status", "readyReplicas") >= desired && number(d, "status", "availableReplicas") >= desired
	for i := range snap.SystemPods {
		p := &snap.SystemPods[i]
		if belongs(p, s.SystemNamespace, s.PoolName) && p.GetLabels()["actions.github.com/scale-set-namespace"] == s.RunnerNamespace && p.GetLabels()["app.kubernetes.io/component"] == "runner-scale-set-listener" && listenerOwned(p) && readyPod(p) {
			o.ListenerReady = true
		}
	}
	starting, inaccessible := !o.ControllerReady || !o.ListenerReady, false
	runners := map[string]*unstructured.Unstructured{}
	for i := range snap.EphemeralRunners {
		r := &snap.EphemeralRunners[i]
		if !belongs(r, s.RunnerNamespace, s.PoolName) {
			return Observation{}, ErrIncomplete
		}
		uid := string(r.GetUID())
		if uid == "" || runners[uid] != nil {
			return Observation{}, ErrIncomplete
		}
		runners[uid] = r
	}
	workers, busy, nodes := map[string]bool{}, map[string]bool{}, map[string]bool{}
	podOwners, podUIDs := map[string]int{}, map[string]bool{}
	for i := range snap.RunnerPods {
		p := &snap.RunnerPods[i]
		if !belongs(p, s.RunnerNamespace, s.PoolName) {
			return Observation{}, ErrIncomplete
		}
		if terminal(str(p, "status", "phase")) {
			continue
		}
		uid := string(p.GetUID())
		if uid == "" || podUIDs[uid] {
			return Observation{}, ErrIncomplete
		}
		podUIDs[uid] = true
		owner, owners := "", 0
		for _, ref := range p.GetOwnerReferences() {
			if ref.Kind == "EphemeralRunner" && ref.APIVersion == "actions.github.com/v1alpha1" && ref.Controller != nil && *ref.Controller {
				owner, owners = string(ref.UID), owners+1
			}
		}
		if owners != 1 || runners[owner] == nil {
			inaccessible = true
			workers["pod:"+uid] = true
		} else {
			workers["runner:"+owner] = true
			podOwners[owner]++
			if podOwners[owner] > 1 {
				inaccessible = true
				workers["extra:"+uid] = true
			}
		}
		if node := str(p, "spec", "nodeName"); node != "" {
			if !nodeName.MatchString(node) {
				return Observation{}, ErrIncomplete
			}
			nodes[node] = true
		}
		if str(p, "status", "phase") == "Pending" {
			starting = true
		}
	}
	for uid, r := range runners {
		phase := str(r, "status", "phase")
		if !terminal(phase) && phase != "Outdated" {
			workers["runner:"+uid] = true
		}
		switch phase {
		case "Running":
			busy["runner:"+uid] = true
		case "Pending":
			ready, _, _ := unstructured.NestedBool(r.Object, "status", "ready")
			starting = starting || !ready
		case "Succeeded", "Failed", "Outdated":
		default:
			inaccessible = true
		}
	}
	if len(nodes) > 32 || len(workers) > 10000 {
		return Observation{}, ErrIncomplete
	}
	o.Workers, o.Busy = len(workers), len(busy)
	for node := range nodes {
		o.Nodes = append(o.Nodes, node)
	}
	sort.Strings(o.Nodes)
	if inaccessible {
		o.State = "inaccessible"
	} else if rs.GetDeletionTimestamp() != nil {
		o.State = "draining"
	} else if starting {
		o.State = "starting"
	}
	return o, nil
}

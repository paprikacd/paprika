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
	v, _, err := unstructured.NestedInt64(o.Object, fields...)
	if err != nil {
		return 0
	}
	return v
}
func str(o *unstructured.Unstructured, fields ...string) string {
	v, _, err := unstructured.NestedString(o.Object, fields...)
	if err != nil {
		return ""
	}
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
	conditions, _, err := unstructured.NestedSlice(o.Object, "status", "conditions")
	if err != nil {
		return false
	}
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
// Missing or partial reads never renew the receiver's previous sample.
func Project(s *Source, snap *Snapshot, now time.Time) (Observation, error) {
	if !validSnapshot(s, snap, now) {
		return Observation{}, ErrIncomplete
	}
	inventory := newWorkerInventory()
	inventory.controllerReady = controllerReady(s, snap.Controller)
	inventory.listenerReady = listenerReady(s, snap.SystemPods)
	inventory.starting = !inventory.controllerReady || !inventory.listenerReady
	if err := inventory.recordRunners(s, snap.EphemeralRunners); err != nil {
		return Observation{}, err
	}
	for i := range snap.RunnerPods {
		if err := inventory.recordPod(s, &snap.RunnerPods[i]); err != nil {
			return Observation{}, err
		}
	}
	inventory.recordReservations()
	return inventory.observation(snap)
}

func validSnapshot(s *Source, snap *Snapshot, now time.Time) bool {
	if !snap.Complete || snap.ObservedAt.IsZero() || now.Sub(snap.ObservedAt) > ReadDeadline || snap.ObservedAt.After(now) {
		return false
	}
	if snap.RunnerSet == nil || snap.Controller == nil || snap.SystemPods == nil || snap.RunnerPods == nil || snap.EphemeralRunners == nil {
		return false
	}
	return runnerSetMatches(s, snap.RunnerSet)
}

func runnerSetMatches(s *Source, rs *unstructured.Unstructured) bool {
	if rs.GetName() != s.PoolName || rs.GetNamespace() != s.RunnerNamespace {
		return false
	}
	minimum, _, err := unstructured.NestedInt64(rs.Object, "spec", "minRunners")
	if err != nil || minimum != s.ExpectedMinRunners {
		return false
	}
	maximum, present, err := unstructured.NestedInt64(rs.Object, "spec", "maxRunners")
	return err == nil && present && maximum == s.ExpectedMaxRunners
}

func controllerReady(s *Source, d *unstructured.Unstructured) bool {
	desired := int64(1)
	n, present, err := unstructured.NestedInt64(d.Object, "spec", "replicas")
	if err != nil {
		return false
	}
	if present {
		desired = n
	}
	return d.GetDeletionTimestamp() == nil && d.GetName() == s.ControllerDeployment && d.GetNamespace() == s.SystemNamespace && desired > 0 && number(d, "status", "observedGeneration") >= d.GetGeneration() && number(d, "status", "readyReplicas") >= desired && number(d, "status", "availableReplicas") >= desired
}

func listenerReady(s *Source, pods []unstructured.Unstructured) bool {
	for i := range pods {
		p := &pods[i]
		if belongs(p, s.SystemNamespace, s.PoolName) && p.GetLabels()["actions.github.com/scale-set-namespace"] == s.RunnerNamespace && p.GetLabels()["app.kubernetes.io/component"] == "runner-scale-set-listener" && listenerOwned(p) && readyPod(p) {
			return true
		}
	}
	return false
}

type workerInventory struct {
	runners                        map[string]*unstructured.Unstructured
	workers, busy, nodes, podUIDs  map[string]bool
	podOwners                      map[string]int
	starting, inaccessible         bool
	controllerReady, listenerReady bool
}

func newWorkerInventory() *workerInventory {
	return &workerInventory{runners: map[string]*unstructured.Unstructured{}, workers: map[string]bool{}, busy: map[string]bool{}, nodes: map[string]bool{}, podUIDs: map[string]bool{}, podOwners: map[string]int{}}
}

func (w *workerInventory) recordRunners(s *Source, runners []unstructured.Unstructured) error {
	for i := range runners {
		r := &runners[i]
		if !belongs(r, s.RunnerNamespace, s.PoolName) {
			return ErrIncomplete
		}
		uid := string(r.GetUID())
		if uid == "" || w.runners[uid] != nil {
			return ErrIncomplete
		}
		w.runners[uid] = r
	}
	return nil
}

func (w *workerInventory) recordPod(s *Source, p *unstructured.Unstructured) error {
	if !belongs(p, s.RunnerNamespace, s.PoolName) {
		return ErrIncomplete
	}
	if terminal(str(p, "status", "phase")) {
		return nil
	}
	uid := string(p.GetUID())
	if uid == "" || w.podUIDs[uid] {
		return ErrIncomplete
	}
	w.podUIDs[uid] = true
	w.recordPodOwner(p, uid)
	if err := w.recordNode(p); err != nil {
		return err
	}
	if str(p, "status", "phase") == "Pending" {
		w.starting = true
	}
	return nil
}

func (w *workerInventory) recordPodOwner(p *unstructured.Unstructured, uid string) {
	owner, owners := "", 0
	for _, ref := range p.GetOwnerReferences() {
		if ref.Kind == "EphemeralRunner" && ref.APIVersion == "actions.github.com/v1alpha1" && ref.Controller != nil && *ref.Controller {
			owner, owners = string(ref.UID), owners+1
		}
	}
	if owners != 1 || w.runners[owner] == nil {
		w.inaccessible = true
		w.workers["pod:"+uid] = true
		return
	}
	w.workers["runner:"+owner] = true
	w.podOwners[owner]++
	if w.podOwners[owner] > 1 {
		w.inaccessible = true
		w.workers["extra:"+uid] = true
	}
}

func (w *workerInventory) recordNode(p *unstructured.Unstructured) error {
	node := str(p, "spec", "nodeName")
	if node == "" {
		return nil
	}
	if !nodeName.MatchString(node) {
		return ErrIncomplete
	}
	w.nodes[node] = true
	return nil
}

func (w *workerInventory) recordReservations() {
	for uid, r := range w.runners {
		phase := str(r, "status", "phase")
		if !terminal(phase) && phase != "Outdated" {
			w.workers["runner:"+uid] = true
		}
		switch phase {
		case "Running":
			w.busy["runner:"+uid] = true
		case "Pending":
			ready, _, err := unstructured.NestedBool(r.Object, "status", "ready")
			w.starting = w.starting || err != nil || !ready
		case "Succeeded", "Failed", "Outdated":
		default:
			w.inaccessible = true
		}
	}
}

func (w *workerInventory) observation(snap *Snapshot) (Observation, error) {
	if len(w.nodes) > 32 || len(w.workers) > 10000 {
		return Observation{}, ErrIncomplete
	}
	o := Observation{ObservedAt: snap.ObservedAt, State: "healthy", ControllerReady: w.controllerReady, ListenerReady: w.listenerReady, Workers: len(w.workers), Busy: len(w.busy)}
	for node := range w.nodes {
		o.Nodes = append(o.Nodes, node)
	}
	sort.Strings(o.Nodes)
	if w.inaccessible {
		o.State = "inaccessible"
	} else if snap.RunnerSet.GetDeletionTimestamp() != nil {
		o.State = "draining"
	} else if w.starting {
		o.State = "starting"
	}
	return o, nil
}

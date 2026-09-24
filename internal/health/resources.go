// Package health provides CEL-based health evaluation with HTTP probe support.
package health

import (
	"context"
	"fmt"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	netv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// ResourceHealthChecker evaluates the health of Kubernetes resources.
type ResourceHealthChecker struct {
	client.Client
}

// NewResourceHealthChecker creates a new resource health checker.
func NewResourceHealthChecker(c client.Client) *ResourceHealthChecker {
	return &ResourceHealthChecker{Client: c}
}

// Check evaluates the health of a resource by kind.
func (r *ResourceHealthChecker) Check(ctx context.Context, kind, name, namespace string) paprikav1.ResourceHealth {
	switch kind {
	case "Deployment":
		return r.checkDeployment(ctx, name, namespace)
	case "Service":
		return r.checkService(ctx, name, namespace)
	case "Ingress":
		return r.checkIngress(ctx, name, namespace)
	case "CronJob":
		return r.checkCronJob(ctx, name, namespace)
	default:
		// ConfigMap, Secret and every other kind go through the generic path:
		// it verifies existence (the old code reported ConfigMaps Healthy
		// without ever fetching them) and assesses status when there is one.
		return r.checkGeneric(ctx, kind, name, namespace)
	}
}

// genericGetTimeout bounds a single generic resource fetch. The manager's
// client is informer-backed, so a kind the manager may not watch would
// otherwise block on informer sync for the whole reconcile.
const genericGetTimeout = 5 * time.Second

// checkGeneric resolves the kind through the RESTMapper and evaluates the
// live object with AssessObject. It exists for callers that cannot reuse a
// diff snapshot; the reconcile path prefers AssessObject on the objects the
// diff engine already fetched.
func (r *ResourceHealthChecker) checkGeneric(ctx context.Context, kind, name, namespace string) paprikav1.ResourceHealth {
	base := paprikav1.ResourceHealth{Kind: kind, Name: name, Namespace: namespace}

	mapping, err := r.RESTMapper().RESTMapping(schema.GroupKind{Kind: kind})
	if err != nil {
		base.Health = "Unknown"
		base.Message = "no API mapping for kind " + kind
		return base
	}

	obj := &unstructured.Unstructured{}
	obj.SetGroupVersionKind(mapping.GroupVersionKind)
	key := types.NamespacedName{Name: name, Namespace: namespace}
	if mapping.Scope.Name() == apimeta.RESTScopeNameRoot {
		key.Namespace = ""
	}

	getCtx, cancel := context.WithTimeout(ctx, genericGetTimeout)
	defer cancel()
	switch err := r.Get(getCtx, key, obj); {
	case err == nil:
		return AssessObject(obj)
	case apierrors.IsNotFound(err):
		base.Health = "Missing"
		base.Message = err.Error()
	default:
		base.Health = "Unknown"
		base.Message = err.Error()
	}
	return base
}

// negativeConditionTypes mark a resource definitively failed when True. They
// are checked before positive conditions so a stale Ready=True cannot mask a
// fresh Failed=True.
var negativeConditionTypes = map[string]bool{
	"Failed": true, "Degraded": true, "Error": true,
	"Stalled": true, "ReplicaFailure": true, "Unhealthy": true,
}

// positiveConditionTypes report readiness when True. When such a condition is
// False the resource is treated as still working toward readiness
// (Progressing); the condition's message is preserved for the operator.
var positiveConditionTypes = []string{
	"Ready", "Available", "Established", "Complete", "Synced",
	"Accepted", "Programmed", "ResolvedRefs", "Reconciled", "Initialized",
}

// existenceOnlyKinds carry no meaningful status — once they exist they are as
// healthy as they can be, and reporting Unknown for them only adds noise.
var existenceOnlyKinds = map[string]bool{
	"Service": true, "Ingress": true, "ConfigMap": true, "Secret": true,
	"ServiceAccount": true, "Role": true, "RoleBinding": true,
	"ClusterRole": true, "ClusterRoleBinding": true, "NetworkPolicy": true,
	"PodDisruptionBudget": true, "ReferenceGrant": true, "LimitRange": true,
	"ResourceQuota": true, "EndpointSlice": true, "Endpoints": true,
}

// AssessObject evaluates the health of a live object without any API calls —
// it is the single source of truth for per-resource health. Kind-specific
// rules run first (workload replica counts, CronJob suspension, Job
// completion), then a generic scan of status.conditions, replica counters and
// status.phase. A resource that exists and reports no failure signal is
// Healthy: existence is the only thing most resources can truthfully claim.
//
//nolint:cyclop // per-kind and per-signal branches are the health matrix.
func AssessObject(obj *unstructured.Unstructured) paprikav1.ResourceHealth {
	base := resourceHealthBase(obj)

	if obj.GetDeletionTimestamp() != nil {
		base.Health = "Progressing"
		base.Message = "terminating"
		return base
	}

	switch obj.GetKind() {
	case "Deployment":
		return assessReplicaHealth(obj,
			[]string{"spec", "replicas"}, []string{"status", "availableReplicas"}, []string{"status", "updatedReplicas"})
	case "StatefulSet", "ReplicaSet":
		return assessReplicaHealth(obj,
			[]string{"spec", "replicas"}, []string{"status", "readyReplicas"}, []string{"status", "updatedReplicas"})
	case "DaemonSet":
		return assessReplicaHealth(obj,
			[]string{"status", "desiredNumberScheduled"}, []string{"status", "numberReady"}, nil)
	case "CronJob":
		if nestedBool(obj.Object, "spec", "suspend") {
			base.Health, base.Message = "Healthy", "cronjob suspended"
			return base
		}
		if active, found := nestedSlice(obj.Object, "status", "active"); found && len(active) > 0 {
			base.Health, base.Message = "Progressing", fmt.Sprintf("%d active jobs", len(active))
			return base
		}
		base.Health, base.Message = "Healthy", "cronjob scheduled"
		return base
	case "Job":
		if degraded, found := failedCondition(obj); found {
			return degraded
		}
		if result, found := readyCondition(obj); found {
			return result
		}
		if succeeded, _ := nestedInt64(obj.Object, "status", "succeeded"); succeeded > 0 {
			base.Health, base.Message = "Healthy", "job completed"
			return base
		}
		if active, _ := nestedInt64(obj.Object, "status", "active"); active > 0 {
			base.Health, base.Message = "Progressing", fmt.Sprintf("%d active pods", active)
			return base
		}
		base.Health, base.Message = "Progressing", "job has not completed"
		return base
	}

	if existenceOnlyKinds[obj.GetKind()] {
		base.Health = "Healthy"
		base.Message = "resource exists"
		return base
	}

	// Generic path: conditions, then replica counters, then phase.
	if degraded, found := failedCondition(obj); found {
		return degraded
	}
	if result, found := readyCondition(obj); found {
		return result
	}
	if result, found := replicaHealth(obj); found {
		return result
	}
	if result, found := phaseHealth(obj); found {
		return result
	}

	base.Health = "Healthy"
	base.Message = "resource exists"
	return base
}

// resourceHealthBase builds the identity fields every assessment shares.
func resourceHealthBase(obj *unstructured.Unstructured) paprikav1.ResourceHealth {
	return paprikav1.ResourceHealth{
		Kind:      obj.GetKind(),
		Name:      obj.GetName(),
		Namespace: obj.GetNamespace(),
	}
}

// failedCondition reports Degraded when a negative condition is True.
func failedCondition(obj *unstructured.Unstructured) (paprikav1.ResourceHealth, bool) {
	base := resourceHealthBase(obj)
	conditions, found := nestedSlice(obj.Object, "status", "conditions")
	if !found {
		return base, false
	}
	for _, raw := range conditions {
		cond, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		condType, _ := nestedString(cond, "type")
		status, _ := nestedString(cond, "status")
		if negativeConditionTypes[condType] && status == "True" {
			base.Health = "Degraded"
			base.Message = conditionMessage(cond)
			return base, true
		}
	}
	return base, false
}

// readyCondition lets the most significant positive condition present decide:
// True is Healthy, False is still working toward it (Progressing), Unknown is
// Unknown. First-present wins rather than first-True, so a lower-priority
// condition cannot mask a higher-priority rejection (e.g. Programmed=True
// hiding Accepted=False on a route).
func readyCondition(obj *unstructured.Unstructured) (paprikav1.ResourceHealth, bool) {
	base := resourceHealthBase(obj)
	conditions, found := nestedSlice(obj.Object, "status", "conditions")
	if !found {
		return base, false
	}
	byType := make(map[string]map[string]interface{}, len(conditions))
	for _, raw := range conditions {
		if cond, ok := raw.(map[string]interface{}); ok {
			if condType, _ := nestedString(cond, "type"); condType != "" {
				byType[condType] = cond
			}
		}
	}
	for _, condType := range positiveConditionTypes {
		cond, found := byType[condType]
		if !found {
			continue
		}
		status, _ := nestedString(cond, "status")
		switch status {
		case "True":
			base.Health = "Healthy"
		case "Unknown":
			base.Health = "Unknown"
		default:
			base.Health = "Progressing"
		}
		base.Message = conditionMessage(cond)
		return base, true
	}
	return base, false
}

// replicaHealth covers workload kinds outside the dedicated list by reading
// the conventional replica counters — enough to catch "0/3 ready" on a kind
// nobody wrote a check for.
func replicaHealth(obj *unstructured.Unstructured) (paprikav1.ResourceHealth, bool) {
	base := resourceHealthBase(obj)
	desired, found := firstInt64(obj,
		[]string{"spec", "replicas"},
		[]string{"status", "desiredNumberScheduled"},
		[]string{"status", "replicas"},
	)
	if !found {
		return base, false
	}
	ready, _ := firstInt64(obj,
		[]string{"status", "readyReplicas"},
		[]string{"status", "availableReplicas"},
		[]string{"status", "numberReady"},
	)
	if ready < desired {
		base.Health = "Progressing"
	} else {
		base.Health = "Healthy"
	}
	base.Message = fmt.Sprintf("%d/%d replicas ready", ready, desired)
	return base, true
}

// phaseHealth maps the conventional status.phase value for kinds that report
// one (PersistentVolumeClaim, Pod, Namespace-like objects).
func phaseHealth(obj *unstructured.Unstructured) (paprikav1.ResourceHealth, bool) {
	base := resourceHealthBase(obj)
	phase, found := nestedString(obj.Object, "status", "phase")
	if !found || phase == "" {
		return base, false
	}
	switch phase {
	case "Bound", "Succeeded", "Running", "Active", "Ready", "Available", "Healthy", "Provisioned":
		base.Health = "Healthy"
	case "Failed", "Lost", "Error", "CrashLoopBackOff":
		base.Health = "Degraded"
	default:
		base.Health = "Progressing"
	}
	base.Message = "phase " + phase
	return base, true
}

// assessReplicaHealth compares a desired-replica count against the ready and
// updated counters, matching the wording the typed Deployment check used.
func assessReplicaHealth(obj *unstructured.Unstructured, desiredPath, readyPath, updatedPath []string) paprikav1.ResourceHealth {
	base := resourceHealthBase(obj)
	desired, found := nestedInt64(obj.Object, desiredPath...)
	if !found {
		// Kubernetes defaults spec.replicas to 1; an explicit 0 means the
		// workload was scaled down on purpose and is healthy at zero.
		desired = 1
	}
	ready, _ := nestedInt64(obj.Object, readyPath...)
	if ready < desired {
		base.Health = "Progressing"
		base.Message = fmt.Sprintf("%d/%d replicas available", ready, desired)
		return base
	}
	if updatedPath != nil {
		if updated, _ := nestedInt64(obj.Object, updatedPath...); updated < desired {
			base.Health = "Progressing"
			base.Message = fmt.Sprintf("%d/%d replicas updated", updated, desired)
			return base
		}
	}
	base.Health = "Healthy"
	base.Message = fmt.Sprintf("%d/%d replicas ready", ready, desired)
	return base
}

// firstInt64 returns the first integer found at any of the given paths.
func firstInt64(obj *unstructured.Unstructured, paths ...[]string) (int64, bool) {
	for _, path := range paths {
		if value, found := nestedInt64(obj.Object, path...); found {
			return value, true
		}
	}
	return 0, false
}

// conditionMessage renders "Type: message" or just the type when the
// condition carries no message.
func conditionMessage(cond map[string]interface{}) string {
	condType, _ := nestedString(cond, "type")
	message, _ := nestedString(cond, "message")
	if message == "" {
		reason, _ := nestedString(cond, "reason")
		if reason != "" {
			return condType + ": " + reason
		}
		return condType
	}
	return condType + ": " + message
}

// nestedString/nestedInt64/nestedBool/nestedSlice wrap the unstructured
// accessors: their only error is a type mismatch, which generic health treats
// as "field absent" rather than a failure.
func nestedString(obj map[string]interface{}, path ...string) (string, bool) {
	v, found, err := unstructured.NestedString(obj, path...)
	if err != nil {
		return "", false
	}
	return v, found
}

func nestedInt64(obj map[string]interface{}, path ...string) (int64, bool) {
	v, found, err := unstructured.NestedInt64(obj, path...)
	if err != nil {
		return 0, false
	}
	return v, found
}

func nestedBool(obj map[string]interface{}, path ...string) bool {
	v, found, err := unstructured.NestedBool(obj, path...)
	return err == nil && found && v
}

func nestedSlice(obj map[string]interface{}, path ...string) ([]interface{}, bool) {
	v, found, err := unstructured.NestedSlice(obj, path...)
	if err != nil {
		return nil, false
	}
	return v, found
}

// checkDeployment evaluates the health of a Deployment.
func (r *ResourceHealthChecker) checkDeployment(ctx context.Context, name, namespace string) paprikav1.ResourceHealth {
	var dep appsv1.Deployment
	if err := r.Get(ctx, types.NamespacedName{Name: name, Namespace: namespace}, &dep); err != nil {
		return paprikav1.ResourceHealth{Kind: "Deployment", Name: name, Namespace: namespace, Health: "Missing", Message: err.Error()}
	}

	replicas := dep.Spec.Replicas
	if replicas == nil {
		replicas = int32Ptr(1)
	}
	available := dep.Status.AvailableReplicas
	updated := dep.Status.UpdatedReplicas

	if available < *replicas {
		return paprikav1.ResourceHealth{Kind: "Deployment", Name: name, Namespace: namespace, Health: "Progressing", Message: fmt.Sprintf("%d/%d replicas available", available, *replicas)}
	}
	if updated < *replicas {
		return paprikav1.ResourceHealth{Kind: "Deployment", Name: name, Namespace: namespace, Health: "Progressing", Message: fmt.Sprintf("%d/%d replicas updated", updated, *replicas)}
	}
	return paprikav1.ResourceHealth{Kind: "Deployment", Name: name, Namespace: namespace, Health: "Healthy", Message: fmt.Sprintf("%d/%d replicas ready", available, *replicas)}
}

// checkService evaluates the health of a Service.
func (r *ResourceHealthChecker) checkService(ctx context.Context, name, namespace string) paprikav1.ResourceHealth {
	var svc corev1.Service
	if err := r.Get(ctx, types.NamespacedName{Name: name, Namespace: namespace}, &svc); err != nil {
		return paprikav1.ResourceHealth{Kind: "Service", Name: name, Namespace: namespace, Health: "Missing", Message: err.Error()}
	}
	return paprikav1.ResourceHealth{Kind: "Service", Name: name, Namespace: namespace, Health: "Healthy", Message: "service exists"}
}

// checkIngress evaluates the health of an Ingress.
func (r *ResourceHealthChecker) checkIngress(ctx context.Context, name, namespace string) paprikav1.ResourceHealth {
	var ing netv1.Ingress
	if err := r.Get(ctx, types.NamespacedName{Name: name, Namespace: namespace}, &ing); err != nil {
		return paprikav1.ResourceHealth{Kind: "Ingress", Name: name, Namespace: namespace, Health: "Missing", Message: err.Error()}
	}
	return paprikav1.ResourceHealth{Kind: "Ingress", Name: name, Namespace: namespace, Health: "Healthy", Message: "ingress exists"}
}

func (r *ResourceHealthChecker) checkCronJob(ctx context.Context, name, namespace string) paprikav1.ResourceHealth {
	var cj batchv1.CronJob
	if err := r.Get(ctx, types.NamespacedName{Name: name, Namespace: namespace}, &cj); err != nil {
		return paprikav1.ResourceHealth{Kind: "CronJob", Name: name, Namespace: namespace, Health: "Missing", Message: err.Error()}
	}
	if cj.Spec.Suspend != nil && *cj.Spec.Suspend {
		return paprikav1.ResourceHealth{Kind: "CronJob", Name: name, Namespace: namespace, Health: "Healthy", Message: "cronjob suspended"}
	}
	if len(cj.Status.Active) > 0 {
		return paprikav1.ResourceHealth{Kind: "CronJob", Name: name, Namespace: namespace, Health: "Progressing", Message: fmt.Sprintf("%d active jobs", len(cj.Status.Active))}
	}
	return paprikav1.ResourceHealth{Kind: "CronJob", Name: name, Namespace: namespace, Health: "Healthy", Message: "cronjob scheduled"}
}

// int32Ptr returns a pointer to an int32.
func int32Ptr(v int32) *int32 {
	return &v
}

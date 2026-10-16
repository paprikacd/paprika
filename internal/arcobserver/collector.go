package arcobserver

import (
	"context"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

var runnerSetGVR = schema.GroupVersionResource{Group: "actions.github.com", Version: "v1alpha1", Resource: "autoscalingrunnersets"}
var runnerGVR = schema.GroupVersionResource{Group: "actions.github.com", Version: "v1alpha1", Resource: "ephemeralrunners"}
var podGVR = schema.GroupVersionResource{Version: "v1", Resource: "pods"}
var deploymentGVR = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}

const scaleSetLabel = "actions.github.com/scale-set-name"

type Snapshot struct {
	ObservedAt                               time.Time
	Complete                                 bool
	RunnerSet, Controller                    *unstructured.Unstructured
	SystemPods, RunnerPods, EphemeralRunners []unstructured.Unstructured
	Usage                                    *UsageSnapshot
}

type Collector interface {
	Collect(context.Context, *Source) (Snapshot, error)
}

// KubernetesCollector uses the manager's existing in-cluster identity and only
// issues GET/LIST. It never requests mutations, logs, exec, Secrets or providers.
type KubernetesCollector struct {
	Client dynamic.Interface
	Usage  *UsageConfig
}

func (c KubernetesCollector) Collect(ctx context.Context, s *Source) (Snapshot, error) {
	var snap Snapshot
	// Timestamp the beginning, not publication: slow reads cannot renew an old sample.
	snap.ObservedAt = time.Now().UTC()
	var err error
	snap.RunnerSet, err = c.Client.Resource(runnerSetGVR).Namespace(s.RunnerNamespace).Get(ctx, s.PoolName, metav1.GetOptions{})
	if err != nil {
		return Snapshot{}, readError(err)
	}
	snap.Controller, err = c.Client.Resource(deploymentGVR).Namespace(s.SystemNamespace).Get(ctx, s.ControllerDeployment, metav1.GetOptions{})
	if err != nil {
		return Snapshot{}, readError(err)
	}
	selector := scaleSetLabel + "=" + s.PoolName
	snap.SystemPods, err = c.list(ctx, podGVR, s.SystemNamespace, selector+",app.kubernetes.io/component=runner-scale-set-listener")
	if err != nil {
		return Snapshot{}, err
	}
	snap.RunnerPods, err = c.list(ctx, podGVR, s.RunnerNamespace, selector)
	if err != nil {
		return Snapshot{}, err
	}
	snap.EphemeralRunners, err = c.list(ctx, runnerGVR, s.RunnerNamespace, selector)
	if err != nil {
		return Snapshot{}, err
	}
	snap.Complete = true
	if c.Usage != nil {
		snap.Usage, err = c.collectUsage(ctx, s, &snap)
		if err != nil {
			return Snapshot{}, err
		}
	}
	return snap, nil
}

func (c KubernetesCollector) list(ctx context.Context, gvr schema.GroupVersionResource, namespace, selector string) ([]unstructured.Unstructured, error) {
	items := make([]unstructured.Unstructured, 0)
	continuation := ""
	resourceVersion := ""
	for pages := 0; pages < 16; pages++ {
		list, err := c.Client.Resource(gvr).Namespace(namespace).List(ctx, metav1.ListOptions{LabelSelector: selector, Limit: 100, Continue: continuation})
		if err != nil {
			return nil, readError(err)
		}
		if list == nil || len(items)+len(list.Items) > 512 {
			return nil, ErrIncomplete
		}
		if pages > 0 && list.GetResourceVersion() != resourceVersion {
			return nil, ErrIncomplete
		}
		resourceVersion = list.GetResourceVersion()
		items = append(items, list.Items...)
		next := list.GetContinue()
		if next == "" {
			return items, nil
		}
		if next == continuation {
			return nil, ErrIncomplete
		}
		continuation = next
	}
	return nil, ErrIncomplete
}

func readError(err error) error {
	if apierrors.IsForbidden(err) || apierrors.IsUnauthorized(err) {
		return ErrDenied
	}
	return ErrIncomplete
}

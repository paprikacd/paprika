package satellite

import (
	"context"
	"errors"
	"io"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes"
	typedapps "k8s.io/client-go/kubernetes/typed/apps/v1"
	typedcore "k8s.io/client-go/kubernetes/typed/core/v1"
)

// observedKubernetes catches failures before Reflector retries them internally.
// WatchErrorHandler alone does not see transient Watch request failures or
// watch.Error events consumed inside Reflector's watch loop.
type observedKubernetes struct {
	kubernetes.Interface
	fail func(error)
}

func (c *observedKubernetes) IsWatchListSemanticsUnSupported() bool {
	if original, ok := c.Interface.(interface{ IsWatchListSemanticsUnSupported() bool }); ok {
		return original.IsWatchListSemanticsUnSupported()
	}
	return false
}

func (c *observedKubernetes) CoreV1() typedcore.CoreV1Interface {
	return &observedCore{CoreV1Interface: c.Interface.CoreV1(), fail: c.fail}
}
func (c *observedKubernetes) AppsV1() typedapps.AppsV1Interface {
	return &observedApps{AppsV1Interface: c.Interface.AppsV1(), fail: c.fail}
}

type observedCore struct {
	typedcore.CoreV1Interface
	fail func(error)
}

func (c *observedCore) Nodes() typedcore.NodeInterface {
	return &observedNodes{NodeInterface: c.CoreV1Interface.Nodes(), fail: c.fail}
}
func (c *observedCore) Pods(namespace string) typedcore.PodInterface {
	return &observedPods{PodInterface: c.CoreV1Interface.Pods(namespace), fail: c.fail}
}
func (c *observedCore) Namespaces() typedcore.NamespaceInterface {
	return &observedNamespaces{NamespaceInterface: c.CoreV1Interface.Namespaces(), fail: c.fail}
}

type observedApps struct {
	typedapps.AppsV1Interface
	fail func(error)
}

func (c *observedApps) Deployments(namespace string) typedapps.DeploymentInterface {
	return &observedDeployments{DeploymentInterface: c.AppsV1Interface.Deployments(namespace), fail: c.fail}
}
func (c *observedApps) StatefulSets(namespace string) typedapps.StatefulSetInterface {
	return &observedStatefulSets{StatefulSetInterface: c.AppsV1Interface.StatefulSets(namespace), fail: c.fail}
}
func (c *observedApps) DaemonSets(namespace string) typedapps.DaemonSetInterface {
	return &observedDaemonSets{DaemonSetInterface: c.AppsV1Interface.DaemonSets(namespace), fail: c.fail}
}

func observeError(ctx context.Context, err error, fail func(error)) {
	if err != nil && ctx.Err() == nil {
		// An EOF while establishing LIST/WATCH is a failed request. It differs
		// from the normal EOF ending an established stream at its timeout.
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		fail(err)
	}
}

func observeWatch(ctx context.Context, source watch.Interface, err error, fail func(error)) (watch.Interface, error) {
	observeError(ctx, err, fail)
	if err != nil {
		return source, err
	}
	return watch.Filter(source, func(event watch.Event) (watch.Event, bool) {
		if event.Type == watch.Error {
			observeError(ctx, apierrors.FromObject(event.Object), fail)
		}
		return event, true
	}), nil
}

type observedNodes struct {
	typedcore.NodeInterface
	fail func(error)
}

//nolint:gocritic,wrapcheck // Kubernetes List requires value ListOptions and the original API error for Reflector classification.
func (c *observedNodes) List(ctx context.Context, options metav1.ListOptions) (*corev1.NodeList, error) {
	result, err := c.NodeInterface.List(ctx, options)
	observeError(ctx, err, c.fail)
	return result, err
}

//nolint:gocritic // Kubernetes Watch requires the value ListOptions interface signature.
func (c *observedNodes) Watch(ctx context.Context, options metav1.ListOptions) (watch.Interface, error) {
	result, err := c.NodeInterface.Watch(ctx, options)
	return observeWatch(ctx, result, err, c.fail)
}

type observedPods struct {
	typedcore.PodInterface
	fail func(error)
}

//nolint:gocritic,wrapcheck // Kubernetes List requires value ListOptions and the original API error for Reflector classification.
func (c *observedPods) List(ctx context.Context, options metav1.ListOptions) (*corev1.PodList, error) {
	result, err := c.PodInterface.List(ctx, options)
	observeError(ctx, err, c.fail)
	return result, err
}

//nolint:gocritic // Kubernetes Watch requires the value ListOptions interface signature.
func (c *observedPods) Watch(ctx context.Context, options metav1.ListOptions) (watch.Interface, error) {
	result, err := c.PodInterface.Watch(ctx, options)
	return observeWatch(ctx, result, err, c.fail)
}

type observedNamespaces struct {
	typedcore.NamespaceInterface
	fail func(error)
}

//nolint:gocritic,wrapcheck // Kubernetes List requires value ListOptions and the original API error for Reflector classification.
func (c *observedNamespaces) List(ctx context.Context, options metav1.ListOptions) (*corev1.NamespaceList, error) {
	result, err := c.NamespaceInterface.List(ctx, options)
	observeError(ctx, err, c.fail)
	return result, err
}

//nolint:gocritic // Kubernetes Watch requires the value ListOptions interface signature.
func (c *observedNamespaces) Watch(ctx context.Context, options metav1.ListOptions) (watch.Interface, error) {
	result, err := c.NamespaceInterface.Watch(ctx, options)
	return observeWatch(ctx, result, err, c.fail)
}

type observedDeployments struct {
	typedapps.DeploymentInterface
	fail func(error)
}

//nolint:gocritic,wrapcheck // Kubernetes List requires value ListOptions and the original API error for Reflector classification.
func (c *observedDeployments) List(ctx context.Context, options metav1.ListOptions) (*appsv1.DeploymentList, error) {
	result, err := c.DeploymentInterface.List(ctx, options)
	observeError(ctx, err, c.fail)
	return result, err
}

//nolint:gocritic // Kubernetes Watch requires the value ListOptions interface signature.
func (c *observedDeployments) Watch(ctx context.Context, options metav1.ListOptions) (watch.Interface, error) {
	result, err := c.DeploymentInterface.Watch(ctx, options)
	return observeWatch(ctx, result, err, c.fail)
}

type observedStatefulSets struct {
	typedapps.StatefulSetInterface
	fail func(error)
}

//nolint:gocritic,wrapcheck // Kubernetes List requires value ListOptions and the original API error for Reflector classification.
func (c *observedStatefulSets) List(ctx context.Context, options metav1.ListOptions) (*appsv1.StatefulSetList, error) {
	result, err := c.StatefulSetInterface.List(ctx, options)
	observeError(ctx, err, c.fail)
	return result, err
}

//nolint:gocritic // Kubernetes Watch requires the value ListOptions interface signature.
func (c *observedStatefulSets) Watch(ctx context.Context, options metav1.ListOptions) (watch.Interface, error) {
	result, err := c.StatefulSetInterface.Watch(ctx, options)
	return observeWatch(ctx, result, err, c.fail)
}

type observedDaemonSets struct {
	typedapps.DaemonSetInterface
	fail func(error)
}

//nolint:gocritic,wrapcheck // Kubernetes List requires value ListOptions and the original API error for Reflector classification.
func (c *observedDaemonSets) List(ctx context.Context, options metav1.ListOptions) (*appsv1.DaemonSetList, error) {
	result, err := c.DaemonSetInterface.List(ctx, options)
	observeError(ctx, err, c.fail)
	return result, err
}

//nolint:gocritic // Kubernetes Watch requires the value ListOptions interface signature.
func (c *observedDaemonSets) Watch(ctx context.Context, options metav1.ListOptions) (watch.Interface, error) {
	result, err := c.DaemonSetInterface.Watch(ctx, options)
	return observeWatch(ctx, result, err, c.fail)
}

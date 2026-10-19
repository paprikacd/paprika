package apiserver

import (
	"context"
	"fmt"
	"sync"

	"connectrpc.com/connect"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// childDiscovery maps a parent GVK to the kinds that are typically its children
// in the standard Kubernetes ownership hierarchy. These are queried during tree
// construction to discover non-managed descendant resources (ReplicaSets, Pods).
var childDiscovery = map[string][]string{
	"Deployment":  {"ReplicaSet"},
	"ReplicaSet":  {"Pod"},
	"StatefulSet": {"Pod"},
	"DaemonSet":   {"Pod"},
	"Job":         {"Pod"},
	"CronJob":     {"Job"},
}

// GetResourceTree returns a flat list of all resources in the application's
// resource tree — managed roots plus live children discovered via owner
// references. The UI builds the tree from parent_kind/parent_name fields.
func (s *PaprikaServer) GetResourceTree(
	ctx context.Context,
	req *connect.Request[paprikav1.GetResourceTreeRequest],
) (*connect.Response[paprikav1.GetResourceTreeResponse], error) {
	var app pipelinesv1alpha1.Application
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &app); err != nil {
		return nil, fmt.Errorf("getting application: %w", err)
	}
	if err := s.authorizeApplication(ctx, auth.ActionRead, &app); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}

	// Build lookup maps from Application status.
	healthMap := make(map[string]string, len(app.Status.ResourceHealth))
	msgMap := make(map[string]string, len(app.Status.ResourceHealth))
	for _, h := range app.Status.ResourceHealth {
		healthMap[h.Namespace+"/"+h.Kind+"/"+h.Name] = h.Health
		msgMap[h.Namespace+"/"+h.Kind+"/"+h.Name] = h.Message
	}

	nodes := make([]*paprikav1.ResourceNode, 0, len(app.Status.Resources)*2)

	// Add managed resources as root nodes.
	for _, r := range app.Status.Resources {
		nodes = append(nodes, &paprikav1.ResourceNode{
			Kind:          r.Kind,
			Name:          r.Name,
			Namespace:     r.Namespace,
			SyncStatus:    r.Status,
			Health:        healthMap[r.Namespace+"/"+r.Kind+"/"+r.Name],
			HealthMessage: msgMap[r.Namespace+"/"+r.Kind+"/"+r.Name],
			Managed:       true,
		})
	}

	// Discover live children on the cluster the application is deployed to, not
	// on the one this server runs in. A cluster that cannot be read yields the
	// managed nodes alone rather than another cluster's children.
	target, targetErr := s.applicationTargetCluster(ctx, &app)
	dyn := s.targetDynamicClientOrNil(ctx, target, targetErr)
	nodes = append(nodes, s.discoverChildren(ctx, dyn, app.Namespace, nodes)...)

	return connect.NewResponse(&paprikav1.GetResourceTreeResponse{Nodes: nodes}), nil
}

// GetResourceTreeDetailed returns the same tree as GetResourceTree but with
// richer status per node (phase, ready/total replicas, container counts and
// names). Used by the list view to render ready-count badges and phases.
func (s *PaprikaServer) GetResourceTreeDetailed(
	ctx context.Context,
	req *connect.Request[paprikav1.GetResourceTreeDetailedRequest],
) (*connect.Response[paprikav1.GetResourceTreeDetailedResponse], error) {
	var app pipelinesv1alpha1.Application
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.ApplicationNamespace, Name: req.Msg.ApplicationName}, &app); err != nil {
		return nil, fmt.Errorf("getting application: %w", err)
	}
	if err := s.authorizeApplication(ctx, auth.ActionRead, &app); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}

	healthMap := make(map[string]string, len(app.Status.ResourceHealth))
	msgMap := make(map[string]string, len(app.Status.ResourceHealth))
	for _, h := range app.Status.ResourceHealth {
		healthMap[h.Namespace+"/"+h.Kind+"/"+h.Name] = h.Health
		msgMap[h.Namespace+"/"+h.Kind+"/"+h.Name] = h.Message
	}

	nodes := make([]*paprikav1.ResourceTreeNode, 0, len(app.Status.Resources)*2)

	// Add managed resources as root nodes.
	for _, r := range app.Status.Resources {
		n := &paprikav1.ResourceTreeNode{
			Kind:          r.Kind,
			Name:          r.Name,
			Namespace:     r.Namespace,
			SyncStatus:    r.Status,
			Health:        healthMap[r.Namespace+"/"+r.Kind+"/"+r.Name],
			HealthMessage: msgMap[r.Namespace+"/"+r.Kind+"/"+r.Name],
			Managed:       true,
		}
		nodes = append(nodes, n)
	}

	// Discover live children on the application's own deployment target.
	target, targetErr := s.applicationTargetCluster(ctx, &app)
	dyn := s.targetDynamicClientOrNil(ctx, target, targetErr)
	typed := s.targetTypedClientOrNil(ctx, target, targetErr)
	if dyn != nil {
		existing := make([]*paprikav1.ResourceNode, 0, len(nodes))
		for _, n := range nodes {
			existing = append(existing, &paprikav1.ResourceNode{
				Kind: n.Kind, Name: n.Name, Namespace: n.Namespace,
			})
		}
		discovered := s.discoverChildren(ctx, dyn, app.Namespace, existing)
		for _, d := range discovered {
			tree := &paprikav1.ResourceTreeNode{
				Kind:       d.Kind,
				Name:       d.Name,
				Namespace:  d.Namespace,
				ParentKind: d.ParentKind,
				ParentName: d.ParentName,
				Uid:        d.Uid,
				Managed:    false,
			}
			nodes = append(nodes, tree)
		}
	}

	if err := s.populateTreeDetails(ctx, typed, nodes); err != nil {
		return nil, err
	}
	return connect.NewResponse(&paprikav1.GetResourceTreeDetailedResponse{Nodes: nodes}), nil
}

func (s *PaprikaServer) populateTreeDetails(ctx context.Context, typed kubernetes.Interface, nodes []*paprikav1.ResourceTreeNode) error {
	if typed == nil {
		return nil
	}
	// Keep Kubernetes reads bounded while allowing independent status reads to overlap.
	var wg sync.WaitGroup
	permits := make(chan struct{}, 8)
	for _, node := range nodes {
		select {
		case permits <- struct{}{}:
		case <-ctx.Done():
			wg.Wait()
			return connect.NewError(connect.CodeCanceled, ctx.Err())
		}
		wg.Add(1)
		go func(n *paprikav1.ResourceTreeNode) {
			defer wg.Done()
			defer func() { <-permits }()
			s.populateNodeDetail(ctx, typed, n)
		}(node)
	}
	wg.Wait()
	return nil
}

// populateNodeDetail fetches status-specific fields via the typed clientset
// (protobuf-negotiated). Failures are silent — leave fields empty.
func (s *PaprikaServer) populateNodeDetail(
	ctx context.Context,
	typed kubernetes.Interface,
	n *paprikav1.ResourceTreeNode,
) {
	if typed == nil || n.Name == "" {
		return
	}
	switch n.Kind {
	case "Pod":
		s.populatePodNodeDetail(ctx, typed, n)
	case "Deployment":
		s.populateDeploymentNodeDetail(ctx, typed, n)
	case "StatefulSet":
		s.populateStatefulSetNodeDetail(ctx, typed, n)
	case "DaemonSet":
		s.populateDaemonSetNodeDetail(ctx, typed, n)
	}
}

func (s *PaprikaServer) populatePodNodeDetail(
	ctx context.Context,
	typed kubernetes.Interface,
	n *paprikav1.ResourceTreeNode,
) {
	pod, err := typed.CoreV1().Pods(n.Namespace).Get(ctx, n.Name, metav1.GetOptions{})
	if err != nil {
		return
	}
	n.Phase = string(pod.Status.Phase)
	containers := make([]string, 0, len(pod.Spec.Containers))
	ready := int32(0)
	for i := range pod.Spec.Containers {
		containers = append(containers, pod.Spec.Containers[i].Name)
	}
	n.Containers = containers
	n.Total = boundedInt32(len(pod.Spec.Containers))
	for i := range pod.Status.ContainerStatuses {
		if pod.Status.ContainerStatuses[i].Ready {
			ready++
		}
	}
	n.Ready = ready
	if pod.Status.Message != "" {
		n.Message = pod.Status.Message
	}
}

func (s *PaprikaServer) populateDeploymentNodeDetail(
	ctx context.Context,
	typed kubernetes.Interface,
	n *paprikav1.ResourceTreeNode,
) {
	d, err := typed.AppsV1().Deployments(n.Namespace).Get(ctx, n.Name, metav1.GetOptions{})
	if err != nil {
		return
	}
	n.Ready = d.Status.ReadyReplicas
	n.Total = d.Status.Replicas
	for _, cond := range d.Status.Conditions {
		if cond.Type == appsv1.DeploymentAvailable && cond.Status == corev1.ConditionFalse {
			n.Message = cond.Message
		}
	}
}

func (s *PaprikaServer) populateStatefulSetNodeDetail(
	ctx context.Context,
	typed kubernetes.Interface,
	n *paprikav1.ResourceTreeNode,
) {
	ss, err := typed.AppsV1().StatefulSets(n.Namespace).Get(ctx, n.Name, metav1.GetOptions{})
	if err != nil {
		return
	}
	n.Ready = ss.Status.ReadyReplicas
	n.Total = ss.Status.Replicas
}

func (s *PaprikaServer) populateDaemonSetNodeDetail(
	ctx context.Context,
	typed kubernetes.Interface,
	n *paprikav1.ResourceTreeNode,
) {
	ds, err := typed.AppsV1().DaemonSets(n.Namespace).Get(ctx, n.Name, metav1.GetOptions{})
	if err != nil {
		return
	}
	n.Ready = ds.Status.NumberReady
	n.Total = ds.Status.DesiredNumberScheduled
}

func boundedInt32(value int) int32 {
	const maxInt32 = int(^uint32(0) >> 1)
	if value > maxInt32 {
		return int32(maxInt32)
	}
	return int32(value) //nolint:gosec // bounded above before conversion
}

// discoverChildren queries the cluster for child resources owned by any node
// already in the tree. Returns newly discovered nodes with parent references set.
func (s *PaprikaServer) discoverChildren(ctx context.Context, dyn dynamic.Interface, namespace string, existing []*paprikav1.ResourceNode) []*paprikav1.ResourceNode {
	if dyn == nil {
		// No client for the target means no live children. The managed nodes the
		// application reports are still returned by the caller.
		return nil
	}
	// Request-local indexes avoid repeating namespace-wide lists for every parent.
	// Nothing is shared across applications or authorization decisions.
	indexes := make(map[string]map[string][]unstructured.Unstructured)
	seen := make(map[string]bool, len(existing))

	for _, n := range existing {
		seen[treeNodeNamespace(namespace, n)+"/"+n.Kind+"/"+n.Name] = true
	}
	queue := append([]*paprikav1.ResourceNode(nil), existing...)
	var discovered []*paprikav1.ResourceNode
	for i := 0; i < len(queue) && ctx.Err() == nil; i++ {
		parent := queue[i]
		children := s.discoverDirectChildren(ctx, dyn, treeNodeNamespace(namespace, parent), parent, indexes, seen)
		discovered = append(discovered, children...)
		queue = append(queue, children...)
	}
	return discovered
}

// discoverDirectChildren lists one parent's children, caching the namespace-wide
// list per child kind so a tree with many pods lists each kind once.
func (s *PaprikaServer) discoverDirectChildren(
	ctx context.Context,
	dyn dynamic.Interface,
	ns string,
	parent *paprikav1.ResourceNode,
	indexes map[string]map[string][]unstructured.Unstructured,
	seen map[string]bool,
) []*paprikav1.ResourceNode {
	var children []*paprikav1.ResourceNode
	for _, childKind := range childDiscovery[parent.Kind] {
		gvr, ok := knownResourceGVRs[childKind]
		if !ok {
			continue
		}
		for _, item := range childKindIndex(ctx, dyn, ns, childKind, gvr, indexes)[parent.Kind+"/"+parent.Name] {
			key := ns + "/" + childKind + "/" + item.GetName()
			if seen[key] {
				continue
			}
			seen[key] = true
			children = append(children, &paprikav1.ResourceNode{
				Kind: childKind, Name: item.GetName(), Namespace: ns,
				ParentKind: parent.Kind, ParentName: parent.Name, Uid: string(item.GetUID()),
			})
		}
	}
	return children
}

// childKindIndex returns (and caches) the owner-indexed list of one child kind in
// one namespace.
func childKindIndex(
	ctx context.Context,
	dyn dynamic.Interface,
	ns, childKind string,
	gvr schema.GroupVersionResource,
	indexes map[string]map[string][]unstructured.Unstructured,
) map[string][]unstructured.Unstructured {
	cacheKey := ns + "/" + childKind
	if index, loaded := indexes[cacheKey]; loaded {
		return index
	}
	index := make(map[string][]unstructured.Unstructured)
	indexes[cacheKey] = index
	list, err := dyn.Resource(gvr).Namespace(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return index
	}
	indexChildrenByOwner(index, list.Items)
	return index
}

// hasOwnerRef checks if obj has an ownerReference of the given apiVersion/kind/name.
func hasOwnerRef(obj *unstructured.Unstructured, kind, name string) bool {
	ownerRefs := obj.GetOwnerReferences()
	for _, ref := range ownerRefs {
		if ref.Kind == kind && ref.Name == name {
			return true
		}
	}
	return false
}

func indexChildrenByOwner(index map[string][]unstructured.Unstructured, items []unstructured.Unstructured) {
	for _, item := range items {
		for _, owner := range item.GetOwnerReferences() {
			key := owner.Kind + "/" + owner.Name
			index[key] = append(index[key], item)
		}
	}
}

func treeNodeNamespace(fallback string, node *paprikav1.ResourceNode) string {
	if node.Namespace != "" {
		return node.Namespace
	}
	return fallback
}

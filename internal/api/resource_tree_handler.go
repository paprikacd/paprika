package apiserver

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
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
		healthMap[h.Kind+"/"+h.Name] = h.Health
		msgMap[h.Kind+"/"+h.Name] = h.Message
	}

	nodes := make([]*paprikav1.ResourceNode, 0, len(app.Status.Resources)*2)

	// Add managed resources as root nodes.
	for _, r := range app.Status.Resources {
		nodes = append(nodes, &paprikav1.ResourceNode{
			Kind:          r.Kind,
			Name:          r.Name,
			Namespace:     r.Namespace,
			SyncStatus:    r.Status,
			Health:        healthMap[r.Kind+"/"+r.Name],
			HealthMessage: msgMap[r.Kind+"/"+r.Name],
			Managed:       true,
		})
	}

	// Discover live children for each managed resource.
	if s.dynamicClient != nil {
		discovered := s.discoverChildren(ctx, app.Namespace, nodes)
		nodes = append(nodes, discovered...)
	}

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
		healthMap[h.Kind+"/"+h.Name] = h.Health
		msgMap[h.Kind+"/"+h.Name] = h.Message
	}

	nodes := make([]*paprikav1.ResourceTreeNode, 0, len(app.Status.Resources)*2)

	// Add managed resources as root nodes.
	for _, r := range app.Status.Resources {
		n := &paprikav1.ResourceTreeNode{
			Kind:          r.Kind,
			Name:          r.Name,
			Namespace:     r.Namespace,
			SyncStatus:    r.Status,
			Health:        healthMap[r.Kind+"/"+r.Name],
			HealthMessage: msgMap[r.Kind+"/"+r.Name],
			Managed:       true,
		}
		s.populateNodeDetail(ctx, n)
		nodes = append(nodes, n)
	}

	// Discover live children for each managed resource.
	if s.dynamicClient != nil {
		existing := make([]*paprikav1.ResourceNode, 0, len(nodes))
		for _, n := range nodes {
			existing = append(existing, &paprikav1.ResourceNode{
				Kind: n.Kind, Name: n.Name, Namespace: n.Namespace,
			})
		}
		discovered := s.discoverChildren(ctx, app.Namespace, existing)
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
			s.populateNodeDetail(ctx, tree)
			nodes = append(nodes, tree)
		}
	}

	return connect.NewResponse(&paprikav1.GetResourceTreeDetailedResponse{Nodes: nodes}), nil
}

// populateNodeDetail fetches status-specific fields via the typed clientset
// (protobuf-negotiated). Failures are silent — leave fields empty.
func (s *PaprikaServer) populateNodeDetail(ctx context.Context, n *paprikav1.ResourceTreeNode) {
	if s.k8sClient == nil || n.Name == "" {
		return
	}
	switch n.Kind {
	case "Pod":
		pod, err := s.k8sClient.CoreV1().Pods(n.Namespace).Get(ctx, n.Name, metav1.GetOptions{})
		if err != nil {
			return
		}
		n.Phase = string(pod.Status.Phase)
		containers := make([]string, 0, len(pod.Spec.Containers))
		ready := int32(0)
		for _, c := range pod.Spec.Containers {
			containers = append(containers, c.Name)
		}
		n.Containers = containers
		n.Total = int32(len(pod.Spec.Containers))
		for _, cs := range pod.Status.ContainerStatuses {
			if cs.Ready {
				ready++
			}
		}
		n.Ready = ready
		if pod.Status.Message != "" {
			n.Message = pod.Status.Message
		}
	case "Deployment":
		d, err := s.k8sClient.AppsV1().Deployments(n.Namespace).Get(ctx, n.Name, metav1.GetOptions{})
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
	case "StatefulSet":
		ss, err := s.k8sClient.AppsV1().StatefulSets(n.Namespace).Get(ctx, n.Name, metav1.GetOptions{})
		if err != nil {
			return
		}
		n.Ready = ss.Status.ReadyReplicas
		n.Total = ss.Status.Replicas
	case "DaemonSet":
		ds, err := s.k8sClient.AppsV1().DaemonSets(n.Namespace).Get(ctx, n.Name, metav1.GetOptions{})
		if err != nil {
			return
		}
		n.Ready = ds.Status.NumberReady
		n.Total = ds.Status.DesiredNumberScheduled
	}
}

// discoverChildren queries the cluster for child resources owned by any node
// already in the tree. Returns newly discovered nodes with parent references set.
func (s *PaprikaServer) discoverChildren(ctx context.Context, namespace string, existing []*paprikav1.ResourceNode) []*paprikav1.ResourceNode {
	var discovered []*paprikav1.ResourceNode

	// Track discovered keys to avoid duplicates.
	seen := make(map[string]bool, len(existing))
	for _, n := range existing {
		seen[n.Kind+"/"+n.Name] = true
	}

	// For each existing node, look for children based on the kind hierarchy.
	for _, parent := range existing {
		childKinds, ok := childDiscovery[parent.Kind]
		if !ok {
			continue
		}
		for _, childKind := range childKinds {
			gvr, ok := knownResourceGVRs[childKind]
			if !ok {
				continue
			}
			children := s.listChildren(ctx, gvr, namespace, childKind, parent.Name, parent.Kind, seen)
			discovered = append(discovered, children...)
		}
	}

	// Recursively discover grandchildren (one level deep — prevents runaway queries).
	if len(discovered) > 0 && len(discovered) < 100 {
		next := s.discoverChildren(ctx, namespace, discovered)
		discovered = append(discovered, next...)
	}

	return discovered
}

// listChildren lists resources of a specific GVR in the namespace and filters
// by ownerReferences pointing to parentName/parentKind.
func (s *PaprikaServer) listChildren(ctx context.Context, gvr schema.GroupVersionResource, namespace, childKind, parentName, parentKind string, seen map[string]bool) []*paprikav1.ResourceNode {
	list, err := s.dynamicClient.Resource(gvr).Namespace(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil
	}

	var nodes []*paprikav1.ResourceNode
	for i := range list.Items {
		item := &list.Items[i]
		if !hasOwnerRef(item, parentKind, parentName) {
			continue
		}
		key := item.GetKind() + "/" + item.GetName()
		if seen[key] {
			continue
		}
		seen[key] = true
		nodes = append(nodes, &paprikav1.ResourceNode{
			Kind:       item.GetKind(),
			Name:       item.GetName(),
			Namespace:  item.GetNamespace(),
			ParentKind: parentKind,
			ParentName: parentName,
			Uid:        string(item.GetUID()),
			Managed:    false,
		})
	}
	return nodes
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

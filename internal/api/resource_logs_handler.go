package apiserver

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// GetResourceLogs returns the recent log output of a managed resource's pod.
// For Pod kinds, returns logs directly. For Deployments, ReplicaSets,
// StatefulSets, DaemonSets, and Jobs, discovers the first matching child Pod
// via label selector and returns its logs. Other kinds return an error field.
func (s *PaprikaServer) GetResourceLogs(
	ctx context.Context,
	req *connect.Request[paprikav1.GetResourceLogsRequest],
) (*connect.Response[paprikav1.GetResourceLogsResponse], error) {
	var app pipelinesv1alpha1.Application
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.ApplicationNamespace, Name: req.Msg.ApplicationName}, &app); err != nil {
		return nil, fmt.Errorf("getting application: %w", err)
	}
	if err := s.authorizeApplication(ctx, auth.ActionRead, &app); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}

	resp := &paprikav1.GetResourceLogsResponse{}
	if s.k8sClient == nil {
		resp.Error = "kubernetes client not configured"
		return connect.NewResponse(resp), nil
	}

	ns := req.Msg.ResourceNamespace
	if ns == "" {
		ns = app.Namespace
	}

	pod, err := s.resolveLogsPod(ctx, req.Msg.ResourceKind, req.Msg.ResourceName, ns)
	if err != nil {
		resp.Error = err.Error()
		return connect.NewResponse(resp), nil
	}

	containerNames := make([]string, 0, len(pod.Spec.Containers))
	for _, c := range pod.Spec.Containers {
		containerNames = append(containerNames, c.Name)
	}
	resp.PodName = pod.Name
	resp.Containers = containerNames
	if len(containerNames) > 0 {
		resp.ContainerName = containerNames[0]
	}

	logs, err := s.streamPodLogs(ctx, ns, pod.Name, req.Msg.TailLines)
	if err != nil {
		resp.Error = err.Error()
		return connect.NewResponse(resp), nil
	}
	resp.Logs = logs
	return connect.NewResponse(resp), nil
}

// resolveLogsPod maps any supported resource kind to a single Pod object to
// fetch logs from. Returns an error (not a panic) when unsupported.
func (s *PaprikaServer) resolveLogsPod(ctx context.Context, kind, name, namespace string) (*corev1.Pod, error) {
	switch kind {
	case "Pod":
		pod, err := s.k8sClient.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, fmt.Errorf("pod %s/%s not found", namespace, name)
		}
		return pod, nil
	case "Deployment", "ReplicaSet", "StatefulSet", "DaemonSet", "Job":
		pods, err := s.k8sClient.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
			LabelSelector: fmt.Sprintf("app=%s", name),
			Limit:         1,
		})
		if err != nil {
			return nil, fmt.Errorf("listing pods for %s/%s: %w", kind, name, err)
		}
		if len(pods.Items) == 0 {
			return nil, fmt.Errorf("no pods found for %s/%s", kind, name)
		}
		return &pods.Items[0], nil
	default:
		return nil, fmt.Errorf("logs only available for Pod, Deployment, ReplicaSet, StatefulSet, DaemonSet, or Job")
	}
}

package apiserver

import (
	"context"
	"errors"
	"fmt"

	"connectrpc.com/connect"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// GetResourceLogs returns the recent log output of a pod in the application's
// resource tree. For Pod kinds, returns logs directly. For Deployments,
// ReplicaSets, StatefulSets, DaemonSets, and Jobs, finds the first pod of the
// workload that the resource tree shows and returns its logs. Other kinds, and
// malformed names, return an error field. A resource outside the tree returns
// CodeNotFound.
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
	// Logs come from the cluster the application is deployed to, never from the
	// one this server happens to run in: the pod names usually exist on both, so
	// reading the wrong one answers confidently and incorrectly.
	target, targetErr := s.applicationTargetCluster(ctx, &app)
	if targetErr != nil {
		resp.Error = targetUnavailableMessage(target, targetErr)
		return connect.NewResponse(resp), nil
	}
	typed, err := s.targetTypedClient(ctx, target)
	if err != nil {
		resp.Error = targetUnavailableMessage(target, err)
		return connect.NewResponse(resp), nil
	}

	ns := req.Msg.ResourceNamespace
	if ns == "" {
		ns = app.Namespace
	}

	pod, err := resolveApplicationLogsPod(ctx, typed, &app, req.Msg.ResourceKind, req.Msg.ResourceName, ns)
	if err != nil {
		if unaryLogsPassThrough[connect.CodeOf(err)] {
			return nil, err
		}
		// A request the server cannot accept, and a read that failed, are
		// answered in the response, as the console expects.
		resp.Error = logsErrorText(err)
		return connect.NewResponse(resp), nil
	}

	resp.PodName = pod.Name
	resp.Containers = podContainerNames(pod)
	resp.ContainerName = pickContainer("", pod)

	logs, err := s.streamPodLogs(ctx, typed, ns, pod.Name, req.Msg.TailLines)
	if err != nil {
		resp.Error = err.Error()
		return connect.NewResponse(resp), nil
	}
	resp.Logs = logs
	return connect.NewResponse(resp), nil
}

// unaryLogsPassThrough lists the resolve failures GetResourceLogs returns as RPC
// errors: outside the tree, and a caller that went away or ran out of time. Other
// failures are answered in the response, as the console expects.
var unaryLogsPassThrough = map[connect.Code]bool{
	connect.CodeNotFound:         true,
	connect.CodeCanceled:         true,
	connect.CodeDeadlineExceeded: true,
}

// podContainerNames lists a pod's containers in spec order.
func podContainerNames(pod *corev1.Pod) []string {
	names := make([]string, 0, len(pod.Spec.Containers))
	for i := range pod.Spec.Containers {
		names = append(names, pod.Spec.Containers[i].Name)
	}
	return names
}

// logsErrorText is the text a log response carries for a failed read. A connect
// error contributes its message, without the code prefix that Error adds.
func logsErrorText(err error) string {
	var ce *connect.Error
	if errors.As(err, &ce) {
		return ce.Message()
	}
	return err.Error()
}

// Workload names do not determine pod labels. Read the controller's selector,
// including match expressions, rather than guessing an app label convention.
func logsPodSelectorString(selector *metav1.LabelSelector, kind, name string) (string, error) {
	if selector == nil || len(selector.MatchLabels)+len(selector.MatchExpressions) == 0 {
		return "", fmt.Errorf("no pod selector configured for %s/%s", kind, name)
	}
	labels, err := metav1.LabelSelectorAsSelector(selector)
	if err != nil {
		return "", fmt.Errorf("invalid pod selector for %s/%s: %w", kind, name, err)
	}
	return labels.String(), nil
}

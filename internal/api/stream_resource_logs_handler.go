package apiserver

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"connectrpc.com/connect"
	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// StreamResourceLogs streams log chunks from a managed resource's pod. When
// `follow` is true the kubelet log stream stays open and lines are forwarded
// as they arrive; when false the stream is read once until EOF and the
// connection closes.
func (s *PaprikaServer) StreamResourceLogs(
	ctx context.Context,
	req *connect.Request[paprikav1.StreamResourceLogsRequest],
	stream *connect.ServerStream[paprikav1.LogChunk],
) error {
	var app pipelinesv1alpha1.Application
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.ApplicationNamespace, Name: req.Msg.ApplicationName}, &app); err != nil {
		return fmt.Errorf("getting application: %w", err)
	}
	if err := s.authorizeApplication(ctx, auth.ActionRead, &app); err != nil {
		return connect.NewError(connect.CodePermissionDenied, err)
	}
	if s.k8sClient == nil {
		return connect.NewError(connect.CodeUnavailable, errors.New("kubernetes client not configured"))
	}

	ns := req.Msg.ResourceNamespace
	if ns == "" {
		ns = app.Namespace
	}

	pod, err := s.resolveLogsPod(ctx, req.Msg.ResourceKind, req.Msg.ResourceName, ns)
	if err != nil {
		return connect.NewError(connect.CodeFailedPrecondition, err)
	}

	opts := &corev1.PodLogOptions{
		Follow:     req.Msg.Follow,
		Container:  req.Msg.ContainerName,
		Timestamps: false,
	}
	kubeStream, err := s.k8sClient.CoreV1().Pods(ns).GetLogs(pod.Name, opts).Stream(ctx)
	if err != nil {
		return fmt.Errorf("opening log stream: %w", err)
	}
	defer func() { _ = kubeStream.Close() }()

	container := pickContainer(req.Msg.ContainerName, pod)
	// ServerStream satisfies logChunkSink (Send only); this is what makes the
	// line-forwarder unit-testable with a tiny in-memory fake.
	return forwardLogLines(ctx, streamAdapter{stream}, kubeStream, pod.Name, container)
}

// logChunkSink is the minimal interface forwardLogLines needs to send chunks.
// Extracted so unit tests can supply an in-memory fake without depending on
// the connect.ServerStream concrete type.
type logChunkSink interface {
	Send(*paprikav1.LogChunk) error
}

// streamAdapter lets us pass *connect.ServerStream to forwardLogLines via the
// logChunkSink interface.
type streamAdapter struct{ s *connect.ServerStream[paprikav1.LogChunk] }

func (a streamAdapter) Send(c *paprikav1.LogChunk) error { return a.s.Send(c) }

// pickContainer returns the explicit container name from the request, or the
// first container on the pod if absent. Falls back to "" for pods with no
// containers (shouldn't happen in practice).
func pickContainer(reqName string, pod *corev1.Pod) string {
	if reqName != "" {
		return reqName
	}
	if len(pod.Spec.Containers) > 0 {
		return pod.Spec.Containers[0].Name
	}
	return ""
}

// forwardLogLines reads newline-delimited lines from src and sends each as a
// LogChunk. Stops when the source returns EOF or the caller's context is
// cancelled.
func forwardLogLines(
	ctx context.Context,
	sink logChunkSink,
	src io.Reader,
	podName, container string,
) error {
	scanner := bufio.NewScanner(src)
	// Allow long log lines (default bufio.Scanner buffer is 64KB which is too
	// small for stack traces / request bodies).
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		line := scanner.Text()
		// Trim trailing CR to keep client-side formatting clean.
		line = strings.TrimSuffix(line, "\r")
		chunk := &paprikav1.LogChunk{
			PodName:       podName,
			ContainerName: container,
			Line:          line,
			TimestampMs:   time.Now().UnixMilli(),
		}
		if err := sink.Send(chunk); err != nil {
			return err
		}
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		return fmt.Errorf("reading log stream: %w", err)
	}
	return nil
}

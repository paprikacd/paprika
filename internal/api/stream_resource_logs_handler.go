package apiserver

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

// streamLogsPassThrough lists the resolve failures the stream returns unchanged:
// outside the tree, a malformed request, and a caller that went away or ran out
// of time. Every other failure is a failed precondition.
var streamLogsPassThrough = map[connect.Code]bool{
	connect.CodeNotFound:         true,
	connect.CodeInvalidArgument:  true,
	connect.CodeCanceled:         true,
	connect.CodeDeadlineExceeded: true,
}

// openLogStream resolves the pod for the request through the application's
// resource tree, then opens its kube log stream. A resource the tree does not
// show, whether or not it exists, is NotFound and opens no stream. A managed
// resource that is gone, or a workload with no pods, is FailedPrecondition.
func (s *PaprikaServer) openLogStream(
	ctx context.Context,
	req *connect.Request[paprikav1.StreamResourceLogsRequest],
	app *pipelinesv1alpha1.Application,
) (*corev1.Pod, io.ReadCloser, error) {
	// The stream reads the cluster the application deploys to. A target the
	// control plane cannot reach is a failed precondition, not an empty stream.
	target, err := s.applicationTargetCluster(ctx, app)
	if err != nil {
		return nil, nil, connect.NewError(connect.CodeFailedPrecondition, err)
	}
	typed, err := s.targetTypedClient(ctx, target)
	if err != nil {
		return nil, nil, connect.NewError(connect.CodeUnavailable, err)
	}

	ns := req.Msg.ResourceNamespace
	if ns == "" {
		ns = app.Namespace
	}

	pod, err := resolveApplicationLogsPod(ctx, typed, app, req.Msg.ResourceKind, req.Msg.ResourceName, ns)
	if err != nil {
		if streamLogsPassThrough[connect.CodeOf(err)] {
			return nil, nil, err
		}
		return nil, nil, connect.NewError(connect.CodeFailedPrecondition, err)
	}

	opts := &corev1.PodLogOptions{
		Follow:     req.Msg.Follow,
		Container:  req.Msg.ContainerName,
		Timestamps: false,
	}
	kubeStream, err := typed.CoreV1().Pods(ns).GetLogs(pod.Name, opts).Stream(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("opening log stream: %w", err)
	}
	return pod, kubeStream, nil
}

// defaultLogStreamLimit is how many StreamResourceLogs calls one principal
// subject may hold open at once when no limit is configured. The api-server
// sets the limit with --api-log-stream-limit. A call past the limit ends with
// ResourceExhausted before it opens a kube log stream.
const defaultLogStreamLimit = 8

// logStreamSlots counts the open StreamResourceLogs calls of each principal
// subject. The zero value is ready to use.
type logStreamSlots struct {
	mu   sync.Mutex
	open map[string]int
}

// acquire takes a slot for subject. It reports false, and takes nothing, when
// subject already holds limit slots. The returned function gives the slot back;
// calling it more than once is harmless.
func (l *logStreamSlots) acquire(subject string, limit int) (func(), bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.open == nil {
		l.open = make(map[string]int)
	}
	if l.open[subject] >= limit {
		return nil, false
	}
	l.open[subject]++
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			l.open[subject]--
			if l.open[subject] == 0 {
				delete(l.open, subject)
			}
		})
	}, true
}

// defaultFollowRecheckInterval is how often a follow-mode log stream
// re-authenticates its caller and re-authorizes the application. A revoked
// token or a changed AppProject ends the stream within one interval, even when
// the pod writes nothing.
const defaultFollowRecheckInterval = 5 * time.Minute

// authorizeLogStreamTarget runs the checks a stream makes before it opens: a
// follow needs the interceptor's re-authenticator, so it can be re-checked; the
// namespace is checked before the lookup, as WrapUnary does for unary RPCs, so a
// caller who cannot read the namespace cannot tell which apps exist in it; then
// the application and its AppProject are checked. It returns the application the
// stream reads.
func (s *PaprikaServer) authorizeLogStreamTarget(
	ctx context.Context,
	action auth.Action,
	resource auth.Resource,
	req *connect.Request[paprikav1.StreamResourceLogsRequest],
) (*pipelinesv1alpha1.Application, error) {
	// With an authorizer configured and no re-authenticator in the context, the
	// follow cannot be re-checked, so it is refused before it opens.
	if s.authorizer != nil && req.Msg.Follow && auth.StreamReauthenticatorFromContext(ctx) == nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("log follow has no re-authenticator"))
	}
	if err := s.authorizeProject(ctx, action, resource, req.Msg.ApplicationNamespace, ""); err != nil {
		return nil, streamAuthzError(err)
	}
	key := client.ObjectKey{Namespace: req.Msg.ApplicationNamespace, Name: req.Msg.ApplicationName}
	var app pipelinesv1alpha1.Application
	if err := s.client.Get(ctx, key, &app); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("getting application: %w", err))
		}
		return nil, connect.NewError(connect.CodeUnavailable, fmt.Errorf("getting application: %w", err))
	}
	if err := s.authorizeApplication(ctx, action, &app); err != nil {
		return nil, streamAuthzError(err)
	}
	return &app, nil
}

// StreamResourceLogs streams log chunks from a pod in the application's resource
// tree. When `follow` is true the kubelet log stream stays open and lines are
// forwarded as they arrive; when false the stream is read once until EOF and the
// connection closes. A resource the tree does not show, whether or not it
// exists, ends the call with NotFound before any log is read. A managed resource
// that is gone, or a workload with no pods, ends it with FailedPrecondition.
//
// The streaming interceptor authenticates the call from its headers before
// this handler runs. The handler checks the application's namespace, then the
// application itself, with the action ActionFor returns for this procedure
// (read, the same as unary GetResourceLogs). While a follow is open the handler
// repeats the application check, which also covers its namespace, every
// followRecheckInterval, reading the application again each time, and ends the
// stream with the failing code. The re-check does not re-resolve the pod against
// the resource tree; the pod is resolved once, when the stream opens. An
// application that does not exist ends the call with NotFound. Each caller
// subject may hold a limited number of open calls (WithLogStreamLimit, set by
// --api-log-stream-limit); a call past it ends with ResourceExhausted.
func (s *PaprikaServer) StreamResourceLogs(
	ctx context.Context,
	req *connect.Request[paprikav1.StreamResourceLogsRequest],
	stream *connect.ServerStream[paprikav1.LogChunk],
) error {
	action, resource := auth.ActionFor(v1connect.PaprikaServiceStreamResourceLogsProcedure)
	app, err := s.authorizeLogStreamTarget(ctx, action, resource, req)
	if err != nil {
		return err
	}
	key := client.ObjectKey{Namespace: req.Msg.ApplicationNamespace, Name: req.Msg.ApplicationName}
	release, ok := s.acquireLogStream(ctx)
	if !ok {
		return connect.NewError(connect.CodeResourceExhausted,
			fmt.Errorf("too many log streams are open for this caller (limit %d)", s.logStreamLimitOrDefault()))
	}
	defer release()
	// logCtx ends the kube request when a re-check fails. Cancelling ctx alone
	// would not wake a read that is blocked on a silent pod.
	logCtx, cancelLogs := context.WithCancel(ctx)
	defer cancelLogs()

	pod, kubeStream, err := s.openLogStream(logCtx, req, app)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := kubeStream.Close(); closeErr != nil {
			return
		}
	}()

	stopRecheck := func() error { return nil }
	if req.Msg.Follow {
		uid := app.UID
		stopRecheck = s.startFollowRecheck(ctx, cancelLogs, func(checkCtx context.Context) error {
			return s.recheckFollow(checkCtx, action, key, uid)
		})
	}

	container := pickContainer(req.Msg.ContainerName, pod)
	// ServerStream satisfies logChunkSink (Send only); this is what makes the
	// line-forwarder unit-testable with a tiny in-memory fake.
	forwardErr := forwardLogLines(logCtx, streamAdapter{stream}, kubeStream, pod.Name, container)
	// A failed re-check cancels logCtx, so forwardLogLines ends with a read
	// error. Report the re-check's code instead of that read error.
	if checkErr := stopRecheck(); checkErr != nil {
		return checkErr
	}
	return forwardErr
}

// recheckFollow repeats the caller's authentication and the application's
// authorization. It reads the application again rather than reusing the copy the
// stream opened with, so a move to another AppProject, a delete or a recreate
// (a new UID) ends the follow too. Errors carry the connect code the stream should
// end with.
func (s *PaprikaServer) recheckFollow(ctx context.Context, action auth.Action, key client.ObjectKey, uid types.UID) error {
	switch reauth := auth.StreamReauthenticatorFromContext(ctx); {
	case reauth != nil:
		principal, err := reauth(ctx)
		if err != nil {
			return connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("log stream re-authentication: %w", err))
		}
		ctx = auth.WithPrincipal(ctx, principal)
	case s.authorizer != nil:
		// The streaming interceptor sets the re-authenticator on every stream. Without
		// it nothing shows the caller still authenticates, so the follow ends.
		return connect.NewError(connect.CodeUnauthenticated, errors.New("log stream has no re-authenticator"))
	}
	var app pipelinesv1alpha1.Application
	if err := s.client.Get(ctx, key, &app); err != nil {
		if apierrors.IsNotFound(err) {
			return connect.NewError(connect.CodeNotFound, fmt.Errorf("log stream application %s/%s no longer exists", key.Namespace, key.Name))
		}
		return connect.NewError(connect.CodeUnavailable, fmt.Errorf("log stream re-read application: %w", err))
	}
	if app.UID != uid {
		return connect.NewError(connect.CodeNotFound, fmt.Errorf("log stream application %s/%s was replaced", key.Namespace, key.Name))
	}
	if err := s.authorizeApplication(ctx, action, &app); err != nil {
		return streamAuthzError(fmt.Errorf("log stream re-authorization: %w", err))
	}
	return nil
}

// acquireLogStream takes a per-subject slot for the caller. A call without a
// principal (auth disabled) shares the empty subject.
func (s *PaprikaServer) acquireLogStream(ctx context.Context) (func(), bool) {
	subject := ""
	if p := auth.PrincipalFromContext(ctx); p != nil {
		subject = p.Subject
	}
	return s.logStreams.acquire(subject, s.logStreamLimitOrDefault())
}

// logStreamLimitOrDefault returns the configured per-subject limit, or the
// default when none is set.
func (s *PaprikaServer) logStreamLimitOrDefault() int {
	if s.logStreamLimit > 0 {
		return s.logStreamLimit
	}
	return defaultLogStreamLimit
}

// streamAuthzError maps an authorization failure to the connect code a stream
// ends with. A denial, or an AppProject that no longer exists, is
// PermissionDenied. Any other error, such as a failed read, is Unavailable, so
// the client retries instead of treating access as revoked.
func streamAuthzError(err error) error {
	if errors.Is(err, auth.ErrUnauthorized) || apierrors.IsNotFound(err) {
		return connect.NewError(connect.CodePermissionDenied, err)
	}
	return connect.NewError(connect.CodeUnavailable, err)
}

// startFollowRecheck runs check every followRecheckInterval until the returned
// stop function is called. A failed check cancels logCtx and is returned from
// stop. stop waits for the goroutine to exit, so no goroutine outlives the
// handler.
func (s *PaprikaServer) startFollowRecheck(
	ctx context.Context,
	cancelLogs context.CancelFunc,
	check func(context.Context) error,
) (stop func() error) {
	interval := s.followRecheckInterval
	if interval <= 0 {
		interval = defaultFollowRecheckInterval
	}
	checkCtx, cancelCheck := context.WithCancel(ctx)
	stopped := make(chan struct{})
	done := make(chan struct{})
	var checkErr error // written by the goroutine before done is closed

	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stopped:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			if err := check(checkCtx); err != nil {
				select {
				case <-stopped:
					// The stream ended while the check ran. Its error is not a failure.
					return
				default:
				}
				checkErr = err
				cancelLogs()
				return
			}
		}
	}()

	return func() error {
		close(stopped)
		cancelCheck()
		<-done
		return checkErr
	}
}

// logChunkSink is the minimal interface forwardLogLines needs to send chunks.
// Extracted so unit tests can supply an in-memory fake without depending on
// the connect.ServerStream concrete type.
type logChunkSink interface {
	Send(*paprikav1.LogChunk) error
}

// streamAdapter lets us pass *connect.ServerStream to forwardLogLines via the
// logChunkSink interface.
type streamAdapter struct {
	s *connect.ServerStream[paprikav1.LogChunk]
}

func (a streamAdapter) Send(c *paprikav1.LogChunk) error {
	if err := a.s.Send(c); err != nil {
		return fmt.Errorf("send log chunk: %w", err)
	}
	return nil
}

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
			return fmt.Errorf("stream context done: %w", err)
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
			return fmt.Errorf("send log chunk: %w", err)
		}
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		return fmt.Errorf("reading log stream: %w", err)
	}
	return nil
}

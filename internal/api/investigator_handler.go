package apiserver

import (
	"context"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"connectrpc.com/connect"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/investigator"
)

// investigatorLogsTailLines bounds how many log lines we send to detectors.
const investigatorLogsTailLines = 500

// investigatorEventsLimit bounds how many recent events we expose to detectors.
const investigatorEventsLimit = 50

// investigatorRegistry is the package-level registry shared by all server modes.
// Built once with default plugins; conditional plugins self-register via their
// own init() in subdirectories of internal/investigator/plugins/.
var investigatorRegistry = investigator.NewDefaultRegistry()

// Investigate runs the configured registry against the target resource. The
// resource must be in the application's resource tree: a resource outside it
// gets the same error as one that does not exist, and no logs or events are
// read for it. Secret values are redacted in the diff the detectors see.
func (s *PaprikaServer) Investigate(
	ctx context.Context,
	req *connect.Request[paprikav1.InvestigateRequest],
) (*connect.Response[paprikav1.InvestigateResponse], error) {
	var app pipelinesv1alpha1.Application
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.ApplicationNamespace, Name: req.Msg.ApplicationName}, &app); err != nil {
		return nil, fmt.Errorf("getting application: %w", err)
	}
	if err := s.authorizeApplication(ctx, auth.ActionRead, &app); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}

	ns := req.Msg.ResourceNamespace
	if ns == "" {
		ns = app.Namespace
	}

	in := investigator.Input{
		Ref: investigator.ResourceRef{
			ApplicationNamespace: app.Namespace,
			ApplicationName:      app.Name,
			Kind:                 req.Msg.ResourceKind,
			Name:                 req.Msg.ResourceName,
			Namespace:            ns,
		},
		App: &app,
	}

	// Live state belongs to the cluster the application deploys to, not to the
	// cluster this server runs in. An investigation built from the management
	// cluster's objects would describe a different deployment that happens to
	// share names.
	target, err := s.applicationTargetCluster(ctx, &app)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnavailable,
			fmt.Errorf("investigate %s/%s: %w", app.Namespace, app.Name, err))
	}
	if target.agent {
		// The detectors need live state — ready replicas, container statuses,
		// events, logs. Reporting "all clear" from an empty live manifest would be
		// worse than refusing, because it reads as a healthy deployment.
		return nil, connect.NewError(connect.CodeUnavailable,
			fmt.Errorf("investigate %s/%s: %w: %s is reached through a satellite, which does not serve live reads yet",
				app.Namespace, app.Name, ErrTargetUnavailable, target.label))
	}

	// An application-level investigation names no resource. Nothing about a
	// resource is read for it, and the detectors run on the application alone.
	// Otherwise the tree check runs first. An out-of-tree resource is never
	// returned or used: its owner objects may be read to place it in the tree,
	// but nothing about it reaches the detectors.
	dyn := s.targetDynamicClientOrNil(ctx, target, nil)
	typed := s.targetTypedClientOrNil(ctx, target, nil)
	live, err := investigatorLive(ctx, &app, dyn, typed, targetMapper(s, target),
		req.Msg.ResourceKind, req.Msg.ResourceName, ns)
	if err != nil {
		return nil, err
	}
	if live != nil {
		in.LiveManifest = live
	}

	// investigatorDiff redacts the live object, so it is safe to hand to the detectors.
	in.Diff = s.investigatorDiff(ctx, &app, req.Msg.ResourceKind, req.Msg.ResourceName, live)
	if req.Msg.ResourceName != "" {
		in.Events = fetchInvestigatorEvents(ctx, typed, req.Msg.ResourceKind, req.Msg.ResourceName, ns)
	}
	in.Logs = investigatorLogs(ctx, typed, req.Msg.ResourceKind, req.Msg.ResourceName, ns, live)

	resp, err := investigatorRegistry.Investigate(ctx, in)
	if err != nil {
		return nil, fmt.Errorf("investigator: %w", err)
	}

	return connect.NewResponse(toProtoInvestigateResponse(resp)), nil
}

// ListInvestigatorPlugins returns the registered plugin set for clients to
// display ("Detectors: 8 · Sources: 3").
func (s *PaprikaServer) ListInvestigatorPlugins(
	ctx context.Context,
	_ *connect.Request[paprikav1.ListInvestigatorPluginsRequest],
) (*connect.Response[paprikav1.ListInvestigatorPluginsResponse], error) {
	sources := investigatorRegistry.Sources()
	detectors := investigatorRegistry.Detectors()
	narrators := investigatorRegistry.Narrators()
	plugins := make([]*paprikav1.PluginInfo, 0, len(sources)+len(detectors)+len(narrators))
	for _, src := range sources {
		plugins = append(plugins, &paprikav1.PluginInfo{Name: src.Name(), Type: "source"})
	}
	for _, det := range detectors {
		plugins = append(plugins, &paprikav1.PluginInfo{Name: det.ID(), Type: "detector"})
	}
	for _, narr := range narrators {
		plugins = append(plugins, &paprikav1.PluginInfo{Name: narr.Name(), Type: "narrator"})
	}
	// Deterministic ordering for stable UI rendering.
	sort.Slice(plugins, func(i, j int) bool {
		if plugins[i].Type != plugins[j].Type {
			return plugins[i].Type < plugins[j].Type
		}
		return plugins[i].Name < plugins[j].Name
	})
	return connect.NewResponse(&paprikav1.ListInvestigatorPluginsResponse{Plugins: plugins}), nil
}

// investigatorLive reads the live object an investigation names, when the
// application's tree holds it. The object is raw and must be redacted before use.
// An application-level investigation names no resource, so it reads none and
// returns no object.
func investigatorLive(
	ctx context.Context,
	app *pipelinesv1alpha1.Application,
	dyn dynamic.Interface,
	typed kubernetes.Interface,
	mapper meta.RESTMapper,
	kind, name, namespace string,
) (*unstructured.Unstructured, error) {
	if name == "" {
		return nil, nil
	}
	live, _, err := readTreeResource(ctx, app, dyn, typed, mapper, kind, name, namespace)
	return live, err
}

// investigatorDiff renders the desired vs. live diff. The live object is redacted
// in place with its desired object, so its Secret values are gone before any
// detector sees it, and a value-only change to a Secret still gives a diff. It
// returns "" when the desired object is missing.
func (s *PaprikaServer) investigatorDiff(ctx context.Context, app *pipelinesv1alpha1.Application, kind, name string, live *unstructured.Unstructured) string {
	if live == nil {
		return ""
	}
	desired := s.desiredObjectOrNil(ctx, app, kind, name)
	redactManifestPair(desired, live.Object)
	if desired == nil {
		return ""
	}
	desiredYAML, liveYAML := manifestsToYAML(desired, live)
	if desiredYAML == "" || liveYAML == "" {
		return ""
	}
	return unifiedDiff(desiredYAML, liveYAML)
}

// fetchInvestigatorEvents lists the recent events for a resource the tree holds.
// A nil typed client, for an unreachable destination, lists nothing.
func fetchInvestigatorEvents(ctx context.Context, typedClient kubernetes.Interface, kind, name, namespace string) []investigator.KubernetesEvent {
	if typedClient == nil {
		return nil
	}
	fieldSelector := fmt.Sprintf("involvedObject.kind=%s,involvedObject.name=%s", kind, name)
	if namespace != "" {
		fieldSelector += ",involvedObject.namespace=" + namespace
	}
	list, err := typedClient.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
		FieldSelector: fieldSelector,
		Limit:         investigatorEventsLimit,
	})
	if err != nil {
		return nil
	}
	// Newest first; capped.
	sort.SliceStable(list.Items, func(i, j int) bool {
		return list.Items[i].LastTimestamp.After(list.Items[j].LastTimestamp.Time)
	})
	if len(list.Items) > investigatorEventsLimit {
		list.Items = list.Items[:investigatorEventsLimit]
	}
	out := make([]investigator.KubernetesEvent, 0, len(list.Items))
	for i := range list.Items {
		e := &list.Items[i]
		out = append(out, investigator.KubernetesEvent{
			Type:            e.Type,
			Reason:          e.Reason,
			Message:         e.Message,
			LastTimestamp:   e.LastTimestamp.UTC().Format("2006-01-02T15:04:05Z"),
			Count:           e.Count,
			ObjectKind:      e.InvolvedObject.Kind,
			ObjectName:      e.InvolvedObject.Name,
			ObjectNamespace: e.InvolvedObject.Namespace,
		})
	}
	return out
}

// investigatorLogs returns the tail of a pod's logs. Only a Pod has logs, and only
// when readTreeResource returned it: a non-nil live object is a pod the tree holds,
// already read and checked, so its logs are read without a second lookup. A nil
// live object (no object, or a managed pod that is gone) has no logs.
func investigatorLogs(
	ctx context.Context,
	typedClient kubernetes.Interface,
	kind, name, namespace string,
	live *unstructured.Unstructured,
) []string {
	if kind != "Pod" || typedClient == nil || live == nil {
		return nil
	}
	return fetchInvestigatorLogs(ctx, typedClient, namespace, name)
}

// fetchInvestigatorLogs reads the tail of one pod's logs. An unreadable log
// yields no lines.
func fetchInvestigatorLogs(ctx context.Context, typedClient kubernetes.Interface, namespace, name string) []string {
	tail := int64(investigatorLogsTailLines)
	logs, err := typedClient.CoreV1().Pods(namespace).GetLogs(name, &corev1.PodLogOptions{TailLines: &tail}).Stream(ctx)
	if err != nil {
		return nil
	}
	defer func() {
		if closeErr := logs.Close(); closeErr != nil {
			_ = closeErr
		}
	}()
	data, err := io.ReadAll(logs)
	if err != nil {
		return nil
	}
	if len(data) == 0 {
		return nil
	}
	return strings.Split(string(data), "\n")
}

// toProtoInvestigateResponse converts the engine's Response to the proto wire
// shape (and stamps the generated-at timestamp).
func toProtoInvestigateResponse(r *investigator.Response) *paprikav1.InvestigateResponse {
	out := &paprikav1.InvestigateResponse{
		Summary:       r.Summary,
		Narrator:      r.Narrator,
		GeneratedAtMs: generatedAtMS(r),
	}
	for _, f := range r.Findings {
		out.Findings = append(out.Findings, &paprikav1.InvestigationFinding{
			Id:          f.ID,
			Severity:    paprikav1.Severity(f.Severity),
			Title:       f.Title,
			Description: f.Description,
			Evidence:    evidenceToProto(f.Evidence),
			Playbook:    append([]string(nil), f.Playbook...),
		})
	}
	return out
}

func generatedAtMS(r *investigator.Response) uint64 {
	if r != nil && r.GeneratedAtMS > 0 {
		return uint64(r.GeneratedAtMS)
	}
	now := time.Now().UnixMilli()
	if now <= 0 {
		return 0
	}
	return uint64(now)
}

func evidenceToProto(ev []investigator.Evidence) []*paprikav1.FindingEvidence {
	out := make([]*paprikav1.FindingEvidence, 0, len(ev))
	for _, e := range ev {
		out = append(out, &paprikav1.FindingEvidence{
			Source:    e.Source,
			Timestamp: e.Timestamp,
			Summary:   e.Summary,
		})
	}
	return out
}

package apiserver

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"

	"connectrpc.com/connect"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
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

// Investigate runs the configured registry against the target resource.
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

	live, _, err := s.fetchInvestigatorLiveManifest(ctx, req.Msg.ResourceKind, req.Msg.ResourceName, ns)
	if err == nil {
		in.LiveManifest = live
	}

	in.Diff = s.fetchInvestigatorDiff(ctx, &app, req.Msg.ResourceKind, req.Msg.ResourceName, ns)
	in.Events = s.fetchInvestigatorEvents(ctx, req.Msg.ResourceKind, req.Msg.ResourceName, ns)
	in.Logs = s.fetchInvestigatorLogs(ctx, req.Msg.ResourceKind, req.Msg.ResourceName, ns)

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
	var plugins []*paprikav1.PluginInfo
	for _, src := range investigatorRegistry.Sources() {
		plugins = append(plugins, &paprikav1.PluginInfo{Name: src.Name(), Type: "source"})
	}
	for _, det := range investigatorRegistry.Detectors() {
		plugins = append(plugins, &paprikav1.PluginInfo{Name: det.ID(), Type: "detector"})
	}
	for _, narr := range investigatorRegistry.Narrators() {
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

// fetchInvestigatorLiveManifest retrieves the live unstructured manifest for
// the given resource via the dynamic client. Returns nil, nil if unavailable.
func (s *PaprikaServer) fetchInvestigatorLiveManifest(ctx context.Context, kind, name, namespace string) (*unstructured.Unstructured, string, error) {
	if s.dynamicClient == nil {
		return nil, "", nil
	}
	gvr, ok := knownResourceGVRs[kind]
	if !ok {
		return nil, "", fmt.Errorf("unknown kind %q", kind)
	}
	resource := s.dynamicClient.Resource(gvr)
	var obj *unstructured.Unstructured
	if gvr.Group == "" && gvr.Resource == "namespaces" {
		got, err := resource.Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, "", fmt.Errorf("get live %s/%s: %w", kind, name, err)
		}
		obj = got
	} else {
		got, err := resource.Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, "", fmt.Errorf("get live %s/%s/%s: %w", kind, namespace, name, err)
		}
		obj = got
	}
	yaml, err := manifestToYAML(obj.Object)
	if err != nil {
		return obj, "", err
	}
	return obj, yaml, nil
}

// fetchInvestigatorDiff renders the desired vs. live diff using the
// existing resource_handler helpers. Returns "" if anything is missing.
func (s *PaprikaServer) fetchInvestigatorDiff(ctx context.Context, app *pipelinesv1alpha1.Application, kind, name, namespace string) string {
	if s.renderer == nil {
		return ""
	}
	desired, err := s.getDesiredManifest(ctx, app, kind, name)
	if err != nil {
		return ""
	}
	live, err := s.getLiveManifestYAML(ctx, kind, name, namespace)
	if err != nil {
		return ""
	}
	return unifiedDiff(desired, live)
}

func (s *PaprikaServer) getLiveManifestYAML(ctx context.Context, kind, name, namespace string) (string, error) {
	if s.dynamicClient == nil {
		return "", errors.New("no dynamic client")
	}
	_, yaml, err := s.fetchInvestigatorLiveManifest(ctx, kind, name, namespace)
	if err != nil {
		return "", err
	}
	return yaml, nil
}

func (s *PaprikaServer) fetchInvestigatorEvents(ctx context.Context, kind, name, namespace string) []investigator.KubernetesEvent {
	if s.k8sClient == nil {
		return nil
	}
	fieldSelector := fmt.Sprintf("involvedObject.kind=%s,involvedObject.name=%s", kind, name)
	if namespace != "" {
		fieldSelector += ",involvedObject.namespace=" + namespace
	}
	list, err := s.k8sClient.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
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
	for _, e := range list.Items {
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

func (s *PaprikaServer) fetchInvestigatorLogs(ctx context.Context, kind, name, namespace string) []string {
	if s.k8sClient == nil || kind != "Pod" {
		return nil
	}
	tail := int64(investigatorLogsTailLines)
	logs, err := s.k8sClient.CoreV1().Pods(namespace).GetLogs(name, &corev1.PodLogOptions{TailLines: &tail}).Stream(ctx)
	if err != nil {
		return nil
	}
	defer logs.Close()
	data, _ := io.ReadAll(logs)
	if len(data) == 0 {
		return nil
	}
	return strings.Split(string(data), "\n")
}

// toProtoInvestigateResponse converts the engine's Response to the proto wire
// shape (and stamps the generated-at timestamp).
func toProtoInvestigateResponse(r *investigator.Response) *paprikav1.InvestigateResponse {
	out := &paprikav1.InvestigateResponse{
		Summary:  r.Summary,
		Narrator: r.Narrator,
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

package observabilitygateway

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	"github.com/go-logr/logr"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	observabilityv1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// defaultCredentialsKey is the Secret key resolveCredentials reads when
// spec.credentialsSecretRef.key is empty.
const defaultCredentialsKey = "credentials"

// Fixed sentences a failed query reports as its Reason, chosen by sentinel
// and never carrying backend output: endpoint URLs and response bodies can
// hold credential material, so detail belongs in the gateway log, not in a
// result a status field or tool response renders. This is the same sanitize
// discipline the connector package documents on QueryResult and the
// clusterprovider package applies to its provider states.
const (
	reasonForbidden      = "observability backend refused the configured credentials"
	reasonNotConfigured  = "provider is not fully configured"
	reasonNotAvailable   = "observability backend path not available"
	reasonQueryFailed    = "observability backend query failed"
	reasonShapeSupported = "query shape is not supported by this connector"
)

// ProviderInfo is the public, credential-free description of one
// ObservabilityProvider CR.
type ProviderInfo struct {
	Name      string `json:"name"`      // "namespace/name" — the identifier tools accept
	Namespace string `json:"namespace"` // the CR's own namespace
	Type      string `json:"type"`      // prometheus | loki | tempo | otlp | gcp-cloudlogging | gcp-cloudmonitoring | gcp-cloudtrace | aws-cloudwatch-logs | aws-cloudwatch-metrics | aws-xray | aws-cloudtrail | mock
	State     string `json:"state,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// Backend resolves ObservabilityProvider CRs into connector queries. It is
// the seam between the Kubernetes objects and the connector framework: tools
// and handlers talk to a Backend, never to a client.Client or a Connector
// directly.
type Backend interface {
	// ListProviders lists every ObservabilityProvider visible to the
	// underlying client (RBAC bounds the visibility), as the public,
	// credential-free summary each tool result renders.
	ListProviders(ctx context.Context) ([]ProviderInfo, error)
	// Query runs one request against the provider named "namespace/name".
	// Backend failures come back as a QueryResult with a fixed-sentence
	// Reason and a nil error; the error return is reserved for caller bugs
	// (bad provider reference, unknown type, missing credentials secret),
	// reported as connect codes the MCP invoker maps onto wire errors.
	Query(ctx context.Context, provider string, req connector.QueryRequest) (*connector.QueryResult, error)
	// Explore enumerates one slice of the provider named "namespace/name"
	// schema — metric names, labels, label values, metadata or trace
	// services — so callers can work out what to query. A provider whose
	// connector does not implement schema exploration answers
	// StateNotAvailable in the result, not an error; the error return is
	// reserved for the same caller bugs as Query.
	Explore(ctx context.Context, provider string, req connector.ExploreRequest) (*connector.ExploreResult, error)
}

// k8sBackend is the production Backend: one controller-runtime client, and
// no held connector state — connectors are built per call (they are
// stateless structs; everything a query needs travels in the request).
type k8sBackend struct {
	client client.Client

	// newConnector builds the Connector for a provider type. It exists so
	// tests can substitute a stub at exactly the point where Query's result
	// mapping happens; production wiring leaves it nil and the fallback
	// calls New, satisfying the per-call construction contract.
	newConnector func(providerType string) (connector.Connector, error)
}

// NewBackend returns the Backend backed by client. Connector instances are
// built from this package's own New per Query call — they are stateless, so
// nothing is worth caching, and per-call state travels in QueryRequest.
func NewBackend(client client.Client) Backend {
	return &k8sBackend{client: client}
}

// NewConnectorRegistry registers the twelve built-in connectors. It is the
// wiring used by cmd/webhook (which validates spec.config with the same
// per-type switch New uses) and by unit tests; the query path itself goes
// through New per call rather than through this registry.
func NewConnectorRegistry() *connector.Registry {
	reg := connector.NewRegistry()
	for _, providerType := range []string{
		connector.ProviderPrometheus,
		connector.ProviderLoki,
		connector.ProviderTempo,
		connector.ProviderOTLP,
		connector.ProviderGCPCloudLogging,
		connector.ProviderGCPCloudMonitoring,
		connector.ProviderGCPCloudTrace,
		connector.ProviderAWSCloudWatchLogs,
		connector.ProviderAWSCloudWatchMetrics,
		connector.ProviderAWSXRay,
		connector.ProviderAWSCloudTrail,
		connector.ProviderVultrMonitoring,
		connector.ProviderMock,
	} {
		conn, err := New(providerType)
		if err != nil {
			// Unreachable: providerType is always one of New's switch cases.
			panic(fmt.Sprintf("observabilitygateway: built-in connector %q: %v", providerType, err))
		}
		if err := reg.Register(conn); err != nil {
			// Unreachable: the twelve built-ins advertise distinct names.
			panic(fmt.Sprintf("observabilitygateway: register built-in connector %q: %v", providerType, err))
		}
	}
	return reg
}

// ListProviders implements Backend. Status fields the CR does not carry stay
// empty strings — this layer never invents a state.
func (b *k8sBackend) ListProviders(ctx context.Context) ([]ProviderInfo, error) {
	var list observabilityv1alpha1.ObservabilityProviderList
	if err := b.client.List(ctx, &list); err != nil {
		return nil, fmt.Errorf("list observability providers: %w", err)
	}
	out := make([]ProviderInfo, 0, len(list.Items))
	for i := range list.Items {
		cr := &list.Items[i]
		out = append(out, ProviderInfo{
			Name:      cr.Namespace + "/" + cr.Name,
			Namespace: cr.Namespace,
			Type:      cr.Spec.Type,
			State:     cr.Status.State,
			Reason:    cr.Status.Reason,
		})
	}
	return out, nil
}

// Query implements Backend. provider is "namespace/name"; anything that does
// not split that way, does not resolve to a CR, or names a type New does not
// know is a caller bug and becomes a connect error. Everything past that —
// credential resolution failures included — is a precondition problem
// (FailedPrecondition) or travels inside the QueryResult, so a tool call
// surfaces "the provider refused my credentials" as data rather than as a
// transport error.
//
//nolint:gocritic // req travels by value because the Backend contract says so; QueryRequest holds only per-call state built fresh by each caller.
func (b *k8sBackend) Query(ctx context.Context, provider string, req connector.QueryRequest) (*connector.QueryResult, error) {
	log := logr.FromContextOrDiscard(ctx)

	namespace, name, found := strings.Cut(provider, "/")
	if !found || namespace == "" || name == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("provider must be %q, got %q", "namespace/name", provider))
	}

	var cr observabilityv1alpha1.ObservabilityProvider
	if err := b.client.Get(ctx, types.NamespacedName{Namespace: namespace, Name: name}, &cr); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, connect.NewError(connect.CodeNotFound,
				fmt.Errorf("observability provider %s not found", provider))
		}
		return nil, fmt.Errorf("get observability provider %s: %w", provider, err)
	}

	conn, err := b.connectorFor(cr.Spec.Type)
	if err != nil {
		// The webhook's validator is the first line against a bad type;
		// this is defense in depth for CRs it never saw.
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}

	credentials, err := b.resolveCredentials(ctx, &cr)
	if err != nil {
		return nil, err
	}

	result, err := conn.Query(ctx, connector.QueryRequest{
		Signal:      req.Signal,
		Query:       req.Query,
		TraceID:     req.TraceID,
		Range:       req.Range,
		Limit:       req.Limit,
		Config:      cr.Spec.Config.Raw,
		Credentials: credentials,
	})
	return finishQuery(log, provider, cr.Spec.Type, result, err)
}

// Explore implements Backend.Explore. The provider resolution, connector
// construction and credential resolution mirror Query; the one difference is
// the optional Explorer assertion — a connector without schema exploration
// answers StateNotAvailable in the result (the provider is fine, the
// capability is absent), which is data, not a caller bug.
//
//nolint:gocritic // req travels by value because the Backend contract says so; ExploreRequest holds only per-call state built fresh by each caller.
func (b *k8sBackend) Explore(ctx context.Context, provider string, req connector.ExploreRequest) (*connector.ExploreResult, error) {
	log := logr.FromContextOrDiscard(ctx)

	namespace, name, found := strings.Cut(provider, "/")
	if !found || namespace == "" || name == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("provider must be %q, got %q", "namespace/name", provider))
	}

	var cr observabilityv1alpha1.ObservabilityProvider
	if err := b.client.Get(ctx, types.NamespacedName{Namespace: namespace, Name: name}, &cr); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, connect.NewError(connect.CodeNotFound,
				fmt.Errorf("observability provider %s not found", provider))
		}
		return nil, fmt.Errorf("get observability provider %s: %w", provider, err)
	}

	conn, err := b.connectorFor(cr.Spec.Type)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	explorer, ok := conn.(connector.Explorer)
	if !ok {
		return &connector.ExploreResult{
			State:  connector.StateNotAvailable,
			Reason: fmt.Sprintf("provider type %q does not support schema exploration", cr.Spec.Type),
		}, nil
	}

	credentials, err := b.resolveCredentials(ctx, &cr)
	if err != nil {
		return nil, err
	}

	result, err := explorer.Explore(ctx, connector.ExploreRequest{
		Kind:        req.Kind,
		Metric:      req.Metric,
		Label:       req.Label,
		Prefix:      req.Prefix,
		Limit:       req.Limit,
		Params:      req.Params,
		Config:      cr.Spec.Config.Raw,
		Credentials: credentials,
	})
	return finishExplore(log, provider, cr.Spec.Type, result, err)
}

// finishExplore maps one Explorer outcome onto what Backend.Explore returns,
// mirroring finishQuery: a result travels as-is, an error alone is classified
// onto a fixed-sentence state.
func finishExplore(log logr.Logger, provider, connectorType string, result *connector.ExploreResult, err error) (*connector.ExploreResult, error) {
	if result != nil {
		if err != nil {
			log.Info("observability connector returned an exploration result alongside an error",
				"provider", provider, "connector", connectorType, "error", err.Error())
		}
		return result, nil
	}
	if err == nil {
		log.Info("observability connector returned no exploration result and no error",
			"provider", provider, "connector", connectorType)
		return &connector.ExploreResult{State: connector.StateError, Reason: reasonQueryFailed}, nil
	}
	log.Info("observability backend exploration failed", "provider", provider, "connector", connectorType, "error", err.Error())
	return &connector.ExploreResult{State: sentinelState(err), Reason: sentinelReason(err)}, nil
}

// finishQuery maps one connector outcome onto what Backend.Query returns.
// A result travels as-is (a dual result+error is the unsupported-shape
// contract: log the error, hand back the result); an error alone is
// classified onto a fixed-sentence state, with the raw text going to the log
// only; neither is a connector contract violation and becomes a generic
// failure rather than a nil the caller would dereference.
func finishQuery(log logr.Logger, provider, connectorType string, result *connector.QueryResult, err error) (*connector.QueryResult, error) {
	if result != nil {
		if err != nil {
			log.Info("observability connector returned a result alongside an error",
				"provider", provider, "connector", connectorType, "error", err.Error())
		}
		return result, nil
	}
	if err == nil {
		log.Info("observability connector returned no result and no error",
			"provider", provider, "connector", connectorType)
		return &connector.QueryResult{State: connector.StateError, Reason: reasonQueryFailed}, nil
	}
	log.Info("observability backend query failed", "provider", provider, "connector", connectorType, "error", err.Error())
	return &connector.QueryResult{State: sentinelState(err), Reason: sentinelReason(err)}, nil
}

// connectorFor builds the Connector for providerType, through the test seam
// when one is installed.
func (b *k8sBackend) connectorFor(providerType string) (connector.Connector, error) {
	if b.newConnector != nil {
		return b.newConnector(providerType)
	}
	return New(providerType)
}

// resolveCredentials returns the credential document the CR's
// credentialsSecretRef points at, applying the field defaults (namespace
// falls back to the CR's own, key falls back to "credentials"). A nil ref is
// not an error: backends that accept ambient or anonymous access need none.
// A missing Secret is a FailedPrecondition — the reference names something
// that does not exist, so the caller should fix the CR, not retry.
func (b *k8sBackend) resolveCredentials(ctx context.Context, cr *observabilityv1alpha1.ObservabilityProvider) ([]byte, error) {
	ref := cr.Spec.CredentialsSecretRef
	if ref == nil {
		return nil, nil
	}
	namespace := ref.Namespace
	if namespace == "" {
		namespace = cr.Namespace
	}
	key := ref.Key
	if key == "" {
		key = defaultCredentialsKey
	}
	var secret corev1.Secret
	err := b.client.Get(ctx, types.NamespacedName{Namespace: namespace, Name: ref.Name}, &secret)
	if apierrors.IsNotFound(err) {
		return nil, connect.NewError(connect.CodeFailedPrecondition,
			fmt.Errorf("credentials secret %s/%s not found", namespace, ref.Name))
	}
	if err != nil {
		return nil, fmt.Errorf("get credentials secret %s/%s: %w", namespace, ref.Name, err)
	}
	return secret.Data[key], nil
}

// sentinelState maps an error a connector returned without a result onto the
// query-state vocabulary. Only sentinel classifications reach the caller;
// anything unrecognized is a generic StateError.
func sentinelState(err error) connector.State {
	switch {
	case errors.Is(err, connector.ErrForbidden):
		return connector.StateForbidden
	case errors.Is(err, connector.ErrNotConfigured):
		return connector.StateNotConfigured
	case errors.Is(err, connector.ErrUnsupported):
		return connector.StateNotAvailable
	case errors.Is(err, connector.ErrNotAvailable):
		return connector.StateNotAvailable
	default:
		return connector.StateError
	}
}

// sentinelReason is the fixed sentence paired with sentinelState. The
// sentences are deliberately closed and generic — the raw error text went to
// the log at the call site, never into a reason.
func sentinelReason(err error) string {
	switch {
	case errors.Is(err, connector.ErrForbidden):
		return reasonForbidden
	case errors.Is(err, connector.ErrNotConfigured):
		return reasonNotConfigured
	case errors.Is(err, connector.ErrUnsupported):
		return reasonShapeSupported
	case errors.Is(err, connector.ErrNotAvailable):
		return reasonNotAvailable
	default:
		return reasonQueryFailed
	}
}

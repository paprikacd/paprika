package apiserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"connectrpc.com/connect"
	"github.com/go-logr/logr"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/validation"

	observabilityv1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// Observability provider library and lifecycle surface: the gateway's
// provider-type catalog (library browser), the health-preflight probe the
// onboarding wizard runs before committing credentials, and the first
// resource-creation RPC on this service, CreateObservabilityProvider.
//
// The three read surfaces proxy the gateway exactly like GetObservabilityUsage
// does — one minted paprika-observability token per call, decoded into the
// local wire structs below — and inherit the file header contract of
// observability_providers.go: nothing here imports
// internal/observabilitygateway or internal/api/mcp (the mcp test files
// import this package, so either import is a toolchain-rejected cycle), the
// gateway vocabulary is restated as literals, and the gateway remains the
// runtime verifier of the audience and scope strings.
//
// CreateObservabilityProvider is different in kind: it writes cluster
// control-plane config (the ObservabilityProvider CR and, when the caller
// supplies a credential document, the Secret it references), so it does not
// touch the gateway at all — the admission webhook on the CR validates type
// and config against the connector registry at apply time, which is the
// enum check this surface deliberately does not duplicate.

// Canonical sentences for the library and preflight surfaces, authored as
// literals in the console_stub.go grammar — what is missing, then what to do
// about it — and never derived from a gateway error, so no reason can leak
// the cluster-internal gateway address or backend detail.
const (
	observabilityCatalogUnavailableReason = "observability gateway is not configured; " +
		"enable it to browse the observability provider library"
	observabilityCatalogErrorReason = "observability gateway is unavailable; " +
		"retry, and check the gateway logs if it persists"
)

// Identity of the CR the create RPC writes, restated here because an API
// projection may not import the controller packages that carry the scheme.
const (
	observabilityProviderAPIVersion = "observability.paprika.io/v1alpha1"
	observabilityProviderKind       = "ObservabilityProvider"
	// observabilityCredentialSecretKey is the Secret key the
	// credentialsSecretRef convention defaults to (see
	// CredentialsSecretRef.Key in api/observability/v1alpha1); the create RPC
	// names it explicitly so the ref reads back self-contained.
	observabilityCredentialSecretKey = "credentials"
)

// catalogTypesJSON mirrors the gateway's GET /observe/api/catalog response
// ({"types": [...]}) for the cycle reason in the file header.
type catalogTypesJSON struct {
	Types []catalogTypeSummaryJSON `json:"types"`
}

// catalogTypeSummaryJSON mirrors catalog.TypeSummary's camelCase wire shape.
type catalogTypeSummaryJSON struct {
	Type        string   `json:"type"`
	DisplayName string   `json:"displayName"`
	Vendor      string   `json:"vendor"`
	Category    string   `json:"category"`
	Signals     []string `json:"signals"`
	Summary     string   `json:"summary"`
}

// catalogTypeJSON mirrors catalog.TypeInfo's camelCase wire shape: the
// summary fields plus the config schema, credential shape, onboarding steps
// and probe shape the onboarding wizard renders.
type catalogTypeJSON struct {
	Type         string                 `json:"type"`
	DisplayName  string                 `json:"displayName"`
	Vendor       string                 `json:"vendor"`
	Category     string                 `json:"category"`
	Signals      []string               `json:"signals"`
	Summary      string                 `json:"summary"`
	Description  string                 `json:"description"`
	ConfigFields []catalogTypeFieldJSON `json:"configFields"`
	Credential   catalogTypeCredJSON    `json:"credential"`
	Steps        []catalogTypeStepJSON  `json:"steps"`
	Probe        catalogTypeProbeJSON   `json:"probe"`
}

type catalogTypeFieldJSON struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Input       string `json:"input"`
	Required    bool   `json:"required"`
	Placeholder string `json:"placeholder"`
	Help        string `json:"help"`
	Secret      bool   `json:"secret"`
}

type catalogTypeCredJSON struct {
	Kind string `json:"kind"`
	Help string `json:"help"`
}

type catalogTypeStepJSON struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	Code  string `json:"code"`
}

type catalogTypeProbeJSON struct {
	Signal string `json:"signal"`
	Note   string `json:"note"`
}

// validateRequestJSON mirrors the gateway's POST /observe/api/validate body.
// Config stays raw so an absent config encodes as the absent key — the
// gateway reads that as "not configured" and answers with the NotConfigured
// verdict rather than a malformed-request error.
type validateRequestJSON struct {
	Type   string          `json:"type"`
	Config json.RawMessage `json:"config,omitempty"`
}

// validateResultJSON mirrors the gateway's validateResponse: the probe's
// verdict travels as data, never as an HTTP error, so a Forbidden verdict
// (a backend that refuses the credential) maps straight through.
type validateResultJSON struct {
	State  string `json:"state"`
	Reason string `json:"reason"`
}

// ListObservabilityProviderTypes serves the gateway's provider-type library —
// one light summary per backend the gateway can connect to, in the catalog's
// deterministic Vendor-then-DisplayName order — through one short-lived
// proxied call.
//
// Authorization follows the install-level-inventory precedent the other
// observability surfaces set (ListObservabilityProviders): these entries are
// read-only gateway metadata, not tenant topology, and no per-namespace
// decision exists to make, so no fleet-scope prologue runs here.
//
// A missing gateway address answers the canonical NOT_CONFIGURED shell; a
// gateway-reachability failure answers DATA_STATE_ERROR with the fixed
// sentence — never the gateway body.
func (s *PaprikaServer) ListObservabilityProviderTypes(
	ctx context.Context,
	req *connect.Request[paprikav1.ListObservabilityProviderTypesRequest],
) (*connect.Response[paprikav1.ListObservabilityProviderTypesResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	if s.observabilityGatewayAddr == "" {
		return connect.NewResponse(notConfiguredObservabilityCatalogTypes()), nil
	}

	var catalog catalogTypesJSON
	if err := s.callObservabilityGateway(ctx, http.MethodGet, observabilityGatewayCatalogPath, nil, &catalog); err != nil {
		return connect.NewResponse(&paprikav1.ListObservabilityProviderTypesResponse{
			State:             paprikav1.DataState_DATA_STATE_ERROR,
			UnavailableReason: observabilityCatalogErrorReason,
			Types:             []*paprikav1.ProviderTypeSummary{},
		}), nil
	}

	types := make([]*paprikav1.ProviderTypeSummary, 0, len(catalog.Types))
	for i := range catalog.Types {
		types = append(types, providerTypeSummary(&catalog.Types[i]))
	}
	return connect.NewResponse(&paprikav1.ListObservabilityProviderTypesResponse{
		State: paprikav1.DataState_DATA_STATE_OK,
		Types: types,
	}), nil
}

// notConfiguredObservabilityCatalogTypes is the NOT_CONFIGURED shell the
// library list degrades to: a well-formed empty page stamped with the one
// canonical sentence, matching every other gateway-backed surface.
func notConfiguredObservabilityCatalogTypes() *paprikav1.ListObservabilityProviderTypesResponse {
	return &paprikav1.ListObservabilityProviderTypesResponse{
		State:             paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
		UnavailableReason: observabilityCatalogUnavailableReason,
		Types:             []*paprikav1.ProviderTypeSummary{},
	}
}

// providerTypeSummary projects one gateway summary entry onto the console
// wire shape. The projection is 1:1 — every field the gateway serves has a
// home here — so no gateway metadata is silently dropped.
func providerTypeSummary(summary *catalogTypeSummaryJSON) *paprikav1.ProviderTypeSummary {
	return &paprikav1.ProviderTypeSummary{
		Type:        summary.Type,
		DisplayName: summary.DisplayName,
		Vendor:      summary.Vendor,
		Category:    summary.Category,
		Signals:     append([]string{}, summary.Signals...),
		Summary:     summary.Summary,
	}
}

// GetObservabilityProviderType serves the full library entry for one
// provider type — display metadata, config-field schema, credential shape,
// onboarding walkthrough and probe shape — through one short-lived proxied
// call.
//
// An unknown type is a 404 on the gateway; like every gateway failure it
// answers DATA_STATE_ERROR with the fixed sentence rather than echoing the
// gateway's error body — the catalog list already tells the caller which
// types exist.
func (s *PaprikaServer) GetObservabilityProviderType(
	ctx context.Context,
	req *connect.Request[paprikav1.GetObservabilityProviderTypeRequest],
) (*connect.Response[paprikav1.GetObservabilityProviderTypeResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	if req.Msg.Type == "" {
		return nil, fleetInvalidArgument("type is required")
	}
	if s.observabilityGatewayAddr == "" {
		return connect.NewResponse(&paprikav1.GetObservabilityProviderTypeResponse{
			State:             paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
			UnavailableReason: observabilityCatalogUnavailableReason,
		}), nil
	}

	var detail catalogTypeJSON
	path := observabilityGatewayCatalogPath + "/" + req.Msg.Type
	if err := s.callObservabilityGateway(ctx, http.MethodGet, path, nil, &detail); err != nil {
		return connect.NewResponse(&paprikav1.GetObservabilityProviderTypeResponse{
			State:             paprikav1.DataState_DATA_STATE_ERROR,
			UnavailableReason: observabilityCatalogErrorReason,
		}), nil
	}

	return connect.NewResponse(&paprikav1.GetObservabilityProviderTypeResponse{
		State:      paprikav1.DataState_DATA_STATE_OK,
		TypeDetail: providerTypeDetail(&detail),
	}), nil
}

// providerTypeDetail projects one full gateway library entry onto the console
// wire shape, sub-documents included. 1:1 like the summary projection.
func providerTypeDetail(detail *catalogTypeJSON) *paprikav1.ProviderTypeDetail {
	fields := make([]*paprikav1.ProviderTypeField, 0, len(detail.ConfigFields))
	for i := range detail.ConfigFields {
		fields = append(fields, &paprikav1.ProviderTypeField{
			Key:         detail.ConfigFields[i].Key,
			Label:       detail.ConfigFields[i].Label,
			Input:       detail.ConfigFields[i].Input,
			Required:    detail.ConfigFields[i].Required,
			Placeholder: detail.ConfigFields[i].Placeholder,
			Help:        detail.ConfigFields[i].Help,
			Secret:      detail.ConfigFields[i].Secret,
		})
	}
	steps := make([]*paprikav1.ProviderTypeStep, 0, len(detail.Steps))
	for i := range detail.Steps {
		steps = append(steps, &paprikav1.ProviderTypeStep{
			Title: detail.Steps[i].Title,
			Body:  detail.Steps[i].Body,
			Code:  detail.Steps[i].Code,
		})
	}
	return &paprikav1.ProviderTypeDetail{
		Type:         detail.Type,
		DisplayName:  detail.DisplayName,
		Vendor:       detail.Vendor,
		Category:     detail.Category,
		Signals:      append([]string{}, detail.Signals...),
		Summary:      detail.Summary,
		Description:  detail.Description,
		ConfigFields: fields,
		Credential: &paprikav1.ProviderTypeCredential{
			Kind: detail.Credential.Kind,
			Help: detail.Credential.Help,
		},
		Steps: steps,
		Probe: &paprikav1.ProviderTypeProbe{
			Signal: detail.Probe.Signal,
			Note:   detail.Probe.Note,
		},
	}
}

// ValidateObservabilityProvider checks configuration syntax without backend I/O.
// The legacy credential field is never forwarded. Connectivity and permission
// validation require a query on an approved, namespace-authorized provider.
func (s *PaprikaServer) ValidateObservabilityProvider(
	ctx context.Context,
	req *connect.Request[paprikav1.ValidateObservabilityProviderRequest],
) (*connect.Response[paprikav1.ValidateObservabilityProviderResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	if req.Msg.Type == "" {
		return nil, fleetInvalidArgument("type is required")
	}
	configJSON, err := observabilityConfigObject(req.Msg.ConfigJson)
	if err != nil {
		return nil, err
	}
	if s.observabilityGatewayAddr == "" {
		return connect.NewResponse(&paprikav1.ValidateObservabilityProviderResponse{
			State:             paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
			UnavailableReason: observabilityCatalogUnavailableReason,
		}), nil
	}

	body := validateRequestJSON{Type: req.Msg.Type}
	if len(configJSON) > 0 {
		body.Config = json.RawMessage(configJSON)
	}
	var result validateResultJSON
	if err := s.callObservabilityGateway(ctx, http.MethodPost, observabilityGatewayValidatePath, body, &result); err != nil {
		return connect.NewResponse(&paprikav1.ValidateObservabilityProviderResponse{
			State:             paprikav1.DataState_DATA_STATE_ERROR,
			UnavailableReason: observabilityCatalogErrorReason,
		}), nil
	}

	return connect.NewResponse(&paprikav1.ValidateObservabilityProviderResponse{
		State:          paprikav1.DataState_DATA_STATE_OK,
		ConnectorState: result.State,
		Reason:         result.Reason,
	}), nil
}

// observabilityConfigObject checks that raw, when non-empty, is a JSON object
// and returns it trimmed. An empty document is not an error — the connectors
// read it as "not configured" and the gateway's probe reports the
// NotConfigured verdict — but a non-object (a string, an array, a number) can
// never be a connector config and is rejected here, before any gateway call
// or any CR write, with the same message shape every other field validation
// on this surface uses.
func observabilityConfigObject(raw []byte) ([]byte, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &obj); err != nil {
		return nil, fleetInvalidArgument("config_json must be a JSON object")
	}
	return trimmed, nil
}

// CreateObservabilityProvider creates an ObservabilityProvider CR — and, when
// the caller supplies a credential document, the Secret it references — in
// one request, so the onboarding wizard can land a working provider without
// a second kubectl step.
//
// Authorization follows the mutating-handler precedent (SyncApplication,
// ApproveGate): the target namespace is authorized with write on the
// observabilityproviders resource. Providers are control-plane config, not
// project-scoped workload objects, so the project clause is left empty and
// every rule's project match applies — namespace is the tenancy boundary
// this write crosses.
//
// Creation order is secret first, then CR: the CR's credentialsSecretRef
// must never name a Secret that does not exist, and a leftover Secret after
// a failed CR create is deleted best-effort so a rejected attempt leaves no
// credential material behind. The admission webhook on the CR — which checks
// spec.type against the connector enum and spec.config against the
// connector's own validation — is the enum check: its rejection message
// names keys, never values, so it is surfaced verbatim as InvalidArgument.
func (s *PaprikaServer) CreateObservabilityProvider(
	ctx context.Context,
	req *connect.Request[paprikav1.CreateObservabilityProviderRequest],
) (*connect.Response[paprikav1.CreateObservabilityProviderResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	msg := req.Msg
	configJSON, err := validateCreateObservabilityProviderRequest(msg)
	if err != nil {
		return nil, err
	}
	if authErr := s.authorizeProject(ctx, auth.ActionWrite, auth.ResourceObservabilityProviders, msg.Namespace, ""); authErr != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, authErr)
	}
	if s.client == nil {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("kubernetes client is not configured"))
	}

	secretName, secretCreated, err := s.createObservabilityCredentialSecretIfRequested(ctx, msg)
	if err != nil {
		return nil, err
	}

	provider := &observabilityv1alpha1.ObservabilityProvider{
		TypeMeta: metav1.TypeMeta{
			APIVersion: observabilityProviderAPIVersion,
			Kind:       observabilityProviderKind,
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      msg.Name,
			Namespace: msg.Namespace,
		},
		Spec: observabilityv1alpha1.ObservabilityProviderSpec{
			Type:   msg.Type,
			Config: runtime.RawExtension{Raw: configJSON},
		},
	}
	if secretCreated {
		provider.Spec.CredentialsSecretRef = &observabilityv1alpha1.CredentialsSecretRef{
			Name: secretName,
			Key:  observabilityCredentialSecretKey,
		}
	}

	if err := s.client.Create(ctx, provider); err != nil {
		if secretCreated {
			s.deleteObservabilityCredentialSecretBestEffort(ctx, msg.Namespace, secretName)
		}
		return nil, observabilityProviderCreateError(err)
	}

	return connect.NewResponse(&paprikav1.CreateObservabilityProviderResponse{
		Name:      msg.Name,
		Namespace: msg.Namespace,
	}), nil
}

// validateCreateObservabilityProviderRequest checks the create request's
// shape before any authorization or write: a valid DNS-1123 target, a
// non-empty connector type, and a config document that is either empty or a
// JSON object. The connector enum check deliberately does not happen here —
// the admission webhook owns it — so this validation names only malformed
// requests, never unknown types.
func validateCreateObservabilityProviderRequest(msg *paprikav1.CreateObservabilityProviderRequest) ([]byte, error) {
	if err := validateFleetObjectTarget(msg.Namespace, msg.Name, "name"); err != nil {
		return nil, err
	}
	if msg.Type == "" {
		return nil, fleetInvalidArgument("type is required")
	}
	return observabilityConfigObject(msg.ConfigJson)
}

// createObservabilityCredentialSecretIfRequested stores the credential
// document when one was supplied and reports the Secret name the CR should
// reference. An empty document means no Secret and no reference at all.
func (s *PaprikaServer) createObservabilityCredentialSecretIfRequested(
	ctx context.Context,
	msg *paprikav1.CreateObservabilityProviderRequest,
) (secretName string, created bool, err error) {
	if msg.CredentialDocument == "" {
		return "", false, nil
	}
	secretName = msg.CredentialSecretName
	if secretName == "" {
		secretName = msg.Name + "-credentials"
	}
	if problems := validation.IsDNS1123Subdomain(secretName); len(problems) != 0 {
		return "", false, fleetInvalidArgument("credential_secret_name must be a valid DNS-1123 subdomain")
	}
	if err = s.createObservabilityCredentialSecret(ctx, msg.Namespace, secretName, msg.CredentialDocument); err != nil {
		return "", false, err
	}
	return secretName, true, nil
}

// createObservabilityCredentialSecret stores the credential document as the
// credentials key of an opaque Secret. The document travels only as
// stringData — it is never echoed into an error, a log line, or a status.
// An existing Secret is not updated: overwriting a credential another
// consumer may be reading is a silent privilege change, so the caller gets
// AlreadyExists and must choose to rotate deliberately.
func (s *PaprikaServer) createObservabilityCredentialSecret(
	ctx context.Context, namespace, name, document string,
) error {
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
		},
		Type:       corev1.SecretTypeOpaque,
		StringData: map[string]string{observabilityCredentialSecretKey: document},
	}
	if err := s.client.Create(ctx, secret); err != nil {
		if apierrors.IsAlreadyExists(err) {
			return connect.NewError(connect.CodeAlreadyExists,
				fmt.Errorf("credential secret %s/%s already exists", namespace, name))
		}
		return fmt.Errorf("creating credential secret %s/%s: %w", namespace, name, err)
	}
	return nil
}

// deleteObservabilityCredentialSecretBestEffort removes a credential Secret
// created for a CR the admission webhook then rejected. The delete is
// best-effort: the create already failed and its error is what the caller
// sees; a leftover secret is logged, never hidden.
func (s *PaprikaServer) deleteObservabilityCredentialSecretBestEffort(ctx context.Context, namespace, name string) {
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
		},
	}
	if err := s.client.Delete(ctx, secret); err != nil && !apierrors.IsNotFound(err) {
		logr.FromContextOrDiscard(ctx).Error(err,
			"failed to clean up credential secret after observability provider rejection",
			"namespace", namespace, "name", name)
	}
}

// observabilityProviderCreateError maps the CR create's API-server errors
// onto connect codes. The admission webhook's Invalid carries the operator-
// safe message (it names config keys, never values) so it is surfaced
// verbatim; Forbidden is the API server's own RBAC refusal on the service
// account, distinct from the caller-authorization PermissionDenied checked
// before any write.
func observabilityProviderCreateError(err error) error {
	switch {
	case apierrors.IsInvalid(err):
		return connect.NewError(connect.CodeInvalidArgument, err)
	case apierrors.IsAlreadyExists(err):
		return connect.NewError(connect.CodeAlreadyExists, err)
	case apierrors.IsForbidden(err):
		return connect.NewError(connect.CodePermissionDenied, err)
	default:
		return fmt.Errorf("creating observability provider: %w", err)
	}
}

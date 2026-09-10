package apiserver

import (
	"context"
	"strings"
	"time"

	"sigs.k8s.io/controller-runtime/pkg/client"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	providersv1alpha1 "github.com/benebsworth/paprika/api/providers/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/dataprovider"
)

// Capacity is the first data class the console redesign serves for real. The
// wire contract, the honest degraded shape and the GetDataSources probe all
// landed in Phase 0 (docs/superpowers/specs/console-redesign/01-backend-design.md
// section 4); this file is where a resolved provider replaces the stub without
// changing any of that. Everything a provider cannot substantiate still comes
// back as a state plus a zeroed number, so the console renders the same
// degraded board it already knows how to render.

// capacityReadTimeout bounds one capacity read across every provider bound to
// the scope. A capacity meter is decoration on a board the console draws
// either way, so it must never be the reason a request hangs: past this, the
// read is abandoned and the meter reports its own failure, which is a state
// the console already handles.
const capacityReadTimeout = 15 * time.Second

// capacityProviderKind is the only providerRef kind a capacity binding may
// name. A binding pointing at some future non-capacity provider is skipped
// rather than treated as a capacity source.
const capacityProviderKind = "CapacityProvider"

// Sanitized reasons for the ways a capacity read fails. Each is a literal, so
// no cluster host, kubeconfig detail or backend error text can travel into a
// response through unavailable_reason — the same rule mapFleetError applies on
// the fleet path (fleet_handler.go:186).
const (
	capacityBindingsUnreadableReason = "capacity provider bindings could not be read; " +
		"check the control plane's access to providers.paprika.io"
	capacityProviderUnreadableReason = "the bound capacity provider could not be read; " +
		"check that the CapacityProvider it names still exists"
	capacityProviderUnregisteredReason = "the bound capacity provider is not registered in this build; " +
		"bind a provider this control plane implements"
	capacityReadFailedReason = "reading capacity from the bound provider failed; " +
		"check the control plane's access to the target cluster"
)

// The console reads the capacity binding chain on behalf of the caller, so the
// control plane's own service account needs to see both halves of it. Read-only
// throughout: nothing on this path ever writes a provider or a binding.
// +kubebuilder:rbac:groups=providers.paprika.io,resources=capacityproviders;dataproviderbindings,verbs=get;list;watch

// capacityOutcome is one resolved, merged capacity read: the numbers, who
// produced them, and the single state the whole class reports to the
// GetDataSources probe.
type capacityOutcome struct {
	reading dataprovider.CapacityReading
	// providers names the bound providers in read order, for the probe's
	// provider field. It is the registry keys, never object names, so it says
	// what is collecting rather than what a tenant happened to call it.
	providers []string
	// usageProvider is the provider that actually supplied Used, which is the
	// one the cluster card credits. Empty when nothing supplied usage.
	usageProvider string
	state         dataprovider.DataState
	reason        string
}

// clusterCapacity serves the capacity half of one cluster's detail view.
//
// It never returns an error: an unconfigured, unreachable or forbidden
// capacity source is a state the console renders, not a reason to fail a read
// of the rest of the cluster. Every failure becomes a non-OK state with a
// zeroed number beside it.
func (s *PaprikaServer) clusterCapacity(ctx context.Context, namespace, name string) *paprikav1.ClusterCapacity {
	outcome := s.readCapacity(ctx, s.capacityScope(ctx, namespace, name), namespace+"/"+name)

	return &paprikav1.ClusterCapacity{
		Cpu:           capacityMeterMessage(paprikav1.ResourceUnit_RESOURCE_UNIT_MILLICORES, &outcome.reading.CPUMillicores),
		Memory:        capacityMeterMessage(paprikav1.ResourceUnit_RESOURCE_UNIT_BYTES, &outcome.reading.MemoryBytes),
		UsageProvider: outcome.usageProvider,
	}
}

// capacityDataSourceStatus answers the GetDataSources probe for
// DATA_CLASS_CLUSTER_CAPACITY.
//
// The probe decides whether the console draws a capacity board at all, so it
// reports what a read actually produced rather than merely whether a binding
// exists: OK once a provider resolves and reads, NOT_CONFIGURED when nothing
// is bound, and the implementation's own state otherwise. The read is scoped
// to the cluster this control plane runs in, because the probe asks about the
// install, not about one fleet member.
func (s *PaprikaServer) capacityDataSourceStatus(
	ctx context.Context,
	namespace *string,
	fallbackReason string,
) *paprikav1.DataSourceStatus {
	scope := dataprovider.Scope{}
	if namespace != nil {
		scope.Namespace = *namespace
	}
	outcome := s.readCapacity(ctx, scope, "")

	status := &paprikav1.DataSourceStatus{
		DataClass: paprikav1.DataClass_DATA_CLASS_CLUSTER_CAPACITY,
		State:     capacityProtoState(outcome.state),
		Provider:  strings.Join(outcome.providers, ", "),
	}
	if status.State != paprikav1.DataState_DATA_STATE_OK {
		status.UnavailableReason = outcome.reason
		if status.UnavailableReason == "" {
			status.UnavailableReason = fallbackReason
		}
	}
	status.ObservedAtUnixMs = capacityObservedAtUnixMs(&outcome.reading.CPUMillicores)

	return status
}

// capacityScope locates one cluster in the binding precedence chain.
//
// The project comes from the Cluster object's own label, so a Project-scoped
// binding covers the clusters that belong to that project. When the Cluster
// cannot be read the project is simply left empty: a project-scoped binding
// then does not match, which under-reports capacity rather than serving one
// project's meters under another project's scope.
func (s *PaprikaServer) capacityScope(ctx context.Context, namespace, name string) dataprovider.Scope {
	scope := dataprovider.Scope{Namespace: namespace, Cluster: name}
	if s.client == nil {
		return scope
	}

	var cluster clustersv1alpha1.Cluster
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: namespace, Name: name}, &cluster); err != nil {
		return scope
	}
	scope.Project = cluster.Labels[projectLabelKey]

	return scope
}

// readCapacity resolves every provider bound to scope, reads each one, and
// merges the results into a single reading.
//
// Merging is what makes a complete meter possible at all: KubernetesCapacity
// supplies allocatable and requested from the core API and cannot supply used;
// MetricsServer supplies used and nothing else. Read together and merged, they
// are one meter — and because a non-OK field can never overwrite an OK one,
// whichever of them fails leaves the other's numbers standing.
func (s *PaprikaServer) readCapacity(
	ctx context.Context,
	scope dataprovider.Scope,
	clusterKey string,
) capacityOutcome {
	if s.capacityProviders == nil || s.client == nil {
		return notConfiguredCapacityOutcome()
	}

	var bindings providersv1alpha1.DataProviderBindingList
	if err := s.client.List(ctx, &bindings); err != nil {
		return uniformCapacityOutcome(dataprovider.StateError, capacityBindingsUnreadableReason)
	}

	resolved := dataprovider.ResolveAll(scope, capacityBindingsFrom(&bindings, s.controlPlaneNamespace))
	if len(resolved) == 0 {
		return notConfiguredCapacityOutcome()
	}

	readCtx, cancel := context.WithTimeout(ctx, capacityReadTimeout)
	defer cancel()

	outcome := capacityOutcome{providers: make([]string, 0, len(resolved))}
	readings := make([]dataprovider.CapacityReading, 0, len(resolved))
	for _, binding := range resolved {
		name, reading := s.readOneCapacityProvider(readCtx, binding, clusterKey)
		outcome.providers = append(outcome.providers, name)
		readings = append(readings, reading)
		if outcome.usageProvider == "" && suppliedUsage(&reading) {
			outcome.usageProvider = name
		}
	}

	outcome.reading = dataprovider.Merge(readings...)
	outcome.state, outcome.reason = capacityClassState(&outcome.reading)

	return outcome
}

// readOneCapacityProvider reads the CapacityProvider a resolved binding names,
// returning the registry key that produced the reading alongside it.
//
// Every failure comes back as a reading rather than an error, because one
// broken provider must not blank the fields another provider read
// successfully: a uniform non-OK reading merges away under any OK field.
func (s *PaprikaServer) readOneCapacityProvider(
	ctx context.Context,
	binding dataprovider.Binding,
	clusterKey string,
) (string, dataprovider.CapacityReading) {
	namespace, name, found := strings.Cut(binding.ProviderName, "/")
	if !found {
		return binding.ProviderName, uniformCapacityReading(
			dataprovider.StateNotConfigured, capacityProviderUnreadableReason)
	}

	var provider providersv1alpha1.CapacityProvider
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: namespace, Name: name}, &provider); err != nil {
		return name, uniformCapacityReading(
			dataprovider.StateNotAvailable, capacityProviderUnreadableReason)
	}

	source, registered := s.capacityProviders.Capacity(provider.Spec.Provider)
	if !registered {
		return provider.Spec.Provider, uniformCapacityReading(
			dataprovider.StateNotConfigured, capacityProviderUnregisteredReason)
	}

	// Namespace stays empty: a cluster's capacity is the whole cluster's, not
	// one namespace's slice of it. The scope narrowed which provider answers,
	// not what the meter counts.
	reading, err := source.Read(ctx, dataprovider.ReadRequest{
		ClusterKey: clusterKey,
		Config:     provider.Spec.Config.Raw,
	})
	if err != nil {
		return provider.Spec.Provider, uniformCapacityReading(
			dataprovider.StateError, capacityReadFailedReason)
	}

	return provider.Spec.Provider, reading
}

// capacityBindingsFrom converts the bound DataProviderBindings into the
// resolver's own binding form.
//
// Bindings are read fleet-wide rather than per namespace on purpose: a
// Cluster- or Project-scoped binding lives wherever an operator put it, and its
// scope, not its namespace, decides what it applies to. The provider is keyed
// by "<namespace>/<name>" because providerRef carries no namespace of its own
// — a binding always refers to a CapacityProvider beside it — and the key has
// to survive resolution for the winner to be fetchable afterwards.
//
// Reading fleet-wide is precisely why the Global scope has to be earned:
// without the ScopeIsPermitted check, any tenant could create a Global binding
// in its own namespace and repoint the capacity source every other tenant
// sees. An ineligible binding is skipped rather than reported, because it is
// not this read's business to explain another namespace's misconfiguration —
// admission is where an operator is told (the same predicate decides both).
func capacityBindingsFrom(
	list *providersv1alpha1.DataProviderBindingList,
	controlPlaneNamespace string,
) []dataprovider.Binding {
	bindings := make([]dataprovider.Binding, 0, len(list.Items))
	for i := range list.Items {
		item := &list.Items[i]
		if item.Spec.ProviderRef.Kind != capacityProviderKind {
			continue
		}
		if !item.ScopeIsPermitted(controlPlaneNamespace) {
			continue
		}
		bindings = append(bindings, dataprovider.Binding{
			ProviderName: item.Namespace + "/" + item.Spec.ProviderRef.Name,
			ScopeKind:    item.Spec.Scope.Kind,
			ScopeName:    item.Spec.Scope.Name,
		})
	}

	return bindings
}

// capacityClassState reduces a merged reading to the one state the
// GetDataSources probe reports for the class, and the reason beside it.
//
// Any successful measurement makes the class OK: capacity is assembled from
// complementary providers, so a meter that has allocatable but not used is
// still a board worth drawing, and its missing field carries its own state on
// the meter itself. With nothing measured, the first field that gives an
// account of itself speaks for the class — that account is the actionable one,
// which a summary state alone would throw away.
func capacityClassState(reading *dataprovider.CapacityReading) (state dataprovider.DataState, reason string) {
	samples := capacitySamples(reading)
	for _, sample := range samples {
		if sample.State == dataprovider.StateOK {
			return dataprovider.StateOK, ""
		}
	}
	for _, sample := range samples {
		// The reserved zero state means the provider said nothing about this
		// field, which is not an account of anything and cannot speak for the
		// class.
		if sample.State != dataprovider.DataState(0) {
			return sample.State, sample.Reason
		}
	}

	return dataprovider.StateNotConfigured, clusterCapacityUnavailableReason
}

// capacitySamples lists every sample of a reading in a fixed order, so the
// state and reason a summary picks are the same on every call.
func capacitySamples(reading *dataprovider.CapacityReading) [6]dataprovider.Sample {
	return [6]dataprovider.Sample{
		reading.CPUMillicores.Used, reading.CPUMillicores.Requested, reading.CPUMillicores.Allocatable,
		reading.MemoryBytes.Used, reading.MemoryBytes.Requested, reading.MemoryBytes.Allocatable,
	}
}

// suppliedUsage reports whether a reading measured usage in either dimension,
// which is what makes a provider the meter's usage provider.
func suppliedUsage(reading *dataprovider.CapacityReading) bool {
	return reading.CPUMillicores.Used.State == dataprovider.StateOK ||
		reading.MemoryBytes.Used.State == dataprovider.StateOK
}

// notConfiguredCapacityOutcome is the honest answer when nothing is bound: the
// same shape the Phase 0 stub served, produced by the same mapping.
func notConfiguredCapacityOutcome() capacityOutcome {
	return uniformCapacityOutcome(dataprovider.StateNotConfigured, clusterCapacityUnavailableReason)
}

// uniformCapacityOutcome reports one state across every field of the reading.
func uniformCapacityOutcome(state dataprovider.DataState, reason string) capacityOutcome {
	return capacityOutcome{
		reading: uniformCapacityReading(state, reason),
		state:   state,
		reason:  reason,
	}
}

// uniformCapacityReading fills every field of a reading with one state and
// reason. ObservedAt stays zero: nothing was observed, so there is no time to
// report, and a zero time is what keeps observed_at_unix_ms off the wire.
func uniformCapacityReading(state dataprovider.DataState, reason string) dataprovider.CapacityReading {
	sample := dataprovider.Sample{State: state, Reason: reason}
	meter := dataprovider.Meter{Used: sample, Requested: sample, Allocatable: sample}

	return dataprovider.CapacityReading{CPUMillicores: meter, MemoryBytes: meter}
}

// capacityMeterMessage maps one merged meter onto the wire.
//
// This is the only place a dataprovider.Sample becomes a proto number, which
// is what makes the numerics rule enforceable at all: see
// capacitySampleMessage.
func capacityMeterMessage(unit paprikav1.ResourceUnit, meter *dataprovider.Meter) *paprikav1.ResourceMeter {
	usedState, used := capacitySampleMessage(meter.Used)
	requestedState, requested := capacitySampleMessage(meter.Requested)
	allocatableState, allocatable := capacitySampleMessage(meter.Allocatable)

	return &paprikav1.ResourceMeter{
		Unit:             unit,
		UsedState:        usedState,
		Used:             used,
		RequestedState:   requestedState,
		Requested:        requested,
		AllocatableState: allocatableState,
		Allocatable:      allocatable,
		// Capacity stays zero. No provider measures a node's total capacity as
		// distinct from its allocatable share, and the field carries no state
		// of its own to qualify a guess with, so any number here would be an
		// unqualified claim.
		Capacity:          0,
		ObservedAtUnixMs:  capacityObservedAtUnixMs(meter),
		UnavailableReason: capacityMeterReason(meter),
	}
}

// capacitySampleMessage maps one Sample onto its wire state and number, and is
// the single gate the numerics rule is enforced at.
//
// Only OK and STALE may carry a number. STALE is the sole non-OK state that
// may, because a stale reading is a real measurement whose age the client is
// told about and can decide about; every other non-OK state means no
// measurement exists, so the number beside it must be zero. Copying a value
// through under, say, ERROR would put a plausible figure on a meter the server
// has just said it cannot substantiate — which is precisely the failure the
// whole DataState contract exists to prevent, and the harder one to notice,
// because it renders perfectly.
func capacitySampleMessage(sample dataprovider.Sample) (state paprikav1.DataState, value float64) {
	state = capacityProtoState(sample.State)
	if state == paprikav1.DataState_DATA_STATE_OK || state == paprikav1.DataState_DATA_STATE_STALE {
		return state, sample.Value
	}

	return state, 0
}

// capacityProtoState maps a provider's DataState onto the wire enum. The two
// enums are deliberately parallel, but the conversion is spelled out rather
// than cast so that adding a member to either one is a compile-or-lint failure
// here instead of a silently mistranslated state.
func capacityProtoState(state dataprovider.DataState) paprikav1.DataState {
	switch state {
	case dataprovider.StateOK:
		return paprikav1.DataState_DATA_STATE_OK
	case dataprovider.StateNotConfigured:
		return paprikav1.DataState_DATA_STATE_NOT_CONFIGURED
	case dataprovider.StateNotAvailable:
		return paprikav1.DataState_DATA_STATE_NOT_AVAILABLE
	case dataprovider.StateStale:
		return paprikav1.DataState_DATA_STATE_STALE
	case dataprovider.StateError:
		return paprikav1.DataState_DATA_STATE_ERROR
	case dataprovider.StateForbidden:
		return paprikav1.DataState_DATA_STATE_FORBIDDEN
	default:
		// The reserved zero DataState: a sample nobody wrote. UNSPECIFIED is
		// the wire's own "unknown", which is exactly what that is.
		return paprikav1.DataState_DATA_STATE_UNSPECIFIED
	}
}

// capacityMeterReason picks the sentence a meter shows while it is not whole:
// the first field that explains itself, in used/requested/allocatable order. A
// fully measured meter carries no reason at all.
func capacityMeterReason(meter *dataprovider.Meter) string {
	incomplete := false
	for _, sample := range [...]dataprovider.Sample{meter.Used, meter.Requested, meter.Allocatable} {
		if sample.State == dataprovider.StateOK {
			continue
		}
		incomplete = true
		if sample.Reason != "" {
			return sample.Reason
		}
	}
	if incomplete {
		return clusterCapacityUnavailableReason
	}

	return ""
}

// capacityObservedAtUnixMs reports when a meter was measured, and zero when it
// holds no measurement — an observation time beside three unmeasured fields
// would claim the absence itself was observed at that moment.
func capacityObservedAtUnixMs(meter *dataprovider.Meter) int64 {
	if meter.ObservedAt.IsZero() {
		return 0
	}
	for _, sample := range [...]dataprovider.Sample{meter.Used, meter.Requested, meter.Allocatable} {
		if sample.State == dataprovider.StateOK || sample.State == dataprovider.StateStale {
			return meter.ObservedAt.UnixMilli()
		}
	}

	return 0
}

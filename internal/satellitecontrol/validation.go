package satellitecontrol

import (
	"errors"
	"net/http"
	"strings"

	"k8s.io/apimachinery/pkg/util/validation"

	clusters "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	"github.com/benebsworth/paprika/internal/satellite"
)

func validName(name string) bool         { return len(validation.IsDNS1123Subdomain(name)) == 0 }
func validNamespace(name string) bool    { return name != "" && len(validation.IsDNS1123Label(name)) == 0 }
func validOptionalName(name string) bool { return name == "" || validName(name) }

func validateReport(r *satellite.Report) error {
	if !validReportIdentity(r) {
		return errors.New("invalid identity")
	}
	if !validReportLimits(r) {
		return errors.New("report exceeds limits")
	}
	if r.Snapshot && (r.Sequence != 1 || len(r.DeletedApplications) > 0) {
		return errors.New("invalid snapshot")
	}
	if err := validateApplicationChanges(r); err != nil {
		return err
	}
	if !validInventory(&r.Inventory) {
		return errors.New("invalid inventory")
	}
	return validateObservationPayload(r)
}

// validateObservationPayload checks everything a report carries about the
// cluster itself, as opposed to its applications. It is separate from
// validateReport so the top-level contract stays readable.
func validateObservationPayload(r *satellite.Report) error {
	if err := validateCapacity(&r.Capacity); err != nil {
		return err
	}
	if err := validateNodePools(r.NodePools); err != nil {
		return err
	}
	if err := validatePolicyReport(r); err != nil {
		return err
	}
	return validateTopology(&r.Inventory)
}

// maxNodePools bounds the pool list a report may carry. A cluster with more
// pools than this has a naming problem, not a reporting one.
const maxNodePools = 64

// validateCapacity rejects negative resource figures. A negative count is not a
// measurement, and accepting one would let a satellite put a nonsensical meter
// in front of an operator.
func validateCapacity(capacity *clusters.SatelliteCapacity) error {
	if capacity == nil {
		return nil
	}
	for _, usage := range []clusters.SatelliteResourceUsage{capacity.CPUMillicores, capacity.MemoryBytes} {
		if usage.Used < 0 || usage.Requested < 0 || usage.Allocatable < 0 {
			return errors.New("invalid capacity")
		}
	}
	return nil
}

// validateNodePools bounds pool identity and rejects a non-positive node count.
// A pool that exists with zero nodes is real; a negative one is not.
func validateNodePools(pools []clusters.ClusterNodePool) error {
	if len(pools) > maxNodePools {
		return errors.New("report exceeds pool limit")
	}
	for i := range pools {
		pool := &pools[i]
		if !validName(pool.Name) || len(pool.Name) > 253 {
			return errors.New("invalid node pool name")
		}
		if len(pool.MachineType) > 253 {
			return errors.New("invalid node pool machine type")
		}
		if pool.NodeCount < 0 || pool.AllocatableCPUMillis < 0 || pool.AllocatableMemoryBytes < 0 {
			return errors.New("invalid node pool capacity")
		}
	}
	return nil
}

// validatePolicyReport bounds the policy and autonomy a satellite claims. The
// values are informational — the Cluster's own ceiling is authoritative — but a
// report still must not carry an unbounded or unrecognised vocabulary.
func validatePolicyReport(r *satellite.Report) error {
	if len(r.Policies) > 8 {
		return errors.New("report exceeds policy limit")
	}
	for _, policy := range r.Policies {
		if !validPolicy(policy) {
			return errors.New("invalid management policy")
		}
	}
	if r.Autonomy != "" && !r.Autonomy.Valid() {
		return errors.New("invalid autonomy mode")
	}
	if r.OperatingState != "" && !validOperatingState(r.OperatingState) {
		return errors.New("invalid operating state")
	}
	return nil
}

func validOperatingState(state clusters.SatelliteOperatingState) bool {
	switch state {
	case clusters.SatelliteOperatingConnecting, clusters.SatelliteOperatingConnected,
		clusters.SatelliteOperatingAutonomous, clusters.SatelliteOperatingOverrideHeld,
		clusters.SatelliteOperatingDisabled:
		return true
	default:
		return false
	}
}

func validPolicy(policy clusters.ManagementPolicy) bool {
	switch policy {
	case clusters.ManagementPolicyObserve, clusters.ManagementPolicyApply, clusters.ManagementPolicyPrune,
		clusters.ManagementPolicyDelete, clusters.ManagementPolicySelfHeal, clusters.ManagementPolicyRollout,
		clusters.ManagementPolicyAll:
		return true
	default:
		return false
	}
}

func validReportIdentity(r *satellite.Report) bool {
	return r.ProtocolVersion == satellite.ProtocolVersion && validNamespace(r.ClusterNamespace) &&
		validName(r.ClusterName) && len(r.ClusterName) <= 63 && validSessionIdentity(r) &&
		r.Sequence > 0 && r.Sequence < 1<<63 && !r.ObservedAt.IsZero()
}

func validSessionIdentity(r *satellite.Report) bool {
	return r.ClusterUID != "" && len(r.ClusterUID) <= 128 && r.SessionID != "" && len(r.SessionID) <= 128
}

func validReportLimits(r *satellite.Report) bool {
	return len(r.DisplayName) <= 256 && len(r.Version) <= 128 && len(r.KubernetesVersion) <= 128 &&
		len(r.Applications) <= satellite.MaxApplications && len(r.DeletedApplications) <= satellite.MaxApplications
}

func validateApplicationChanges(r *satellite.Report) error {
	seen := make(map[string]bool, len(r.Applications)+len(r.DeletedApplications))
	for i := range r.Applications {
		a := &r.Applications[i]
		if !validApplication(a) || seen[a.Key()] {
			return errors.New("invalid application")
		}
		seen[a.Key()] = true
	}
	return validateDeletedKeys(r.DeletedApplications, seen)
}

func validApplication(a *satellite.Application) bool {
	return validNamespace(a.Namespace) && validName(a.Name) && validOptionalName(a.Identity) &&
		validOptionalName(a.Project) && len(a.Health) <= 32 && len(a.Phase) <= 32 && len(a.SourceRevision) <= 256
}

func validateDeletedKeys(keys []string, seen map[string]bool) error {
	for _, key := range keys {
		ns, name, ok := strings.Cut(key, "/")
		if !ok || !validNamespace(ns) || !validName(name) || seen[key] {
			return errors.New("invalid deletion")
		}
		seen[key] = true
	}
	return nil
}

func validInventory(inv *clusters.ClusterInventory) bool {
	return inv.NodeCount >= 0 && inv.ReadyNodeCount >= 0 && inv.PodCount >= 0 &&
		inv.RunningPodCount >= 0 && inv.NamespaceCount >= 0 && inv.ReadyNodeCount <= inv.NodeCount &&
		inv.RunningPodCount <= inv.PodCount
}

func validateTopology(inv *clusters.ClusterInventory) error {
	for _, values := range [][]string{inv.Regions, inv.Zones, inv.KubeletVersions} {
		if len(values) > 256 {
			return errors.New("invalid topology")
		}
		for _, value := range values {
			if len(value) > 256 {
				return errors.New("invalid topology")
			}
		}
	}
	return nil
}

func requireSnapshot(r *satellite.Report) error {
	if !r.Snapshot || r.Sequence != 1 {
		return refuse(http.StatusConflict, "full snapshot required")
	}
	return nil
}

func validateBaseline(old *clusters.SatelliteStatus, r *satellite.Report, digest string) (bool, error) {
	if old == nil {
		return false, requireSnapshot(r)
	}
	if old.ClusterUID != r.ClusterUID {
		return false, refuse(http.StatusConflict, "cluster identity mismatch")
	}
	if old.SessionID == r.SessionID {
		return validateSessionSequence(old, r, digest)
	}
	for _, session := range old.RetiredSessions {
		if session == r.SessionID {
			return false, refuse(http.StatusConflict, "retired reporting session")
		}
	}
	return false, requireSnapshot(r)
}

func validateSessionSequence(old *clusters.SatelliteStatus, r *satellite.Report, digest string) (bool, error) {
	if reportSequence(r) == old.Sequence {
		if old.ReportDigest == digest {
			return true, nil
		}
		return false, refuse(http.StatusConflict, "sequence payload mismatch")
	}
	if reportSequence(r) != old.Sequence+1 || r.Snapshot {
		return false, refuse(http.StatusConflict, "full snapshot required")
	}
	return false, nil
}

func reportSequence(r *satellite.Report) int64 {
	return int64(r.Sequence) // #nosec G115 -- validateReport requires 0 < sequence < 1<<63 before persistence.
}

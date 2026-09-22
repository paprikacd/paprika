package dataprovider

import (
	"sort"
	"time"
)

// stateUnset is the reserved zero DataState (see the iota in reading.go): a
// Sample nobody wrote. It is named here rather than in the exported block on
// purpose — callers must never be able to set it — but merging has to tell
// "this source said nothing about the field" apart from "this source said the
// field is not configured", and only the zero value carries the former.
const stateUnset DataState = 0

// Merge folds readings into one, left to right: a later reading fills in the
// fields an earlier one left non-OK, and can never overwrite a field an
// earlier one measured successfully.
//
// This is what lets complementary sources compose into a single meter.
// KubernetesCapacity supplies Requested and Allocatable from the core API and
// reports Used as StateNotConfigured because it cannot ever measure it;
// MetricsServer supplies Used from metrics.k8s.io and reports the other two
// as StateNotConfigured for the same reason. Merged in that order they make
// one complete meter, and neither can blank the other's numbers.
//
// The precedence is deliberately asymmetric. An OK sample is never replaced,
// because a real measurement outranks any account of why a measurement is
// missing. Between two non-OK samples the later one wins, because a source
// bound specifically to that field describes its absence better than a source
// that never claimed the field at all — a bound-but-absent metrics-server's
// StateNotAvailable is a truer account of Used than KubernetesCapacity's
// StateNotConfigured. The one exception is a sample left entirely unset,
// which asserts nothing and therefore replaces nothing.
func Merge(readings ...CapacityReading) CapacityReading {
	merged := CapacityReading{}
	for i := range readings {
		merged.CPUMillicores = mergeMeter(&merged.CPUMillicores, &readings[i].CPUMillicores)
		merged.MemoryBytes = mergeMeter(&merged.MemoryBytes, &readings[i].MemoryBytes)
	}

	return merged
}

// mergeMeter folds next into base one field at a time, then decides what
// observation time the combined meter honestly carries.
func mergeMeter(base, next *Meter) Meter {
	merged := Meter{
		Used:        mergeSample(base.Used, next.Used),
		Requested:   mergeSample(base.Requested, next.Requested),
		Allocatable: mergeSample(base.Allocatable, next.Allocatable),
	}
	merged.ObservedAt = mergeObservedAt(base, next, &merged)

	return merged
}

// mergeSample applies the precedence Merge documents to one field.
func mergeSample(base, next Sample) Sample {
	if base.State == StateOK || next.State == stateUnset {
		return base
	}

	return next
}

// mergeObservedAt returns the oldest observation time among the meters that
// actually contributed a measurement to merged.
//
// Oldest, not newest: a meter assembled from two reads is only as fresh as
// its stalest component, so reporting the newer time would let a staleness
// check pass on the strength of a field that is not the stale one. A meter
// that contributed no measurement contributes no time either — its clock says
// nothing about how fresh the merged numbers are — and a contributor that
// left ObservedAt unset is skipped rather than pinning the result to the zero
// time, which would read as "observed in 1 CE" to anything doing arithmetic.
func mergeObservedAt(base, next, merged *Meter) time.Time {
	observed := time.Time{}
	for _, side := range [...]*Meter{base, next} {
		if side.ObservedAt.IsZero() || !contributedTo(side, merged) {
			continue
		}
		if observed.IsZero() || side.ObservedAt.Before(observed) {
			observed = side.ObservedAt
		}
	}

	return observed
}

// contributedTo reports whether any measurement side supplied survived into
// merged. Sample is a comparable value, so identity is enough: the winning
// sample is the very value one side handed over.
func contributedTo(side, merged *Meter) bool {
	return measurementSurvived(side.Used, merged.Used) ||
		measurementSurvived(side.Requested, merged.Requested) ||
		measurementSurvived(side.Allocatable, merged.Allocatable)
}

// measurementSurvived reports whether candidate is a successful measurement
// that won its field. Only StateOK counts: a state explaining why a number is
// missing is not an observation, so it must not pin an observation time.
func measurementSurvived(candidate, winner Sample) bool {
	return candidate.State == StateOK && candidate == winner
}

// ResolveAll returns the binding that wins for scope for each distinct
// provider named in bindings, sorted by provider name.
//
// Resolve answers "which binding applies?" for one provider chain. Capacity,
// though, is assembled from complementary providers — one supplying the
// structural fields, another supplying usage — so a single winner across all
// bindings would silently discard every provider but one and leave the meter
// permanently half-empty. Resolving the chain per provider keeps the
// precedence rules Resolve defines (most specific scope wins) while letting
// the survivors compose through Merge.
//
// The result is sorted rather than left in map order because read order
// decides which provider wins a field two providers both report: an unstable
// order would make a meter's contents vary between identical requests.
func ResolveAll(scope Scope, bindings []Binding) []Binding {
	byProvider := make(map[string][]Binding)
	for _, binding := range bindings {
		byProvider[binding.ProviderName] = append(byProvider[binding.ProviderName], binding)
	}

	names := make([]string, 0, len(byProvider))
	for name := range byProvider {
		names = append(names, name)
	}
	sort.Strings(names)

	resolved := make([]Binding, 0, len(names))
	for _, name := range names {
		if winner, ok := Resolve(scope, byProvider[name]); ok {
			resolved = append(resolved, winner)
		}
	}

	return resolved
}

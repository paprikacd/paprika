package dataprovider

import (
	v1alpha1 "github.com/benebsworth/paprika/api/providers/v1alpha1"
)

// Scope identifies the fleet coordinates a capacity reading is requested
// for. Fields left empty simply never match a binding scoped at that level.
type Scope struct {
	Namespace string
	Cluster   string
	Project   string
}

// Binding is a resolved view of a DataProviderBinding: which provider it
// points at, and the scope level and name it applies to.
type Binding struct {
	ProviderName string
	ScopeKind    v1alpha1.ScopeKind
	ScopeName    string
}

// matches reports whether b applies to scope, i.e. whether b's ScopeKind is
// scoped to a name that scope also carries at that level. ScopeGlobal has no
// name to compare against, so it always matches.
func (b Binding) matches(scope Scope) bool {
	switch b.ScopeKind {
	case v1alpha1.ScopeNamespace:
		return b.ScopeName == scope.Namespace
	case v1alpha1.ScopeCluster:
		return b.ScopeName == scope.Cluster
	case v1alpha1.ScopeProject:
		return b.ScopeName == scope.Project
	case v1alpha1.ScopeGlobal:
		return true
	default:
		return false
	}
}

// Resolve returns the binding that wins for scope, walking the precedence
// chain most-specific-first and returning the first match at each level. It
// does not consult a Registry: it only decides which binding applies, not
// whether the provider it names is actually registered. Ties within one
// level are an admission concern, not a resolution one.
func Resolve(scope Scope, bindings []Binding) (Binding, bool) {
	for _, kind := range v1alpha1.ScopeKindsBySpecificity() {
		for _, b := range bindings {
			if b.ScopeKind != kind {
				continue
			}
			if b.matches(scope) {
				return b, true
			}
		}
	}

	return Binding{}, false
}

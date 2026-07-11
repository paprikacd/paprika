package fleet

import (
	"testing"

	"k8s.io/apimachinery/pkg/types"
)

func fleetID(namespace, name string) types.NamespacedName {
	return types.NamespacedName{Namespace: namespace, Name: name}
}

func application(namespace, name string) ApplicationSummary {
	id := fleetID(namespace, name)
	return ApplicationSummary{Identity: id}
}

func searchSnapshot(t *testing.T, applications ...ApplicationSummary) *Snapshot {
	t.Helper()

	builder := NewSnapshot(1)
	for _, app := range applications {
		builder.Applications[app.Identity] = app
	}
	builder.rebuildSearchIndex()
	return builder
}

func idSet(ids ...types.NamespacedName) IDSet {
	set := make(IDSet, len(ids))
	for _, id := range ids {
		set[id] = struct{}{}
	}
	return set
}

package obsstore

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/types"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	"github.com/benebsworth/paprika/internal/satellite"
)

func testObservation(clusterName string, sequence uint64) Observation {
	return Observation{
		Cluster: types.NamespacedName{Namespace: "paprika-system", Name: clusterName},
		Report: &satellite.Report{
			ProtocolVersion:  satellite.ProtocolVersion,
			ClusterNamespace: "paprika-system",
			ClusterName:      clusterName,
			SessionID:        "session-a",
			Sequence:         sequence,
			Snapshot:         sequence == 1,
			ObservedAt:       time.Unix(1800000000, 0).UTC(),
			Inventory:        clustersv1alpha1.ClusterInventory{NodeCount: 1, ReadyNodeCount: 1},
			Applications: []satellite.Application{
				{Namespace: "checkout", Name: "web", Health: "Healthy", ResourceCount: 3},
			},
		},
		UpdatedAt: time.Unix(1800000000, 0).UTC(),
	}
}

func TestMemoryStoreRoundTrip(t *testing.T) {
	t.Parallel()

	store := NewMemory()
	ctx := context.Background()

	require.NoError(t, store.Put(ctx, testObservation("edge-b", 2)))
	require.NoError(t, store.Put(ctx, testObservation("edge-a", 1)))

	observations, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, observations, 2)
	require.Equal(t, "edge-a", observations[0].Cluster.Name, "list is ordered by cluster identity")
	require.Equal(t, uint64(1), observations[0].Report.Sequence)

	require.NoError(t, store.Delete(ctx, types.NamespacedName{Namespace: "paprika-system", Name: "edge-a"}))
	observations, err = store.List(ctx)
	require.NoError(t, err)
	require.Len(t, observations, 1)
}

// TestRedisStoreRoundTrip covers the shared backing store: one key per cluster,
// an index for enumeration, and a replacement that keeps the newest report.
func TestRedisStoreRoundTrip(t *testing.T) {
	t.Parallel()

	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	store := NewRedis(client, "paprika:test")
	ctx := context.Background()

	require.NoError(t, store.Put(ctx, testObservation("edge-a", 1)))
	require.NoError(t, store.Put(ctx, testObservation("edge-b", 1)))
	require.NoError(t, store.Put(ctx, testObservation("edge-a", 2)))

	observations, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, observations, 2)
	require.Equal(t, "edge-a", observations[0].Cluster.Name)
	require.Equal(t, uint64(2), observations[0].Report.Sequence, "the latest report replaces the previous one")
	require.Len(t, observations[0].Report.Applications, 1)
	require.Equal(t, "web", observations[0].Report.Applications[0].Name)

	require.NoError(t, store.Delete(ctx, types.NamespacedName{Namespace: "paprika-system", Name: "edge-a"}))
	remaining, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, remaining, 1)
	require.Equal(t, "edge-b", remaining[0].Cluster.Name)
}

// TestRedisStoreDropsIndexEntriesWithoutData keeps the index from accumulating
// keys after a flush or eviction.
func TestRedisStoreDropsIndexEntriesWithoutData(t *testing.T) {
	t.Parallel()

	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	store := NewRedis(client, "paprika:test")
	ctx := context.Background()

	require.NoError(t, store.Put(ctx, testObservation("edge-a", 1)))
	require.NoError(t, client.Del(ctx, store.observationKey(types.NamespacedName{Namespace: "paprika-system", Name: "edge-a"})).Err())

	observations, err := store.List(ctx)
	require.NoError(t, err)
	require.Empty(t, observations)

	members, err := client.SMembers(ctx, store.indexKey()).Result()
	require.NoError(t, err)
	require.Empty(t, members, "the dangling index entry is removed on read")
}

package obsstore

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"
	"k8s.io/apimachinery/pkg/types"

	"github.com/benebsworth/paprika/internal/satellite"
)

// RedisStoreName is the provider name accepted by the store selector.
const RedisStoreName = "redis"

// Redis stores each cluster's latest observation as one key and keeps an index
// set for enumeration.
//
// One key per cluster rather than one document for the fleet: a report rewrites
// only its own cluster's observation, so writes do not contend across clusters
// the way a single shared value would.
type Redis struct {
	client *redis.Client
	prefix string
}

// NewRedis returns a store backed by client under prefix (for example
// "paprika:obs").
func NewRedis(client *redis.Client, prefix string) *Redis {
	return &Redis{client: client, prefix: prefix}
}

// Name implements Store.
func (r *Redis) Name() string { return RedisStoreName }

func (r *Redis) observationKey(cluster types.NamespacedName) string {
	return r.prefix + ":obs:" + cluster.Namespace + "/" + cluster.Name
}

func (r *Redis) indexKey() string { return r.prefix + ":index" }

// redisObservation is the stored envelope: identity and freshness around the
// report exactly as the satellite sent it.
type redisObservation struct {
	Namespace string          `json:"namespace"`
	Name      string          `json:"name"`
	UpdatedAt time.Time       `json:"updatedAt"`
	Report    json.RawMessage `json:"report"`
}

// Put implements Store.
func (r *Redis) Put(ctx context.Context, observation Observation) error {
	if observation.Report == nil {
		return fmt.Errorf("observation for %s has no report", observation.Cluster)
	}
	report, err := json.Marshal(observation.Report)
	if err != nil {
		return fmt.Errorf("encode observation report: %w", err)
	}
	envelope, err := json.Marshal(redisObservation{
		Namespace: observation.Cluster.Namespace,
		Name:      observation.Cluster.Name,
		UpdatedAt: observation.UpdatedAt.UTC(),
		Report:    report,
	})
	if err != nil {
		return fmt.Errorf("encode observation: %w", err)
	}

	key := r.observationKey(observation.Cluster)
	pipe := r.client.TxPipeline()
	pipe.Set(ctx, key, envelope, 0)
	pipe.SAdd(ctx, r.indexKey(), key)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("write observation: %w", err)
	}
	return nil
}

// List implements Store.
func (r *Redis) List(ctx context.Context) ([]Observation, error) {
	keys, err := r.client.SMembers(ctx, r.indexKey()).Result()
	if err != nil {
		return nil, fmt.Errorf("list observation index: %w", err)
	}
	if len(keys) == 0 {
		return nil, nil
	}
	values, err := r.client.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, fmt.Errorf("read observations: %w", err)
	}

	observations, stale := decodeObservations(keys, values)
	if len(stale) > 0 {
		staleKeys := make([]interface{}, len(stale))
		for i := range stale {
			staleKeys[i] = stale[i]
		}
		if err := r.client.SRem(ctx, r.indexKey(), staleKeys...).Err(); err != nil {
			return nil, fmt.Errorf("prune observation index: %w", err)
		}
	}

	sort.Slice(observations, func(i, j int) bool {
		if observations[i].Cluster.Namespace != observations[j].Cluster.Namespace {
			return observations[i].Cluster.Namespace < observations[j].Cluster.Namespace
		}
		return observations[i].Cluster.Name < observations[j].Cluster.Name
	})
	return observations, nil
}

// Delete implements Store.
func (r *Redis) Delete(ctx context.Context, cluster types.NamespacedName) error {
	key := r.observationKey(cluster)
	pipe := r.client.TxPipeline()
	pipe.Del(ctx, key)
	pipe.SRem(ctx, r.indexKey(), key)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("delete observation: %w", err)
	}
	return nil
}

func decodeObservation(encoded []byte) (Observation, error) {
	var stored redisObservation
	if err := json.Unmarshal(encoded, &stored); err != nil {
		return Observation{}, fmt.Errorf("decode observation envelope: %w", err)
	}
	var report satellite.Report
	if err := json.Unmarshal(stored.Report, &report); err != nil {
		return Observation{}, fmt.Errorf("decode observation report: %w", err)
	}
	return Observation{
		Cluster:   types.NamespacedName{Namespace: stored.Namespace, Name: stored.Name},
		Report:    &report,
		UpdatedAt: stored.UpdatedAt,
	}, nil
}

// decodeObservations separates readable observations from index entries whose
// key no longer exists or no longer decodes. Callers prune the latter so the
// index cannot grow without bound after a flush or eviction.
func decodeObservations(keys []string, values []interface{}) (observations []Observation, stale []string) {
	observations = make([]Observation, 0, len(values))
	stale = make([]string, 0)
	for i, value := range values {
		encoded, ok := value.(string)
		if !ok || encoded == "" {
			stale = append(stale, keys[i])
			continue
		}
		observation, decodeErr := decodeObservation([]byte(encoded))
		if decodeErr != nil {
			stale = append(stale, keys[i])
			continue
		}
		observations = append(observations, observation)
	}
	return observations, stale
}

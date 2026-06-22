package coordinator

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func setupTestCoordinator(t *testing.T, members []string) (*Coordinator, *miniredis.Miniredis, context.Context) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(mr.Close)
	client := redis.NewClient(&redis.Options{
		Addr:         mr.Addr(),
		DialTimeout:  100 * time.Millisecond,
		ReadTimeout:  100 * time.Millisecond,
		WriteTimeout: 100 * time.Millisecond,
		MaxRetries:   0,
		PoolTimeout:  200 * time.Millisecond,
	})
	ctx := context.Background()
	for _, m := range members {
		client.SAdd(ctx, replicasKey(), m)
		client.Set(ctx, heartbeatKey(m), "alive", 30*time.Second)
	}
	c := NewCoordinator(client, "test-pod",
		WithHeartbeatInterval(time.Hour),
		WithHeartbeatTTL(30*time.Second),
	)
	return c, mr, ctx
}

func TestCoordinatorJoin(t *testing.T) {
	c, mr, ctx := setupTestCoordinator(t, []string{"peer-1", "peer-2"})
	if err := c.Join(ctx); err != nil {
		t.Fatal(err)
	}
	if c.ring.Len() != 3 {
		t.Errorf("expected 3 ring members, got %d", c.ring.Len())
	}
	ok, err := mr.SIsMember(replicasKey(), "test-pod")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Error("test-pod not in replicas set")
	}
	found := false
	for i := 0; i < 100; i++ {
		owner, _ := c.ring.Lookup(fmt.Sprintf("ns-%d", i))
		if owner == "test-pod" {
			found = true
			break
		}
	}
	if !found {
		t.Error("test-pod not assigned any namespaces")
	}
}

func TestCoordinatorLeave(t *testing.T) {
	c, mr, ctx := setupTestCoordinator(t, []string{"peer-1"})
	if err := c.Join(ctx); err != nil {
		t.Fatal(err)
	}
	if err := c.Leave(ctx); err != nil {
		t.Fatal(err)
	}
	ok, err := mr.SIsMember(replicasKey(), "test-pod")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Error("test-pod still in replicas after leave")
	}
	if mr.Exists(heartbeatKey("test-pod")) {
		t.Error("heartbeat still exists after leave")
	}
}

func TestCoordinatorStaleDetection(t *testing.T) {
	c, mr, ctx := setupTestCoordinator(t, []string{"peer-1"})
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	client.SAdd(ctx, replicasKey(), "stale-pod")
	// stale-pod is in the replicas set but has no heartbeat key (it expired or never joined)
	if err := c.Join(ctx); err != nil {
		t.Fatal(err)
	}
	ok, err := mr.SIsMember(replicasKey(), "stale-pod")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Error("stale-pod was not removed")
	}
	if c.ring.Len() != 2 {
		t.Errorf("expected 2 ring members, got %d", c.ring.Len())
	}
}

func TestCoordinatorHealthy(t *testing.T) {
	c, mr, ctx := setupTestCoordinator(t, nil)
	c.heartbeatInterval = 50 * time.Millisecond
	c.heartbeatTTL = 2 * time.Second
	if err := c.Join(ctx); err != nil {
		t.Fatal(err)
	}
	if !c.Healthy(ctx) {
		t.Error("expected healthy after join")
	}
	mr.Close()
	time.Sleep(2 * time.Second)
	if c.Healthy(ctx) {
		t.Error("expected unhealthy after Redis failure")
	}
}

func TestCoordinatorHeartbeatRefreshesTTL(t *testing.T) {
	c, mr, ctx := setupTestCoordinator(t, nil)
	c.heartbeatTTL = 2 * time.Second
	c.heartbeatInterval = 100 * time.Millisecond
	if err := c.Join(ctx); err != nil {
		t.Fatal(err)
	}
	ttl := mr.TTL(heartbeatKey("test-pod"))
	if ttl <= 0 {
		t.Errorf("expected heartbeat TTL > 0, got %v", ttl)
	}
	time.Sleep(200 * time.Millisecond)
	newTTL := mr.TTL(heartbeatKey("test-pod"))
	if newTTL < 1500*time.Millisecond {
		t.Errorf("expected TTL refreshed (~2s), got %v", newTTL)
	}
}

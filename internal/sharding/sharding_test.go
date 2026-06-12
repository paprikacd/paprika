package sharding

import (
	"fmt"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewFilterFromEnv_Disabled(t *testing.T) {
	_ = os.Unsetenv(shardTotalEnv)
	_ = os.Unsetenv(shardIDEnv)
	f := NewFilterFromEnv()
	assert.False(t, f.Enabled())
	assert.True(t, f.Matches("any-namespace"))
}

func TestNewFilterFromEnv_Enabled(t *testing.T) {
	t.Setenv(shardTotalEnv, "4")
	t.Setenv(shardIDEnv, "2")

	f := NewFilterFromEnv()
	assert.True(t, f.Enabled())
	assert.Equal(t, 2, f.ShardID())
	assert.Equal(t, 4, f.TotalShards())
}

func TestNewFilterFromEnv_InvalidTotal(t *testing.T) {
	t.Setenv(shardTotalEnv, "abc")
	f := NewFilterFromEnv()
	assert.False(t, f.Enabled())
}

func TestNewFilterFromEnv_InvalidID(t *testing.T) {
	t.Setenv(shardTotalEnv, "4")
	t.Setenv(shardIDEnv, "10")
	f := NewFilterFromEnv()
	assert.False(t, f.Enabled())
}

func TestNewFilter(t *testing.T) {
	f := NewFilter(1, 4)
	assert.True(t, f.Enabled())
	assert.Equal(t, 1, f.ShardID())
	assert.Equal(t, 4, f.TotalShards())

	f = NewFilter(0, 1)
	assert.False(t, f.Enabled())

	f = NewFilter(-1, 4)
	assert.False(t, f.Enabled())

	f = NewFilter(4, 4)
	assert.False(t, f.Enabled())
}

func TestFilter_Matches_Distribution(t *testing.T) {
	namespaces := []string{
		"default", "kube-system", "app-1", "app-2", "app-3",
		"team-a", "team-b", "team-c", "prod", "staging", "dev",
	}

	// With 4 shards, each namespace should belong to exactly one shard.
	for _, ns := range namespaces {
		matched := false
		for shard := 0; shard < 4; shard++ {
			f := NewFilter(shard, 4)
			if f.Matches(ns) {
				matched = true
			}
		}
		assert.True(t, matched, "namespace %s matched no shard", ns)
	}
}

func TestFilter_Matches_Consistency(t *testing.T) {
	f := NewFilter(2, 8)

	// Find a namespace that matches this shard by brute force.
	var matchingNS, nonMatchingNS string
	for i := 0; i < 1000; i++ {
		ns := fmt.Sprintf("ns-%d", i)
		if f.Matches(ns) {
			if matchingNS == "" {
				matchingNS = ns
			}
		} else {
			if nonMatchingNS == "" {
				nonMatchingNS = ns
			}
		}
		if matchingNS != "" && nonMatchingNS != "" {
			break
		}
	}
	require.NotEmpty(t, matchingNS, "no matching namespace found")
	require.NotEmpty(t, nonMatchingNS, "no non-matching namespace found")

	// Same namespace should always match the same shard.
	for i := 0; i < 100; i++ {
		assert.True(t, f.Matches(matchingNS))
		assert.False(t, f.Matches(nonMatchingNS))
	}
}

func TestValidateShardEnv_Valid(t *testing.T) {
	t.Setenv(shardTotalEnv, "4")
	t.Setenv(shardIDEnv, "2")
	require.NoError(t, ValidateShardEnv())
}

func TestValidateShardEnv_Missing(t *testing.T) {
	_ = os.Unsetenv(shardTotalEnv)
	_ = os.Unsetenv(shardIDEnv)
	require.NoError(t, ValidateShardEnv())
}

func TestValidateShardEnv_InvalidTotal(t *testing.T) {
	t.Setenv(shardTotalEnv, "abc")
	require.Error(t, ValidateShardEnv())
}

func TestValidateShardEnv_OutOfRange(t *testing.T) {
	t.Setenv(shardTotalEnv, "4")
	t.Setenv(shardIDEnv, "10")
	require.Error(t, ValidateShardEnv())
}

func TestMustLoadFromEnvOrPod(t *testing.T) {
	t.Setenv(podNameEnv, "paprika-controller-manager-2")
	t.Setenv(shardTotalEnv, "4")
	_ = os.Unsetenv(shardIDEnv)

	f, err := MustLoadFromEnvOrPod()
	require.NoError(t, err)
	assert.True(t, f.Enabled())
	assert.Equal(t, 2, f.ShardID())
	assert.Equal(t, 4, f.TotalShards())
}

func TestMustLoadFromEnvOrPod_NoSharding(t *testing.T) {
	_ = os.Unsetenv(shardTotalEnv)
	_ = os.Unsetenv(shardIDEnv)
	_ = os.Unsetenv(podNameEnv)

	f, err := MustLoadFromEnvOrPod()
	require.NoError(t, err)
	assert.False(t, f.Enabled())
}

func TestMustLoadFromEnvOrPod_InvalidTotal(t *testing.T) {
	t.Setenv(shardTotalEnv, "abc")
	_, err := MustLoadFromEnvOrPod()
	require.Error(t, err)
}

func TestMustLoadFromEnvOrPod_OutOfRange(t *testing.T) {
	t.Setenv(podNameEnv, "paprika-controller-manager-10")
	t.Setenv(shardTotalEnv, "4")
	_, err := MustLoadFromEnvOrPod()
	require.Error(t, err)
}

func TestExtractOrdinalFromPodName(t *testing.T) {
	assert.Equal(t, 0, extractOrdinalFromPodName("controller-manager-0"))
	assert.Equal(t, 5, extractOrdinalFromPodName("my-pod-5"))
	assert.Equal(t, 123, extractOrdinalFromPodName("paprika-123"))
	assert.Equal(t, -1, extractOrdinalFromPodName("no-ordinal"))
	assert.Equal(t, -1, extractOrdinalFromPodName(""))
}

func TestNewFilterFromEnv_StatefulSetPodName(t *testing.T) {
	t.Setenv(shardTotalEnv, "4")
	t.Setenv(shardIDEnv, "controller-manager-2")

	f := NewFilterFromEnv()
	assert.True(t, f.Enabled())
	assert.Equal(t, 2, f.ShardID())
	assert.Equal(t, 4, f.TotalShards())
}

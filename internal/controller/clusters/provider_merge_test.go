/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package clusters

import (
	"testing"

	"github.com/stretchr/testify/require"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

func TestMergePoolCounts(t *testing.T) {
	t.Parallel()

	derived := []clustersv1alpha1.ClusterNodePool{
		{Name: "core", NodeCount: 4},
		{Name: "core-large", NodeCount: 2},
	}

	t.Run("zero counts inherit the derived count by name", func(t *testing.T) {
		t.Parallel()
		reported := []clustersv1alpha1.ClusterNodePool{
			{Name: "core", NodeCount: 0, MachineType: "vc2-2c-4gb", MinNodes: 4, MaxNodes: 4, AutoScaled: true},
			{Name: "core-large", NodeCount: 0, MachineType: "vc2-4c-8gb"},
		}
		out := mergePoolCounts(reported, derived)
		require.Equal(t, int32(4), out[0].NodeCount)
		require.Equal(t, int32(2), out[1].NodeCount)
		// API-reported fields are preserved through the merge.
		require.True(t, out[0].AutoScaled)
		require.Equal(t, int32(4), out[0].MaxNodes)
	})

	t.Run("nonzero reported counts win", func(t *testing.T) {
		t.Parallel()
		reported := []clustersv1alpha1.ClusterNodePool{{Name: "core", NodeCount: 9}}
		out := mergePoolCounts(reported, derived)
		require.Equal(t, int32(9), out[0].NodeCount)
	})

	t.Run("unknown pools keep zero", func(t *testing.T) {
		t.Parallel()
		reported := []clustersv1alpha1.ClusterNodePool{{Name: "search", NodeCount: 0}}
		out := mergePoolCounts(reported, derived)
		require.Equal(t, int32(0), out[0].NodeCount)
	})
}

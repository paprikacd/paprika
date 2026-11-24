package postgresql

import (
	"strings"
	"testing"

	"github.com/lib/pq"
	"github.com/stretchr/testify/require"
)

func TestNormalizeListParameterBindsTextArray(t *testing.T) {
	bound, err := normalizeParameter([]any{"omega", "delta"})
	require.NoError(t, err)
	require.Equal(t, pq.StringArray{"omega", "delta"}, bound)

	empty, err := normalizeParameter([]any{})
	require.NoError(t, err)
	require.Equal(t, pq.StringArray{}, empty, "an empty array is a list, not NULL")

	null, err := normalizeParameter(nil)
	require.NoError(t, err)
	require.Nil(t, null, "All reaches the query as NULL")
}

func TestNormalizeListParameterRefusesBadElements(t *testing.T) {
	_, err := normalizeParameter([]any{"omega", 5.0})
	require.Error(t, err, "a number is not text")

	_, err = normalizeParameter([]any{"a\x00b"})
	require.Error(t, err, "a NUL byte is refused")

	many := make([]any, 101)
	for i := range many {
		many[i] = strings.Repeat("a", 1)
	}
	_, err = normalizeParameter(many)
	require.Error(t, err, "more than 100 items")
}

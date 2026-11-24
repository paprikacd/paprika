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

// The array reaches PostgreSQL as one bound text[] parameter. Items that look like SQL or array syntax are
// quoted in the array literal and come back unchanged, so no item can add elements or statement text.
func TestNormalizeListParameterQuotesHostileItems(t *testing.T) {
	hostile := []any{"x'); DROP TABLE t; --", `"},{"`, `a\b`, "NULL", "", "{}", "é,🙂"}
	bound, err := normalizeParameter(hostile)
	require.NoError(t, err)
	array, ok := bound.(pq.StringArray)
	require.True(t, ok, "a list binds as text[]")
	encoded, err := array.Value()
	require.NoError(t, err)
	literal, ok := encoded.(string)
	require.True(t, ok)
	var decoded pq.StringArray
	require.NoError(t, decoded.Scan([]byte(literal)))
	require.Len(t, decoded, len(hostile))
	for index, item := range hostile {
		require.Equal(t, item, decoded[index])
	}

	_, err = normalizeParameter([]any{[]any{"nested"}})
	require.Error(t, err, "a nested array is not text")
	_, err = normalizeParameter([]any{nil})
	require.Error(t, err, "a null item is not text")
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

package variablevalue

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestValueJSONRoundTrip(t *testing.T) {
	text, err := json.Marshal(Single("omega"))
	require.NoError(t, err)
	require.JSONEq(t, `"omega"`, string(text))

	empty, err := json.Marshal(List(nil))
	require.NoError(t, err)
	require.Equal(t, "[]", string(empty))

	var decoded Value
	require.NoError(t, json.Unmarshal([]byte(`["omega","delta"]`), &decoded))
	require.Equal(t, List([]string{"omega", "delta"}), decoded)

	var single Value
	require.NoError(t, json.Unmarshal([]byte(`"omega"`), &single))
	require.Equal(t, Single("omega"), single)
}

func TestValueRejectsOtherJSONShapes(t *testing.T) {
	for _, raw := range []string{`null`, `5`, `{}`, `[1]`, `[null]`, `true`} {
		var value Value
		require.Error(t, json.Unmarshal([]byte(raw), &value), raw)
	}
}

func TestValueValidateBounds(t *testing.T) {
	require.NoError(t, List(nil).Validate())
	require.Error(t, List([]string{"a", "a"}).Validate(), "duplicates")
	require.NoError(t, Single(strings.Repeat("x", 1024)).Validate())
	require.Error(t, Single(strings.Repeat("x", 1025)).Validate())

	hundred := make([]string, 0, MaxItems)
	for i := range MaxItems {
		hundred = append(hundred, string(rune('a'+i%26))+string(rune('a'+i/26)))
	}
	require.NoError(t, List(hundred).Validate())
	require.Error(t, List(append(hundred, "extra")).Validate(), "101 items")

	// Two items of 511 and 512 units plus one separator is 1024; one more unit is over budget.
	require.NoError(t, List([]string{strings.Repeat("a", 511), strings.Repeat("b", 512)}).Validate())
	require.Error(t, List([]string{strings.Repeat("a", 512), strings.Repeat("b", 512)}).Validate())
}

func TestNormalize(t *testing.T) {
	list, err := Single("omega").Normalize(true, false)
	require.NoError(t, err)
	require.Equal(t, List([]string{"omega"}), list, "a string for a multi variable becomes a one-item list")

	_, err = List(nil).Normalize(true, false)
	require.Error(t, err, "[] needs allowAll")
	all, err := List(nil).Normalize(true, true)
	require.NoError(t, err)
	require.True(t, all.List)
	require.Empty(t, all.Items)

	_, err = List([]string{"a"}).Normalize(false, false)
	require.Error(t, err, "a list on a single variable is rejected")
	text, err := Single("a").Normalize(false, false)
	require.NoError(t, err)
	require.Equal(t, Single("a"), text)
}

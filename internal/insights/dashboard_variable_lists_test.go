package insights

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/insights/variablevalue"
)

func TestDashboardVariableValuesApplyTheDeclaration(t *testing.T) {
	definitions := []dashboardReadVariable{
		{Name: "cluster", Multi: true, AllowAll: true, Options: []string{"omega", "delta"}},
		{Name: "region", Options: []string{"eu", "us"}},
	}

	values, err := dashboardVariableValues(definitions, map[string]variablevalue.Value{"cluster": variablevalue.Single("omega")})
	require.NoError(t, err)
	require.Equal(t, variablevalue.List([]string{"omega"}), values["cluster"], "a string for a multi variable is one item")

	values, err = dashboardVariableValues(definitions, map[string]variablevalue.Value{"cluster": variablevalue.List(nil)})
	require.NoError(t, err)
	require.Equal(t, variablevalue.List(nil), values["cluster"], "an empty list is All")

	_, err = dashboardVariableValues(definitions, map[string]variablevalue.Value{"region": variablevalue.List([]string{"eu"})})
	require.Error(t, err, "a list for a single-value variable is refused")
}

func TestDashboardWidgetQueryExpandsAListAsAnAlternation(t *testing.T) {
	definitions := []dashboardReadVariable{{Name: "cluster", Multi: true, Options: []string{"omega", "delta"}}}
	widget := &dashboardReadWidget{ID: "w", Type: "timeseries", Query: `up{cluster=~{{cluster}}}`}

	query, failure := resolveDashboardWidget(widget, nil, map[string]variablevalue.Value{
		"cluster": variablevalue.List([]string{"omega", "delta"}),
	}, definitions)
	require.Nil(t, failure)
	require.Equal(t, `up{cluster=~"omega|delta"}`, query.Query)
}

func TestDashboardWidgetQueryRefusesAListAfterEquality(t *testing.T) {
	definitions := []dashboardReadVariable{{Name: "cluster", Multi: true, Options: []string{"omega"}}}
	widget := &dashboardReadWidget{ID: "w", Type: "timeseries", Query: `up{cluster={{cluster}}}`}

	_, failure := resolveDashboardWidget(widget, nil, map[string]variablevalue.Value{
		"cluster": variablevalue.List([]string{"omega"}),
	}, definitions)
	require.NotNil(t, failure, "equality cannot take several values")
}

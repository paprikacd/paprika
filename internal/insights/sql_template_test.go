package insights

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSQLTemplateBindsValuesWithoutChangingSQL(t *testing.T) {
	for name, query := range map[string]string{
		"string":           `{"sql":"SELECT service FROM services WHERE service=$1","parameters":[{{service}}]}`,
		"typed values":     `{"sql":"SELECT $1,$2,$3,$4","parameters":[{{service}},{{limit}},true,null]}`,
		"fixed projection": `{"sql":"SELECT time,value FROM samples WHERE service=$1","parameters":[{{service}}],"projection":{"time":"time","value":"value"}}`,
		"plain SQL":        `SELECT service FROM services`,
	} {
		t.Run(name, func(t *testing.T) { require.NoError(t, validateSQLTemplate("postgresql", query)) })
	}
}

func TestSQLTemplateRejectsStructuralInterpolation(t *testing.T) {
	for name, query := range map[string]string{
		"native SQL":             `SELECT * FROM services WHERE service={{service}}`,
		"quoted SQL placeholder": `{"sql":"SELECT * FROM services WHERE service={{service}}","parameters":[]}`,
		"whole SQL":              `{"sql":{{sql}},"parameters":[]}`,
		"quoted parameter":       `{"sql":"SELECT $1","parameters":["{{service}}"]}`,
		"missing array":          `{"sql":"SELECT $1","parameters":{{service}}}`,
		"projection":             `{"sql":"SELECT $1","parameters":[{{service}}],"projection":{"value":{{column}}}}`,
		"duplicate SQL":          `{"sql":"SELECT $1","parameters":[{{service}}],"sql":"SELECT $2"}`,
		"duplicate parameters":   `{"sql":"SELECT $1","parameters":[{{service}}],"parameters":[]}`,
		"trailing JSON":          `{"sql":"SELECT $1","parameters":[{{service}}]} {}`,
		"invalid JSON":           `{"sql":"SELECT $1","parameters":[{{service}}],}`,
		"unfinished placeholder": `{"sql":"SELECT $1","parameters":[{{service]}`,
	} {
		t.Run(name, func(t *testing.T) { require.Error(t, validateSQLTemplate("postgresql", query)) })
	}
	// Other query languages retain their own interpolation contract.
	require.NoError(t, validateSQLTemplate("prometheus", `up{service={{service}}}`))
}

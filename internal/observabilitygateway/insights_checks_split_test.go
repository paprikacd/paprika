package observabilitygateway

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// The checks member is cut from the saved bytes. Key order and spelling of the
// document survive, which a decode-and-re-encode would not keep.
func TestSplitInsightsChecksKeepsDocumentBytes(t *testing.T) {
	saved := `{"widgets":[],"title":"Ordered","id":"ordered","schemaVersion":1,"timeRange":"1h","refreshInterval":0}`
	body := []byte(saved[:len(saved)-1] + `,"checks":{"issues":[],"total":0,"truncated":false,"errorCount":0,"warningCount":0,"infoCount":0}}` + "\n")

	document, report, err := splitInsightsChecks(body)
	require.NoError(t, err)
	require.Equal(t, saved, string(document))
	require.NotNil(t, report)
	require.Equal(t, uint32(0), report.GetErrorCount())
}

func TestSplitInsightsChecksPassesThroughBodiesWithoutChecks(t *testing.T) {
	body := []byte(`{"id":"plain","schemaVersion":1}` + "\n")
	document, report, err := splitInsightsChecks(body)
	require.NoError(t, err)
	require.Equal(t, string(body), string(document))
	require.Nil(t, report)
}

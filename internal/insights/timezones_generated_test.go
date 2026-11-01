package insights

import (
	"os"
	"regexp"
	"slices"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// uiTimeZoneFile is relative to this package, the directory `go test` runs in.
const uiTimeZoneFile = "../../ui/src/features/insights/time-zones.generated.ts"

// uiTimeZoneEntry matches one name in the array that time-zones.generated.ts exports.
var uiTimeZoneEntry = regexp.MustCompile(`(?m)^  "([^"]+)",$`)

func TestServerAndUITimeZoneListsMatch(t *testing.T) {
	source, err := os.ReadFile(uiTimeZoneFile)
	require.NoError(t, err)
	matches := uiTimeZoneEntry.FindAllStringSubmatch(string(source), -1)
	uiZones := make([]string, 0, len(matches))
	for _, match := range matches {
		uiZones = append(uiZones, match[1])
	}
	require.NotEmpty(t, uiZones, "the UI list must be readable from the generated file")
	require.True(t, slices.IsSorted(uiZones), "the UI list is sorted byte-wise")
	require.Len(t, slices.Compact(slices.Clone(uiZones)), len(uiZones), "the UI list has no duplicates")

	serverZones := make([]string, 0, len(canonicalTimeZones))
	for zone := range canonicalTimeZones {
		serverZones = append(serverZones, zone)
	}
	slices.Sort(serverZones)
	require.Equal(t, serverZones, uiZones, "the server and the UI must accept the same names; regenerate with go run ./hack/gen-time-zones")
}

func TestCanonicalTimeZonesExcludeNonZoneNamesAndLoad(t *testing.T) {
	for _, zone := range []string{"Local", "localtime", "Factory", "posixrules", "+05:30", "-08:00", ""} {
		_, ok := canonicalTimeZones[zone]
		require.False(t, ok, "%q is not a dashboard zone", zone)
	}
	for zone := range canonicalTimeZones {
		_, err := time.LoadLocation(zone)
		require.NoError(t, err, "every canonical name must load in Go: %s", zone)
	}
}

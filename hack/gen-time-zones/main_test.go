package main

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestExcludedNamesAreNotDashboardZones(t *testing.T) {
	for _, name := range []string{"Factory", "Local", "localtime", "posixrules", "posix/Europe/London", "right/UTC", "+05:30", "-08:00"} {
		require.True(t, excluded(name), name)
	}
}

func TestZoneAndLinkNamesAreKept(t *testing.T) {
	// Links and the Etc/GMT+-N names stay: both runtimes already accepted them, and saved dashboards may name them.
	for _, name := range []string{"UTC", "Europe/London", "Etc/GMT+5", "US/Pacific", "Asia/Calcutta", "GMT+0", "Zulu"} {
		require.False(t, excluded(name), name)
	}
}

func TestAllowlistIsSortedUniqueAndRefusesUnsafeNames(t *testing.T) {
	zones, err := allowlist([]string{"Europe/London", "UTC", "Factory", "Europe/London", "Asia/Kolkata"})
	require.NoError(t, err)
	require.Equal(t, []string{"Asia/Kolkata", "Europe/London", "UTC"}, zones)

	_, err = allowlist([]string{"Bad Name"})
	require.Error(t, err)
	_, err = allowlist([]string{"Factory"})
	require.Error(t, err, "an archive with nothing left to list is an error, not an empty allowlist")
}

func TestRenderedFilesListEveryZoneOnce(t *testing.T) {
	zones := []string{"Asia/Kolkata", "UTC"}
	require.Contains(t, string(renderTS(zones)), "export const timeZones = [\n  \"Asia/Kolkata\",\n  \"UTC\",\n] as const\n")
	require.Contains(t, string(renderGo(zones)), "var canonicalTimeZones = map[string]struct{}{\n\t\"Asia/Kolkata\": {},\n\t\"UTC\": {},\n}\n")
}

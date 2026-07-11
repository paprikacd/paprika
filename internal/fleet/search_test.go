package fleet

import (
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNormalizeSearchUnicodeAndSeparators(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "NFKC compatibility characters",
			raw:  "Ｆｏｏ-ﬃ",
			want: "foo ffi",
		},
		{
			name: "Unicode lowercase and outer trim",
			raw:  "\u2003  ΣERVICE\u00a0",
			want: "σervice",
		},
		{
			name: "mixed repeated separators",
			raw:  "--alpha_._\t\n\u2003beta...gamma__--",
			want: "alpha beta gamma",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			got, err := NormalizeSearch(test.raw)
			require.NoError(t, err)
			require.Equal(t, test.want, got)
		})
	}
}

func TestNormalizeSearchCountsRawUnicodeRunes(t *testing.T) {
	t.Parallel()

	accepted := strings.Repeat("界", MaxSearchRunes)
	got, err := NormalizeSearch(accepted)
	require.NoError(t, err)
	require.Equal(t, accepted, got)

	_, err = NormalizeSearch(accepted + "界")
	require.Error(t, err)
	var invalid *InvalidSearchError
	require.ErrorAs(t, err, &invalid)
	require.Equal(t, MaxSearchRunes+1, invalid.RuneCount)
	require.Equal(t, MaxSearchRunes, invalid.Maximum)
}

func TestSearchRanksExactPrefixSubstringThenTrigram(t *testing.T) {
	t.Parallel()

	apps := []ApplicationSummary{
		application("b", "alpha"),
		application("a", "alpha"),
		application("z", "alpha-service"),
		application("a", "my-alpha-service"),
		application("m", "alphx"),
		application("a", "alphx"),
		application("x", "alpine"),
	}
	snapshot := searchSnapshot(t, apps...)
	candidates := make(IDSet, len(apps))
	for _, app := range apps {
		candidates[app.Identity] = struct{}{}
	}

	matches, err := snapshot.Search("alpha", candidates)
	require.NoError(t, err)
	require.Equal(t, []SearchMatch{
		{Identity: fleetID("a", "alpha"), Tier: SearchTierExact},
		{Identity: fleetID("b", "alpha"), Tier: SearchTierExact},
		{Identity: fleetID("z", "alpha-service"), Tier: SearchTierPrefix},
		{Identity: fleetID("a", "my-alpha-service"), Tier: SearchTierSubstring},
		{
			Identity:       fleetID("a", "alphx"),
			Tier:           SearchTierTrigram,
			Similarity:     0.5,
			SharedTrigrams: 2,
			UnionTrigrams:  4,
		},
		{
			Identity:       fleetID("m", "alphx"),
			Tier:           SearchTierTrigram,
			Similarity:     0.5,
			SharedTrigrams: 2,
			UnionTrigrams:  4,
		},
	}, matches)
}

func TestSearchSortsTrigramSimilarityByExactRatio(t *testing.T) {
	t.Parallel()

	apps := []ApplicationSummary{
		application("a", "abcdxy"), // 2/5 shared/union with abcde.
		application("z", "abcdx"),  // 2/4 shared/union with abcde.
	}
	snapshot := searchSnapshot(t, apps...)
	candidates := idSet(apps[0].Identity, apps[1].Identity)

	matches, err := snapshot.Search("abcde", candidates)
	require.NoError(t, err)
	require.Len(t, matches, 2)
	require.Equal(t, fleetID("z", "abcdx"), matches[0].Identity)
	require.Equal(t, fleetID("a", "abcdxy"), matches[1].Identity)
	require.Equal(t, 2, matches[0].SharedTrigrams)
	require.Equal(t, 4, matches[0].UnionTrigrams)
	require.Equal(t, 2, matches[1].SharedTrigrams)
	require.Equal(t, 5, matches[1].UnionTrigrams)
}

func TestSearchIncludesExactTrigramThresholdAndExcludesBelow(t *testing.T) {
	t.Parallel()

	boundary := application("allowed", "xxabcdeyyy")
	below := application("allowed", "zxxabcdeyyy")
	snapshot := searchSnapshot(t, boundary, below)

	matches, err := snapshot.Search("abcdefg", idSet(boundary.Identity, below.Identity))
	require.NoError(t, err)
	require.Equal(t, []SearchMatch{{
		Identity:       boundary.Identity,
		Tier:           SearchTierTrigram,
		Similarity:     0.3,
		SharedTrigrams: 3,
		UnionTrigrams:  10,
	}}, matches)
}

func TestSearchIntersectsCallerCandidatesBeforeMatching(t *testing.T) {
	t.Parallel()

	unauthorized := application("private", "secret")
	authorized := application("public", "my-secret-service")
	other := application("public", "other")
	snapshot := searchSnapshot(t, unauthorized, authorized, other)

	matches, err := snapshot.Search("secret", idSet(authorized.Identity, other.Identity))
	require.NoError(t, err)
	require.Equal(t, []SearchMatch{{
		Identity: authorized.Identity,
		Tier:     SearchTierSubstring,
	}}, matches)

	for _, candidates := range []IDSet{nil, {}} {
		matches, err = snapshot.Search("secret", candidates)
		require.NoError(t, err)
		require.Empty(t, matches)
	}
}

func TestSearchEmptyNormalizedQueryIsCandidateScopedAndDeterministic(t *testing.T) {
	t.Parallel()

	apps := []ApplicationSummary{
		application("z", "third"),
		application("a", "second"),
		application("a", "first"),
		application("private", "not-authorized"),
	}
	snapshot := searchSnapshot(t, apps...)
	candidates := idSet(apps[0].Identity, apps[1].Identity, apps[2].Identity)

	matches, err := snapshot.Search(" -._\u2003 ", candidates)
	require.NoError(t, err)
	require.Equal(t, []SearchMatch{
		{Identity: fleetID("a", "first"), Tier: SearchTierNeutral},
		{Identity: fleetID("a", "second"), Tier: SearchTierNeutral},
		{Identity: fleetID("z", "third"), Tier: SearchTierNeutral},
	}, matches)
}

func TestSearchUsesNFKCNameDocumentsAndSearchesNameOnly(t *testing.T) {
	t.Parallel()

	compatibilityName := application("ordinary", "Ｆｏｏ")
	namespaceOnly := application("foo", "unrelated")
	snapshot := searchSnapshot(t, compatibilityName, namespaceOnly)

	matches, err := snapshot.Search("foo", idSet(compatibilityName.Identity, namespaceOnly.Identity))
	require.NoError(t, err)
	require.Equal(t, []SearchMatch{{
		Identity: compatibilityName.Identity,
		Tier:     SearchTierExact,
	}}, matches)
}

func TestSearchRejectsOversizedRawQueryWithTypedError(t *testing.T) {
	t.Parallel()

	snapshot := searchSnapshot(t, application("default", "anything"))
	_, err := snapshot.Search(strings.Repeat("界", MaxSearchRunes+1), idSet(fleetID("default", "anything")))
	require.Error(t, err)

	var invalid *InvalidSearchError
	require.True(t, errors.As(err, &invalid))
}

func TestSearchUsesDirectMatchingWithoutFuzzyTrigramsForShortNames(t *testing.T) {
	t.Parallel()

	short := application("default", "ø")
	snapshot := searchSnapshot(t, short)

	require.NotContains(t, snapshot.Trigrams, "ø")
	matches, err := snapshot.Search("ø", idSet(short.Identity))
	require.NoError(t, err)
	require.Equal(t, []SearchMatch{{Identity: short.Identity, Tier: SearchTierExact}}, matches)
}

package fleet

import (
	"fmt"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
	"k8s.io/apimachinery/pkg/types"
)

const (
	// MaxSearchRunes bounds raw caller input. The bound deliberately counts
	// Unicode code points rather than UTF-8 bytes.
	MaxSearchRunes = 128

	minimumTrigramShared = 3
	minimumTrigramUnion  = 10
)

// InvalidSearchError reports an inspectable validation failure for raw search
// input.
type InvalidSearchError struct {
	RuneCount int
	Maximum   int
}

func (e *InvalidSearchError) Error() string {
	return fmt.Sprintf("search contains %d Unicode runes; maximum is %d", e.RuneCount, e.Maximum)
}

// SearchTier identifies the strongest name match. Neutral is used only for an
// empty normalized query and returns the caller's candidates without changing
// their authorization scope.
type SearchTier uint8

const (
	SearchTierNeutral   SearchTier = 0
	SearchTierExact     SearchTier = 1
	SearchTierPrefix    SearchTier = 2
	SearchTierSubstring SearchTier = 3
	SearchTierTrigram   SearchTier = 4
)

// SearchMatch retains the exact Jaccard fraction used for ordering. Similarity
// is a convenience projection; comparisons use SharedTrigrams/UnionTrigrams
// and integer cross-multiplication.
type SearchMatch struct {
	Identity       types.NamespacedName
	Tier           SearchTier
	Similarity     float64
	SharedTrigrams int
	UnionTrigrams  int
}

type searchDocument struct {
	normalizedName string
	trigrams       map[string]struct{}
}

// NormalizeSearch applies Unicode NFKC normalization, Unicode lowercasing,
// and separator folding after validating the raw query's rune count.
func NormalizeSearch(raw string) (string, error) {
	runeCount := utf8.RuneCountInString(raw)
	if runeCount > MaxSearchRunes {
		return "", &InvalidSearchError{RuneCount: runeCount, Maximum: MaxSearchRunes}
	}
	return normalizeText(raw), nil
}

func normalizeText(raw string) string {
	normalized := norm.NFKC.String(raw)
	var builder strings.Builder
	builder.Grow(len(normalized))
	pendingSeparator := false

	for _, r := range normalized {
		if isSearchSeparator(r) {
			if builder.Len() > 0 {
				pendingSeparator = true
			}
			continue
		}
		if pendingSeparator {
			builder.WriteByte(' ')
			pendingSeparator = false
		}
		builder.WriteRune(unicode.ToLower(r))
	}
	return builder.String()
}

func isSearchSeparator(r rune) bool {
	return r == '-' || r == '_' || r == '.' || unicode.IsSpace(r)
}

// Search matches application names only and never broadens beyond candidates.
// Its fuzzy tier uses set-Jaccard similarity over unique Unicode-rune trigrams.
func (s *Snapshot) Search(rawQuery string, candidates IDSet) ([]SearchMatch, error) {
	query, err := NormalizeSearch(rawQuery)
	if err != nil {
		return nil, err
	}

	allowed := s.intersectApplications(candidates)
	if len(allowed) == 0 {
		return []SearchMatch{}, nil
	}

	if query == "" {
		return neutralMatches(allowed), nil
	}

	matches, ranked := s.directMatches(query, allowed)
	matches = append(matches, s.trigramMatches(query, allowed, ranked)...)
	sort.Slice(matches, func(i, j int) bool {
		return searchMatchLess(matches[i], matches[j])
	})
	return matches, nil
}

func (s *Snapshot) intersectApplications(candidates IDSet) IDSet {
	allowed := make(IDSet)
	for id := range candidates {
		if _, ok := s.Applications[id]; ok {
			allowed[id] = struct{}{}
		}
	}
	return allowed
}

func neutralMatches(allowed IDSet) []SearchMatch {
	matches := make([]SearchMatch, 0, len(allowed))
	for _, id := range sortedIDs(allowed) {
		matches = append(matches, SearchMatch{Identity: id, Tier: SearchTierNeutral})
	}
	return matches
}

func (s *Snapshot) directMatches(query string, allowed IDSet) ([]SearchMatch, IDSet) {
	matches := make([]SearchMatch, 0, len(allowed))
	ranked := make(IDSet)
	for _, id := range sortedIDs(allowed) {
		document, ok := s.searchDocuments[id]
		if !ok {
			continue
		}

		tier, ok := directSearchTier(document.normalizedName, query)
		if !ok {
			continue
		}
		matches = append(matches, SearchMatch{Identity: id, Tier: tier})
		ranked[id] = struct{}{}
	}
	return matches, ranked
}

func (s *Snapshot) trigramMatches(query string, allowed, ranked IDSet) []SearchMatch {
	queryTrigrams := trigramSet(query)
	fuzzyCandidates := s.trigramCandidates(queryTrigrams, allowed, ranked)
	matches := make([]SearchMatch, 0, len(fuzzyCandidates))
	for id := range fuzzyCandidates {
		document := s.searchDocuments[id]
		shared, union := jaccardCounts(queryTrigrams, document.trigrams)
		if union == 0 || shared*minimumTrigramUnion < union*minimumTrigramShared {
			continue
		}
		matches = append(matches, SearchMatch{
			Identity:       id,
			Tier:           SearchTierTrigram,
			Similarity:     float64(shared) / float64(union),
			SharedTrigrams: shared,
			UnionTrigrams:  union,
		})
	}
	return matches
}

func (s *Snapshot) trigramCandidates(queryTrigrams map[string]struct{}, allowed, ranked IDSet) IDSet {
	fuzzyCandidates := make(IDSet)
	for trigram := range queryTrigrams {
		for id := range s.Trigrams[trigram] {
			if _, ok := allowed[id]; !ok {
				continue
			}
			if _, ok := ranked[id]; !ok {
				fuzzyCandidates[id] = struct{}{}
			}
		}
	}
	return fuzzyCandidates
}

func (s *Snapshot) rebuildSearchIndex() {
	s.searchDocuments = make(map[types.NamespacedName]searchDocument, len(s.Applications))
	s.Trigrams = make(map[string]IDSet)
	for id := range s.Applications {
		normalizedName := normalizeText(id.Name)
		trigrams := trigramSet(normalizedName)
		s.searchDocuments[id] = searchDocument{
			normalizedName: normalizedName,
			trigrams:       trigrams,
		}
		for trigram := range trigrams {
			posting := s.Trigrams[trigram]
			if posting == nil {
				posting = make(IDSet)
				s.Trigrams[trigram] = posting
			}
			posting[id] = struct{}{}
		}
	}
}

func directSearchTier(document, query string) (SearchTier, bool) {
	switch {
	case document == query:
		return SearchTierExact, true
	case strings.HasPrefix(document, query):
		return SearchTierPrefix, true
	case strings.Contains(document, query):
		return SearchTierSubstring, true
	default:
		return SearchTierNeutral, false
	}
}

func trigramSet(value string) map[string]struct{} {
	runes := []rune(value)
	trigrams := make(map[string]struct{})
	if len(runes) == 0 {
		return trigrams
	}
	if len(runes) < 3 {
		// Short strings participate only in exact, prefix, and substring tiers.
		// They have no padded or synthetic fuzzy trigrams.
		return trigrams
	}
	for i := 0; i <= len(runes)-3; i++ {
		trigrams[string(runes[i:i+3])] = struct{}{}
	}
	return trigrams
}

func jaccardCounts(left, right map[string]struct{}) (shared, union int) {
	for token := range left {
		if _, ok := right[token]; ok {
			shared++
		}
	}
	return shared, len(left) + len(right) - shared
}

func searchMatchLess(left, right SearchMatch) bool {
	leftRank, rightRank := tierRank(left.Tier), tierRank(right.Tier)
	if leftRank != rightRank {
		return leftRank < rightRank
	}
	if left.Tier == SearchTierTrigram &&
		left.SharedTrigrams*right.UnionTrigrams != right.SharedTrigrams*left.UnionTrigrams {
		return left.SharedTrigrams*right.UnionTrigrams > right.SharedTrigrams*left.UnionTrigrams
	}
	if left.Identity.Namespace != right.Identity.Namespace {
		return left.Identity.Namespace < right.Identity.Namespace
	}
	return left.Identity.Name < right.Identity.Name
}

func tierRank(tier SearchTier) uint8 {
	switch tier {
	case SearchTierExact:
		return 0
	case SearchTierPrefix:
		return 1
	case SearchTierSubstring:
		return 2
	case SearchTierTrigram:
		return 3
	case SearchTierNeutral:
		return 4
	default:
		return 5
	}
}

func sortedIDs(set IDSet) []types.NamespacedName {
	ids := make([]types.NamespacedName, 0, len(set))
	for id := range set {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		if ids[i].Namespace != ids[j].Namespace {
			return ids[i].Namespace < ids[j].Namespace
		}
		return ids[i].Name < ids[j].Name
	})
	return ids
}

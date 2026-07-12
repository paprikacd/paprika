package apiserver

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"connectrpc.com/connect"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/fleet"
)

const (
	defaultReleaseQueryPageSize = 24
	maxReleaseQueryPageSize     = 100
	maxReleaseQueryOffset       = 1_000_000
)

// QueryReleases returns one bounded, authorized release page with optional
// fleet-backed application filtering and deterministic search relevance.
//
//nolint:gocyclo,cyclop,funlen,gocognit // Keep validation, authorization, filtering, and cancellation order visible at the RPC boundary.
func (s *PaprikaServer) QueryReleases(
	ctx context.Context,
	req *connect.Request[paprikav1.QueryReleasesRequest],
) (response *connect.Response[paprikav1.QueryReleasesResponse], err error) {
	started := time.Now()
	resultCount := 0
	defer func() {
		recordAPIList(ctx, "releases", started, resultCount, err)
	}()

	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	normalizedSearch, normalizeErr := fleet.NormalizeSearch(req.Msg.Search)
	if normalizeErr != nil {
		return nil, mapFleetError(normalizeErr)
	}
	if filterErr := validateFleetFilter(req.Msg.Filter); filterErr != nil {
		return nil, filterErr
	}
	filter, err := fleetFilterFromProto(req.Msg.Filter)
	if err != nil {
		return nil, err
	}
	if req.Msg.PageSize > maxReleaseQueryPageSize {
		return nil, fleetInvalidArgument("page_size must not exceed %d", maxReleaseQueryPageSize)
	}
	if req.Msg.PageOffset > maxReleaseQueryOffset {
		return nil, fleetInvalidArgument("page_offset must not exceed %d", maxReleaseQueryOffset)
	}
	pageSize := req.Msg.PageSize
	if pageSize == 0 {
		pageSize = defaultReleaseQueryPageSize
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, mapFleetError(ctxErr)
	}

	allowedApplications, scoped, scopeErr := s.queryReleaseApplicationScope(ctx, &filter)
	if scopeErr != nil {
		return nil, scopeErr
	}

	var list pipelinesv1alpha1.ReleaseList
	// QueryReleases is strictly read-only. With a cache-backed client this
	// avoids deep-copying every Release; callers must never mutate list.Items.
	if listErr := s.client.List(ctx, &list, client.UnsafeDisableDeepCopy); listErr != nil {
		return nil, mapFleetError(fmt.Errorf("listing releases: %w", listErr))
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, mapFleetError(ctxErr)
	}

	terms := strings.Fields(normalizedSearch)
	candidates := make([]releaseQueryCandidate, 0, len(list.Items))
	for i := range list.Items {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, mapFleetError(ctxErr)
		}
		release := &list.Items[i]
		authorized, authorizeErr := s.authorizeReleaseRead(ctx, release)
		if authorizeErr != nil {
			return nil, mapFleetError(authorizeErr)
		}
		if !authorized {
			continue
		}
		if scoped {
			application := types.NamespacedName{
				Namespace: release.Namespace,
				Name:      release.Labels[engine.ApplicationNameLabelKey],
			}
			if _, allowed := allowedApplications[application]; !allowed {
				continue
			}
		}
		rank, matches := rankReleaseSearch(release, normalizedSearch, terms)
		if !matches {
			continue
		}
		candidates = append(candidates, releaseQueryCandidate{release: release, rank: rank})
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, mapFleetError(ctxErr)
	}

	sortReleaseQueryCandidates(candidates, normalizedSearch != "")
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, mapFleetError(ctxErr)
	}
	total := uint64(len(candidates))
	offset := min(int(req.Msg.PageOffset), len(candidates))
	end := min(offset+int(pageSize), len(candidates))
	releases := make([]*paprikav1.Release, 0, end-offset)
	for i := offset; i < end; i++ {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, mapFleetError(ctxErr)
		}
		releases = append(releases, convertRelease(candidates[i].release))
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, mapFleetError(ctxErr)
	}
	resultCount = len(releases)
	return connect.NewResponse(&paprikav1.QueryReleasesResponse{
		Releases: releases, TotalCount: total,
	}), nil
}

func (s *PaprikaServer) authorizeReleaseRead(
	ctx context.Context,
	release *pipelinesv1alpha1.Release,
) (bool, error) {
	project := release.Labels[projectLabelKey]
	if project == "" {
		project = defaultProjectName
	}
	err := s.authorizeProject(
		ctx, auth.ActionRead, auth.ResourceReleases, release.Namespace, project,
	)
	if errors.Is(err, auth.ErrUnauthorized) {
		return false, nil
	}
	return err == nil, err
}

func (s *PaprikaServer) queryReleaseApplicationScope(
	ctx context.Context,
	filter *fleet.ApplicationFilter,
) (fleet.IDSet, bool, error) {
	if filter.ActiveDimensionCount() == 0 {
		return nil, false, nil
	}
	reader, err := s.requireFleetIndex()
	if err != nil {
		return nil, false, err
	}
	scope, err := buildFleetReadQueryScope(
		ctx, reader, s.authorizer, auth.PrincipalFromContext(ctx), filter.Namespaces,
	)
	if err != nil {
		return nil, false, mapFleetError(err)
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, false, mapFleetError(ctxErr)
	}
	snapshot, err := reader.LoadSnapshot()
	if err != nil {
		return nil, false, mapFleetError(err)
	}
	filtered, err := snapshot.FilterApplications(scope, *filter, "")
	if err != nil {
		return nil, false, mapFleetError(err)
	}
	return filtered.IDs, true, nil
}

type releaseQueryRank uint8

const (
	releaseQueryRankExact releaseQueryRank = iota
	releaseQueryRankPrefix
	releaseQueryRankSubstring
	releaseQueryRankMetadata
)

type releaseQueryCandidate struct {
	release *pipelinesv1alpha1.Release
	rank    releaseQueryRank
}

func rankReleaseSearch(
	release *pipelinesv1alpha1.Release,
	normalizedSearch string,
	terms []string,
) (releaseQueryRank, bool) {
	if normalizedSearch == "" {
		return releaseQueryRankMetadata, true
	}
	normalizedName, searchableDocument := fleet.NormalizeSearchDocumentFields(
		release.Name,
		release.Namespace,
		release.Labels[engine.ApplicationNameLabelKey],
		release.Spec.Pipeline,
		release.Spec.Target,
		string(release.Status.Phase),
		release.Status.CurrentStage,
	)
	for _, term := range terms {
		if !strings.Contains(searchableDocument, term) {
			return releaseQueryRankMetadata, false
		}
	}
	switch {
	case normalizedName == normalizedSearch:
		return releaseQueryRankExact, true
	case strings.HasPrefix(normalizedName, normalizedSearch):
		return releaseQueryRankPrefix, true
	case strings.Contains(normalizedName, normalizedSearch):
		return releaseQueryRankSubstring, true
	default:
		return releaseQueryRankMetadata, true
	}
}

func sortReleaseQueryCandidates(candidates []releaseQueryCandidate, searched bool) {
	sort.Slice(candidates, func(i, j int) bool {
		left, right := candidates[i], candidates[j]
		if searched && left.rank != right.rank {
			return left.rank < right.rank
		}
		leftCreated := left.release.CreationTimestamp.UnixNano()
		rightCreated := right.release.CreationTimestamp.UnixNano()
		if leftCreated != rightCreated {
			return leftCreated > rightCreated
		}
		if left.release.Namespace != right.release.Namespace {
			return left.release.Namespace < right.release.Namespace
		}
		return left.release.Name < right.release.Name
	})
}

// ListReleases returns a list of releases.
func (s *PaprikaServer) ListReleases(
	ctx context.Context,
	req *connect.Request[paprikav1.ListReleasesRequest],
) (*connect.Response[paprikav1.ListReleasesResponse], error) {
	started := time.Now()
	var list pipelinesv1alpha1.ReleaseList
	opts := []client.ListOption{}
	if req.Msg.Namespace != nil {
		opts = append(opts, client.InNamespace(*req.Msg.Namespace))
	}
	if err := s.client.List(ctx, &list, opts...); err != nil {
		recordAPIList(ctx, "releases", started, 0, err)
		return nil, fmt.Errorf("listing releases: %w", err)
	}
	releases := make([]*paprikav1.Release, 0, len(list.Items))
	for i := range list.Items {
		rel := &list.Items[i]
		if !s.releaseMatchesListRequest(ctx, rel, req.Msg) {
			continue
		}
		releases = append(releases, convertRelease(rel))
	}
	sortReleasesByNewest(releases)
	total := len(releases)
	releases = paginateReleases(releases, req.Msg.PageOffset, req.Msg.PageSize)
	recordAPIList(ctx, "releases", started, len(releases), nil)
	return connect.NewResponse(&paprikav1.ListReleasesResponse{Releases: releases, TotalCount: safeInt32(total)}), nil
}

func (s *PaprikaServer) releaseMatchesListRequest(ctx context.Context, rel *pipelinesv1alpha1.Release, req *paprikav1.ListReleasesRequest) bool {
	labels := rel.GetLabels()
	if req.ApplicationName != "" && labels[engine.ApplicationNameLabelKey] != req.ApplicationName {
		return false
	}
	if req.Project != "" && labels[projectLabelKey] != req.Project {
		return false
	}
	return s.authorizeProjectFromLabels(ctx, rel, auth.ResourceReleases)
}

func sortReleasesByNewest(releases []*paprikav1.Release) {
	sort.SliceStable(releases, func(i, j int) bool {
		if releases[i].CreatedAt == releases[j].CreatedAt {
			return releases[i].Name < releases[j].Name
		}
		return releases[i].CreatedAt > releases[j].CreatedAt
	})
}

func paginateReleases(releases []*paprikav1.Release, pageOffset, pageSize int32) []*paprikav1.Release {
	if pageOffset <= 0 && pageSize <= 0 {
		return releases
	}
	total := len(releases)
	offset := max(0, min(int(pageOffset), total))
	limit := total
	if pageSize > 0 {
		limit = min(int(pageSize), 500)
	}
	end := min(offset+limit, total)
	return releases[offset:end]
}

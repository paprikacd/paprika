package api

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

type PaprikaServer struct {
	client.Client
}

func NewPaprikaServer(c client.Client) *PaprikaServer {
	return &PaprikaServer{Client: c}
}

var _ v1connect.PaprikaServiceHandler = (*PaprikaServer)(nil)

func (s *PaprikaServer) ListPipelines(
	ctx context.Context,
	req *connect.Request[paprikav1.ListPipelinesRequest],
) (*connect.Response[paprikav1.ListPipelinesResponse], error) {
	var list pipelinesv1alpha1.PipelineList
	if err := s.List(ctx, &list); err != nil {
		return nil, fmt.Errorf("listing pipelines: %w", err)
	}
	pipelines := make([]*paprikav1.Pipeline, 0, len(list.Items))
	for _, p := range list.Items {
		pipelines = append(pipelines, convertPipeline(p))
	}
	return connect.NewResponse(&paprikav1.ListPipelinesResponse{Pipelines: pipelines}), nil
}

func (s *PaprikaServer) ListReleases(
	ctx context.Context,
	req *connect.Request[paprikav1.ListReleasesRequest],
) (*connect.Response[paprikav1.ListReleasesResponse], error) {
	var list pipelinesv1alpha1.ReleaseList
	if err := s.List(ctx, &list); err != nil {
		return nil, fmt.Errorf("listing releases: %w", err)
	}
	releases := make([]*paprikav1.Release, 0, len(list.Items))
	for _, r := range list.Items {
		releases = append(releases, convertRelease(r))
	}
	return connect.NewResponse(&paprikav1.ListReleasesResponse{Releases: releases}), nil
}

func (s *PaprikaServer) ListStages(
	ctx context.Context,
	req *connect.Request[paprikav1.ListStagesRequest],
) (*connect.Response[paprikav1.ListStagesResponse], error) {
	var list pipelinesv1alpha1.StageList
	if err := s.List(ctx, &list); err != nil {
		return nil, fmt.Errorf("listing stages: %w", err)
	}
	stages := make([]*paprikav1.Stage, 0, len(list.Items))
	for _, st := range list.Items {
		stages = append(stages, convertStage(st))
	}
	return connect.NewResponse(&paprikav1.ListStagesResponse{Stages: stages}), nil
}

func convertPipeline(p pipelinesv1alpha1.Pipeline) *paprikav1.Pipeline {
	steps := make([]*paprikav1.Step, 0, len(p.Spec.Steps))
	for _, s := range p.Spec.Steps {
		steps = append(steps, &paprikav1.Step{
			Name:    s.Name,
			Image:   s.Image,
			Script:  s.Script,
			Depends: s.Depends,
		})
	}
	stepStatuses := make([]*paprikav1.StepStatus, 0, len(p.Status.StepStatuses))
	for _, s := range p.Status.StepStatuses {
		ss := &paprikav1.StepStatus{
			Name:  s.Name,
			Phase: string(s.Phase),
		}
		if s.StartedAt != nil {
			ss.StartedAt = ptr(s.StartedAt.Unix())
		}
		if s.CompletedAt != nil {
			ss.CompletedAt = ptr(s.CompletedAt.Unix())
		}
		stepStatuses = append(stepStatuses, ss)
	}
	artifacts := make([]*paprikav1.ArtifactRef, 0, len(p.Spec.Artifacts))
	for _, a := range p.Spec.Artifacts {
		artifacts = append(artifacts, &paprikav1.ArtifactRef{
			Name: a.Name,
			Path: a.Path,
		})
	}
	return &paprikav1.Pipeline{
		Name:         p.Name,
		Namespace:    p.Namespace,
		CreatedAt:    p.CreationTimestamp.Unix(),
		Steps:        steps,
		MaxParallel:  int32(p.Spec.MaxParallel),
		Phase:        string(p.Status.Phase),
		StepStatuses: stepStatuses,
		Artifacts:    artifacts,
	}
}

func convertRelease(r pipelinesv1alpha1.Release) *paprikav1.Release {
	promos := make([]*paprikav1.Promotion, 0, len(r.Status.PromotionHistory))
	for _, ph := range r.Status.PromotionHistory {
		promos = append(promos, &paprikav1.Promotion{
			Stage:     ph.Stage,
			Result:    ph.Result,
			Timestamp: ph.Timestamp.Unix(),
		})
	}
	return &paprikav1.Release{
		Name:             r.Name,
		Namespace:        r.Namespace,
		CreatedAt:        r.CreationTimestamp.Unix(),
		Pipeline:         r.Spec.Pipeline,
		Target:           r.Spec.Target,
		Phase:            string(r.Status.Phase),
		CurrentStage:     r.Status.CurrentStage,
		PromotionHistory: promos,
	}
}

func convertStage(st pipelinesv1alpha1.Stage) *paprikav1.Stage {
	return &paprikav1.Stage{
		Name:      st.Name,
		Namespace: st.Namespace,
		CreatedAt: st.CreationTimestamp.Unix(),
		Ring:      int32(st.Spec.Ring),
		StageName: st.Spec.Name,
	}
}

func ptr[T any](v T) *T {
	return &v
}

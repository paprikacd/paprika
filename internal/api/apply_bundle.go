package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"
	"gopkg.in/yaml.v3"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/controller-runtime/pkg/client"
	k8syaml "sigs.k8s.io/yaml"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
	"github.com/benebsworth/paprika/engine"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/governance"
	"github.com/benebsworth/paprika/policy"
)

// PaprikaServer RBAC for ApplyBundle.
// +kubebuilder:rbac:groups=policy.paprika.io,resources=policies,verbs=get;list;watch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=stages,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=releases,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=configmaps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=namespaces,verbs=get;list;watch;create

const (
	managedByLabel     = "app.paprika.io/managed-by"
	nameLabel          = "app.paprika.io/name"
	releaseLabel       = "app.paprika.io/release"
	historyLabel       = "app.paprika.io/history"
	projectLabelKey    = "app.paprika.io/project"
	defaultProjectName = "default"
	rollbackAnnotation = "paprika.io/rollback-requested"
)

// SetPolicyEvaluator sets the policy evaluator used by ApplyBundle.
func (s *PaprikaServer) SetPolicyEvaluator(e policy.Evaluator) {
	s.evaluator = e
}

// SetGovernanceValidator sets the project boundary validator used by ApplyBundle.
func (s *PaprikaServer) SetGovernanceValidator(v *governance.ProjectValidator) {
	s.governanceValidator = v
}

// SetGovernancePolicyEvaluator sets the project-scoped policy evaluator used by ApplyBundle.
func (s *PaprikaServer) SetGovernancePolicyEvaluator(e *governance.PolicyEvaluator) {
	s.governancePolicyEvaluator = e
}

// ApplyBundle accepts a rendered manifest bundle and creates or updates the
// Application, Stage, Release, and manifest snapshot ConfigMap for an inline
// apply. It evaluates policies before any mutating operation and honours
// dry-run.
//
//nolint:cyclop // project resolution + validation + policy evaluation flow.
func (s *PaprikaServer) ApplyBundle(
	ctx context.Context,
	req *connect.Request[paprikav1.ApplyBundleRequest],
) (*connect.Response[paprikav1.ApplyBundleResponse], error) {
	namespace := req.Msg.Namespace
	if namespace == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("namespace is required"))
	}
	appName := req.Msg.Name
	if appName == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("application name is required"))
	}
	project := req.Msg.Project
	if project == "" {
		project = defaultProjectName
	}

	if err := s.ensureNamespace(ctx, namespace); err != nil {
		return nil, fmt.Errorf("ensure namespace: %w", err)
	}

	bundle, err := s.prepareBundle(req.Msg.Manifests, namespace)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("prepare bundle: %w", err))
	}

	var manifests []*unstructured.Unstructured
	if s.governanceValidator != nil || s.governancePolicyEvaluator != nil {
		manifests, err = manifestsFromBundle(bundle)
		if err != nil {
			return nil, fmt.Errorf("parse bundle: %w", err)
		}
	}

	var boundaryResults []policy.Result
	if s.governanceValidator != nil {
		source := pipelinesv1alpha1.ApplicationSource{
			Type:   pipelinesv1alpha1.SourceTypeInline,
			Inline: &pipelinesv1alpha1.InlineSourceSpec{ConfigMapRef: ""},
		}

		projectObj, resolveErr := s.governanceValidator.ResolveProject(ctx, namespace, project)
		if resolveErr != nil {
			return nil, fmt.Errorf("resolve project: %w", resolveErr)
		}

		violations, vErr := s.governanceValidator.ValidateBundle(ctx, projectObj, source, nil, namespace, "", manifests)
		if vErr != nil {
			return nil, fmt.Errorf("validate bundle: %w", vErr)
		}
		if blocking := violations.Blocking(); len(blocking) > 0 {
			return connect.NewResponse(&paprikav1.ApplyBundleResponse{
				PolicyResults: convertViolationsToPolicyResults(violations),
				Blocked:       true,
				BlockReason:   blocking[0].Message,
			}), nil
		}
		boundaryResults = toPolicyResults(violations)
	}

	var evResult *policy.EvaluationResult
	if s.governancePolicyEvaluator != nil {
		evResult, err = s.evaluatePoliciesForProject(ctx, project, manifests, namespace, appName, req.Msg.SkipPolicies, req.Msg.PolicyOverrides)
	} else {
		evResult, err = s.evaluatePolicies(ctx, bundle, namespace, appName, req.Msg.SkipPolicies, req.Msg.PolicyOverrides)
	}
	if err != nil {
		return nil, fmt.Errorf("evaluate policies: %w", err)
	}
	evResult.Results = append(evResult.Results, boundaryResults...)

	if evResult.Blocked {
		return connect.NewResponse(&paprikav1.ApplyBundleResponse{
			PolicyResults: convertPolicyResults(evResult.Results),
			Blocked:       true,
			BlockReason:   evResult.Message,
		}), nil
	}

	if req.Msg.DryRun {
		app := s.buildApplication(appName, namespace, "", project)
		rel := s.buildRelease(appName, namespace, "", project, bundle, evResult.Results)
		return connect.NewResponse(&paprikav1.ApplyBundleResponse{
			Application:   convertApplication(app),
			Release:       convertRelease(rel),
			PolicyResults: convertPolicyResults(evResult.Results),
			Blocked:       false,
		}), nil
	}

	app, release, err := s.applyInline(ctx, appName, namespace, project, bundle, evResult.Results)
	if err != nil {
		return nil, fmt.Errorf("apply inline bundle: %w", err)
	}

	return connect.NewResponse(&paprikav1.ApplyBundleResponse{
		Application:   convertApplication(app),
		Release:       convertRelease(release),
		PolicyResults: convertPolicyResults(evResult.Results),
		Blocked:       false,
	}), nil
}

func (s *PaprikaServer) ensureNamespace(ctx context.Context, namespace string) error {
	var ns corev1.Namespace
	if err := s.Get(ctx, types.NamespacedName{Name: namespace}, &ns); err != nil {
		if !apierrors.IsNotFound(err) {
			return fmt.Errorf("get namespace: %w", err)
		}
		ns.Name = namespace
		if err := s.Create(ctx, &ns); err != nil {
			return fmt.Errorf("create namespace: %w", err)
		}
	}
	return nil
}

func (s *PaprikaServer) prepareBundle(raw []byte, namespace string) ([]byte, error) {
	if len(raw) == 0 {
		return nil, errors.New("empty manifest bundle")
	}
	docs := engine.SplitYAMLDocuments(raw)
	outDocs := make([]string, 0, len(docs))
	for _, doc := range docs {
		prepared, err := prepareDocument(doc, namespace)
		if err != nil {
			return nil, err
		}
		if prepared == "" {
			continue
		}
		outDocs = append(outDocs, prepared)
	}
	if len(outDocs) == 0 {
		return nil, errors.New("no valid manifests in bundle")
	}
	var b strings.Builder
	for i, d := range outDocs {
		if i > 0 {
			b.WriteString("\n---\n")
		}
		b.WriteString(d)
	}
	return []byte(b.String()), nil
}

func manifestsFromBundle(bundle []byte) ([]*unstructured.Unstructured, error) {
	docs := engine.SplitYAMLDocuments(bundle)
	var out []*unstructured.Unstructured
	for _, doc := range docs {
		obj := &unstructured.Unstructured{}
		if err := k8syaml.Unmarshal(doc, &obj.Object); err != nil {
			return nil, fmt.Errorf("unmarshal manifest: %w", err)
		}
		if obj.Object != nil {
			out = append(out, obj)
		}
	}
	return out, nil
}

func prepareDocument(doc []byte, namespace string) (string, error) {
	trimmed := strings.TrimSpace(string(doc))
	if trimmed == "" {
		return "", nil
	}
	obj := &unstructured.Unstructured{}
	if err := k8syaml.Unmarshal([]byte(trimmed), &obj.Object); err != nil {
		return "", fmt.Errorf("unmarshal manifest: %w", err)
	}
	if obj.Object == nil {
		return "", nil
	}
	if obj.GetNamespace() == "" {
		obj.SetNamespace(namespace)
	}
	objLabels := obj.GetLabels()
	if objLabels == nil {
		objLabels = map[string]string{}
	}
	objLabels[managedByLabel] = "paprika"
	objLabels[nameLabel] = obj.GetName()
	obj.SetLabels(objLabels)

	bytes, err := yaml.Marshal(obj.Object)
	if err != nil {
		return "", fmt.Errorf("marshal manifest: %w", err)
	}
	return string(bytes), nil
}

func (s *PaprikaServer) evaluatePolicies(
	ctx context.Context,
	bundle []byte,
	namespace, appName string,
	skip []string,
	overrides map[string]string,
) (*policy.EvaluationResult, error) {
	opts := policy.EvaluateOptions{
		Namespace:       namespace,
		ApplicationName: appName,
		SkipPolicies:    skip,
		PolicyOverrides: toPolicyActions(overrides),
	}
	if s.evaluator != nil {
		res, err := s.evaluator.Evaluate(ctx, bundle, opts)
		if err != nil {
			return nil, fmt.Errorf("policy evaluator: %w", err)
		}
		return res, nil
	}

	var polList policyv1alpha1.PolicyList
	if err := s.List(ctx, &polList); err != nil {
		return nil, fmt.Errorf("list policies: %w", err)
	}
	pols := make([]policyv1alpha1.Policy, len(polList.Items))
	copy(pols, polList.Items)
	ev := policy.NewEvaluator(pols)
	res, err := ev.Evaluate(ctx, bundle, opts)
	if err != nil {
		return nil, fmt.Errorf("policy evaluator: %w", err)
	}
	return res, nil
}

func (s *PaprikaServer) evaluatePoliciesForProject(
	ctx context.Context,
	project string,
	manifests []*unstructured.Unstructured,
	namespace, appName string,
	skip []string,
	overrides map[string]string,
) (*policy.EvaluationResult, error) {
	opts := policy.EvaluateOptions{
		Namespace:       namespace,
		ApplicationName: appName,
		SkipPolicies:    skip,
		PolicyOverrides: toPolicyActions(overrides),
	}
	violations, err := s.governancePolicyEvaluator.Evaluate(ctx, project, manifests, opts)
	if err != nil {
		return nil, fmt.Errorf("evaluate project policies: %w", err)
	}
	results := make([]policy.Result, 0, len(violations))
	passed := true
	blocked := false
	var message string
	for _, v := range violations {
		results = append(results, violationToPolicyResult(v))
		if v.Blocking() {
			passed = false
			blocked = true
			message = v.Message
		} else if message == "" {
			message = v.Message
		}
	}
	return &policy.EvaluationResult{Passed: passed, Blocked: blocked, Message: message, Results: results}, nil
}

func violationToPolicyResult(v governance.Violation) policy.Result {
	return policy.Result{
		Name:     v.Rule,
		Severity: v.Severity,
		Action:   string(v.Action),
		Passed:   false,
		Message:  v.Message,
	}
}

func toPolicyResults(violations governance.Violations) []policy.Result {
	out := make([]policy.Result, 0, len(violations))
	for _, v := range violations {
		out = append(out, violationToPolicyResult(v))
	}
	return out
}

func convertViolationsToPolicyResults(violations governance.Violations) []*paprikav1.PolicyResult {
	out := make([]*paprikav1.PolicyResult, 0, len(violations))
	for _, v := range violations {
		converted := violationToPolicyResult(v)
		out = append(out, &paprikav1.PolicyResult{
			Name:     converted.Name,
			Severity: converted.Severity,
			Action:   converted.Action,
			Passed:   converted.Passed,
			Message:  converted.Message,
		})
	}
	return out
}

func toPolicyActions(in map[string]string) map[string]policy.Action {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]policy.Action, len(in))
	for k, v := range in {
		out[k] = policy.Action(v)
	}
	return out
}

//nolint:cyclop // inline apply orchestration is inherently sequential.
func (s *PaprikaServer) applyInline(
	ctx context.Context,
	appName, namespace, project string,
	bundle []byte,
	policyResults []policy.Result,
) (*pipelinesv1alpha1.Application, *pipelinesv1alpha1.Release, error) {
	releaseName := generateReleaseName(appName, bundle)
	snapshotName := releaseName + "-manifests"
	stageName := appName + "-default"

	app, err := s.createOrUpdateApplication(ctx, appName, namespace, snapshotName, project)
	if err != nil {
		return nil, nil, err
	}

	if err := s.ensureStage(ctx, appName, namespace, project, releaseName, stageName); err != nil {
		return nil, nil, err
	}

	release := s.buildRelease(appName, namespace, snapshotName, project, bundle, policyResults)
	release.OwnerReferences = []metav1.OwnerReference{{
		APIVersion: pipelinesv1alpha1.GroupVersion.String(),
		Kind:       "Application",
		Name:       app.Name,
		UID:        app.UID,
		Controller: ptr(true),
	}}
	if err := s.Create(ctx, release); err != nil {
		return nil, nil, fmt.Errorf("create release: %w", err)
	}

	if err := s.createSnapshot(ctx, release, appName, namespace, project, snapshotName, releaseName, bundle); err != nil {
		_ = s.Delete(ctx, release)
		return nil, nil, err
	}

	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var freshRelease pipelinesv1alpha1.Release
		if err := s.Get(ctx, types.NamespacedName{Name: release.Name, Namespace: release.Namespace}, &freshRelease); err != nil {
			return fmt.Errorf("fetching release for policy results: %w", err)
		}
		freshRelease.Status.PolicyResults = toReleasePolicyResults(policyResults)
		if err := s.Status().Update(ctx, &freshRelease); err != nil {
			return fmt.Errorf("updating release policy results: %w", err)
		}
		return nil
	}); err != nil {
		_ = s.Delete(ctx, release)
		return nil, nil, fmt.Errorf("update release policy results: %w", err)
	}

	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var freshApp pipelinesv1alpha1.Application
		if err := s.Get(ctx, types.NamespacedName{Name: app.Name, Namespace: app.Namespace}, &freshApp); err != nil {
			return fmt.Errorf("fetching application for releaseRef: %w", err)
		}
		freshApp.Status.ReleaseRef = release.Name
		if err := s.Status().Update(ctx, &freshApp); err != nil {
			return fmt.Errorf("updating application releaseRef: %w", err)
		}
		return nil
	}); err != nil {
		_ = s.Delete(ctx, release)
		return nil, nil, fmt.Errorf("update application releaseRef: %w", err)
	}

	return app, release, nil
}

func (s *PaprikaServer) createOrUpdateApplication(
	ctx context.Context,
	appName, namespace, snapshotName, project string,
) (*pipelinesv1alpha1.Application, error) {
	app := s.buildApplication(appName, namespace, snapshotName, project)
	var existing pipelinesv1alpha1.Application
	if err := s.Get(ctx, client.ObjectKey{Namespace: namespace, Name: appName}, &existing); err != nil {
		if !apierrors.IsNotFound(err) {
			return nil, fmt.Errorf("get application: %w", err)
		}
		if err := s.Create(ctx, app); err != nil {
			return nil, fmt.Errorf("create application: %w", err)
		}
		return app, nil
	}
	existing.Spec = app.Spec
	if existing.Labels == nil {
		existing.Labels = map[string]string{}
	}
	for k, v := range app.Labels {
		existing.Labels[k] = v
	}
	if err := s.Update(ctx, &existing); err != nil {
		return nil, fmt.Errorf("update application: %w", err)
	}
	return &existing, nil
}

//nolint:nestif // label update path is straightforward.
func (s *PaprikaServer) ensureStage(
	ctx context.Context,
	appName, namespace, project, releaseName, stageName string,
) error {
	labels := s.baseLabels(appName, releaseName, project)
	stage := &pipelinesv1alpha1.Stage{
		ObjectMeta: metav1.ObjectMeta{
			Name:      stageName,
			Namespace: namespace,
			Labels:    labels,
		},
		Spec: pipelinesv1alpha1.StageSpec{
			Name:      "default",
			Ring:      1,
			Templates: []string{},
		},
	}
	if err := s.Create(ctx, stage); err != nil {
		if !apierrors.IsAlreadyExists(err) {
			return fmt.Errorf("create stage: %w", err)
		}
		var existing pipelinesv1alpha1.Stage
		if getErr := s.Get(ctx, client.ObjectKey{Namespace: namespace, Name: stageName}, &existing); getErr != nil {
			return fmt.Errorf("get existing stage: %w", getErr)
		}
		if existing.Labels == nil {
			existing.Labels = map[string]string{}
		}
		changed := false
		for k, v := range labels {
			if existing.Labels[k] != v {
				existing.Labels[k] = v
				changed = true
			}
		}
		if changed {
			if updateErr := s.Update(ctx, &existing); updateErr != nil {
				return fmt.Errorf("update stage labels: %w", updateErr)
			}
		}
	}
	return nil
}

func (s *PaprikaServer) createSnapshot(
	ctx context.Context,
	release *pipelinesv1alpha1.Release,
	appName, namespace, project, snapshotName, releaseName string,
	bundle []byte,
) error {
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      snapshotName,
			Namespace: namespace,
			Labels:    s.baseLabels(appName, releaseName, project),
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: pipelinesv1alpha1.GroupVersion.String(),
				Kind:       "Release",
				Name:       release.Name,
				UID:        release.UID,
				Controller: ptr(true),
			}},
		},
		Data: map[string]string{
			"manifests.yaml": string(bundle),
		},
	}
	if err := s.Create(ctx, cm); err != nil {
		return fmt.Errorf("create manifest snapshot: %w", err)
	}
	return nil
}

func (s *PaprikaServer) buildApplication(appName, namespace, snapshotName, project string) *pipelinesv1alpha1.Application {
	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{
			Name:      appName,
			Namespace: namespace,
			Labels: map[string]string{
				managedByLabel:  "paprika",
				projectLabelKey: project,
			},
		},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Project: project,
			Source: pipelinesv1alpha1.ApplicationSource{
				Type: pipelinesv1alpha1.SourceTypeInline,
				Inline: &pipelinesv1alpha1.InlineSourceSpec{
					ConfigMapRef: snapshotName,
				},
			},
			Stages: []pipelinesv1alpha1.ApplicationPromotionStage{
				{
					Name: "default",
					Ring: 1,
				},
			},
			Strategy:   pipelinesv1alpha1.StrategyRolling,
			SyncPolicy: pipelinesv1alpha1.SyncAuto,
		},
	}
	if snapshotName != "" {
		app.Spec.Source.Inline.ConfigMapRef = snapshotName
	}
	return app
}

func (s *PaprikaServer) buildRelease(
	appName, namespace, snapshotName, project string,
	bundle []byte,
	policyResults []policy.Result,
) *pipelinesv1alpha1.Release {
	releaseName := generateReleaseName(appName, bundle)
	return &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{
			Name:      releaseName,
			Namespace: namespace,
			Labels:    s.baseLabels(appName, releaseName, project),
			Annotations: map[string]string{
				"paprika.io/bundle-sha": fullBundleSHA(bundle),
			},
		},
		Spec: pipelinesv1alpha1.ReleaseSpec{
			Pipeline: "",
			Target:   appName + "-default",
			ManifestSource: &pipelinesv1alpha1.ManifestSource{
				ConfigMapRef: snapshotName,
			},
		},
		Status: pipelinesv1alpha1.ReleaseStatus{
			PolicyResults: toReleasePolicyResults(policyResults),
		},
	}
}

func (s *PaprikaServer) baseLabels(appName, releaseName, project string) map[string]string {
	return map[string]string{
		managedByLabel:  "paprika",
		nameLabel:       appName,
		releaseLabel:    releaseName,
		historyLabel:    "true",
		projectLabelKey: project,
	}
}

func generateReleaseName(appName string, bundle []byte) string {
	hash := sha256.Sum256(bundle)
	short := hex.EncodeToString(hash[:4])
	return fmt.Sprintf("%s-release-%s-%d", appName, short, time.Now().Unix())
}

func fullBundleSHA(bundle []byte) string {
	return hex.EncodeToString(bundleSHA(bundle))
}

func bundleSHA(bundle []byte) []byte {
	hash := sha256.Sum256(bundle)
	return hash[:]
}

func toReleasePolicyResults(results []policy.Result) []pipelinesv1alpha1.ReleasePolicyResult {
	out := make([]pipelinesv1alpha1.ReleasePolicyResult, 0, len(results))
	for _, r := range results {
		out = append(out, pipelinesv1alpha1.ReleasePolicyResult{
			Name:     r.Name,
			Severity: r.Severity,
			Action:   r.Action,
			Passed:   r.Passed,
			Message:  r.Message,
		})
	}
	return out
}

func convertPolicyResults(results []policy.Result) []*paprikav1.PolicyResult {
	out := make([]*paprikav1.PolicyResult, 0, len(results))
	for _, r := range results {
		out = append(out, &paprikav1.PolicyResult{
			Name:     r.Name,
			Severity: r.Severity,
			Action:   r.Action,
			Passed:   r.Passed,
			Message:  r.Message,
		})
	}
	return out
}

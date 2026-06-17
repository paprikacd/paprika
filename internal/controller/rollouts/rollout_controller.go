/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controller

import (
	"context"
	"errors"
	"fmt"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/tools/record"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	"github.com/benebsworth/paprika/analysis"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/rollout"
	"github.com/benebsworth/paprika/internal/rollout/core"
	"github.com/benebsworth/paprika/traffic"
)

const (
	rolloutFinalizer       = "rollouts.paprika.io/finalizer"
	promoteAnnotation      = "paprika.io/promote"
	abortAnnotation        = "paprika.io/abort"
	progressingCondition   = "RolloutProgressing"
	defaultServicePortName = "http"
)

// RolloutReconciler reconciles Rollout resources.
type RolloutReconciler struct {
	client.Client
	Scheme        *runtime.Scheme
	DynamicClient dynamic.Interface
	Analyzer      analysis.Analyzer
	EventRecorder record.EventRecorder
}

// +kubebuilder:rbac:groups=rollouts.paprika.io,resources=rollouts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=rollouts.paprika.io,resources=rollouts/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=rollouts.paprika.io,resources=rollouts/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=replicasets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=core,resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch
// +kubebuilder:rbac:groups=networking.istio.io,resources=virtualservices,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=httproutes,verbs=get;list;watch;update;patch

// Reconcile handles Rollout reconciliation.
func (r *RolloutReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var ro rolloutsv1alpha1.Rollout
	if err := r.Get(ctx, req.NamespacedName, &ro); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	if !controllerutil.ContainsFinalizer(&ro, rolloutFinalizer) {
		controllerutil.AddFinalizer(&ro, rolloutFinalizer)
		if err := r.Update(ctx, &ro); err != nil {
			return ctrl.Result{}, fmt.Errorf("adding rollout finalizer: %w", err)
		}
		return ctrl.Result{Requeue: true}, nil
	}

	if !ro.DeletionTimestamp.IsZero() {
		return r.handleDeletion(ctx, &ro)
	}

	if ro.Spec.Paused {
		ro.Status.Phase = rolloutsv1alpha1.RolloutPhasePaused
		if err := r.patchStatus(ctx, &ro); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}

	if err := r.applyDefaults(&ro); err != nil {
		return ctrl.Result{}, fmt.Errorf("applying defaults: %w", err)
	}

	if err := r.resolveTarget(ctx, &ro); err != nil {
		ro.Status.Phase = rolloutsv1alpha1.RolloutPhaseFailed
		ro.Status.Message = err.Error()
		_ = r.patchStatus(ctx, &ro)
		return ctrl.Result{}, fmt.Errorf("resolving target: %w", err)
	}

	strategy, err := rollout.NewStrategy(&ro.Spec.Strategy)
	if err != nil {
		ro.Status.Phase = rolloutsv1alpha1.RolloutPhaseFailed
		ro.Status.Message = err.Error()
		_ = r.patchStatus(ctx, &ro)
		return ctrl.Result{}, fmt.Errorf("creating strategy: %w", err)
	}

	result, err := strategy.Sync(ctx, &ro, &ro.Status)
	if err != nil {
		ro.Status.Phase = rolloutsv1alpha1.RolloutPhaseFailed
		ro.Status.Message = err.Error()
		_ = r.patchStatus(ctx, &ro)
		return ctrl.Result{}, fmt.Errorf("strategy sync: %w", err)
	}

	if err := r.executeReplicaSetActions(ctx, &ro, result.ReplicaSets); err != nil {
		ro.Status.Phase = rolloutsv1alpha1.RolloutPhaseFailed
		ro.Status.Message = err.Error()
		_ = r.patchStatus(ctx, &ro)
		return ctrl.Result{}, fmt.Errorf("executing replica set actions: %w", err)
	}

	if err := r.ensureServices(ctx, &ro, result); err != nil {
		ro.Status.Phase = rolloutsv1alpha1.RolloutPhaseFailed
		ro.Status.Message = err.Error()
		_ = r.patchStatus(ctx, &ro)
		return ctrl.Result{}, fmt.Errorf("ensuring services: %w", err)
	}

	if err := r.configureTraffic(ctx, &ro, result); err != nil {
		log.Error(err, "Failed to configure traffic")
		setCondition(&ro, progressingCondition, metav1.ConditionFalse, "TrafficConfigFailed", err.Error())
	} else {
		removeCondition(&ro, progressingCondition)
	}

	if err := r.runAnalysis(ctx, &ro, result); err != nil {
		log.Error(err, "Analysis failed")
	}

	r.updateStatusFromResult(&ro, result)

	if err := r.patchStatus(ctx, &ro); err != nil {
		return ctrl.Result{}, fmt.Errorf("patching rollout status: %w", err)
	}

	if result.Action == core.ActionPause {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	}
	if result.Action == core.ActionStep {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	}
	return ctrl.Result{Requeue: true}, nil
}

func (r *RolloutReconciler) handleDeletion(ctx context.Context, ro *rolloutsv1alpha1.Rollout) (ctrl.Result, error) {
	if !controllerutil.ContainsFinalizer(ro, rolloutFinalizer) {
		return ctrl.Result{}, nil
	}
	if r.DynamicClient != nil && ro.Spec.TrafficRouter != nil {
		if router, err := r.buildRouter(ro); err == nil && router != nil {
			_ = router.RemoveCanary(ctx)
		}
	}
	controllerutil.RemoveFinalizer(ro, rolloutFinalizer)
	if err := r.Update(ctx, ro); err != nil {
		return ctrl.Result{}, fmt.Errorf("removing rollout finalizer: %w", err)
	}
	return ctrl.Result{}, nil
}

func (r *RolloutReconciler) applyDefaults(ro *rolloutsv1alpha1.Rollout) error {
	if ro.Spec.Replicas == nil {
		ro.Spec.Replicas = ptr.To(int32(1))
	}
	if ro.Spec.RevisionHistoryLimit == nil {
		ro.Spec.RevisionHistoryLimit = ptr.To(int32(10))
	}

	setServiceDefaults(&ro.Spec.Strategy, ro.Name)

	if ro.Spec.Target.Kind == "" {
		ro.Spec.Target.Kind = "Deployment"
	}
	return nil
}

func setServiceDefaults(s *rolloutsv1alpha1.RolloutStrategy, name string) {
	switch s.Type {
	case "Canary":
		if s.Canary != nil {
			if s.Canary.StableService == "" {
				s.Canary.StableService = name + "-stable"
			}
			if s.Canary.CanaryService == "" {
				s.Canary.CanaryService = name + "-canary"
			}
		}
	case "BlueGreen":
		if s.BlueGreen != nil {
			if s.BlueGreen.ActiveService == "" {
				s.BlueGreen.ActiveService = name + "-active"
			}
			if s.BlueGreen.PreviewService == "" {
				s.BlueGreen.PreviewService = name + "-preview"
			}
		}
	case "ABTest":
		if s.ABTest != nil {
			if s.ABTest.StableService == "" {
				s.ABTest.StableService = name + "-stable"
			}
			if s.ABTest.CanaryService == "" {
				s.ABTest.CanaryService = name + "-canary"
			}
		}
	case "Mirror":
		if s.Mirror != nil {
			if s.Mirror.StableService == "" {
				s.Mirror.StableService = name + "-stable"
			}
			if s.Mirror.CanaryService == "" {
				s.Mirror.CanaryService = name + "-canary"
			}
		}
	}
}

func (r *RolloutReconciler) resolveTarget(ctx context.Context, ro *rolloutsv1alpha1.Rollout) error {
	if ro.Spec.Target.Kind != "Deployment" || ro.Spec.Target.Name == "" {
		return nil
	}
	var deploy appsv1.Deployment
	if err := r.Get(ctx, client.ObjectKey{Namespace: ro.Namespace, Name: ro.Spec.Target.Name}, &deploy); err != nil {
		if apierrors.IsNotFound(err) {
			return nil
		}
		return fmt.Errorf("getting target deployment: %w", err)
	}
	if ro.Spec.Template.ObjectMeta.Labels == nil && len(deploy.Spec.Template.ObjectMeta.Labels) > 0 {
		ro.Spec.Template = deploy.Spec.Template
	}
	return nil
}

func (r *RolloutReconciler) executeReplicaSetActions(ctx context.Context, ro *rolloutsv1alpha1.Rollout, actions []core.ReplicaSetAction) error {
	log := logf.FromContext(ctx)

	for _, action := range actions {
		var rs appsv1.ReplicaSet
		err := r.Get(ctx, client.ObjectKey{Namespace: ro.Namespace, Name: action.Name}, &rs)
		if err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("getting ReplicaSet %s: %w", action.Name, err)
		}

		labels := action.Labels
		if labels == nil {
			labels = map[string]string{}
		}
		if action.Template.ObjectMeta.Labels == nil {
			action.Template.ObjectMeta.Labels = map[string]string{}
		}
		for k, v := range labels {
			action.Template.ObjectMeta.Labels[k] = v
		}

		desired := &appsv1.ReplicaSet{
			ObjectMeta: metav1.ObjectMeta{
				Name:      action.Name,
				Namespace: ro.Namespace,
				Labels:    labels,
				OwnerReferences: []metav1.OwnerReference{{
					APIVersion: rolloutsv1alpha1.GroupVersion.String(),
					Kind:       "Rollout",
					Name:       ro.Name,
					UID:        ro.UID,
					Controller: ptr.To(true),
				}},
			},
			Spec: appsv1.ReplicaSetSpec{
				Replicas: &action.Replicas,
				Selector: &metav1.LabelSelector{MatchLabels: labels},
				Template: *action.Template,
			},
		}

		if err != nil && apierrors.IsNotFound(err) {
			if err := r.Create(ctx, desired); err != nil {
				return fmt.Errorf("creating ReplicaSet %s: %w", action.Name, err)
			}
			log.Info("Created ReplicaSet", "name", desired.Name)
			continue
		}

		rs.Spec.Replicas = desired.Spec.Replicas
		rs.Spec.Template = desired.Spec.Template
		rs.Labels = desired.Labels
		if err := r.Update(ctx, &rs); err != nil {
			return fmt.Errorf("updating ReplicaSet %s: %w", action.Name, err)
		}
		log.Info("Updated ReplicaSet", "name", rs.Name, "replicas", action.Replicas)
	}
	return nil
}

func (r *RolloutReconciler) ensureServices(ctx context.Context, ro *rolloutsv1alpha1.Rollout, result *core.SyncResult) error {
	services := r.serviceNames(ro)
	for svcName, selector := range services {
		if svcName == "" {
			continue
		}
		if err := r.ensureService(ctx, ro, svcName, selector); err != nil {
			return err
		}
	}

	r.updateServiceStatus(ro)
	return nil
}

func (r *RolloutReconciler) serviceNames(ro *rolloutsv1alpha1.Rollout) map[string]string {
	switch ro.Spec.Strategy.Type {
	case "BlueGreen":
		bg := ro.Spec.Strategy.BlueGreen
		if bg == nil {
			return nil
		}
		return map[string]string{
			bg.ActiveService:  "active",
			bg.PreviewService: "preview",
		}
	case "Canary", "ABTest", "Mirror":
		var stableSvc, canarySvc string
		switch ro.Spec.Strategy.Type {
		case "Canary":
			if ro.Spec.Strategy.Canary != nil {
				stableSvc = ro.Spec.Strategy.Canary.StableService
				canarySvc = ro.Spec.Strategy.Canary.CanaryService
			}
		case "ABTest":
			if ro.Spec.Strategy.ABTest != nil {
				stableSvc = ro.Spec.Strategy.ABTest.StableService
				canarySvc = ro.Spec.Strategy.ABTest.CanaryService
			}
		case "Mirror":
			if ro.Spec.Strategy.Mirror != nil {
				stableSvc = ro.Spec.Strategy.Mirror.StableService
				canarySvc = ro.Spec.Strategy.Mirror.CanaryService
			}
		}
		return map[string]string{
			stableSvc: "stable",
			canarySvc: "canary",
		}
	}
	return nil
}

func (r *RolloutReconciler) ensureService(ctx context.Context, ro *rolloutsv1alpha1.Rollout, name, role string) error {
	var svc corev1.Service
	err := r.Get(ctx, client.ObjectKey{Namespace: ro.Namespace, Name: name}, &svc)
	if err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("getting service %s: %w", name, err)
	}

	selector := map[string]string{
		"rollouts.paprika.io/rollout": ro.Name,
		"rollouts.paprika.io/" + role: "true",
	}
	desired := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: ro.Namespace,
			Labels: map[string]string{
				"rollouts.paprika.io/rollout": ro.Name,
				"rollouts.paprika.io/role":    role,
			},
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: rolloutsv1alpha1.GroupVersion.String(),
				Kind:       "Rollout",
				Name:       ro.Name,
				UID:        ro.UID,
				Controller: ptr.To(true),
			}},
		},
		Spec: corev1.ServiceSpec{
			Selector: selector,
			Ports: []corev1.ServicePort{{
				Name:       defaultServicePortName,
				Port:       80,
				TargetPort: intstrFromInt(8080),
			}},
		},
	}

	if err != nil && apierrors.IsNotFound(err) {
		return r.Create(ctx, desired)
	}
	svc.Spec.Selector = selector
	svc.Spec.Ports = desired.Spec.Ports
	svc.OwnerReferences = desired.OwnerReferences
	return r.Update(ctx, &svc)
}

func intstrFromInt(i int32) intstr.IntOrString {
	// This helper is only used for the service target port.
	return intstr.IntOrString{Type: intstr.Int, IntVal: i}
}

func (r *RolloutReconciler) updateServiceStatus(ro *rolloutsv1alpha1.Rollout) {
	if ro.Spec.Strategy.Type == "BlueGreen" {
		if bg := ro.Spec.Strategy.BlueGreen; bg != nil {
			ro.Status.ActiveService = bg.ActiveService
			ro.Status.PreviewService = bg.PreviewService
		}
	}
}

func (r *RolloutReconciler) configureTraffic(ctx context.Context, ro *rolloutsv1alpha1.Rollout, result *core.SyncResult) error {
	if ro.Spec.TrafficRouter == nil {
		return nil
	}
	router, err := r.buildRouter(ro)
	if err != nil {
		return err
	}
	if router == nil {
		return nil
	}

	switch ro.Spec.Strategy.Type {
	case "Canary":
		return r.configureCanaryTraffic(ctx, ro, result, router)
	case "BlueGreen":
		return r.configureBlueGreenTraffic(ctx, ro, result, router)
	case "ABTest":
		return r.configureABTestTraffic(ctx, ro, result, router)
	case "Mirror":
		return r.configureMirrorTraffic(ctx, ro, result, router)
	}
	return nil
}

func (r *RolloutReconciler) configureCanaryTraffic(ctx context.Context, ro *rolloutsv1alpha1.Rollout, result *core.SyncResult, router traffic.Router) error {
	switch result.Action {
	case core.ActionPromote, core.ActionComplete:
		return router.RemoveCanary(ctx)
	case core.ActionStep:
		return router.SetWeight(ctx, ro.Status.CurrentStepWeight)
	}
	return nil
}

func (r *RolloutReconciler) configureBlueGreenTraffic(ctx context.Context, _ *rolloutsv1alpha1.Rollout, result *core.SyncResult, router traffic.Router) error {
	if result.Action == core.ActionPromote || result.Action == core.ActionComplete {
		return router.SetWeight(ctx, 100)
	}
	return nil
}

func (r *RolloutReconciler) configureABTestTraffic(ctx context.Context, ro *rolloutsv1alpha1.Rollout, result *core.SyncResult, router traffic.Router) error {
	if router.Type() == "gateway-api" {
		setCondition(ro, progressingCondition, metav1.ConditionFalse, "HeaderRoutingNotSupported", "Gateway API does not support header routing")
		return nil
	}
	if result.Action == core.ActionPromote || result.Action == core.ActionComplete {
		for _, route := range ro.Spec.Strategy.ABTest.Routes {
			_ = router.RemoveHeaderRoute(ctx, route.Name)
		}
		return nil
	}
	for _, route := range ro.Spec.Strategy.ABTest.Routes {
		svc := ro.Spec.Strategy.ABTest.StableService
		if route.Service == "canary" {
			svc = ro.Spec.Strategy.ABTest.CanaryService
		}
		if err := router.SetHeaderRoute(ctx, route.Name, route.Value, svc); err != nil {
			return err
		}
	}
	return nil
}

func (r *RolloutReconciler) configureMirrorTraffic(ctx context.Context, ro *rolloutsv1alpha1.Rollout, result *core.SyncResult, router traffic.Router) error {
	if router.Type() == "gateway-api" {
		setCondition(ro, progressingCondition, metav1.ConditionFalse, "HeaderRoutingNotSupported", "Gateway API does not support traffic mirroring")
		return nil
	}
	if result.Action == core.ActionPromote || result.Action == core.ActionComplete || result.Action == core.ActionStep {
		return router.RemoveMirror(ctx)
	}
	return router.SetMirror(ctx, ro.Spec.Strategy.Mirror.MirrorPercent)
}

func (r *RolloutReconciler) buildRouter(ro *rolloutsv1alpha1.Rollout) (traffic.Router, error) {
	if r.DynamicClient == nil {
		return nil, nil
	}
	stableSvc, canarySvc := r.routerServiceNames(ro)
	cfg := r.convertTrafficRouter(ro.Spec.TrafficRouter)
	return traffic.NewRouter(cfg, r.DynamicClient, stableSvc, canarySvc, ro.Namespace)
}

func (r *RolloutReconciler) routerServiceNames(ro *rolloutsv1alpha1.Rollout) (string, string) {
	switch ro.Spec.Strategy.Type {
	case "Canary":
		if ro.Spec.Strategy.Canary != nil {
			return ro.Spec.Strategy.Canary.StableService, ro.Spec.Strategy.Canary.CanaryService
		}
	case "ABTest":
		if ro.Spec.Strategy.ABTest != nil {
			return ro.Spec.Strategy.ABTest.StableService, ro.Spec.Strategy.ABTest.CanaryService
		}
	case "Mirror":
		if ro.Spec.Strategy.Mirror != nil {
			return ro.Spec.Strategy.Mirror.StableService, ro.Spec.Strategy.Mirror.CanaryService
		}
	case "BlueGreen":
		if ro.Spec.Strategy.BlueGreen != nil {
			return ro.Spec.Strategy.BlueGreen.ActiveService, ro.Spec.Strategy.BlueGreen.PreviewService
		}
	}
	return ro.Name + "-stable", ro.Name + "-canary"
}

func (r *RolloutReconciler) convertTrafficRouter(rt *rolloutsv1alpha1.TrafficRouter) *pipelinesv1alpha1.TrafficRouter {
	if rt == nil {
		return nil
	}
	out := &pipelinesv1alpha1.TrafficRouter{
		Provider: rt.Provider,
	}
	if rt.Istio != nil {
		out.Istio = &pipelinesv1alpha1.IstioRouterConfig{
			VirtualService: rt.Istio.VirtualService,
			Routes:         rt.Istio.Routes,
			Hosts:          rt.Istio.Hosts,
			StableService:  rt.Istio.StableService,
			CanaryService:  rt.Istio.CanaryService,
		}
	}
	if rt.GatewayAPI != nil {
		out.GatewayAPI = &pipelinesv1alpha1.GatewayAPIRouterConfig{
			HTTPRoute:     rt.GatewayAPI.HTTPRoute,
			StableService: rt.GatewayAPI.StableService,
			CanaryService: rt.GatewayAPI.CanaryService,
		}
	}
	return out
}

func (r *RolloutReconciler) runAnalysis(ctx context.Context, ro *rolloutsv1alpha1.Rollout, result *core.SyncResult) error {
	if r.Analyzer == nil {
		return nil
	}
	analysis := r.analysisForResult(ro, result)
	if analysis == nil || len(analysis.Checks) == 0 {
		return nil
	}
	results := r.Analyzer.RunChecks(ctx, convertAnalysisChecks(analysis.Checks))
	for _, res := range results {
		if !res.Passed {
			setCondition(ro, progressingCondition, metav1.ConditionFalse, "AnalysisFailed", res.Message)
			return errors.New(res.Message)
		}
	}
	return nil
}

func (r *RolloutReconciler) analysisForResult(ro *rolloutsv1alpha1.Rollout, result *core.SyncResult) *rolloutsv1alpha1.RolloutAnalysis {
	var analysis *rolloutsv1alpha1.RolloutAnalysis
	switch ro.Spec.Strategy.Type {
	case "Canary":
		if ro.Spec.Strategy.Canary != nil {
			analysis = ro.Spec.Strategy.Canary.Analysis
		}
		if result.Action == core.ActionStep {
			idx := int(ro.Status.CurrentStepIndex)
			if ro.Spec.Strategy.Canary != nil && idx < len(ro.Spec.Strategy.Canary.Steps) && ro.Spec.Strategy.Canary.Steps[idx].Analysis != nil {
				analysis = ro.Spec.Strategy.Canary.Steps[idx].Analysis
			}
		}
	case "BlueGreen":
		if ro.Spec.Strategy.BlueGreen != nil {
			analysis = ro.Spec.Strategy.BlueGreen.Analysis
		}
	case "ABTest":
		if ro.Spec.Strategy.ABTest != nil {
			analysis = ro.Spec.Strategy.ABTest.Analysis
		}
	case "Mirror":
		if ro.Spec.Strategy.Mirror != nil {
			analysis = ro.Spec.Strategy.Mirror.Analysis
		}
	}
	return analysis
}

func (r *RolloutReconciler) updateStatusFromResult(ro *rolloutsv1alpha1.Rollout, result *core.SyncResult) {
	ro.Status.Phase = result.Phase
	ro.Status.Message = result.Message
	ro.Status.ObservedGeneration = ro.Generation

	for _, rs := range result.ReplicaSets {
		if rs.Labels["rollouts.paprika.io/stable"] == "true" || rs.Labels["rollouts.paprika.io/active"] == "true" {
			ro.Status.StableRS = rs.Name
		}
		if rs.Labels["rollouts.paprika.io/canary"] == "true" || rs.Labels["rollouts.paprika.io/preview"] == "true" {
			ro.Status.CanaryRS = rs.Name
		}
	}

	if ro.Spec.Strategy.Type == "Canary" && ro.Spec.Strategy.Canary != nil {
		idx := int(ro.Status.CurrentStepIndex)
		if idx < len(ro.Spec.Strategy.Canary.Steps) {
			ro.Status.CurrentStepWeight = ro.Spec.Strategy.Canary.Steps[idx].SetWeight
		}
	}
}

func (r *RolloutReconciler) patchStatus(ctx context.Context, ro *rolloutsv1alpha1.Rollout) error {
	return r.Status().Update(ctx, ro)
}

// SetupWithManager sets up the controller with the Manager.
func (r *RolloutReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&rolloutsv1alpha1.Rollout{}).
		Owns(&appsv1.ReplicaSet{}).
		Owns(&corev1.Service{}).
		Complete(r)
}

func setCondition(ro *rolloutsv1alpha1.Rollout, typ string, status metav1.ConditionStatus, reason, message string) {
	meta.SetStatusCondition(&ro.Status.Conditions, metav1.Condition{
		Type:               typ,
		Status:             status,
		Reason:             reason,
		Message:            message,
		LastTransitionTime: metav1.Now(),
	})
}

func removeCondition(ro *rolloutsv1alpha1.Rollout, typ string) {
	for i, c := range ro.Status.Conditions {
		if c.Type == typ {
			ro.Status.Conditions = append(ro.Status.Conditions[:i], ro.Status.Conditions[i+1:]...)
			return
		}
	}
}

func convertAnalysisChecks(checks []rolloutsv1alpha1.AnalysisCheck) []pipelinesv1alpha1.AnalysisCheck {
	out := make([]pipelinesv1alpha1.AnalysisCheck, len(checks))
	for i, c := range checks {
		out[i] = pipelinesv1alpha1.AnalysisCheck{
			Type:             c.Type,
			URL:              c.URL,
			HTTPHeaders:      c.HTTPHeaders,
			SuccessThreshold: c.SuccessThreshold,
			TimeoutSeconds:   c.TimeoutSeconds,
			RequestCount:     c.RequestCount,
			Metric:           c.Metric,
			Threshold:        c.Threshold,
			WindowSeconds:    c.WindowSeconds,
		}
	}
	return out
}

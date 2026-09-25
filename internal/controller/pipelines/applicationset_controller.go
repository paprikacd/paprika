package pipelines

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"text/template"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/log"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/clock"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/metrics"
	"github.com/benebsworth/paprika/internal/observability"
	"github.com/benebsworth/paprika/internal/sharding"
)

const applicationSetLabelKey = "applicationset.paprika.io/name"

// ApplicationSetReconciler reconciles ApplicationSet resources.
type ApplicationSetReconciler struct {
	client      client.Client
	Scheme      *runtime.Scheme
	ShardFilter *sharding.Filter
	Clock       clock.Clock
}

// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applicationsets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applicationsets/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applicationsets/finalizers,verbs=update
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=clusters.paprika.io,resources=clusters,verbs=get;list;watch

// Reconcile handles ApplicationSet reconciliation.
//
//nolint:cyclop // create/update/delete flow is inherent to the reconcile loop.
func (r *ApplicationSetReconciler) Reconcile(ctx context.Context, req ctrl.Request) (_ ctrl.Result, spanErr error) {
	ctx, endSpan := observability.ReconcileSpan(ctx, "ApplicationSet", req)
	defer func() { endSpan(spanErr) }()

	result := resultSuccess
	start := metrics.Timer(r.Clock)
	defer func() {
		metrics.ReconcileTotal.WithLabelValues("applicationset", result).Inc()
		metrics.ReconcileDuration.WithLabelValues("applicationset").Observe(metrics.Since(r.Clock, start))
	}()

	log := log.FromContext(ctx)

	var appSet pipelinesv1alpha1.ApplicationSet
	if err := r.client.Get(ctx, req.NamespacedName, &appSet); err != nil {
		result = resultError
		if k8sErr := client.IgnoreNotFound(err); k8sErr != nil {
			return ctrl.Result{}, fmt.Errorf("getting applicationset: %w", k8sErr)
		}
		return ctrl.Result{}, nil
	}

	if r.ShardFilter != nil && !r.ShardFilter.Matches(req.Namespace) {
		log.Info("Skipping applicationset not in shard", "namespace", req.Namespace, "shard", r.ShardFilter.ShardID())
		return ctrl.Result{}, nil
	}

	params, err := r.generateParams(ctx, &appSet)
	if err != nil {
		result = resultError
		r.patchStatus(ctx, &appSet, 0, false, "GenerationFailed", err.Error())
		return ctrl.Result{}, fmt.Errorf("generating parameters: %w", err)
	}

	desired, err := r.buildDesiredApplications(&appSet, params)
	if err != nil {
		result = resultError
		r.patchStatus(ctx, &appSet, 0, false, "RenderFailed", err.Error())
		return ctrl.Result{}, fmt.Errorf("rendering applications: %w", err)
	}

	existing, err := r.listOwnedApplications(ctx, &appSet)
	if err != nil {
		result = resultError
		return ctrl.Result{}, fmt.Errorf("listing owned applications: %w", err)
	}

	existingByName := make(map[string]pipelinesv1alpha1.Application, len(existing))
	for i := range existing {
		existingByName[existing[i].Name] = existing[i]
	}

	gated, err := r.applyApplicationUpdates(ctx, &appSet, desired, existingByName)
	if err != nil {
		result = resultError
		r.patchStatus(ctx, &appSet, len(desired), false, "UpdateFailed", err.Error())
		return ctrl.Result{}, err
	}
	if gated {
		// A rolling-sync step is waiting on prior-step apps to become
		// Healthy — poll again shortly rather than the steady 30s.
		r.patchStatus(ctx, &appSet, len(desired), true, "RollingSyncGated",
			"rolling sync waiting for earlier-step applications to become Healthy")
		return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
	}

	for name := range existingByName {
		existingApp := existingByName[name]
		if _, ok := desired[name]; ok {
			continue
		}
		if deleteErr := r.client.Delete(ctx, &existingApp); deleteErr != nil {
			result = resultError
			r.patchStatus(ctx, &appSet, len(desired), false, "DeleteFailed", deleteErr.Error())
			return ctrl.Result{}, fmt.Errorf("deleting application %s: %w", name, deleteErr)
		}
	}

	r.patchStatus(ctx, &appSet, len(desired), true, "ApplicationsGenerated",
		fmt.Sprintf("Generated %d applications", len(desired)))

	return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
}

func (r *ApplicationSetReconciler) generateParams(ctx context.Context, appSet *pipelinesv1alpha1.ApplicationSet) ([]map[string]string, error) {
	var all []map[string]string
	for _, g := range appSet.Spec.Generators {
		params, err := r.generateForGenerator(ctx, appSet.Namespace, g)
		if err != nil {
			return nil, err
		}
		all = append(all, params...)
	}
	return all, nil
}

func (r *ApplicationSetReconciler) generateForGenerator(ctx context.Context, ns string, g pipelinesv1alpha1.ApplicationSetGenerator) ([]map[string]string, error) {
	switch {
	case g.List != nil:
		return r.generateList(g.List)
	case g.GitDirectories != nil:
		return r.generateGitDirectories(g.GitDirectories)
	case g.Clusters != nil:
		return r.generateClusters(ctx, ns, g.Clusters)
	case g.Matrix != nil:
		return r.generateMatrix(ctx, ns, g.Matrix)
	default:
		return nil, errors.New("empty generator")
	}
}

func (r *ApplicationSetReconciler) generateNestedGenerator(ctx context.Context, ns string, g pipelinesv1alpha1.NestedApplicationSetGenerator) ([]map[string]string, error) {
	switch {
	case g.List != nil:
		return r.generateList(g.List)
	case g.GitDirectories != nil:
		return r.generateGitDirectories(g.GitDirectories)
	case g.Clusters != nil:
		return r.generateClusters(ctx, ns, g.Clusters)
	default:
		return nil, errors.New("empty nested generator")
	}
}

func (r *ApplicationSetReconciler) generateList(g *pipelinesv1alpha1.ListGenerator) ([]map[string]string, error) {
	out := make([]map[string]string, 0, len(g.Items))
	for _, item := range g.Items {
		itemCopy := make(map[string]string, len(item))
		for k, v := range item {
			itemCopy[k] = v
		}
		out = append(out, itemCopy)
	}
	return out, nil
}

func (r *ApplicationSetReconciler) generateGitDirectories(g *pipelinesv1alpha1.GitDirectoriesGenerator) ([]map[string]string, error) {
	base := g.RepoURL
	if g.Path != "" {
		base = filepath.Join(base, g.Path)
	}

	entries, err := os.ReadDir(base)
	if err != nil {
		return nil, fmt.Errorf("reading directories %s: %w", base, err)
	}

	out := make([]map[string]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}

		rel := entry.Name()
		if g.Path != "" {
			rel = filepath.Join(g.Path, entry.Name())
		}
		out = append(out, map[string]string{
			"path":     rel,
			"basename": entry.Name(),
		})
	}
	return out, nil
}

func (r *ApplicationSetReconciler) generateClusters(ctx context.Context, ns string, g *pipelinesv1alpha1.ClustersGenerator) ([]map[string]string, error) {
	if len(g.Names) > 0 {
		out := make([]map[string]string, 0, len(g.Names))
		for _, name := range g.Names {
			out = append(out, map[string]string{"name": name})
		}
		return out, nil
	}

	if g.Selector != nil {
		var list clustersv1alpha1.ClusterList
		if err := r.client.List(ctx, &list, client.InNamespace(ns)); err != nil {
			return nil, fmt.Errorf("listing clusters: %w", err)
		}

		sel, err := metav1.LabelSelectorAsSelector(g.Selector)
		if err != nil {
			return nil, fmt.Errorf("parsing selector: %w", err)
		}

		out := make([]map[string]string, 0, len(list.Items))
		for i := range list.Items {
			cluster := &list.Items[i]
			if sel.Matches(labels.Set(cluster.GetLabels())) || sel.Matches(labels.Set(cluster.Spec.Labels)) {
				out = append(out, map[string]string{"name": cluster.Name})
			}
		}
		return out, nil
	}

	return nil, errors.New("clusters generator requires names or selector")
}

func (r *ApplicationSetReconciler) generateMatrix(ctx context.Context, ns string, g *pipelinesv1alpha1.MatrixGenerator) ([]map[string]string, error) {
	left, err := r.generateNestedGenerator(ctx, ns, g.First)
	if err != nil {
		return nil, err
	}
	right, err := r.generateNestedGenerator(ctx, ns, g.Second)
	if err != nil {
		return nil, err
	}

	out := make([]map[string]string, 0, len(left)*len(right))
	for _, l := range left {
		for _, rr := range right {
			merged := make(map[string]string, len(l)+len(rr))
			for k, v := range l {
				merged[k] = v
			}
			for k, v := range rr {
				merged[k] = v
			}
			out = append(out, merged)
		}
	}
	return out, nil
}

func (r *ApplicationSetReconciler) buildDesiredApplications(
	appSet *pipelinesv1alpha1.ApplicationSet,
	params []map[string]string,
) (map[string]pipelinesv1alpha1.Application, error) {
	desired := make(map[string]pipelinesv1alpha1.Application, len(params))
	for _, p := range params {
		spec := *appSet.Spec.Template.ApplicationSpec.DeepCopy()
		if err := substituteStrings(&spec, p); err != nil {
			return nil, err
		}

		name := applicationNameFromParams(appSet.Name, p)
		appLabels := map[string]string{
			applicationSetLabelKey:         appSet.Name,
			engine.ManagedByLabelKey:       engine.ManagedByLabelValue,
			engine.ApplicationNameLabelKey: name,
		}
		if spec.Project != "" {
			appLabels["app.paprika.io/project"] = spec.Project
		}

		annotations, err := renderTemplateMetadata(appSet.Spec.Template.Metadata, appLabels, p)
		if err != nil {
			return nil, err
		}

		app := pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{
				Name:        name,
				Namespace:   appSet.Namespace,
				Labels:      appLabels,
				Annotations: annotations,
			},
			Spec: spec,
		}

		if err := ctrl.SetControllerReference(appSet, &app, r.Scheme); err != nil {
			return nil, fmt.Errorf("setting controller reference on application %s: %w", name, err)
		}

		desired[name] = app
	}
	return desired, nil
}

// renderTemplateMetadata interpolates generator params into the template's
// labels (merged into appLabels) and annotations (returned).
func renderTemplateMetadata(meta *pipelinesv1alpha1.ApplicationTemplateMetadata, appLabels, p map[string]string) (map[string]string, error) {
	if meta == nil {
		return nil, nil
	}
	for k, v := range meta.Labels {
		rendered, err := renderTemplate(v, p)
		if err != nil {
			return nil, fmt.Errorf("template label %q: %w", k, err)
		}
		appLabels[k] = rendered
	}
	var annotations map[string]string
	if len(meta.Annotations) > 0 {
		annotations = make(map[string]string, len(meta.Annotations))
		for k, v := range meta.Annotations {
			rendered, err := renderTemplate(v, p)
			if err != nil {
				return nil, fmt.Errorf("template annotation %q: %w", k, err)
			}
			annotations[k] = rendered
		}
	}
	return annotations, nil
}

func (r *ApplicationSetReconciler) listOwnedApplications(ctx context.Context, appSet *pipelinesv1alpha1.ApplicationSet) ([]pipelinesv1alpha1.Application, error) {
	var list pipelinesv1alpha1.ApplicationList
	if err := r.client.List(ctx, &list,
		client.InNamespace(appSet.Namespace),
		client.MatchingLabels{applicationSetLabelKey: appSet.Name},
	); err != nil {
		return nil, fmt.Errorf("listing applications: %w", err)
	}
	return list.Items, nil
}

func (r *ApplicationSetReconciler) updateApplication(ctx context.Context, existing, desired *pipelinesv1alpha1.Application) error {
	if applicationMatchesDesired(existing, desired) {
		return nil // skip no-op writes — an update bumps resourceVersion
	}
	existing.Spec = desired.Spec
	if existing.Labels == nil {
		existing.Labels = map[string]string{}
	}
	for k, v := range desired.Labels {
		existing.Labels[k] = v
	}
	if desired.Annotations != nil {
		if existing.Annotations == nil {
			existing.Annotations = map[string]string{}
		}
		for k, v := range desired.Annotations {
			existing.Annotations[k] = v
		}
	}
	existing.OwnerReferences = desired.OwnerReferences
	if err := r.client.Update(ctx, existing); err != nil {
		return fmt.Errorf("updating application: %w", err)
	}
	return nil
}

// applicationMatchesDesired reports whether the existing app already carries
// the rendered spec plus template-managed labels and annotations.
func applicationMatchesDesired(existing, desired *pipelinesv1alpha1.Application) bool {
	if !reflect.DeepEqual(existing.Spec, desired.Spec) {
		return false
	}
	for k, v := range desired.Labels {
		if existing.Labels[k] != v {
			return false
		}
	}
	for k, v := range desired.Annotations {
		if existing.Annotations[k] != v {
			return false
		}
	}
	return true
}

// applyApplicationUpdates creates missing apps and applies spec updates under
// the set's strategy. It returns gated=true when a RollingSync step is
// health-blocked and no more updates may proceed this pass.
func (r *ApplicationSetReconciler) applyApplicationUpdates(
	ctx context.Context,
	appSet *pipelinesv1alpha1.ApplicationSet,
	desired map[string]pipelinesv1alpha1.Application,
	existingByName map[string]pipelinesv1alpha1.Application,
) (bool, error) {
	if appSet.Spec.Strategy == nil || appSet.Spec.Strategy.Type != "RollingSync" ||
		appSet.Spec.Strategy.RollingSync == nil || len(appSet.Spec.Strategy.RollingSync.Steps) == 0 {
		return r.applyAllApplicationUpdates(ctx, desired, existingByName)
	}
	return r.applyRollingSync(ctx, appSet, desired, existingByName)
}

func (r *ApplicationSetReconciler) applyAllApplicationUpdates(
	ctx context.Context,
	desired map[string]pipelinesv1alpha1.Application,
	existingByName map[string]pipelinesv1alpha1.Application,
) (bool, error) {
	for name := range desired {
		desiredApp := desired[name]
		if existingApp, ok := existingByName[name]; ok {
			if err := r.updateApplication(ctx, &existingApp, &desiredApp); err != nil {
				return false, fmt.Errorf("updating application %s: %w", name, err)
			}
			continue
		}
		if err := r.client.Create(ctx, &desiredApp); err != nil {
			return false, fmt.Errorf("creating application %s: %w", name, err)
		}
	}
	return false, nil
}

// applyRollingSync implements ApplicationSet progressive sync: steps are
// ordered batches; step N may only issue updates once every app matched by
// steps < N is already at desired state and reports Healthy. maxUpdate caps
// per-pass updates inside a step. Apps matching no step update in a final
// implicit step after all declared steps pass.
func (r *ApplicationSetReconciler) applyRollingSync(
	ctx context.Context,
	appSet *pipelinesv1alpha1.ApplicationSet,
	desired map[string]pipelinesv1alpha1.Application,
	existingByName map[string]pipelinesv1alpha1.Application,
) (bool, error) {
	log := log.FromContext(ctx)
	steps := appSet.Spec.Strategy.RollingSync.Steps
	stepOf := assignSyncSteps(desired, steps)

	// Creates are unthrottled — a net-new app is safe to create in its step.
	if err := r.createMissingApplications(ctx, desired, existingByName); err != nil {
		return false, err
	}

	for i := 0; i <= len(steps); i++ {
		var members []string
		for name := range desired {
			if stepOf[name] == i {
				members = append(members, name)
			}
		}
		if len(members) == 0 {
			continue
		}
		sort.Strings(members) // deterministic batching
		if blocked := priorStepsUnhealthy(desired, existingByName, stepOf, i); blocked != "" {
			log.Info("RollingSync step gated on prior-step health",
				"step", i, "blockedBy", blocked)
			return true, nil
		}
		gated, err := r.applyRollingSyncStep(ctx, steps, i, members, desired, existingByName)
		if err != nil || gated {
			return gated, err
		}
	}
	return false, nil
}

// assignSyncSteps maps each desired app to its first matching step; unmatched
// apps land in the implicit trailing step len(steps).
func assignSyncSteps(desired map[string]pipelinesv1alpha1.Application, steps []pipelinesv1alpha1.RollingSyncStep) map[string]int {
	stepOf := make(map[string]int, len(desired))
	for name := range desired {
		stepOf[name] = len(steps)
		for i := range steps {
			if stepMatches(desired[name].Labels, steps[i].MatchLabels) {
				stepOf[name] = i
				break
			}
		}
	}
	return stepOf
}

func (r *ApplicationSetReconciler) createMissingApplications(
	ctx context.Context,
	desired map[string]pipelinesv1alpha1.Application,
	existingByName map[string]pipelinesv1alpha1.Application,
) error {
	for name := range desired {
		if _, exists := existingByName[name]; exists {
			continue
		}
		desiredApp := desired[name]
		if err := r.client.Create(ctx, &desiredApp); err != nil {
			return fmt.Errorf("creating application %s: %w", name, err)
		}
	}
	return nil
}

// applyRollingSyncStep issues updates for one step's members up to the step's
// maxUpdate budget. gated=true means the budget is spent and later members
// wait for the next pass.
func (r *ApplicationSetReconciler) applyRollingSyncStep(
	ctx context.Context,
	steps []pipelinesv1alpha1.RollingSyncStep,
	step int,
	members []string,
	desired map[string]pipelinesv1alpha1.Application,
	existingByName map[string]pipelinesv1alpha1.Application,
) (bool, error) {
	budget := stepMaxUpdate(steps, step, len(members))
	updated := 0
	for _, name := range members {
		existing, ok := existingByName[name]
		if !ok {
			continue // created this pass
		}
		desiredApp := desired[name]
		if applicationMatchesDesired(&existing, &desiredApp) {
			continue
		}
		if updated >= budget {
			return true, nil
		}
		if err := r.updateApplication(ctx, &existing, &desiredApp); err != nil {
			return false, fmt.Errorf("updating application %s: %w", name, err)
		}
		updated++
	}
	return false, nil
}

func stepMatches(appLabels, matchLabels map[string]string) bool {
	for k, v := range matchLabels {
		if appLabels[k] != v {
			return false
		}
	}
	return true
}

// priorStepsUnhealthy returns the name of an earlier-step app blocking
// progress: still out-of-date or not Healthy. Empty means clear.
func priorStepsUnhealthy(
	desired map[string]pipelinesv1alpha1.Application,
	existingByName map[string]pipelinesv1alpha1.Application,
	stepOf map[string]int,
	step int,
) string {
	names := make([]string, 0, len(desired))
	for name := range desired {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if stepOf[name] >= step {
			continue
		}
		existing, ok := existingByName[name]
		if !ok {
			return name // created this pass; not yet healthy
		}
		desiredApp := desired[name]
		if !applicationMatchesDesired(&existing, &desiredApp) {
			return name
		}
		if existing.Status.Health != pipelinesv1alpha1.HealthHealthy &&
			existing.Status.Phase != pipelinesv1alpha1.ApplicationHealthy {
			return name
		}
	}
	return ""
}

func stepMaxUpdate(steps []pipelinesv1alpha1.RollingSyncStep, step, members int) int {
	if step >= len(steps) {
		return members // implicit trailing step: unbounded
	}
	m := steps[step].MaxUpdate
	if m == nil {
		return members
	}
	v, err := intstr.GetScaledValueFromIntOrPercent(m, members, true)
	if err != nil || v < 1 {
		return 1
	}
	return v
}

func (r *ApplicationSetReconciler) patchStatus(
	ctx context.Context,
	appSet *pipelinesv1alpha1.ApplicationSet,
	count int,
	ready bool,
	reason, message string,
) {
	log := log.FromContext(ctx)
	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var fresh pipelinesv1alpha1.ApplicationSet
		if err := r.client.Get(ctx, types.NamespacedName{Name: appSet.Name, Namespace: appSet.Namespace}, &fresh); err != nil {
			return fmt.Errorf("fetching applicationset for status update: %w", err)
		}

		fresh.Status.ObservedGeneration = fresh.Generation
		fresh.Status.Applications = count

		status := metav1.ConditionTrue
		if !ready {
			status = metav1.ConditionFalse
		}
		meta.SetStatusCondition(&fresh.Status.Conditions, metav1.Condition{
			Type:               "Ready",
			Status:             status,
			Reason:             reason,
			Message:            message,
			LastTransitionTime: metav1.Now(),
		})

		if err := r.client.Status().Update(ctx, &fresh); err != nil {
			return fmt.Errorf("updating applicationset status: %w", err)
		}
		return nil
	}); err != nil {
		log.Error(err, "Failed to patch ApplicationSet status", "applicationset", appSet.Name)
	}
}

func applicationNameFromParams(setName string, params map[string]string) string {
	hash := paramHash(params)
	suffix := hash[:8]
	name := fmt.Sprintf("%s-%s", setName, suffix)
	if len(name) > 63 {
		maxSet := 63 - 1 - len(suffix)
		if maxSet < 1 {
			maxSet = 1
		}
		name = setName[:maxSet] + "-" + suffix
	}
	return strings.ToLower(name)
}

func paramHash(params map[string]string) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	h := sha256.New()
	for _, k := range keys {
		h.Write([]byte(k))
		h.Write([]byte("="))
		h.Write([]byte(params[k]))
		h.Write([]byte("\n"))
	}
	return hex.EncodeToString(h.Sum(nil))
}

func substituteStrings(v interface{}, params map[string]string) error {
	return substituteValue(reflect.ValueOf(v).Elem(), params)
}

//nolint:gocognit,exhaustive,cyclop // reflect traversal of known spec shapes.
func substituteValue(v reflect.Value, params map[string]string) error {
	switch v.Kind() {
	case reflect.Pointer:
		if v.IsNil() {
			return nil
		}
		return substituteValue(v.Elem(), params)
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			if err := substituteValue(v.Field(i), params); err != nil {
				return fmt.Errorf("substitute struct field: %w", err)
			}
		}
	case reflect.Map:
		for _, key := range v.MapKeys() {
			val := v.MapIndex(key)
			if val.Kind() == reflect.String {
				rendered, err := renderTemplate(val.String(), params)
				if err != nil {
					return fmt.Errorf("render map value template: %w", err)
				}
				v.SetMapIndex(key, reflect.ValueOf(rendered))
			} else {
				if err := substituteValue(val, params); err != nil {
					return fmt.Errorf("substitute map value: %w", err)
				}
			}
		}
	case reflect.Slice, reflect.Array:
		for i := 0; i < v.Len(); i++ {
			if err := substituteValue(v.Index(i), params); err != nil {
				return fmt.Errorf("substitute slice element: %w", err)
			}
		}
	case reflect.String:
		s := v.String()
		if s == "" {
			return nil
		}
		rendered, err := renderTemplate(s, params)
		if err != nil {
			return fmt.Errorf("render string template: %w", err)
		}
		v.SetString(rendered)
	default:
		// No substitution for other kinds.
	}
	return nil
}

func renderTemplate(tmpl string, params map[string]string) (string, error) {
	t, err := template.New("field").Parse(tmpl)
	if err != nil {
		return "", fmt.Errorf("parsing template %q: %w", tmpl, err)
	}
	var buf bytes.Buffer
	if err := t.Execute(&buf, params); err != nil {
		return "", fmt.Errorf("executing template %q: %w", tmpl, err)
	}
	return buf.String(), nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *ApplicationSetReconciler) SetupWithManager(mgr ctrl.Manager) error {
	r.client = mgr.GetClient()
	if err := ctrl.NewControllerManagedBy(mgr).
		For(&pipelinesv1alpha1.ApplicationSet{}).
		Owns(&pipelinesv1alpha1.Application{}).
		WithOptions(controller.Options{MaxConcurrentReconciles: 1}).
		Named("applicationset").
		Complete(r); err != nil {
		return fmt.Errorf("setting up applicationset controller: %w", err)
	}
	return nil
}

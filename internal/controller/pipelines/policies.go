package pipelines

import (
	"context"
	"errors"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// Management policies gate what Paprika may do, not what it may want. Every
// enforcement point asks this file the same question — "may I do X here?" — so a
// single answer decides apply, prune, delete, self-heal and rollout together.
// Splitting the check per call site is how two controllers end up disagreeing
// about whether a cluster is read-only.

// resolveStagePolicies returns the policies in force for one Stage.
//
// The effective set is the target Cluster's ceiling intersected with the
// Stage's own request. A Stage can narrow the ceiling, never widen it.
//
// A read that fails for any reason other than "no such registration" is
// returned as an error rather than degraded to full management. Assuming a
// ceiling away on a transient API blip would apply writes the ceiling forbids,
// which is exactly the guarantee an observe-only cluster is bought for.
func resolveStagePolicies(
	ctx context.Context,
	reader client.Reader,
	operatorNamespace string,
	stage *paprikav1.Stage,
	defaultNamespace string,
) ([]paprikav1.ManagementPolicy, error) {
	ceiling, err := resolveClusterCeiling(ctx, reader, operatorNamespace, &stage.Spec.Cluster, defaultNamespace)
	if err != nil {
		return nil, err
	}
	return paprikav1.IntersectManagementPolicies(ceiling, stage.Spec.ManagementPolicies), nil
}

// resolveClusterCeiling reads the ceiling a deployment target declares.
//
// An empty ref means the stage deploys in-cluster, which resolves to the
// registered in-cluster Cluster the chart installs — the same registration the
// fleet index uses. A named ref is read from its own namespace, falling back to
// the referring namespace the way resolveClusterRef does.
func resolveClusterCeiling(
	ctx context.Context,
	reader client.Reader,
	operatorNamespace string,
	ref *paprikav1.ClusterRef,
	defaultNamespace string,
) ([]paprikav1.ManagementPolicy, error) {
	if ref.Name == "" {
		cluster := inClusterRegistration(ctx, reader, operatorNamespace)
		if cluster == nil {
			return paprikav1.DefaultManagementPolicies(), nil
		}
		return cluster.Spec.ManagementPolicies, nil
	}

	namespace := ref.Namespace
	if namespace == "" {
		namespace = defaultNamespace
	}
	var cluster clustersv1alpha1.Cluster
	err := reader.Get(ctx, types.NamespacedName{Namespace: namespace, Name: ref.Name}, &cluster)
	if missingClusterRegistration(err) {
		// An explicit transport with no registration (a bare kubeconfigSecret
		// or agentAddress) has no ceiling to read, so the stage's own request
		// stands alone.
		return paprikav1.DefaultManagementPolicies(), nil
	}
	if err != nil {
		return nil, fmt.Errorf("read cluster %s/%s management policies: %w", namespace, ref.Name, err)
	}
	return cluster.Spec.ManagementPolicies, nil
}

// missingClusterRegistration reports whether a failed read means "there is no
// Cluster here" rather than "the read failed".
//
// The third case matters: a manager built without the clusters API registered in
// its scheme answers with a not-registered error, which is the same fact — no
// registration to read a ceiling from — expressed by a different type.
func missingClusterRegistration(err error) bool {
	return err != nil && (apierrors.IsNotFound(err) ||
		meta.IsNoMatchError(err) ||
		runtime.IsNotRegisteredError(err))
}

// inClusterRegistration finds the Cluster that represents the control plane's
// own cluster. There is one per install, installed by the chart; a second one
// would be an operator mistake, and picking the first by name keeps the answer
// deterministic rather than map-order dependent.
func inClusterRegistration(ctx context.Context, reader client.Reader, operatorNamespace string) *clustersv1alpha1.Cluster {
	var list clustersv1alpha1.ClusterList
	if err := reader.List(ctx, &list, client.InNamespace(operatorNamespace)); err != nil {
		return nil
	}
	var found *clustersv1alpha1.Cluster
	for i := range list.Items {
		cluster := &list.Items[i]
		if cluster.Spec.Mode != paprikav1.ClusterModeInCluster {
			continue
		}
		if found == nil || cluster.Name < found.Name {
			found = cluster
		}
	}
	return found
}

// policySet answers the deployment questions for one resolved target.
type policySet struct {
	policies []paprikav1.ManagementPolicy
	// target names the cluster the decision applies to, for the message a
	// refused operation reports.
	target string
}

// allows reports whether action is permitted.
func (p policySet) allows(action paprikav1.ManagementPolicy) bool {
	return paprikav1.Allows(p.policies, action)
}

// ErrManagementPolicyWithheld marks an operation the effective policies refuse.
// Callers treat it as a wait state rather than a failure: the work can proceed
// as soon as an operator widens the ceiling, so spending the release's retry
// budget on it would be wrong.
var ErrManagementPolicyWithheld = errors.New("management policy withheld")

// refusal explains a withheld action. It names the action and the cluster, and
// states the effective set, because "prune is disabled" and "this cluster is
// read-only" are different conversations for whoever has to change it.
func (p policySet) refusal(action paprikav1.ManagementPolicy) error {
	return fmt.Errorf("%w: %s is not permitted on %s (effective policies: %v)",
		ErrManagementPolicyWithheld, action, p.target, p.policies)
}

// rolloutPolicyError reports whether a stage's progressive strategy may run.
// Stages without a canary or rollout strategy shift no traffic, so they need no
// Rollout grant; the gate only exists where traffic actually moves.
func (r *ReleaseReconciler) rolloutPolicyError(ctx context.Context, stage *paprikav1.Stage, namespace string) error {
	progressive := stage.Spec.RolloutStrategy != nil ||
		(stage.Spec.Canary != nil && len(stage.Spec.Canary.Steps) > 0)
	if !progressive {
		return nil
	}
	policies, err := r.policiesForStage(ctx, stage, namespace)
	if err != nil {
		return err
	}
	if policies.allows(paprikav1.ManagementPolicyRollout) {
		return nil
	}
	return policies.refusal(paprikav1.ManagementPolicyRollout)
}

// policiesForStage is the ReleaseReconciler's entry point to the shared
// resolver. A nil stage means the release carries no stage reference, which only
// standalone Releases do; those keep full management because no registration
// declared otherwise.
func (r *ReleaseReconciler) policiesForStage(ctx context.Context, stage *paprikav1.Stage, namespace string) (policySet, error) {
	if stage == nil {
		return policySet{policies: paprikav1.DefaultManagementPolicies(), target: "an unregistered target"}, nil
	}
	policies, err := resolveStagePolicies(ctx, r.client, r.Namespace, stage, namespace)
	if err != nil {
		return policySet{}, err
	}
	return policySet{policies: policies, target: stageTargetName(&stage.Spec.Cluster, stage.Name)}, nil
}

// policiesForApplicationStage resolves the policies in force for an inline
// Application stage, before any Stage or Release exists.
//
// The Application controller asks this question early so an unwritable target
// parks with a condition instead of creating a Release that can only sit in
// Promoting. The Release controller asks the same question again against the
// generated Stage, which is what still protects a release created before the
// ceiling narrowed.
func (r *ApplicationReconciler) policiesForApplicationStage(
	ctx context.Context,
	stage *paprikav1.ApplicationPromotionStage,
	namespace string,
) (policySet, error) {
	ceiling, err := resolveClusterCeiling(ctx, r.client, r.Namespace, &stage.Cluster, namespace)
	if err != nil {
		return policySet{}, err
	}
	return policySet{
		policies: paprikav1.IntersectManagementPolicies(ceiling, stage.ManagementPolicies),
		target:   stageTargetName(&stage.Cluster, stage.Name),
	}, nil
}

// stageTargetName renders a ClusterRef for a human: a named cluster, or the
// in-cluster sentinel an empty ref means.
func stageTargetName(ref *paprikav1.ClusterRef, fallback string) string {
	if ref.Name == "" {
		return "the in-cluster target"
	}
	if ref.Namespace != "" {
		return ref.Namespace + "/" + ref.Name
	}
	return ref.Name
}

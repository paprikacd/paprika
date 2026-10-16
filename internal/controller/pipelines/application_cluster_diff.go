package pipelines

import (
	"context"
	"errors"
	"fmt"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/discovery"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/clusterconfig"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/kube"
)

const diffUnavailableCondition = "DiffUnavailable"

// applicationDiffEngine selects the same registered target used by release
// apply. A remote target gets its own engine and discovery resolver; replacing
// the shared engine would race applications on other clusters.
func (r *ApplicationReconciler) applicationDiffEngine(ctx context.Context, app *paprikav1.Application) (selected DiffEngine, stop func(), remote bool, err error) {
	cluster, err := r.applicationDiffCluster(ctx, app)
	if err != nil {
		return nil, nil, true, err
	}
	if cluster.Mode == paprikav1.ClusterModeAgent || cluster.AgentAddress != "" {
		return nil, nil, true, errors.New("agent observation transport does not expose desired-resource drift reads; configure a direct cluster kubeconfigSecretRef")
	}
	if cluster.KubeconfigSecret == "" {
		return r.DiffEngine, func() {}, false, nil
	}
	diff, err := r.remoteApplicationDiffEngine(ctx, &cluster, app.Namespace)
	if err != nil {
		return nil, nil, true, err
	}
	return diff, diff.Stop, true, nil
}

func (r *ApplicationReconciler) remoteApplicationDiffEngine(ctx context.Context, cluster *paprikav1.ClusterRef, namespace string) (*engine.ScalableDiffEngine, error) {
	if r.ClusterMgr == nil {
		return nil, errors.New("remote cluster connection manager is not configured")
	}
	credentialNamespace := clusterCredentialNamespace(cluster, namespace)
	client, err := r.ClusterMgr.GetClient(ctx, cluster.KubeconfigSecret, credentialNamespace)
	if err != nil {
		return nil, fmt.Errorf("get application target client: %w", err)
	}
	if client == nil {
		return nil, errors.New("application target client is not available")
	}
	config, err := r.ClusterMgr.GetRestConfig(ctx, cluster.KubeconfigSecret, credentialNamespace)
	if err != nil {
		return nil, fmt.Errorf("get application target discovery configuration: %w", err)
	}
	if config == nil {
		return nil, errors.New("application target discovery configuration is not available")
	}
	config = clusterconfig.WithClientRateLimits(kube.WithRetryTransport(kube.WithProtobufResponses(config)))
	discoveryClient, err := discovery.NewDiscoveryClientForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("create application target discovery client: %w", err)
	}
	diff := engine.NewScalableDiffEngine(client)
	// The pooled transport is shared, but an ephemeral diff must not start
	// cluster-wide informers or wait for their initial synchronization.
	diff.SetLiveCache(nil)
	diff.SetResolver(engine.NewCachedGVRResolver(discoveryClient))
	return diff, nil
}

func (r *ApplicationReconciler) applicationDiffStageName(ctx context.Context, app *paprikav1.Application) (string, error) {
	stageName := ""
	if app.Status.ReleaseRef != "" {
		var release paprikav1.Release
		if err := r.client.Get(ctx, types.NamespacedName{Namespace: app.Namespace, Name: app.Status.ReleaseRef}, &release); err != nil {
			return "", fmt.Errorf("get active release for application diff target: %w", err)
		}
		stageName = release.Spec.Target
		if stageName == "" {
			stageName = release.Status.CurrentStage
		}
	}
	if stageName == "" && app.Status.CurrentStage != "" {
		stageName = app.Status.CurrentStage
		for i := range app.Spec.Stages {
			stage := &app.Spec.Stages[i]
			if stage.Name == stageName {
				stageName = app.Name + "-" + stage.Name
				break
			}
		}
	}
	return stageName, nil
}

func (r *ApplicationReconciler) applicationDiffCluster(ctx context.Context, app *paprikav1.Application) (paprikav1.ClusterRef, error) {
	stageName, err := r.applicationDiffStageName(ctx, app)
	if err != nil {
		return paprikav1.ClusterRef{}, err
	}
	resolver := &ReleaseReconciler{client: r.client}
	if stageName != "" {
		var stage paprikav1.Stage
		if err := r.client.Get(ctx, types.NamespacedName{Namespace: app.Namespace, Name: stageName}, &stage); err != nil {
			return paprikav1.ClusterRef{}, fmt.Errorf("get application diff stage %s: %w", stageName, err)
		}
		return resolver.resolveClusterRef(ctx, &stage.Spec.Cluster, app.Namespace)
	}
	if len(app.Spec.Stages) == 1 {
		return resolver.resolveClusterRef(ctx, &app.Spec.Stages[0].Cluster, app.Namespace)
	}
	for i := range app.Spec.Stages {
		cluster, err := resolver.resolveClusterRef(ctx, &app.Spec.Stages[i].Cluster, app.Namespace)
		if err != nil {
			return paprikav1.ClusterRef{}, err
		}
		if cluster.KubeconfigSecret != "" || cluster.Mode == paprikav1.ClusterModeAgent || cluster.AgentAddress != "" {
			return paprikav1.ClusterRef{}, errors.New("application current deployment stage is not known for remote resource comparison")
		}
	}
	return paprikav1.ClusterRef{}, nil
}

func markApplicationDiffUnavailable(app *paprikav1.Application) {
	app.Status.Synced = false
	app.Status.Health = paprikav1.HealthUnknown
	meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
		Type: diffUnavailableCondition, Status: metav1.ConditionTrue, Reason: "TargetStateUnavailable",
		Message:            "Desired-resource comparison requires a reachable direct read transport for the current deployment cluster.",
		ObservedGeneration: app.Generation, LastTransitionTime: metav1.Now(),
	})
}

func clearApplicationDiffUnavailable(app *paprikav1.Application) {
	meta.RemoveStatusCondition(&app.Status.Conditions, diffUnavailableCondition)
}

func applicationDiffUnavailable(app *paprikav1.Application) bool {
	return meta.IsStatusConditionTrue(app.Status.Conditions, diffUnavailableCondition)
}

func markApplicationResourceHealthUnavailable(app *paprikav1.Application) {
	app.Status.ResourceHealth = nil
	for _, resource := range app.Status.Resources {
		if resource.Status != "Pruned" {
			app.Status.ResourceHealth = append(app.Status.ResourceHealth, paprikav1.ResourceHealth{
				Kind: resource.Kind, Name: resource.Name, Namespace: resource.Namespace,
				Health: "Unknown", Message: "Current deployment cluster state is unavailable.",
			})
		}
	}
	sortResourceHealth(app.Status.ResourceHealth)
}

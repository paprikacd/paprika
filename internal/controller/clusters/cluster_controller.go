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

package clusters

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	"github.com/benebsworth/paprika/internal/clusterconfig"
	"github.com/benebsworth/paprika/internal/clusterprovider"
	"github.com/benebsworth/paprika/internal/kube"
	"github.com/benebsworth/paprika/internal/observability"
)

// ClusterReconciler reconciles a Cluster object.
type ClusterReconciler struct {
	client     client.Client
	Scheme     *runtime.Scheme
	RESTConfig *rest.Config

	// clients holds one warm Kubernetes client per managed cluster, so a
	// health check reuses its connection pool instead of rebuilding one every
	// reconcile. Lazily created so existing construction sites keep working.
	clients     *kube.Clients
	clientsOnce sync.Once
}

// clientCache returns the shared per-cluster client cache, creating it once.
func (r *ClusterReconciler) clientCache() *kube.Clients {
	r.clientsOnce.Do(func() {
		if r.clients == nil {
			r.clients = kube.NewClients()
		}
	})
	return r.clients
}

// +kubebuilder:rbac:groups=clusters.paprika.io,resources=clusters,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=clusters.paprika.io,resources=clusters/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=clusters.paprika.io,resources=clusters/finalizers,verbs=update
// +kubebuilder:rbac:groups=core,resources=secrets,verbs=get;list;watch

// Reconcile performs a health/connectivity check for the Cluster.
func (r *ClusterReconciler) Reconcile(ctx context.Context, req ctrl.Request) (_ ctrl.Result, spanErr error) {
	ctx, endSpan := observability.ReconcileSpan(ctx, "Cluster", req)
	defer func() { endSpan(spanErr) }()

	log := logf.FromContext(ctx)

	var cluster clustersv1alpha1.Cluster
	if err := r.client.Get(ctx, req.NamespacedName, &cluster); err != nil {
		if k8sErr := client.IgnoreNotFound(err); k8sErr != nil {
			return ctrl.Result{}, fmt.Errorf("getting cluster: %w", k8sErr)
		}
		// The Cluster is gone; drop its client so the connections it held do
		// not outlive the object.
		r.clientCache().Forget(req.Namespace + "/" + req.Name)
		return ctrl.Result{}, nil
	}

	if cluster.Spec.Disabled {
		return r.updatePhase(ctx, &cluster, clustersv1alpha1.ClusterPhaseDisabled, "Disabled", "cluster is disabled")
	}

	cfg, err := r.buildConfig(ctx, &cluster)
	if err != nil {
		log.Error(err, "Failed to build cluster config", "cluster", cluster.Name)
		return r.updatePhase(ctx, &cluster, clustersv1alpha1.ClusterPhaseUnhealthy, "ConfigError", err.Error())
	}

	if cluster.Spec.Mode == clustersv1alpha1.ClusterModeAgent {
		return r.updatePhase(ctx, &cluster, clustersv1alpha1.ClusterPhasePending, "AwaitingAgent", "waiting for agent connection")
	}

	version, cli, checkErr := r.checkHealth(ctx, cfg, &cluster)
	if checkErr != nil {
		log.Error(checkErr, "Cluster health check failed", "cluster", cluster.Name)
		return r.updatePhase(ctx, &cluster, clustersv1alpha1.ClusterPhaseUnhealthy, "HealthCheckFailed", checkErr.Error())
	}

	cluster.Status.Version = version

	// Inventory and provider enrichment ride the health check: both read the
	// same connection, and a failure in either degrades its own status field
	// rather than the cluster's phase — a cluster whose nodes cannot be
	// listed is still a cluster deployments can reach.
	nodes, invErr := r.gatherInventory(ctx, cli, &cluster)
	if invErr != nil {
		log.Error(invErr, "Cluster inventory gather failed", "cluster", cluster.Name)
		cluster.Status.Inventory = nil
	}
	cluster.Status.Provider = r.enrichProvider(ctx, &cluster, cfg, nodes)

	return r.updatePhase(ctx, &cluster, clustersv1alpha1.ClusterPhaseHealthy, "Ready", "cluster is reachable")
}

// gatherInventory lists the cluster's workload surface — nodes, pods,
// namespaces — and folds it into status.inventory. The nodes are returned
// alongside the inventory because provider detection and derived node pools
// read the same list; listing twice would double the cost of every check.
func (r *ClusterReconciler) gatherInventory(
	ctx context.Context,
	cli kubernetes.Interface,
	cluster *clustersv1alpha1.Cluster,
) ([]corev1.Node, error) {
	nodeList, err := cli.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("listing nodes: %w", err)
	}
	podList, err := cli.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("listing pods: %w", err)
	}
	nsList, err := cli.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("listing namespaces: %w", err)
	}

	inv := &clustersv1alpha1.ClusterInventory{
		NodeCount:      clampInt32(len(nodeList.Items)),
		PodCount:       clampInt32(len(podList.Items)),
		NamespaceCount: clampInt32(len(nsList.Items)),
	}
	regions, zones, kubelets := map[string]struct{}{}, map[string]struct{}{}, map[string]struct{}{}
	for i := range nodeList.Items {
		foldNodeIntoInventory(&nodeList.Items[i], inv, regions, zones, kubelets)
	}
	for i := range podList.Items {
		if podList.Items[i].Status.Phase == corev1.PodRunning {
			inv.RunningPodCount++
		}
	}
	inv.Regions = sortedKeys(regions)
	inv.Zones = sortedKeys(zones)
	inv.KubeletVersions = sortedKeys(kubelets)

	cluster.Status.Inventory = inv
	return nodeList.Items, nil
}

// foldNodeIntoInventory accumulates one node's readiness and topology into
// the inventory being built.
func foldNodeIntoInventory(
	node *corev1.Node,
	inv *clustersv1alpha1.ClusterInventory,
	regions, zones, kubelets map[string]struct{},
) {
	for _, cond := range node.Status.Conditions {
		if cond.Type == corev1.NodeReady && cond.Status == corev1.ConditionTrue {
			inv.ReadyNodeCount++
		}
	}
	if region := node.Labels["topology.kubernetes.io/region"]; region != "" {
		regions[region] = struct{}{}
	}
	if zone := node.Labels["topology.kubernetes.io/zone"]; zone != "" {
		zones[zone] = struct{}{}
	}
	if node.Status.NodeInfo.KubeletVersion != "" {
		kubelets[node.Status.NodeInfo.KubeletVersion] = struct{}{}
	}
}

// clampInt32 bounds a count for the int32 status field — a cluster with more
// than 2^31 pods has bigger problems than this guard, but the conversion
// still must not wrap.
func clampInt32(n int) int32 {
	if n > math.MaxInt32 {
		return math.MaxInt32
	}
	return int32(n) //nolint:gosec // bounded above
}

// enrichProvider resolves the cluster's cloud provider and fills
// status.provider. Detection from node providerIDs always runs — a Cluster
// with no spec.provider still reports "vultr" and its node-label-derived
// pools — while the provider API call only happens when a credential can be
// resolved. The returned status is nil only when nothing could be resolved
// at all, which keeps an uninstrumented cluster free of a misleading entry.
func (r *ClusterReconciler) enrichProvider(
	ctx context.Context,
	cluster *clustersv1alpha1.Cluster,
	cfg *rest.Config,
	nodes []corev1.Node,
) *clustersv1alpha1.ClusterProviderStatus {
	spec := cluster.Spec.Provider
	providerType := clusterprovider.ResolveType(spec, nodes)
	if providerType == "" {
		return nil
	}

	status := &clustersv1alpha1.ClusterProviderStatus{
		Type:       providerType,
		NodePools:  clusterprovider.NodePoolsFromNodes(providerType, nodes),
		ObservedAt: &metav1.Time{Time: time.Now()},
	}

	creds, err := r.providerCredentials(ctx, cluster)
	if err != nil {
		status.State = clusterprovider.StateNotConfigured
		status.Reason = "provider credentials could not be read; check credentialsSecretRef"
		return status
	}

	provider, err := clusterprovider.New(providerType)
	if err != nil {
		status.State = clusterprovider.StateError
		status.Reason = "the resolved provider is not implemented in this build"
		return status
	}

	endpoint := cluster.Spec.Server
	if endpoint == "" && cfg != nil {
		endpoint = cfg.Host
	}
	details, err := provider.Describe(ctx, &clusterprovider.Request{
		ClusterID:      specClusterID(spec),
		Region:         specRegion(spec),
		Project:        specProject(spec),
		SubscriptionID: specSubscriptionID(spec),
		Endpoint:       endpoint,
		Credentials:    creds,
	})
	applyProviderOutcome(ctx, cluster, status, details, err)
	return status
}

// applyProviderOutcome folds one Describe result into the provider status.
// The reasons are fixed sentences rather than the error text: a provider
// error can carry endpoints, subscription IDs or credential fragments, none
// of which belong on a status field an MCP caller can read.
func applyProviderOutcome(
	ctx context.Context,
	cluster *clustersv1alpha1.Cluster,
	status *clustersv1alpha1.ClusterProviderStatus,
	details *clusterprovider.Details,
	err error,
) {
	switch {
	case err == nil:
		status.State = clusterprovider.StateOK
		status.ClusterID = details.ClusterID
		status.Region = details.Region
		if len(details.NodePools) > 0 {
			status.NodePools = mergePoolCounts(details.NodePools, status.NodePools)
		}
	case errors.Is(err, clusterprovider.ErrNotConfigured):
		status.State = clusterprovider.StateNotConfigured
		status.Reason = "provider detected; configure spec.provider credentials for full enrichment"
	case errors.Is(err, clusterprovider.ErrForbidden):
		status.State = clusterprovider.StateForbidden
		status.Reason = "the provider credential was refused; check the credential's permissions"
	case errors.Is(err, clusterprovider.ErrNotMatched):
		status.State = clusterprovider.StateNotAvailable
		status.Reason = "no managed cluster matched; set spec.provider.clusterId to the provider's identifier"
	default:
		logf.FromContext(ctx).Error(err, "Provider enrichment failed", "cluster", cluster.Name)
		status.State = clusterprovider.StateError
		status.Reason = "provider enrichment failed; see the controller logs"
	}
}

// mergePoolCounts fills API-reported pools whose count is zero from the
// node-label-derived set. Some provider APIs report pool shape (plan,
// autoscaler bounds) without a live node count — Vultr v2 returns
// count: null — where the Kubernetes node list already knows the truth.
func mergePoolCounts(
	reported []clustersv1alpha1.ClusterNodePool,
	derived []clustersv1alpha1.ClusterNodePool,
) []clustersv1alpha1.ClusterNodePool {
	byName := make(map[string]int32, len(derived))
	for _, p := range derived {
		byName[p.Name] = p.NodeCount
	}
	out := make([]clustersv1alpha1.ClusterNodePool, len(reported))
	for i, p := range reported {
		out[i] = p
		if out[i].NodeCount == 0 {
			out[i].NodeCount = byName[p.Name]
		}
	}
	return out
}

// providerCredentials reads the credentialsSecretRef document. A nil ref is
// not an error — ambient identity (IRSA, workload identity) is a first-class
// auth pattern — it just means Describe gets no credential document.
func (r *ClusterReconciler) providerCredentials(
	ctx context.Context,
	cluster *clustersv1alpha1.Cluster,
) ([]byte, error) {
	ref := cluster.Spec.Provider
	if ref == nil || ref.CredentialsSecretRef == nil {
		return nil, nil
	}
	ns := ref.CredentialsSecretRef.Namespace
	if ns == "" {
		ns = cluster.Namespace
	}
	var secret corev1.Secret
	if err := r.client.Get(ctx, client.ObjectKey{Namespace: ns, Name: ref.CredentialsSecretRef.Name}, &secret); err != nil {
		return nil, fmt.Errorf("reading provider credentials secret: %w", err)
	}
	key := ref.CredentialsSecretRef.Key
	if key == "" {
		key = "credentials"
	}
	data, ok := secret.Data[key]
	if !ok {
		return nil, fmt.Errorf("provider credentials secret missing key %q", key)
	}
	return data, nil
}

func specClusterID(spec *clustersv1alpha1.ClusterProviderSpec) string {
	if spec == nil {
		return ""
	}
	return spec.ClusterID
}

func specRegion(spec *clustersv1alpha1.ClusterProviderSpec) string {
	if spec == nil {
		return ""
	}
	return spec.Region
}

func specProject(spec *clustersv1alpha1.ClusterProviderSpec) string {
	if spec == nil {
		return ""
	}
	return spec.Project
}

func specSubscriptionID(spec *clustersv1alpha1.ClusterProviderSpec) string {
	if spec == nil {
		return ""
	}
	return spec.SubscriptionID
}

func sortedKeys(set map[string]struct{}) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// buildConfig resolves the connection details for cluster. The mode-by-mode
// rules live in internal/clusterconfig because the console's capacity
// providers resolve the very same clusters and must not develop a second,
// slightly different idea of how a fleet cluster is reached.
func (r *ClusterReconciler) buildConfig(ctx context.Context, cluster *clustersv1alpha1.Cluster) (*rest.Config, error) {
	cfg, err := clusterconfig.ForCluster(ctx, r.client, cluster)
	if err != nil {
		return nil, fmt.Errorf("resolving cluster config: %w", err)
	}
	return cfg, nil
}

func (r *ClusterReconciler) checkHealth(ctx context.Context, cfg *rest.Config, cluster *clustersv1alpha1.Cluster) (string, kubernetes.Interface, error) {
	if cfg == nil {
		return "", nil, errors.New("no rest config for health check")
	}

	timeout := 10 * time.Second
	if cluster.Spec.HealthCheck != nil && cluster.Spec.HealthCheck.Timeout != "" {
		if d, err := time.ParseDuration(cluster.Spec.HealthCheck.Timeout); err == nil {
			timeout = d
		}
	}

	// Discovery's ServerVersion takes no context, so the deadline has to ride
	// on the config. The previous code derived a timeout context and then
	// discarded it, which meant the configured health-check timeout did
	// nothing at all.
	//
	// Discovery only ever touches built-in endpoints, so it can send and
	// receive protobuf; custom resources would need JSON requests.
	healthCfg := kube.RequestTimeout(kube.WithProtobufBothWays(cfg), timeout)

	// One client per cluster, reused across reconciles. Building a clientset
	// per health check discarded the connection pool every time, so each pass
	// paid a fresh TCP and TLS handshake against every managed cluster.
	cli, err := r.clientCache().For(clusterCacheKey(cluster), healthCfg)
	if err != nil {
		return "", nil, fmt.Errorf("building kubernetes client: %w", err)
	}

	version, err := cli.Discovery().ServerVersion()
	if err != nil {
		return "", nil, fmt.Errorf("discovering server version: %w", err)
	}
	return version.GitVersion, cli, nil
}

// clusterCacheKey identifies a cluster in the client cache. Namespace and name
// are stable for the object's lifetime; rotated credentials are handled by the
// cache's own fingerprinting, not by this key.
func clusterCacheKey(cluster *clustersv1alpha1.Cluster) string {
	return cluster.Namespace + "/" + cluster.Name
}

func (r *ClusterReconciler) updatePhase(ctx context.Context, cluster *clustersv1alpha1.Cluster, phase clustersv1alpha1.ClusterPhase, reason, message string) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	if cluster.Status.Phase != phase {
		cluster.Status.Phase = phase
	}
	cluster.Status.ObservedGeneration = cluster.Generation
	cluster.Status.LastHealthCheckTime = &metav1.Time{Time: time.Now()}

	meta.SetStatusCondition(&cluster.Status.Conditions, metav1.Condition{
		Type:               string(phase),
		Status:             metav1.ConditionTrue,
		ObservedGeneration: cluster.Generation,
		LastTransitionTime: metav1.Now(),
		Reason:             reason,
		Message:            message,
	})

	desiredStatus := cluster.Status.DeepCopy()
	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var fresh clustersv1alpha1.Cluster
		if err := r.client.Get(ctx, types.NamespacedName{Name: cluster.Name, Namespace: cluster.Namespace}, &fresh); err != nil {
			return fmt.Errorf("fetching cluster for status update: %w", err)
		}
		fresh.Status = *desiredStatus
		fresh.Status.ObservedGeneration = fresh.Generation
		if err := r.client.Status().Update(ctx, &fresh); err != nil {
			return fmt.Errorf("updating cluster status: %w", err)
		}
		return nil
	}); err != nil {
		log.Error(err, "Failed to update cluster status", "cluster", cluster.Name)
		return ctrl.Result{}, fmt.Errorf("patching cluster status: %w", err)
	}

	interval := 30 * time.Second
	if cluster.Spec.HealthCheck != nil && cluster.Spec.HealthCheck.Interval != "" {
		if d, err := time.ParseDuration(cluster.Spec.HealthCheck.Interval); err == nil {
			interval = d
		}
	}
	return ctrl.Result{RequeueAfter: interval}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *ClusterReconciler) SetupWithManager(mgr ctrl.Manager) error {
	r.client = mgr.GetClient()
	err := ctrl.NewControllerManagedBy(mgr).
		For(&clustersv1alpha1.Cluster{}).
		Named("clusters-cluster").
		Complete(r)
	if err != nil {
		return fmt.Errorf("setting up cluster controller: %w", err)
	}
	return nil
}

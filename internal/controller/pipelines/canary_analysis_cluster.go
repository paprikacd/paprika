package pipelines

import (
	"context"
	"errors"

	"github.com/go-logr/logr"
	"k8s.io/client-go/kubernetes"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/analysis"
	"github.com/benebsworth/paprika/internal/clusterconfig"
	"github.com/benebsworth/paprika/internal/kube"
)

// Bind pod checks to the deployment's cluster. HTTP and Prometheus checks use
// their explicitly configured endpoints and can retain the shared analyzer.
func (r *ReleaseReconciler) analyzerForStage(ctx context.Context, stage *paprikav1.Stage, namespace string, checks []paprikav1.AnalysisCheck) (Analyzer, error) {
	if !hasPodChecks(checks) {
		return r.Analyzer, nil
	}
	cluster, err := r.resolveClusterRef(ctx, &stage.Spec.Cluster, namespace)
	if err != nil {
		return nil, err
	}
	if cluster.Mode == paprikav1.ClusterModeAgent || cluster.AgentAddress != "" {
		return nil, errors.New("podMetrics analysis requires a direct cluster connection; satellite observations do not expose live pod metric reads")
	}
	if cluster.KubeconfigSecret == "" {
		return r.Analyzer, nil
	}
	base, ok := r.Analyzer.(*analysis.CELAnalyzer)
	if !ok {
		return nil, errors.New("remote podMetrics checks require the Kubernetes analysis backend")
	}
	return r.bindRemotePodAnalyzer(ctx, base, &cluster, namespace)
}

func (r *ReleaseReconciler) bindRemotePodAnalyzer(ctx context.Context, base *analysis.CELAnalyzer, cluster *paprikav1.ClusterRef, namespace string) (Analyzer, error) {
	configs, ok := r.ClusterMgr.(ClusterRestConfigGetter)
	if !ok {
		return nil, errors.New("remote podMetrics cluster config resolver is not configured")
	}
	config, err := configs.GetRestConfig(ctx, cluster.KubeconfigSecret, clusterCredentialNamespace(cluster, namespace))
	if err != nil {
		return nil, errors.New("remote podMetrics cluster config could not be resolved")
	}
	if config == nil {
		return nil, errors.New("remote podMetrics cluster config is unavailable")
	}
	config = clusterconfig.WithClientRateLimits(kube.WithRetryTransport(kube.WithProtobufResponses(config)))
	remote, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, errors.New("remote podMetrics Kubernetes client could not be created")
	}
	bound := *base
	bound.K8sClient = remote
	bound.RESTConfig = config
	return &bound, nil
}

func hasPodChecks(checks []paprikav1.AnalysisCheck) bool {
	for i := range checks {
		if checks[i].Type == "podMetrics" {
			return true
		}
	}
	return false
}

func (r *ReleaseReconciler) runCanaryAnalysisForStage(ctx context.Context, release *paprikav1.Release, stage *paprikav1.Stage, cfg *paprikav1.CanaryConfig, result *string, logger logr.Logger) (bool, error) {
	if cfg.Analysis == nil || len(cfg.Analysis.Checks) == 0 {
		return false, nil
	}
	analyzer, err := r.analyzerForStage(ctx, stage, release.Namespace, cfg.Analysis.Checks)
	if err != nil {
		return false, err
	}
	// Dependencies are pointers/interfaces without lock state. This invocation
	// gets its own analyzer without changing concurrent release reconciles.
	bound := *r
	bound.Analyzer = analyzer
	return bound.runCanaryAnalysis(ctx, release, cfg, result, logger)
}

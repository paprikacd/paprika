package apiserver

import (
	"context"
	"errors"
	"fmt"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/clusterconfig"
	"github.com/benebsworth/paprika/internal/kube"
)

// Live reads — a resource tree, a live manifest, pod logs, events — are reads of
// the cluster an application is *deployed to*, not of the cluster this server
// runs in. Serving them from the management cluster is worse than not serving
// them: the names often exist on both, so a wrong answer looks like a right one.
// Everything below exists to make the target explicit and to refuse when it
// cannot be reached.

// ErrTargetUnavailable means the application's cluster cannot be read from here.
// It is not a failure of the control plane: an agent-mode cluster has no API
// endpoint the control plane may dial, and saying so is the honest answer.
var ErrTargetUnavailable = errors.New("the deployment target cannot be read from the control plane")

// targetCluster is where an application's live state lives.
type targetCluster struct {
	// key is the registered Cluster's "<namespace>/<name>". Empty means the
	// control plane's own cluster, which is reached without a registration.
	key string
	// label is what an error message calls it.
	label string
	// agent marks a cluster reached only through a satellite, so no live read
	// is possible until the link carries one.
	agent bool
}

// applicationTargetCluster resolves where an application currently deploys.
//
// The current release is authoritative: a Release records the stage it was
// promoted into, and that stage names the cluster. Falling back to the
// application's own stage list only happens for an application that has not
// produced a release yet, where there is exactly one candidate.
func (s *PaprikaServer) applicationTargetCluster(
	ctx context.Context,
	app *pipelinesv1alpha1.Application,
) (targetCluster, error) {
	if s.client == nil {
		return targetCluster{}, nil
	}

	ref, known, err := s.applicationClusterRef(ctx, app)
	if err != nil {
		return targetCluster{}, err
	}
	if !known {
		return targetCluster{}, fmt.Errorf("%w: no deployment target is recorded for %s/%s",
			ErrTargetUnavailable, app.Namespace, app.Name)
	}
	return s.resolveClusterRef(ctx, &ref, app.Namespace)
}

// applicationClusterRef finds the ClusterRef the application's current release
// targets.
func (s *PaprikaServer) applicationClusterRef(
	ctx context.Context,
	app *pipelinesv1alpha1.Application,
) (pipelinesv1alpha1.ClusterRef, bool, error) {
	stageName, err := s.currentStageName(ctx, app)
	if err != nil {
		return pipelinesv1alpha1.ClusterRef{}, false, err
	}
	if stageName == "" {
		if len(app.Spec.Stages) != 1 {
			return pipelinesv1alpha1.ClusterRef{}, false, nil
		}
		return app.Spec.Stages[0].Cluster, true, nil
	}
	return s.stageClusterRef(ctx, app.Namespace, stageName)
}

// currentStageName reports the stage the application's active release promoted
// into, or the stage an inline application is currently observing.
func (s *PaprikaServer) currentStageName(
	ctx context.Context,
	app *pipelinesv1alpha1.Application,
) (string, error) {
	if app.Status.ReleaseRef != "" {
		var release pipelinesv1alpha1.Release
		err := s.client.Get(ctx, client.ObjectKey{Namespace: app.Namespace, Name: app.Status.ReleaseRef}, &release)
		switch {
		case err == nil:
			if name := release.Spec.Target; name != "" {
				return name, nil
			}
			return release.Status.CurrentStage, nil
		case client.IgnoreNotFound(err) != nil:
			return "", fmt.Errorf("read active release: %w", err)
		}
	}
	if app.Status.CurrentStage != "" {
		// Generated stages are named "<application>-<stage>"; an inline
		// Application promotes through one it does not have to name.
		return app.Name + "-" + app.Status.CurrentStage, nil
	}
	return "", nil
}

// stageClusterRef reads the cluster a named stage deploys to.
func (s *PaprikaServer) stageClusterRef(
	ctx context.Context,
	namespace, stageName string,
) (pipelinesv1alpha1.ClusterRef, bool, error) {
	var stage pipelinesv1alpha1.Stage
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: namespace, Name: stageName}, &stage); err != nil {
		if client.IgnoreNotFound(err) != nil {
			return pipelinesv1alpha1.ClusterRef{}, false, fmt.Errorf("read stage %s: %w", stageName, err)
		}
		return pipelinesv1alpha1.ClusterRef{}, false, nil
	}
	return stage.Spec.Cluster, true, nil
}

// resolveClusterRef turns a ref into a target, applying the same namespace
// defaulting the release controller uses: a ref with no namespace means the
// referring application's namespace.
func (s *PaprikaServer) resolveClusterRef(
	ctx context.Context,
	ref *pipelinesv1alpha1.ClusterRef,
	defaultNamespace string,
) (targetCluster, error) {
	if ref.Name == "" {
		return targetCluster{label: "the control plane's cluster"}, nil
	}
	namespace := ref.Namespace
	if namespace == "" {
		namespace = defaultNamespace
	}
	var cluster clustersv1alpha1.Cluster
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: namespace, Name: ref.Name}, &cluster); err != nil {
		if client.IgnoreNotFound(err) != nil {
			return targetCluster{}, fmt.Errorf("read cluster %s/%s: %w", namespace, ref.Name, err)
		}
		// An inline ref may carry its own transport without a registration; that
		// is a deployment path the console has no client for.
		return targetCluster{}, fmt.Errorf("%w: cluster %s/%s is not registered",
			ErrTargetUnavailable, namespace, ref.Name)
	}
	return targetCluster{
		key:   cluster.Namespace + "/" + cluster.Name,
		label: namespace + "/" + ref.Name,
		agent: cluster.Spec.Mode == clustersv1alpha1.ClusterModeAgent,
	}, nil
}

// targetDynamicClient returns the unstructured client for a target cluster.
func (s *PaprikaServer) targetDynamicClient(ctx context.Context, target targetCluster) (dynamic.Interface, error) {
	if target.agent {
		return nil, fmt.Errorf("%w: %s is reached through a satellite, which does not serve live resource reads yet",
			ErrTargetUnavailable, target.label)
	}
	if target.key == "" {
		if s.dynamicClient == nil {
			return nil, fmt.Errorf("%w: no client is configured for the control plane's cluster", ErrTargetUnavailable)
		}
		return s.dynamicClient, nil
	}
	cfg, err := clusterconfig.NewResolver(s.client).ConfigFor(ctx, target.key)
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %w", ErrTargetUnavailable, target.label, err)
	}
	client, err := s.kubeClientCache().DynamicFor(target.key, cfg)
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %w", ErrTargetUnavailable, target.label, err)
	}
	return client, nil
}

// targetTypedClient returns the typed client for a target cluster, for the
// core-API reads (events, pod logs) that a dynamic client makes awkward.
func (s *PaprikaServer) targetTypedClient(ctx context.Context, target targetCluster) (kubernetes.Interface, error) {
	if target.agent {
		return nil, fmt.Errorf("%w: %s is reached through a satellite, which does not serve live log or event reads yet",
			ErrTargetUnavailable, target.label)
	}
	if target.key == "" {
		if s.k8sClient == nil {
			return nil, fmt.Errorf("%w: no client is configured for the control plane's cluster", ErrTargetUnavailable)
		}
		return s.k8sClient, nil
	}
	cfg, err := clusterconfig.NewResolver(s.client).ConfigFor(ctx, target.key)
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %w", ErrTargetUnavailable, target.label, err)
	}
	client, err := s.kubeClientCache().For(target.key, cfg)
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %w", ErrTargetUnavailable, target.label, err)
	}
	return client, nil
}

// kubeClientCache returns the per-cluster client cache, creating it on first
// use. It exists so a drill-down reuses one connection pool per cluster instead
// of paying a handshake per request.
func (s *PaprikaServer) kubeClientCache() *kube.Clients {
	s.kubeClientsOnce.Do(func() {
		if s.kubeClients == nil {
			s.kubeClients = kube.NewClients()
		}
	})
	return s.kubeClients
}

// targetUnavailableMessage is the sentence a degraded live read returns. It
// names the target so an operator knows which cluster could not be read.
func targetUnavailableMessage(target targetCluster, err error) string {
	if target.label == "" {
		return err.Error()
	}
	return target.label + ": " + err.Error()
}

// targetDynamicClientOrNil resolves the target's dynamic client, returning nil
// when live reads are not possible. Handlers that can render a useful answer
// from status alone use this: an absent client degrades the response instead of
// failing it, and the reason is logged once with the application it applies to.
func (s *PaprikaServer) targetDynamicClientOrNil(
	ctx context.Context,
	target targetCluster,
	resolveErr error,
) dynamic.Interface {
	if resolveErr != nil {
		log.FromContext(ctx).V(1).Info("Live reads are unavailable for this application",
			"target", target.label, "reason", resolveErr.Error())
		return nil
	}
	client, err := s.targetDynamicClient(ctx, target)
	if err != nil {
		log.FromContext(ctx).V(1).Info("Live reads are unavailable for this application",
			"target", target.label, "reason", err.Error())
		return nil
	}
	return client
}

// targetTypedClientOrNil is targetDynamicClientOrNil for the typed client.
func (s *PaprikaServer) targetTypedClientOrNil(
	ctx context.Context,
	target targetCluster,
	resolveErr error,
) kubernetes.Interface {
	if resolveErr != nil {
		return nil
	}
	client, err := s.targetTypedClient(ctx, target)
	if err != nil {
		log.FromContext(ctx).V(1).Info("Live status reads are unavailable for this application",
			"target", target.label, "reason", err.Error())
		return nil
	}
	return client
}

// WithKubeClients injects the per-cluster client cache. Tests use it to serve a
// remote target without a real API server; production leaves it unset and the
// server builds its own on first use.
func WithKubeClients(clients *kube.Clients) ServerOption {
	return func(s *PaprikaServer) { s.kubeClients = clients }
}

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
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

// ClusterReconciler reconciles a Cluster object.
type ClusterReconciler struct {
	client     client.Client
	Scheme     *runtime.Scheme
	RESTConfig *rest.Config
}

// +kubebuilder:rbac:groups=clusters.paprika.io,resources=clusters,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=clusters.paprika.io,resources=clusters/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=clusters.paprika.io,resources=clusters/finalizers,verbs=update
// +kubebuilder:rbac:groups=core,resources=secrets,verbs=get;list;watch

// Reconcile performs a health/connectivity check for the Cluster.
func (r *ClusterReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var cluster clustersv1alpha1.Cluster
	if err := r.client.Get(ctx, req.NamespacedName, &cluster); err != nil {
		if k8sErr := client.IgnoreNotFound(err); k8sErr != nil {
			return ctrl.Result{}, fmt.Errorf("getting cluster: %w", k8sErr)
		}
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

	version, checkErr := r.checkHealth(ctx, cfg, &cluster)
	if checkErr != nil {
		log.Error(checkErr, "Cluster health check failed", "cluster", cluster.Name)
		return r.updatePhase(ctx, &cluster, clustersv1alpha1.ClusterPhaseUnhealthy, "HealthCheckFailed", checkErr.Error())
	}

	cluster.Status.Version = version
	return r.updatePhase(ctx, &cluster, clustersv1alpha1.ClusterPhaseHealthy, "Ready", "cluster is reachable")
}

func (r *ClusterReconciler) buildConfig(ctx context.Context, cluster *clustersv1alpha1.Cluster) (*rest.Config, error) {
	switch cluster.Spec.Mode {
	case clustersv1alpha1.ClusterModeInCluster:
		cfg, err := rest.InClusterConfig()
		if err != nil {
			return nil, fmt.Errorf("in-cluster config: %w", err)
		}
		return cfg, nil
	case clustersv1alpha1.ClusterModeAgent:
		return nil, nil
	case clustersv1alpha1.ClusterModeDirect:
		if cluster.Spec.KubeconfigSecretRef != nil {
			return r.configFromSecret(ctx, cluster)
		}
		if cluster.Spec.Server != "" {
			return &rest.Config{Host: cluster.Spec.Server}, nil
		}
		return nil, errors.New("direct mode requires server or kubeconfigSecretRef")
	default:
		return nil, fmt.Errorf("unsupported cluster mode %q", cluster.Spec.Mode)
	}
}

func (r *ClusterReconciler) configFromSecret(ctx context.Context, cluster *clustersv1alpha1.Cluster) (*rest.Config, error) {
	ref := cluster.Spec.KubeconfigSecretRef
	ns := ref.Namespace
	if ns == "" {
		ns = cluster.Namespace
	}

	var secret corev1.Secret
	if err := r.client.Get(ctx, client.ObjectKey{Name: ref.Name, Namespace: ns}, &secret); err != nil {
		return nil, fmt.Errorf("getting kubeconfig secret: %w", err)
	}

	key := ref.Key
	if key == "" {
		key = "kubeconfig"
	}
	data, ok := secret.Data[key]
	if !ok {
		return nil, fmt.Errorf("kubeconfig secret missing key %q", key)
	}

	cfg, err := clientcmd.RESTConfigFromKubeConfig(data)
	if err != nil {
		return nil, fmt.Errorf("parsing kubeconfig: %w", err)
	}
	return cfg, nil
}

func (r *ClusterReconciler) checkHealth(ctx context.Context, cfg *rest.Config, cluster *clustersv1alpha1.Cluster) (string, error) {
	if cfg == nil {
		return "", errors.New("no rest config for health check")
	}

	timeout := 10 * time.Second
	if cluster.Spec.HealthCheck != nil && cluster.Spec.HealthCheck.Timeout != "" {
		if d, err := time.ParseDuration(cluster.Spec.HealthCheck.Timeout); err == nil {
			timeout = d
		}
	}

	_, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cli, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return "", fmt.Errorf("building kubernetes client: %w", err)
	}

	version, err := cli.Discovery().ServerVersion()
	if err != nil {
		return "", fmt.Errorf("discovering server version: %w", err)
	}
	return version.GitVersion, nil
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

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

package v1alpha1

import (
	"context"
	"fmt"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	ctrl "sigs.k8s.io/controller-runtime"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

var clusterlog = logf.Log.WithName("cluster-resource")

// SetupClusterWebhookWithManager registers the Cluster webhooks.
func SetupClusterWebhookWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewWebhookManagedBy(mgr, &clustersv1alpha1.Cluster{}).
		WithValidator(&ClusterCustomValidator{}).
		WithDefaulter(&ClusterCustomDefaulter{}).
		Complete(); err != nil {
		return fmt.Errorf("setting up cluster webhook: %w", err)
	}
	return nil
}

// +kubebuilder:webhook:path=/mutate-clusters-paprika-io-v1alpha1-cluster,mutating=true,failurePolicy=fail,sideEffects=None,groups=clusters.paprika.io,resources=clusters,verbs=create;update,versions=v1alpha1,name=mcluster-v1alpha1.kb.io,admissionReviewVersions=v1

// ClusterCustomDefaulter sets defaults for Cluster.
type ClusterCustomDefaulter struct{}

func (d *ClusterCustomDefaulter) Default(_ context.Context, obj *clustersv1alpha1.Cluster) error {
	clusterlog.Info("Defaulting for Cluster", "name", obj.GetName())
	if obj.Spec.Mode == "" {
		obj.Spec.Mode = clustersv1alpha1.ClusterModeInCluster
	}
	if obj.Spec.HealthCheck != nil {
		if obj.Spec.HealthCheck.Interval == "" {
			obj.Spec.HealthCheck.Interval = "30s"
		}
		if obj.Spec.HealthCheck.Timeout == "" {
			obj.Spec.HealthCheck.Timeout = "10s"
		}
	}
	if obj.Spec.ConnectionTimeout == "" {
		obj.Spec.ConnectionTimeout = "30s"
	}
	return nil
}

// +kubebuilder:webhook:path=/validate-clusters-paprika-io-v1alpha1-cluster,mutating=false,failurePolicy=fail,sideEffects=None,groups=clusters.paprika.io,resources=clusters,verbs=create;update,versions=v1alpha1,name=vcluster-v1alpha1.kb.io,admissionReviewVersions=v1

// ClusterCustomValidator validates Cluster resources.
type ClusterCustomValidator struct{}

func (v *ClusterCustomValidator) ValidateCreate(_ context.Context, obj *clustersv1alpha1.Cluster) (admission.Warnings, error) {
	clusterlog.Info("Validation for Cluster upon creation", "name", obj.GetName())
	return nil, validateCluster(obj)
}

func (v *ClusterCustomValidator) ValidateUpdate(_ context.Context, oldObj, newObj *clustersv1alpha1.Cluster) (admission.Warnings, error) {
	clusterlog.Info("Validation for Cluster upon update", "name", newObj.GetName())
	return nil, validateCluster(newObj)
}

func (v *ClusterCustomValidator) ValidateDelete(_ context.Context, obj *clustersv1alpha1.Cluster) (admission.Warnings, error) {
	clusterlog.Info("Validation for Cluster upon deletion", "name", obj.GetName())
	return nil, nil
}

//nolint:cyclop,nestif // cluster validation has sequential guard branches.
func validateCluster(cluster *clustersv1alpha1.Cluster) error {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	if cluster.Spec.Mode == "" {
		allErrs = append(allErrs, field.Required(specPath.Child("mode"), "cluster mode is required"))
	} else if cluster.Spec.Mode != clustersv1alpha1.ClusterModeDirect && cluster.Spec.Mode != clustersv1alpha1.ClusterModeAgent && cluster.Spec.Mode != clustersv1alpha1.ClusterModeInCluster {
		allErrs = append(allErrs, field.NotSupported(specPath.Child("mode"), cluster.Spec.Mode, []string{"direct", "agent", "in-cluster"}))
	}

	if cluster.Spec.Mode == clustersv1alpha1.ClusterModeDirect {
		if cluster.Spec.Server == "" && cluster.Spec.KubeconfigSecretRef == nil {
			allErrs = append(allErrs, field.Required(specPath, "direct mode requires server or kubeconfigSecretRef"))
		}
		if cluster.Spec.KubeconfigSecretRef != nil && cluster.Spec.KubeconfigSecretRef.Name == "" {
			allErrs = append(allErrs, field.Required(specPath.Child("kubeconfigSecretRef").Child("name"), "kubeconfig secret name is required"))
		}
	}

	if cluster.Spec.HealthCheck != nil {
		if cluster.Spec.HealthCheck.Interval != "" {
			if _, err := time.ParseDuration(cluster.Spec.HealthCheck.Interval); err != nil {
				allErrs = append(allErrs, field.Invalid(specPath.Child("healthCheck").Child("interval"), cluster.Spec.HealthCheck.Interval, "must be a valid duration"))
			}
		}
		if cluster.Spec.HealthCheck.Timeout != "" {
			if _, err := time.ParseDuration(cluster.Spec.HealthCheck.Timeout); err != nil {
				allErrs = append(allErrs, field.Invalid(specPath.Child("healthCheck").Child("timeout"), cluster.Spec.HealthCheck.Timeout, "must be a valid duration"))
			}
		}
	}

	if cluster.Spec.ConnectionTimeout != "" {
		if _, err := time.ParseDuration(cluster.Spec.ConnectionTimeout); err != nil {
			allErrs = append(allErrs, field.Invalid(specPath.Child("connectionTimeout"), cluster.Spec.ConnectionTimeout, "must be a valid duration"))
		}
	}

	if len(allErrs) == 0 {
		return nil
	}
	return apierrors.NewInvalid(
		schema.GroupKind{Group: "clusters.paprika.io", Kind: "Cluster"},
		cluster.Name,
		allErrs,
	)
}

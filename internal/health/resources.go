// Package health provides CEL-based health evaluation with HTTP probe support.
package health

import (
	"context"
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	netv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// ResourceHealthChecker evaluates the health of Kubernetes resources.
type ResourceHealthChecker struct {
	client.Client
}

// NewResourceHealthChecker creates a new resource health checker.
func NewResourceHealthChecker(c client.Client) *ResourceHealthChecker {
	return &ResourceHealthChecker{Client: c}
}

// Check evaluates the health of a resource by kind.
func (r *ResourceHealthChecker) Check(ctx context.Context, kind, name, namespace string) paprikav1.ResourceHealth {
	switch kind {
	case "Deployment":
		return r.checkDeployment(ctx, name, namespace)
	case "Service":
		return r.checkService(ctx, name, namespace)
	case "Ingress":
		return r.checkIngress(ctx, name, namespace)
	case "ConfigMap", "Secret":
		return paprikav1.ResourceHealth{Kind: kind, Name: name, Namespace: namespace, Health: "Healthy"}
	default:
		return paprikav1.ResourceHealth{Kind: kind, Name: name, Namespace: namespace, Health: "Unknown"}
	}
}

// checkDeployment evaluates the health of a Deployment.
func (r *ResourceHealthChecker) checkDeployment(ctx context.Context, name, namespace string) paprikav1.ResourceHealth {
	var dep appsv1.Deployment
	if err := r.Get(ctx, types.NamespacedName{Name: name, Namespace: namespace}, &dep); err != nil {
		return paprikav1.ResourceHealth{Kind: "Deployment", Name: name, Namespace: namespace, Health: "Missing", Message: err.Error()}
	}

	replicas := dep.Spec.Replicas
	if replicas == nil {
		replicas = int32Ptr(1)
	}
	available := dep.Status.AvailableReplicas
	updated := dep.Status.UpdatedReplicas

	if available < *replicas {
		return paprikav1.ResourceHealth{Kind: "Deployment", Name: name, Namespace: namespace, Health: "Progressing", Message: fmt.Sprintf("%d/%d replicas available", available, *replicas)}
	}
	if updated < *replicas {
		return paprikav1.ResourceHealth{Kind: "Deployment", Name: name, Namespace: namespace, Health: "Progressing", Message: fmt.Sprintf("%d/%d replicas updated", updated, *replicas)}
	}
	return paprikav1.ResourceHealth{Kind: "Deployment", Name: name, Namespace: namespace, Health: "Healthy", Message: fmt.Sprintf("%d/%d replicas ready", available, *replicas)}
}

// checkService evaluates the health of a Service.
func (r *ResourceHealthChecker) checkService(ctx context.Context, name, namespace string) paprikav1.ResourceHealth {
	var svc corev1.Service
	if err := r.Get(ctx, types.NamespacedName{Name: name, Namespace: namespace}, &svc); err != nil {
		return paprikav1.ResourceHealth{Kind: "Service", Name: name, Namespace: namespace, Health: "Missing", Message: err.Error()}
	}
	return paprikav1.ResourceHealth{Kind: "Service", Name: name, Namespace: namespace, Health: "Healthy", Message: "service exists"}
}

// checkIngress evaluates the health of an Ingress.
func (r *ResourceHealthChecker) checkIngress(ctx context.Context, name, namespace string) paprikav1.ResourceHealth {
	var ing netv1.Ingress
	if err := r.Get(ctx, types.NamespacedName{Name: name, Namespace: namespace}, &ing); err != nil {
		return paprikav1.ResourceHealth{Kind: "Ingress", Name: name, Namespace: namespace, Health: "Missing", Message: err.Error()}
	}
	return paprikav1.ResourceHealth{Kind: "Ingress", Name: name, Namespace: namespace, Health: "Healthy", Message: "ingress exists"}
}

// int32Ptr returns a pointer to an int32.
func int32Ptr(v int32) *int32 {
	return &v
}

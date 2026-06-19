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

package core

import (
	"context"
	"fmt"
	"net/http"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/manager"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
)

const (
	repositoryHealthCheckInterval = 5 * time.Minute
	repositoryHealthCheckTimeout  = 15 * time.Second
)

// RepositoryReconciler reconciles Repository objects, testing connectivity and
// updating the connection state on the status.
type RepositoryReconciler struct {
	client client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=core.paprika.io,resources=repositories,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.paprika.io,resources=repositories/status,verbs=get;update;patch

// Reconcile tests the connection state of the Repository and updates its status.
func (r *RepositoryReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var repo corev1alpha1.Repository
	if err := r.client.Get(ctx, req.NamespacedName, &repo); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, fmt.Errorf("get repository: %w", err)
	}

	logger := log.FromContext(ctx).WithValues("repository", repo.Name, "namespace", repo.Namespace)
	oldState := repo.Status.ConnectionState
	newState := r.testConnection(ctx, &repo)
	if !connectionStateEqual(oldState, newState) {
		repo.Status.ConnectionState = newState
		repo.Status.ObservedGeneration = repo.Generation
		if err := r.client.Status().Update(ctx, &repo); err != nil {
			return ctrl.Result{}, fmt.Errorf("update repository status: %w", err)
		}
		logger.Info("Updated repository connection state", "status", newState.Status, "message", newState.Message)
	}

	return ctrl.Result{RequeueAfter: repositoryHealthCheckInterval}, nil
}

// testConnection performs a lightweight reachability check on the repository.
func (r *RepositoryReconciler) testConnection(ctx context.Context, repo *corev1alpha1.Repository) *corev1alpha1.ConnectionState {
	state := &corev1alpha1.ConnectionState{
		AttemptedAt: &metav1.Time{Time: time.Now()},
	}
	switch repo.Spec.Type {
	case corev1alpha1.RepositoryTypeGit, corev1alpha1.RepositoryTypeHelm:
		if err := r.testHTTP(ctx, repo); err != nil {
			state.Status = corev1alpha1.ConnectionStatusFailed
			state.Message = err.Error()
			return state
		}
		state.Status = corev1alpha1.ConnectionStatusSuccessful
	case corev1alpha1.RepositoryTypeOCI:
		// OCI registries are validated on first pull; mark as unknown until used.
		state.Status = corev1alpha1.ConnectionStatusUnknown
		state.Message = "OCI connection state updated on first pull"
	default:
		state.Status = corev1alpha1.ConnectionStatusUnknown
		state.Message = fmt.Sprintf("unknown repository type %q", repo.Spec.Type)
	}
	return state
}

// testHTTP issues a HEAD/GET request to the repository URL to verify reachability.
func (r *RepositoryReconciler) testHTTP(ctx context.Context, repo *corev1alpha1.Repository) error {
	url := repo.Spec.URL
	if repo.Spec.Type == corev1alpha1.RepositoryTypeHelm {
		// Helm repos serve index.yaml at the root.
		url = trimSlash(url) + "/index.yaml"
	}
	client := &http.Client{Timeout: repositoryHealthCheckTimeout}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, http.NoBody)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	if repo.Spec.SecretRef != nil {
		username, password, credErr := r.loadBasicAuth(ctx, repo)
		if credErr != nil {
			return fmt.Errorf("load credentials: %w", credErr)
		}
		if username != "" {
			req.SetBasicAuth(username, password)
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("http request: %w", err)
	}
	defer func() {
		if cerr := resp.Body.Close(); cerr != nil {
			log.FromContext(ctx).Error(cerr, "Failed to close repository health-check response body")
		}
	}()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("repository returned status %d", resp.StatusCode)
	}
	return nil
}

// loadBasicAuth reads username/password from the referenced Secret.
func (r *RepositoryReconciler) loadBasicAuth(ctx context.Context, repo *corev1alpha1.Repository) (username, password string, err error) {
	var secret corev1.Secret
	if err = r.client.Get(ctx, client.ObjectKey{Name: repo.Spec.SecretRef.Name, Namespace: repo.Namespace}, &secret); err != nil {
		return "", "", fmt.Errorf("get secret: %w", err)
	}
	return string(secret.Data["username"]), string(secret.Data["password"]), nil
}

// connectionStateEqual reports whether two ConnectionState values are equivalent.
func connectionStateEqual(a, b *corev1alpha1.ConnectionState) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Status == b.Status && a.Message == b.Message
}

// SetupWithManager sets up the Repository controller with the Manager.
func (r *RepositoryReconciler) SetupWithManager(mgr ctrl.Manager) error {
	r.client = mgr.GetClient()
	if err := ctrl.NewControllerManagedBy(mgr).
		For(&corev1alpha1.Repository{}).
		Complete(r); err != nil {
		return fmt.Errorf("setup repository controller: %w", err)
	}
	return nil
}

// WatchSecretChange returns an event handler that triggers reconciliation when
// the Secret referenced by a Repository is updated.
func WatchSecretChange(mgr manager.Manager) handler.EventHandler {
	return handler.EnqueueRequestsFromMapFunc(func(ctx context.Context, obj client.Object) []reconcile.Request {
		secret, ok := obj.(*corev1.Secret)
		if !ok {
			return nil
		}
		var repos corev1alpha1.RepositoryList
		if err := mgr.GetClient().List(ctx, &repos,
			client.InNamespace(secret.Namespace),
			client.MatchingFieldsSelector{Selector: fields.OneTermEqualSelector("spec.secretRef.name", secret.Name)}); err != nil {
			log.FromContext(ctx).Error(err, "list repositories by secretRef")
			return nil
		}
		requests := make([]reconcile.Request, 0, len(repos.Items))
		for i := range repos.Items {
			requests = append(requests, reconcile.Request{
				NamespacedName: client.ObjectKeyFromObject(&repos.Items[i]),
			})
		}
		return requests
	})
}

// Ensure builder is used (avoids unused import if controller setup changes).

func trimSlash(s string) string {
	if s != "" && s[len(s)-1] == '/' {
		return s[:len(s)-1]
	}
	return s
}

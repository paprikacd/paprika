package admin

import (
	"context"
	"errors"
	"strings"
	"time"

	authenticationv1 "k8s.io/api/authentication/v1"
	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

const defaultKubernetesReviewTimeout = 5 * time.Second

var (
	ErrPodIdentityUnavailable = errors.New("admin pod identity unavailable")
	ErrKubernetesReviewFailed = errors.New("kubernetes identity review failed")
	ErrKubernetesAccessDenied = errors.New("kubernetes pod port-forward access denied")
)

type PodIdentity struct {
	Namespace          string
	Name               string
	UID                types.UID
	ServiceAccount     string
	ExpectedContainers []string
}

func (identity *PodIdentity) Validate() error {
	if identity == nil {
		return ErrPodIdentityUnavailable
	}
	if !completeIdentityValue(identity.Namespace) ||
		!completeIdentityValue(identity.Name) ||
		!completeIdentityValue(string(identity.UID)) ||
		!completeIdentityValue(identity.ServiceAccount) ||
		len(identity.ExpectedContainers) == 0 {
		return ErrPodIdentityUnavailable
	}
	containers := make(map[string]struct{}, len(identity.ExpectedContainers))
	for _, container := range identity.ExpectedContainers {
		if !completeIdentityValue(container) {
			return ErrPodIdentityUnavailable
		}
		if _, duplicate := containers[container]; duplicate {
			return ErrPodIdentityUnavailable
		}
		containers[container] = struct{}{}
	}
	return nil
}

type PodGetter interface {
	Get(
		ctx context.Context,
		namespace string,
		name string,
		options metav1.GetOptions,
	) (*corev1.Pod, error)
}

type TokenReviewer interface {
	Create(
		ctx context.Context,
		review *authenticationv1.TokenReview,
		options metav1.CreateOptions,
	) (*authenticationv1.TokenReview, error)
}

type SubjectAccessReviewer interface {
	Create(
		ctx context.Context,
		review *authorizationv1.SubjectAccessReview,
		options metav1.CreateOptions,
	) (*authorizationv1.SubjectAccessReview, error)
}

type KubernetesReview struct {
	Identity             PodIdentity
	Pods                 PodGetter
	TokenReviews         TokenReviewer
	SubjectAccessReviews SubjectAccessReviewer
	Timeout              time.Duration
}

func (review *KubernetesReview) Verify(
	ctx context.Context,
	bearer string,
) (ReviewedIdentity, error) {
	if err := review.validateConfiguration(); err != nil {
		return ReviewedIdentity{}, err
	}
	timeout := review.Timeout
	if timeout <= 0 {
		timeout = defaultKubernetesReviewTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	if err := review.verifyPod(ctx); err != nil {
		return ReviewedIdentity{}, err
	}
	identity, err := review.reviewToken(ctx, bearer)
	if err != nil {
		return ReviewedIdentity{}, err
	}
	if err := review.reviewPortForwardAccess(ctx, identity); err != nil {
		return ReviewedIdentity{}, err
	}
	return identity, nil
}

func (review *KubernetesReview) validateConfiguration() error {
	if review == nil || review.Identity.Validate() != nil || review.Pods == nil {
		return ErrPodIdentityUnavailable
	}
	if review.TokenReviews == nil || review.SubjectAccessReviews == nil {
		return ErrKubernetesReviewFailed
	}
	return nil
}

func (review *KubernetesReview) verifyPod(ctx context.Context) error {
	pod, err := review.Pods.Get(
		ctx,
		review.Identity.Namespace,
		review.Identity.Name,
		metav1.GetOptions{},
	)
	if err != nil || !review.Identity.matches(pod) {
		return ErrPodIdentityUnavailable
	}
	return nil
}

func (review *KubernetesReview) reviewToken(
	ctx context.Context,
	bearer string,
) (ReviewedIdentity, error) {
	if bearer == "" {
		return ReviewedIdentity{}, ErrKubernetesReviewFailed
	}
	tokenReview, err := review.TokenReviews.Create(
		ctx,
		&authenticationv1.TokenReview{
			Spec: authenticationv1.TokenReviewSpec{Token: bearer},
		},
		metav1.CreateOptions{},
	)
	if err != nil || tokenReview == nil ||
		!tokenReview.Status.Authenticated ||
		!completeIdentityValue(tokenReview.Status.User.Username) ||
		tokenReview.Status.Error != "" {
		return ReviewedIdentity{}, ErrKubernetesReviewFailed
	}
	if tokenReview.Status.User.Username == review.Identity.serviceAccountUsername() {
		return ReviewedIdentity{}, ErrKubernetesReviewFailed
	}
	return reviewedTokenIdentity(tokenReview.Status.User), nil
}

func (review *KubernetesReview) reviewPortForwardAccess(
	ctx context.Context,
	identity ReviewedIdentity,
) error {
	accessReview, err := review.SubjectAccessReviews.Create(
		ctx,
		&authorizationv1.SubjectAccessReview{
			Spec: authorizationv1.SubjectAccessReviewSpec{
				User:   identity.Username,
				Groups: append([]string(nil), identity.Groups...),
				Extra:  authorizationExtras(identity.Extra),
				ResourceAttributes: &authorizationv1.ResourceAttributes{
					Namespace:   review.Identity.Namespace,
					Verb:        "create",
					Group:       "",
					Resource:    "pods",
					Subresource: "portforward",
					Name:        review.Identity.Name,
				},
			},
		},
		metav1.CreateOptions{},
	)
	if err != nil || accessReview == nil ||
		!accessReview.Status.Allowed || accessReview.Status.Denied ||
		accessReview.Status.EvaluationError != "" {
		return ErrKubernetesAccessDenied
	}
	return nil
}

func (identity *PodIdentity) matches(pod *corev1.Pod) bool {
	if pod == nil || pod.Namespace != identity.Namespace || pod.Name != identity.Name ||
		pod.UID != identity.UID || pod.Spec.ServiceAccountName != identity.ServiceAccount ||
		pod.DeletionTimestamp != nil || len(pod.Spec.Containers) != len(identity.ExpectedContainers) ||
		hasUnreviewedLongLivedContainer(pod) {
		return false
	}
	return identity.matchesContainers(pod.Spec.Containers)
}

func hasUnreviewedLongLivedContainer(pod *corev1.Pod) bool {
	if len(pod.Spec.EphemeralContainers) != 0 {
		return true
	}
	for index := range pod.Spec.InitContainers {
		restartPolicy := pod.Spec.InitContainers[index].RestartPolicy
		if restartPolicy != nil && *restartPolicy == corev1.ContainerRestartPolicyAlways {
			return true
		}
	}
	return false
}

func (identity *PodIdentity) matchesContainers(containers []corev1.Container) bool {
	expected := make(map[string]struct{}, len(identity.ExpectedContainers))
	for _, container := range identity.ExpectedContainers {
		expected[container] = struct{}{}
	}
	seen := make(map[string]struct{}, len(containers))
	for index := range containers {
		name := containers[index].Name
		if _, allowed := expected[name]; !allowed {
			return false
		}
		if _, duplicate := seen[name]; duplicate {
			return false
		}
		seen[name] = struct{}{}
	}
	return len(seen) == len(expected)
}

func (identity *PodIdentity) serviceAccountUsername() string {
	return "system:serviceaccount:" + identity.Namespace + ":" + identity.ServiceAccount
}

func completeIdentityValue(value string) bool {
	return value != "" && strings.TrimSpace(value) == value
}

func reviewedTokenIdentity(user authenticationv1.UserInfo) ReviewedIdentity {
	identity := ReviewedIdentity{
		Username: user.Username,
		Groups:   append([]string(nil), user.Groups...),
	}
	if user.Extra != nil {
		identity.Extra = make(map[string][]string, len(user.Extra))
		for key, values := range user.Extra {
			identity.Extra[key] = append([]string(nil), values...)
		}
	}
	return identity
}

func authorizationExtras(extra map[string][]string) map[string]authorizationv1.ExtraValue {
	if extra == nil {
		return nil
	}
	converted := make(map[string]authorizationv1.ExtraValue, len(extra))
	for key, values := range extra {
		converted[key] = append(authorizationv1.ExtraValue(nil), values...)
	}
	return converted
}

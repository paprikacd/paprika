package admin

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	authenticationv1 "k8s.io/api/authentication/v1"
	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakePodGetter struct {
	mu    sync.Mutex
	pod   *corev1.Pod
	err   error
	calls int
	order *[]string
}

func (fake *fakePodGetter) Get(
	_ context.Context,
	namespace string,
	name string,
	_ metav1.GetOptions,
) (*corev1.Pod, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.calls++
	if fake.order != nil {
		*fake.order = append(*fake.order, "pod:"+namespace+"/"+name)
	}
	if fake.err != nil {
		return nil, fake.err
	}
	return fake.pod.DeepCopy(), nil
}

type fakeTokenReviewer struct {
	mu       sync.Mutex
	response *authenticationv1.TokenReview
	err      error
	calls    int
	request  *authenticationv1.TokenReview
	order    *[]string
	block    bool
}

func (fake *fakeTokenReviewer) Create(
	ctx context.Context,
	review *authenticationv1.TokenReview,
	_ metav1.CreateOptions,
) (*authenticationv1.TokenReview, error) {
	fake.mu.Lock()
	fake.calls++
	fake.request = review.DeepCopy()
	if fake.order != nil {
		*fake.order = append(*fake.order, "token-review")
	}
	block := fake.block
	response := fake.response
	err := fake.err
	fake.mu.Unlock()
	if block {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if err != nil {
		return nil, err
	}
	return response.DeepCopy(), nil
}

type fakeSubjectAccessReviewer struct {
	mu       sync.Mutex
	response *authorizationv1.SubjectAccessReview
	err      error
	calls    int
	request  *authorizationv1.SubjectAccessReview
	order    *[]string
}

func (fake *fakeSubjectAccessReviewer) Create(
	_ context.Context,
	review *authorizationv1.SubjectAccessReview,
	_ metav1.CreateOptions,
) (*authorizationv1.SubjectAccessReview, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.calls++
	fake.request = review.DeepCopy()
	if fake.order != nil {
		*fake.order = append(*fake.order, "subject-access-review")
	}
	if fake.err != nil {
		return nil, fake.err
	}
	return fake.response.DeepCopy(), nil
}

func validPodIdentity() PodIdentity {
	return PodIdentity{
		Namespace:          "paprika-system",
		Name:               "paprika-api-0",
		UID:                types.UID("pod-uid-123"),
		ServiceAccount:     "paprika-admin-reviewer",
		ExpectedContainers: []string{"api"},
	}
}

func validAdminPod() *corev1.Pod {
	identity := validPodIdentity()
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: identity.Namespace,
			Name:      identity.Name,
			UID:       identity.UID,
		},
		Spec: corev1.PodSpec{
			ServiceAccountName: identity.ServiceAccount,
			Containers: []corev1.Container{
				{Name: "api"},
			},
		},
	}
}

func authenticatedTokenReview(username string) *authenticationv1.TokenReview {
	return &authenticationv1.TokenReview{
		Status: authenticationv1.TokenReviewStatus{
			Authenticated: true,
			User: authenticationv1.UserInfo{
				Username: username,
				Groups:   []string{"platform-admins", "system:authenticated"},
				Extra: map[string]authenticationv1.ExtraValue{
					"authentication.kubernetes.io/credential-id": {"exec:omega"},
					"oidc.example.com/team":                      {"delivery", "platform"},
				},
			},
		},
	}
}

func allowedSubjectAccessReview() *authorizationv1.SubjectAccessReview {
	return &authorizationv1.SubjectAccessReview{
		Status: authorizationv1.SubjectAccessReviewStatus{Allowed: true},
	}
}

func validKubernetesReview() (*KubernetesReview, *fakePodGetter, *fakeTokenReviewer, *fakeSubjectAccessReviewer) {
	pods := &fakePodGetter{pod: validAdminPod()}
	tokens := &fakeTokenReviewer{response: authenticatedTokenReview("alice@example.com")}
	access := &fakeSubjectAccessReviewer{response: allowedSubjectAccessReview()}
	review := &KubernetesReview{
		Identity:             validPodIdentity(),
		Pods:                 pods,
		TokenReviews:         tokens,
		SubjectAccessReviews: access,
		Timeout:              time.Second,
	}
	return review, pods, tokens, access
}

func TestPodIdentityRequiresCompleteUniqueConfiguration(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		mutate func(*PodIdentity)
	}{
		{name: "namespace", mutate: func(identity *PodIdentity) { identity.Namespace = "" }},
		{name: "name", mutate: func(identity *PodIdentity) { identity.Name = "" }},
		{name: "UID", mutate: func(identity *PodIdentity) { identity.UID = "" }},
		{name: "service account", mutate: func(identity *PodIdentity) { identity.ServiceAccount = "" }},
		{name: "container allowlist", mutate: func(identity *PodIdentity) { identity.ExpectedContainers = nil }},
		{name: "empty container", mutate: func(identity *PodIdentity) { identity.ExpectedContainers = []string{""} }},
		{name: "duplicate container", mutate: func(identity *PodIdentity) {
			identity.ExpectedContainers = []string{"api", "api"}
		}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			identity := validPodIdentity()
			test.mutate(&identity)
			require.ErrorIs(t, identity.Validate(), ErrPodIdentityUnavailable)
		})
	}
	valid := validPodIdentity()
	require.NoError(t, valid.Validate())
}

func TestKubernetesReviewChecksPodBeforePresentedCredential(t *testing.T) {
	t.Parallel()

	order := []string{}
	review, pods, tokens, access := validKubernetesReview()
	pods.order = &order
	tokens.order = &order
	access.order = &order

	identity, err := review.Verify(context.Background(), "presented-bearer")
	require.NoError(t, err)
	assert.Equal(t, []string{
		"pod:paprika-system/paprika-api-0",
		"token-review",
		"subject-access-review",
	}, order)
	assert.Equal(t, ReviewedIdentity{
		Username: "alice@example.com",
		Groups:   []string{"platform-admins", "system:authenticated"},
		Extra: map[string][]string{
			"authentication.kubernetes.io/credential-id": {"exec:omega"},
			"oidc.example.com/team":                      {"delivery", "platform"},
		},
	}, identity)
	assert.Equal(t, "presented-bearer", tokens.request.Spec.Token)

	attributes := access.request.Spec.ResourceAttributes
	require.NotNil(t, attributes)
	assert.Equal(t, "create", attributes.Verb)
	assert.Empty(t, attributes.Group)
	assert.Equal(t, "pods", attributes.Resource)
	assert.Equal(t, "portforward", attributes.Subresource)
	assert.Equal(t, "paprika-system", attributes.Namespace)
	assert.Equal(t, "paprika-api-0", attributes.Name)
	assert.Equal(t, "alice@example.com", access.request.Spec.User)
	assert.Equal(t, []string{"platform-admins", "system:authenticated"}, access.request.Spec.Groups)
	assert.Equal(t, authorizationv1.ExtraValue{"exec:omega"},
		access.request.Spec.Extra["authentication.kubernetes.io/credential-id"])
	assert.Equal(t, authorizationv1.ExtraValue{"delivery", "platform"},
		access.request.Spec.Extra["oidc.example.com/team"])
}

func TestKubernetesReviewRejectsIncompleteIdentityBeforeAPICalls(t *testing.T) {
	t.Parallel()

	review, pods, tokens, access := validKubernetesReview()
	review.Identity.UID = ""

	_, err := review.Verify(context.Background(), "presented-bearer")
	require.ErrorIs(t, err, ErrPodIdentityUnavailable)
	assert.Zero(t, pods.calls)
	assert.Zero(t, tokens.calls)
	assert.Zero(t, access.calls)
}

func TestKubernetesReviewRejectsIneligibleLivePod(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		mutate func(*corev1.Pod)
	}{
		{name: "UID mismatch", mutate: func(pod *corev1.Pod) { pod.UID = "different" }},
		{name: "service account mismatch", mutate: func(pod *corev1.Pod) {
			pod.Spec.ServiceAccountName = "different"
		}},
		{name: "injected sidecar", mutate: func(pod *corev1.Pod) {
			pod.Spec.Containers = append(pod.Spec.Containers, corev1.Container{Name: "injected"})
		}},
		{name: "missing expected container", mutate: func(pod *corev1.Pod) {
			pod.Spec.Containers = nil
		}},
		{name: "duplicate regular container", mutate: func(pod *corev1.Pod) {
			pod.Spec.Containers = append(pod.Spec.Containers, corev1.Container{Name: "api"})
		}},
		{name: "native sidecar", mutate: func(pod *corev1.Pod) {
			always := corev1.ContainerRestartPolicyAlways
			pod.Spec.InitContainers = []corev1.Container{{Name: "injected", RestartPolicy: &always}}
		}},
		{name: "ephemeral debug container", mutate: func(pod *corev1.Pod) {
			pod.Spec.EphemeralContainers = []corev1.EphemeralContainer{{
				EphemeralContainerCommon: corev1.EphemeralContainerCommon{Name: "debugger"},
			}}
		}},
		{name: "terminating pod", mutate: func(pod *corev1.Pod) {
			now := metav1.Now()
			pod.DeletionTimestamp = &now
		}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			review, pods, tokens, access := validKubernetesReview()
			test.mutate(pods.pod)

			_, err := review.Verify(context.Background(), "presented-bearer")
			require.ErrorIs(t, err, ErrPodIdentityUnavailable)
			assert.Equal(t, 1, pods.calls)
			assert.Zero(t, tokens.calls)
			assert.Zero(t, access.calls)
		})
	}
}

func TestKubernetesReviewRejectsUnauthenticatedEmptyAndOwnServiceAccount(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		response *authenticationv1.TokenReview
	}{
		{name: "unauthenticated", response: &authenticationv1.TokenReview{}},
		{name: "empty username", response: authenticatedTokenReview("")},
		{name: "whitespace username", response: authenticatedTokenReview(" ")},
		{name: "indeterminate error", response: func() *authenticationv1.TokenReview {
			response := authenticatedTokenReview("alice@example.com")
			response.Status.Error = "authenticator unavailable"
			return response
		}()},
		{
			name: "Paprika service account",
			response: authenticatedTokenReview(
				"system:serviceaccount:paprika-system:paprika-admin-reviewer",
			),
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			review, _, tokens, access := validKubernetesReview()
			tokens.response = test.response

			_, err := review.Verify(context.Background(), "presented-bearer")
			require.ErrorIs(t, err, ErrKubernetesReviewFailed)
			assert.Zero(t, access.calls)
		})
	}
}

func TestKubernetesReviewFailsClosedOnAPIErrorDenialAndIndeterminateReview(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		mutate func(*KubernetesReview, *fakePodGetter, *fakeTokenReviewer, *fakeSubjectAccessReviewer)
		want   error
	}{
		{
			name: "Pod API error",
			mutate: func(_ *KubernetesReview, pods *fakePodGetter, _ *fakeTokenReviewer, _ *fakeSubjectAccessReviewer) {
				pods.err = errors.New("pod API unavailable")
			},
			want: ErrPodIdentityUnavailable,
		},
		{
			name: "TokenReview API error",
			mutate: func(_ *KubernetesReview, _ *fakePodGetter, tokens *fakeTokenReviewer, _ *fakeSubjectAccessReviewer) {
				tokens.err = errors.New("review unavailable")
			},
			want: ErrKubernetesReviewFailed,
		},
		{
			name: "SubjectAccessReview API error",
			mutate: func(_ *KubernetesReview, _ *fakePodGetter, _ *fakeTokenReviewer, access *fakeSubjectAccessReviewer) {
				access.err = errors.New("review unavailable")
			},
			want: ErrKubernetesAccessDenied,
		},
		{
			name: "denied",
			mutate: func(_ *KubernetesReview, _ *fakePodGetter, _ *fakeTokenReviewer, access *fakeSubjectAccessReviewer) {
				access.response.Status = authorizationv1.SubjectAccessReviewStatus{Denied: true, Reason: "no"}
			},
			want: ErrKubernetesAccessDenied,
		},
		{
			name: "indeterminate",
			mutate: func(_ *KubernetesReview, _ *fakePodGetter, _ *fakeTokenReviewer, access *fakeSubjectAccessReviewer) {
				access.response.Status = authorizationv1.SubjectAccessReviewStatus{
					Allowed:         true,
					EvaluationError: "authorizer unavailable",
				}
			},
			want: ErrKubernetesAccessDenied,
		},
		{
			name: "timeout",
			mutate: func(review *KubernetesReview, _ *fakePodGetter, tokens *fakeTokenReviewer, _ *fakeSubjectAccessReviewer) {
				review.Timeout = 10 * time.Millisecond
				tokens.block = true
			},
			want: ErrKubernetesReviewFailed,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			review, pods, tokens, access := validKubernetesReview()
			test.mutate(review, pods, tokens, access)

			_, err := review.Verify(context.Background(), "presented-bearer")
			require.ErrorIs(t, err, test.want)
		})
	}
}

func TestKubernetesReviewNeverExposesPresentedBearer(t *testing.T) {
	t.Parallel()

	presented := "must-not-escape-" + t.Name()
	review, pods, tokens, access := validKubernetesReview()
	failures := []func(){
		func() { pods.err = fmt.Errorf("pod failure containing %s", presented) },
		func() { tokens.err = fmt.Errorf("token failure containing %s", presented) },
		func() { access.err = fmt.Errorf("access failure containing %s", presented) },
	}

	for index, fail := range failures {
		pods.err = nil
		tokens.err = nil
		access.err = nil
		fail()
		_, err := review.Verify(context.Background(), presented)
		require.Error(t, err, "failure %d", index)
		assert.False(t, strings.Contains(err.Error(), presented))
		assert.NotContains(t, fmt.Sprintf("%+v", err), presented)
	}
}

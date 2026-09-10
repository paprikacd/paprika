package dataprovider

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

func node(name, cpu, memory string) *corev1.Node {
	return &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Status: corev1.NodeStatus{
			Allocatable: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse(cpu),
				corev1.ResourceMemory: resource.MustParse(memory),
			},
		},
	}
}

func scheduledPod(name, nodeName, cpu, memory string) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
		Spec: corev1.PodSpec{
			NodeName: nodeName,
			Containers: []corev1.Container{
				{
					Name: name,
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceCPU:    resource.MustParse(cpu),
							corev1.ResourceMemory: resource.MustParse(memory),
						},
					},
				},
			},
		},
		Status: corev1.PodStatus{Phase: corev1.PodRunning},
	}
}

func pendingPod(name, cpu, memory string) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name: name,
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceCPU:    resource.MustParse(cpu),
							corev1.ResourceMemory: resource.MustParse(memory),
						},
					},
				},
			},
		},
		Status: corev1.PodStatus{Phase: corev1.PodPending},
	}
}

func scheduledPodNoRequests(name, nodeName string) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
		Spec: corev1.PodSpec{
			NodeName:   nodeName,
			Containers: []corev1.Container{{Name: name}},
		},
		Status: corev1.PodStatus{Phase: corev1.PodRunning},
	}
}

// terminalPod returns a pod scheduled onto nodeName but that has already
// exited, so it must not count toward Requested even though NodeName is set.
func terminalPod(name, nodeName, cpu, memory string, phase corev1.PodPhase) *corev1.Pod {
	pod := scheduledPod(name, nodeName, cpu, memory)
	pod.Status.Phase = phase
	return pod
}

func TestKubernetesCapacityDescriptorAdvertisesOnlyRequestedAndAllocatable(t *testing.T) {
	t.Parallel()
	src := newKubernetesCapacityWithClientset(fake.NewSimpleClientset())
	d := src.Descriptor()

	require.Equal(t, "KubernetesCapacity", d.Name)
	require.Equal(t, []Field{FieldRequested, FieldAllocatable}, d.Supplies)
	require.False(t, d.NeedsEgress)
	require.False(t, d.CanSupply(FieldUsed), "this provider cannot measure usage and must not claim to")
}

func TestKubernetesCapacitySumsAllocatableAndRequested(t *testing.T) {
	t.Parallel()
	clientset := fake.NewSimpleClientset(
		node("node-a", "4", "8Gi"),
		node("node-b", "2", "4Gi"),
		scheduledPod("web", "node-a", "500m", "1Gi"),
		scheduledPod("api", "node-b", "250m", "512Mi"),
	)
	src := newKubernetesCapacityWithClientset(clientset)

	got, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.NoError(t, err)

	require.Equal(t, StateOK, got.CPUMillicores.Allocatable.State)
	require.InDelta(t, 6000, got.CPUMillicores.Allocatable.Value, 0.001)
	require.InDelta(t, 750, got.CPUMillicores.Requested.Value, 0.001)

	// This implementation cannot measure usage; it must say so rather than
	// report a zero that reads as "nothing is running".
	require.Equal(t, StateNotConfigured, got.CPUMillicores.Used.State)
	require.Zero(t, got.CPUMillicores.Used.Value)
	require.NotEmpty(t, got.CPUMillicores.Used.Reason)
}

func TestKubernetesCapacitySumsMemory(t *testing.T) {
	t.Parallel()
	clientset := fake.NewSimpleClientset(
		node("node-a", "4", "8Gi"),
		node("node-b", "2", "4Gi"),
		scheduledPod("web", "node-a", "500m", "1Gi"),
		scheduledPod("api", "node-b", "250m", "512Mi"),
	)
	src := newKubernetesCapacityWithClientset(clientset)

	got, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.NoError(t, err)

	const gibibyte = 1024 * 1024 * 1024
	require.Equal(t, StateOK, got.MemoryBytes.Allocatable.State)
	require.InDelta(t, 12*gibibyte, got.MemoryBytes.Allocatable.Value, 0.001)
	require.InDelta(t, 1.5*gibibyte, got.MemoryBytes.Requested.Value, 0.001)
	require.Equal(t, StateNotConfigured, got.MemoryBytes.Used.State)
	require.Zero(t, got.MemoryBytes.Used.Value)
}

func TestKubernetesCapacityIgnoresUnscheduledPods(t *testing.T) {
	t.Parallel()
	clientset := fake.NewSimpleClientset(
		node("node-a", "4", "8Gi"),
		pendingPod("waiting", "1", "1Gi"), // no nodeName: not consuming anything
	)
	src := newKubernetesCapacityWithClientset(clientset)
	got, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.NoError(t, err)
	require.Zero(t, got.CPUMillicores.Requested.Value)
}

func TestKubernetesCapacityIgnoresTerminalPods(t *testing.T) {
	t.Parallel()
	clientset := fake.NewSimpleClientset(
		node("node-a", "4", "8Gi"),
		terminalPod("done", "node-a", "1", "1Gi", corev1.PodSucceeded),
		terminalPod("crashed", "node-a", "1", "1Gi", corev1.PodFailed),
	)
	src := newKubernetesCapacityWithClientset(clientset)
	got, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.NoError(t, err)
	require.Zero(t, got.CPUMillicores.Requested.Value, "a pod that has exited has released whatever it was using")
}

func TestKubernetesCapacityToleratesPodsWithoutRequests(t *testing.T) {
	t.Parallel()
	clientset := fake.NewSimpleClientset(
		node("node-a", "4", "8Gi"),
		scheduledPodNoRequests("best-effort", "node-a"),
	)
	src := newKubernetesCapacityWithClientset(clientset)
	got, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.NoError(t, err)
	require.Zero(t, got.CPUMillicores.Requested.Value)
	require.Equal(t, StateOK, got.CPUMillicores.Requested.State)
}

func TestKubernetesCapacityScopesRequestedToNamespace(t *testing.T) {
	t.Parallel()
	inScope := scheduledPod("web", "node-a", "500m", "1Gi")
	inScope.Namespace = "team-a"
	outOfScope := scheduledPod("api", "node-a", "250m", "512Mi")
	outOfScope.Namespace = "team-b"

	clientset := fake.NewSimpleClientset(
		node("node-a", "4", "8Gi"),
		inScope,
		outOfScope,
	)
	src := newKubernetesCapacityWithClientset(clientset)

	got, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod", Namespace: "team-a"})
	require.NoError(t, err)
	require.InDelta(t, 500, got.CPUMillicores.Requested.Value, 0.001)
}

func TestKubernetesCapacityValidateConfigAcceptsEmpty(t *testing.T) {
	t.Parallel()
	src := newKubernetesCapacityWithClientset(fake.NewSimpleClientset())

	require.NoError(t, src.ValidateConfig(nil))
	require.NoError(t, src.ValidateConfig([]byte("")))
	require.NoError(t, src.ValidateConfig([]byte("null")))
	require.NoError(t, src.ValidateConfig([]byte("{}")))
	require.NoError(t, src.ValidateConfig([]byte("  {}  ")))
}

func TestKubernetesCapacityValidateConfigRejectsNonEmpty(t *testing.T) {
	t.Parallel()
	src := newKubernetesCapacityWithClientset(fake.NewSimpleClientset())

	err := src.ValidateConfig([]byte(`{"apiKey":"super-secret-value"}`))
	require.Error(t, err)
	require.ErrorContains(t, err, "apiKey")
	require.NotContains(t, err.Error(), "super-secret-value",
		"the error must never echo a config value, only key names")
}

func TestKubernetesCapacityValidateConfigRejectsNonObjectPayload(t *testing.T) {
	t.Parallel()
	src := newKubernetesCapacityWithClientset(fake.NewSimpleClientset())

	err := src.ValidateConfig([]byte(`"super-secret-value"`))
	require.Error(t, err)
	require.NotContains(t, err.Error(), "super-secret-value")
}

// clientAlwaysContinuing returns a fake clientset whose node list always
// hands back the exact same non-empty Continue token, forever — the
// misbehaving-server case pageThroughList must refuse to loop against
// rather than spinning and inflating the sum without bound.
func clientAlwaysContinuing() *fake.Clientset {
	clientset := fake.NewSimpleClientset(node("node-a", "4", "8Gi"))
	clientset.PrependReactor("list", "nodes", func(_ k8stesting.Action) (bool, runtime.Object, error) {
		list := &corev1.NodeList{
			ListMeta: metav1.ListMeta{Continue: "same-token-forever"},
			Items:    []corev1.Node{*node("node-a", "4", "8Gi")},
		}
		return true, list, nil
	})
	return clientset
}

// clientNeverStopsPaginatingPods returns a fake clientset whose pod list
// always hands back a fresh, never-repeating Continue token, so the only
// thing that can stop pageThroughList is the page cap, not the
// repeated-token guard.
func clientNeverStopsPaginatingPods() *fake.Clientset {
	clientset := fake.NewSimpleClientset(node("node-a", "4", "8Gi"))
	page := 0
	clientset.PrependReactor("list", "pods", func(_ k8stesting.Action) (bool, runtime.Object, error) {
		page++
		list := &corev1.PodList{
			ListMeta: metav1.ListMeta{Continue: fmt.Sprintf("token-%d", page)},
			Items:    []corev1.Pod{*scheduledPod(fmt.Sprintf("pod-%d", page), "node-a", "10m", "10Mi")},
		}
		return true, list, nil
	})
	return clientset
}

// clientWithTwoPagesOfPods returns a fake clientset whose pod list splits a
// two-pod result across two pages, so a correct implementation must follow
// Continue exactly once to see both pods.
func clientWithTwoPagesOfPods() *fake.Clientset {
	clientset := fake.NewSimpleClientset(node("node-a", "4", "8Gi"))
	page := 0
	clientset.PrependReactor("list", "pods", func(_ k8stesting.Action) (bool, runtime.Object, error) {
		page++
		if page == 1 {
			list := &corev1.PodList{
				ListMeta: metav1.ListMeta{Continue: "page-2"},
				Items:    []corev1.Pod{*scheduledPod("web", "node-a", "500m", "1Gi")},
			}
			return true, list, nil
		}
		list := &corev1.PodList{
			ListMeta: metav1.ListMeta{Continue: ""},
			Items:    []corev1.Pod{*scheduledPod("api", "node-a", "250m", "512Mi")},
		}
		return true, list, nil
	})
	return clientset
}

func TestKubernetesCapacityErrorsRatherThanSpinsOnRepeatingContinueToken(t *testing.T) {
	t.Parallel()
	src := newKubernetesCapacityWithClientset(clientAlwaysContinuing())

	// No test timeout is needed: the repeated-token guard must catch this on
	// the second page, long before any page-count cap would.
	_, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.Error(t, err)
}

func TestKubernetesCapacityErrorsRatherThanLoopsForeverOnEndlessFreshTokens(t *testing.T) {
	t.Parallel()
	src := newKubernetesCapacityWithClientset(clientNeverStopsPaginatingPods())

	_, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.Error(t, err, "a server that never empties Continue must hit the page cap, not loop forever")
}

func TestKubernetesCapacityFollowsMultiPagePodList(t *testing.T) {
	t.Parallel()
	src := newKubernetesCapacityWithClientset(clientWithTwoPagesOfPods())

	got, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.NoError(t, err, "normal two-page pagination must still complete and sum correctly")
	require.InDelta(t, 750, got.CPUMillicores.Requested.Value, 0.001)
}

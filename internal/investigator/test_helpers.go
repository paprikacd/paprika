package investigator

import (
	appsv1 "k8s.io/api/apps/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

// runtimeToUnstructured converts a typed K8s object into its Unstructured
// representation so detector tests can roundtrip through fromUnstructured.
// `kind`/`apiVersion` are re-applied after conversion because
// DefaultUnstructuredConverter strips TypeMeta.
func runtimeToUnstructured(obj runtime.Object) (*unstructured.Unstructured, error) {
	u, err := runtime.DefaultUnstructuredConverter.ToUnstructured(obj)
	if err != nil {
		return nil, err
	}
	out := &unstructured.Unstructured{Object: u}
	gvks := obj.GetObjectKind().GroupVersionKind()
	if gvks.Kind != "" {
		out.SetKind(gvks.Kind)
		out.SetAPIVersion(gvks.GroupVersion().String())
	}
	return out, nil
}

// appsv1Deployment builds a synthetic Deployment with the given replicas.
func appsv1Deployment(name, ns string, replicas *int32, ready int32) appsv1.Deployment {
	return appsv1.Deployment{
		TypeMeta: metav1.TypeMeta{Kind: "Deployment", APIVersion: "apps/v1"},
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec:       appsv1.DeploymentSpec{Replicas: replicas},
		Status: appsv1.DeploymentStatus{
			Replicas:      func() int32 { if replicas != nil { return *replicas }; return 0 }(),
			ReadyReplicas: ready,
		},
	}
}

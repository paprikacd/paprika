// +kubebuilder:object:generate=true
package v1alpha1

import (
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"
)

var SchemeGroupVersion = schema.GroupVersion{Group: "featureflags.paprika.io", Version: "v1alpha1"}

var (
	SchemeBuilder = &scheme.Builder{GroupVersion: SchemeGroupVersion}
	AddToScheme   = SchemeBuilder.AddToScheme
)

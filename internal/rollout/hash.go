package rollout

import (
	corev1 "k8s.io/api/core/v1"

	"github.com/benebsworth/paprika/internal/rollout/hash"
)

// HashTemplate returns a deterministic short hash of a PodTemplateSpec.
func HashTemplate(tmpl corev1.PodTemplateSpec) string {
	return hash.Template(tmpl)
}

// RevisionHash returns a short hash of a revision name.
func RevisionHash(name string) string {
	return hash.Revision(name)
}

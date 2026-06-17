// Package hash provides template hashing utilities for rollout strategies.
package hash

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"

	corev1 "k8s.io/api/core/v1"
)

// Template returns a deterministic short hash of a PodTemplateSpec.
func Template(tmpl *corev1.PodTemplateSpec) string {
	data, err := json.Marshal(tmpl)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])[:10]
}

// Revision returns a short hash of a revision name.
func Revision(name string) string {
	sum := sha256.Sum256([]byte(name))
	return hex.EncodeToString(sum[:])[:10]
}

// SortedKeys returns the keys of a string map in sorted order.
func SortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

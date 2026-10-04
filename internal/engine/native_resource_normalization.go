package engine

import "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

// PriorityClass serializes globalDefault with omitempty: an absent value means
// false. Normalize both copies so a live true value still reports drift.
func normalizePriorityClassDefaults(obj unstructured.Unstructured) unstructured.Unstructured {
	normalized := obj.DeepCopy()
	if _, present := normalized.Object["globalDefault"]; !present {
		normalized.Object["globalDefault"] = false
	}
	return *normalized
}

// API storage canonicalizes ResourceQuota quantities just as it does container
// requests. Compare quantity values, without normalizing unrelated CRD fields.
func normalizeQuotaQuantities(obj unstructured.Unstructured) unstructured.Unstructured {
	normalized := obj.DeepCopy()
	hard, found, err := unstructured.NestedMap(normalized.Object, "spec", "hard")
	if err != nil || !found {
		return obj
	}
	for key, value := range hard {
		if quantity, ok := parseQuantity(value); ok {
			hard[key] = quantity.String()
		}
	}
	// NestedMap was successfully read from this path; setting the same type
	// cannot fail unless the object is concurrently mutated (this is a copy).
	if err := unstructured.SetNestedMap(normalized.Object, hard, "spec", "hard"); err != nil {
		return obj
	}
	return *normalized
}

// NetworkPolicy omits empty rule lists in API responses. An empty desired list
// still means no rules: a live nonempty list must remain visible as drift.
func normalizeEmptyNetworkPolicyRules(desired, live unstructured.Unstructured) (normalized unstructured.Unstructured, equal bool) {
	normalizedObject := desired.DeepCopy()
	for _, field := range []string{"ingress", "egress"} {
		dRules, _, dErr := unstructured.NestedSlice(desired.Object, "spec", field)
		lRules, _, lErr := unstructured.NestedSlice(live.Object, "spec", field)
		if dErr != nil || lErr != nil {
			return desired, false
		}
		if len(dRules) == 0 {
			if len(lRules) != 0 {
				return desired, false
			}
			unstructured.RemoveNestedField(normalizedObject.Object, "spec", field)
		}
	}
	return *normalizedObject, true
}

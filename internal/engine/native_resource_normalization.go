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

// NetworkPolicy omits empty rule lists in API responses, and the API server
// drops null fields. A null, absent, or empty spec.ingress or spec.egress list
// therefore means the same thing: no rules of that kind. With the matching
// entry in policyTypes, that denies all traffic of that kind. A live nonempty
// list must remain visible as drift, because an empty desired list denies the
// traffic that the live rules allow.
func normalizeEmptyNetworkPolicyRules(desired, live unstructured.Unstructured) (normalized unstructured.Unstructured, equal bool) {
	normalizedObject := desired.DeepCopy()
	for _, field := range []string{"ingress", "egress"} {
		dRules, dOK := networkPolicyRuleList(desired, field)
		lRules, lOK := networkPolicyRuleList(live, field)
		if !dOK || !lOK {
			return desired, false
		}
		if len(dRules) == 0 {
			if len(lRules) != 0 {
				return desired, false
			}
			unstructured.RemoveNestedField(normalizedObject.Object, "spec", field)
			continue
		}
		for _, rule := range dRules {
			pruneEmptyNetworkPolicyLists(rule)
		}
		if err := unstructured.SetNestedField(normalizedObject.Object, dRules, "spec", field); err != nil {
			return desired, false
		}
	}
	if spec, ok := normalizedObject.Object["spec"].(map[string]interface{}); ok {
		pruneEmptyNetworkPolicyLists(spec["podSelector"])
	}
	return *normalizedObject, true
}

// networkPolicyRuleList reads spec.<field> as a rule list. A null or absent
// field is an empty list. A value of any other type is not a rule list, and
// ok is false.
func networkPolicyRuleList(obj unstructured.Unstructured, field string) (rules []interface{}, ok bool) {
	value, found, err := unstructured.NestedFieldCopy(obj.Object, "spec", field)
	if err != nil {
		return nil, false
	}
	if !found || value == nil {
		return nil, true
	}
	rules, ok = value.([]interface{})
	return rules, ok
}

// networkPolicyOmitEmptyKeys are the NetworkPolicy list and map fields that
// the API types tag omitempty. For these fields an empty value is stored as an
// absent key, so an empty desired value must match a live object that has no
// key. Selectors are not in this set: an empty podSelector or
// namespaceSelector inside a peer selects all pods or namespaces, and the API
// server keeps it.
var networkPolicyOmitEmptyKeys = map[string]bool{
	"ports":            true,
	"from":             true,
	"to":               true,
	"except":           true,
	"matchLabels":      true,
	"matchExpressions": true,
	"values":           true,
}

// pruneEmptyNetworkPolicyLists removes, in place, the omitempty keys whose
// value is null, an empty list, or an empty map. The caller passes a value
// from a deep copy of the desired object.
func pruneEmptyNetworkPolicyLists(value interface{}) {
	switch v := value.(type) {
	case map[string]interface{}:
		for key, child := range v {
			if networkPolicyOmitEmptyKeys[key] && isEmptyCollection(child) {
				delete(v, key)
				continue
			}
			pruneEmptyNetworkPolicyLists(child)
		}
	case []interface{}:
		for _, child := range v {
			pruneEmptyNetworkPolicyLists(child)
		}
	}
}

func isEmptyCollection(value interface{}) bool {
	switch v := value.(type) {
	case nil:
		return true
	case []interface{}:
		return len(v) == 0
	case map[string]interface{}:
		return len(v) == 0
	default:
		return false
	}
}

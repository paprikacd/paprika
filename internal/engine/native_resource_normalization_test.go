package engine

import (
	"testing"

	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"sigs.k8s.io/yaml"
)

func TestPriorityClassDefaultFalseMatchesOmissionWithoutHidingTrue(t *testing.T) {
	desired := unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "scheduling.k8s.io/v1", "kind": "PriorityClass",
		"metadata": map[string]interface{}{"name": "example"},
		"value":    int64(-100), "globalDefault": false, "preemptionPolicy": "Never",
	}}
	live := desired.DeepCopy()
	unstructured.RemoveNestedField(live.Object, "globalDefault")
	require.True(t, resourceEqual(desired, *live))
	require.Equal(t, false, desired.Object["globalDefault"], "do not mutate desired input")
	require.NotContains(t, live.Object, "globalDefault", "do not mutate live input")

	live.Object["globalDefault"] = true
	require.False(t, resourceEqual(desired, *live), "a live global priority default must remain drift")
	desired.Object["globalDefault"] = true
	require.True(t, resourceEqual(desired, *live))
	unstructured.RemoveNestedField(live.Object, "globalDefault")
	require.False(t, resourceEqual(desired, *live), "an omitted live value cannot satisfy desired true")

	desired.Object["globalDefault"] = false
	desired.SetAPIVersion("example.test/v1")
	live.SetAPIVersion("example.test/v1")
	require.False(t, resourceEqual(desired, *live), "do not normalize unrelated CRD fields")
}

func TestQuotaCanonicalQuantitiesDoNotHideActualChanges(t *testing.T) {
	desired := unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1", "kind": "ResourceQuota", "metadata": map[string]interface{}{"name": "example"},
		"spec": map[string]interface{}{"hard": map[string]interface{}{"requests.cpu": "5000m", "requests.memory": "10240Mi"}},
	}}
	live := desired.DeepCopy()
	require.NoError(t, unstructured.SetNestedField(live.Object, "5", "spec", "hard", "requests.cpu"))
	require.NoError(t, unstructured.SetNestedField(live.Object, "10Gi", "spec", "hard", "requests.memory"))
	require.True(t, resourceEqual(desired, *live))
	require.NoError(t, unstructured.SetNestedField(live.Object, "6", "spec", "hard", "requests.cpu"))
	require.False(t, resourceEqual(desired, *live))
	// Normalization must neither mutate inputs nor alter arbitrary CRD strings.
	value, _, err := unstructured.NestedString(desired.Object, "spec", "hard", "requests.cpu")
	require.NoError(t, err)
	require.Equal(t, "5000m", value)
	desired.SetAPIVersion("example.test/v1")
	live.SetAPIVersion("example.test/v1")
	require.NoError(t, unstructured.SetNestedField(live.Object, "5", "spec", "hard", "requests.cpu"))
	require.False(t, resourceEqual(desired, *live))
}

func TestNetworkPolicyEmptyRulesMatchOmissionButDetectAddedAccess(t *testing.T) {
	desired := unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": map[string]interface{}{"name": "example"},
		"spec": map[string]interface{}{"podSelector": map[string]interface{}{}, "policyTypes": []interface{}{"Ingress", "Egress"}, "ingress": []interface{}{}, "egress": []interface{}{}},
	}}
	live := desired.DeepCopy()
	unstructured.RemoveNestedField(live.Object, "spec", "ingress")
	unstructured.RemoveNestedField(live.Object, "spec", "egress")
	require.True(t, resourceEqual(desired, *live))
	for _, field := range []string{"ingress", "egress"} {
		t.Run(field, func(t *testing.T) {
			opened := live.DeepCopy()
			require.NoError(t, unstructured.SetNestedSlice(opened.Object, []interface{}{map[string]interface{}{}}, "spec", field))
			require.False(t, resourceEqual(desired, *opened), "an empty rule allows all traffic and must remain drift")
		})
	}
	_, present, err := unstructured.NestedSlice(desired.Object, "spec", "ingress")
	require.NoError(t, err)
	require.True(t, present, "do not mutate rendered input")
}

// absentField marks a spec field that the object does not carry.
type absentField struct{}

func networkPolicyWith(field string, value interface{}) unstructured.Unstructured {
	spec := map[string]interface{}{
		"podSelector": map[string]interface{}{"matchLabels": map[string]interface{}{"app": "example"}},
		"policyTypes": []interface{}{"Ingress", "Egress"},
	}
	if _, absent := value.(absentField); !absent {
		spec[field] = value
	}
	return unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
		"metadata": map[string]interface{}{"name": "example", "namespace": "default"},
		"spec":     spec,
	}}
}

// A null, absent, or empty rule list all mean "no rules": with the policy type
// set, that denies all traffic of that kind. The API server drops null and
// empty lists, so the three forms must compare equal on either side. A
// nonempty rule list allows traffic and must never equal an empty one.
func TestNetworkPolicyNullAbsentAndEmptyRuleListsAreEqual(t *testing.T) {
	rule := func() []interface{} {
		return []interface{}{map[string]interface{}{
			"ports": []interface{}{map[string]interface{}{"protocol": "TCP", "port": int64(53)}},
		}}
	}
	cases := []struct {
		name          string
		desired, live interface{}
		equal         bool
	}{
		{"null desired, absent live", nil, absentField{}, true},
		{"absent desired, null live", absentField{}, nil, true},
		{"null desired, empty live", nil, []interface{}{}, true},
		{"empty desired, null live", []interface{}{}, nil, true},
		{"empty desired, absent live", []interface{}{}, absentField{}, true},
		{"absent desired, empty live", absentField{}, []interface{}{}, true},
		{"null desired, null live", nil, nil, true},
		{"nonempty desired, equal live", rule(), rule(), true},
		{"nonempty desired, empty live", rule(), []interface{}{}, false},
		{"nonempty desired, null live", rule(), nil, false},
		{"nonempty desired, absent live", rule(), absentField{}, false},
		{"empty desired, nonempty live", []interface{}{}, rule(), false},
		{"null desired, nonempty live", nil, rule(), false},
		{"absent desired, nonempty live", absentField{}, rule(), false},
		{"null desired, allow-all live", nil, []interface{}{map[string]interface{}{}}, false},
		{"rule list of the wrong type", "not-a-list", absentField{}, false},
	}
	for _, field := range []string{"ingress", "egress"} {
		for _, tc := range cases {
			t.Run(field+"/"+tc.name, func(t *testing.T) {
				desired := networkPolicyWith(field, tc.desired)
				live := networkPolicyWith(field, tc.live)
				before := desired.DeepCopy()
				require.Equal(t, tc.equal, resourceEqual(desired, live))
				require.Equal(t, before.Object, desired.Object, "do not mutate rendered input")
			})
		}
	}
}

// The API server also drops null and empty values of the omitempty lists and
// maps inside the rules and selectors. An empty or null desired value matches
// a live object without the key. Selectors stay: an empty peer selector
// selects everything and the API server keeps it.
func TestNetworkPolicyNestedEmptyListsMatchOmission(t *testing.T) {
	peer := func(extra map[string]interface{}) map[string]interface{} {
		p := map[string]interface{}{"podSelector": map[string]interface{}{"matchLabels": map[string]interface{}{"app": "db"}}}
		for k, v := range extra {
			p[k] = v
		}
		return p
	}
	liveRule := map[string]interface{}{"to": []interface{}{peer(nil)}}
	cases := []struct {
		name        string
		desiredRule map[string]interface{}
		equal       bool
	}{
		{"null ports", map[string]interface{}{"to": []interface{}{peer(nil)}, "ports": nil}, true},
		{"empty ports", map[string]interface{}{"to": []interface{}{peer(nil)}, "ports": []interface{}{}}, true},
		{"null peer matchExpressions", map[string]interface{}{"to": []interface{}{map[string]interface{}{"podSelector": map[string]interface{}{"matchLabels": map[string]interface{}{"app": "db"}, "matchExpressions": nil}}}}, true},
		{"empty peer matchExpressions", map[string]interface{}{"to": []interface{}{map[string]interface{}{"podSelector": map[string]interface{}{"matchLabels": map[string]interface{}{"app": "db"}, "matchExpressions": []interface{}{}}}}}, true},
		{"matchExpressions missing from live", map[string]interface{}{"to": []interface{}{map[string]interface{}{"podSelector": map[string]interface{}{"matchLabels": map[string]interface{}{"app": "db"}, "matchExpressions": []interface{}{map[string]interface{}{"key": "tier", "operator": "Exists", "values": nil}}}}}}, false},
		{"nonempty ports", map[string]interface{}{"to": []interface{}{peer(nil)}, "ports": []interface{}{map[string]interface{}{"port": int64(5432)}}}, false},
		{"empty peer selector is kept", map[string]interface{}{"to": []interface{}{peer(map[string]interface{}{"namespaceSelector": map[string]interface{}{}})}}, false},
	}
	for _, field := range []string{"ingress", "egress"} {
		peerKey := map[string]string{"ingress": "from", "egress": "to"}[field]
		for _, tc := range cases {
			t.Run(field+"/"+tc.name, func(t *testing.T) {
				rename := func(rule map[string]interface{}) map[string]interface{} {
					out := map[string]interface{}{}
					for k, v := range rule {
						if k == "to" {
							k = peerKey
						}
						out[k] = v
					}
					return out
				}
				desired := networkPolicyWith(field, []interface{}{rename(tc.desiredRule)})
				live := networkPolicyWith(field, []interface{}{rename(liveRule)})
				before := desired.DeepCopy()
				require.Equal(t, tc.equal, resourceEqual(desired, live))
				require.Equal(t, before.Object, desired.Object, "do not mutate rendered input")
			})
		}
	}

	t.Run("empty values and except match omission", func(t *testing.T) {
		expr := func(values interface{}) map[string]interface{} {
			e := map[string]interface{}{"key": "tier", "operator": "Exists"}
			if _, absent := values.(absentField); !absent {
				e["values"] = values
			}
			return e
		}
		ipBlock := func(except interface{}) map[string]interface{} {
			b := map[string]interface{}{"cidr": "10.0.0.0/8"}
			if _, absent := except.(absentField); !absent {
				b["except"] = except
			}
			return b
		}
		rule := func(values, except interface{}) []interface{} {
			return []interface{}{map[string]interface{}{"to": []interface{}{
				map[string]interface{}{"podSelector": map[string]interface{}{"matchExpressions": []interface{}{expr(values)}}},
				map[string]interface{}{"ipBlock": ipBlock(except)},
			}}}
		}
		live := networkPolicyWith("egress", rule(absentField{}, absentField{}))
		for _, empty := range []interface{}{nil, []interface{}{}} {
			require.True(t, resourceEqual(networkPolicyWith("egress", rule(empty, empty)), live))
		}
		require.False(t, resourceEqual(networkPolicyWith("egress", rule(absentField{}, []interface{}{"10.1.0.0/16"})), live), "a nonempty except must remain drift")
	})

	t.Run("both rule lists null", func(t *testing.T) {
		desired := networkPolicyWith("ingress", nil)
		require.NoError(t, unstructured.SetNestedField(desired.Object, nil, "spec", "egress"))
		live := networkPolicyWith("ingress", absentField{})
		require.True(t, resourceEqual(desired, live))
	})

	t.Run("empty peer list and empty pod selector labels", func(t *testing.T) {
		desired := networkPolicyWith("ingress", []interface{}{map[string]interface{}{"from": []interface{}{}, "ports": nil}})
		require.NoError(t, unstructured.SetNestedField(desired.Object, map[string]interface{}{"matchLabels": map[string]interface{}{}}, "spec", "podSelector"))
		live := networkPolicyWith("ingress", []interface{}{map[string]interface{}{}})
		require.NoError(t, unstructured.SetNestedField(live.Object, map[string]interface{}{}, "spec", "podSelector"))
		require.True(t, resourceEqual(desired, live))
	})
}

// Regression for sfh-next on 2026-10-05: the Job policies rendered a bare
// "ingress:" key (null) with egress rules only. The API server dropped the
// key, and the four policies stayed OutOfSync forever.
func TestNetworkPolicyNullIngressEgressOnlyRegression(t *testing.T) {
	const rendered = `
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: sfh-next-migrate
  namespace: sfh-next
  labels:
    app.kubernetes.io/component: migrate
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/component: migrate
  policyTypes: [Ingress, Egress]
  ingress:
  egress:
    - to:
        - namespaceSelector: {}
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports: [{protocol: UDP, port: 53}, {protocol: TCP, port: 53}]
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/component: postgres
      ports: [{protocol: TCP, port: 5432}]
`
	var desired unstructured.Unstructured
	require.NoError(t, yaml.Unmarshal([]byte(rendered), &desired.Object))
	ingress, present := desired.Object["spec"].(map[string]interface{})["ingress"]
	require.True(t, present)
	require.Nil(t, ingress, "the bare ingress key must parse as null")

	live := desired.DeepCopy()
	unstructured.RemoveNestedField(live.Object, "spec", "ingress")
	require.True(t, resourceEqual(desired, *live), "a null ingress must match the live object the API server stored")

	opened := live.DeepCopy()
	require.NoError(t, unstructured.SetNestedSlice(opened.Object, []interface{}{map[string]interface{}{}}, "spec", "ingress"))
	require.False(t, resourceEqual(desired, *opened), "live ingress rules must remain drift")
}

//go:build e2e || e2e_core || e2e_split
// +build e2e e2e_core e2e_split

/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Shared spec lifecycle for the e2e suites: every fixture is a Fixture that
// records what it applied, and teardown deletes in reverse order with a
// finalizer strip as the last resort — so a spec that dies mid-reconcile
// can't leave a finalizer'd CR blocking namespace/CRD deletion.
package e2e

import (
	"fmt"
	"strings"
	"time"

	. "github.com/onsi/gomega"

	"github.com/benebsworth/paprika/test/utils"
)

// Fixture tracks manifests applied by a spec (or BeforeAll) and unwinds them
// in reverse order. Prefer it over ad-hoc `kubectl delete` lists: the tracker
// cannot forget an object added mid-spec, and Teardown strips finalizers on
// objects that refuse to disappear.
type Fixture struct {
	applied []utils.ManifestID
}

// Apply applies each single-object manifest in order, failing the spec on the
// first error and recording every success for later teardown.
func (f *Fixture) Apply(manifests ...string) {
	for _, m := range manifests {
		out, err := utils.ApplyManifest(m)
		Expect(err).NotTo(HaveOccurred(), "apply failed: %s", out)
		if id, err := utils.ParseManifestID(m); err == nil {
			f.applied = append(f.applied, id)
		}
	}
}

// Teardown deletes tracked objects newest-first, then sweeps any that still
// carry finalizers. Safe to call even if Apply never ran.
func (f *Fixture) Teardown() {
	for i := len(f.applied) - 1; i >= 0; i-- {
		_ = utils.DeleteNamed(f.applied[i])
	}
	// Second pass: anything still around is finalizer-parked (controllers
	// may already be gone in teardown) — strip rather than block.
	for _, id := range f.applied {
		args := []string{"patch", strings.ToLower(id.Kind), id.Name,
			"--type=merge", "-p", `{"metadata":{"finalizers":[]}}`}
		if id.Namespace != "" {
			args = append(args, "-n", id.Namespace)
		}
		_, _ = utils.Kubectl(args...)
	}
	f.applied = nil
}

// DeleteByLabel sweeps label-selected resources that can't be tracked by name
// (resources the controller derives from an Application).
func DeleteByLabel(namespace, label string, kinds ...string) {
	utils.DeleteByLabel(namespace, label, kinds...)
}

// TeardownApp deletes an Application and sweeps every resource class the
// controllers derive from it — the canonical per-app cleanup block.
func TeardownApp(namespace, app string) {
	_ = utils.DeleteNamed(utils.ManifestID{Kind: "Application", Namespace: namespace, Name: app})
	utils.DeleteByLabel(namespace, "app.paprika.io/name="+app,
		"releases", "stages", "pipelines", "templates",
		"deployments", "services", "ingresses", "configmaps", "jobs", "pods")
}

// WaitForWebhook probes the AppProject admission webhook until an apply
// succeeds — required after the manager pod is replaced (endpoint updates
// lag the pod restart, so webhooks transiently dead-end).
func WaitForWebhook(namespace string) {
	Eventually(func(g Gomega) {
		probe := fmt.Sprintf(`{"apiVersion":"core.paprika.io/v1alpha1","kind":"AppProject","metadata":{"name":"webhook-probe","namespace":"%s"},"spec":{}}`, namespace)
		out, err := utils.ApplyManifest(probe)
		if err == nil {
			_ = utils.DeleteNamed(utils.ManifestID{Kind: "AppProject", Namespace: namespace, Name: "webhook-probe"})
			return
		}
		lowered := strings.ToLower(out)
		if strings.Contains(lowered, "connection refused") || strings.Contains(lowered, "timeout") ||
			strings.Contains(lowered, "no route to host") || strings.Contains(lowered, "deadline exceeded") {
			g.Expect(lowered).To(Equal(""), "webhook is not reachable yet: %s", out)
		}
	}, 2*time.Minute, 5*time.Second).Should(Succeed())
}

// ExpectPhaseEventually asserts a resource reaches an exact jsonpath value.
func ExpectPhaseEventually(namespace, resource, name, path, want string, within time.Duration) {
	Eventually(func(g Gomega) {
		out, err := utils.GetJSONPath(namespace, resource, name, path)
		g.Expect(err).NotTo(HaveOccurred())
		g.Expect(out).To(Equal(want))
	}).WithTimeout(within).WithPolling(2 * time.Second).Should(Succeed())
}

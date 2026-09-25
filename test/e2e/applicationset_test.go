//go:build e2e
// +build e2e

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

package e2e

import (
	"fmt"
	"os/exec"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/benebsworth/paprika/test/utils"
)

// rollingSyncSetFmt renders an ApplicationSet whose list generator produces
// two Applications labeled wave=canary / wave=prod, under a RollingSync
// strategy that gates prod updates on canary health. %s are, in order:
// the ApplicationSet namespace, the targetNamespace template, and the
// canary image tag.
//
// Phase 2 points the canary at a namespace that does not exist, so its
// release apply fails deterministically and the prod update stays gated
// forever — an un-pullable image is not a reliable blocker since the old
// ReplicaSet keeps the Deployment reporting Healthy.
const rollingSyncSetFmt = `{
	"apiVersion": "pipelines.paprika.io/v1alpha1",
	"kind": "ApplicationSet",
	"metadata": {"name": "e2e-rollingsync", "namespace": "%s"},
	"spec": {
		"generators": [{
			"list": {"items": [
				{"wave": "canary"},
				{"wave": "prod"}
			]}
		}],
		"template": {
			"metadata": {"labels": {"wave": "{{.wave}}"}},
			"source": {
				"type": "helm",
				"chart": {"path": "/charts/demo-app"},
				"targetNamespace": "%s"
			},
			"stages": [{"name": "dev", "ring": 1}],
			"strategy": "Rolling",
			"syncPolicy": "Auto",
			"parameters": {
				"replicaCount": "1",
				"image.tag": "%s",
				"features.canary.enabled": "false",
				"features.monitoring.enabled": "false",
				"features.ingress.enabled": "false",
				"probes.enabled": "false"
			}
		},
		"strategy": {
			"type": "RollingSync",
			"rollingSync": {"steps": [
				{"matchLabels": {"wave": "canary"}},
				{"matchLabels": {"wave": "prod"}}
			]}
		}
	}
}`

// Phase 2 renders targetNamespace per wave via Go-template conditional: the
// canary update lands on a namespace that will never exist (permanent apply
// failure → resourceHealth Missing → never Healthy), while prod's spec also
// changes (image.tag) so it sits pending behind the gate.
const (
	rollSyncPhase1Ns  = "paprika-system"
	rollSyncPhase2Ns  = `{{if eq .wave \"canary\"}}e2e-nowhere{{else}}paprika-system{{end}}`
	rollSyncPhase1Tag = "alpine"
	rollSyncPhase2Tag = "alpine-otel"
)

func appsetJSONPath(g Gomega, path string) string {
	cmd := exec.Command("kubectl", "get", "applicationset", "e2e-rollingsync",
		"-n", namespace, "-o", fmt.Sprintf("jsonpath=%s", path))
	out, err := utils.Run(cmd)
	g.Expect(err).NotTo(HaveOccurred())
	return strings.TrimSpace(out)
}

func generatedAppName(g Gomega, wave string) string {
	cmd := exec.Command("kubectl", "get", "applications", "-n", namespace,
		"-l", fmt.Sprintf("applicationset.paprika.io/name=e2e-rollingsync,wave=%s", wave),
		"-o", "jsonpath={.items[0].metadata.name}")
	out, err := utils.Run(cmd)
	g.Expect(err).NotTo(HaveOccurred())
	return strings.TrimSpace(out)
}

func generatedAppJSONPath(g Gomega, wave, path string) string {
	cmd := exec.Command("kubectl", "get", "applications", "-n", namespace,
		"-l", fmt.Sprintf("applicationset.paprika.io/name=e2e-rollingsync,wave=%s", wave),
		"-o", fmt.Sprintf("jsonpath={.items[0]%s}", path))
	out, err := utils.Run(cmd)
	g.Expect(err).NotTo(HaveOccurred())
	return strings.TrimSpace(out)
}

var _ = Context("ApplicationSetRollingSync", Ordered, func() {
	AfterAll(func() {
		By("cleaning up rollingsync e2e resources")
		cmd := exec.Command("kubectl", "delete", "applicationset", "e2e-rollingsync",
			"-n", namespace, "--ignore-not-found", "--timeout=30s")
		_, _ = utils.Run(cmd)
		for _, resource := range []string{"releases", "stages", "pipelines", "templates", "applications"} {
			cmd := exec.Command("kubectl", "delete", resource, "-n", namespace,
				"-l", "applicationset.paprika.io/name=e2e-rollingsync",
				"--ignore-not-found", "--timeout=30s")
			_, _ = utils.Run(cmd)
		}
		for _, resource := range []string{"deployments", "services", "configmaps", "pods"} {
			cmd := exec.Command("kubectl", "delete", resource, "-n", namespace,
				"-l", "app.kubernetes.io/name=demo-app",
				"--ignore-not-found", "--timeout=15s")
			_, _ = utils.Run(cmd)
		}
	})

	It("generates one healthy Application per list item with wave labels", func() {
		cmd := exec.Command("kubectl", "apply", "-f", "-")
		cmd.Stdin = strings.NewReader(fmt.Sprintf(rollingSyncSetFmt, namespace, rollSyncPhase1Ns, rollSyncPhase1Tag))
		_, err := utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to create ApplicationSet")

		By("waiting for both generated Applications to reach Healthy")
		verifyHealthy := func(g Gomega) {
			cmd := exec.Command("kubectl", "get", "applications", "-n", namespace,
				"-l", "applicationset.paprika.io/name=e2e-rollingsync",
				"-o", "jsonpath={.items[*].status.phase}")
			out, err := utils.Run(cmd)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(strings.Fields(out)).To(ConsistOf("Healthy", "Healthy"))
		}
		Eventually(verifyHealthy, 4*time.Minute, 5*time.Second).Should(Succeed())

		By("confirming rollingSync status is cleared once converged")
		Eventually(func(g Gomega) {
			g.Expect(appsetJSONPath(g, "{.status.rollingSync}")).To(BeEmpty())
		}, 30*time.Second, 3*time.Second).Should(Succeed())
	})

	It("gates the prod update behind the unhealthy canary and reports progress", func() {
		By("applying the phase-2 template (canary targets a missing namespace)")
		cmd := exec.Command("kubectl", "apply", "-f", "-")
		cmd.Stdin = strings.NewReader(fmt.Sprintf(rollingSyncSetFmt, namespace, rollSyncPhase2Ns, rollSyncPhase2Tag))
		_, err := utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred())

		By("confirming the canary consumed its update and went non-Healthy")
		Eventually(func(g Gomega) {
			g.Expect(generatedAppJSONPath(g, "canary", ".spec.source.targetNamespace")).
				To(Equal("e2e-nowhere"))
		}, 60*time.Second, 3*time.Second).Should(Succeed())

		By("asserting status.rollingSync reports step/pending/waitingFor")
		verifyProgress := func(g Gomega) {
			step := appsetJSONPath(g, "{.status.rollingSync.step}")
			g.Expect(step).To(Equal("2"), "prod step should be the active gated step")
			waitingFor := appsetJSONPath(g, "{.status.rollingSync.waitingFor}")
			g.Expect(waitingFor).To(Equal(generatedAppName(g, "canary")),
				"gated step must name the unhealthy canary")
			pending := appsetJSONPath(g, "{.status.rollingSync.pending}")
			g.Expect(pending).To(ContainSubstring(generatedAppName(g, "prod")))
		}
		Eventually(verifyProgress, 3*time.Minute, 5*time.Second).Should(Succeed())

		By("confirming the Ready condition flips to RollingSyncGated")
		Eventually(func(g Gomega) {
			reason := appsetJSONPath(g,
				`{.status.conditions[?(@.type=="Ready")].reason}`)
			g.Expect(reason).To(Equal("RollingSyncGated"))
		}, 60*time.Second, 5*time.Second).Should(Succeed())
	})

	It("never writes the prod spec while the gate holds", func() {
		// The prod Application spec must retain phase-1 values — the gated
		// update was never written to the generated Application.
		Consistently(func(g Gomega) {
			g.Expect(generatedAppJSONPath(g, "prod", ".spec.source.targetNamespace")).
				To(Equal(rollSyncPhase1Ns))
			// parameters serialises as JSON: {"image.tag":"alpine",...};
			// phase-2 would carry image.tag=alpine-otel.
			params := generatedAppJSONPath(g, "prod", `.spec.parameters`)
			g.Expect(params).To(ContainSubstring(`"image.tag":"` + rollSyncPhase1Tag + `"`))
			g.Expect(params).NotTo(ContainSubstring(rollSyncPhase2Tag))
		}, 45*time.Second, 5*time.Second).Should(Succeed())
	})
})

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
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/benebsworth/paprika/test/utils"
)

const namespace = "paprika-system"

const serviceAccountName = "paprika-controller-manager"

const metricsServiceName = "paprika-controller-manager-metrics-service"

const metricsRoleBindingName = "paprika-metrics-binding"

var portForwardCmd *exec.Cmd

func waitForWebhookCA() {
	Eventually(func(g Gomega) {
		cmd := exec.Command("kubectl", "get", "mutatingwebhookconfiguration", "paprika-mutating-webhook-configuration",
			"-o", "jsonpath={.webhooks[0].clientConfig.caBundle}")
		out, err := utils.Run(cmd)
		g.Expect(err).NotTo(HaveOccurred())
		g.Expect(out).NotTo(BeEmpty(), "mutating webhook CA bundle not injected")

		cmd = exec.Command("kubectl", "get", "validatingwebhookconfiguration", "paprika-validating-webhook-configuration",
			"-o", "jsonpath={.webhooks[0].clientConfig.caBundle}")
		out, err = utils.Run(cmd)
		g.Expect(err).NotTo(HaveOccurred())
		g.Expect(out).NotTo(BeEmpty(), "validating webhook CA bundle not injected")

		cmd = exec.Command("kubectl", "get", "secret", "webhook-server-cert", "-n", namespace)
		_, err = utils.Run(cmd)
		g.Expect(err).NotTo(HaveOccurred(), "webhook-server-cert secret not found")
	}, 2*time.Minute, 2*time.Second).Should(Succeed())

	By("waiting for the controller-manager to be ready after webhook cert is available")
	cmd := exec.Command("kubectl", "wait", "--for=condition=available", "-n", namespace,
		"deployment/paprika-controller-manager", "--timeout=180s")
	_, err := utils.Run(cmd)
	Expect(err).NotTo(HaveOccurred(), "Operator deployment not available after webhook cert ready")
}

func deployManager() {
	By("creating manager namespace")
	nsManifest := fmt.Sprintf(`{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"%s"}}`, namespace)
	cmd := exec.Command("kubectl", "apply", "-f", "-")
	cmd.Stdin = strings.NewReader(nsManifest)
	_, err := utils.Run(cmd)
	Expect(err).NotTo(HaveOccurred(), "Failed to create namespace")

	By("labeling the namespace to enforce the restricted security policy")
	cmd = exec.Command("kubectl", "label", "--overwrite", "ns", namespace,
		"pod-security.kubernetes.io/enforce=restricted")
	_, err = utils.Run(cmd)
	Expect(err).NotTo(HaveOccurred(), "Failed to label namespace")

	By("installing CRDs")
	cmd = exec.Command("make", "install")
	_, err = utils.Run(cmd)
	Expect(err).NotTo(HaveOccurred(), "Failed to install CRDs")

	By("deploying the controller-manager")
	cmd = exec.Command("make", "deploy", fmt.Sprintf("IMG=%s", managerImage))
	_, err = utils.Run(cmd)
	Expect(err).NotTo(HaveOccurred(), "Failed to deploy the controller-manager")

	By("restarting the controller-manager to ensure the freshly built image is used")
	cmd = exec.Command("kubectl", "rollout", "restart", "-n", namespace, "deployment/paprika-controller-manager")
	_, err = utils.Run(cmd)
	Expect(err).NotTo(HaveOccurred(), "Failed to restart the controller-manager")

	By("waiting for the operator deployment to be ready")
	cmd = exec.Command("kubectl", "wait", "--for=condition=available", "-n", namespace,
		"deployment/paprika-controller-manager", "--timeout=180s")
	_, err = utils.Run(cmd)
	Expect(err).NotTo(HaveOccurred(), "Operator deployment not available")

	By("waiting for webhook CA bundles to be injected")
	waitForWebhookCA()
}

func teardownManager() {
	By("stopping port-forward for the UI dashboard")
	if portForwardCmd != nil && portForwardCmd.Process != nil {
		_ = portForwardCmd.Process.Signal(syscall.SIGTERM)
		_, _ = portForwardCmd.Process.Wait()
	}

	By("deleting the demo app")
	cmd := exec.Command("kubectl", "delete", "deployment", "paprika-demo", "-n", namespace, "--ignore-not-found")
	_, _ = utils.Run(cmd)
	cmd = exec.Command("kubectl", "delete", "service", "paprika-demo", "-n", namespace, "--ignore-not-found")
	_, _ = utils.Run(cmd)

	By("cleaning up the curl pod for metrics")
	cmd = exec.Command("kubectl", "delete", "pod", "curl-metrics", "-n", namespace, "--ignore-not-found")
	_, _ = utils.Run(cmd)

	By("deleting the metrics ClusterRoleBinding")
	cmd = exec.Command("kubectl", "delete", "clusterrolebinding", metricsRoleBindingName, "--ignore-not-found")
	_, _ = utils.Run(cmd)

	By("undeploying the controller-manager")
	cmd = exec.Command("make", "undeploy")
	_, _ = utils.Run(cmd)

	By("uninstalling CRDs")
	cmd = exec.Command("make", "uninstall", "ignore-not-found=true")
	_, _ = utils.Run(cmd)

	By("removing manager namespace")
	cmd = exec.Command("kubectl", "delete", "ns", namespace, "--ignore-not-found")
	_, _ = utils.Run(cmd)
}

var _ = Describe("Manager", Ordered, func() {
	var controllerPodName string

	BeforeAll(func() {
		By("deploying the demo app")
		demoApp := fmt.Sprintf(`{
			"apiVersion": "apps/v1",
			"kind": "Deployment",
			"metadata": {"name": "paprika-demo", "namespace": "%s"},
			"spec": {
				"replicas": 1,
				"selector": {"matchLabels": {"app": "paprika-demo"}},
				"template": {
					"metadata": {"labels": {"app": "paprika-demo"}},
					"spec": {
						"serviceAccountName": "%s",
						"securityContext": {"runAsNonRoot": true, "runAsUser": 1000, "seccompProfile": {"type": "RuntimeDefault"}},
						"containers": [{
							"name": "demo",
							"image": "%s",
							"imagePullPolicy": "Never",
							"ports": [{"containerPort": 8080}],
							"securityContext": {
								"allowPrivilegeEscalation": false,
								"capabilities": {"drop": ["ALL"]},
								"runAsNonRoot": true,
								"runAsUser": 1000,
								"seccompProfile": {"type": "RuntimeDefault"}
							}
						}]
					}
				}
			}
		}`, namespace, serviceAccountName, demoImage)
		cmd := exec.Command("kubectl", "apply", "-f", "-")
		cmd.Stdin = strings.NewReader(demoApp)
		_, err := utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to deploy the demo app")

		demoSvc := fmt.Sprintf(`{
			"apiVersion": "v1",
			"kind": "Service",
			"metadata": {"name": "paprika-demo", "namespace": "%s"},
			"spec": {
				"selector": {"app": "paprika-demo"},
				"ports": [{"port": 80, "targetPort": 8080}],
				"type": "ClusterIP"
			}
		}`, namespace)
		cmd = exec.Command("kubectl", "apply", "-f", "-")
		cmd.Stdin = strings.NewReader(demoSvc)
		_, err = utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to create demo app service")

		By("waiting for the operator deployment to be ready")
		cmd = exec.Command("kubectl", "wait", "--for=condition=available", "-n", namespace,
			"deployment/paprika-controller-manager", "--timeout=120s")
		_, err = utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Operator deployment not available")

		By("starting port-forward for the operator UI (port 3000)")
		pfCmd := exec.Command("kubectl", "port-forward", "-n", namespace,
			"deployment/paprika-controller-manager", "4000:3000")
		err = pfCmd.Start()
		Expect(err).NotTo(HaveOccurred(), "Failed to start port-forward for operator UI")
		portForwardCmd = pfCmd

		By("waiting for the port-forward to be ready")
		verifyPortForward := func(g Gomega) {
			resp, err := http.Get("http://localhost:4000/")
			g.Expect(err).NotTo(HaveOccurred(), "Port-forward not yet ready")
			defer resp.Body.Close()
			g.Expect(resp.StatusCode).To(Equal(http.StatusOK))
		}
		Eventually(verifyPortForward, 30*time.Second, time.Second).Should(Succeed())

		By("waiting for webhook CA bundles to be injected")
		waitForWebhookCA()
	})

	AfterEach(func() {
		specReport := CurrentSpecReport()
		if specReport.Failed() {
			By("Fetching controller manager pod logs")
			cmd := exec.Command("kubectl", "logs", controllerPodName, "-n", namespace)
			controllerLogs, err := utils.Run(cmd)
			if err == nil {
				_, _ = fmt.Fprintf(GinkgoWriter, "Controller logs:\n %s", controllerLogs)
			} else {
				_, _ = fmt.Fprintf(GinkgoWriter, "Failed to get Controller logs: %s", err)
			}

			By("Fetching Kubernetes events")
			cmd = exec.Command("kubectl", "get", "events", "-n", namespace, "--sort-by=.lastTimestamp")
			eventsOutput, err := utils.Run(cmd)
			if err == nil {
				_, _ = fmt.Fprintf(GinkgoWriter, "Kubernetes events:\n%s", eventsOutput)
			} else {
				_, _ = fmt.Fprintf(GinkgoWriter, "Failed to get Kubernetes events: %s", err)
			}

			By("Fetching curl-metrics logs")
			cmd = exec.Command("kubectl", "logs", "curl-metrics", "-n", namespace)
			metricsOutput, err := utils.Run(cmd)
			if err == nil {
				_, _ = fmt.Fprintf(GinkgoWriter, "Metrics logs:\n %s", metricsOutput)
			} else {
				_, _ = fmt.Fprintf(GinkgoWriter, "Failed to get curl-metrics logs: %s", err)
			}

			By("Fetching controller manager pod description")
			cmd = exec.Command("kubectl", "describe", "pod", controllerPodName, "-n", namespace)
			podDescription, err := utils.Run(cmd)
			if err == nil {
				fmt.Println("Pod description:\n", podDescription)
			} else {
				fmt.Println("Failed to describe controller pod")
			}
		}
	})

	SetDefaultEventuallyTimeout(2 * time.Minute)
	SetDefaultEventuallyPollingInterval(time.Second)

	Context("Pipeline", func() {
		It("should reconcile a simple pipeline", func() {
			By("creating a pipeline that runs echo in alpine")
			pipeline := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Pipeline",
				"metadata": {"name": "e2e-hello", "namespace": "%s"},
				"spec": {
					"maxParallel": 1,
					"steps": [{"name": "greet", "image": "alpine:3.19", "script": "echo hello-from-paprika"}]
				}
			}`, namespace)
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(pipeline)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create pipeline")

			By("waiting for the pipeline to complete")
			verifyPhase := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "pipeline", "e2e-hello",
					"-n", namespace, "-o", "jsonpath={.status.phase}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Or(Equal("Succeeded"), Equal("Failed")),
					"Pipeline should have reached terminal state")
			}
			Eventually(verifyPhase, 3*time.Minute, time.Second).Should(Succeed())

			By("checking that pipeline status shows Succeeded")
			cmd = exec.Command("kubectl", "get", "pipeline", "e2e-hello",
				"-n", namespace, "-o", "jsonpath={.status.phase}")
			finalPhase, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred())
			Expect(finalPhase).To(Equal("Succeeded"), "Pipeline should have succeeded")
		})

		It("should create a Job for each pipeline step", func() {
			By("checking that a Job was created in the operator namespace")
			verifyJob := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "jobs", "-n", namespace,
					"-l", "paprika.io/pipeline=e2e-hello",
					"-o", "jsonpath={.items[*].metadata.name}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).NotTo(BeEmpty(), "Expected at least one Job for the pipeline")
			}
			Eventually(verifyJob, 30*time.Second, time.Second).Should(Succeed())
		})

		It("should handle step dependencies correctly", func() {
			By("creating a pipeline with dependent steps")
			pipeline := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Pipeline",
				"metadata": {"name": "e2e-dag", "namespace": "%s"},
				"spec": {
					"maxParallel": 2,
					"steps": [
						{"name": "stage1", "image": "alpine:3.19", "script": "echo stage1"},
						{"name": "stage2", "depends": ["stage1"], "image": "alpine:3.19", "script": "echo stage2"},
						{"name": "stage3", "depends": ["stage1"], "image": "alpine:3.19", "script": "echo stage3"}
					]
				}
			}`, namespace)
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(pipeline)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create DAG pipeline")

			By("waiting for the DAG pipeline to complete")
			verifyPhase := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "pipeline", "e2e-dag",
					"-n", namespace, "-o", "jsonpath={.status.phase}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("Succeeded"), "DAG pipeline should succeed")
			}
			Eventually(verifyPhase, 3*time.Minute, time.Second).Should(Succeed())

			By("verifying all step statuses")
			cmd = exec.Command("kubectl", "get", "pipeline", "e2e-dag",
				"-n", namespace, "-o", "jsonpath={range .status.stepStatuses[*]}{.name}={.phase}{\"\\n\"}{end}")
			out, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred())
			Expect(out).To(ContainSubstring("Succeeded"))
		})

		It("should fail when a step uses an invalid image", func() {
			By("creating a pipeline with a bad image")
			pipeline := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Pipeline",
				"metadata": {"name": "e2e-bad-image", "namespace": "%s"},
				"spec": {
					"maxParallel": 1,
					"steps": [{"name": "fail-step", "image": "this-image-does-not-exist-12345", "script": "echo never", "timeout": 30}]
				}
			}`, namespace)
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(pipeline)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create bad-image pipeline")

			By("waiting for the pipeline to fail")
			verifyPhase := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "pipeline", "e2e-bad-image",
					"-n", namespace, "-o", "jsonpath={.status.phase}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("Failed"), "Pipeline should have failed")
			}
			Eventually(verifyPhase, 3*time.Minute, time.Second).Should(Succeed())
		})

		It("should create artifacts for pipelines with artifact outputs", func() {
			By("creating a pipeline with artifact outputs")
			pipeline := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Pipeline",
				"metadata": {"name": "e2e-artifact", "namespace": "%s"},
				"spec": {
					"maxParallel": 1,
					"steps": [{"name": "build", "image": "alpine:3.19", "script": "echo built"}],
					"artifacts": [{"name": "image", "path": "e2e-registry.io/app:v1"}]
				}
			}`, namespace)
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(pipeline)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create artifact pipeline")

			By("waiting for the pipeline to succeed")
			verifyPhase := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "pipeline", "e2e-artifact",
					"-n", namespace, "-o", "jsonpath={.status.phase}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("Succeeded"), "Pipeline should succeed")
			}
			Eventually(verifyPhase, 3*time.Minute, time.Second).Should(Succeed())

			By("checking that an Artifact CR was created")
			cmd = exec.Command("kubectl", "get", "artifacts", "-n", namespace,
				"-l", "paprika.io/pipeline=e2e-artifact",
				"-o", "jsonpath={.items[*].metadata.name}")
			out, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred())
			Expect(out).NotTo(BeEmpty(), "Expected at least one Artifact CR")
		})
	})

	Context("Manager", func() {
		It("should run successfully", func() {
			By("validating that the controller-manager pod is running as expected")
			verifyControllerUp := func(g Gomega) {
				By("getting the name of the controller-manager pod")
				cmd := exec.Command("kubectl", "get",
					"pods", "-l", "control-plane=controller-manager",
					"-o", "go-template={{ range .items }}"+
						"{{ if not .metadata.deletionTimestamp }}"+
						"{{ .metadata.name }}"+
						"{{ \"\\n\" }}{{ end }}{{ end }}",
					"-n", namespace,
				)

				podOutput, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred(), "Failed to retrieve controller-manager pod information")
				podNames := utils.GetNonEmptyLines(podOutput)
				g.Expect(podNames).To(HaveLen(1), "expected 1 controller pod running")
				controllerPodName = podNames[0]
				g.Expect(controllerPodName).To(ContainSubstring("controller-manager"))

				By("validating the pod's status")
				cmd = exec.Command("kubectl", "get",
					"pods", controllerPodName, "-o", "jsonpath={.status.phase}",
					"-n", namespace,
				)
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(Equal("Running"), "Incorrect controller-manager pod status")
			}
			Eventually(verifyControllerUp).Should(Succeed())
		})

		It("should ensure the metrics endpoint is serving metrics", func() {
			By("creating a ClusterRoleBinding for the service account to allow access to metrics")
			cmd := exec.Command("kubectl", "create", "clusterrolebinding", metricsRoleBindingName,
				"--clusterrole=paprika-metrics-reader",
				fmt.Sprintf("--serviceaccount=%s:%s", namespace, serviceAccountName),
				"--dry-run=client", "-o", "yaml",
			)
			manifest, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to generate ClusterRoleBinding manifest")
			cmd = exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(manifest)
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create ClusterRoleBinding")

			By("validating that the metrics service is available")
			cmd = exec.Command("kubectl", "get", "service", metricsServiceName, "-n", namespace)
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Metrics service should exist")

			By("getting the service account token")
			token, err := serviceAccountToken()
			Expect(err).NotTo(HaveOccurred())
			Expect(token).NotTo(BeEmpty())

			By("ensuring the controller pod is ready")
			verifyControllerPodReady := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "pod", controllerPodName, "-n", namespace,
					"-o", "jsonpath={.status.conditions[?(@.type=='Ready')].status}")
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(Equal("True"), "Controller pod not ready")
			}
			Eventually(verifyControllerPodReady, 3*time.Minute, time.Second).Should(Succeed())

			By("verifying that the controller manager is serving the metrics server")
			verifyMetricsServerStarted := func(g Gomega) {
				cmd := exec.Command("kubectl", "logs", controllerPodName, "-n", namespace)
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(ContainSubstring("Serving metrics server"),
					"Metrics server not yet started")
			}
			Eventually(verifyMetricsServerStarted, 3*time.Minute, time.Second).Should(Succeed())

			By("waiting for the webhook service endpoints to be ready")
			verifyWebhookEndpointsReady := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "endpointslices.discovery.k8s.io", "-n", namespace,
					"-l", "kubernetes.io/service-name=paprika-webhook-service",
					"-o", "jsonpath={range .items[*]}{range .endpoints[*]}{.addresses[*]}{end}{end}")
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred(), "Webhook endpoints should exist")
				g.Expect(output).ShouldNot(BeEmpty(), "Webhook endpoints not yet ready")
			}
			Eventually(verifyWebhookEndpointsReady, 3*time.Minute, time.Second).Should(Succeed())

			By("verifying the mutating webhook server is ready")
			verifyMutatingWebhookReady := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "mutatingwebhookconfigurations.admissionregistration.k8s.io",
					"paprika-mutating-webhook-configuration",
					"-o", "jsonpath={.webhooks[0].clientConfig.caBundle}")
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred(), "MutatingWebhookConfiguration should exist")
				g.Expect(output).ShouldNot(BeEmpty(), "Mutating webhook CA bundle not yet injected")
			}
			Eventually(verifyMutatingWebhookReady, 3*time.Minute, time.Second).Should(Succeed())

			By("verifying the validating webhook server is ready")
			verifyValidatingWebhookReady := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "validatingwebhookconfigurations.admissionregistration.k8s.io",
					"paprika-validating-webhook-configuration",
					"-o", "jsonpath={.webhooks[0].clientConfig.caBundle}")
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred(), "ValidatingWebhookConfiguration should exist")
				g.Expect(output).ShouldNot(BeEmpty(), "Validating webhook CA bundle not yet injected")
			}
			Eventually(verifyValidatingWebhookReady, 3*time.Minute, time.Second).Should(Succeed())

			By("waiting additional time for webhook server to stabilize")
			time.Sleep(5 * time.Second)

			// +kubebuilder:scaffold:e2e-metrics-webhooks-readiness

			By("creating the curl-metrics pod to access the metrics endpoint")
			cmd = exec.Command("kubectl", "run", "curl-metrics", "--restart=Never",
				"--namespace", namespace,
				"--image=curlimages/curl:latest",
				"--overrides",
				fmt.Sprintf(`{
					"spec": {
						"containers": [{
							"name": "curl",
							"image": "curlimages/curl:latest",
							"command": ["/bin/sh", "-c"],
							"args": [
								"for i in $(seq 1 30); do curl -v -k -H 'Authorization: Bearer %s' https://%s.%s.svc.cluster.local:8443/metrics && exit 0 || sleep 2; done; exit 1"
							],
							"securityContext": {
								"readOnlyRootFilesystem": true,
								"allowPrivilegeEscalation": false,
								"capabilities": {
									"drop": ["ALL"]
								},
								"runAsNonRoot": true,
								"runAsUser": 1000,
								"seccompProfile": {
									"type": "RuntimeDefault"
								}
							}
						}],
						"serviceAccountName": "%s"
					}
				}`, token, metricsServiceName, namespace, serviceAccountName))
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create curl-metrics pod")

			By("waiting for the curl-metrics pod to complete.")
			verifyCurlUp := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "pods", "curl-metrics",
					"-o", "jsonpath={.status.phase}",
					"-n", namespace)
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(Equal("Succeeded"), "curl pod in wrong status")
			}
			Eventually(verifyCurlUp, 5*time.Minute).Should(Succeed())

			By("getting the metrics by checking curl-metrics logs")
			verifyMetricsAvailable := func(g Gomega) {
				metricsOutput, err := getMetricsOutput()
				g.Expect(err).NotTo(HaveOccurred(), "Failed to retrieve logs from curl pod")
				g.Expect(metricsOutput).NotTo(BeEmpty())
				g.Expect(metricsOutput).To(ContainSubstring("< HTTP/1.1 200 OK"))
			}
			Eventually(verifyMetricsAvailable, 2*time.Minute).Should(Succeed())
		})

		It("should provisioned cert-manager", func() {
			By("validating that cert-manager has the certificate Secret")
			verifyCertManager := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "secrets", "webhook-server-cert", "-n", namespace)
				_, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
			}
			Eventually(verifyCertManager).Should(Succeed())
		})

		It("should have CA injection for mutating webhooks", func() {
			By("checking CA injection for mutating webhooks")
			verifyCAInjection := func(g Gomega) {
				cmd := exec.Command("kubectl", "get",
					"mutatingwebhookconfigurations.admissionregistration.k8s.io",
					"paprika-mutating-webhook-configuration",
					"-o", "go-template={{ range .webhooks }}{{ .clientConfig.caBundle }}{{ end }}")
				mwhOutput, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(len(mwhOutput)).To(BeNumerically(">", 10))
			}
			Eventually(verifyCAInjection).Should(Succeed())
		})

		It("should have CA injection for validating webhooks", func() {
			By("checking CA injection for validating webhooks")
			verifyCAInjection := func(g Gomega) {
				cmd := exec.Command("kubectl", "get",
					"validatingwebhookconfigurations.admissionregistration.k8s.io",
					"paprika-validating-webhook-configuration",
					"-o", "go-template={{ range .webhooks }}{{ .clientConfig.caBundle }}{{ end }}")
				vwhOutput, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(len(vwhOutput)).To(BeNumerically(">", 10))
			}
			Eventually(verifyCAInjection).Should(Succeed())
		})

		// +kubebuilder:scaffold:e2e-webhooks-checks
	})

	Context("Release", Ordered, func() {
		AfterAll(func() {
			By("cleaning up all Paprika CRDs")
			for _, resource := range []string{"releases", "stages", "templates", "pipelines", "artifacts"} {
				cmd := exec.Command("kubectl", "delete", resource, "--all", "-n", namespace, "--ignore-not-found", "--timeout=30s")
				_, _ = utils.Run(cmd)
			}

			By("cleaning up all derived resources created by releases")
			for _, label := range []string{
				"app.kubernetes.io/name=demo-app",
				"track=canary",
				"track=stable",
				"paprika.io/pipeline",
			} {
				for _, resource := range []string{"deployments", "services", "ingresses", "configmaps"} {
					cmd := exec.Command("kubectl", "delete", resource, "-n", namespace, "-l", label, "--ignore-not-found", "--timeout=10s")
					_, _ = utils.Run(cmd)
				}
			}

			By("cleaning up step jobs")
			cmd := exec.Command("kubectl", "delete", "jobs", "-n", namespace, "-l", "paprika.io/pipeline", "--ignore-not-found", "--timeout=10s")
			_, _ = utils.Run(cmd)

			By("cleaning up step pods")
			cmd = exec.Command("kubectl", "delete", "pods", "-n", namespace, "-l", "paprika.io/pipeline", "--ignore-not-found", "--timeout=10s")
			_, _ = utils.Run(cmd)

			By("verifying cleanup is complete")
			for _, resource := range []string{"releases", "stages", "templates"} {
				cmd := exec.Command("kubectl", "get", resource, "-n", namespace, "-o", "jsonpath={.items}")
				out, err := utils.Run(cmd)
				if err == nil {
					Expect(out).To(Equal("[]"), fmt.Sprintf("Expected no %s remaining after cleanup", resource))
				}
			}
		})

		It("should create a Template, Stage, and Release that reaches Complete", func() {
			By("creating a Template resource")
			template := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Template",
				"metadata": {"name": "e2e-template", "namespace": "%s"},
				"spec": {
					"type": "helm",
					"chart": {"path": "/charts/demo-app"}
				}
			}`, namespace)
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(template)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create template")

			By("creating a Stage resource")
			stage := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Stage",
				"metadata": {"name": "e2e-stage", "namespace": "%s"},
				"spec": {
					"name": "e2e-stage",
					"ring": 1,
					"templates": ["e2e-template"]
				}
			}`, namespace)
			cmd = exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(stage)
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create stage")

			By("creating a Release resource")
			release := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Release",
				"metadata": {"name": "e2e-release", "namespace": "%s"},
				"spec": {
					"pipeline": "e2e-pipeline",
					"target": "e2e-stage",
					"parameters": {
						"replicaCount": "1",
						"features.canary.enabled": "false",
						"features.monitoring.enabled": "false",
						"features.ingress.enabled": "false"
					}
				}
			}`, namespace)
			cmd = exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(release)
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create release")

			By("waiting for the release to reach Complete phase")
			verifyReleasePhase := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "release", "e2e-release",
					"-n", namespace, "-o", "jsonpath={.status.phase}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("Complete"), "Release should reach Complete phase")
			}
			Eventually(verifyReleasePhase, 2*time.Minute, 2*time.Second).Should(Succeed())

			By("verifying the rendered manifests were applied")
			verifyDeployment := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "deployment", "-n", namespace,
					"-l", "app.kubernetes.io/name=demo-app",
					"-o", "jsonpath={.items[*].metadata.name}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(ContainSubstring("stable"), "Expected stable deployment to exist")
			}
			Eventually(verifyDeployment, 60*time.Second, 2*time.Second).Should(Succeed())
		})

		It("should perform canary deployment with progressive traffic shifting and PDV analysis", func() {
			By("creating a canary Stage with analysis checks")
			canaryStage := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Stage",
				"metadata": {"name": "e2e-canary-stage", "namespace": "%s"},
				"spec": {
					"name": "e2e-canary-stage",
					"ring": 2,
					"templates": ["e2e-template"],
					"canary": {
						"steps": [25, 50, 100],
						"intervalSeconds": 5,
						"analysis": {
							"checks": [
								{"type": "podMetrics", "metric": "restartRate", "threshold": "5", "windowSeconds": 30}
							],
							"rollbackOnFail": true
						}
					}
				}
			}`, namespace)
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(canaryStage)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create canary stage")

			By("creating a Release targeting the canary Stage")
			release := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Release",
				"metadata": {"name": "e2e-canary-release", "namespace": "%s"},
				"spec": {
					"pipeline": "e2e-pipeline",
					"target": "e2e-canary-stage",
					"parameters": {
						"features.canary.enabled": "true",
						"features.monitoring.enabled": "false",
						"features.ingress.enabled": "true",
						"features.ingress.host": "e2e-canary.example.com",
						"replicaCount": "1"
					}
				}
			}`, namespace)
			cmd = exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(release)
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create canary release")

			By("waiting for the release to reach Canarying phase")
			verifyCanarying := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "release", "e2e-canary-release",
					"-n", namespace, "-o", "jsonpath={.status.phase}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Or(Equal("Canarying"), Equal("Verifying"), Equal("Complete")),
					"Release should be in canary or later phase")
			}
			Eventually(verifyCanarying, 60*time.Second, 2*time.Second).Should(Succeed())

			By("verifying canary Deployment exists during canary progression")
			verifyCanaryDeployment := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "deployment", "-n", namespace,
					"-l", "track=canary",
					"-o", "jsonpath={.items[*].metadata.name}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).NotTo(BeEmpty(), "Expected canary deployment to exist")
			}
			Eventually(verifyCanaryDeployment, 30*time.Second, 2*time.Second).Should(Succeed())

			By("waiting for the canary release to complete")
			verifyCanaryComplete := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "release", "e2e-canary-release",
					"-n", namespace, "-o", "jsonpath={.status.phase}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("Complete"), "Canary release should reach Complete")
			}
			Eventually(verifyCanaryComplete, 3*time.Minute, 2*time.Second).Should(Succeed())

			By("verifying canary promotion: canary resources cleaned up, stable Deployment remains")
			verifyCanaryCleanup := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "deployment", "-n", namespace,
					"-l", "track=canary", "-o", "jsonpath={.items}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("[]"), "Canary deployments should be cleaned up after promotion")

				cmd = exec.Command("kubectl", "get", "deployment", "-n", namespace,
					"-l", "track=stable", "-o", "jsonpath={.items[*].metadata.name}")
				out, err = utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(ContainSubstring("stable"), "Stable deployment should still exist")
			}
			Eventually(verifyCanaryCleanup, 30*time.Second, 2*time.Second).Should(Succeed())

			By("verifying canary Ingress cleaned up after promotion")
			verifyCanaryIngressCleanup := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "ingress", "-n", namespace,
					"-l", "track=canary", "-o", "jsonpath={.items}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("[]"), "Canary ingress should be cleaned up after promotion")
			}
			Eventually(verifyCanaryIngressCleanup, 15*time.Second, 2*time.Second).Should(Succeed())
		})

		It("should handle Gateway API traffic router gracefully when CRDs are absent", func() {
			By("creating a canary Stage with trafficRouter configured")
			gatewayStage := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Stage",
				"metadata": {"name": "e2e-gateway-stage", "namespace": "%s"},
				"spec": {
					"name": "e2e-gateway-stage",
					"ring": 4,
					"templates": ["e2e-template"],
					"canary": {
						"steps": [50, 100],
						"intervalSeconds": 5
					},
					"trafficRouter": {
						"provider": "gateway-api",
						"gatewayApi": {
							"httpRoute": "e2e-gateway-route"
						}
					}
				}
			}`, namespace)
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(gatewayStage)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create gateway canary stage")

			By("creating a Release targeting the gateway canary Stage")
			release := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Release",
				"metadata": {"name": "e2e-gateway-release", "namespace": "%s"},
				"spec": {
					"pipeline": "e2e-pipeline",
					"target": "e2e-gateway-stage",
					"parameters": {
						"features.canary.enabled": "true",
						"features.monitoring.enabled": "false",
						"features.ingress.enabled": "false",
						"replicaCount": "1"
					}
				}
			}`, namespace)
			cmd = exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(release)
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create gateway release")

			By("waiting for the release to reach Canarying phase (traffic router error expected)")
			verifyCanarying := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "release", "e2e-gateway-release",
					"-n", namespace, "-o", "jsonpath={.status.phase}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Or(Equal("Canarying"), Equal("Verifying"), Equal("Complete"), Equal("Failed")),
					"Release should reach a terminal or canary phase")
			}
			Eventually(verifyCanarying, 60*time.Second, 2*time.Second).Should(Succeed())

			By("verifying canary Deployment exists (nginx fallback works)")
			verifyCanaryDeployment := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "deployment", "-n", namespace,
					"-l", "track=canary", "-o", "jsonpath={.items[*].metadata.name}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).NotTo(BeEmpty(), "Expected canary deployment to exist despite traffic router error")
			}
			Eventually(verifyCanaryDeployment, 30*time.Second, 2*time.Second).Should(Succeed())

			By("cleaning up gateway canary resources")
			cmd = exec.Command("kubectl", "delete", "release", "e2e-gateway-release", "-n", namespace, "--ignore-not-found", "--timeout=10s")
			_, _ = utils.Run(cmd)
			cmd = exec.Command("kubectl", "delete", "stage", "e2e-gateway-stage", "-n", namespace, "--ignore-not-found", "--timeout=10s")
			_, _ = utils.Run(cmd)
		})

		It("should fail and roll back canary when PDV analysis fails", func() {
			By("creating a canary Stage with a failing HTTP check")
			failingStage := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Stage",
				"metadata": {"name": "e2e-failing-canary", "namespace": "%s"},
				"spec": {
					"name": "e2e-failing-canary",
					"ring": 3,
					"templates": ["e2e-template"],
					"canary": {
						"steps": [10, 100],
						"intervalSeconds": 5,
						"analysis": {
							"checks": [
								{"type": "http", "url": "http://this-url-does-not-exist-12345.invalid/health", "successThreshold": "100", "requestCount": 3, "timeoutSeconds": 2},
								{"type": "podMetrics", "metric": "restartRate", "threshold": "0", "windowSeconds": 30}
							],
							"rollbackOnFail": true
						}
					}
				}
			}`, namespace)
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(failingStage)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create failing canary stage")

			By("creating a Release targeting the failing canary Stage")
			release := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Release",
				"metadata": {"name": "e2e-failing-release", "namespace": "%s"},
				"spec": {
					"pipeline": "e2e-pipeline",
					"target": "e2e-failing-canary",
					"parameters": {
						"features.canary.enabled": "true",
						"features.monitoring.enabled": "false",
						"features.ingress.enabled": "false",
						"replicaCount": "1"
					}
				}
			}`, namespace)
			cmd = exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(release)
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create failing release")

			By("waiting for the release to fail due to analysis")
			verifyFailed := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "release", "e2e-failing-release",
					"-n", namespace, "-o", "jsonpath={.status.phase}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("Failed"), "Release should fail when PDV analysis fails")
			}
			Eventually(verifyFailed, 2*time.Minute, 2*time.Second).Should(Succeed())

			By("verifying the canary failure condition is recorded")
			cmd = exec.Command("kubectl", "get", "release", "e2e-failing-release",
				"-n", namespace, "-o", "jsonpath={.status.conditions[?(@.type==\"CanaryFailed\")].message}")
			out, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred())
			Expect(out).NotTo(BeEmpty(), "CanaryFailed condition should have a message")
		})
	})

	Context("Application", Ordered, func() {
		AfterAll(func() {
			By("cleaning up all Application and derived resources")
			cmd := exec.Command("kubectl", "delete", "application", "e2e-app", "-n", namespace, "--ignore-not-found", "--timeout=30s")
			_, _ = utils.Run(cmd)
			for _, resource := range []string{"releases", "stages", "pipelines", "templates"} {
				cmd := exec.Command("kubectl", "delete", resource, "-l", "app.paprika.io/name=e2e-app", "-n", namespace, "--ignore-not-found", "--timeout=10s")
				_, _ = utils.Run(cmd)
			}
			for _, resource := range []string{"deployments", "services", "ingresses", "configmaps", "jobs", "pods"} {
				cmd := exec.Command("kubectl", "delete", resource, "-n", namespace, "-l", "app.paprika.io/name=e2e-app", "--ignore-not-found", "--timeout=10s")
				_, _ = utils.Run(cmd)
			}
		})

		It("should create Template, Stage, and Release from Application spec and reach Healthy", func() {
			By("creating an Application resource")
			app := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Application",
				"metadata": {"name": "e2e-app", "namespace": "%s"},
				"spec": {
					"source": {"type": "helm", "chart": {"path": "/charts/demo-app"}},
					"stages": [
						{"name": "dev", "ring": 1}
					],
					"strategy": "Rolling",
					"syncPolicy": "Auto",
					"parameters": {
						"replicaCount": "1",
						"features.canary.enabled": "false",
						"features.monitoring.enabled": "false",
						"features.ingress.enabled": "false"
					}
				}
			}`, namespace)
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(app)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create Application")

			By("verifying owned Template was created")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "template", "e2e-app-template", "-n", namespace, "-o", "jsonpath={.spec.type}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("helm"))
			}, 30*time.Second, 2*time.Second).Should(Succeed())

			By("verifying owned Stage was created")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "stage", "e2e-app-dev", "-n", namespace, "-o", "jsonpath={.spec.name}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("dev"))
			}, 30*time.Second, 2*time.Second).Should(Succeed())

			By("verifying owned Release was created")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "release", "e2e-app-release", "-n", namespace, "-o", "jsonpath={.spec.target}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("e2e-app-dev"))
			}, 30*time.Second, 2*time.Second).Should(Succeed())

			By("waiting for the Application to reach Healthy phase")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "application", "e2e-app", "-n", namespace, "-o", "jsonpath={.status.phase}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("Healthy"), "Application should reach Healthy phase")
			}, 3*time.Minute, 2*time.Second).Should(Succeed())
		})
	})

	Context("ApplicationHealthCheck", Ordered, func() {
		AfterAll(func() {
			By("cleaning up Application health check resources")
			cmd := exec.Command("kubectl", "delete", "application", "e2e-health", "-n", namespace, "--ignore-not-found", "--timeout=30s")
			_, _ = utils.Run(cmd)
			for _, resource := range []string{"releases", "stages", "pipelines", "templates"} {
				cmd := exec.Command("kubectl", "delete", resource, "-l", "app.paprika.io/name=e2e-health", "-n", namespace, "--ignore-not-found", "--timeout=10s")
				_, _ = utils.Run(cmd)
			}
			for _, resource := range []string{"deployments", "services", "ingresses", "configmaps", "jobs", "pods"} {
				cmd := exec.Command("kubectl", "delete", resource, "-n", namespace, "-l", "app.paprika.io/name=e2e-health", "--ignore-not-found", "--timeout=10s")
				_, _ = utils.Run(cmd)
			}
		})

		It("should evaluate CEL health checks and populate health status", func() {
			By("creating an Application with health checks")
			app := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Application",
				"metadata": {"name": "e2e-health", "namespace": "%s"},
				"spec": {
					"source": {"type": "helm", "chart": {"path": "/charts/demo-app"}},
					"stages": [
						{"name": "dev", "ring": 1}
					],
					"strategy": "Rolling",
					"syncPolicy": "Auto",
					"parameters": {
						"replicaCount": "1",
						"features.canary.enabled": "false",
						"features.monitoring.enabled": "false",
						"features.ingress.enabled": "false"
					},
					"healthChecks": [
						{
							"name": "ready-check",
							"expression": "true"
						},
						{
							"name": "strategy-check",
							"expression": "app.strategy == 'Rolling'"
						}
					]
				}
			}`, namespace)
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(app)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create Application with health checks")

			By("waiting for the Application to reach Healthy phase")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "application", "e2e-health", "-n", namespace, "-o", "jsonpath={.status.phase}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("Healthy"), "Application should reach Healthy phase")
			}, 3*time.Minute, 2*time.Second).Should(Succeed())

			By("verifying health check results are populated")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "application", "e2e-health", "-n", namespace, "-o", "jsonpath={.status.health}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("Healthy"), "Overall health should be Healthy")
			}, 30*time.Second, 2*time.Second).Should(Succeed())

			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "application", "e2e-health", "-n", namespace, "-o", "jsonpath={.status.healthChecks[0].name}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("ready-check"))

				cmd = exec.Command("kubectl", "get", "application", "e2e-health", "-n", namespace, "-o", "jsonpath={.status.healthChecks[0].status}")
				out, err = utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("Healthy"))

				cmd = exec.Command("kubectl", "get", "application", "e2e-health", "-n", namespace, "-o", "jsonpath={.status.healthChecks[1].name}")
				out, err = utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("strategy-check"))

				cmd = exec.Command("kubectl", "get", "application", "e2e-health", "-n", namespace, "-o", "jsonpath={.status.healthChecks[1].status}")
				out, err = utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("Healthy"))
			}, 30*time.Second, 2*time.Second).Should(Succeed())
		})
	})

	Context("ApplicationSyncAndResync", Ordered, func() {
		AfterAll(func() {
			By("cleaning up sync Application resources")
			cmd := exec.Command("kubectl", "delete", "application", "e2e-sync", "-n", namespace, "--ignore-not-found", "--timeout=30s")
			_, _ = utils.Run(cmd)
			for _, resource := range []string{"releases", "stages", "pipelines", "templates"} {
				cmd := exec.Command("kubectl", "delete", resource, "-l", "app.paprika.io/name=e2e-sync", "-n", namespace, "--ignore-not-found", "--timeout=10s")
				_, _ = utils.Run(cmd)
			}
			for _, resource := range []string{"deployments", "services", "ingresses", "configmaps", "jobs", "pods"} {
				cmd := exec.Command("kubectl", "delete", resource, "-n", namespace, "-l", "app.paprika.io/name=e2e-sync", "--ignore-not-found", "--timeout=10s")
				_, _ = utils.Run(cmd)
			}
		})

		It("should sync application and detect source hash changes", func() {
			By("creating an Application with helm source")
			app := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Application",
				"metadata": {"name": "e2e-sync", "namespace": "%s"},
				"spec": {
					"source": {"type": "helm", "chart": {"path": "/charts/demo-app"}},
					"stages": [
						{"name": "dev", "ring": 1}
					],
					"strategy": "Rolling",
					"syncPolicy": "Auto",
					"parameters": {
						"replicaCount": "1",
						"features.canary.enabled": "false",
						"features.monitoring.enabled": "false",
						"features.ingress.enabled": "false"
					}
				}
			}`, namespace)
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(app)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create Application")

			By("waiting for the Application to reach Healthy phase")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "application", "e2e-sync", "-n", namespace, "-o", "jsonpath={.status.phase}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("Healthy"), "Application should reach Healthy phase")
			}, 3*time.Minute, 2*time.Second).Should(Succeed())

			By("verifying source hash and revision are populated")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "application", "e2e-sync", "-n", namespace, "-o", "jsonpath={.status.sourceHash}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).NotTo(BeEmpty(), "source hash should be populated")
			}, 60*time.Second, 2*time.Second).Should(Succeed())

			By("verifying owned Template has correct type")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "template", "e2e-sync-template", "-n", namespace, "-o", "jsonpath={.spec.type}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("helm"))
			}, 60*time.Second, 2*time.Second).Should(Succeed())

			By("verifying owned Release was created")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "release", "e2e-sync-release", "-n", namespace, "-o", "jsonpath={.spec.target}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("e2e-sync-dev"))
			}, 60*time.Second, 2*time.Second).Should(Succeed())
		})
	})

	Context("FullCICDFlow", Ordered, func() {
		AfterAll(func() {
			By("cleaning up full CI/CD resources")
			cmd := exec.Command("kubectl", "delete", "application", "e2e-cicd", "-n", namespace, "--ignore-not-found", "--timeout=30s")
			_, _ = utils.Run(cmd)
			for _, resource := range []string{"releases", "stages", "pipelines", "templates"} {
				cmd := exec.Command("kubectl", "delete", resource, "-l", "app.paprika.io/name=e2e-cicd", "-n", namespace, "--ignore-not-found", "--timeout=10s")
				_, _ = utils.Run(cmd)
			}
			for _, resource := range []string{"deployments", "services", "ingresses", "configmaps", "jobs", "pods"} {
				cmd := exec.Command("kubectl", "delete", resource, "-n", namespace, "-l", "app.paprika.io/name=e2e-cicd", "--ignore-not-found", "--timeout=10s")
				_, _ = utils.Run(cmd)
			}
		})

		It("should complete the full CI/CD lifecycle: create, build, promote, canary, verify, and reach Healthy", func() {
			By("creating an Application with build pipeline, canary strategy, and health checks")
			app := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Application",
				"metadata": {"name": "e2e-cicd", "namespace": "%s"},
				"spec": {
					"source": {"type": "helm", "chart": {"path": "/charts/demo-app"}},
					"build": {
						"steps": [
							{"name": "test", "image": "alpine:3.19", "script": "#!/bin/sh\necho tests passed"}
						]
					},
					"stages": [
						{
							"name": "dev",
							"ring": 1,
							"parameters": {"replicaCount": "1", "features.canary.enabled": "false", "features.monitoring.enabled": "false", "features.ingress.enabled": "false"}
						}
					],
					"strategy": "Rolling",
					"syncPolicy": "Auto",
					"parameters": {"image.tag": "latest"},
					"healthChecks": [
						{"name": "always-healthy", "expression": "true"}
					]
				}
			}`, namespace)
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(app)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create full CI/CD Application")

			By("verifying owned Pipeline is created from build spec")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "pipeline", "e2e-cicd-pipeline", "-n", namespace, "-o", "jsonpath={.spec.steps[0].name}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("test"))
			}, 30*time.Second, 2*time.Second).Should(Succeed())

			By("waiting for Pipeline to complete (Succeeded or not present if fast)")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "pipeline", "e2e-cicd-pipeline", "-n", namespace, "-o", "jsonpath={.status.phase}")
				out, err := utils.Run(cmd)
				if err != nil {
					g.Expect(err).NotTo(HaveOccurred())
					return
				}
				g.Expect(out).To(Or(Equal("Succeeded"), Equal("Running"), Equal("Pending")))
			}, 2*time.Minute, 3*time.Second).Should(Succeed())

			By("waiting for the Application to reach Healthy phase")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "application", "e2e-cicd", "-n", namespace, "-o", "jsonpath={.status.phase}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("Healthy"), "Application should reach Healthy phase")
			}, 5*time.Minute, 3*time.Second).Should(Succeed())

			By("verifying health check was evaluated")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "application", "e2e-cicd", "-n", namespace, "-o", "jsonpath={.status.health}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("Healthy"), "Application health should be Healthy")
			}, 30*time.Second, 2*time.Second).Should(Succeed())

			By("verifying source hash is populated")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "application", "e2e-cicd", "-n", namespace, "-o", "jsonpath={.status.sourceHash}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).NotTo(BeEmpty(), "sourceHash should be populated")
			}, 30*time.Second, 2*time.Second).Should(Succeed())

			By("verifying health check results")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "application", "e2e-cicd", "-n", namespace, "-o", "jsonpath={.status.healthChecks[0].name}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("always-healthy"))

				cmd = exec.Command("kubectl", "get", "application", "e2e-cicd", "-n", namespace, "-o", "jsonpath={.status.healthChecks[0].status}")
				out, err = utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("Healthy"))
			}, 30*time.Second, 2*time.Second).Should(Succeed())

			By("verifying a Deployment was created from the rendered manifests")
			cmd = exec.Command("kubectl", "get", "deployment", "-n", namespace, "-l", "app.paprika.io/name=e2e-cicd", "-o", "jsonpath={.items[0].metadata.name}")
			out, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred())
			Expect(out).NotTo(BeEmpty(), "A deployment should have been created by the release")
		})
	})

	Context("ApplicationDiff", Ordered, func() {
		AfterAll(func() {
			By("cleaning up diff Application resources")
			cmd := exec.Command("kubectl", "delete", "application", "e2e-diff", "-n", namespace, "--ignore-not-found", "--timeout=30s")
			_, _ = utils.Run(cmd)
			for _, resource := range []string{"releases", "stages", "pipelines", "templates"} {
				cmd := exec.Command("kubectl", "delete", resource, "-l", "app.paprika.io/name=e2e-diff", "-n", namespace, "--ignore-not-found", "--timeout=10s")
				_, _ = utils.Run(cmd)
			}
			for _, resource := range []string{"deployments", "services", "ingresses", "configmaps", "jobs", "pods"} {
				cmd := exec.Command("kubectl", "delete", resource, "-n", namespace, "-l", "app.paprika.io/name=e2e-diff", "--ignore-not-found", "--timeout=10s")
				_, _ = utils.Run(cmd)
			}
		})

		It("should detect diff and populate resource sync status", func() {
			By("creating an Application for diff testing")
			app := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Application",
				"metadata": {"name": "e2e-diff", "namespace": "%s"},
				"spec": {
					"source": {"type": "helm", "chart": {"path": "/charts/demo-app"}},
					"stages": [
						{"name": "dev", "ring": 1}
					],
					"strategy": "Rolling",
					"syncPolicy": "Auto",
					"parameters": {
						"replicaCount": "1",
						"features.canary.enabled": "false",
						"features.monitoring.enabled": "false",
						"features.ingress.enabled": "false"
					}
				}
			}`, namespace)
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(app)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create Application for diff")

			By("waiting for the Application to reach Healthy phase")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "application", "e2e-diff", "-n", namespace, "-o", "jsonpath={.status.phase}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("Healthy"), "Application should reach Healthy phase")
			}, 3*time.Minute, 2*time.Second).Should(Succeed())

			By("verifying resource sync status is populated")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "application", "e2e-diff", "-n", namespace, "-o", "jsonpath={.status.resources}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).NotTo(BeEmpty(), "Resource sync status should be populated")
			}, 2*time.Minute, 2*time.Second).Should(Succeed())

			By("verifying resource health is populated")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "application", "e2e-diff", "-n", namespace, "-o", "jsonpath={.status.resourceHealth}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).NotTo(BeEmpty(), "Resource health should be populated")
			}, 3*time.Minute, 2*time.Second).Should(Succeed())
		})
	})

	Context("ApplicationSelfHeal", Ordered, func() {
		AfterAll(func() {
			By("cleaning up self-heal Application resources")
			cmd := exec.Command("kubectl", "delete", "application", "e2e-self-heal", "-n", namespace, "--ignore-not-found", "--timeout=30s")
			_, _ = utils.Run(cmd)
			for _, resource := range []string{"releases", "stages", "pipelines", "templates"} {
				cmd := exec.Command("kubectl", "delete", resource, "-l", "app.paprika.io/name=e2e-self-heal", "-n", namespace, "--ignore-not-found", "--timeout=10s")
				_, _ = utils.Run(cmd)
			}
			for _, resource := range []string{"deployments", "services", "ingresses", "configmaps", "jobs", "pods"} {
				cmd := exec.Command("kubectl", "delete", resource, "-n", namespace, "-l", "app.paprika.io/name=e2e-self-heal", "--ignore-not-found", "--timeout=10s")
				_, _ = utils.Run(cmd)
			}
		})

		It("should auto-sync when managed resources drift and selfHeal is enabled", func() {
			By("creating an Application with self-heal enabled")
			app := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Application",
				"metadata": {"name": "e2e-self-heal", "namespace": "%s"},
				"spec": {
					"source": {"type": "helm", "chart": {"path": "/charts/demo-app"}},
					"stages": [
						{"name": "dev", "ring": 1}
					],
					"strategy": "Rolling",
					"syncPolicy": "Auto",
					"selfHeal": {
						"autoSyncOnDrift": true,
						"cooldown": "10s"
					},
					"parameters": {
						"replicaCount": "1",
						"features.canary.enabled": "false",
						"features.monitoring.enabled": "false",
						"features.ingress.enabled": "false"
					}
				}
			}`, namespace)
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(app)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create self-heal Application")

			By("waiting for the Application to reach Healthy phase")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "application", "e2e-self-heal", "-n", namespace, "-o", "jsonpath={.status.phase}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("Healthy"), "Application should reach Healthy phase")
			}, 3*time.Minute, 2*time.Second).Should(Succeed())

			By("finding the deployed Deployment name")
			var deploymentName string
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "deployment", "-n", namespace, "-l", "app.paprika.io/name=e2e-self-heal", "-o", "jsonpath={.items[0].metadata.name}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).NotTo(BeEmpty(), "A deployment should exist")
				deploymentName = out
			}, 60*time.Second, 2*time.Second).Should(Succeed())

			By("introducing drift by adding an extra label to the Deployment")
			cmd = exec.Command("kubectl", "label", "deployment", deploymentName, "-n", namespace, "e2e-self-heal-drift=true", "--overwrite")
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to label deployment for drift")

			By("waiting for the Application to report out-of-sync resources")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "application", "e2e-self-heal", "-n", namespace, "-o", "jsonpath={.status.outOfSync}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).NotTo(BeEmpty(), "outOfSync should be populated")
				g.Expect(out).NotTo(Equal("0"), "Application should report drift")
			}, 2*time.Minute, 2*time.Second).Should(Succeed())

			By("waiting for the current Release to be annotated for resync")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "release", "e2e-self-heal-release", "-n", namespace, "-o", "jsonpath={.metadata.annotations.paprika\\.io/resync}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).NotTo(BeEmpty(), "Release should be annotated for resync")
			}, 2*time.Minute, 2*time.Second).Should(Succeed())

			By("waiting for the SelfHealed condition to report DriftDetected")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "application", "e2e-self-heal", "-n", namespace, "-o", "jsonpath={.status.conditions[?(@.type=='SelfHealed')].reason}")
				out, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(out).To(Equal("DriftDetected"), "SelfHealed condition should report DriftDetected")
			}, 2*time.Minute, 2*time.Second).Should(Succeed())
		})
	})

	Context("DashboardUI", func() {
		fetchUI := func(url string) (*http.Response, error) {
			var lastErr error
			for i := 0; i < 5; i++ {
				resp, err := http.Get(url)
				if err == nil {
					return resp, nil
				}
				lastErr = err
				time.Sleep(time.Second)
			}
			return nil, lastErr
		}

		It("should serve the landing page", func() {
			By("requesting the landing page via port-forward")
			resp, err := fetchUI("http://localhost:4000/")
			Expect(err).NotTo(HaveOccurred(), "Failed to reach landing page")
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(http.StatusOK), "Landing page should return 200")

			By("checking that the response contains expected content")
			bodyBytes, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred(), "Failed to read landing page body")
			body := string(bodyBytes)
			Expect(body).To(ContainSubstring("Paprika"), "Landing page should contain title")
			Expect(body).To(ContainSubstring("Get Started"), "Landing page should contain CTA")
		})

		It("should serve the dashboard", func() {
			By("requesting the dashboard page via port-forward")
			resp, err := fetchUI("http://localhost:4000/dashboard/")
			Expect(err).NotTo(HaveOccurred(), "Failed to reach dashboard")
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(http.StatusOK), "Dashboard should return 200")

			By("checking that the response contains expected dashboard elements")
			bodyBytes, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred(), "Failed to read dashboard body")
			body := string(bodyBytes)
			Expect(body).To(ContainSubstring("Dashboard"), "Dashboard should contain the heading")
		})
	})

	Context("Metrics", func() {
		It("should expose custom Paprika metrics on the /metrics endpoint", func() {
			By("port-forwarding to the controller metrics service")
			metricsCmd := exec.Command("kubectl", "port-forward",
				"-n", namespace,
				"service/paprika-controller-manager-metrics-service",
				"8443:8443",
			)
			err := metricsCmd.Start()
			Expect(err).NotTo(HaveOccurred(), "Failed to start port-forward for metrics")
			defer func() {
				if metricsCmd.Process != nil {
					_ = metricsCmd.Process.Signal(syscall.SIGTERM)
					_, _ = metricsCmd.Process.Wait()
				}
			}()

			time.Sleep(3 * time.Second)

			By("creating a service account token for metrics access")
			token, err := serviceAccountToken()
			Expect(err).NotTo(HaveOccurred())

			By("querying the metrics endpoint")
			var metricsBody string
			Eventually(func(g Gomega) {
				client := &http.Client{
					Transport: &http.Transport{
						TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
					},
					Timeout: 10 * time.Second,
				}
				req, reqErr := http.NewRequest("GET", "https://localhost:8443/metrics", nil)
				g.Expect(reqErr).NotTo(HaveOccurred())
				req.Header.Set("Authorization", "Bearer "+token)
				resp, httpErr := client.Do(req)
				if httpErr != nil {
					g.Expect(httpErr).NotTo(HaveOccurred())
					return
				}
				defer resp.Body.Close()
				g.Expect(resp.StatusCode).To(Equal(http.StatusOK))
				body, readErr := io.ReadAll(resp.Body)
				g.Expect(readErr).NotTo(HaveOccurred())
				metricsBody = string(body)
			}, 2*time.Minute, 5*time.Second).Should(Succeed())

			By("verifying custom Paprika metrics are present")
			Expect(metricsBody).To(ContainSubstring("paprika_reconcile_total"),
				"Should expose paprika_reconcile_total metric")
			Expect(metricsBody).To(ContainSubstring("paprika_reconcile_duration_seconds"),
				"Should expose paprika_reconcile_duration_seconds metric")
			Expect(metricsBody).To(ContainSubstring("paprika_pipeline_phase_total"),
				"Should expose paprika_pipeline_phase_total metric")
			Expect(metricsBody).To(ContainSubstring("paprika_release_phase_total"),
				"Should expose paprika_release_phase_total metric")
			Expect(metricsBody).To(ContainSubstring("paprika_application_phase_total"),
				"Should expose paprika_application_phase_total metric")
			Expect(metricsBody).To(ContainSubstring("paprika_canary_weight_current"),
				"Should expose paprika_canary_weight_current metric")
			Expect(metricsBody).To(ContainSubstring("paprika_analysis_check_total"),
				"Should expose paprika_analysis_check_total metric")

			By("verifying reconcile metrics have been recorded for controllers")
			Expect(metricsBody).To(ContainSubstring(`paprika_reconcile_total{controller="pipeline"`),
				"Should have recorded pipeline reconcile metrics")
			Expect(metricsBody).To(ContainSubstring(`paprika_reconcile_total{controller="release"`),
				"Should have recorded release reconcile metrics")
			Expect(metricsBody).To(ContainSubstring(`paprika_reconcile_total{controller="application"`),
				"Should have recorded application reconcile metrics")

			By("verifying pipeline phase metrics show pipeline activity")
			Expect(metricsBody).To(ContainSubstring("paprika_pipeline_phase_total"),
				"Should have recorded pipeline phase transitions")
		})

		It("should expose metrics on the UI server /metrics endpoint", func() {
			By("requesting the /metrics endpoint from the UI server")
			var metricsBody string
			Eventually(func(g Gomega) {
				resp, err := http.Get("http://localhost:4000/metrics")
				g.Expect(err).NotTo(HaveOccurred())
				defer resp.Body.Close()
				g.Expect(resp.StatusCode).To(Equal(http.StatusOK))
				body, readErr := io.ReadAll(resp.Body)
				g.Expect(readErr).NotTo(HaveOccurred())
				metricsBody = string(body)
			}, 30*time.Second, 2*time.Second).Should(Succeed())

			By("verifying Paprika custom metrics are served on UI /metrics")
			Expect(metricsBody).To(ContainSubstring("paprika_reconcile_total"),
				"UI /metrics should expose paprika_reconcile_total")
			Expect(metricsBody).To(ContainSubstring("paprika_pipeline_phase_total"),
				"UI /metrics should expose paprika_pipeline_phase_total")
			Expect(metricsBody).To(ContainSubstring("paprika_release_phase_total"),
				"UI /metrics should expose paprika_release_phase_total")
		})
	})

	const apiNamespace = "paprika-api-system"
	const apiPort = 4001

	var apiPortForwardCmd *exec.Cmd

	Context("APIServer", Ordered, func() {
		BeforeAll(func() {
			By("creating api-server namespace")
			cmd := exec.Command("kubectl", "create", "ns", apiNamespace)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create api namespace")

			By("deploying the manager in api mode via Helm (CRDs already installed, skip)")
			cmd = exec.Command("helm", "upgrade", "--install", "paprika-api", "./charts/chart",
				"--namespace", apiNamespace,
				"--create-namespace",
				"--set", fmt.Sprintf("manager.image.repository=%s", strings.Split(managerImage, ":")[0]),
				"--set", fmt.Sprintf("manager.image.tag=%s", strings.Split(managerImage, ":")[1]),
				"--set", "mode=api",
				"--set", "metrics.enable=false",
				"--set", "crd.enable=false",
				"--wait",
				"--timeout", "3m",
			)
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to deploy api-mode via Helm")

			By("granting api service account access to list pipelines")
			saName := "paprika-api-controller-manager"
			rbacYAML := fmt.Sprintf(`---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: paprika-api-list-pipelines
rules:
- apiGroups: ["pipelines.paprika.io"]
  resources: ["pipelines", "applications"]
  verbs: ["get", "list", "update"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: paprika-api-list-pipelines
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: paprika-api-list-pipelines
subjects:
- kind: ServiceAccount
  name: %s
  namespace: %s
`, saName, apiNamespace)
			cmd = exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(rbacYAML)
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create api RBAC")

			By("starting port-forward for the api server (port 3000)")
			getDeploy := exec.Command("kubectl", "get", "deployment", "-n", apiNamespace,
				"-l", "control-plane=controller-manager", "-o", "name")
			deployName, err := utils.Run(getDeploy)
			Expect(err).NotTo(HaveOccurred(), "Failed to get api deployment name")
			pfCmd := exec.Command("kubectl", "port-forward", "-n", apiNamespace,
				strings.TrimSpace(deployName), fmt.Sprintf("%d:3000", apiPort))
			err = pfCmd.Start()
			Expect(err).NotTo(HaveOccurred(), "Failed to start port-forward for api server")
			apiPortForwardCmd = pfCmd

			By("waiting for the port-forward to be ready")
			verifyPortForward := func(g Gomega) {
				resp, err := http.Get(fmt.Sprintf("http://localhost:%d/", apiPort))
				g.Expect(err).NotTo(HaveOccurred(), "Port-forward not yet ready")
				defer resp.Body.Close()
				g.Expect(resp.StatusCode).To(Equal(http.StatusOK))
			}
			Eventually(verifyPortForward, 30*time.Second, time.Second).Should(Succeed())
		})

		AfterAll(func() {
			By("stopping port-forward for the api server")
			if apiPortForwardCmd != nil && apiPortForwardCmd.Process != nil {
				_ = apiPortForwardCmd.Process.Signal(syscall.SIGTERM)
				_, _ = apiPortForwardCmd.Process.Wait()
			}

			By("deleting the api RBAC")
			cmd := exec.Command("kubectl", "delete", "clusterrolebinding", "paprika-api-list-pipelines", "--ignore-not-found")
			_, _ = utils.Run(cmd)
			cmd = exec.Command("kubectl", "delete", "clusterrole", "paprika-api-list-pipelines", "--ignore-not-found")
			_, _ = utils.Run(cmd)

			By("uninstalling the api-mode Helm release")
			cmd = exec.Command("helm", "uninstall", "paprika-api", "--namespace", apiNamespace)
			_, _ = utils.Run(cmd)

			By("removing api namespace")
			cmd = exec.Command("kubectl", "delete", "ns", apiNamespace, "--ignore-not-found")
			_, _ = utils.Run(cmd)
		})

		It("should respond to health checks", func() {
			By("requesting the healthz endpoint")
			resp, err := http.Get(fmt.Sprintf("http://localhost:%d/healthz", apiPort))
			Expect(err).NotTo(HaveOccurred(), "Failed to reach healthz endpoint")
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(http.StatusOK), "healthz should return 200")
		})

		It("should serve the dashboard UI", func() {
			By("requesting the UI dashboard")
			resp, err := http.Get(fmt.Sprintf("http://localhost:%d/", apiPort))
			Expect(err).NotTo(HaveOccurred(), "Failed to reach UI dashboard")
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(http.StatusOK), "UI dashboard should return 200")

			By("checking for the expected title")
			bodyBytes, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred(), "Failed to read UI dashboard body")
			body := string(bodyBytes)
			Expect(body).To(ContainSubstring("Paprika"), "Dashboard should contain the title")
		})

		It("should serve the connect-gRPC API", func() {
			By("sending a POST to the PaprikaService RPC endpoint")
			resp, err := http.Post(
				fmt.Sprintf("http://localhost:%d/paprika.v1.PaprikaService/ListPipelines", apiPort),
				"application/json",
				strings.NewReader("{}"),
			)
			Expect(err).NotTo(HaveOccurred(), "Failed to call ListPipelines RPC")
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(http.StatusOK), "ListPipelines RPC should return 200")
		})

		It("should list applications with source and health fields via API", func() {
			By("creating an Application in the API namespace")
			app := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Application",
				"metadata": {"name": "e2e-api-app", "namespace": "%s"},
				"spec": {
					"source": {"type": "helm", "chart": {"path": "/charts/demo-app"}},
					"stages": [{"name": "dev", "ring": 1}],
					"strategy": "Rolling",
					"syncPolicy": "Auto"
				}
			}`, apiNamespace)
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(app)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create API test Application")
			defer func() {
				cmd := exec.Command("kubectl", "delete", "application", "e2e-api-app", "-n", apiNamespace, "--ignore-not-found", "--timeout=30s")
				_, _ = utils.Run(cmd)
			}()

			By("calling ListApplications RPC")
			resp, err := http.Post(
				fmt.Sprintf("http://localhost:%d/paprika.v1.PaprikaService/ListApplications", apiPort),
				"application/json",
				strings.NewReader("{}"),
			)
			Expect(err).NotTo(HaveOccurred(), "Failed to call ListApplications RPC")
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(http.StatusOK), "ListApplications RPC should return 200")

			body, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred())
			bodyStr := string(body)
			Expect(bodyStr).To(ContainSubstring("applications"), "Response should contain applications field")
			Expect(bodyStr).To(ContainSubstring("e2e-api-app"), "Response should include the API test application")
		})

		It("should accept SyncApplication RPC calls", func() {
			By("calling SyncApplication RPC for a non-existent application")
			resp, err := http.Post(
				fmt.Sprintf("http://localhost:%d/paprika.v1.PaprikaService/SyncApplication", apiPort),
				"application/json",
				strings.NewReader(`{"name": "nonexistent-app", "namespace": "default"}`),
			)
			Expect(err).NotTo(HaveOccurred(), "Failed to call SyncApplication RPC")
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(BeNumerically(">=", 200), "SyncApplication should accept requests")
		})
	})

	Context("PaprikaApply", func() {
		const applyTestNamespace = "e2e-apply-test"
		var manifestDir string

		BeforeEach(func() {
			By("building the paprika CLI")
			cmd := exec.Command("make", "build-cli")
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to build paprika CLI")

			By("creating the apply test namespace")
			cmd = exec.Command("kubectl", "create", "ns", applyTestNamespace)
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create apply test namespace")

			By("ensuring the default AppProject exists in the apply test namespace")
			defaultProject := fmt.Sprintf(`{
				"apiVersion": "core.paprika.io/v1alpha1",
				"kind": "AppProject",
				"metadata": {"name": "default", "namespace": "%s"},
				"spec": {
					"sourceRepos": ["*"],
					"destinations": [{"server": "*", "namespace": "*"}],
					"kinds": ["*"],
					"roles": [{"name": "default", "subjects": ["*"], "actions": ["read", "write"]}]
				}
			}`, applyTestNamespace)
			cmd = exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(defaultProject)
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create default AppProject in apply namespace")

			By("creating a temporary directory for apply manifests")
			manifestDir, err = os.MkdirTemp("", "paprika-apply-e2e-")
			Expect(err).NotTo(HaveOccurred(), "Failed to create manifest temp dir")
		})

		AfterEach(func() {
			if manifestDir != "" {
				_ = os.RemoveAll(manifestDir)
			}
			By("cleaning up the apply test namespace")
			cmd := exec.Command("kubectl", "delete", "ns", applyTestNamespace, "--ignore-not-found")
			_, _ = utils.Run(cmd)
		})

		It("should apply a raw manifest bundle and reach a healthy terminal phase", func() {
			manifest := fmt.Sprintf(`apiVersion: v1
kind: ConfigMap
metadata:
  name: e2e-inline-configmap
  namespace: %s
data:
  greeting: hello-from-paprika-apply
`, applyTestNamespace)
			manifestPath := filepath.Join(manifestDir, "configmap.yaml")
			Expect(os.WriteFile(manifestPath, []byte(manifest), 0o600)).To(Succeed())

			By("running paprika apply against the operator API")
			cmd := exec.Command("bin/paprika", "apply", "-f", manifestPath,
				"--name", "e2e-inline-apply",
				"--namespace", applyTestNamespace,
				"--server", "http://localhost:4000",
				"--timeout", "2m",
			)
			out, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "paprika apply failed: %s", out)
			Expect(out).To(ContainSubstring("e2e-inline-apply"))

			By("waiting for the Application to report a terminal phase")
			verifyAppPhase := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "application", "e2e-inline-apply",
					"-n", applyTestNamespace, "-o", "jsonpath={.status.phase}")
				phase, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(phase).To(Or(Equal("Healthy"), Equal("Degraded"), Equal("Failed")))
			}
			Eventually(verifyAppPhase, 2*time.Minute, 2*time.Second).Should(Succeed())

			By("checking that the Application reached Healthy")
			cmd = exec.Command("kubectl", "get", "application", "e2e-inline-apply",
				"-n", applyTestNamespace, "-o", "jsonpath={.status.phase}")
			phase, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred())
			Expect(phase).To(Equal("Healthy"), "Application should be Healthy")

			By("checking that the ConfigMap was applied")
			cmd = exec.Command("kubectl", "get", "configmap", "e2e-inline-configmap",
				"-n", applyTestNamespace, "-o", "jsonpath={.data.greeting}")
			value, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred())
			Expect(strings.TrimSpace(value)).To(Equal("hello-from-paprika-apply"))
		})
	})

	Context("PaprikaApply CLI", Ordered, func() {
		const applyCLINamespace = "default"
		var manifestDir string

		BeforeAll(func() {
			By("building the paprika CLI")
			cmd := exec.Command("make", "build-cli")
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to build paprika CLI")

			By("ensuring the default AppProject exists")
			defaultProject := `{
				"apiVersion": "core.paprika.io/v1alpha1",
				"kind": "AppProject",
				"metadata": {"name": "default", "namespace": "default"},
				"spec": {
					"sourceRepos": ["*"],
					"destinations": [{"server": "*", "namespace": "*"}],
					"kinds": ["*"],
					"roles": [{"name": "default", "subjects": ["*"], "actions": ["read", "write"]}]
				}
			}`
			cmd = exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(defaultProject)
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create default AppProject")

			By("creating a temporary directory for apply manifests")
			manifestDir, err = os.MkdirTemp("", "paprika-apply-cli-e2e-")
			Expect(err).NotTo(HaveOccurred(), "Failed to create manifest temp dir")
		})

		AfterAll(func() {
			if manifestDir != "" {
				_ = os.RemoveAll(manifestDir)
			}

			By("cleaning up the apply-e2e application")
			cmd := exec.Command("kubectl", "delete", "application", "apply-e2e", "-n", applyCLINamespace, "--ignore-not-found", "--timeout=30s")
			_, _ = utils.Run(cmd)

			By("cleaning up the apply-e2e stage")
			cmd = exec.Command("kubectl", "delete", "stage", "apply-e2e-default", "-n", applyCLINamespace, "--ignore-not-found", "--timeout=10s")
			_, _ = utils.Run(cmd)

			By("cleaning up the applied ConfigMap")
			cmd = exec.Command("kubectl", "delete", "configmap", "apply-e2e-configmap", "-n", applyCLINamespace, "--ignore-not-found", "--timeout=10s")
			_, _ = utils.Run(cmd)

			By("cleaning up the default AppProject")
			cmd = exec.Command("kubectl", "delete", "appproject", "default", "-n", applyCLINamespace, "--ignore-not-found", "--timeout=10s")
			_, _ = utils.Run(cmd)
		})

		It("should apply a raw manifest bundle via the CLI and reach a terminal phase", func() {
			manifest := `apiVersion: v1
kind: ConfigMap
metadata:
  name: apply-e2e-configmap
  namespace: default
data:
  greeting: hello-from-paprika-apply-cli
`
			manifestPath := filepath.Join(manifestDir, "configmap.yaml")
			Expect(os.WriteFile(manifestPath, []byte(manifest), 0o600)).To(Succeed())

			By("running paprika apply against the API server")
			cmd := exec.Command("bin/paprika", "apply", "-f", manifestPath,
				"--namespace", "default",
				"--name", "apply-e2e",
				"--wait",
				"--timeout", "5m",
				"--server", "http://localhost:4000",
			)
			out, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "paprika apply failed: %s", out)
			Expect(out).To(ContainSubstring("apply-e2e"))

			By("waiting for the Application to report a terminal phase")
			verifyAppPhase := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "application", "apply-e2e",
					"-n", applyCLINamespace, "-o", "jsonpath={.status.phase}")
				phase, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(phase).To(Or(Equal("Healthy"), Equal("Degraded"), Equal("Failed")))
			}
			Eventually(verifyAppPhase, 5*time.Minute, 2*time.Second).Should(Succeed())

			By("checking that the Application reached Healthy")
			cmd = exec.Command("kubectl", "get", "application", "apply-e2e",
				"-n", applyCLINamespace, "-o", "jsonpath={.status.phase}")
			phase, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred())
			Expect(phase).To(Equal("Healthy"), "Application should be Healthy")

			By("checking that the ConfigMap was applied")
			cmd = exec.Command("kubectl", "get", "configmap", "apply-e2e-configmap",
				"-n", applyCLINamespace, "-o", "jsonpath={.data.greeting}")
			value, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred())
			Expect(strings.TrimSpace(value)).To(Equal("hello-from-paprika-apply-cli"))
		})
	})
})

func serviceAccountToken() (string, error) {
	const tokenRequestRawString = `{
		"apiVersion": "authentication.k8s.io/v1",
		"kind": "TokenRequest"
	}`

	By("creating temporary file to store the token request")
	secretName := fmt.Sprintf("%s-token-request", serviceAccountName)
	tokenRequestFile := filepath.Join("/tmp", secretName)
	err := os.WriteFile(tokenRequestFile, []byte(tokenRequestRawString), os.FileMode(0o644))
	if err != nil {
		return "", err
	}

	var out string
	verifyTokenCreation := func(g Gomega) {
		By("executing kubectl command to create the token")
		cmd := exec.Command("kubectl", "create", "--raw", fmt.Sprintf(
			"/api/v1/namespaces/%s/serviceaccounts/%s/token",
			namespace,
			serviceAccountName,
		), "-f", tokenRequestFile)

		output, err := cmd.CombinedOutput()
		g.Expect(err).NotTo(HaveOccurred())

		By("parsing the JSON output to extract the token")
		var token tokenRequest
		err = json.Unmarshal(output, &token)
		g.Expect(err).NotTo(HaveOccurred())

		out = token.Status.Token
	}
	Eventually(verifyTokenCreation).Should(Succeed())

	return out, err
}

func getMetricsOutput() (string, error) {
	By("getting the curl-metrics logs")
	cmd := exec.Command("kubectl", "logs", "curl-metrics", "-n", namespace)
	return utils.Run(cmd)
}

type tokenRequest struct {
	Status struct {
		Token string `json:"token"`
	} `json:"status"`
}

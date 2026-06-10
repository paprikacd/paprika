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
	"encoding/json"
	"fmt"
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

var _ = Describe("Manager", Ordered, func() {
	var controllerPodName string

	BeforeAll(func() {
		By("creating manager namespace")
		cmd := exec.Command("kubectl", "create", "ns", namespace)
		_, err := utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to create namespace")

		By("labeling the namespace to enforce the restricted security policy")
		cmd = exec.Command("kubectl", "label", "--overwrite", "ns", namespace,
			"pod-security.kubernetes.io/enforce=restricted")
		_, err = utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to label namespace with restricted policy")

		By("installing CRDs")
		cmd = exec.Command("make", "install")
		_, err = utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to install CRDs")

		By("deploying the controller-manager (with embedded UI on :3000)")
		cmd = exec.Command("make", "deploy", fmt.Sprintf("IMG=%s", managerImage))
		_, err = utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to deploy the controller-manager")

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
		cmd = exec.Command("kubectl", "apply", "-f", "-")
		cmd.Stdin = strings.NewReader(demoApp)
		_, err = utils.Run(cmd)
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
	})

	AfterAll(func() {
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
		cmd = exec.Command("make", "uninstall")
		_, _ = utils.Run(cmd)

		By("removing manager namespace")
		cmd = exec.Command("kubectl", "delete", "ns", namespace, "--ignore-not-found")
		_, _ = utils.Run(cmd)
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

	Context("DashboardUI", func() {
		It("should serve the dashboard page", func() {
			By("requesting the UI dashboard via port-forward")
			resp, err := http.Get("http://localhost:4000/")
			Expect(err).NotTo(HaveOccurred(), "Failed to reach UI dashboard")
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(http.StatusOK), "UI dashboard should return 200")

			By("checking that the response contains expected dashboard elements")
			buf := make([]byte, 4096)
			n, err := resp.Body.Read(buf)
			Expect(err).To(Or(BeNil(), HaveOccurred())) // may EOF after reading
			body := string(buf[:n])
			Expect(body).To(ContainSubstring("Paprika"), "Dashboard should contain the title")
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
  resources: ["pipelines"]
  verbs: ["get", "list"]
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
			buf := make([]byte, 4096)
			n, err := resp.Body.Read(buf)
			Expect(err).To(Or(BeNil(), HaveOccurred()))
			body := string(buf[:n])
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

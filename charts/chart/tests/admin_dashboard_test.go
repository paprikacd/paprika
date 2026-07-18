package charttests

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
	k8syaml "k8s.io/apimachinery/pkg/util/yaml"
)

const (
	releaseName       = "admin"
	releaseNamespace  = "admin-system"
	defaultSA         = "admin-paprika-controller-manager"
	adminDashboardSA  = "admin-paprika-admin-dashboard"
	adminDashboardArg = "--admin-dashboard-enabled"
	adminReviewRole   = "admin-paprika-admin-dashboard-reviewer"
)

type manifest map[string]any

func TestAdminDashboardValueIsOptIn(t *testing.T) {
	values := readYAMLFile(t, filepath.Join(chartRoot(t), "values.yaml"))
	admin := object(t, values["adminDashboard"], "adminDashboard")
	if len(admin) != 1 {
		t.Fatalf("adminDashboard must contain only enabled, got keys %v", sortedKeys(admin))
	}
	if enabled, ok := admin["enabled"].(bool); !ok || enabled {
		t.Fatalf("adminDashboard.enabled must default to false, got %#v", admin["enabled"])
	}

	testValues := readYAMLFile(t, filepath.Join(repoRoot(t), "deploy", "test-values.yaml"))
	testAdmin := object(t, testValues["adminDashboard"], "deploy/test-values.yaml adminDashboard")
	if enabled, ok := testAdmin["enabled"].(bool); !ok || !enabled {
		t.Fatalf("deploy/test-values.yaml must enable adminDashboard, got %#v", testAdmin["enabled"])
	}
}

func TestAdminDashboardEnabledRequiresBoolean(t *testing.T) {
	cases := []struct {
		name string
		args []string
	}{
		{
			name: "quoted-false",
			args: []string{"--set-string", "adminDashboard.enabled=false"},
		},
		{
			name: "quoted-false-without-manager-workload",
			args: []string{
				"--set-string", "adminDashboard.enabled=false",
				"--set", "manager.enabled=false",
			},
		},
		{
			name: "junk-string",
			args: []string{"--set-string", "adminDashboard.enabled=enabled"},
		},
		{
			name: "number",
			args: []string{"--set", "adminDashboard.enabled=1"},
		},
		{
			name: "object",
			args: []string{"--set-json", `adminDashboard.enabled={"unexpected":true}`},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			output := renderChartFailure(t, tc.args...)
			if !strings.Contains(output, "adminDashboard.enabled must be a boolean") {
				t.Fatalf("Helm failure does not contain stable type error:\n%s", output)
			}
		})
	}
}

func TestAdminDashboardRejectsRemoteClusterClient(t *testing.T) {
	const incompatibility = "adminDashboard.enabled cannot be used with monolith mode=api and remoteCluster.apiServer"
	t.Run("remote-api/deployment", func(t *testing.T) {
		output := renderChartFailure(t,
			"--set", "deploymentMode=monolith",
			"--set", "mode=api",
			"--set", "adminDashboard.enabled=true",
			"--set", "manager.sharding.enabled=false",
			"--set", "remoteCluster.apiServer=https://remote.example.invalid",
		)
		if !strings.Contains(output, incompatibility) {
			t.Fatalf("Helm failure does not contain stable remote-client error:\n%s", output)
		}
		if !strings.Contains(output, "local pod-forward review cannot use the remote cluster client") {
			t.Fatalf("Helm failure does not explain the trust mismatch:\n%s", output)
		}
	})

	t.Run("remote-api/sharded-operator", func(t *testing.T) {
		_, objects := renderChart(t,
			"--set", "deploymentMode=monolith",
			"--set", "mode=api",
			"--set", "adminDashboard.enabled=true",
			"--set", "manager.sharding.enabled=true",
			"--set", "remoteCluster.apiServer=https://remote.example.invalid",
			"--set", "remoteCluster.tokenFile=/var/run/secrets/remote-token",
		)
		assertAdminDashboardWorkloads(t, objects, map[string]bool{"manager": true})
		assertAdminDashboardRBAC(t, objects, true)
		workload := requireManifest(t, objects, "StatefulSet", "admin-paprika-controller-manager")
		assertContainerLacksRemoteClientArgs(t, workload, "manager")
	})

	t.Run("remote-api/manager-disabled", func(t *testing.T) {
		_, objects := renderChart(t,
			"--set", "deploymentMode=monolith",
			"--set", "mode=api",
			"--set", "adminDashboard.enabled=true",
			"--set", "manager.enabled=false",
			"--set", "remoteCluster.apiServer=https://remote.example.invalid",
		)
		assertAdminDashboardWorkloads(t, objects, map[string]bool{})
		assertAdminDashboardRBAC(t, objects, false)
	})

	for _, sharded := range []bool{false, true} {
		t.Run("token-file-only/sharded="+strconv.FormatBool(sharded), func(t *testing.T) {
			_, objects := renderChart(t,
				"--set", "deploymentMode=monolith",
				"--set", "mode=api",
				"--set", "adminDashboard.enabled=true",
				"--set", "manager.sharding.enabled="+strconv.FormatBool(sharded),
				"--set", "remoteCluster.tokenFile=/var/run/secrets/remote-token",
			)
			assertAdminDashboardWorkloads(t, objects, map[string]bool{"manager": true})
		})

		t.Run("disabled-remote-api/sharded="+strconv.FormatBool(sharded), func(t *testing.T) {
			_, objects := renderChart(t,
				"--set", "deploymentMode=monolith",
				"--set", "mode=api",
				"--set", "adminDashboard.enabled=false",
				"--set", "manager.sharding.enabled="+strconv.FormatBool(sharded),
				"--set", "remoteCluster.apiServer=https://remote.example.invalid",
			)
			assertAdminDashboardWorkloads(t, objects, map[string]bool{})
		})
	}

	t.Run("split-is-not-rejected", func(t *testing.T) {
		_, objects := renderChart(t,
			"--set", "deploymentMode=split",
			"--set", "mode=api",
			"--set", "adminDashboard.enabled=true",
			"--set", "remoteCluster.apiServer=https://remote.example.invalid",
			"--set", "remoteCluster.tokenFile=/var/run/secrets/remote-token",
		)
		assertAdminDashboardWorkloads(t, objects, map[string]bool{
			"manager":    true,
			"api-server": true,
		})
	})
}

func TestAdminDashboardEligibilityMatrix(t *testing.T) {
	modes := []string{"operator", "api", "webhook", "repo-server", "agent"}
	for _, deploymentMode := range []string{"monolith", "split"} {
		for _, mode := range modes {
			if deploymentMode == "split" && mode != "operator" {
				continue
			}
			for _, sharded := range []bool{false, true} {
				for _, enabled := range []bool{false, true} {
					name := strings.Join([]string{
						deploymentMode,
						"mode=" + mode,
						"sharded=" + strconv.FormatBool(sharded),
						"enabled=" + strconv.FormatBool(enabled),
					}, "/")
					t.Run(name, func(t *testing.T) {
						_, objects := renderChart(t,
							"--set", "deploymentMode="+deploymentMode,
							"--set", "mode="+mode,
							"--set", "manager.sharding.enabled="+strconv.FormatBool(sharded),
							"--set", "adminDashboard.enabled="+strconv.FormatBool(enabled),
							"--set", "repoServer.enabled=true",
							"--set", "agent.enabled=true",
						)
						eligible := expectedEligibleContainers(deploymentMode, mode, enabled)
						assertNoPort3001Exposure(t, objects)
						assertAdminDashboardWorkloads(t, objects, eligible)
						assertAdminDashboardRBAC(t, objects, len(eligible) > 0)
					})
				}
			}
		}
	}
}

func TestAdminDashboardDisabledRenderIsByteExact(t *testing.T) {
	for _, deploymentMode := range []string{"monolith", "split"} {
		for _, mode := range []string{"operator", "api", "webhook", "repo-server", "agent"} {
			if deploymentMode == "split" && mode != "operator" {
				continue
			}
			for _, sharded := range []bool{false, true} {
				name := strings.Join([]string{
					deploymentMode,
					"mode=" + mode,
					"sharded=" + strconv.FormatBool(sharded),
				}, "/")
				t.Run(name, func(t *testing.T) {
					args := []string{
						"--set", "deploymentMode=" + deploymentMode,
						"--set", "mode=" + mode,
						"--set", "manager.sharding.enabled=" + strconv.FormatBool(sharded),
					}
					implicit, _ := renderChart(t, args...)
					explicit, _ := renderChart(t, append(args,
						"--set", "adminDashboard.enabled=false")...)
					if implicit != explicit {
						t.Errorf("default-disabled render differs from explicit false")
					}
				})
			}
		}
	}
}

func TestAdminDashboardExposureSurfaces(t *testing.T) {
	cases := []struct {
		name         string
		args         []string
		expectedKind map[string]int
	}{
		{
			name: "standard-ingress",
			args: []string{
				"--set", "apiServer.ingress.enabled=true",
				"--set", "apiServer.ingress.type=ingress",
				"--set", "apiServer.ingress.hosts[0].host=api.example.com",
				"--set", "apiServer.ingress.hosts[0].paths[0].path=/",
				"--set", "apiServer.ingress.hosts[0].paths[0].pathType=Prefix",
				"--set", "webhookReceiver.ingress.enabled=true",
				"--set", "webhookReceiver.ingress.type=ingress",
				"--set", "webhookReceiver.ingress.ingress.hostname=hooks.example.com",
			},
			expectedKind: map[string]int{"Ingress": 2, "NetworkPolicy": 1, "Service": 1},
		},
		{
			name: "gateway-api",
			args: []string{
				"--set", "apiServer.ingress.enabled=true",
				"--set", "apiServer.ingress.type=gateway-api",
				"--set", "apiServer.ingress.gateway.gatewayRef.name=public",
				"--set", "apiServer.ingress.gateway.gatewayRef.namespace=gateway-system",
				"--set", "apiServer.ingress.gateway.hostname=api.example.com",
				"--set", "webhookReceiver.ingress.enabled=true",
				"--set", "webhookReceiver.ingress.type=gateway-api",
				"--set", "webhookReceiver.ingress.gateway.gatewayRef.name=public",
				"--set", "webhookReceiver.ingress.gateway.gatewayRef.namespace=gateway-system",
				"--set", "webhookReceiver.ingress.gateway.hostname=hooks.example.com",
			},
			expectedKind: map[string]int{"HTTPRoute": 2, "NetworkPolicy": 1, "Service": 1},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			args := []string{
				"--set", "deploymentMode=split",
				"--set", "adminDashboard.enabled=true",
				"--set", "networkPolicy.enabled=true",
				"--set", "repoServer.enabled=true",
				"--set", "agent.enabled=true",
			}
			_, objects := renderChart(t, append(args, tc.args...)...)
			assertKindsAtLeast(t, objects, tc.expectedKind)
			assertNoPort3001Exposure(t, objects)
		})
	}
}

func TestAdminDashboardServiceAccountMetadata(t *testing.T) {
	_, objects := renderChart(t,
		"--set", "adminDashboard.enabled=true",
		"--set-string", "serviceAccount.labels.team=platform",
		"--set-string", `serviceAccount.labels.app\.kubernetes\.io/name=forbidden`,
		"--set-string", `serviceAccount.labels.app\.kubernetes\.io/managed-by=forbidden`,
		"--set-string", `serviceAccount.annotations.example\.com/owner=chart-test`,
	)
	sa := requireManifest(t, objects, "ServiceAccount", adminDashboardSA)
	labels := object(t, path(sa, "metadata", "labels"), "admin ServiceAccount labels")
	annotations := object(t, path(sa, "metadata", "annotations"), "admin ServiceAccount annotations")
	if stringValue(labels["team"]) != "platform" {
		t.Errorf("dedicated ServiceAccount did not preserve custom label")
	}
	if stringValue(annotations["example.com/owner"]) != "chart-test" {
		t.Errorf("dedicated ServiceAccount did not preserve custom annotation")
	}
	if got := stringValue(labels["app.kubernetes.io/name"]); got != "paprika" {
		t.Errorf("reserved name label override was accepted: %q", got)
	}
	if got := stringValue(labels["app.kubernetes.io/managed-by"]); got != "Helm" {
		t.Errorf("reserved managed-by label override was accepted: %q", got)
	}
}

func TestAdminDashboardNamespacedRBAC(t *testing.T) {
	_, objects := renderChart(t,
		"--set", "deploymentMode=split",
		"--set", "adminDashboard.enabled=true",
		"--set", "rbac.namespaced=true",
	)
	assertAdminDashboardRBAC(t, objects, true)
	binding := requireManifest(t, objects, "RoleBinding", "admin-paprika-manager-rolebinding")
	if !bindingHasServiceAccount(t, binding, adminDashboardSA) {
		t.Errorf("namespaced manager RoleBinding does not include admin ServiceAccount")
	}
	assertExactReviewRules(t, requireManifest(t, objects, "ClusterRole", adminReviewRole))
}

func TestAdminDashboardEligiblePodsHaveCredentials(t *testing.T) {
	for _, deploymentMode := range []string{"monolith", "split"} {
		modes := []string{"operator"}
		if deploymentMode == "monolith" {
			modes = append(modes, "api")
		}
		for _, mode := range modes {
			for _, sharded := range []bool{false, true} {
				for _, enabled := range []bool{false, true} {
					name := strings.Join([]string{
						deploymentMode,
						"mode=" + mode,
						"sharded=" + strconv.FormatBool(sharded),
						"enabled=" + strconv.FormatBool(enabled),
					}, "/")
					t.Run(name, func(t *testing.T) {
						_, objects := renderChart(t,
							"--set", "deploymentMode="+deploymentMode,
							"--set", "mode="+mode,
							"--set", "manager.sharding.enabled="+strconv.FormatBool(sharded),
							"--set", "adminDashboard.enabled="+strconv.FormatBool(enabled),
							"--set", "manager.automountServiceAccountToken=false",
							"--set", "apiServer.automountServiceAccountToken=false",
						)
						expected := map[string]bool{"manager": enabled}
						if deploymentMode == "split" {
							expected["api-server"] = enabled
						}
						assertAutomountForContainers(t, objects, expected)
					})
				}
			}
		}
	}

	t.Run("ineligible-preserves-false", func(t *testing.T) {
		_, objects := renderChart(t,
			"--set", "deploymentMode=monolith",
			"--set", "mode=webhook",
			"--set", "adminDashboard.enabled=true",
			"--set", "manager.automountServiceAccountToken=false",
		)
		assertAutomountForContainers(t, objects, map[string]bool{"manager": false})
	})

	t.Run("disabled-preserves-true", func(t *testing.T) {
		_, objects := renderChart(t,
			"--set", "deploymentMode=split",
			"--set", "adminDashboard.enabled=false",
			"--set", "manager.automountServiceAccountToken=true",
			"--set", "apiServer.automountServiceAccountToken=true",
		)
		assertAutomountForContainers(t, objects, map[string]bool{
			"manager":    true,
			"api-server": true,
		})
	})
}

func TestAdminDashboardIdentityRequiresEligibleWorkload(t *testing.T) {
	t.Run("monolith-manager-disabled", func(t *testing.T) {
		_, objects := renderChart(t,
			"--set", "deploymentMode=monolith",
			"--set", "mode=operator",
			"--set", "adminDashboard.enabled=true",
			"--set", "manager.enabled=false",
		)
		assertAdminDashboardWorkloads(t, objects, map[string]bool{})
		assertAdminDashboardRBAC(t, objects, false)
	})

	t.Run("split-api-remains-eligible", func(t *testing.T) {
		_, objects := renderChart(t,
			"--set", "deploymentMode=split",
			"--set", "adminDashboard.enabled=true",
			"--set", "manager.enabled=false",
		)
		expected := map[string]bool{"api-server": true}
		assertAdminDashboardWorkloads(t, objects, expected)
		assertAdminDashboardRBAC(t, objects, true)
	})
}

func expectedEligibleContainers(deploymentMode, mode string, enabled bool) map[string]bool {
	eligible := map[string]bool{}
	if !enabled {
		return eligible
	}
	if deploymentMode == "split" {
		eligible["manager"] = true
		eligible["api-server"] = true
		return eligible
	}
	if mode == "operator" || mode == "api" {
		eligible["manager"] = true
	}
	return eligible
}

func assertKindsAtLeast(t *testing.T, objects []manifest, expected map[string]int) {
	t.Helper()
	counts := map[string]int{}
	for _, obj := range objects {
		counts[stringValue(obj["kind"])]++
	}
	for kind, minimum := range expected {
		if counts[kind] < minimum {
			t.Errorf("rendered %d %s objects, want at least %d", counts[kind], kind, minimum)
		}
	}
}

func requireManifest(t *testing.T, objects []manifest, kind, name string) manifest {
	t.Helper()
	for _, obj := range objects {
		if stringValue(obj["kind"]) == kind && stringValue(path(obj, "metadata", "name")) == name {
			return obj
		}
	}
	t.Fatalf("%s %q was not rendered", kind, name)
	return nil
}

func bindingHasServiceAccount(t *testing.T, binding manifest, serviceAccount string) bool {
	t.Helper()
	for _, subject := range list(t, binding["subjects"], "binding subjects") {
		item := object(t, subject, "binding subject")
		if stringValue(item["kind"]) == "ServiceAccount" &&
			stringValue(item["name"]) == serviceAccount &&
			stringValue(item["namespace"]) == releaseNamespace {
			return true
		}
	}
	return false
}

func assertContainerLacksRemoteClientArgs(t *testing.T, workload manifest, containerName string) {
	t.Helper()
	spec, ok := podSpec(workload)
	if !ok {
		t.Fatalf("%s %q has no pod spec", workload["kind"], path(workload, "metadata", "name"))
	}
	for _, value := range list(t, spec["containers"], "containers") {
		container := object(t, value, "container")
		if stringValue(container["name"]) != containerName {
			continue
		}
		for _, arg := range stringList(t, container["args"]) {
			if strings.HasPrefix(arg, "--k8s-api-server=") ||
				strings.HasPrefix(arg, "--k8s-token-file=") {
				t.Errorf("%s unexpectedly wires remote client argument %q", containerName, arg)
			}
		}
		return
	}
	t.Errorf("container %q was not rendered", containerName)
}

func assertAutomountForContainers(
	t *testing.T,
	objects []manifest,
	expected map[string]bool,
) {
	t.Helper()
	seen := map[string]bool{}
	for _, obj := range objects {
		spec, ok := podSpec(obj)
		if !ok {
			continue
		}
		for _, value := range list(t, spec["containers"], "containers") {
			name := stringValue(object(t, value, "container")["name"])
			if name != "manager" && name != "api-server" {
				continue
			}
			seen[name] = true
			got, ok := spec["automountServiceAccountToken"].(bool)
			if !ok {
				t.Errorf("%s automountServiceAccountToken is %#v, want boolean", name,
					spec["automountServiceAccountToken"])
				continue
			}
			want, shouldCheck := expected[name]
			if !shouldCheck {
				continue
			}
			if got != want {
				t.Errorf("%s automountServiceAccountToken=%t, want %t", name, got, want)
			}
		}
	}
	for name := range expected {
		if !seen[name] {
			t.Errorf("eligible %s container was not rendered for automount assertion", name)
		}
	}
}

func assertAdminDashboardWorkloads(
	t *testing.T,
	objects []manifest,
	expectedEligible map[string]bool,
) {
	t.Helper()
	seenEligible := map[string]bool{}

	for _, obj := range objects {
		spec, ok := podSpec(obj)
		if !ok {
			continue
		}
		workloadName := stringValue(path(obj, "metadata", "name"))
		containers := list(t, spec["containers"], workloadName+" containers")
		for _, item := range containers {
			container := object(t, item, workloadName+" container")
			containerName := stringValue(container["name"])
			eligibleKey := ""
			switch containerName {
			case "manager":
				eligibleKey = "manager"
			case "api-server":
				eligibleKey = "api-server"
			}
			args := stringList(t, container["args"])
			hasArg := contains(args, adminDashboardArg)
			env := environment(t, container["env"])

			if eligibleKey == "" || !expectedEligible[eligibleKey] {
				if hasArg {
					t.Errorf("%s/%s is not eligible but has %s", workloadName, containerName, adminDashboardArg)
				}
				assertNoAdminIdentityEnv(t, workloadName, containerName, env)
				if stringValue(spec["serviceAccountName"]) != defaultSA {
					t.Errorf("%s/%s is not eligible but uses ServiceAccount %q, want %q",
						workloadName, containerName, stringValue(spec["serviceAccountName"]), defaultSA)
				}
				continue
			}
			if seenEligible[eligibleKey] {
				t.Errorf("eligible container %q rendered more than once", eligibleKey)
			}
			seenEligible[eligibleKey] = true
			if len(containers) != 1 {
				t.Errorf("%s has regular containers %v; admin-enabled pods must have exactly the chart inventory",
					workloadName, containerNames(t, containers))
			}

			assertEligibleContainer(t, workloadName, containerName,
				stringValue(spec["serviceAccountName"]), hasArg, env)
		}
	}

	for key := range expectedEligible {
		if !seenEligible[key] {
			t.Errorf("eligible %s container was not rendered", key)
		}
	}
}

func assertEligibleContainer(
	t *testing.T,
	workloadName string,
	containerName string,
	serviceAccount string,
	hasArg bool,
	env map[string]map[string]any,
) {
	t.Helper()
	if !hasArg {
		t.Errorf("%s/%s missing %s", workloadName, containerName, adminDashboardArg)
	}
	if serviceAccount != adminDashboardSA {
		t.Errorf("%s uses ServiceAccount %q, want %q", workloadName, serviceAccount, adminDashboardSA)
	}
	assertAdminIdentityEnv(t, workloadName, containerName, env)
}

func assertAdminIdentityEnv(
	t *testing.T,
	workloadName string,
	containerName string,
	env map[string]map[string]any,
) {
	t.Helper()
	fieldPaths := map[string]string{
		"POD_NAMESPACE":       "metadata.namespace",
		"POD_NAME":            "metadata.name",
		"POD_UID":             "metadata.uid",
		"POD_SERVICE_ACCOUNT": "spec.serviceAccountName",
	}
	for name, want := range fieldPaths {
		got := stringValue(path(env[name], "valueFrom", "fieldRef", "fieldPath"))
		if got != want {
			t.Errorf("%s/%s env %s fieldPath=%q, want %q",
				workloadName, containerName, name, got, want)
		}
	}
	expected := stringValue(env["PAPRIKA_ADMIN_EXPECTED_CONTAINER"]["value"])
	if expected != containerName {
		t.Errorf("%s/%s expected-container env=%q, want %q",
			workloadName, containerName, expected, containerName)
	}
}

func assertNoAdminIdentityEnv(
	t *testing.T,
	workloadName string,
	containerName string,
	env map[string]map[string]any,
) {
	t.Helper()
	for _, name := range []string{
		"POD_NAMESPACE",
		"POD_UID",
		"POD_SERVICE_ACCOUNT",
		"PAPRIKA_ADMIN_EXPECTED_CONTAINER",
	} {
		if _, ok := env[name]; ok {
			t.Errorf("%s/%s has admin identity env %s while ineligible or disabled",
				workloadName, containerName, name)
		}
	}
}

type adminRBACInventory struct {
	serviceAccounts         map[string]bool
	adminOperationalRoles   map[string]bool
	defaultOperationalRoles map[string]bool
	reviewRole              manifest
	reviewBindingFound      bool
}

func collectAdminRBAC(t *testing.T, objects []manifest) adminRBACInventory {
	t.Helper()
	inventory := adminRBACInventory{
		serviceAccounts:         map[string]bool{},
		adminOperationalRoles:   map[string]bool{},
		defaultOperationalRoles: map[string]bool{},
	}
	for _, obj := range objects {
		kind := stringValue(obj["kind"])
		name := stringValue(path(obj, "metadata", "name"))
		switch kind {
		case "ServiceAccount":
			inventory.serviceAccounts[name] = true
		case "RoleBinding", "ClusterRoleBinding":
			roleName := stringValue(path(obj, "roleRef", "name"))
			for _, subject := range list(t, obj["subjects"], name+" subjects") {
				s := object(t, subject, name+" subject")
				if stringValue(s["kind"]) != "ServiceAccount" ||
					stringValue(s["namespace"]) != releaseNamespace {
					continue
				}
				switch stringValue(s["name"]) {
				case adminDashboardSA:
					inventory.adminOperationalRoles[roleName] = true
				case defaultSA:
					inventory.defaultOperationalRoles[roleName] = true
				}
			}
			if roleName == adminReviewRole {
				inventory.reviewBindingFound = true
			}
		case "ClusterRole":
			if name == adminReviewRole {
				inventory.reviewRole = obj
			}
		}
	}
	return inventory
}

func assertAdminDashboardRBAC(t *testing.T, objects []manifest, enabled bool) {
	t.Helper()
	inventory := collectAdminRBAC(t, objects)

	if !enabled {
		if inventory.serviceAccounts[adminDashboardSA] ||
			inventory.reviewRole != nil ||
			inventory.reviewBindingFound {
			t.Errorf("admin dashboard identity/RBAC rendered while disabled")
		}
		return
	}
	if !inventory.serviceAccounts[adminDashboardSA] {
		t.Errorf("dedicated ServiceAccount %q was not rendered", adminDashboardSA)
	}
	for _, operationalRole := range []string{
		"admin-paprika-manager-role",
		"admin-paprika-leader-election-role",
		"admin-paprika-metrics-auth-role",
	} {
		if !inventory.defaultOperationalRoles[operationalRole] {
			t.Fatalf("test invariant: default ServiceAccount lacks operational binding %q", operationalRole)
		}
		if !inventory.adminOperationalRoles[operationalRole] {
			t.Errorf("admin ServiceAccount lacks operational binding %q", operationalRole)
		}
	}
	if inventory.reviewRole == nil {
		t.Fatalf("review-only ClusterRole %q was not rendered", adminReviewRole)
	}
	if !inventory.reviewBindingFound || !inventory.adminOperationalRoles[adminReviewRole] {
		t.Errorf("admin ServiceAccount is not bound to review-only ClusterRole %q", adminReviewRole)
	}
	assertExactReviewRules(t, inventory.reviewRole)
}

func assertExactReviewRules(t *testing.T, role manifest) {
	t.Helper()
	rules := list(t, role["rules"], "admin review rules")
	if len(rules) != 2 {
		t.Fatalf("review ClusterRole must contain exactly two rules, got %d", len(rules))
	}
	got := map[string]bool{}
	for _, ruleValue := range rules {
		rule := object(t, ruleValue, "admin review rule")
		apiGroups := stringList(t, rule["apiGroups"])
		resources := stringList(t, rule["resources"])
		verbs := stringList(t, rule["verbs"])
		if len(apiGroups) != 1 || len(resources) != 1 || len(verbs) != 1 || verbs[0] != "create" {
			t.Errorf("review rule is broader than one API group/resource with create: %#v", rule)
			continue
		}
		if contains(apiGroups, "*") || contains(resources, "*") || contains(verbs, "*") {
			t.Errorf("review rule contains wildcard: %#v", rule)
		}
		if resources[0] == "pods" || resources[0] == "pods/portforward" ||
			resources[0] == "secrets" || resources[0] == "impersonate" {
			t.Errorf("review ClusterRole grants forbidden resource %q", resources[0])
		}
		got[apiGroups[0]+"/"+resources[0]+"/"+verbs[0]] = true
	}
	for _, permission := range []string{
		"authentication.k8s.io/tokenreviews/create",
		"authorization.k8s.io/subjectaccessreviews/create",
	} {
		if !got[permission] {
			t.Errorf("review ClusterRole missing exact permission %q", permission)
		}
	}
}

func assertNoPort3001Exposure(t *testing.T, objects []manifest) {
	t.Helper()
	for _, obj := range objects {
		kind := stringValue(obj["kind"])
		switch kind {
		case "Service":
			assertNo3001(t, stringValue(path(obj, "metadata", "name"))+" Service ports", path(obj, "spec", "ports"))
		case "Ingress":
			assertNo3001(t, stringValue(path(obj, "metadata", "name"))+" Ingress backends", path(obj, "spec"))
		case "HTTPRoute", "Gateway":
			assertNo3001(t, stringValue(path(obj, "metadata", "name"))+" Gateway API backends", path(obj, "spec"))
		case "NetworkPolicy":
			assertNo3001(t, stringValue(path(obj, "metadata", "name"))+" NetworkPolicy ingress", path(obj, "spec", "ingress"))
		}
		spec, ok := podSpec(obj)
		if !ok {
			continue
		}
		for _, item := range list(t, spec["containers"], "workload containers") {
			container := object(t, item, "workload container")
			assertNo3001(t, stringValue(container["name"])+" container ports", container["ports"])
			assertNo3001(t, stringValue(container["name"])+" probes", map[string]any{
				"livenessProbe":  container["livenessProbe"],
				"readinessProbe": container["readinessProbe"],
				"startupProbe":   container["startupProbe"],
			})
			name := stringValue(container["name"])
			if name == "webhook-receiver" || name == "repo-server" || name == "agent" {
				for _, arg := range stringList(t, container["args"]) {
					if strings.Contains(arg, "admin-dashboard") || strings.Contains(arg, "3001") {
						t.Errorf("ineligible %s container has private admin argument %q", name, arg)
					}
				}
			}
		}
	}
}

func assertNo3001(t *testing.T, location string, value any) {
	t.Helper()
	data, err := yaml.Marshal(value)
	if err != nil {
		t.Fatalf("marshal %s: %v", location, err)
	}
	if bytes.Contains(data, []byte("3001")) {
		t.Errorf("%s contains private admin port 3001:\n%s", location, data)
	}
}

func renderChart(t *testing.T, args ...string) (string, []manifest) {
	t.Helper()
	cmd := helmTemplateCommand(t, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("helm template failed: %v\n%s", err, out)
	}

	decoder := k8syaml.NewYAMLToJSONDecoder(bytes.NewReader(out))
	var objects []manifest
	for {
		var obj manifest
		err := decoder.Decode(&obj)
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			t.Fatalf("decode Helm output: %v", err)
		}
		if len(obj) != 0 {
			objects = append(objects, obj)
		}
	}
	return string(out), objects
}

func renderChartFailure(t *testing.T, args ...string) string {
	t.Helper()
	out, err := helmTemplateCommand(t, args...).CombinedOutput()
	if err == nil {
		t.Fatal("helm template unexpectedly succeeded")
	}
	return string(out)
}

func helmTemplateCommand(t *testing.T, args ...string) *exec.Cmd {
	t.Helper()
	base := make([]string, 0, 5+len(args))
	base = append(base,
		"template", releaseName, chartRoot(t),
		"--namespace", releaseNamespace,
	)
	// #nosec G204 -- arguments are fixed by this repository-owned structural test.
	cmd := exec.CommandContext(t.Context(), "helm", append(base, args...)...)
	cmd.Dir = repoRoot(t)
	return cmd
}

func podSpec(obj manifest) (map[string]any, bool) {
	switch stringValue(obj["kind"]) {
	case "Deployment", "StatefulSet", "DaemonSet":
		spec, ok := path(obj, "spec", "template", "spec").(map[string]any)
		return spec, ok
	default:
		return nil, false
	}
}

func environment(t *testing.T, value any) map[string]map[string]any {
	t.Helper()
	result := map[string]map[string]any{}
	for _, item := range list(t, value, "container env") {
		env := object(t, item, "environment variable")
		name := stringValue(env["name"])
		if result[name] != nil {
			t.Errorf("duplicate environment variable %q", name)
		}
		result[name] = env
	}
	return result
}

func containerNames(t *testing.T, values []any) []string {
	t.Helper()
	names := make([]string, 0, len(values))
	for _, value := range values {
		names = append(names, stringValue(object(t, value, "container")["name"]))
	}
	sort.Strings(names)
	return names
}

func object(t *testing.T, value any, label string) map[string]any {
	t.Helper()
	obj, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("%s is %T, want object", label, value)
	}
	return obj
}

func list(t *testing.T, value any, label string) []any {
	t.Helper()
	if value == nil {
		return nil
	}
	values, ok := value.([]any)
	if !ok {
		t.Fatalf("%s is %T, want list", label, value)
	}
	return values
}

func stringList(t *testing.T, value any) []string {
	t.Helper()
	values := list(t, value, "string list")
	result := make([]string, 0, len(values))
	for _, item := range values {
		result = append(result, stringValue(item))
	}
	return result
}

func path(value any, keys ...string) any {
	current := value
	for _, key := range keys {
		switch obj := current.(type) {
		case manifest:
			current = obj[key]
		case map[string]any:
			current = obj[key]
		default:
			return nil
		}
	}
	return current
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func sortedKeys(value map[string]any) []string {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func readYAMLFile(t *testing.T, path string) map[string]any {
	t.Helper()
	// #nosec G304 -- paths are constructed solely from this test's repository root.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var value map[string]any
	if err := yaml.Unmarshal(data, &value); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return value
}

func chartRoot(t *testing.T) string {
	t.Helper()
	return filepath.Join(repoRoot(t), "charts", "chart")
}

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate chart test source")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
}

func TestMain(m *testing.M) {
	if _, err := exec.LookPath("helm"); err != nil {
		fmt.Fprintln(os.Stderr, "helm is required for chart structural tests")
		os.Exit(1)
	}
	os.Exit(m.Run())
}

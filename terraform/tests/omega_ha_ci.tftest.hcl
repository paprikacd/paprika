# Plan-only tests: every provider is mocked; no cloud credentials or writes.
mock_provider "vultr" {
  override_during = plan

  mock_resource "vultr_kubernetes" {
    defaults = {
      id          = "40ee226a-9fd0-43fc-9571-e4a44668098d"
      kube_config = "b2ZmbGluZS10ZXN0LWZpeHR1cmUK"
    }
  }
}
mock_provider "github" {}
mock_provider "cloudflare" {}
mock_provider "local" {}
mock_provider "null" {}

variables {
  github_token       = "unused-mocked-provider"
  vultr_api_token    = "unused-mocked-provider"
  cloudflare_api_key = "unused-mocked-provider"
  cloudflare_email   = "test@example.invalid"
}

run "disabled_by_default" {
  command = plan

  assert {
    condition     = length(vultr_kubernetes_node_pools.omega_ha_ci) == 0
    error_message = "The default configuration must not add billable CI nodes."
  }
}

run "one_fixed_ci_pool_with_placement_metadata" {
  command = plan

  variables {
    vke_ci_enabled = true
  }

  assert {
    condition = (
      length(vultr_kubernetes_node_pools.omega_ha_ci) == 1 &&
      vultr_kubernetes_node_pools.omega_ha_ci[0].cluster_id == "40ee226a-9fd0-43fc-9571-e4a44668098d" &&
      vultr_kubernetes_node_pools.omega_ha_ci[0].plan == "vc2-4c-8gb" &&
      vultr_kubernetes_node_pools.omega_ha_ci[0].node_quantity == 1 &&
      vultr_kubernetes_node_pools.omega_ha_ci[0].min_nodes == 1 &&
      vultr_kubernetes_node_pools.omega_ha_ci[0].max_nodes == 1 &&
      !vultr_kubernetes_node_pools.omega_ha_ci[0].auto_scaler
    )
    error_message = "Opt-in must add exactly one fixed 4-vCPU/8-GB node to omega-ha."
  }

  assert {
    condition = (
      vultr_kubernetes_node_pools.omega_ha_ci[0].label == "cuttlefish-ci" &&
      vultr_kubernetes_node_pools.omega_ha_ci[0].tag == "tf-vke-cuttlefish-ci" &&
      length(vultr_kubernetes_node_pools.omega_ha_ci[0].labels) == 1 &&
      one(vultr_kubernetes_node_pools.omega_ha_ci[0].labels).key == "cuttlefish.dev/role" &&
      one(vultr_kubernetes_node_pools.omega_ha_ci[0].labels).value == "ci" &&
      length(vultr_kubernetes_node_pools.omega_ha_ci[0].taints) == 1 &&
      one(vultr_kubernetes_node_pools.omega_ha_ci[0].taints).key == "dedicated" &&
      one(vultr_kubernetes_node_pools.omega_ha_ci[0].taints).value == "cuttlefish-ci" &&
      one(vultr_kubernetes_node_pools.omega_ha_ci[0].taints).effect == "NoSchedule"
    )
    error_message = "The pool label and narrow NoSchedule taint must remain exact."
  }
}

run "wrong_cluster_is_rejected" {
  command = plan

  variables {
    vke_ci_enabled = true
  }

  override_resource {
    target          = vultr_kubernetes.omega_ha
    override_during = plan
    values = {
      id          = "00000000-0000-0000-0000-000000000000"
      kube_config = "b2ZmbGluZS10ZXN0LWZpeHR1cmUK"
    }
  }

  expect_failures = [vultr_kubernetes_node_pools.omega_ha_ci[0]]
}

run "wrong_region_is_rejected" {
  command = plan

  variables {
    vke_ci_enabled = true
    vke_region     = "ewr"
  }

  expect_failures = [vultr_kubernetes_node_pools.omega_ha_ci[0]]
}

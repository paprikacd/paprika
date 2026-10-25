# These plan-only mocks check module inputs and planned metadata, not remote
# authentication. Cloudflare's real provider owns its credential validation.
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
  github_token    = "unused-mocked-provider"
  vultr_api_token = "unused-mocked-provider"
}

run "credentials_default_to_null_and_repo_metadata_is_preserved" {
  command = plan

  assert {
    condition     = var.cloudflare_api_key == null && var.cloudflare_api_token == null
    error_message = "Cloudflare credentials must not be embedded in default inputs."
  }

  assert {
    condition = (
      github_repository.paprika.description == "Open source Kubernetes application delivery operator with pipelines, staged releases, health checks, and progressive rollouts." &&
      github_repository.paprika.homepage_url == "https://paprikacd.github.io/paprika/"
    )
    error_message = "The recovered repository description and homepage must not be cleared."
  }
}

run "scoped_token_input_does_not_require_global_key" {
  command = plan

  variables {
    cloudflare_api_token = "offline_mock_token_0000000000000000000000"
  }

  assert {
    condition     = var.cloudflare_api_key == null && var.cloudflare_api_token != null
    error_message = "The scoped-token mode must leave the legacy key unset."
  }

  assert {
    condition     = cloudflare_record.paprika.content == var.paprika_lb_ip && cloudflare_record.demo_paprika.content == var.paprika_lb_ip
    error_message = "Selecting token authentication must preserve both planned DNS destinations."
  }
}

run "legacy_key_input_remains_supported" {
  command = plan

  variables {
    cloudflare_api_key = "offline_mock_key_00000000000000000000000"
    cloudflare_email   = "test@example.invalid"
  }

  assert {
    condition     = var.cloudflare_api_key != null && var.cloudflare_api_token == null && var.cloudflare_email == "test@example.invalid"
    error_message = "The explicit legacy key/email mode must leave the scoped token unset."
  }
}

run "existing_pool_topology_and_capacity_are_preserved" {
  command = plan

  assert {
    condition = (
      vultr_kubernetes.omega_ha.region == "syd" &&
      vultr_kubernetes.omega_ha.label == "omega-ha" &&
      vultr_kubernetes.omega_ha.ha_controlplanes &&
      vultr_kubernetes_node_pools.omega_ha_core_large.cluster_id == vultr_kubernetes.omega_ha.id &&
      vultr_kubernetes_node_pools.omega_ha_search.cluster_id == vultr_kubernetes.omega_ha.id
    )
    error_message = "Recovery must preserve the Sydney HA cluster and both existing standalone pool bindings."
  }

  assert {
    condition = (
      length(vultr_kubernetes.omega_ha.node_pools) == 1 &&
      one(vultr_kubernetes.omega_ha.node_pools).label == "core" &&
      one(vultr_kubernetes.omega_ha.node_pools).plan == "vc2-2c-4gb" &&
      one(vultr_kubernetes.omega_ha.node_pools).node_quantity == 4 &&
      one(vultr_kubernetes.omega_ha.node_pools).auto_scaler &&
      one(vultr_kubernetes.omega_ha.node_pools).min_nodes == 4 &&
      one(vultr_kubernetes.omega_ha.node_pools).max_nodes == 4 &&
      vultr_kubernetes_node_pools.omega_ha_core_large.label == "core-large" &&
      vultr_kubernetes_node_pools.omega_ha_core_large.plan == "vc2-4c-8gb" &&
      vultr_kubernetes_node_pools.omega_ha_core_large.node_quantity == 2 &&
      vultr_kubernetes_node_pools.omega_ha_core_large.min_nodes == 2 &&
      vultr_kubernetes_node_pools.omega_ha_core_large.max_nodes == 2 &&
      vultr_kubernetes_node_pools.omega_ha_search.label == "greenveil-search" &&
      vultr_kubernetes_node_pools.omega_ha_search.plan == "vc2-6c-16gb" &&
      vultr_kubernetes_node_pools.omega_ha_search.node_quantity == 1 &&
      vultr_kubernetes_node_pools.omega_ha_search.min_nodes == 1 &&
      vultr_kubernetes_node_pools.omega_ha_search.max_nodes == 1
    )
    error_message = "Recovery must preserve existing pool sizes, node quantities and autoscaler bounds: core=4, core-large=2, search=1."
  }

  assert {
    condition = (
      length(vultr_kubernetes_node_pools.omega_ha_search.taints) == 1 &&
      one(vultr_kubernetes_node_pools.omega_ha_search.taints).key == "dedicated" &&
      one(vultr_kubernetes_node_pools.omega_ha_search.taints).value == "search" &&
      one(vultr_kubernetes_node_pools.omega_ha_search.taints).effect == "NoSchedule"
    )
    error_message = "Recovery must not loosen the existing search pool's scheduling taint."
  }
}

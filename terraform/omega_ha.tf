# Side-by-side HA replacement for `omega` (docs/guides/vke-ha-control-plane-migration.md).
#
# `ha_controlplanes` is ForceNew in the vultr provider, so HA cannot be enabled on
# `vultr_kubernetes.omega` without destroying it. This file builds a second cluster
# with the same worker shape. Every apply that touches it MUST be targeted, e.g.
#
#   terraform apply -target=vultr_kubernetes.omega_ha \
#     -target=vultr_kubernetes_node_pools.omega_ha_core_large \
#     -target=vultr_kubernetes_node_pools.omega_ha_search \
#     -target=local_file.omega_ha_kubeconfig
#
# and its plan must show `0 to destroy`. Do not edit `vultr_kubernetes.omega` until
# the retirement phase; rename omega_ha -> omega with a `moved {}` block then.

variable "vke_ha_kubernetes_version" {
  description = "Kubernetes version for the HA replacement cluster (v1.36.1+2 is no longer offered)"
  type        = string
  default     = "v1.36.5+1"
}

resource "vultr_kubernetes" "omega_ha" {
  region           = var.vke_region
  label            = "omega-ha"
  version          = var.vke_ha_kubernetes_version
  ha_controlplanes = true

  oidc_issuer_url     = var.kubernetes_oidc_issuer_url
  oidc_client_id      = var.kubernetes_oidc_client_id
  oidc_username_claim = var.kubernetes_oidc_username_claim
  oidc_groups_claim   = var.kubernetes_oidc_groups_claim

  node_pools {
    node_quantity = var.vke_node_count
    plan          = var.vke_node_plan
    label         = "core"
    auto_scaler   = true
    min_nodes     = var.vke_node_count
    max_nodes     = var.vke_core_max_nodes
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "vultr_kubernetes_node_pools" "omega_ha_core_large" {
  cluster_id    = vultr_kubernetes.omega_ha.id
  node_quantity = var.vke_core_large_node_count
  plan          = var.vke_core_large_node_plan
  label         = "core-large"
  tag           = "tf-vke-core-large"
  min_nodes     = var.vke_core_large_node_count
  max_nodes     = var.vke_core_large_node_count
}

resource "vultr_kubernetes_node_pools" "omega_ha_search" {
  cluster_id    = vultr_kubernetes.omega_ha.id
  node_quantity = var.vke_search_node_count
  plan          = var.vke_search_node_plan
  label         = "greenveil-search"
  min_nodes     = var.vke_search_node_count
  max_nodes     = var.vke_search_node_count

  taints {
    key    = "dedicated"
    value  = "search"
    effect = "NoSchedule"
  }
}

resource "local_file" "omega_ha_kubeconfig" {
  depends_on      = [vultr_kubernetes.omega_ha]
  content         = base64decode(vultr_kubernetes.omega_ha.kube_config)
  filename        = "${path.module}/omega-ha.kubeconfig"
  file_permission = "0600"
}

output "omega_ha_cluster_id" {
  value = vultr_kubernetes.omega_ha.id
}

output "omega_ha_cluster_endpoint" {
  value = vultr_kubernetes.omega_ha.endpoint
}

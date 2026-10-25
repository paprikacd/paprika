# Opt-in capacity only. Recover the canonical state and review a whole-module
# no-change baseline before planning this one additional pool. See the runbook.
variable "vke_ci_enabled" {
  description = "Opt in to one reviewed, fixed-size CI node on the existing omega-ha cluster. Enabling incurs instance charges."
  type        = bool
  default     = false
  nullable    = false
}

resource "vultr_kubernetes_node_pools" "omega_ha_ci" {
  count = var.vke_ci_enabled ? 1 : 0

  cluster_id    = vultr_kubernetes.omega_ha.id
  label         = "cuttlefish-ci"
  tag           = "tf-vke-cuttlefish-ci"
  plan          = "vc2-4c-8gb"
  node_quantity = 1
  auto_scaler   = false
  min_nodes     = 1
  max_nodes     = 1

  labels {
    key   = "cuttlefish.dev/role"
    value = "ci"
  }

  # Provider 2.31.2 adds this only AFTER the pool becomes active. This is not a
  # guarantee of isolation at first join; verify actual placement before use.
  taints {
    key    = "dedicated"
    value  = "cuttlefish-ci"
    effect = "NoSchedule"
  }

  lifecycle {
    prevent_destroy = true

    precondition {
      condition = (
        vultr_kubernetes.omega_ha.id == "40ee226a-9fd0-43fc-9571-e4a44668098d" &&
        vultr_kubernetes.omega_ha.region == "syd" &&
        vultr_kubernetes.omega_ha.label == "omega-ha" &&
        vultr_kubernetes.omega_ha.ha_controlplanes
      )
      error_message = "CI capacity may attach only to the recovered, existing Sydney omega-ha HA cluster."
    }
  }
}

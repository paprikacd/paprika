variable "github_token" {
  description = "GitHub personal access token with repo scope"
  type        = string
  sensitive   = true
}

variable "repo_name" {
  description = "Repository name"
  type        = string
  default     = "paprika"
}

variable "repo_owner" {
  description = "Repository owner (user or organization)"
  type        = string
  default     = "paprikacd"
}

variable "vultr_api_token" {
  description = "Vultr API token"
  type        = string
  sensitive   = true
}

variable "vke_region" {
  description = "Vultr region for the VKE cluster"
  type        = string
  default     = "syd"
}

variable "vke_node_plan" {
  description = "Vultr plan for VKE node pool"
  type        = string
  default     = "vc2-2c-4gb"
}

variable "vke_node_count" {
  description = "Baseline node count for the VKE core node pool"
  type        = number
  default     = 4
}

variable "vke_core_max_nodes" {
  description = "Maximum autoscaled node count for the VKE core node pool"
  type        = number
  default     = 4
}

variable "vke_core_large_node_plan" {
  description = "Vultr plan for the core-large pool (heavy tenants such as the Greenveil API)"
  type        = string
  default     = "vc2-4c-8gb"
}

variable "vke_core_large_node_count" {
  description = "Node count for the core-large pool"
  type        = number
  default     = 2
}

variable "vke_search_node_plan" {
  description = "Vultr plan for the dedicated VKE search node pool"
  type        = string
  default     = "vc2-6c-16gb"
}

variable "vke_search_node_count" {
  description = "Node count for the dedicated VKE search node pool"
  type        = number
  default     = 1
}

variable "vke_kubernetes_version" {
  description = "Kubernetes version for VKE cluster"
  type        = string
  default     = "v1.36.1+2"
}

variable "oidc_client_id" {
  description = "Deprecated Google OAuth Desktop client ID for the old local kubelogin flow."
  type        = string
  sensitive   = true
  default     = null
}

variable "oidc_client_secret" {
  description = "Deprecated Google OAuth Desktop client secret for the old local kubelogin flow."
  type        = string
  sensitive   = true
  default     = null
}

variable "kubernetes_oidc_issuer_url" {
  description = "OIDC issuer trusted by the VKE Kubernetes API server."
  type        = string
  default     = "https://token.actions.githubusercontent.com"
}

variable "kubernetes_oidc_client_id" {
  description = "OIDC audience/client ID accepted by the VKE Kubernetes API server."
  type        = string
  default     = "paprika-vke-deploy"
}

variable "kubernetes_oidc_username_claim" {
  description = "OIDC claim mapped to the Kubernetes username."
  type        = string
  default     = "sub"
}

variable "kubernetes_oidc_groups_claim" {
  description = "OIDC claim mapped to Kubernetes groups. GitHub Actions exposes repository as a string claim; RBAC still binds exact user subjects."
  type        = string
  default     = "repository"
}

variable "cloudflare_api_key" {
  description = "Cloudflare Global API key"
  type        = string
  sensitive   = true
}

variable "cloudflare_email" {
  description = "Cloudflare account email"
  type        = string
  default     = "Ben.ebsworth@gmail.com"
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for benebsworth.com"
  type        = string
  default     = "b18684990f8bbad83a5dada1824ad388"
}

variable "paprika_lb_ip" {
  description = "Paprika Envoy Gateway LoadBalancer IP"
  type        = string
  default     = "139.180.161.184" # omega-ha envoy gateway LB (was 104.156.233.70 on omega)
}

# Versions
terraform {
  required_version = ">= 1.6"
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
    vultr = {
      source  = "vultr/vultr"
      version = "~> 2.29"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

provider "github" {
  token = var.github_token
  owner = var.repo_owner
}

provider "vultr" {
  api_key = var.vultr_api_token
}

provider "cloudflare" {
  api_key = var.cloudflare_api_key
  email   = var.cloudflare_email
}

# Import existing repo (run: terraform import github_repository.paprika paprika)
resource "github_repository" "paprika" {
  name = var.repo_name

  visibility = "public"

  has_issues      = true
  has_wiki        = false
  has_projects    = false
  has_discussions = false

  allow_merge_commit     = true
  allow_squash_merge     = true
  allow_rebase_merge     = true
  delete_branch_on_merge = true
}

# Separate pages resource (pages block in github_repository is deprecated)
resource "github_repository_pages" "paprika" {
  repository = github_repository.paprika.name
  build_type = "legacy"
  source {
    branch = "gh-pages"
    path   = "/"
  }
}

# The original non-HA cluster `omega` (7997fb87-…) was retired 2026-09-28/29 and
# removed from state; the serving cluster is `omega-ha` in omega_ha.tf. See
# docs/guides/vke-ha-control-plane-migration.md (runbook log + teardown).
#
# GitHub Actions deploy RBAC (github-actions-deployer-rbac.yaml) used to be
# applied here by a null_resource against omega's kubeconfig. It is applied to
# omega-ha by hand:
#   KUBECONFIG=omega-ha.kubeconfig kubectl apply -f github-actions-deployer-rbac.yaml

# Cloudflare DNS for paprika.benebsworth.com
# Import existing: terraform import cloudflare_record.paprika b18684990f8bbad83a5dada1824ad388/6866879f3afa54ced6498defce8e8286
resource "cloudflare_record" "paprika" {
  zone_id = var.cloudflare_zone_id
  name    = "paprika"
  type    = "A"
  content = var.paprika_lb_ip
  proxied = true
  ttl     = 1
}

resource "cloudflare_record" "demo_paprika" {
  zone_id = var.cloudflare_zone_id
  name    = "paprika-demo"
  type    = "A"
  content = var.paprika_lb_ip
  proxied = true
  ttl     = 1
}

output "github_actions_oidc_audience" {
  description = "OIDC audience GitHub Actions must request for Kubernetes API access"
  value       = var.kubernetes_oidc_client_id
}

output "paprika_lb_ip" {
  description = "Envoy Gateway LoadBalancer IP"
  value       = var.paprika_lb_ip
}

output "paprika_url" {
  description = "Paprika URL"
  value       = "https://paprika.benebsworth.com"
}

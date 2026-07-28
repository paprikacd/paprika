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
  default     = 3
}

variable "vke_core_max_nodes" {
  description = "Maximum autoscaled node count for the VKE core node pool"
  type        = number
  default     = 3
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
  default     = "104.156.233.70"
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

# VKE cluster with GitHub Actions OIDC for CI deploys.
resource "vultr_kubernetes" "omega" {
  region  = var.vke_region
  label   = "omega"
  version = var.vke_kubernetes_version

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

}

resource "vultr_kubernetes_node_pools" "search" {
  cluster_id    = vultr_kubernetes.omega.id
  node_quantity = var.vke_search_node_count
  plan          = var.vke_search_node_plan
  label         = "greenveil-search"

  taints {
    key    = "dedicated"
    value  = "search"
    effect = "NoSchedule"
  }
}

# Write kubeconfig to disk so kubectl can use it
resource "local_file" "kubeconfig" {
  depends_on      = [vultr_kubernetes.omega]
  content         = base64decode(vultr_kubernetes.omega.kube_config)
  filename        = "${path.module}/omega.kubeconfig"
  file_permission = "0600"
}

# Apply GitHub Actions deploy RBAC once the cluster is up.
resource "null_resource" "github_actions_deployer_rbac" {
  depends_on = [local_file.kubeconfig]
  triggers = {
    manifest_sha = filesha256("${path.module}/github-actions-deployer-rbac.yaml")
  }

  provisioner "local-exec" {
    command = "KUBECONFIG=${local_file.kubeconfig.filename} kubectl apply -f ${abspath(path.module)}/github-actions-deployer-rbac.yaml"
  }
}

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

output "cluster_id" {
  value = vultr_kubernetes.omega.id
}

output "cluster_endpoint" {
  value = vultr_kubernetes.omega.endpoint
}

output "kubeconfig_admin" {
  description = "Path to admin kubeconfig"
  value       = local_file.kubeconfig.filename
}

output "github_actions_oidc_audience" {
  description = "OIDC audience GitHub Actions must request for Kubernetes API access"
  value       = var.kubernetes_oidc_client_id
}

output "github_actions_deployer_rbac_applied" {
  description = "Whether GitHub Actions deploy RBAC was applied"
  value       = null_resource.github_actions_deployer_rbac.id
}

output "paprika_lb_ip" {
  description = "Envoy Gateway LoadBalancer IP"
  value       = var.paprika_lb_ip
}

output "paprika_url" {
  description = "Paprika URL"
  value       = "https://paprika.benebsworth.com"
}

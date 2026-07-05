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
  description = "Node count for VKE node pool"
  type        = number
  default     = 2
}

variable "vke_kubernetes_version" {
  description = "Kubernetes version for VKE cluster"
  type        = string
  default     = "v1.36.1+2"
}

variable "oidc_client_id" {
  description = "Google OAuth Desktop client ID for kubelogin"
  type        = string
  sensitive   = true
}

variable "oidc_client_secret" {
  description = "Google OAuth Desktop client secret for kubelogin"
  type        = string
  sensitive   = true
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
  api_key  = var.cloudflare_api_key
  email    = var.cloudflare_email
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

# VKE cluster with OIDC for kubelogin
resource "vultr_kubernetes" "omega" {
  region  = var.vke_region
  label   = "omega"
  version = var.vke_kubernetes_version

  oidc_issuer_url      = "https://accounts.google.com"
  oidc_client_id       = var.oidc_client_id
  oidc_username_claim  = "email"
  oidc_groups_claim    = "groups"

  node_pools {
    node_quantity = var.vke_node_count
    plan          = var.vke_node_plan
    label         = "core"
  }
}

# Write kubeconfig to disk so kubectl can use it
resource "local_file" "kubeconfig" {
  depends_on      = [vultr_kubernetes.omega]
  content         = base64decode(vultr_kubernetes.omega.kube_config)
  filename        = "${path.module}/omega.kubeconfig"
  file_permission = "0600"
}

# Apply OIDC ClusterRoleBinding once the cluster is up
resource "null_resource" "oidc_rbac" {
  depends_on = [local_file.kubeconfig]

  provisioner "local-exec" {
    command = "KUBECONFIG=${local_file.kubeconfig.filename} kubectl apply -f ${abspath(path.module)}/oidc-admin.yaml"
  }
}

# Generate OIDC kubeconfig for kubelogin
resource "local_file" "oidc_kubeconfig" {
  depends_on = [vultr_kubernetes.omega]
  content = yamlencode({
    apiVersion = "v1"
    kind       = "Config"
    current-context = "omega-oidc"
    clusters = [
      {
        cluster = {
          certificate-authority-data = vultr_kubernetes.omega.cluster_ca_certificate
          server                     = "https://${vultr_kubernetes.omega.endpoint}:6443"
        }
        name = "omega"
      }
    ]
    contexts = [
      {
        context = {
          cluster   = "omega"
          user      = "oidc"
          namespace = "default"
        }
        name = "omega-oidc"
      }
    ]
    users = [
      {
        name = "oidc"
        user = {
          exec = {
            apiVersion = "client.authentication.k8s.io/v1beta1"
            command    = "kubectl"
            args = [
              "oidc-login",
              "get-token",
              "--oidc-issuer-url=https://accounts.google.com",
              "--oidc-client-id=${var.oidc_client_id}",
              "--oidc-client-secret=${var.oidc_client_secret}",
              "--grant-type=authcode",
              "--oidc-extra-scope=email",
              "--oidc-extra-scope=openid",
              "--token-cache-dir=${abspath(path.module)}/.kube-cache",
            ]
          }
        }
      }
    ]
  })
  filename        = "${path.module}/omega-oidc.kubeconfig"
  file_permission = "0600"
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

output "kubeconfig_oidc" {
  description = "Path to OIDC kubeconfig for kubelogin"
  value       = local_file.oidc_kubeconfig.filename
}

output "oidc_rbac_applied" {
  description = "Whether OIDC ClusterRoleBinding was applied"
  value       = null_resource.oidc_rbac.id
}

output "paprika_lb_ip" {
  description = "Envoy Gateway LoadBalancer IP"
  value       = var.paprika_lb_ip
}

output "paprika_url" {
  description = "Paprika URL"
  value       = "https://paprika.benebsworth.com"
}

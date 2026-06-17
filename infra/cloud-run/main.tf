terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.27"
    }
  }
}

locals {
  cloud_run_project_id = var.project_id
  gke_project_id       = var.gke_project_id != "" ? var.gke_project_id : var.project_id
  gke_sa_project_id    = var.gke_sa_project_id != "" ? var.gke_sa_project_id : local.gke_project_id

  cloud_run_sa_email = google_service_account.cloud_run.email
  gke_sa_email       = google_service_account.gke.email

  service_account_member = "serviceAccount:${local.cloud_run_sa_email}"
}

provider "google" {
  project = local.cloud_run_project_id
  region  = var.region
}

provider "google-beta" {
  project = local.cloud_run_project_id
  region  = var.region
}

provider "kubernetes" {
  host                   = "https://${data.google_container_cluster.gke.private_cluster_config[0].private_endpoint}"
  token                  = data.google_client_config.default.access_token
  cluster_ca_certificate = base64decode(data.google_container_cluster.gke.master_auth[0].cluster_ca_certificate)
}

data "google_client_config" "default" {}

data "google_container_cluster" "gke" {
  project  = local.gke_project_id
  name     = var.gke_cluster_name
  location = var.gke_region
}

resource "google_service_account" "cloud_run" {
  account_id   = var.cloud_run_sa_name
  display_name = "Paprika Cloud Run (${var.environment})"
  description  = "Service account for the Paprika stateless Cloud Run plane"
  project      = local.cloud_run_project_id
}

resource "google_service_account" "gke" {
  account_id   = var.gke_sa_name
  display_name = "Paprika Cloud Run GKE identity (${var.environment})"
  description  = "GCP service account impersonated by Cloud Run to access GKE"
  project      = local.gke_sa_project_id
}

resource "google_service_account_iam_member" "cloud_run_impersonate_gke" {
  service_account_id = google_service_account.gke.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.service_account_member
}

resource "google_service_account_iam_member" "cloud_run_use_gke" {
  service_account_id = google_service_account.gke.name
  role               = "roles/iam.serviceAccountUser"
  member             = local.service_account_member
}

resource "google_project_iam_member" "cloud_run_container_cluster_viewer" {
  project = local.gke_project_id
  role    = "roles/container.clusterViewer"
  member  = local.service_account_member
}

resource "google_project_iam_member" "gke_container_developer" {
  project = local.gke_project_id
  role    = "roles/container.developer"
  member  = "serviceAccount:${local.gke_sa_email}"
}

resource "google_vpc_access_connector" "cloud_run" {
  provider      = google-beta
  project       = local.cloud_run_project_id
  region        = var.region
  name          = var.vpc_connector_name
  ip_cidr_range = var.vpc_connector_subnet
  network       = var.vpc_network_name
  min_instances = var.vpc_connector_min_instances
  max_instances = var.vpc_connector_max_instances
}

resource "google_cloud_run_v2_service" "paprika" {
  provider = google-beta
  project  = local.cloud_run_project_id
  name     = var.service_name
  location = var.region
  ingress  = var.ingress

  template {
    service_account = google_service_account.cloud_run.email

    vpc_access {
      connector = google_vpc_access_connector.cloud_run.id
      egress    = "ALL_TRAFFIC"
    }

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image
      name  = "paprika"

      ports {
        container_port = var.container_port
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        cpu_idle = var.min_instances == 0
      }

      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = local.cloud_run_project_id
      }

      env {
        name  = "PAPRIKA_MODE"
        value = "cloud-run"
      }

      startup_probe {
        http_get {
          path = "/healthz"
          port = var.container_port
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 6
        timeout_seconds       = 3
      }

      liveness_probe {
        http_get {
          path = "/healthz"
          port = var.container_port
        }
        period_seconds    = 10
        failure_threshold = 3
        timeout_seconds   = 3
      }
    }
  }

  depends_on = [
    google_vpc_access_connector.cloud_run,
    google_service_account_iam_member.cloud_run_impersonate_gke,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "noauth" {
  count = var.environment == "dev" || var.environment == "preview" ? 1 : 0

  project  = local.cloud_run_project_id
  location = google_cloud_run_v2_service.paprika.location
  name     = google_cloud_run_v2_service.paprika.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "kubernetes_cluster_role_binding_v1" "paprika_cloud_run_crb" {
  metadata {
    name = "${var.service_name}-${var.environment}-crd-admin"
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    name      = var.crd_cluster_role_name
  }

  subject {
    kind = "User"
    name = local.gke_sa_email
  }

  depends_on = [google_service_account.gke]
}

resource "google_secret_manager_secret" "kubeconfig" {
  count = var.enable_secret_manager_kubeconfig ? 1 : 0

  project   = local.cloud_run_project_id
  secret_id = "${var.service_name}-${var.environment}-kubeconfig"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "kubeconfig" {
  count = var.enable_secret_manager_kubeconfig ? 1 : 0

  secret      = google_secret_manager_secret.kubeconfig[0].id
  secret_data = local.kubeconfig_placeholder
}

locals {
  kubeconfig_placeholder = <<EOF
# Placeholder kubeconfig for Paprika Cloud Run -> GKE private endpoint.
# Cloud Run service account: ${local.cloud_run_sa_email}
# Impersonated GKE service account: ${local.gke_sa_email}
# GKE private endpoint: https://${data.google_container_cluster.gke.private_cluster_config[0].private_endpoint}
#
# Generate a working kubeconfig with one of these patterns:
# 1. Add Google ADC token support to cmd/cloud-run/main.go and omit this secret.
# 2. Use a kubeconfig exec plugin that calls the metadata server or impersonation endpoint.
# 3. Mount a rotated bearer token via this Secret Manager secret.
#
# Example exec plugin (requires a suitable binary in the container image):
# users:
#   - name: paprika-cloudrun
#     user:
#       exec:
#         apiVersion: client.authentication.k8s.io/v1beta1
#         command: /usr/local/bin/gke-auth-plugin
#         args:
#           - --impersonate-service-account=${local.gke_sa_email}
#           - --project=${local.gke_project_id}
#           - --cluster=${var.gke_cluster_name}
#           - --location=${var.gke_region}
EOF
}

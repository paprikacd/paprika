variable "project_id" {
  description = "GCP project where the Cloud Run service is deployed"
  type        = string
}

variable "gke_project_id" {
  description = "GCP project that owns the GKE cluster. Defaults to the Cloud Run project"
  type        = string
  default     = ""
}

variable "environment" {
  description = "Deployment environment name"
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "preview", "prod"], var.environment)
    error_message = "environment must be dev, preview, or prod"
  }
}

variable "region" {
  description = "GCP region for Cloud Run and VPC connector"
  type        = string
  default     = "australia-southeast1"
}

variable "gke_region" {
  description = "Region of the GKE cluster for data source lookups"
  type        = string
  default     = "australia-southeast1"
}

variable "gke_cluster_name" {
  description = "Name of the existing GKE cluster"
  type        = string
}

variable "service_name" {
  description = "Cloud Run service name"
  type        = string
  default     = "paprika-cloud-run"
}

variable "image" {
  description = "Container image for the Cloud Run service"
  type        = string
}

variable "cloud_run_sa_name" {
  description = "Name of the Cloud Run service account"
  type        = string
  default     = "paprika-cloudrun"
}

variable "gke_sa_name" {
  description = "Name of the GKE service account to impersonate"
  type        = string
  default     = "paprika-cloudrun-gke"
}

variable "gke_sa_project_id" {
  description = "Project that owns the GKE service account. Defaults to gke_project_id"
  type        = string
  default     = ""
}

variable "vpc_network_name" {
  description = "VPC network name for the Serverless VPC Access connector"
  type        = string
}

variable "vpc_connector_subnet" {
  description = "Subnet for the VPC connector (must be /28 and in the same region)"
  type        = string
  default     = "10.0.10.0/28"
}

variable "vpc_connector_name" {
  description = "Name of the Serverless VPC Access connector"
  type        = string
  default     = "paprika-cloudrun-connector"
}

variable "vpc_connector_min_instances" {
  description = "Minimum instances for the VPC connector"
  type        = number
  default     = 2
}

variable "vpc_connector_max_instances" {
  description = "Maximum instances for the VPC connector"
  type        = number
  default     = 10
}

variable "min_instances" {
  description = "Minimum Cloud Run instances"
  type        = number
  default     = 1
}

variable "max_instances" {
  description = "Maximum Cloud Run instances"
  type        = number
  default     = 10
}

variable "cpu" {
  description = "CPU allocation per container"
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Memory allocation per container"
  type        = string
  default     = "512Mi"
}

variable "container_port" {
  description = "Port exposed by the container"
  type        = number
  default     = 8080
}

variable "crd_cluster_role_name" {
  description = "Existing ClusterRole in GKE that grants Paprika CRUD permissions"
  type        = string
  default     = "paprika-crd-admin"
}

variable "kubernetes_namespace" {
  description = "Namespace for the Cloud Run binding subject in GKE RBAC"
  type        = string
  default     = "paprika-system"
}

variable "enable_secret_manager_kubeconfig" {
  description = "Create a Secret Manager secret to hold the generated kubeconfig"
  type        = bool
  default     = true
}

variable "ingress" {
  description = "Cloud Run ingress setting"
  type        = string
  default     = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
}

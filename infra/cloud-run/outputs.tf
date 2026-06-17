output "cloud_run_service_url" {
  description = "URL of the deployed Paprika Cloud Run service"
  value       = google_cloud_run_v2_service.paprika.uri
}

output "cloud_run_service_name" {
  description = "Name of the Cloud Run service"
  value       = google_cloud_run_v2_service.paprika.name
}

output "cloud_run_sa_email" {
  description = "Email of the Cloud Run service account"
  value       = local.cloud_run_sa_email
}

output "gke_sa_email" {
  description = "Email of the impersonated GKE service account"
  value       = local.gke_sa_email
}

output "vpc_connector_id" {
  description = "ID of the Serverless VPC Access connector"
  value       = google_vpc_access_connector.cloud_run.id
}

output "gke_private_endpoint" {
  description = "Private endpoint of the GKE cluster"
  value       = try(data.google_container_cluster.gke.private_cluster_config[0].private_endpoint, "")
}

output "kubeconfig_secret_id" {
  description = "Secret Manager secret ID holding the kubeconfig placeholder"
  value       = var.enable_secret_manager_kubeconfig ? google_secret_manager_secret.kubeconfig[0].id : ""
}

output "connection_instructions" {
  description = "Instructions for connecting the Cloud Run service to GKE"
  value       = <<EOT
Paprika Cloud Run -> GKE connectivity
=====================================

Cloud Run service account:  ${local.cloud_run_sa_email}
Impersonated GKE account:   ${local.gke_sa_email}
GKE private endpoint:       https://${try(data.google_container_cluster.gke.private_cluster_config[0].private_endpoint, "N/A")}
Cloud Run URL:              ${google_cloud_run_v2_service.paprika.uri}
VPC connector:              ${google_vpc_access_connector.cloud_run.id}

Required follow-up steps
------------------------
1. Ensure the GKE cluster has Workload Identity / private endpoint enabled and
   the VPC connector subnet (${var.vpc_connector_subnet}) can route to the
   control plane private endpoint subnet.

2. Verify the Cloud Run service account can impersonate the GKE account:
      gcloud iam service-accounts get-iam-policy ${local.gke_sa_email} \
        --project=${local.gke_sa_project_id}

3. Apply the generated ClusterRoleBinding in GKE so the impersonated account
   can read/write Paprika CRDs:
      kubectl apply -f -<<RBAC
      apiVersion: rbac.authorization.k8s.io/v1
      kind: ClusterRoleBinding
      metadata:
        name: ${var.service_name}-${var.environment}-crd-admin
      roleRef:
        apiGroup: rbac.authorization.k8s.io
        kind: ClusterRole
        name: ${var.crd_cluster_role_name}
      subjects:
      - kind: User
        name: ${local.gke_sa_email}
      RBAC

4. Mount a working kubeconfig into the Cloud Run container (Secret Manager
   secret: ${var.enable_secret_manager_kubeconfig ? google_secret_manager_secret.kubeconfig[0].id : "disabled"})
   or update cmd/cloud-run/main.go to fetch tokens from the GCP metadata
   server using Application Default Credentials and impersonation.

5. Deploy the container image:
      gcloud run services update ${google_cloud_run_v2_service.paprika.name} \
        --image=${var.image} \
        --region=${var.region} \
        --project=${local.cloud_run_project_id}
EOT
}

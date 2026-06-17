# Paprika Cloud Run Infrastructure

Production-ready Terraform for deploying the Paprika stateless plane on Cloud Run with private connectivity to a GKE control plane.

## What is provisioned

- Cloud Run service (`paprika-cloud-run`) running the `cmd/cloud-run/main.go` image
- Dedicated Cloud Run service account
- Impersonation IAM bindings to a GKE service account
- Serverless VPC Access connector for private GKE control-plane egress
- GKE RBAC ClusterRoleBinding for Paprika CRD read/write access
- Secret Manager secret for the kubeconfig placeholder

## Files

- `main.tf` — core resources
- `variables.tf` — tunable inputs
- `outputs.tf` — service URL, service accounts, and connection instructions
- `terraform.tfvars.example` — example values for dev/preview

## Project IDs

| Environment | Project ID                  |
|-------------|-----------------------------|
| Dev/Preview | `shorted-dev-aba5688f`      |
| Prod        | `rosy-clover-477102-t5`     |

## Usage

```bash
cd infra/cloud-run

# Dev/Preview
cp terraform.tfvars.example dev.tfvars
# Edit dev.tfvars, then:
terraform init
terraform workspace new dev || terraform workspace select dev
terraform plan -var-file=dev.tfvars
terraform apply -var-file=dev.tfvars

# Prod
cp terraform.tfvars.example prod.tfvars
# Edit prod.tfvars (project_id, gke_project_id, environment, etc.)
terraform workspace new prod || terraform workspace select prod
terraform plan -var-file=prod.tfvars
terraform apply -var-file=prod.tfvars
```

## Authentication model

The Cloud Run service account impersonates a dedicated GKE service account via
`roles/iam.serviceAccountTokenCreator`. The GKE service account is bound to a
ClusterRole that grants read/write access to Paprika CRDs.

## Important follow-up

The Cloud Run binary uses `clientcmd` to load a kubeconfig. You must either:

1. Update `cmd/cloud-run/main.go` to fetch access tokens from the GCP metadata
   server using Application Default Credentials and service-account impersonation.
2. Or mount a kubeconfig (via the created Secret Manager secret) that uses an
   `exec` plugin to obtain tokens for the impersonated GKE service account.

## Verification

```bash
terraform fmt -check
terraform validate
```

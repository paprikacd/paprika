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

# Versions
terraform {
  required_version = ">= 1.6"
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

provider "github" {
  token = var.github_token
  owner = var.repo_owner
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

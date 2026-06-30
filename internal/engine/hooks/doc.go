// Package hooks partitions rendered manifests into ArgoCD-compatible hook
// phases (PreSync, Sync, PostSync, SyncFail) and provides per-kind
// completion checkers for hook resources that need to reach a terminal
// state before the next phase runs.
//
// Annotation compat: paprika recognizes the standard ArgoCD annotations:
//   - argocd.argoproj.io/hook             (comma-separated phase list)
//   - argocd.argoproj.io/hook-delete-policy
//   - argocd.argoproj.io/hook-weight      (parsed, ignored in MVP)
//
// The string constants live in paprikav1 (api/pipelines/v1alpha1) so both
// the controller and agent can import them without a cycle.
package hooks

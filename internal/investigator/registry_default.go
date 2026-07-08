package investigator

// NewDefaultRegistry returns a Registry populated with all built-in plugins:
//   - 3 DataSources: Manifest, Events, Logs
//   - 8 Detectors: CrashLoop, OOMKilled, ImagePull, PendingScheduling,
//     DeploymentReplicasDrift, ConfigDrift, ForbiddenRbac,
//     EndpointMismatch
//   - 1 Narrator: DeterministicNarrator (always-on, never errors)
//
// Optional plugins (Anthropic narrator, MCP source, Prometheus source) live
// in `plugins/` subdirectories and self-register via init() when their
// respective env-var gates are set. See cmd/main.go where they're blank-imported.
func NewDefaultRegistry() *Registry {
	r := NewRegistry()

	// Sources.
	r.RegisterSource(&ManifestSource{})
	r.RegisterSource(&EventsSource{})
	r.RegisterSource(&LogsSource{})

	// Detectors.
	r.RegisterDetector(&CrashLoopDetector{})
	r.RegisterDetector(&OOMKilledDetector{})
	r.RegisterDetector(&ImagePullDetector{})
	r.RegisterDetector(&PendingSchedulingDetector{})
	r.RegisterDetector(&DeploymentReplicasDriftDetector{})
	r.RegisterDetector(&ConfigDriftDetector{})
	r.RegisterDetector(&ForbiddenRbacDetector{})
	r.RegisterDetector(&EndpointMismatchDetector{})

	// Narrators.
	r.RegisterNarrator(&DeterministicNarrator{})

	return r
}

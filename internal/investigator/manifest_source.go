package investigator

import "context"

// ManifestSource fetches the live manifest. The actual dynamic-client call
// lives in the handler (`s.collectInvestigatorInput`) because sources are
// decoded in a pipeline shared with detectors; this stub satisfies the
// interface so the default registry builds. Populating real evidence here
// would require injecting a dynamic client into the Registry, which we
// intentionally avoid to keep the registry testable.
//
// The handler short-circuits and augments Input.LiveManifest before invoking
// the registry; see collectInvestigatorInput.
type ManifestSource struct{}

// Name returns the source identifier.
func (s *ManifestSource) Name() string { return "manifest" }

// Collect returns no evidence; manifest population happens in the handler.
func (s *ManifestSource) Collect(ctx context.Context, ref ResourceRef) ([]Evidence, error) {
	return nil, nil
}

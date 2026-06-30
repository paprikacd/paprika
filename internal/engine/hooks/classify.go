package hooks

import (
	"bytes"
	"fmt"
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// Phase is a hook execution phase. Matches ArgoCD semantics.
type Phase string

const (
	PhasePreSync  Phase = "PreSync"
	PhaseSync     Phase = "Sync"
	PhasePostSync Phase = "PostSync"
	PhaseSyncFail Phase = "SyncFail"
)

// PairedObj is a parsed manifest paired with its original raw bytes (so the
// Sync-phase docs can be re-emitted without re-serializing parsed objects,
// preserving YAML comments / key order / scalar formatting).
type PairedObj struct {
	Obj *unstructured.Unstructured
	Raw []byte
}

// PairWithBytes pairs each parsed object with its source bytes from rawDocs.
// rawDocs is split using the same separator engine.SplitYAMLDocuments uses
// ("\n---\n"). The lengths must match; mismatch is an error.
func PairWithBytes(objs []*unstructured.Unstructured, rawDocs []byte) ([]PairedObj, error) {
	docs := splitDocs(rawDocs)
	if len(docs) != len(objs) {
		return nil, fmt.Errorf("PairWithBytes: %d objects but %d raw docs", len(objs), len(docs))
	}
	out := make([]PairedObj, len(objs))
	for i := range objs {
		out[i] = PairedObj{Obj: objs[i], Raw: docs[i]}
	}
	return out, nil
}

// splitDocs mirrors engine.SplitYAMLDocuments without the import (avoids an
// import cycle when engine itself wants to use this package later).
func splitDocs(raw []byte) [][]byte {
	if len(raw) == 0 {
		return nil
	}
	parts := strings.Split(string(raw), "\n---\n")
	out := make([][]byte, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		out = append(out, []byte(p))
	}
	return out
}

// Resource is a single parsed manifest tagged with its phase.
type Resource struct {
	Obj          *unstructured.Unstructured
	Raw          []byte
	Phase        Phase
	DeletePolicy string // raw value of HookDeletePolicyAnnotation; "" = BeforeHookCreation default
}

// Bucket is the phase-partitioned manifest set for a single release.
type Bucket struct {
	PreSync  []Resource
	Sync     []Resource
	PostSync []Resource
	SyncFail []Resource
}

// HasHooks reports whether any phase bucket (other than Sync) is non-empty.
func (b *Bucket) HasHooks() bool {
	return len(b.PreSync) > 0 || len(b.PostSync) > 0 || len(b.SyncFail) > 0
}

// SyncDocs returns the original raw bytes for the Sync-phase (non-hook)
// documents, joined with "\n---\n" separators.
func (b *Bucket) SyncDocs() []byte {
	var buf bytes.Buffer
	for i, r := range b.Sync {
		if i > 0 {
			buf.WriteString("\n---\n")
		}
		buf.Write(r.Raw)
	}
	return buf.Bytes()
}

// ClassifyPaired partitions paired manifests into phase buckets. Resources
// without the hook annotation land in Sync. Hook resources appear ONLY in
// their declared phase(s) — a hook annotated "PreSync,PostSync" appears in
// both PreSync and PostSync but NOT in Sync.
//
// Phase values are validated against the four known phases; unknown values
// cause the resource to fall back to Sync (treated as non-hook). The value
// "Sync" explicitly is ALSO treated as non-hook in MVP (divergence from
// ArgoCD, where hook=Sync is a real hook phase with completion-wait).
func ClassifyPaired(objs []PairedObj) (*Bucket, error) {
	b := &Bucket{}
	for _, po := range objs {
		annotations := po.Obj.GetAnnotations()
		hookAnn := annotations[paprikav1.HookAnnotation]
		phases, explicit := parseHookPhases(hookAnn)
		deletePolicy := annotations[paprikav1.HookDeletePolicyAnnotation]

		if !explicit {
			b.Sync = append(b.Sync, Resource{Obj: po.Obj, Raw: po.Raw, Phase: PhaseSync, DeletePolicy: deletePolicy})
			continue
		}

		for _, p := range phases {
			r := Resource{Obj: po.Obj, Raw: po.Raw, Phase: p, DeletePolicy: deletePolicy}
			switch p {
			case PhasePreSync:
				b.PreSync = append(b.PreSync, r)
			case PhasePostSync:
				b.PostSync = append(b.PostSync, r)
			case PhaseSyncFail:
				b.SyncFail = append(b.SyncFail, r)
			case PhaseSync:
				b.Sync = append(b.Sync, r)
			}
		}
	}
	return b, nil
}

// parseHookPhases parses the hook annotation value into a slice of phases.
// Returns (phases, explicit). explicit is false when the annotation is
// absent OR empty (the resource is a non-hook). Unknown phase values cause
// the entire annotation to be treated as non-hook (returns (nil, false)).
// The explicit value "Sync" is included in the phases slice so ClassifyPaired
// can place it in Sync (treated as non-hook per MVP divergence).
func parseHookPhases(value string) ([]Phase, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, false
	}
	var phases []Phase
	for _, raw := range strings.Split(value, ",") {
		raw = strings.TrimSpace(raw)
		switch Phase(raw) {
		case PhasePreSync:
			phases = append(phases, PhasePreSync)
		case PhasePostSync:
			phases = append(phases, PhasePostSync)
		case PhaseSyncFail:
			phases = append(phases, PhaseSyncFail)
		case PhaseSync:
			phases = append(phases, PhaseSync)
		default:
			return nil, false
		}
	}
	return phases, true
}

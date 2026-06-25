package pipelines

import (
	"strings"
	"testing"
)

func TestSanitizeArtifactName(t *testing.T) {
	t.Parallel()

	cases := []struct {
		pipeline, step, output, wantPrefix string
	}{
		{"my-pipeline", "build", "image", "my-pipeline-build-image"},
		{"MyPipeline", "Build_Step", "Image", "mypipeline-build-step-image"},
		{"very-long-pipeline-name-that-needs-truncation", "build", "image", "very-long-pipeline-name-that-needs-truncat-build-image"},
	}

	for _, tc := range cases {
		t.Run(tc.wantPrefix, func(t *testing.T) {
			t.Parallel()
			got := sanitizeArtifactName(tc.pipeline, tc.step, tc.output)
			if !strings.HasPrefix(got, tc.wantPrefix) && len(got) > 63 {
				t.Fatalf("sanitize(%q,%q,%q) = %q (len %d)", tc.pipeline, tc.step, tc.output, got, len(got))
			}
			if len(got) > 63 {
				t.Fatalf("sanitize(%q,%q,%q) = %q (len %d) exceeds 63", tc.pipeline, tc.step, tc.output, got, len(got))
			}
		})
	}
}

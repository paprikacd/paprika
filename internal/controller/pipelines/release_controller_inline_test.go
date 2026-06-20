package pipelines

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestReleaseReconciler_LoadManifestsFromConfigMap(t *testing.T) {
	t.Parallel()

	const ns = "default"
	const cmName = "inline-manifests"
	const manifestData = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: example\n"

	ctx := context.Background()

	buildClient := func(objs ...runtime.Object) *ReleaseReconciler {
		scheme := runtime.NewScheme()
		require.NoError(t, corev1.AddToScheme(scheme))
		require.NoError(t, paprikav1.AddToScheme(scheme))

		c := fake.NewClientBuilder().WithScheme(scheme).WithRuntimeObjects(objs...).Build()
		return NewReleaseReconciler(c)
	}

	tests := []struct {
		name        string
		release     *paprikav1.Release
		setupClient func() *ReleaseReconciler
		want        []byte
		wantErr     bool
		errContains string
	}{
		{
			name: "returns manifests.yaml from referenced ConfigMap",
			release: &paprikav1.Release{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "release-inline",
					Namespace: ns,
					UID:       types.UID("release-uid"),
				},
				Spec: paprikav1.ReleaseSpec{
					ManifestSource: &paprikav1.ManifestSource{
						ConfigMapRef: cmName,
					},
				},
			},
			setupClient: func() *ReleaseReconciler {
				cm := &corev1.ConfigMap{
					ObjectMeta: metav1.ObjectMeta{
						Name:      cmName,
						Namespace: ns,
					},
					Data: map[string]string{
						"manifests.yaml": manifestData,
					},
				}
				return buildClient(cm)
			},
			want:    []byte(manifestData),
			wantErr: false,
		},
		{
			name: "returns error when ConfigMap is missing",
			release: &paprikav1.Release{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "release-inline-missing",
					Namespace: ns,
					UID:       types.UID("release-uid-2"),
				},
				Spec: paprikav1.ReleaseSpec{
					ManifestSource: &paprikav1.ManifestSource{
						ConfigMapRef: cmName,
					},
				},
			},
			setupClient: func() *ReleaseReconciler {
				return buildClient()
			},
			want:        nil,
			wantErr:     true,
			errContains: "fetch manifest snapshot",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			r := tc.setupClient()
			got, err := r.loadManifestsFromConfigMap(ctx, tc.release)

			if tc.wantErr {
				require.Error(t, err)
				require.Contains(t, err.Error(), tc.errContains)
				return
			}

			require.NoError(t, err)
			require.Equal(t, tc.want, got)
		})
	}
}

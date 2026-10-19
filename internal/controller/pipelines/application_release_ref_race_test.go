package pipelines

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestPatchAppStatus_ReleaseRefOwnership(t *testing.T) {
	for _, tc := range []struct {
		name, initial, desired, published, want string
		inline, promotion, clear                bool
	}{
		{name: "publisher_replaces_nonempty_inline_ref", inline: true, initial: "old", desired: "old", published: "new", want: "new"},
		{name: "publisher_sets_initial_inline_ref", inline: true, published: "new", want: "new"},
		{name: "git_controller_adopts_new_release", initial: "old", desired: "new", published: "old", want: "new"},
		{name: "inline_promotion_controller_adopts_new_release", inline: true, promotion: true, initial: "old", desired: "new", published: "old", want: "new"},
		{name: "explicit_release_clear", inline: true, clear: true, initial: "old", published: "old"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			scheme := runtime.NewScheme()
			require.NoError(t, paprikav1.AddToScheme(scheme))
			app := &paprikav1.Application{
				ObjectMeta: metav1.ObjectMeta{Name: "release-ref-race", Namespace: "default"},
				Status:     paprikav1.ApplicationStatus{ReleaseRef: tc.initial, Phase: paprikav1.ApplicationPromoting},
			}
			if tc.inline {
				app.Spec.Source.Type = paprikav1.SourceTypeInline
			} else {
				app.Spec.Source.Type = paprikav1.SourceTypeGit
			}
			if tc.promotion {
				app.Spec.Trigger = &paprikav1.ApplicationTrigger{Type: paprikav1.ApplicationTriggerPromotion}
			}
			c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app).WithStatusSubresource(app).Build()
			var stale, publisher paprikav1.Application
			key := client.ObjectKeyFromObject(app)
			require.NoError(t, c.Get(ctx, key, &stale))
			require.NoError(t, c.Get(ctx, key, &publisher))
			// ApplyBundle can publish a new release while an earlier application
			// reconciliation is still evaluating health for its old snapshot.
			publisher.Status.ReleaseRef = tc.published
			require.NoError(t, c.Status().Update(ctx, &publisher))
			stale.Status.ReleaseRef = tc.desired
			stale.Status.Phase = paprikav1.ApplicationHealthy
			r := &ApplicationReconciler{client: c, Scheme: scheme}
			if tc.clear {
				require.NoError(t, r.patchAppStatusAllowingReleaseRefClear(ctx, &stale))
			} else {
				require.NoError(t, r.patchAppStatus(ctx, &stale))
			}
			var updated paprikav1.Application
			require.NoError(t, c.Get(ctx, key, &updated))
			require.Equal(t, tc.want, updated.Status.ReleaseRef)
			require.Equal(t, tc.want, stale.Status.ReleaseRef)
			require.Equal(t, paprikav1.ApplicationHealthy, updated.Status.Phase)
		})
	}
}

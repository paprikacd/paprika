package auth

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
)

func init() {
	_ = corev1alpha1.AddToScheme(scheme.Scheme)
}

func TestProjectAuthorizer(t *testing.T) {
	paymentsProject := &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Name: "payments", Namespace: "default"},
		Spec: corev1alpha1.AppProjectSpec{
			Roles: []corev1alpha1.AppProjectRole{{
				Subjects: []string{"alice"},
				Actions:  []string{"read"},
			}},
		},
	}

	groupProject := &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Name: "payments", Namespace: "default"},
		Spec: corev1alpha1.AppProjectSpec{
			Roles: []corev1alpha1.AppProjectRole{{
				Subjects: []string{"group:payments"},
				Actions:  []string{"*"},
			}},
		},
	}

	tests := []struct {
		name      string
		objs      []client.Object
		principal *Principal
		action    Action
		ns        string
		project   string
		wantErr   bool
	}{
		{
			name:      "allows when project empty",
			principal: &Principal{Subject: "any"},
			action:    ActionRead,
			ns:        "ns",
			project:   "",
			wantErr:   false,
		},
		{
			name:      "allows default missing project",
			principal: &Principal{Subject: "any"},
			action:    ActionRead,
			ns:        "ns",
			project:   "default",
			wantErr:   false,
		},
		{
			name:      "matching role allows",
			objs:      []client.Object{paymentsProject},
			principal: &Principal{Subject: "alice"},
			action:    ActionRead,
			ns:        "default",
			project:   "payments",
			wantErr:   false,
		},
		{
			name:      "non-matching subject denies",
			objs:      []client.Object{paymentsProject},
			principal: &Principal{Subject: "bob"},
			action:    ActionRead,
			ns:        "default",
			project:   "payments",
			wantErr:   true,
		},
		{
			name:      "group subject allows",
			objs:      []client.Object{groupProject},
			principal: &Principal{Subject: "bob", Groups: []string{"payments"}},
			action:    ActionWrite,
			ns:        "default",
			project:   "payments",
			wantErr:   false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			authz := NewProjectAuthorizer(fake.NewClientBuilder().WithObjects(tc.objs...).Build())
			err := authz.Authorize(context.Background(), tc.principal, tc.action, ResourceApplications, tc.ns, tc.project)
			if tc.wantErr {
				assert.Error(t, err)
			} else {
				require.NoError(t, err)
			}
		})
	}
}

package source

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestIsOCIURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		url  string
		want bool
	}{
		{"oci://registry.example.com/charts/mychart", true},
		{"oci://ghcr.io/org/chart:1.2.3", true},
		{"https://charts.example.com", false},
		{"http://charts.example.com", false},
		{"git@github.com:org/repo.git", false},
		{"", false},
	}
	for _, tc := range tests {
		t.Run(tc.url, func(t *testing.T) {
			assert.Equal(t, tc.want, IsOCIURL(tc.url))
		})
	}
}

package memlimit

import (
	"errors"
	"io/fs"
	"testing"

	"github.com/stretchr/testify/assert"
)

// fakeFiles serves cgroup files from a map and records every path it was asked for.
type fakeFiles struct {
	files map[string]string
	asked []string
}

func (f *fakeFiles) read(name string) ([]byte, error) {
	f.asked = append(f.asked, name)
	text, ok := f.files[name]
	if !ok {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}
	return []byte(text), nil
}

func noEnv(string) string { return "" }

func TestComputeReadsCgroupLimits(t *testing.T) {
	tests := []struct {
		name      string
		files     map[string]string
		env       map[string]string
		want      Limit
		wantOK    bool
		wantAsked []string
	}{
		{
			name:      "v2 numeric limit gives 90 percent",
			files:     map[string]string{cgroupV2Path: "1000\n"},
			want:      Limit{Bytes: 900, ContainerBytes: 1000, Source: cgroupV2Path},
			wantOK:    true,
			wantAsked: []string{cgroupV2Path},
		},
		{
			name:      "v2 limit of 256 MiB",
			files:     map[string]string{cgroupV2Path: "268435456"},
			want:      Limit{Bytes: 268435456 / 100 * 90, ContainerBytes: 268435456, Source: cgroupV2Path},
			wantOK:    true,
			wantAsked: []string{cgroupV2Path},
		},
		{
			name:      "v2 max is unlimited and v1 is not consulted",
			files:     map[string]string{cgroupV2Path: "max\n", cgroupV1Path: "2000\n"},
			wantOK:    false,
			wantAsked: []string{cgroupV2Path},
		},
		{
			name:      "v1 limit is used when v2 is absent",
			files:     map[string]string{cgroupV1Path: "2000\n"},
			want:      Limit{Bytes: 1800, ContainerBytes: 2000, Source: cgroupV1Path},
			wantOK:    true,
			wantAsked: []string{cgroupV2Path, cgroupV1Path},
		},
		{
			name:      "v1 unlimited sentinel is unlimited",
			files:     map[string]string{cgroupV1Path: "9223372036854771712\n"},
			wantOK:    false,
			wantAsked: []string{cgroupV2Path, cgroupV1Path},
		},
		{
			name:      "garbage v2 file applies nothing and does not fall back to v1",
			files:     map[string]string{cgroupV2Path: "lots\n", cgroupV1Path: "2000\n"},
			wantOK:    false,
			wantAsked: []string{cgroupV2Path},
		},
		{
			name:      "garbage v1 file applies nothing",
			files:     map[string]string{cgroupV1Path: "-1\n"},
			wantOK:    false,
			wantAsked: []string{cgroupV2Path, cgroupV1Path},
		},
		{
			name:      "zero limit is not a limit",
			files:     map[string]string{cgroupV2Path: "0\n"},
			wantOK:    false,
			wantAsked: []string{cgroupV2Path},
		},
		{
			name:      "limit too small to give a non-zero heap limit is ignored",
			files:     map[string]string{cgroupV2Path: "50\n"},
			wantOK:    false,
			wantAsked: []string{cgroupV2Path},
		},
		{
			name:      "no cgroup files applies nothing",
			files:     map[string]string{},
			wantOK:    false,
			wantAsked: []string{cgroupV2Path, cgroupV1Path},
		},
		{
			name:      "existing GOMEMLIMIT wins and nothing is read",
			files:     map[string]string{cgroupV2Path: "1000\n"},
			env:       map[string]string{"GOMEMLIMIT": "512MiB"},
			wantOK:    false,
			wantAsked: nil,
		},
		{
			name:      "empty GOMEMLIMIT is the same as unset",
			files:     map[string]string{cgroupV2Path: "1000\n"},
			env:       map[string]string{"GOMEMLIMIT": ""},
			want:      Limit{Bytes: 900, ContainerBytes: 1000, Source: cgroupV2Path},
			wantOK:    true,
			wantAsked: []string{cgroupV2Path},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			files := &fakeFiles{files: tt.files}
			getenv := noEnv
			if tt.env != nil {
				getenv = func(key string) string { return tt.env[key] }
			}
			got, ok := Compute(getenv, files.read)
			assert.Equal(t, tt.wantOK, ok)
			assert.Equal(t, tt.want, got)
			assert.Equal(t, tt.wantAsked, files.asked)
		})
	}
}

func TestComputeReportsUnreadableFilesAsNoLimit(t *testing.T) {
	read := func(string) ([]byte, error) { return nil, errors.New("permission denied") }
	_, ok := Compute(noEnv, read)
	assert.False(t, ok)
}

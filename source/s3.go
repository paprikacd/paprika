// Package source provides source resolution for git, S3, and other sources.
package source

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// S3Source represents an S3 object source.
type S3Source struct {
	Bucket    string
	Key       string
	Region    string
	Endpoint  string
	WorkDir   string
	AccessKey string
	SecretKey string
	Path      string
}

// Resolve downloads the S3 object and returns the local path.
func (s *S3Source) Resolve(ctx context.Context) (*ResolveResult, error) {
	cfg, err := s.loadConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("load aws config: %w", err)
	}

	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		if s.Endpoint != "" {
			o.BaseEndpoint = aws.String(s.Endpoint)
			o.UsePathStyle = true
		}
	})

	headOut, err := client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(s.Key),
	})
	if err != nil {
		return nil, fmt.Errorf("head object s3://%s/%s: %w", s.Bucket, s.Key, err)
	}

	etag := ""
	if headOut.ETag != nil {
		etag = strings.Trim(*headOut.ETag, `"`)
	}

	localDir := filepath.Join(s.WorkDir, "s3-cache", SanitizeName(s.Bucket))
	// #nosec G301 -- s3 cache requires world-readable directories
	if mkdirErr := os.MkdirAll(localDir, 0o755); mkdirErr != nil {
		return nil, fmt.Errorf("create s3 cache dir: %w", mkdirErr)
	}

	localFile := filepath.Join(localDir, filepath.Base(s.Key))
	if dlErr := s.downloadObject(ctx, client, localFile); dlErr != nil {
		return nil, dlErr
	}

	chartPath := localDir
	if s.Path != "" {
		chartPath = filepath.Join(localDir, s.Path)
	}

	dirHash, err := ComputeDirHash(chartPath)
	if err != nil {
		return nil, fmt.Errorf("compute chart hash: %w", err)
	}

	revision := etag
	if revision == "" {
		revision = dirHash[:16]
	}

	return &ResolveResult{
		LocalPath: chartPath,
		Hash:      dirHash,
		Revision:  revision,
	}, nil
}

func (s *S3Source) downloadObject(ctx context.Context, client *s3.Client, localFile string) error {
	tmpFile := localFile + ".tmp"

	// #nosec G304 -- tmpFile is constructed from sanitized key
	f, createErr := os.Create(tmpFile)
	if createErr != nil {
		return fmt.Errorf("create temp file: %w", createErr)
	}

	getOut, err := client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(s.Key),
	})
	if err != nil {
		_ = f.Close()
		_ = os.Remove(tmpFile)
		return fmt.Errorf("get object s3://%s/%s: %w", s.Bucket, s.Key, err)
	}
	defer func() { _ = getOut.Body.Close() }()

	if _, copyErr := io.Copy(f, getOut.Body); copyErr != nil {
		_ = f.Close()
		_ = os.Remove(tmpFile)
		return fmt.Errorf("download object: %w", copyErr)
	}
	_ = f.Close()

	if strings.HasSuffix(s.Key, ".tgz") || strings.HasSuffix(s.Key, ".tar.gz") {
		if tarErr := untarArchive(ctx, tmpFile, filepath.Dir(localFile)); tarErr != nil {
			_ = os.Remove(tmpFile)
			return fmt.Errorf("extract chart archive: %w", tarErr)
		}
		_ = os.Remove(tmpFile)
	} else {
		if renameErr := os.Rename(tmpFile, localFile); renameErr != nil {
			return fmt.Errorf("rename temp file: %w", renameErr)
		}
	}
	return nil
}

// loadConfig loads the AWS configuration.
func (s *S3Source) loadConfig(ctx context.Context) (aws.Config, error) {
	var opts []func(*awsconfig.LoadOptions) error
	if s.Region != "" {
		opts = append(opts, awsconfig.WithRegion(s.Region))
	}
	if s.Endpoint != "" && s.AccessKey != "" {
		opts = append(opts, awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(s.AccessKey, s.SecretKey, "")))
	} else if s.Endpoint != "" {
		opts = append(opts, awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider("test", "test", "")))
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return aws.Config{}, fmt.Errorf("loading AWS config: %w", err)
	}
	return cfg, nil
}

// untarArchive extracts a tar.gz archive to the destination directory.
func untarArchive(ctx context.Context, tarPath, dest string) error {
	// #nosec G204 -- tar extraction from trusted chart archives
	cmd := exec.CommandContext(ctx, "tar", "xzf", tarPath, "-C", dest)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("extracting archive: %w", err)
	}
	return nil
}

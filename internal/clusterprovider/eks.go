package clusterprovider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/eks"
	"github.com/aws/aws-sdk-go-v2/service/eks/types"
	"github.com/aws/smithy-go"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

// EKS enriches a Cluster through the AWS EKS API. Credentials resolve two
// ways: a credentialsSecretRef document with static keys, or — when the ref
// is absent — the SDK's default chain, which is where IRSA, pod identity and
// node-role credentials come from.
type EKS struct {
	// loadConfig and describe/list seams exist so tests can run without AWS.
	loadConfig func(ctx context.Context, region string, creds []byte) (aws.Config, error)
	newClient  func(cfg aws.Config) eksAPI
}

// eksAPI is the slice of the EKS client Describe uses, so tests can stub it.
type eksAPI interface {
	DescribeCluster(ctx context.Context, in *eks.DescribeClusterInput, opt ...func(*eks.Options)) (*eks.DescribeClusterOutput, error)
	ListClusters(ctx context.Context, in *eks.ListClustersInput, opt ...func(*eks.Options)) (*eks.ListClustersOutput, error)
	ListNodegroups(ctx context.Context, in *eks.ListNodegroupsInput, opt ...func(*eks.Options)) (*eks.ListNodegroupsOutput, error)
	DescribeNodegroup(ctx context.Context, in *eks.DescribeNodegroupInput, opt ...func(*eks.Options)) (*eks.DescribeNodegroupOutput, error)
}

// eksCredentialsDocument is the JSON shape credentialsSecretRef carries.
//
//nolint:tagliatelle // credential document fields follow cloud JSON conventions.
type eksCredentialsDocument struct {
	AccessKeyID     string `json:"access_key_id"`
	SecretAccessKey string `json:"secret_access_key"`
	SessionToken    string `json:"session_token,omitempty"`
}

// Describe resolves the EKS cluster — by name when the spec names one, by
// apiserver endpoint otherwise — and reports its node groups as pools.
func (e *EKS) Describe(ctx context.Context, req *Request) (*Details, error) {
	if req.Region == "" {
		return nil, fmt.Errorf("%w: eks requires spec.provider.region", ErrNotConfigured)
	}

	load := e.loadConfig
	if load == nil {
		load = loadAWSConfig
	}
	cfg, err := load(ctx, req.Region, req.Credentials)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNotConfigured, sanitizeProviderError(err))
	}

	newClient := e.newClient
	if newClient == nil {
		newClient = func(c aws.Config) eksAPI { return eks.NewFromConfig(c) }
	}
	cli := newClient(cfg)

	cluster, err := e.resolveCluster(ctx, cli, req)
	if err != nil {
		return nil, err
	}

	pools, err := e.nodeGroups(ctx, cli, aws.ToString(cluster.Name))
	if err != nil {
		return nil, err
	}

	return &Details{
		ClusterID: aws.ToString(cluster.Name),
		Region:    req.Region,
		Version:   aws.ToString(cluster.Version),
		NodePools: pools,
	}, nil
}

func (e *EKS) resolveCluster(ctx context.Context, cli eksAPI, req *Request) (*types.Cluster, error) {
	if req.ClusterID != "" {
		out, err := cli.DescribeCluster(ctx, &eks.DescribeClusterInput{Name: aws.String(req.ClusterID)})
		if err != nil {
			return nil, mapAWSError(err)
		}
		return out.Cluster, nil
	}

	host := endpointHost(req.Endpoint)
	if host == "" {
		return nil, ErrNotMatched
	}
	list, err := cli.ListClusters(ctx, &eks.ListClustersInput{})
	if err != nil {
		return nil, mapAWSError(err)
	}
	for _, name := range list.Clusters {
		out, err := cli.DescribeCluster(ctx, &eks.DescribeClusterInput{Name: aws.String(name)})
		if err != nil {
			continue
		}
		if endpointHost(aws.ToString(out.Cluster.Endpoint)) == host {
			return out.Cluster, nil
		}
	}
	return nil, ErrNotMatched
}

func (e *EKS) nodeGroups(ctx context.Context, cli eksAPI, clusterName string) ([]clustersv1alpha1.ClusterNodePool, error) {
	list, err := cli.ListNodegroups(ctx, &eks.ListNodegroupsInput{ClusterName: aws.String(clusterName)})
	if err != nil {
		return nil, mapAWSError(err)
	}

	pools := make([]clustersv1alpha1.ClusterNodePool, 0, len(list.Nodegroups))
	for _, name := range list.Nodegroups {
		out, err := cli.DescribeNodegroup(ctx, &eks.DescribeNodegroupInput{
			ClusterName:   aws.String(clusterName),
			NodegroupName: aws.String(name),
		})
		if err != nil {
			return nil, mapAWSError(err)
		}
		group := out.Nodegroup
		pool := clustersv1alpha1.ClusterNodePool{Name: name}
		if len(group.InstanceTypes) > 0 {
			pool.MachineType = group.InstanceTypes[0]
		}
		if group.ScalingConfig != nil {
			pool.NodeCount = aws.ToInt32(group.ScalingConfig.DesiredSize)
			pool.MinNodes = aws.ToInt32(group.ScalingConfig.MinSize)
			pool.MaxNodes = aws.ToInt32(group.ScalingConfig.MaxSize)
			pool.AutoScaled = aws.ToInt32(group.ScalingConfig.MaxSize) > 0
		}
		pools = append(pools, pool)
	}
	return pools, nil
}

// loadAWSConfig resolves AWS credentials: a static pair from the secret
// document when one is supplied, or the SDK default chain otherwise. The
// default chain is the ambient-identity path — IRSA, pod identity, instance
// role — which is what "no secret" is supposed to mean.
func loadAWSConfig(ctx context.Context, region string, creds []byte) (aws.Config, error) {
	options := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(region)}

	if len(creds) > 0 {
		var doc eksCredentialsDocument
		if err := json.Unmarshal(creds, &doc); err != nil {
			return aws.Config{}, fmt.Errorf("credentials document is not valid JSON: %w", err)
		}
		if doc.AccessKeyID == "" || doc.SecretAccessKey == "" {
			return aws.Config{}, errors.New("credentials document requires access_key_id and secret_access_key")
		}
		options = append(options, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(doc.AccessKeyID, doc.SecretAccessKey, doc.SessionToken)))
	}

	cfg, err := awsconfig.LoadDefaultConfig(ctx, options...)
	if err != nil {
		return aws.Config{}, fmt.Errorf("loading aws config: %w", err)
	}
	return cfg, nil
}

// mapAWSError classifies AWS failures: auth and policy denials are Forbidden
// (the credential reached AWS and was refused), everything else is a plain
// error. Smithy's ErrorCode is the stable signal — message text is not.
func mapAWSError(err error) error {
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		code := apiErr.ErrorCode()
		if strings.Contains(code, "Unauthorized") || strings.Contains(code, "AccessDenied") ||
			code == "InvalidClientTokenId" || code == "SignatureDoesNotMatch" ||
			code == "ExpiredToken" || code == "ExpiredTokenException" {
			return fmt.Errorf("%w: %s", ErrForbidden, code)
		}
		if code == "ResourceNotFoundException" {
			return ErrNotMatched
		}
	}
	return fmt.Errorf("eks api call: %w", err)
}

// sanitizeProviderError strips request/endpoint detail from an error before
// it can travel into cluster status — the same rule the fleet handlers apply.
func sanitizeProviderError(err error) string {
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		return apiErr.ErrorCode()
	}
	return "credential resolution failed"
}

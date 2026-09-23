package clusterprovider

import (
	"context"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/eks"
	"github.com/aws/aws-sdk-go-v2/service/eks/types"
	"github.com/stretchr/testify/require"
)

type fakeEKS struct {
	clusters   map[string]*types.Cluster
	nodegroups map[string][]*types.Nodegroup
}

func (f *fakeEKS) DescribeCluster(_ context.Context, in *eks.DescribeClusterInput, _ ...func(*eks.Options)) (*eks.DescribeClusterOutput, error) {
	cluster, ok := f.clusters[aws.ToString(in.Name)]
	if !ok {
		return nil, &types.ResourceNotFoundException{}
	}
	return &eks.DescribeClusterOutput{Cluster: cluster}, nil
}

func (f *fakeEKS) ListClusters(_ context.Context, _ *eks.ListClustersInput, _ ...func(*eks.Options)) (*eks.ListClustersOutput, error) {
	names := make([]string, 0, len(f.clusters))
	for name := range f.clusters {
		names = append(names, name)
	}
	return &eks.ListClustersOutput{Clusters: names}, nil
}

func (f *fakeEKS) ListNodegroups(_ context.Context, in *eks.ListNodegroupsInput, _ ...func(*eks.Options)) (*eks.ListNodegroupsOutput, error) {
	groups := f.nodegroups[aws.ToString(in.ClusterName)]
	names := make([]string, 0, len(groups))
	for _, g := range groups {
		names = append(names, aws.ToString(g.NodegroupName))
	}
	return &eks.ListNodegroupsOutput{Nodegroups: names}, nil
}

func (f *fakeEKS) DescribeNodegroup(_ context.Context, in *eks.DescribeNodegroupInput, _ ...func(*eks.Options)) (*eks.DescribeNodegroupOutput, error) {
	for _, g := range f.nodegroups[aws.ToString(in.ClusterName)] {
		if aws.ToString(g.NodegroupName) == aws.ToString(in.NodegroupName) {
			return &eks.DescribeNodegroupOutput{Nodegroup: g}, nil
		}
	}
	return nil, &types.ResourceNotFoundException{}
}

func fakeLoadConfig(aws.Config, error) func(context.Context, string, []byte) (aws.Config, error) {
	return func(context.Context, string, []byte) (aws.Config, error) { return aws.Config{}, nil }
}

func TestEKSDescribeByName(t *testing.T) {
	t.Parallel()

	fake := &fakeEKS{
		clusters: map[string]*types.Cluster{
			"prod": {Name: aws.String("prod"), Version: aws.String("1.31"), Endpoint: aws.String("https://prod.eks.amazonaws.com")},
		},
		nodegroups: map[string][]*types.Nodegroup{
			"prod": {{
				NodegroupName: aws.String("workers"),
				InstanceTypes: []string{"m6i.large"},
				ScalingConfig: &types.NodegroupScalingConfig{
					DesiredSize: aws.Int32(4), MinSize: aws.Int32(2), MaxSize: aws.Int32(10),
				},
			}},
		},
	}

	e := &EKS{
		loadConfig: fakeLoadConfig(aws.Config{}, nil),
		newClient:  func(aws.Config) eksAPI { return fake },
	}
	details, err := e.Describe(context.Background(), &Request{Region: "us-east-1", ClusterID: "prod"})
	require.NoError(t, err)
	require.Equal(t, "prod", details.ClusterID)
	require.Equal(t, "us-east-1", details.Region)
	require.Equal(t, "1.31", details.Version)
	require.Len(t, details.NodePools, 1)
	require.Equal(t, "workers", details.NodePools[0].Name)
	require.Equal(t, "m6i.large", details.NodePools[0].MachineType)
	require.Equal(t, int32(4), details.NodePools[0].NodeCount)
	require.Equal(t, int32(2), details.NodePools[0].MinNodes)
	require.Equal(t, int32(10), details.NodePools[0].MaxNodes)
	require.True(t, details.NodePools[0].AutoScaled)
}

func TestEKSDescribeMatchesByEndpoint(t *testing.T) {
	t.Parallel()

	fake := &fakeEKS{
		clusters: map[string]*types.Cluster{
			"prod": {Name: aws.String("prod"), Endpoint: aws.String("https://AAAA.gr7.us-east-1.eks.amazonaws.com")},
			"dev":  {Name: aws.String("dev"), Endpoint: aws.String("https://BBBB.gr7.us-east-1.eks.amazonaws.com")},
		},
	}
	e := &EKS{
		loadConfig: fakeLoadConfig(aws.Config{}, nil),
		newClient:  func(aws.Config) eksAPI { return fake },
	}
	details, err := e.Describe(context.Background(), &Request{
		Region: "us-east-1", Endpoint: "https://BBBB.gr7.us-east-1.eks.amazonaws.com",
	})
	require.NoError(t, err)
	require.Equal(t, "dev", details.ClusterID)
}

func TestEKSDescribeMissingInputs(t *testing.T) {
	t.Parallel()

	t.Run("region required", func(t *testing.T) {
		t.Parallel()
		e := &EKS{loadConfig: fakeLoadConfig(aws.Config{}, nil)}
		_, err := e.Describe(context.Background(), &Request{ClusterID: "x"})
		require.ErrorIs(t, err, ErrNotConfigured)
	})

	t.Run("no endpoint match", func(t *testing.T) {
		t.Parallel()
		e := &EKS{
			loadConfig: fakeLoadConfig(aws.Config{}, nil),
			newClient: func(aws.Config) eksAPI {
				return &fakeEKS{clusters: map[string]*types.Cluster{
					"prod": {Name: aws.String("prod"), Endpoint: aws.String("https://prod.eks.amazonaws.com")},
				}}
			},
		}
		_, err := e.Describe(context.Background(), &Request{Region: "r", Endpoint: "https://unknown.example.com"})
		require.ErrorIs(t, err, ErrNotMatched)
	})
}

func TestLoadAWSConfigStaticCreds(t *testing.T) {
	t.Parallel()

	cfg, err := loadAWSConfig(context.Background(), "us-east-1",
		[]byte(`{"access_key_id":"AKID","secret_access_key":"SECRET"}`))
	require.NoError(t, err)
	creds, err := cfg.Credentials.Retrieve(context.Background())
	require.NoError(t, err)
	require.Equal(t, "AKID", creds.AccessKeyID)

	_, err = loadAWSConfig(context.Background(), "us-east-1", []byte(`{"access_key_id":"AKID"}`))
	require.Error(t, err)

	_, err = loadAWSConfig(context.Background(), "us-east-1", []byte(`not json`))
	require.Error(t, err)
}

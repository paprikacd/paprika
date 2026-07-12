package apiserver

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

const queryReleasesUnimplementedMessage = "release query is not implemented"

func (*PaprikaServer) QueryReleases(
	context.Context,
	*connect.Request[paprikav1.QueryReleasesRequest],
) (*connect.Response[paprikav1.QueryReleasesResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New(queryReleasesUnimplementedMessage))
}

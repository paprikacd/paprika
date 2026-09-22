package mcp

import (
	"context"
	"encoding/json"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

// writeToolRPCs maps each write tool to the Connect RPC(s) it covers. Task
// 10's completeness guard consumes this to verify every proto RPC is either
// exposed as a tool or explicitly opted out. Every write tool below dispatch
// to exactly one RPC, unlike a couple of the read tools.
var writeToolRPCs = map[string][]string{
	"sync_application": {"SyncApplication"},
	"approve_gate":     {"ApproveGate"},
	"reject_gate":      {"RejectGate"},
	"rollback_release": {"RollbackRelease"},
	"promote_rollout":  {"PromoteRollout"},
	"abort_rollout":    {"AbortRollout"},
	"retry_step":       {"RetryStep"},
	"skip_step":        {"SkipStep"},
	"cancel_pipeline":  {"CancelPipeline"},
	"hold_rollout":     {"HoldRollout"},
	"resume_rollout":   {"ResumeRollout"},
}

// confirmationTokenProperty is the schema fragment every destructive write
// tool adds to its InputSchema so a caller can present the token issued by
// the Invoker's confirmation gate (see gateDestructive in invoke.go). It is
// never read by a tool's own Invoke func: Go's JSON decoding silently drops
// it since none of the argument structs below declare a matching field.
const confirmationTokenProperty = `"confirmation_token":{"type":"string","description":"Token from the unconfirmed call, required to execute this destructive action."}`

// RegisterWriteTools registers the write tool surface: every mutating
// Connect RPC exposed over MCP. Each tool maps to exactly one RPC. Tools
// whose action cannot be cleanly undone are marked Destructive, which gates
// them behind the Invoker's confirmation flow before they execute; see the
// spec's table for the exact list, reproduced in tools_write_test.go.
func RegisterWriteTools(r *Registry) error {
	tools := []Tool{
		writeSyncApplicationTool(),
		writeApproveGateTool(),
		writeRejectGateTool(),
		writeRollbackReleaseTool(),
		writePromoteRolloutTool(),
		writeAbortRolloutTool(),
		writeRetryStepTool(),
		writeSkipStepTool(),
		writeCancelPipelineTool(),
		writeHoldRolloutTool(),
		writeResumeRolloutTool(),
	}
	for _, t := range tools {
		if err := r.Register(t); err != nil {
			return err
		}
	}
	return nil
}

func writeSyncApplicationTool() Tool {
	return Tool{
		Name:        "sync_application",
		Description: "Trigger a sync of an application to its target source state.",
		Scope:       ScopeWrite,
		Destructive: false,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"name":{"type":"string"},
				"namespace":{"type":"string"}
			},
			"required":["name","namespace"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			resp, err := c.SyncApplication(ctx, connect.NewRequest(&v1.SyncApplicationRequest{
				Name:      in.string("name"),
				Namespace: in.string("namespace"),
			}))
			if err != nil {
				return nil, fmt.Errorf("sync_application: %w", err)
			}
			return resp.Msg, nil
		},
	}
}

func writeApproveGateTool() Tool {
	return Tool{
		Name:        "approve_gate",
		Description: "Approve a pending progressive-delivery gate for an application.",
		Scope:       ScopeWrite,
		Destructive: false,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"name":{"type":"string"},
				"namespace":{"type":"string"},
				"gate":{"type":"string"}
			},
			"required":["name","namespace","gate"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			resp, err := c.ApproveGate(ctx, connect.NewRequest(&v1.ApproveGateRequest{
				Name:      in.string("name"),
				Namespace: in.string("namespace"),
				Gate:      in.string("gate"),
			}))
			if err != nil {
				return nil, fmt.Errorf("approve_gate: %w", err)
			}
			return resp.Msg, nil
		},
	}
}

func writeRejectGateTool() Tool {
	return Tool{
		Name:        "reject_gate",
		Description: "Reject a pending progressive-delivery gate for an application.",
		Scope:       ScopeWrite,
		Destructive: false,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"name":{"type":"string"},
				"namespace":{"type":"string"},
				"gate":{"type":"string"}
			},
			"required":["name","namespace","gate"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			resp, err := c.RejectGate(ctx, connect.NewRequest(&v1.RejectGateRequest{
				Name:      in.string("name"),
				Namespace: in.string("namespace"),
				Gate:      in.string("gate"),
			}))
			if err != nil {
				return nil, fmt.Errorf("reject_gate: %w", err)
			}
			return resp.Msg, nil
		},
	}
}

// writeRollbackReleaseTool rolls a release back to its previous revision.
// RollbackReleaseRequest carries only namespace and name (see api.proto):
// there is no revision field to target a specific prior revision, so none is
// accepted here — the RPC always rolls back to the immediately preceding
// release.
func writeRollbackReleaseTool() Tool {
	return Tool{
		Name:        "rollback_release",
		Description: "Roll an application's release back to its previous revision. Destructive: requires confirmation.",
		Scope:       ScopeWrite,
		Destructive: true,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"namespace":{"type":"string"},
				"name":{"type":"string"},
				` + confirmationTokenProperty + `
			},
			"required":["namespace","name"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			resp, err := c.RollbackRelease(ctx, connect.NewRequest(&v1.RollbackReleaseRequest{
				Namespace: in.string("namespace"),
				Name:      in.string("name"),
			}))
			if err != nil {
				return nil, fmt.Errorf("rollback_release: %w", err)
			}
			return resp.Msg, nil
		},
	}
}

func writePromoteRolloutTool() Tool {
	return Tool{
		Name:        "promote_rollout",
		Description: "Promote a progressive rollout to its next step immediately, skipping any remaining wait or analysis for the current step. Destructive: requires confirmation.",
		Scope:       ScopeWrite,
		Destructive: true,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"namespace":{"type":"string"},
				"name":{"type":"string"},
				` + confirmationTokenProperty + `
			},
			"required":["namespace","name"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			resp, err := c.PromoteRollout(ctx, connect.NewRequest(&v1.PromoteRolloutRequest{
				Namespace: in.string("namespace"),
				Name:      in.string("name"),
			}))
			if err != nil {
				return nil, fmt.Errorf("promote_rollout: %w", err)
			}
			return resp.Msg, nil
		},
	}
}

func writeAbortRolloutTool() Tool {
	return Tool{
		Name:        "abort_rollout",
		Description: "Abort a progressive rollout, reverting traffic to the stable version. Destructive: requires confirmation.",
		Scope:       ScopeWrite,
		Destructive: true,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"namespace":{"type":"string"},
				"name":{"type":"string"},
				` + confirmationTokenProperty + `
			},
			"required":["namespace","name"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			resp, err := c.AbortRollout(ctx, connect.NewRequest(&v1.AbortRolloutRequest{
				Namespace: in.string("namespace"),
				Name:      in.string("name"),
			}))
			if err != nil {
				return nil, fmt.Errorf("abort_rollout: %w", err)
			}
			return resp.Msg, nil
		},
	}
}

func writeRetryStepTool() Tool {
	return Tool{
		Name:        "retry_step",
		Description: "Retry a failed step in a pipeline run.",
		Scope:       ScopeWrite,
		Destructive: false,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"pipeline_name":{"type":"string"},
				"pipeline_namespace":{"type":"string"},
				"step_name":{"type":"string"}
			},
			"required":["pipeline_name","pipeline_namespace","step_name"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			resp, err := c.RetryStep(ctx, connect.NewRequest(&v1.RetryStepRequest{
				PipelineName:      in.string("pipeline_name"),
				PipelineNamespace: in.string("pipeline_namespace"),
				StepName:          in.string("step_name"),
			}))
			if err != nil {
				return nil, fmt.Errorf("retry_step: %w", err)
			}
			return resp.Msg, nil
		},
	}
}

// writeSkipStepTool skips a pipeline step, permanently bypassing whatever
// that step would otherwise have done (including gates such as approvals).
// Unlike retry_step, this cannot be undone by trying again, so it is marked
// Destructive.
func writeSkipStepTool() Tool {
	return Tool{
		Name:        "skip_step",
		Description: "Skip a step in a pipeline run, bypassing whatever it would otherwise have done. Destructive: requires confirmation.",
		Scope:       ScopeWrite,
		Destructive: true,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"pipeline_name":{"type":"string"},
				"pipeline_namespace":{"type":"string"},
				"step_name":{"type":"string"},
				` + confirmationTokenProperty + `
			},
			"required":["pipeline_name","pipeline_namespace","step_name"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			resp, err := c.SkipStep(ctx, connect.NewRequest(&v1.SkipStepRequest{
				PipelineName:      in.string("pipeline_name"),
				PipelineNamespace: in.string("pipeline_namespace"),
				StepName:          in.string("step_name"),
			}))
			if err != nil {
				return nil, fmt.Errorf("skip_step: %w", err)
			}
			return resp.Msg, nil
		},
	}
}

func writeCancelPipelineTool() Tool {
	return Tool{
		Name:        "cancel_pipeline",
		Description: "Cancel a running pipeline. Destructive: requires confirmation.",
		Scope:       ScopeWrite,
		Destructive: true,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"name":{"type":"string"},
				"namespace":{"type":"string"},
				` + confirmationTokenProperty + `
			},
			"required":["name","namespace"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			resp, err := c.CancelPipeline(ctx, connect.NewRequest(&v1.CancelPipelineRequest{
				Name:      in.string("name"),
				Namespace: in.string("namespace"),
			}))
			if err != nil {
				return nil, fmt.Errorf("cancel_pipeline: %w", err)
			}
			return resp.Msg, nil
		},
	}
}

func writeHoldRolloutTool() Tool {
	return Tool{
		Name:        "hold_rollout",
		Description: "Place a hold on a progressive rollout, pausing it at its current step until resumed or the hold expires.",
		Scope:       ScopeWrite,
		Destructive: false,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"namespace":{"type":"string"},
				"name":{"type":"string"},
				"reason":{"type":"string"},
				"expires_at_unix_ms":{"type":"integer"}
			},
			"required":["namespace","name"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			resp, err := c.HoldRollout(ctx, connect.NewRequest(&v1.HoldRolloutRequest{
				Namespace:       in.string("namespace"),
				Name:            in.string("name"),
				Reason:          in.string("reason"),
				ExpiresAtUnixMs: in.int64("expires_at_unix_ms"),
			}))
			if err != nil {
				return nil, fmt.Errorf("hold_rollout: %w", err)
			}
			return resp.Msg, nil
		},
	}
}

func writeResumeRolloutTool() Tool {
	return Tool{
		Name:        "resume_rollout",
		Description: "Resume a held progressive rollout, lifting any active hold.",
		Scope:       ScopeWrite,
		Destructive: false,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"namespace":{"type":"string"},
				"name":{"type":"string"},
				"reason":{"type":"string"}
			},
			"required":["namespace","name"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			resp, err := c.ResumeRollout(ctx, connect.NewRequest(&v1.ResumeRolloutRequest{
				Namespace: in.string("namespace"),
				Name:      in.string("name"),
				Reason:    in.string("reason"),
			}))
			if err != nil {
				return nil, fmt.Errorf("resume_rollout: %w", err)
			}
			return resp.Msg, nil
		},
	}
}

// int64 reads a JSON number field as an int64. JSON numbers decode to
// float64 in a map[string]any, so an absent value is reported as 0; that
// matches the field's own zero value (no hold expiry set).
func (a toolArgs) int64(key string) int64 {
	f, ok := a[key].(float64)
	if !ok {
		return 0
	}
	return int64(f)
}

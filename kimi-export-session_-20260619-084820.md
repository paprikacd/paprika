---
session_id: session_c62b6d92-1529-479f-b118-499dc294e38b
exported_at: 2026-06-19T08:48:20.799Z
work_dir: /Users/benebsworth/projects/paprika
message_count: 208
token_count: 198634
---

# Kimi Session Export

## Overview

- **Topic**: <notification id="task:bash-ur3fo95a:completed" category="task" type="task.compl…
- **Conversation**: 4 turns | 103 tool calls

---

## Turn 1

### User

<notification id="task:bash-ur3fo95a:completed" category="task" type="task.completed" source_kind="background_task" source_id="bash-ur3fo95a">
Title: Background process completed
Severity: info
Poll third e2e CI run until complete completed.
</notification>

### Assistant

<details><summary>Thinking</summary>

Check result.

</details>

#### Tool Call: Bash (`cat /tmp/e2e-ci-poll3.log && echo "---TAIL---" && tail -60 /…`)
<!-- call_id: tool_Hgdxkgcgy0bcOdlY5eWJgh5M -->
```json
{
  "command": "cat /tmp/e2e-ci-poll3.log && echo \"---TAIL---\" && tail -60 /tmp/e2e-ci3.log",
  "timeout": 30
}
```

<details><summary>Tool Result: Bash (`cat /tmp/e2e-ci-poll3.log && echo "---TAIL---" && tail -60 /…`)</summary>

<!-- call_id: tool_Hgdxkgcgy0bcOdlY5eWJgh5M -->
04:16:28 status=in_progress conclusion=
04:17:00 status=in_progress conclusion=
04:17:32 status=in_progress conclusion=
04:18:04 status=in_progress conclusion=
04:18:36 status=in_progress conclusion=
04:19:08 status=in_progress conclusion=
04:19:40 status=in_progress conclusion=
04:20:12 status=in_progress conclusion=
04:20:45 status=in_progress conclusion=
04:21:17 status=in_progress conclusion=
04:21:48 status=in_progress conclusion=
04:22:20 status=in_progress conclusion=
04:22:52 status=in_progress conclusion=
04:23:24 status=in_progress conclusion=
04:23:56 status=in_progress conclusion=
04:24:28 status=in_progress conclusion=
04:24:59 status=in_progress conclusion=
04:25:31 status=in_progress conclusion=
04:26:03 status=in_progress conclusion=
04:26:35 status=in_progress conclusion=
04:27:07 status=in_progress conclusion=
04:27:39 status=completed conclusion=success
completed conclusion=success
---TAIL---
Run on Ubuntu	Cleanup kind cluster	2026-06-19T04:27:04.3535710Z   E2E_SKIP_IMAGE_BUILD: true
Run on Ubuntu	Cleanup kind cluster	2026-06-19T04:27:04.3535961Z   E2E_SKIP_IMAGE_LOAD: true
Run on Ubuntu	Cleanup kind cluster	2026-06-19T04:27:04.3536215Z   KIND_CLUSTER: paprika-test-e2e
Run on Ubuntu	Cleanup kind cluster	2026-06-19T04:27:04.3536490Z ##[endgroup]
Run on Ubuntu	Cleanup kind cluster	2026-06-19T04:27:04.4016885Z Deleting cluster "paprika-test-e2e" ...
Run on Ubuntu	Cleanup kind cluster	2026-06-19T04:27:04.9041180Z Deleted nodes: ["paprika-test-e2e-control-plane"]
Run on Ubuntu	Post Build demo image	﻿2026-06-19T04:27:04.9149915Z Node 20 is being deprecated. This workflow is running with Node 24 by default. If you need to temporarily use Node 20, you can set the ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true environment variable. For more information see: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/
Run on Ubuntu	Post Build demo image	2026-06-19T04:27:04.9151109Z Post job cleanup.
Run on Ubuntu	Post Build demo image	2026-06-19T04:27:05.1397982Z ##[group]Removing temp folder /home/runner/work/_temp/docker-actions-toolkit-WGoiC1
Run on Ubuntu	Post Build demo image	2026-06-19T04:27:05.1403081Z (node:30535) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.
Run on Ubuntu	Post Build demo image	2026-06-19T04:27:05.1404141Z (Use `node --trace-deprecation ...` to show where the warning was created)
Run on Ubuntu	Post Build demo image	2026-06-19T04:27:05.1405121Z ##[endgroup]
Run on Ubuntu	Post Build demo image	2026-06-19T04:27:05.1405567Z ##[group]Post cache
Run on Ubuntu	Post Build demo image	2026-06-19T04:27:05.1407114Z State not set
Run on Ubuntu	Post Build demo image	2026-06-19T04:27:05.1408013Z ##[endgroup]
Run on Ubuntu	Post Build manager image	﻿2026-06-19T04:27:05.1537138Z Node 20 is being deprecated. This workflow is running with Node 24 by default. If you need to temporarily use Node 20, you can set the ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true environment variable. For more information see: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/
Run on Ubuntu	Post Build manager image	2026-06-19T04:27:05.1538329Z Post job cleanup.
Run on Ubuntu	Post Build manager image	2026-06-19T04:27:05.3707551Z ##[group]Removing temp folder /home/runner/work/_temp/docker-actions-toolkit-3H31ZC
Run on Ubuntu	Post Build manager image	2026-06-19T04:27:05.3713025Z (node:30543) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.
Run on Ubuntu	Post Build manager image	2026-06-19T04:27:05.3714359Z (Use `node --trace-deprecation ...` to show where the warning was created)
Run on Ubuntu	Post Build manager image	2026-06-19T04:27:05.3715341Z ##[endgroup]
Run on Ubuntu	Post Build manager image	2026-06-19T04:27:05.3715997Z ##[group]Post cache
Run on Ubuntu	Post Build manager image	2026-06-19T04:27:05.3716434Z State not set
Run on Ubuntu	Post Build manager image	2026-06-19T04:27:05.3724531Z ##[endgroup]
Run on Ubuntu	Post Setup Docker Buildx	﻿2026-06-19T04:27:05.3869866Z Node 20 is being deprecated. This workflow is running with Node 24 by default. If you need to temporarily use Node 20, you can set the ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true environment variable. For more information see: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/
Run on Ubuntu	Post Setup Docker Buildx	2026-06-19T04:27:05.3871877Z Post job cleanup.
Run on Ubuntu	Post Setup Docker Buildx	2026-06-19T04:27:05.6352425Z ##[group]Removing builder
Run on Ubuntu	Post Setup Docker Buildx	2026-06-19T04:27:05.6359396Z (node:30551) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.
Run on Ubuntu	Post Setup Docker Buildx	2026-06-19T04:27:05.6360565Z (Use `node --trace-deprecation ...` to show where the warning was created)
Run on Ubuntu	Post Setup Docker Buildx	2026-06-19T04:27:05.7290998Z [command]/usr/bin/docker buildx rm builder-e3cdc00a-0ce7-4e6f-a2ae-c88d969b41c2
Run on Ubuntu	Post Setup Docker Buildx	2026-06-19T04:27:09.3556184Z builder-e3cdc00a-0ce7-4e6f-a2ae-c88d969b41c2 removed
Run on Ubuntu	Post Setup Docker Buildx	2026-06-19T04:27:09.3571888Z ##[endgroup]
Run on Ubuntu	Post Setup Docker Buildx	2026-06-19T04:27:09.3572568Z ##[group]Cleaning up certificates
Run on Ubuntu	Post Setup Docker Buildx	2026-06-19T04:27:09.3574117Z ##[endgroup]
Run on Ubuntu	Post Setup Docker Buildx	2026-06-19T04:27:09.3575072Z ##[group]Post cache
Run on Ubuntu	Post Setup Docker Buildx	2026-06-19T04:27:09.3576732Z State not set
Run on Ubuntu	Post Setup Docker Buildx	2026-06-19T04:27:09.3577346Z ##[endgroup]
Run on Ubuntu	Post Setup Go	﻿2026-06-19T04:27:09.3706839Z Post job cleanup.
Run on Ubuntu	Post Setup Go	2026-06-19T04:27:09.5050542Z [command]/opt/hostedtoolcache/go/1.26.4/x64/bin/go env GOMODCACHE
Run on Ubuntu	Post Setup Go	2026-06-19T04:27:09.5090321Z [command]/opt/hostedtoolcache/go/1.26.4/x64/bin/go env GOCACHE
Run on Ubuntu	Post Setup Go	2026-06-19T04:27:09.5116647Z /home/runner/go/pkg/mod
Run on Ubuntu	Post Setup Go	2026-06-19T04:27:09.5140129Z /home/runner/.cache/go-build
Run on Ubuntu	Post Setup Go	2026-06-19T04:27:09.5144414Z Cache hit occurred on the primary key setup-go-Linux-x64-ubuntu24-go-1.26.4-714b1ca1133e445c2c286430e84c614a7b4237b3451ee9eed5f35ac5080ab30a, not saving cache.
Run on Ubuntu	Post Clone the code	﻿2026-06-19T04:27:09.5258913Z Post job cleanup.
Run on Ubuntu	Post Clone the code	2026-06-19T04:27:09.6122687Z [command]/usr/bin/git version
Run on Ubuntu	Post Clone the code	2026-06-19T04:27:09.6160929Z git version 2.54.0
Run on Ubuntu	Post Clone the code	2026-06-19T04:27:09.6200469Z Temporarily overriding HOME='/home/runner/work/_temp/7f346b42-9a37-4259-94a4-9cae3be4a8e1' before making global git config changes
Run on Ubuntu	Post Clone the code	2026-06-19T04:27:09.6202227Z Adding repository directory to the temporary git global config as a safe directory
Run on Ubuntu	Post Clone the code	2026-06-19T04:27:09.6206812Z [command]/usr/bin/git config --global --add safe.directory /home/runner/work/paprika/paprika
Run on Ubuntu	Post Clone the code	2026-06-19T04:27:09.6234432Z Removing SSH command configuration
Run on Ubuntu	Post Clone the code	2026-06-19T04:27:09.6240929Z [command]/usr/bin/git config --local --name-only --get-regexp core\.sshCommand
Run on Ubuntu	Post Clone the code	2026-06-19T04:27:09.6271507Z [command]/usr/bin/git submodule foreach --recursive sh -c "git config --local --name-only --get-regexp 'core\.sshCommand' && git config --local --unset-all 'core.sshCommand' || :"
Run on Ubuntu	Post Clone the code	2026-06-19T04:27:09.6457610Z Removing HTTP extra header
Run on Ubuntu	Post Clone the code	2026-06-19T04:27:09.6462314Z [command]/usr/bin/git config --local --name-only --get-regexp http\.https\:\/\/github\.com\/\.extraheader
Run on Ubuntu	Post Clone the code	2026-06-19T04:27:09.6491271Z [command]/usr/bin/git submodule foreach --recursive sh -c "git config --local --name-only --get-regexp 'http\.https\:\/\/github\.com\/\.extraheader' && git config --local --unset-all 'http.https://github.com/.extraheader' || :"
Run on Ubuntu	Post Clone the code	2026-06-19T04:27:09.6662401Z Removing includeIf entries pointing to credentials config files
Run on Ubuntu	Post Clone the code	2026-06-19T04:27:09.6668936Z [command]/usr/bin/git config --local --name-only --get-regexp ^includeIf\.gitdir:
Run on Ubuntu	Post Clone the code	2026-06-19T04:27:09.6694020Z [command]/usr/bin/git submodule foreach --recursive git config --local --show-origin --name-only --get-regexp remote.origin.url
Run on Ubuntu	Complete job	﻿2026-06-19T04:27:09.7007959Z Cleaning up orphan processes
Run on Ubuntu	Complete job	2026-06-19T04:27:09.7333310Z ##[warning]Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: docker/build-push-action@v5, docker/setup-buildx-action@v3. For more information see: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/


</details>

<details><summary>Thinking</summary>

E2E run completed successfully. Need update deployment/e2e validation skill (todo). Check current skill file. Then update todo.

</details>

#### Tool Call: Read (`.kimi-code/skills/debugging-paprika-kubernetes/SKILL.md`)
<!-- call_id: tool_vPn2PCOt0eTEDYUopDc5JVTc -->
```json
{
  "path": ".kimi-code/skills/debugging-paprika-kubernetes/SKILL.md",
  "n_lines": 1000
}
```

#### Tool Call: TodoList
<!-- call_id: tool_8NUeNUmXeaxw3ssKBMPNlAeu -->
```json
{
  "todos": [
    {
      "title": "Switch e2e workflow to on-demand trigger",
      "status": "done"
    },
    {
      "title": "Push workflow change and trigger CI run",
      "status": "done"
    },
    {
      "title": "Monitor CI run and capture results",
      "status": "done"
    },
    {
      "title": "Update deployment/e2e validation skill",
      "status": "in_progress"
    }
  ]
}
```

<details><summary>Tool Result: Read (`.kimi-code/skills/debugging-paprika-kubernetes/SKILL.md`)</summary>

<!-- call_id: tool_vPn2PCOt0eTEDYUopDc5JVTc -->
1	---
2	name: debugging-paprika-kubernetes
3	description: Use when Paprika controllers or Kubernetes resources behave silently, e2e tests hang with empty status, or status updates appear to succeed but never reflect in the cluster.
4	---
5	
6	# Debugging Paprika on Kubernetes
7	
8	## Overview
9	
10	Silent controller failures are the norm in Paprika: a reconcile can return no error yet never write the status you expect. Trust state over logs.
11	
12	## When to Use
13	
14	- A controller pod is running but its CR has an empty or stale `status`
15	- `paprika apply` times out waiting for a terminal phase
16	- A Pipeline's Jobs finish but the Pipeline phase never updates
17	- Controller logs show no recent reconcile entries for a resource
18	- A resource seems "stuck" after the first reconcile (finalizer added, then nothing)
19	
20	## Core Pattern: State First, Logs Second
21	
22	1. **Read the actual object state** (`kubectl get <cr> -o yaml`) before reading logs.
23	2. **Check every status field**, not just `phase`: `observedGeneration`, `conditions`, `releaseRef`, `pipelineRef`.
24	3. **Verify the child resources** the controller should have created (Release, Stage, ConfigMap snapshot, Jobs).
25	4. **Look for reconcile loops**: stable `metadata.resourceVersion` with repeated webhook defaulting/validation logs means the controller is updating something without changing status.
26	5. **Force a reconcile** with a no-op annotation change and watch what changes.
27	
28	## Quick Reference
29	
30	| Symptom | Likely Cause | Quick Check |
31	|---|---|---|
32	| Empty phase, no errors in logs | Status patch helper produces empty diff | Inspect `patch*Status` for `MergeFrom(modified.DeepCopy())` |
33	| Controller "hangs" after first reconcile | Worker spinning on empty patch or requeue loop | Check `resourceVersion` is unchanged, webhook logs repeat |
34	| Release/Stage exists but release never promotes | Release controller blocked on status update | Patch release status manually and watch next reconcile |
35	| Pipeline Jobs done, Pipeline phase empty | Pipeline status patch helper broken | Same `MergeFrom` check |
36	| Apply server returns success but app has no `releaseRef` | Apply server status update conflicted | Check apply server logs and retry logic |
37	
38	## Common Mistakes
39	
40	- **Assuming "no error" means "status written"**. `Status().Patch` can succeed with an empty patch and change nothing.
41	- **Using `MergeFrom` on an already-mutated object**. The base must capture the object *before* status changes.
42	- **Ignoring work-queue backoff**. A single conflict error can back off reconciles for minutes; e2e timeouts follow.
43	- **Trusting the controller's cached object** after another component (apply server, webhook, another controller) updates status.
44	
45	## Example: Empty Status Patch
46	
47	Bad pattern that silently drops status updates:
48	
49	```go
50	patch := client.MergeFromWithOptions(app.DeepCopy(), client.MergeFromWithOptimisticLock{})
51	app.Status.Phase = "Healthy"
52	return r.Status().Patch(ctx, app, patch)
53	```
54	
55	Because `app.DeepCopy()` already contains `"Healthy"`, the patch diff is empty.
56	
57	Good pattern: fetch fresh, apply desired status, and update:
58	
59	```go
60	desiredStatus := app.Status.DeepCopy()
61	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
62	    var fresh paprikav1.Application
63	    if err := r.Get(ctx, key, &fresh); err != nil {
64	        return err
65	    }
66	    fresh.Status = *desiredStatus
67	    fresh.Status.ObservedGeneration = fresh.Generation
68	    return r.Status().Update(ctx, &fresh)
69	})
70	```
71	
72	## Diagnostic Moves
73	
74	1. **Manual status patch**: `kubectl patch <cr> <name> --subresource=status --type=merge -p '{"status":{"phase":"Promoting"}}'`. If the controller then proceeds, the status patch path is the bottleneck.
75	2. **Annotate to requeue**: `kubectl annotate <cr> <name> debug=paprika` forces a reconcile without changing spec.
76	3. **Check controller workers**: `kubectl logs -n paprika-system deployment/paprika-controller-manager | grep Reconciler` shows which controllers are active.
77	4. **Look for webhook loops**: repeated `Defaulting for ...` / `Validation for ... upon update` logs with unchanged `resourceVersion` indicate a controller is calling `Update` repeatedly.
78	
79	## E2E / Helm Debugging Checklist
80	
81	Use this before claiming an e2e failure is a flake or a controller bug.
82	
83	1. **Can the chart render at all?**
84	   - `helm lint ./charts/chart`
85	   - `helm template` with the same `--set` values the e2e uses
86	   - Look for missing-template errors (e.g., `no template "paprika.cacheEnv"`)
87	
88	2. **Does the chart actually create the workload the test expects?**
89	   - Check `kind: Deployment` / `kind: StatefulSet` output for the chosen `deploymentMode`
90	   - Controller-manager Deployment must exist when `manager.enabled=true` and sharding is off
91	   - `api-server` Deployment only renders when `deploymentMode=split`
92	   - Verify labels match the e2e selectors (e.g., `app.kubernetes.io/component=api-server`)
93	
94	3. **Are the right images being set on the right components?**
95	   - `manager.image.*` for monolith / operator mode
96	   - `apiServer.image.*` for split-mode API server
97	   - `webhookReceiver.image.*` / `repoServer.image.*` if those components are enabled
98	
99	4. **Do optional components honor their `enabled` flags?**
100	   - Webhook-receiver, repo-server, agent, redis should be skipped when disabled
101	
102	5. **Are required helpers defined?**
103	   - `paprika.cacheEnv`
104	   - `paprika.authArgs`
105	   - `paprika.serviceAccountName`
106	
107	6. **For webhook "connection refused" errors**
108	   - Check manager pod is ready and the webhook server is listening (`:9443`)
109	   - Check `kubectl get endpoints -n paprika-system webhook-service`
110	   - Look for manager container restarts in `kubectl describe pod`
111	   - Check cert-manager injected CA bundles in `ValidatingWebhookConfiguration` / `MutatingWebhookConfiguration`
112	   - Webhook failures during startup bootstrap can indicate the Service endpoints are not ready yet
113	
114	7. **For API-server port-forward failures**
115	   - Confirm the API-server Deployment exists and is ready
116	   - Confirm the test selector matches the chart labels
117	   - Confirm the Service targets port `3000` and the pod exposes it
118	   - Verify `mode=api` is passed and the container starts the API server
119	
120	8. **General pre-e2e validation**
121	   - `make lint` (Go + golangci-lint config)
122	   - `make test` (unit tests)
123	   - `helm lint ./charts/chart`
124	   - Then run `make test-e2e`
125	
126	## Validating Fixes in CI (E2E Tests)
127	
128	The `E2E Tests` workflow is intentionally **on-demand** (`workflow_dispatch`) to keep GitHub Actions minute usage low. Trigger it after controller/webhook/API/RBAC/Helm changes before claiming a deployment is safe.
129	
130	### Trigger a run
131	
132	```bash
133	# Full e2e suite
134	gh workflow run "E2E Tests" --repo paprikacd/paprika
135	
136	# Focused run, e.g. governance specs only
137	gh workflow run "E2E Tests" --repo paprikacd/paprika -f ginkgo_focus=Governance
138	
139	# Keep the Kind cluster alive for post-failure inspection
140	gh workflow run "E2E Tests" --repo paprikacd/paprika -f retain_cluster=true
141	```
142	
143	### What the workflow does
144	
145	1. Pre-builds the manager and demo images with Docker layer caching (`type=gha`).
146	2. Creates a fresh Kind cluster and loads the images.
147	3. Runs the Ginkgo e2e suite with a 30-minute timeout.
148	4. Tears down the Kind cluster (unless `retain_cluster=true`).
149	
150	### Interpreting results
151	
152	- **Pass**: the change is safe to deploy.
153	- **Fail in `BeforeSuite`**: usually an image-build, Kind cluster, or cert-manager issue. Inspect the manager/demo image build steps first.
154	- **Fail in a spec**: follow the [Diagnostic Moves](#diagnostic-moves) above using the downloaded job logs. Look for:
155	  - `Forbidden` project-boundary errors → AppProject/Policy mismatch.
156	  - Webhook connection refused → manager pod not ready or cert-manager CA not injected.
157	  - Application stuck in a non-terminal phase → status-patch bottleneck.
158	
159	### Cost guardrails
160	
161	- The workflow only runs when manually triggered; it does **not** run on every push or PR.
162	- Use `ginkgo_focus` to run only the specs relevant to your change when iterating.
163	- Avoid `retain_cluster=true` unless you need live debugging; the cluster continues to consume runner time until the job times out or is cancelled.
164	
165	## When NOT to Use
166	
167	- For obvious compile-time or test assertion failures (use normal debugging).
168	- When the issue is clearly in the UI/CLI client without controller involvement.
<system>168 lines read from file starting from line 1. Total lines in file: 168. End of file reached.</system>

</details>

<details><summary>Tool Result: TodoList</summary>

<!-- call_id: tool_8NUeNUmXeaxw3ssKBMPNlAeu -->
Todo list updated.
Current todo list:
  [done] Switch e2e workflow to on-demand trigger
  [done] Push workflow change and trigger CI run
  [done] Monitor CI run and capture results
  [in_progress] Update deployment/e2e validation skill

Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.

</details>

<details><summary>Thinking</summary>

Skill already updated with validating in CI. But title says debugging paprika kubernetes, not deployment/e2e validation. User said update deployment skill maybe. Check if there is a deployment skill in .kimi-code/skills. Use Glob.

</details>

#### Tool Call: Glob (`.kimi-code/skills/**/SKILL.md`)
<!-- call_id: tool_BquFDd7CxVbphzNkY0K1NBdv -->
```json
{
  "pattern": ".kimi-code/skills/**/SKILL.md",
  "include_dirs": false
}
```

<details><summary>Tool Result: Glob (`.kimi-code/skills/**/SKILL.md`)</summary>

<!-- call_id: tool_BquFDd7CxVbphzNkY0K1NBdv -->
.kimi-code/skills/debugging-paprika-kubernetes/SKILL.md

</details>

<details><summary>Thinking</summary>

Only debugging skill exists; it already contains validation section. Need maybe enhance it with latest success details? Or create new deployment skill. User said "update deployment skill with running that for validation". There is no deployment skill. We could create `.kimi-code/skills/deployment-paprika/SKILL.md` or rename? The instructions: when modifying files/styles/structures/configurations/workflows mentioned in AGENTS.md, update AGENTS.md. But skills can be added. We should create a deployment skill focused on e2e validation, referencing workflow trigger. But also maybe merge into existing? The task says update deployment/e2e validation skill. Since only debugging skill exists, perhaps create new `e2e-validation` skill. However project skill creation should follow conventions. The existing skill name `debugging-paprika-kubernetes`. We can create `.kimi-code/skills/e2e-validation/SKILL.md` with description for running on-demand E2E. But do we need? The user said "update deployment skill with running that for validation". We already updated debugging skill with "Validating Fixes in CI (E2E Tests)". Maybe that's enough. But the TODO item is "Update deployment/e2e validation skill". We can either mark done since updated, or create new. Given context, probably they expect the debugging skill updated. It already has section. But maybe we should add a note about the successful run and command. Also ensure skill mentions run ID? Not necessary. We can mark done. But before final, perhaps verify no uncommitted changes, git status. Also maybe run `make lint` and `make test`? Not needed if no code changes since last. We should update todo list to done. Then inform user CI success and skill updated, next steps.

</details>

#### Tool Call: Bash (`git status --short`)
<!-- call_id: tool_ANZ3FW4yRJJjBd6Z9tbQq2S9 -->
```json
{
  "command": "git status --short",
  "timeout": 30
}
```

<details><summary>Tool Result: Bash (`git status --short`)</summary>

<!-- call_id: tool_ANZ3FW4yRJJjBd6Z9tbQq2S9 -->
Command executed successfully.

</details>

<details><summary>Thinking</summary>

Clean. Update todo done.

</details>

#### Tool Call: TodoList
<!-- call_id: tool_sYnKzWUTsO1PN8FBEX9H4NST -->
```json
{
  "todos": [
    {
      "title": "Switch e2e workflow to on-demand trigger",
      "status": "done"
    },
    {
      "title": "Push workflow change and trigger CI run",
      "status": "done"
    },
    {
      "title": "Monitor CI run and capture results",
      "status": "done"
    },
    {
      "title": "Update deployment/e2e validation skill",
      "status": "done"
    }
  ]
}
```

<details><summary>Tool Result: TodoList</summary>

<!-- call_id: tool_sYnKzWUTsO1PN8FBEX9H4NST -->
Todo list updated.
Current todo list:
  [done] Switch e2e workflow to on-demand trigger
  [done] Push workflow change and trigger CI run
  [done] Monitor CI run and capture results
  [done] Update deployment/e2e validation skill

Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.

</details>

<details><summary>Thinking</summary>

Now respond to user with summary and next steps. Mention run success, run ID 27805040603, duration ~? We can compute from log timestamps? It started maybe around 04:15? Actually poll log started earlier. The tail shows completed at 04:27. The workflow took maybe ~20 min? We can get duration from gh run view. Use Bash.

</details>

#### Tool Call: Bash (`gh run view 27805040603 --repo paprikacd/paprika --json stat…`)
<!-- call_id: tool_9eMKBd5r2tB0Qi6qeBterUaD -->
```json
{
  "command": "gh run view 27805040603 --repo paprikacd/paprika --json status,conclusion,duration,url -q '{status,conclusion,duration,url}'",
  "timeout": 30
}
```

<details><summary>Tool Result: Bash (`gh run view 27805040603 --repo paprikacd/paprika --json stat…`)</summary>

<!-- call_id: tool_9eMKBd5r2tB0Qi6qeBterUaD -->
<system>ERROR: Tool execution failed.</system>
Unknown JSON field: "duration"
Available fields:
  attempt
  conclusion
  createdAt
  databaseId
  displayTitle
  event
  headBranch
  headSha
  jobs
  name
  number
  startedAt
  status
  updatedAt
  url
  workflowDatabaseId
  workflowName
Command failed with exit code: 1.

</details>

<details><summary>Thinking</summary>

Use createdAt/updatedAt.

</details>

#### Tool Call: Bash (`gh run view 27805040603 --repo paprikacd/paprika --json stat…`)
<!-- call_id: tool_TVwpEWVtfTv5WSSIXB7dl9NM -->
```json
{
  "command": "gh run view 27805040603 --repo paprikacd/paprika --json status,conclusion,createdAt,updatedAt,url",
  "timeout": 30
}
```

<details><summary>Tool Result: Bash (`gh run view 27805040603 --repo paprikacd/paprika --json stat…`)</summary>

<!-- call_id: tool_TVwpEWVtfTv5WSSIXB7dl9NM -->
{"conclusion":"success","createdAt":"2026-06-19T04:16:19Z","status":"completed","updatedAt":"2026-06-19T04:27:13Z","url":"https://github.com/paprikacd/paprika/actions/runs/27805040603"}


</details>

<details><summary>Thinking</summary>

Duration ~10m 54s. Good. Provide concise summary. Ask about next steps.

</details>

The third CI run finished successfully.

**Result:** `success`  
**Run:** [#27805040603](https://github.com/paprikacd/paprika/actions/runs/27805040603)  
**Duration:** ~11 minutes (04:16–04:27 UTC)  
**Focus:** `Governance` specs

That confirms:
- The on-demand `E2E Tests` workflow builds and caches the manager + demo images correctly.
- The pre-loaded images run in Kind without the suite doing redundant builds.
- The webhook readiness probe fix resolves the `connection refused` flake we hit in the first two runs.
- Project-scoped governance e2e specs pass in CI.

All todo items are done. What would you like to tackle next? Options that come to mind:
1. Run the full unfocused e2e suite once to make sure nothing else regressed.
2. Add branch protection / required status checks so the on-demand workflow can be triggered from PRs without auto-running.
3. Look at the local Docker Desktop e2e hang so devs can iterate locally again.
4. Move on to the next feature.

## Turn 2

### User

4

### Assistant

<details><summary>Thinking</summary>

User wants move on to next feature. Need ask what next feature. Also perhaps there is context from previous conversation about next steps? The compacted context lost. We should ask user to specify the next feature they want to work on. Could also check project board, issues, or TODOs. Maybe user has a direction. We can ask.

</details>

Got it. What feature do you want to work on next? If you have an issue, branch name, or rough idea, point me at it and I’ll start exploring.

## Turn 3

### User

look through our backlog and pick up next big chunks

### Assistant

<details><summary>Thinking</summary>

User wants look through backlog and pick up next big chunks. We need inspect project backlog. Could be GitHub issues, project board, TODOs, maybe AGENTS/roadmap. Need find backlog. Use `gh` to list issues, maybe with labels. Also check repo for ROADMAP/TODO/CHANGELOG. Let's explore. Use gh issue list, search for labels like "enhancement", "epic", "backlog". Also check docs/roadmap. Since repo is paprikacd/paprika. Use Bash gh commands.

</details>

#### Tool Call: Bash (`gh issue list --repo paprikacd/paprika --limit 50 --state al…`)
<!-- call_id: tool_yPI1otCmFNYszOBsLrYw8jO7 -->
```json
{
  "command": "gh issue list --repo paprikacd/paprika --limit 50 --state all --json number,title,labels,state,assignees,milestone | jq -r '.[] | \"\\(.number) [\\(.state)] \\(.title) | labels: \\(.labels | map(.name) | join(\",\")) | assignees: \\(.assignees | map(.login) | join(\",\"))\"' | head -60",
  "timeout": 60
}
```

#### Tool Call: Bash (`ls docs/ && find . -maxdepth 2 -iname '*roadmap*' -o -iname …`)
<!-- call_id: tool_OmnohyCzu1eJ1NyYJ6J2I31H -->
```json
{
  "command": "ls docs/ && find . -maxdepth 2 -iname '*roadmap*' -o -iname '*todo*' -o -iname '*backlog*' -o -iname '*milestone*' | head -30",
  "timeout": 30
}
```

<details><summary>Tool Result: Bash (`gh issue list --repo paprikacd/paprika --limit 50 --state al…`)</summary>

<!-- call_id: tool_yPI1otCmFNYszOBsLrYw8jO7 -->
Command executed successfully.

</details>

<details><summary>Tool Result: Bash (`ls docs/ && find . -maxdepth 2 -iname '*roadmap*' -o -iname …`)</summary>

<!-- call_id: tool_OmnohyCzu1eJ1NyYJ6J2I31H -->
api.md
cli.md
features.md
frontend.md
getting-started.md
guides
superpowers
./GOLANG_BEST_PRACTICES_BACKLOG.md
./TODO.md
./PRODUCTION_ROADMAP.md


</details>

<details><summary>Thinking</summary>

Issue list returned empty (maybe no output due to no issues or jq). We have TODO.md, GOLANG_BEST_PRACTICES_BACKLOG.md, PRODUCTION_ROADMAP.md. Read all three.

</details>

#### Tool Call: Read (`TODO.md`)
<!-- call_id: tool_7Q4NHnR5EgrUgWoybnOkGAx6 -->
```json
{
  "path": "TODO.md",
  "n_lines": 1000
}
```

#### Tool Call: Read (`PRODUCTION_ROADMAP.md`)
<!-- call_id: tool_8QZSyfw4SjZQJre4TAjyJ2Pd -->
```json
{
  "path": "PRODUCTION_ROADMAP.md",
  "n_lines": 1000
}
```

#### Tool Call: Read (`GOLANG_BEST_PRACTICES_BACKLOG.md`)
<!-- call_id: tool_JBGzMqD6fnmuBMgcUN71Mk5e -->
```json
{
  "path": "GOLANG_BEST_PRACTICES_BACKLOG.md",
  "n_lines": 1000
}
```

<details><summary>Tool Result: Read (`TODO.md`)</summary>

<!-- call_id: tool_7Q4NHnR5EgrUgWoybnOkGAx6 -->
1	# Paprika Feature TODO
2	
3	This file tracks implemented capabilities and planned features. It consolidates the [unified platform roadmap](docs/superpowers/plans/2026-06-09-unified-platform-roadmap.md), [production roadmap](PRODUCTION_ROADMAP.md), and pending P2 work.
4	
5	## Implemented
6	
7	- [x] Pipeline CRD (DAG workflow execution)
8	- [x] Template CRD (Helm rendering)
9	- [x] Stage CRD (canary / blue-green progression)
10	- [x] Release CRD (promotion to stages)
11	- [x] Application CRD (unified resource owning Pipeline/Template/Stage/Release)
12	- [x] Multi-source rendering (git, S3, Helm, OCI)
13	- [x] CEL health checks with HTTP probes
14	- [x] Resource diff detection (`Application` status resources / outOfSync)
15	- [x] Resource pruning
16	- [x] Resource health tracking
17	- [x] Prometheus metrics
18	- [x] API / UI dashboard
19	- [x] Event-driven sync (`paprika.io/sync`, `paprika.io/refresh`)
20	- [x] Advanced rollout strategies (A/B testing, blue-green, canary, mirroring, header-based routing)
21	- [x] Analysis Templates and AnalysisRuns
22	- [x] Notifications (Slack, email, webhook, delivery status)
23	- [x] OCI source support
24	- [x] Sync windows (cron-based)
25	- [x] Self-healing (auto-sync on drift, auto-revert on health failure)
26	- [x] Feature flags (`FeatureFlag` / `FeatureFlagBinding` CRDs + OpenFeature bridge)
27	
28	## P2 — Planned Next
29	
30	These are the next user-facing features queued after the current MVP.
31	
32	- [ ] **Approval Gates** — manual/webhook/Slack gates between stages; pause promotion until approved
33	  - Priority: high
34	  - Status: no detailed plan yet
35	  - Owner: TBD
36	
37	- [ ] **Conftest Gates** — Open Policy Agent / Conftest policy checks in the promotion pipeline
38	  - Priority: medium
39	  - Status: no detailed plan yet
40	  - Owner: TBD
41	
42	- [ ] **Project-Scoped Policy Governance** — enforce `AppProject` boundaries and `Policy` rules in webhooks, controllers, and API; scope authorization by project
43	  - Priority: high
44	  - Plan: [docs/superpowers/plans/2026-06-13-project-scoped-policy-governance.md](docs/superpowers/plans/2026-06-13-project-scoped-policy-governance.md)
45	  - Spec: [docs/superpowers/specs/2026-06-13-project-scoped-policy-governance-design.md](docs/superpowers/specs/2026-06-13-project-scoped-policy-governance-design.md)
46	  - Owner: TBD
47	
48	- [ ] **`paprika apply -f` CLI** — render manifests locally and submit via `ApplyBundle`; `Policy` CRD; Bubble Tea TUI
49	  - Priority: high
50	  - Plan: [docs/superpowers/plans/2026-06-13-paprika-apply.md](docs/superpowers/plans/2026-06-13-paprika-apply.md)
51	  - Spec: [docs/superpowers/specs/2026-06-13-paprika-apply-design.md](docs/superpowers/specs/2026-06-13-paprika-apply-design.md)
52	  - Owner: TBD
53	
54	## Mid-Term
55	
56	- [ ] **Multi-Cluster Deployment** — deploy to target clusters via `Stage.clusterRef`
57	- [ ] **App-of-Apps / ApplicationSet** — parent Application or ApplicationSet managing child Applications
58	- [ ] **HA / Sharded Repo Server** — horizontally scalable source/render service
59	
60	## Production Hardening (P0/P1)
61	
62	See [PRODUCTION_ROADMAP.md](PRODUCTION_ROADMAP.md) for full details.
63	
64	- [ ] Informer-based diff engine (avoid `ServerPreferredResources()` on every reconcile)
65	- [ ] Source cache with Redis + webhook receiver + background poller
66	- [ ] Helm SDK in-process rendering (replace `helm template` subprocess)
67	- [ ] Split monolithic controller (`controller-manager`, `api-server`, `repo-server`, `webhook-receiver`)
68	- [ ] Status-subresource-only updates
69	- [ ] Multi-cluster connection pooling
70	- [ ] Redis-backed API / manifest cache
71	- [ ] Per-Application and per-source rate limiting
72	- [ ] Security model hardening
73	
74	## How to Pick Up Work
75	
76	1. Choose a feature from **P2 — Planned Next**.
77	2. If a plan exists, follow it and use `superpowers:subagent-driven-development`.
78	3. If no plan exists, write one first using `superpowers:writing-plans`.
79	4. Create a feature branch / worktree, implement, and run `make test` + `make lint` before merging.
<system>79 lines read from file starting from line 1. Total lines in file: 79. End of file reached.</system>

</details>

<details><summary>Tool Result: Read (`PRODUCTION_ROADMAP.md`)</summary>

<!-- call_id: tool_8QZSyfw4SjZQJre4TAjyJ2Pd -->
1	# Paprika Production Readiness Roadmap
2	
3	## Current State: MVP → ArgoCD-Scale Production
4	
5	The codebase has solid foundations but is currently architected for small-scale, single-cluster deployments. To operate at ArgoCD scale (10,000+ applications, 100+ clusters, millions of resources), fundamental architectural changes are required.
6	
7	## Critical Scaling Bottlenecks (P0)
8	
9	### 1. O(n) Diff Engine — Highest Priority
10	**Current:** `engine/diff.go` calls `ServerPreferredResources()` and lists **every namespaced resource** on every Application reconcile.
11	
12	**Impact:** With 10,000 applications reconciling every 5s, you list the entire cluster repeatedly. This will DDoS the Kubernetes API server.
13	
14	**Required Fix:**
15	- Index desired resources by owner reference (Application)
16	- Track live resources via label selector (`app.paprika.io/name=<app>`)
17	- Use an informer-based cache instead of List calls
18	- Only diff resources the Application actually owns
19	
20	### 2. No Source Cache / Webhook Support
21	**Current:** Git source re-clones on every template render. S3 re-downloads on every render. No commit cache, no webhook listener.
22	
23	**Impact:** Every Application reconcile triggers git clone/fetch or S3 HEAD. At scale this saturates bandwidth and source APIs.
24	
25	**Required Fix:**
26	- Central `SourceCache` service with Redis backend
27	- Webhook receiver for GitHub/GitLab/Bitbucket push events
28	- Background poller with exponential backoff and ETag support
29	- Cache rendered manifests keyed by commit hash
30	
31	### 3. Shelling Out to Helm Binary
32	**Current:** `engine/template.go` executes `helm template`, `helm repo add`, `helm repo update` via `exec.CommandContext`.
33	
34	**Impact:** Cannot scale — subprocess creation is slow, no chart caching at process level, concurrent helm runs corrupt repo cache.
35	
36	**Required Fix:**
37	- Use Helm SDK (`helm.sh/helm/v3/pkg/action`) in-process
38	- Chart museum/cache with persistent volume or object storage
39	- Repository index caching with TTL
40	- Lock chart downloads to prevent race conditions
41	
42	### 4. Single Monolithic Controller
43	**Current:** One Deployment with `replicas: 1`, all controllers in one process. API server embedded in operator.
44	
45	**Impact:** Cannot scale horizontally. Leader election only allows one active replica. API and controller compete for resources.
46	
47	**Required Fix:**
48	- Split into separate deployments: `controller-manager`, `api-server`, `repo-server`, `webhook-receiver`
49	- Implement controller sharding by namespace hash or application ID
50	- Redis-backed work queue for cross-replica coordination
51	- HorizontalPodAutoscaler for each component
52	
53	### 5. Status Subresource Anti-Patterns
54	**Current:** Controllers update entire objects (not just status), causing unnecessary etcd writes and revision churn.
55	
56	**Impact:** etcd write amplification, watch storm cascades, conflicts between controllers.
57	
58	**Required Fix:**
59	- Use `client.MergeFrom` + `r.Status().Update()` exclusively for status changes
60	- Add `ObservedGeneration` to all status types
61	- Separate spec and status update paths
62	
63	## High-Priority Production Gaps (P1)
64	
65	### 6. No Multi-Cluster Connection Pooling
66	**Current:** `ClusterClientManager` creates new dynamic client per reconcile from kubeconfig secret.
67	
68	**Impact:** Constant TLS handshakes, no connection reuse, slow reconciliation across many clusters.
69	
70	**Required Fix:**
71	- Cluster registry CRD with connection pool management
72	- Cache clients by kubeconfig secret hash
73	- Connection health checks and circuit breakers
74	- Separate cluster-agent DaemonSet for remote clusters
75	
76	### 7. Missing Caching Layer
77	**Current:** Every API call hits Kubernetes API server directly. No Redis, no local cache.
78	
79	**Impact:** API server becomes bottleneck, UI is slow, controllers redundant work.
80	
81	**Required Fix:**
82	- Redis deployment for:
83	  - Source state cache
84	  - Rendered manifest cache
85	  - Cluster resource cache snapshot
86	  - Event bus for inter-controller communication
87	  - Rate limiting counters
88	
89	### 8. No Rate Limiting or Backoff
90	**Current:** Fixed `MaxConcurrentReconciles`, no per-resource rate limiting, no global throttling.
91	
92	**Impact:** Thundering herd on source APIs, retry loops spike API server.
93	
94	**Required Fix:**
95	- Per-Application rate limiter (token bucket)
96	- Per-source rate limiter (git host, S3 bucket)
97	- Global controller rate limiter
98	- Exponential backoff with jitter for failures
99	
100	### 9. Security Model Gaps
101	**Current:**
102	- No authentication/authorization in API server
103	- Operator has broad cluster-admin RBAC
104	- S3 hardcodes test credentials
105	- No audit logging
106	- TLS config uses `InsecureSkipVerify` in analysis
107	
108	**Required Fix:**
109	- OIDC/JWT auth for API server
110	- RBAC policy engine (Casbin or OPA)
111	- Project-scoped permissions
112	- Audit logging to stdout/file
113	- Secret rotation for kubeconfig and git credentials
114	- mTLS for inter-service communication
115	
116	### 10. No Observability Beyond Metrics
117	**Current:** Prometheus metrics exist but no tracing, no structured events, no SLO dashboards.
118	
119	**Required Fix:**
120	- OpenTelemetry tracing across controllers and API
121	- Kubernetes Events for every significant state change
122	- Structured logging with correlation IDs
123	- Pre-built Grafana dashboards
124	- AlertManager rules for failed syncs, unhealthy apps, queue depth
125	
126	## Medium-Priority Gaps (P2)
127	
128	### 11. No Resource Management
129	**Current:** `manager.yaml` has `limits.cpu: 500m`, `limits.memory: 128Mi` — insufficient for any real workload.
130	
131	**Required Fix:**
132	- Right-size based on load testing
133	- Add VerticalPodAutoscaler recommendations
134	- Separate resource profiles for controller vs API server
135	- PodDisruptionBudgets for HA
136	
137	### 12. No Disaster Recovery
138	**Current:** All state lives in etcd via CRDs. No backup/restore strategy.
139	
140	**Required Fix:**
141	- Backup CRDs to object storage (Velero integration)
142	- GitOps backup of Application specs
143	- Multi-region deployment guide
144	
145	### 13. UI is Static HTML Only
146	**Current:** `uistatic/index.html` is a 15-byte placeholder.
147	
148	**Required Fix:**
149	- Full React/Vue SPA with real-time updates via WebSocket/SSE
150	- Application topology visualization
151	- Diff viewer for manifest changes
152	- Audit log viewer
153	
154	### 14. No Multi-Tenancy
155	**Current:** Any authenticated user can see/modify all Applications.
156	
157	**Required Fix:**
158	- Project/namespace isolation
159	- Resource quotas per project
160	- SSO integration
161	
162	## Recommended Implementation Order
163	
164	### Phase 1: Core Scaling (Weeks 1-3)
165	1. ✅ **Fix diff engine** — label-selector based, stop scanning all resources
166	2. ✅ **Add Redis** — source cache + rendered manifest cache
167	3. **Helm SDK migration** — replace shell execs
168	4. **Connection pooling** — for multi-cluster clients
169	
170	### Phase 2: Architecture Split (Weeks 4-6)
171	5. **Split operator and API server** into separate deployments
172	6. **Add controller sharding** by namespace hash
173	7. **Webhook receiver** for Git push events
174	8. **Rate limiting and backoff**
175	
176	### Phase 3: Production Hardening (Weeks 7-10)
177	9. **Authn/authz** for API server
178	10. **Audit logging and tracing**
179	11. **Security hardening** — RBAC scopes, secret rotation
180	12. **Resource tuning** — VPA, HPA, PDBs
181	13. **Real UI**
182	
183	### Phase 4: Enterprise Features (Weeks 11-14)
184	14. **Multi-tenancy**
185	15. **Backup/restore**
186	16. **Advanced sync policies** — prune, replace, sync windows
187	17. **Notifications** — Slack, email, webhook
188	
189	## Immediate Next Steps
190	
191	The highest-impact, lowest-risk wins are:
192	
193	1. **Fix the diff engine** — pure code change, huge scaling impact
194	2. **Add a Redis-backed manifest cache** — architectural but contained
195	3. **Implement controller/API split** — structural but uses existing code
196	4. **Add source webhook support** — prevents polling overhead
197	
198	Which would you like to tackle first?
<system>198 lines read from file starting from line 1. Total lines in file: 198. End of file reached.</system>

</details>

<details><summary>Tool Result: Read (`GOLANG_BEST_PRACTICES_BACKLOG.md`)</summary>

<!-- call_id: tool_JBGzMqD6fnmuBMgcUN71Mk5e -->
1	# Go Best-Practices Alignment Backlog
2	
3	**Repo:** `github.com/benebsworth/paprika`  
4	**Skill:** `../skunkworq-skills/go-best-practices` (Go Best Practices)  
5	**Date:** 2026-06-17  
6	**Audited by:** Kimi Code CLI (deep static review + targeted spot checks)
7	
8	---
9	
10	## Executive Summary
11	
12	The Paprika codebase is already in reasonable shape for a Kubebuilder project: it uses Go 1.26, organizes code under `internal/` by domain, has no `util`/`common` grab-bag packages, uses `go.uber.org/mock`, and `golangci-lint run ./...` is currently green. However, aligning it with the `go-best-practices` skill reveals a meaningful backlog concentrated in four areas:
13	
14	1. **Concurrency safety** – real data races, goroutine leaks, and a potential deadlock in the workflow engine.
15	2. **Dependency injection & architecture** – producer-side interfaces, constructors returning interfaces, package-level mutable state, and struct embedding that leaks APIs.
16	3. **CI / toolchain hygiene** – the release workflow pins Go 1.24 (older than `go.mod`), there is no race-detector gate, and `go.mod` lacks a `toolchain` directive.
17	4. **Error handling & testing** – bare `return err` at high-level orchestration, error-string style violations, and tests that leak resources or rely on real time.
18	
19	This backlog is intentionally actionable: each item includes severity, effort, affected files, problem statement, suggested fix, and acceptance criteria. It is ordered by risk, not by file.
20	
21	---
22	
23	## How This Audit Was Conducted
24	
25	1. Read the full skill (`SKILL.md`) and its three reference files:
26	   - `references/interfaces-and-architecture.md`
27	   - `references/testing-and-concurrency.md`
28	   - `references/gomock-mocking.md`
29	2. Inspected `go.mod`, `.golangci.yml`, `.custom-gcl.yml`, `Makefile`, and all GitHub Actions workflows.
30	3. Ran `golangci-lint run ./...` (green, 0 issues) and `go vet ./...` (clean).
31	4. Used read-only subagents to audit:
32	   - Toolchain / CI / project layout
33	   - Code anti-patterns (error wrapping, `_ =` discards, globals, deprecated APIs)
34	   - Interfaces, package boundaries, dependency injection, and mock placement
35	   - Testing structure, concurrency patterns, and race/leak risks
36	5. Spot-checked every P0 and most P1 findings against the source files.
37	
38	> **Note:** `golangci-lint` is green because several relevant checks are disabled or excluded (e.g., `wrapcheck` in controllers, `staticcheck` in rollout controllers, `gocritic.ifElseChain`). Re-enabling those linters after the fixes below is part of the recommended follow-up.
39	
40	---
41	
42	## Compliance Snapshot
43	
44	| Skill requirement | Status | Gap |
45	|---|---|---|
46	| `go 1.26.0` in `go.mod` | ✅ | Missing `toolchain go1.26.4` |
47	| Go 1.24+ `tool` directive for dev tools | ❌ | `mockgen` not tracked as a `tool` |
48	| `golangci-lint` v2.12+ | ❌ | Using v2.11.4 |
49	| `modules-download-mode: readonly` | ❌ | Not configured |
50	| `errcheck.check-blank: true` | ❌ | Not configured |
51	| `make test-race` / `-race` in CI | ❌ | `make test` omits `-race` |
52	| `GOTOOLCHAIN=auto` in CI | ❌ | Not exported |
53	| Testable `run(ctx, args, getenv, stdin, stdout, stderr)` entrypoint | ❌ | `cmd/main.go` uses global `flag.CommandLine` and `os.Exit` directly |
54	| Consumer-defined interfaces | ❌ | Most interfaces live next to implementations |
55	| `mockgen -typed` / `_test.go` mocks | ❌ | Mocks live in `mocks/` packages without `-typed` |
56	| Table-driven tests + `t.Parallel()` | ⚠️ | Some packages still use copy-paste tests and skip `t.Parallel()` |
57	| No goroutine without a stop path | ❌ | Several leaked goroutines in `cmd/main.go` and `cluster_pool.go` |
58	
59	---
60	
61	## Risk Heat Map
62	
63	| Epic | P0 | P1 | P2 | Primary risk |
64	|---|---:|---:|---:|---|
65	| CI / Toolchain | 1 | 5 | 3 | Broken release builds, drift between local and CI |
66	| Concurrency & Safety | 5 | 4 | 2 | Data races, goroutine leaks, deadlock, runtime panics |
67	| Error Handling & Observability | 0 | 6 | 3 | Silent failures, poor operator debugging, lint debt |
68	| Interfaces, Architecture & DI | 0 | 7 | 5 | Brittle abstractions, tight coupling, test pain |
69	| Testing & Mock Hygiene | 0 | 5 | 6 | Flaky/slow tests, false confidence, resource leaks |
70	
71	---
72	
73	## Recommended Sequencing
74	
75	1. **Sprint 0 — Stop the bleeding (P0 only)**
76	   - Fix the release workflow Go version.
77	   - Add `toolchain go1.26.4` and `GOTOOLCHAIN=auto`.
78	   - Fix `cluster_pool.go` data race and goroutine leak.
79	   - Fix `engine/workflow.go` deadlock.
80	   - Initialize `NotificationConfigReconciler.rateLimits` in a constructor.
81	
82	2. **Sprint 1 — Concurrency & entrypoints**
83	   - Shut down leaked HTTP servers in `cmd/main.go`.
84	   - Give `NewClusterConnectionPool` a stop path.
85	   - Refactor `cmd/main.go`, `cmd/paprika/main.go`, and `cmd/paprika-cli/main.go` to testable `run(...)` entrypoints.
86	   - Add `make test-race` and run it in CI.
87	
88	3. **Sprint 2 — Error handling & lint config**
89	   - Bump `golangci-lint` to v2.12.2, add `modules-download-mode: readonly`, `errcheck.check-blank`.
90	   - Wrap high-level bare `return err` paths.
91	   - Fix error-string capitalization and `%w` ordering.
92	   - Clean up `_ =` error discards in production code.
93	
94	4. **Sprint 3 — Architecture & DI**
95	   - Move consumer-defined interfaces out of producer packages.
96	   - Change constructors to return concrete structs.
97	   - Split kitchen-sink interfaces.
98	   - Replace package globals (`timeNow`, observability globals) with injected dependencies.
99	
100	5. **Sprint 4 — Testing & mocks**
101	   - Regenerate mocks with `-typed` and move test-only mocks into `*_test.go`.
102	   - Convert copy-paste tests to table-driven tests.
103	   - Add `t.Parallel()` where safe.
104	   - Inject clocks in `ratelimit`, `cache`, and `metrics`.
105	
106	---
107	
108	## Detailed Backlog
109	
110	### Epic 1 — CI / Toolchain
111	
112	#### GBP-001 Release workflow uses Go 1.24 while `go.mod` requires 1.26
113	- **Severity:** P0
114	- **Effort:** S
115	- **Files:** `.github/workflows/release.yml:25`
116	- **Problem:** The release job pins `go-version: "1.24"`, which is older than `go 1.26.0` in `go.mod`. This will fail releases once the toolchain check triggers.
117	- **Fix:** Use `go-version-file: go.mod` (consistent with `test.yml` and `lint.yml`).
118	- **Acceptance:** Release workflow uses the same Go minor as `go.mod`.
119	
120	#### GBP-002 Missing `toolchain` directive in `go.mod`
121	- **Severity:** P1
122	- **Effort:** S
123	- **Files:** `go.mod:3`
124	- **Problem:** Only `go 1.26.0` is declared; the skill recommends an explicit `toolchain go1.26.4`.
125	- **Fix:** Add `toolchain go1.26.4` after the `go` directive.
126	- **Acceptance:** `go env GOTOOLCHAIN` resolves to `go1.26.4` on a clean clone.
127	
128	#### GBP-003 Dev tools not tracked via the Go `tool` directive
129	- **Severity:** P1
130	- **Effort:** S
131	- **Files:** `go.mod`
132	- **Problem:** `go.uber.org/mock` is a runtime dependency solely because `mockgen` is needed at generation time. There is no `tools.go` or `tool` directive.
133	- **Fix:** Run `go get -tool go.uber.org/mock/mockgen@v0.6.0` (or latest) and document `go tool mockgen` usage.
134	- **Acceptance:** `go tool mockgen` works without a global install; `go.mod` contains a `tool` line.
135	
136	#### GBP-004 `golangci-lint` version below skill floor
137	- **Severity:** P1
138	- **Effort:** S
139	- **Files:** `Makefile:247`, `.custom-gcl.yml:6`
140	- **Problem:** Both pin `v2.11.4`; the skill floor is `v2.12`.
141	- **Fix:** Bump `GOLANGCI_LINT_VERSION` and `.custom-gcl.yml` to `v2.12.2` (or newer).
142	- **Acceptance:** `make lint` runs v2.12+ and remains green.
143	
144	#### GBP-005 `.golangci.yml` missing recommended `run` and `errcheck` settings
145	- **Severity:** P1
146	- **Effort:** S
147	- **Files:** `.golangci.yml`
148	- **Problem:** Missing `run.modules-download-mode: readonly` and `linters-settings.errcheck.check-blank: true`.
149	- **Fix:** Add both settings.
150	- **Acceptance:** `golangci-lint config verify` passes and `_ = fn()` patterns in non-test code are flagged.
151	
152	#### GBP-006 Race detector is not the default CI invocation
153	- **Severity:** P1
154	- **Effort:** M
155	- **Files:** `Makefile:73-75`, `.github/workflows/test.yml:27-29`
156	- **Problem:** `make test` runs `go test` without `-race`. The skill expects `go test -race ./...` as the default CI command.
157	- **Fix:** Add a `test-race` target and switch CI to use it (or add `GOFLAGS=-race` to the existing target). Keep envtest filtering logic.
158	- **Acceptance:** CI runs every unit test with the race detector and fails on data races.
159	
160	#### GBP-007 CI does not export `GOTOOLCHAIN=auto`
161	- **Severity:** P1
162	- **Effort:** S
163	- **Files:** `.github/workflows/test.yml`, `.github/workflows/lint.yml`, `.github/workflows/release.yml`, `.github/workflows/test-e2e.yml`
164	- **Problem:** Official `golang` Docker images bake in `GOTOOLCHAIN=local`. If `go.mod` is bumped ahead of the CI image pin, builds fail cryptically.
165	- **Fix:** Export `GOTOOLCHAIN=auto` in all Go-related steps.
166	- **Acceptance:** A toolchain bump ahead of the image pin still succeeds (with a one-time download).
167	
168	#### GBP-008 No CI gate for `gofmt -l .`
169	- **Severity:** P2
170	- **Effort:** S
171	- **Files:** `.github/workflows/lint.yml`
172	- **Problem:** `make fmt` exists but CI does not fail on unformatted code.
173	- **Fix:** Add a step that fails if `gofmt -l .` produces output.
174	- **Acceptance:** CI fails on unformatted Go files.
175	
176	#### GBP-009 No pre-commit hook for lint / format
177	- **Severity:** P2
178	- **Effort:** S
179	- **Files:** repo root
180	- **Problem:** The skill recommends a `.githooks/pre-commit` hook running `golangci-lint` on staged `.go` files.
181	- **Fix:** Add `.githooks/pre-commit` and document `git config core.hooksPath .githooks` in `CONTRIBUTING.md`.
182	- **Acceptance:** A commit with lint errors is blocked locally.
183	
184	#### GBP-010 Missing `.editorconfig`
185	- **Severity:** P2
186	- **Effort:** XS
187	- **Files:** repo root
188	- **Problem:** No editor-agnostic formatting defaults.
189	- **Fix:** Add a root `.editorconfig` (tab-width 4 for Go, 2-space YAML, trim trailing whitespace).
190	- **Acceptance:** File exists and is respected by editors.
191	
192	---
193	
194	### Epic 2 — Concurrency & Safety
195	
196	#### GBP-011 `ClusterConnectionPool.isValid` mutates state under `RLock`
197	- **Severity:** P0
198	- **Effort:** M
199	- **Files:** `internal/controller/pipelines/cluster_pool.go:211-227`, callers at `:79`, `:104`, `:121`
200	- **Problem:** `isValid` resets `pc.circuitOpen` and `pc.failures` while callers hold only an `RLock`. This is a data race.
201	- **Fix:** Make `isValid` read-only. Move circuit-breaker reset into the write path (`createAndCacheClient`, `getDefaultClient`, or `runHealthChecks`) under a full `Lock`.
202	- **Acceptance:** `go test -race ./internal/controller/pipelines/...` reports no race from `cluster_pool.go`.
203	
204	#### GBP-012 `ClusterConnectionPool` goroutine has no stop path
205	- **Severity:** P0
206	- **Effort:** M
207	- **Files:** `internal/controller/pipelines/cluster_pool.go:52-61`, `:229-237`
208	- **Problem:** `NewClusterConnectionPool` starts `healthCheckLoop` in a goroutine that loops forever. The goroutine leaks in every test that creates a pool and cannot be shut down on manager stop.
209	- **Fix:** Accept a `context.Context` and stop the ticker on `ctx.Done()`, or register the pool as a `manager.Runnable` whose `Start` receives a context.
210	- **Acceptance:** Pool shutdown cancels the health-check loop; leak detector / race tests pass.
211	
212	#### GBP-013 `ClusterConnectionPool.runHealthChecks` holds the write lock during I/O
213	- **Severity:** P1
214	- **Effort:** M
215	- **Files:** `internal/controller/pipelines/cluster_pool.go:239-279`
216	- **Problem:** The exclusive lock is held while calling `dynamic.NewForConfig` and `List`, blocking all `GetClient`/`GetRestConfig` callers for the duration of every health probe.
217	- **Fix:** Snapshot the clients under `RLock`, perform probes outside the lock, then acquire the write lock only to update `healthy`/`failures`/`circuitOpen`.
218	- **Acceptance:** Health checks no longer block client lookups.
219	
220	#### GBP-014 Workflow `executeSubBatch` can deadlock on a full `errCh`
221	- **Severity:** P0
222	- **Effort:** M
223	- **Files:** `engine/workflow.go:188-208`, `:210-253`, `:255-269`
224	- **Problem:** `errCh` is buffered to `len(batch)`, but each step goroutine can send multiple errors (create failure, retries, final failure). Because `wg.Wait()` runs before draining, goroutines can block on a full channel forever.
225	- **Fix:** Replace the hand-rolled `WaitGroup` + channel with `golang.org/x/sync/errgroup.WithContext(ctx)`, or drain errors concurrently and make sends `select { case errCh <- err: case <-ctx.Done(): }`.
226	- **Acceptance:** A step that fails and retries does not deadlock; `go test -race ./engine/...` passes.
227	
228	#### GBP-015 `NotificationConfigReconciler` map field is not initialized in the constructor
229	- **Severity:** P0
230	- **Effort:** S
231	- **Files:** `internal/controller/pipelines/notification_controller.go:47-54`, `:209-229`
232	- **Problem:** `rateLimits map[rateLimitKey]time.Time` is only initialized inside `Start`. If the reconciler is ever constructed and used without calling `Start`, `rateLimitAllowed` panics on a nil-map write. Tests currently paper over this by initializing manually.
233	- **Fix:** Add a constructor `NewNotificationConfigReconciler(...)` that initializes `rateLimits`, `Sender`, and `Emailer`, and use it from `cmd/main.go`.
234	- **Acceptance:** No nil-map panic if `rateLimitAllowed` is called before `Start`; all tests use the constructor.
235	
236	#### GBP-016 Inline HTTP servers in `cmd/main.go` leak goroutines and ports
237	- **Severity:** P1
238	- **Effort:** M
239	- **Files:** `cmd/main.go:369-385` (`startInlineWebhook`), `:713-745` (`startOperatorUI`), `:914-926` (`startHealthProbeServer`)
240	- **Problem:** Servers are started in goroutines with no shutdown path; they outlive the manager context.
241	- **Fix:** Return `*http.Server` from each helper and shut it down on context cancellation (e.g., via `mgr.Add(&serverRunnable{srv})` or a `defer` in `dispatchMode`).
242	- **Acceptance:** Manager shutdown closes all three servers cleanly.
243	
244	#### GBP-017 `events.Broker` goroutine and lock issues
245	- **Severity:** P1
246	- **Effort:** M
247	- **Files:** `internal/api/events/broker.go:43` (`receiveLoop`), `:79-91` (`Subscribe`), `:118-130` (`publishLocal`)
248	- **Problem:**
249	  - `NewRedisBroker` starts `receiveLoop` with no stop path.
250	  - `Subscribe` holds `mu.Lock` while calling `pubsub.Subscribe` (Redis network I/O).
251	  - `publishLocal` silently drops events when a subscriber channel is full.
252	- **Fix:**
253	  - Accept a context and stop `receiveLoop` on `ctx.Done()`.
254	  - Subscribe to Redis outside the lock, then update the in-memory map under the lock.
255	  - Document the drop policy or use a brief blocking send with `ctx.Done()`.
256	- **Acceptance:** Broker shuts down cleanly; `Subscribe` does not serialize publishers behind a lock.
257	
258	#### GBP-018 `retryStep` / `watchJob` lack cancellation and use a hard-coded 24h timeout
259	- **Severity:** P1
260	- **Effort:** M
261	- **Files:** `engine/workflow.go:255-269`, `:276-302`
262	- **Problem:** `retryStep` does not accept a `context.Context`; `watchJob` uses `time.After(24 * time.Hour)` instead of deriving the deadline from the caller's context or the Job's `ActiveDeadlineSeconds`.
263	- **Fix:** Thread `ctx` through `retryStep`; replace `time.After(24 * time.Hour)` with a context deadline or the job's own deadline.
264	- **Acceptance:** Pipeline reconciliation cancels promptly when its context is cancelled.
265	
266	#### GBP-019 Workflow job names can collide
267	- **Severity:** P2
268	- **Effort:** S
269	- **Files:** `engine/workflow.go:329` (approx.)
270	- **Problem:** Job names are based on `time.Now().UnixMilli()`; two steps created in the same millisecond can collide.
271	- **Fix:** Use `time.Now().UnixNano()` or a UUID for the suffix.
272	- **Acceptance:** No collision under rapid creation.
273	
274	---
275	
276	### Epic 3 — Error Handling & Observability
277	
278	#### GBP-020 High-level orchestration paths return bare `err`
279	- **Severity:** P0
280	- **Effort:** M
281	- **Files:** `cmd/main.go:294, 297, 660, 697, 700, 752, 757, 805`; `internal/api/apply_bundle.go:389, 393, 409, 424, 439`; `internal/controller/pipelines/release_controller.go:628, 649, 654, 665, 679, 1275, 1306`; `internal/controller/pipelines/application_controller.go:637, 1364, 1373`; `traffic/istio/istio.go:46, 87, 127, 153, 176, 196`; `traffic/gatewayapi/gatewayapi.go:63`
282	- **Problem:** Errors lose context before reaching the operator / CLI user, making incident debugging hard.
283	- **Fix:** Wrap each with `fmt.Errorf("<operation>: %w", err)`. `%w` must be at the end.
284	- **Acceptance:** No bare `return err` in the listed high-level functions.
285	
286	#### GBP-021 Additional bare `return err` in mid-level code
287	- **Severity:** P1
288	- **Effort:** M
289	- **Files:** `internal/api/auth/middleware.go:33, 91`; `cmd/paprika/apply.go:89`; `engine/workflow.go:77, 98`; `source/resolver.go:46`; `internal/api/apply_bundle.go:197`
290	- **Problem:** Same as GBP-020, but in smaller functions.
291	- **Fix:** Wrap each error with the operation name.
292	- **Acceptance:** `golangci-lint` with `wrapcheck` enabled on these paths is green.
293	
294	#### GBP-022 Error strings start with capital letters or end with punctuation
295	- **Severity:** P1
296	- **Effort:** S
297	- **Files:** `traffic/istio/istio.go:49, 130`; `traffic/gatewayapi/gatewayapi.go:66`; `internal/api/auth/oidc_auth.go:39, 42`
298	- **Problem:** Violates Go error-string convention and `revive` / `staticcheck ST1005`.
299	- **Fix:** Lowercase and remove trailing punctuation.
300	- **Acceptance:** No capitalized error strings in new code.
301	
302	#### GBP-023 `%w` is not at the end of formatted errors in auth package
303	- **Severity:** P2
304	- **Effort:** S
305	- **Files:** `internal/api/auth/authz.go:92`; `internal/api/auth/authenticator.go:42`; `internal/api/auth/basic_auth.go:56, 67, 71`; `internal/api/auth/oidc_auth.go:82, 93, 102`
306	- **Problem:** Sentinel errors are placed first, producing least-specific-cause-last output.
307	- **Fix:** Reorder to `context: %w` form.
308	- **Acceptance:** All `%w` verbs appear at the end of the format string.
309	
310	#### GBP-024 `_ =` error discards in production code
311	- **Severity:** P1
312	- **Effort:** M
313	- **Files:** `cmd/cloud-run/main.go:253`; `cmd/main.go:911`; `internal/reposerver/server.go:104, 134`; `internal/webhook/receiver/handler.go:101, 109`; `engine/template.go:168`; `internal/agent/server/server.go:204-205`
314	- **Problem:** Silent failures from `w.Write`, `fmt.Fprintln`, and file writes.
315	- **Fix:** Either return/log the error or use `defer func() { _ = resp.Body.Close() }()` with a documented ignore.
316	- **Acceptance:** No unchecked `_ =` for I/O or HTTP writes in production code.
317	
318	#### GBP-025 Silently ignored parse / type-assertion errors
319	- **Severity:** P1
320	- **Effort:** S
321	- **Files:** `cmd/paprika-cli/template.go:44` (`sourceType, _ = raw["type"].(string)`); `internal/api/events/broker.go:63` (`db, _ := strconv.Atoi(os.Getenv(...))`)
322	- **Problem:** Invalid input is ignored, leading to wrong defaults or hidden misconfigurations.
323	- **Fix:** Check the `ok` value and return an explicit error.
324	- **Acceptance:** Invalid template types and `PAPRIKA_REDIS_DB` values surface errors.
325	
326	#### GBP-026 Package-level mutable state in observability
327	- **Severity:** P0
328	- **Effort:** M
329	- **Files:** `internal/observability/observability.go:31-35`
330	- **Problem:** `tracer`, `provider`, and `enabled` are package globals mutated by `InitTracing`.
331	- **Fix:** Return a `Telemetry` struct (or `Tracer` + `Shutdown` func) from `InitTracing` and inject it into servers/controllers. Keep `StartSpan` as a method.
332	- **Acceptance:** No package-level mutable state; tests can create independent telemetry instances.
333	
334	#### GBP-027 Package-level mutable `timeNow` in webhook receiver
335	- **Severity:** P0
336	- **Effort:** S
337	- **Files:** `internal/webhook/receiver/handler.go:316`, `:313`
338	- **Problem:** `var timeNow = time.Now` is global mutable state swapped in tests.
339	- **Fix:** Inject a `func() time.Time` or `Clock` interface through `NewHandler`.
340	- **Acceptance:** Tests inject the clock; production uses `time.Now` via the constructor default.
341	
342	#### GBP-028 `cmd/cloud-run/main.go` global health mux and `init()`
343	- **Severity:** P2
344	- **Effort:** S
345	- **Files:** `cmd/cloud-run/main.go:49, 232`
346	- **Problem:** A package-level `var muxHealth = http.NewServeMux()` is initialized in `init()`.
347	- **Fix:** Create the mux lazily inside `startHealthProbe` or return it from a constructor.
348	- **Acceptance:** No mutable globals or non-scheme `init()` functions in `cmd/cloud-run/main.go`.
349	
350	#### GBP-029 `context.Context` shadowed by `ctx, cancel := context.WithTimeout`
351	- **Severity:** P2
352	- **Effort:** XS
353	- **Files:** `internal/api/auth/oidc_auth.go:97`
354	- **Problem:** The skill prefers `=` reassignment to avoid shadowing the parameter.
355	- **Fix:** Use `ctx, cancel = context.WithTimeout(ctx, 10*time.Second)` after declaring `cancel`.
356	- **Acceptance:** `go vet` / shadow analyzer reports no shadow.
357	
358	#### GBP-030 Deprecated APIs suppressed with `//nolint:staticcheck`
359	- **Severity:** P1
360	- **Effort:** M
361	- **Files:** `cmd/main.go:471, 493, 537, 571` (`mgr.GetEventRecorderFor`); `internal/controller/pipelines/application_controller.go:483`; `internal/webhook/pipelines/v1alpha1/application_webhook.go:122` (`app.Spec.Source.Image`)
362	- **Problem:** SA1019 usages are permanently suppressed rather than migrated.
363	- **Fix:** Migrate to `mgr.GetEventRecorder` and `app.Spec.Source.OCI.URL`; remove the `nolint` comments.
364	- **Acceptance:** No `SA1019` suppressions remain.
365	
366	#### GBP-031 `os.Getenv` scattered deep in constructors
367	- **Severity:** P2
368	- **Effort:** M
369	- **Files:** `internal/cache/factory.go:29-31`; `internal/api/events/broker.go:52, 59, 63, 66`; `internal/reposerver/client/client.go:41`; `internal/observability/observability.go:39, 44, 140, 177`; `internal/sharding/sharding.go:28, 38, 119, 121, 123`; `cmd/main.go:942, 975, 1021`; `cmd/cloud-run/main.go:67, 71, 202`
370	- **Problem:** Configuration is read throughout the call tree, making tests environment-dependent and behavior hard to trace.
371	- **Fix:** Read all env vars in `main`/`registerFlags` and pass explicit `Config` structs. Keep `NewFromEnv` as a thin wrapper only where necessary.
372	- **Acceptance:** No `os.Getenv` inside library constructors (only in `main` or `*_test.go`).
373	
374	---
375	
376	### Epic 4 — Interfaces, Architecture & DI
377	
378	#### GBP-032 Producer-side interfaces in `engine`, `source`, `analysis`, `health`, `policy`, `gates`, `internal/governance`, `internal/syncwindow`
379	- **Severity:** P0
380	- **Effort:** L
381	- **Files:** `engine/interfaces.go`; `source/interfaces.go`; `analysis/interfaces.go`; `health/interfaces.go`; `policy/interfaces.go`; `gates/interfaces.go`; `internal/governance/cluster_resolver.go`; `internal/syncwindow/evaluator.go`
382	- **Problem:** Interfaces are defined next to their only implementation, forcing consumers to import the producer package just for the interface. This is the Java-style anti-pattern the skill calls out as the highest-leverage design mistake.
383	- **Fix:** Move each interface to the package that **consumes** it (controllers / `internal/api`). Have the producer export concrete structs. Adapters satisfy interfaces implicitly.
384	- **Acceptance:** No interface in a producer package that is only consumed elsewhere.
385	
386	#### GBP-033 Constructors return interfaces instead of concrete structs
387	- **Severity:** P0
388	- **Effort:** M
389	- **Files:** `policy/evaluator.go:22`; `internal/governance/cluster_resolver.go:19`; `internal/syncwindow/evaluator.go:26`; `internal/cache/factory.go:23, 44`
390	- **Problem:** Returning interfaces prevents callers from using new methods and hides the concrete type.
391	- **Fix:** Return `*evaluator`, `*clusterResolver`, `*MemoryCache`, `*RedisCache`. Callers can still store them through the interface if needed.
392	- **Acceptance:** Constructors listed above return structs.
393	
394	#### GBP-034 Kitchen-sink interfaces
395	- **Severity:** P1
396	- **Effort:** M
397	- **Files:** `traffic/traffic.go:21` (`Router`, 7 methods); `internal/featureflag/provider.go:5` (`Provider`, 5 methods); `internal/cache/interfaces.go:12` (`Cache`, 5 methods); `engine/interfaces.go:20` (`TemplateRenderer`, 4 methods)
398	- **Problem:** Large interfaces weaken abstraction and force implementers to stub unused methods.
399	- **Fix:** Split into role interfaces (`WeightRouter`, `HeaderRouter`, `MirrorRouter`, `Getter`, `Setter`, `Renderer`, `Resolver`) and compose only the combinations callers need.
400	- **Acceptance:** No interface >3 methods unless it is a genuine stdlib-style composition (`io.ReadWriter`).
401	
402	#### GBP-035 Speculative / single-implementation abstractions
403	- **Severity:** P2
404	- **Effort:** M
405	- **Files:** `analysis/interfaces.go:13`; `health/interfaces.go:14, 20`; `policy/interfaces.go:34`; `engine/interfaces.go:41`; `source/interfaces.go:6-8`; `gates/gates.go:19`
406	- **Problem:** Interfaces exist with no second implementation, mainly to support mocks. The skill says interfaces earn their place at the second implementation or a real seam.
407	- **Fix:** Either introduce a second implementation, move the interface to the consumer, or delete it and test the real code.
408	- **Acceptance:** Every exported interface has ≥2 implementations or a documented seam.
409	
410	#### GBP-036 Struct embedding leaks `client.Client` API through exported types
411	- **Severity:** P1
412	- **Effort:** M
413	- **Files:** `internal/api/server.go:32-40`; `internal/controller/pipelines/cluster.go:17-20`; `internal/controller/pipelines/cluster_pool.go:43-47`; `internal/controller/pipelines/notification_controller.go:47-48`; `internal/controller/pipelines/application_controller.go:73`; `internal/controller/pipelines/release_controller.go:87`; `internal/controller/pipelines/pipeline_controller.go:30`; `internal/controller/rollouts/rollout_controller.go:58`; plus other reconcilers
414	- **Problem:** Embedding promotes the full controller-runtime client API on exported types, leaking implementation details and making future evolution harder.
415	- **Fix:** Replace embedding with an unexported `client client.Client` field and delegate only the methods you intend to expose. For Kubebuilder reconcilers, the standard pattern is an unexported field.
416	- **Acceptance:** No exported struct embeds `client.Client`.
417	
418	#### GBP-037 Side effects in constructors
419	- **Severity:** P2
420	- **Effort:** M
421	- **Files:** `internal/controller/pipelines/cluster_pool.go:59` (starts goroutine); `internal/api/events/broker.go:43` (starts goroutine); `analysis/analysis.go:37-50` (builds `*http.Client` with `InsecureSkipVerify`); `gates/gates.go:36-40` (builds `*http.Client`); `internal/agent/client/client.go:26-31` (builds `*http.Client`)
422	- **Problem:** Constructors should not start goroutines or build hidden HTTP clients with insecure settings.
423	- **Fix:**
424	  - Provide `Start(ctx)` or register as a `manager.Runnable`.
425	  - Accept `*http.Client` as a parameter; default to `http.DefaultClient` only in a `NewFromEnv` wrapper.
426	- **Acceptance:** Constructors are pure; lifecycle methods handle goroutines.
427	
428	#### GBP-038 Package naming smells
429	- **Severity:** P1
430	- **Effort:** M
431	- **Files:** `internal/api/server.go:1` (package `api`); `internal/controller/pipelines/cluster.go:1`, `cluster_pool.go:1` (package `controller` despite path `pipelines`); `internal/reposerver/client/client.go:1`; `internal/agent/client/client.go:1`
432	- **Problem:** `api` and `controller` are generic grab-bag names; two different packages are both named `client`.
433	- **Fix:** Rename `internal/api` package to `apiserver`; rename `internal/controller/pipelines` files to `package pipelines`; rename `internal/reposerver/client` to `reposerverclient` and `internal/agent/client` to `agentclient`.
434	- **Acceptance:** Package names describe the domain and do not collide with controller-runtime imports.
435	
436	#### GBP-039 Setter injection makes dependencies optional
437	- **Severity:** P2
438	- **Effort:** M
439	- **Files:** `internal/api/server.go:62-69` (`SetRenderer`, `SetAuthorizer`, `SetPolicyEvaluator`, etc.)
440	- **Problem:** Setters imply optional dependencies and allow partially initialized objects.
441	- **Fix:** Inject dependencies through `NewPaprikaServer` (or functional options with defaults) and remove the setters.
442	- **Acceptance:** Server construction requires all dependencies explicitly.
443	
444	#### GBP-040 `if-else` chain that should be a `switch`
445	- **Severity:** P2
446	- **Effort:** XS
447	- **Files:** `engine/scalable_diff.go:87-108`
448	- **Problem:** `gocritic.ifElseChain` is disabled in `.golangci.yml`; the code is clearer as a `switch`.
449	- **Fix:** Refactor to `switch { case !exists: ...; case resourceEqual(...): ...; default: ... }` and consider re-enabling `ifElseChain`.
450	- **Acceptance:** Chain is converted; linter option is re-evaluated.
451	
452	---
453	
454	### Epic 5 — Testing & Mock Hygiene
455	
456	#### GBP-041 Regenerate mocks with `-typed` and move test-only mocks into `*_test.go`
457	- **Severity:** P1
458	- **Effort:** M
459	- **Files:** `engine/mocks/*`, `internal/controller/pipelines/mocks/*`, `health/mocks/*`, `source/mocks/*`, `analysis/mocks/*`, `gates/mocks/*`, `traffic/mocks/*`, `internal/cache/mocks/*`; all `//go:generate mockgen` directives
460	- **Problem:** Mocks are not generated with `-typed`, so `Return`/`DoAndReturn` take `any` and fail at runtime. They also live in non-test `mocks` packages, leaking into the module surface.
461	- **Fix:** Add `-typed` to every directive. Generate mocks next to the source as `mock_<file>_test.go` where possible; keep shared mocks in `internal/<domain>/mocks` if they are reused.
462	- **Acceptance:** All mocks compile with type-safe recorders; no mock package is imported by production code.
463	
464	#### GBP-042 Remove redundant `defer ctrl.Finish()`
465	- **Severity:** P2
466	- **Effort:** XS
467	- **Files:** `engine/engine_gomock_test.go`; `engine/cached_renderer_test.go`; `health/cel_gomock_test.go`; `internal/controller/pipelines/pipeline_controller_unit_test.go`; `internal/controller/pipelines/release_controller_unit_test.go`
468	- **Problem:** `gomock.NewController(t)` already registers `t.Cleanup` to call `Finish`.
469	- **Fix:** Delete the explicit `defer ctrl.Finish()` lines.
470	- **Acceptance:** No redundant `Finish()` in test files.
471	
472	#### GBP-043 Delete or replace mock-only / placeholder tests
473	- **Severity:** P1
474	- **Effort:** M
475	- **Files:** `engine/engine_gomock_test.go`; `health/cel_gomock_test.go`; `internal/controller/pipelines/pipeline_controller_unit_test.go:12-58, 60-97`
476	- **Problem:** These tests only exercise generated mocks or contain empty subtests; they provide no behavioral coverage.
477	- **Fix:** Replace with tests of the real implementation or meaningful fakes; delete placeholder tests.
478	- **Acceptance:** No test file exists solely to exercise mocks.
479	
480	#### GBP-044 Convert copy-paste tests to table-driven tests
481	- **Severity:** P1
482	- **Effort:** M
483	- **Files:** `engine/workflow_test.go` (`TestLinearDAG`, `TestFanOutDAG`, `TestNoDepsDAG`, `TestCycleDetection`, `TestMissingDependency`, `TestDiamondDAG`); `gates/gates_test.go`; `internal/controller/pipelines/self_heal_test.go`; `policy/evaluator_test.go`; `cmd/paprika/apply_test.go`; `cmd/paprika/watch_test.go`
484	- **Problem:** Multiple near-identical functions are harder to extend and review than a single table-driven test.
485	- **Fix:** Collapse into one test with a `[]struct{...}` table and `t.Run` subtests.
486	- **Acceptance:** Each listed package has a single table-driven test per behavior area.
487	
488	#### GBP-045 Add `t.Parallel()` to safe table-driven tests
489	- **Severity:** P2
490	- **Effort:** S
491	- **Files:** `engine/template_test.go`; `source/resolver_test.go`; `health/cel_test.go`; `internal/controller/pipelines/sync_options_test.go`; `internal/controller/pipelines/sync_window_test.go`; `internal/syncwindow/evaluator_test.go`; `cmd/paprika/apply_test.go`; `cmd/paprika/watch_test.go`; `internal/controller/pipelines/release_controller_unit_test.go`
492	- **Problem:** Tests do not take advantage of Go 1.22 per-iteration loop scope.
493	- **Fix:** Add `t.Parallel()` to the outer test and each subtest after confirming they do not share mutable state.
494	- **Acceptance:** `go test -count=1` runtime improves; no race failures.
495	
496	#### GBP-046 Use `t.TempDir()` and `t.Setenv()` instead of manual cleanup
497	- **Severity:** P2
498	- **Effort:** S
499	- **Files:** `internal/controller/pipelines/applicationset_controller_test.go:155-159`; `cmd/paprika/apply_test.go:292-301`; `test/e2e/e2e_suite_test.go:123`; `internal/controller/pipelines/suite_test.go:62`; `engine/cached_renderer_test.go:26, 65`
500	- **Problem:** Manual `os.MkdirTemp` + `defer os.RemoveAll`, manual env save/restore, and hard-coded `/tmp/test` are brittle and leak between tests.
501	- **Fix:** Use `t.TempDir()`, `t.Setenv()`, and `t.Cleanup()`.
502	- **Acceptance:** No manual temp-dir or env cleanup in tests.
503	
504	#### GBP-047 Stop leaking real servers in tests
505	- **Severity:** P1
506	- **Effort:** M
507	- **Files:** `cmd/main_test.go:14-61, 83-95`; `internal/api/sse_test.go:24-30`
508	- **Problem:** Tests start real HTTP servers in goroutines and never shut them down; `sse_test.go` also calls `require.NoError` inside a non-test goroutine.
509	- **Fix:** Use `httptest.Server` where possible, or capture `*http.Server` and call `Shutdown` in `t.Cleanup`. Move assertions out of helper goroutines.
510	- **Acceptance:** Tests run without port/goroutine leaks.
511	
512	#### GBP-048 Handle errors in `httptest` handlers
513	- **Severity:** P2
514	- **Effort:** XS
515	- **Files:** `internal/controller/pipelines/notification_controller_test.go:115`
516	- **Problem:** `io.ReadAll(r.Body)` error is ignored.
517	- **Fix:** Check the error and use `require.NoError(t, err)` or `http.Error`.
518	- **Acceptance:** No ignored handler errors in tests.
519	
520	#### GBP-049 Inject clocks to remove real time from unit tests
521	- **Severity:** P2
522	- **Effort:** M
523	- **Files:** `internal/ratelimit/ratelimit.go:29, 79`; `internal/cache/memory.go:37, 50`; `metrics/metrics.go:155, 160`
524	- **Problem:** Tests must sleep to observe TTL refill / expiry behavior.
525	- **Fix:** Inject a `Clock` interface (`Now() time.Time`) with real and fake implementations.
526	- **Acceptance:** TTL/rate-limit tests run deterministically without `time.Sleep`.
527	
528	#### GBP-050 Add `go generate ./...` to `make generate`
529	- **Severity:** P1
530	- **Effort:** S
531	- **Files:** `Makefile:61-63`
532	- **Problem:** `make generate` regenerates controller-gen and protobuf output but does not refresh gomock mocks.
533	- **Fix:** Add `go generate ./...` to the `generate` target (or add a separate `generate-mocks` target).
534	- **Acceptance:** `make generate` updates mocks.
535	
536	---
537	
538	## Quick Wins (can be done in one PR each)
539	
540	1. **GBP-001** — Release workflow Go version (P0, 5 min).
541	2. **GBP-002** — Add `toolchain go1.26.4` (P1, 5 min).
542	3. **GBP-005** — Add `.golangci.yml` `modules-download-mode` and `errcheck.check-blank` (P1, 10 min).
543	4. **GBP-027** — Inject clock in webhook receiver (P0, 30 min).
544	5. **GBP-042** — Remove redundant `defer ctrl.Finish()` (P2, 15 min).
545	6. **GBP-046** — Replace manual temp dirs with `t.TempDir()` (P2, 30 min).
546	7. **GBP-040** — Convert `scalable_diff.go` if-else chain to switch (P2, 15 min).
547	8. **GBP-022** — Lowercase error strings in traffic/auth packages (P1, 20 min).
548	
549	---
550	
551	## Notable Positives
552	
553	- Go version is current (`go 1.26.0`) and the module uses modern dependencies.
554	- Project layout follows domain-driven packages under `internal/`: `agent`, `cache`, `controller`, `featureflag`, `governance`, `observability`, `ratelimit`, `repository`, `rollout`, etc.
555	- No `util`, `common`, `helpers`, `misc`, or `models` grab-bag packages were found.
556	- Mock framework is the live fork `go.uber.org/mock v0.6.0`, not the archived Google version.
557	- `//go:generate mockgen` directives are placed next to the interfaces they mock.
558	- `golangci-lint` v2 config is in place and currently green.
559	- Uses `metav1.Condition` and standard Kubernetes API conventions (per `AGENTS.md`).
560	
561	---
562	
563	## Appendix — Verification Commands to Run After Each Sprint
564	
565	```bash
566	# Toolchain / CI
567	go version                         # should report 1.26.x
568	gofmt -l .                         # should be empty
569	go vet ./...                       # should be clean
570	golangci-lint run ./...            # should be clean
571	golangci-lint config verify        # should pass
572	
573	# Concurrency
574	go test -race ./internal/controller/pipelines/... -run ClusterPool
575	go test -race ./engine/... -run Workflow
576	go test -race ./...                # default CI target after fixes
577	
578	# Architecture (manual)
579	grep -R "type .* interface" --include="*.go" api/ engine/ source/ analysis/ health/ policy/ gates/ internal/governance/ internal/syncwindow/
580	grep -R "func New.*(.*) .*interface" --include="*.go" .
581	grep -R "client.Client" --include="*.go" internal/controller/ internal/api/ | grep -v "unexported"
582	```
<system>582 lines read from file starting from line 1. Total lines in file: 582. End of file reached.</system>

</details>

<details><summary>Thinking</summary>

We need pick next big chunks. The TODO.md says P2 planned next: Approval Gates (high), Conftest Gates (medium), Project-Scoped Policy Governance (high but listed planned with plan spec; we just merged that? Actually TODO shows project-scoped policy governance not checked, but we just merged? Wait earlier context: "Merge project-scoped policy governance: feature branch merged to master". So maybe it should be checked but not updated. So next high is Approval Gates. Also paprika apply CLI high. Production roadmap has critical scaling bottlenecks: diff engine, source cache, helm SDK, monolithic controller, status subresource. But those are P0. The TODO.md "How to Pick Up Work" says choose from P2 Planned Next. User said "look through our backlog and pick up next big chunks". We should present options and recommend. Need consider user said "next big chunks" plural. We can propose a prioritized list. We can also check docs/superpowers/plans for existing plans. Approval gates likely no plan. Paprika apply has plan. We need decide. Since user wants us to pick up, perhaps start with Approval Gates because high priority P2 and no plan yet; we'd write plan first using writing-plans skill. Alternatively `paprika apply -f` CLI has plan/spec, so faster to implement. But "big chunks" maybe pick the highest-impact. We can present 2-3 options with recommendation. Also need possibly use skill `writing-plans` and `subagent-driven-development`. Also maybe use EnterPlanMode because non-trivial feature. According to guidelines, for new feature implementation, use EnterPlanMode. We should do that. But first present options? The user wants us to pick up; we can propose and then plan. The instructions say be decisive. We can recommend Approval Gates as next high-priority P2 with no plan, write plan. Or maybe `paprika apply -f` CLI is high and has plan. Which is bigger? Approval gates touches CRDs, controllers, webhooks, API, UI maybe. Paprika apply CLI touches CLI, Bubble Tea TUI, Policy CRD, ApplyBundle. Both big. The TODO lists Approval Gates first. The production roadmap P0 items are bigger but maybe more architectural. However user said backlog, likely feature backlog TODO.md. We should suggest Approval Gates as the next big chunk. Maybe also mention that project-scoped governance is done but TODO not checked; we can update TODO.md. Actually we should update TODO.md to mark project-scoped policy governance as implemented, since it was merged and e2e passed. That is part of backlog hygiene. Then pick next. We can present. Let's use EnterPlanMode for Approval Gates? Could ask user to confirm. Since user said "pick up next big chunks", we can be decisive and start planning. The system says use EnterPlanMode for new feature implementation. We can do that after maybe a brief message. But EnterPlanMode enters plan mode automatically; user will see plan. However it might be good to first communicate the options and ask which? But instructions say "Use it when ANY of these conditions apply: New Feature Implementation". It doesn't require user approval necessarily, but for plan mode we should explore and write plan. However user said "look through our backlog and pick up next big chunks"—this is ambiguous, could want us to choose. We should ask for clarification if ambiguous. But we can also propose. Since they said pick up, we can pick. Use plan mode? We could say "I'm going to plan Approval Gates; confirm or pick another". That respects user. But maybe too much back-and-forth. The instruction: "When the request is vague, ask the user for clarification if there is anything unclear." The request is vague: "pick up next big chunks" could mean choose and start. We can ask them to pick among top 3 options. But user might expect us to decide. Given the backlog, I think we should present a short ranked shortlist and ask which to start planning, unless they want us to just pick. We can phrase: "My recommendation: start with Approval Gates. If you're good with that, I'll enter plan mode and write an implementation plan." That gives user chance to confirm. However we already used many turns; being decisive might be better. But need not start plan mode prematurely; we can update TODO and then propose. Let's also check if there are GitHub issues or project board with labels. Issue list empty? The `gh issue list` returned no output, maybe because empty or due to permissions. We can check project boards? `gh project list`. But enough from docs. Let's read plan/spec for paprika apply to compare. Use Glob for docs/superpowers/plans.

</details>

#### Tool Call: Bash (`ls docs/superpowers/plans/ docs/superpowers/specs/ 2>/dev/nu…`)
<!-- call_id: tool_3n3EgXT1p5igR6d4l0rw9Mcb -->
```json
{
  "command": "ls docs/superpowers/plans/ docs/superpowers/specs/ 2>/dev/null",
  "timeout": 30
}
```

<details><summary>Tool Result: Bash (`ls docs/superpowers/plans/ docs/superpowers/specs/ 2>/dev/nu…`)</summary>

<!-- call_id: tool_3n3EgXT1p5igR6d4l0rw9Mcb -->
docs/superpowers/plans/:
2026-06-07-paprika-phase1.md
2026-06-08-application-crd.md
2026-06-08-ci-deployment-implementation.md
2026-06-09-multi-source-rendering.md
2026-06-09-unified-platform-roadmap.md
2026-06-10-hardening-phase-1.md
2026-06-10-traffic-management.md
2026-06-12-ha-sharding-repo-server.md
2026-06-13-paprika-apply.md
2026-06-13-project-scoped-policy-governance.md
2026-06-13-rollout-feature-flags-phase1.md
2026-06-16-advanced-rollout-strategies.md
2026-06-16-analysis-templates.md
2026-06-16-notifications.md
2026-06-16-oci-support.md
2026-06-16-self-healing.md
2026-06-16-sync-windows.md

docs/superpowers/specs/:
2026-06-07-paprika-design.md
2026-06-08-ci-deployment-design.md
2026-06-10-hardening-design.md
2026-06-10-traffic-management-design.md
2026-06-13-paprika-apply-design.md
2026-06-13-project-scoped-policy-governance-design.md
2026-06-13-rollout-feature-flags-design.md
2026-06-16-advanced-rollout-strategies-design.md
2026-06-16-analysis-templates.md
2026-06-16-notifications-design.md
2026-06-16-oci-support-design.md
2026-06-16-self-healing-design.md
2026-06-16-sync-windows-design.md


</details>

<details><summary>Thinking</summary>

No approval gates plan. The next P2 high items: Approval Gates (no plan), Project-scoped governance (done), paprika apply CLI (plan). We should update TODO to mark governance done. Then propose options. Since user wants "next big chunks", maybe we can pick two: start with Approval Gates (new P2 high) and also maybe `paprika apply -f` CLI (high, has plan) as parallel? They are independent? Approval gates touches release/stage controllers; paprika apply CLI touches CLI. Could be parallel with subagents. But maybe too much. The user said chunks plural; we can propose a slate: 1) Approval Gates, 2) Conftest Gates, 3) `paprika apply` CLI. We recommend Approval Gates as the biggest user-facing feature. Or perhaps Production scaling diff engine P0 is bigger but not in P2. However TODO says P2 next. We can mention P0 scaling items as alternative. Since user said "backlog" generally, include production roadmap P0 as options. Let's read the `docs/superpowers/plans/2026-06-13-paprika-apply.md` quickly to assess scope.

</details>

#### Tool Call: Read (`docs/superpowers/plans/2026-06-13-paprika-apply.md`)
<!-- call_id: tool_viYf2OwZcYB2Db0SxCsbeuX1 -->
```json
{
  "path": "docs/superpowers/plans/2026-06-13-paprika-apply.md",
  "n_lines": 200
}
```

<details><summary>Tool Result: Read (`docs/superpowers/plans/2026-06-13-paprika-apply.md`)</summary>

<!-- call_id: tool_viYf2OwZcYB2Db0SxCsbeuX1 -->
1	# `paprika apply -f` Implementation Plan
2	
3	> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.
4	
5	**Goal:** Implement the `paprika apply -f` command and its supporting platform features: a `Policy` CRD, an `ApplyBundle` API, inline Application/Release source types, and a Bubble Tea TUI for watching rollouts.
6	
7	**Architecture:** The CLI renders manifests locally and submits them via `ApplyBundle`. The API server evaluates policies, creates an Application/Stage/Release, and stores a snapshot ConfigMap. The existing controllers apply the snapshot and monitor health. A new `policy` package provides CEL-based policy evaluation.
8	
9	**Tech Stack:** Go 1.26, Kubebuilder, controller-runtime, cel-go, Connect-RPC, Cobra, Bubble Tea, Next.js.
10	
11	---
12	
13	## Chunk 1: Policy CRD and evaluator package
14	
15	This chunk creates the `Policy` CRD, registers it in the scheme, and builds a reusable policy evaluator that can be unit-tested in isolation.
16	
17	### Task 1.1: Scaffold `Policy` CRD
18	
19	**Files:**
20	- Create: `api/policy/v1alpha1/policy_types.go` (via `kubebuilder create api`, then edited)
21	- Create: `api/policy/v1alpha1/groupversion_info.go` (via `kubebuilder create api`)
22	- Create: `api/policy/v1alpha1/zz_generated.deepcopy.go` (via `make generate`)
23	- Modify: `cmd/main.go`
24	- Modify: `PROJECT`
25	
26	> **Convention:** Per `AGENTS.md`, use `kubebuilder create api` to scaffold. Do not hand-write `groupversion_info.go` or `_types.go` from scratch.
27	
28	- [ ] **Step 1: Scaffold the Policy API**
29	
30	```bash
31	kubebuilder create api --group policy --version v1alpha1 --kind Policy --namespaced=false
32	```
33	
34	Expected: `api/policy/v1alpha1/` created with `policy_types.go`, `groupversion_info.go`, `zz_generated.deepcopy.go`, and `config/crd/bases/policy.paprika.io_policies.yaml`.
35	
36	- [ ] **Step 2: Edit `api/policy/v1alpha1/policy_types.go`**
37	
38	Replace the scaffolded `PolicySpec` with:
39	
40	```go
41	type PolicySeverity string
42	const (
43	    PolicySeverityCritical PolicySeverity = "critical"
44	    PolicySeverityWarning  PolicySeverity = "warning"
45	)
46	
47	type PolicyAction string
48	const (
49	    PolicyActionEnforce PolicyAction = "enforce"
50	    PolicyActionWarn    PolicyAction = "warn"
51	)
52	
53	type PolicyMatch struct {
54	    APIGroups     []string              `json:"apiGroups,omitempty"`
55	    Kinds         []string              `json:"kinds,omitempty"`
56	    Namespaces    []string              `json:"namespaces,omitempty"`
57	    LabelSelector *metav1.LabelSelector `json:"labelSelector,omitempty"`
58	}
59	
60	type PolicySpec struct {
61	    Description   string         `json:"description,omitempty"`
62	    // +kubebuilder:validation:Enum=critical;warning
63	    Severity      PolicySeverity `json:"severity"`
64	    // +kubebuilder:validation:Enum=enforce;warn
65	    DefaultAction PolicyAction   `json:"defaultAction,omitempty"`
66	    Match         PolicyMatch    `json:"match"`
67	    Expression    string         `json:"expression"`
68	}
69	
70	type PolicyStatus struct{}
71	```
72	
73	Use the project convention `json:"metadata,omitzero"` for `Policy` and `PolicyList`.
74	
75	Add markers:
76	
77	```go
78	// +kubebuilder:object:root=true
79	// +kubebuilder:resource:scope=Cluster
80	// +kubebuilder:subresource:status
81	// +kubebuilder:printcolumn:name="Severity",type=string,JSONPath=".spec.severity"
82	// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"
83	```
84	
85	- [ ] **Step 3: Register policy scheme in operator mode**
86	
87	Modify `cmd/main.go` to import and register `policyv1alpha1`:
88	
89	```go
90	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
91	```
92	
93	```go
94	utilruntime.Must(policyv1alpha1.AddToScheme(scheme))
95	```
96	
97	- [ ] **Step 4: Register policy scheme in API-only mode**
98	
99	Find `createAPIClient` (or equivalent) in `cmd/main.go` and add:
100	
101	```go
102	utilruntime.Must(policyv1alpha1.AddToScheme(apiScheme))
103	```
104	
105	- [ ] **Step 5: Generate deepcopy and CRDs**
106	
107	Run:
108	```bash
109	make generate
110	make manifests
111	```
112	
113	Expected: `api/policy/v1alpha1/zz_generated.deepcopy.go` and `config/crd/bases/policy.paprika.io_policies.yaml` are created without errors.
114	
115	- [ ] **Step 6: Verify `PROJECT` file**
116	
117	Open `PROJECT` and confirm a new `policy.paprika.io/v1alpha1 Policy` resource entry exists.
118	
119	- [ ] **Step 7: Commit**
120	
121	```bash
122	git add api/policy cmd/main.go config/crd/bases PROJECT
123	git commit -m "feat(policy): add Policy CRD scaffolding"
124	```
125	
126	### Task 1.2: Build the policy evaluator
127	
128	**Files:**
129	- Create: `policy/interfaces.go`
130	- Create: `policy/evaluator.go`
131	- Create: `policy/evaluator_test.go`
132	- Create: `policy/defaults.go`
133	
134	- [ ] **Step 1: Write failing unit test**
135	
136	Create `policy/evaluator_test.go`:
137	
138	```go
139	package policy
140	
141	import (
142	    "context"
143	    "testing"
144	
145	    policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
146	    "github.com/stretchr/testify/require"
147	    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
148	)
149	
150	func TestEvaluator_PassesValidManifest(t *testing.T) {
151	    policies := []policyv1alpha1.Policy{{
152	        ObjectMeta: metav1.ObjectMeta{Name: "no-latest"},
153	        Spec: policyv1alpha1.PolicySpec{
154	            Severity: policyv1alpha1.PolicySeverityCritical,
155	            Match: policyv1alpha1.PolicyMatch{Kinds: []string{"Deployment"}},
156	            Expression: `object.spec.template.spec.containers.all(c, c.image != "latest")`,
157	        },
158	    }}
159	    bundle := []byte(`
160	apiVersion: apps/v1
161	kind: Deployment
162	metadata:
163	  name: nginx
164	spec:
165	  template:
166	    spec:
167	      containers:
168	        - name: nginx
169	          image: nginx:1.25
170	`)
171	    eval := NewEvaluator(policies)
172	    res, err := eval.Evaluate(context.Background(), bundle, EvaluateOptions{})
173	    require.NoError(t, err)
174	    require.True(t, res.Passed)
175	    require.False(t, res.Blocked)
176	}
177	```
178	
179	- [ ] **Step 2: Run the test and confirm it fails**
180	
181	```bash
182	go test ./policy/... -run TestEvaluator_PassesValidManifest -v
183	```
184	
185	Expected: compile or test failure.
186	
187	- [ ] **Step 3: Implement the evaluator**
188	
189	Create `policy/interfaces.go`:
190	
191	```go
192	package policy
193	
194	import (
195	    "context"
196	
197	    policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
198	)
199	
200	type Action string
<system>200 lines read from file starting from line 1. Total lines in file: 2878.</system>

</details>

<details><summary>Thinking</summary>

The paprika apply plan is huge (2878 lines) with detailed chunks. It might be the most ready to implement. Approval gates has no plan, would need writing one first. The user wants "next big chunks". We can propose to start with `paprika apply -f` because it has a detailed plan and is high priority. But Approval Gates is also high. Let's consider recent context: They just merged project-scoped policy governance. The `paprika apply -f` plan references Policy CRD and project-scoped governance; maybe it's a natural continuation: now that governance is in place, implement CLI apply and Policy CRD. Also the plan says "For agentic workers: REQUIRED: Use superpowers:subagent-driven-development". That aligns with our tools. The plan is broken into chunks. So picking that up is straightforward. Approval gates would need a plan first. We can recommend `paprika apply -f` as the next big chunk because it builds on governance and has a ready plan. However the user asked us to look through backlog and pick up; maybe we should pick one and start planning/executing. We can update TODO and then say "I recommend `paprika apply -f`". Then use EnterPlanMode or subagent-driven development. The plan already exists, so we may not need EnterPlanMode; we can execute the existing plan using subagent-driven-development skill. But the skill instructions require reading skill. We should read `subagent-driven-development` skill. Also maybe `executing-plans` skill. The plan doc explicitly says use subagent-driven-development or executing-plans. We should read that skill. Then we can start implementing. But before writing code, we should maybe ask user if they want to proceed with paprika apply. But they said pick up; we can be decisive. However implementing a 2878-line plan is huge; we might want to chunk and use subagents. We can start with chunk 1. But we need create a worktree? The `using-git-worktrees` skill might be useful. The plan may require a feature branch. We should create a worktree for this feature. But first decide. Let's read the subagent-driven-development skill to see workflow.

</details>

#### Tool Call: Read (`/Users/benebsworth/.agents/skills/superpowers/subagent-drive…`)
<!-- call_id: tool_KZB02X6uNCZToJ3F5jpTmyHz -->
```json
{
  "path": "/Users/benebsworth/.agents/skills/superpowers/subagent-driven-development/SKILL.md",
  "n_lines": 1000
}
```

<details><summary>Tool Result: Read (`/Users/benebsworth/.agents/skills/superpowers/subagent-drive…`)</summary>

<!-- call_id: tool_KZB02X6uNCZToJ3F5jpTmyHz -->
1	---
2	name: subagent-driven-development
3	description: Use when executing implementation plans with independent tasks in the current session
4	---
5	
6	# Subagent-Driven Development
7	
8	Execute plan by dispatching fresh subagent per task, with two-stage review after each: spec compliance review first, then code quality review.
9	
10	**Why subagents:** You delegate tasks to specialized agents with isolated context. By precisely crafting their instructions and context, you ensure they stay focused and succeed at their task. They should never inherit your session's context or history — you construct exactly what they need. This also preserves your own context for coordination work.
11	
12	**Core principle:** Fresh subagent per task + two-stage review (spec then quality) = high quality, fast iteration
13	
14	## When to Use
15	
16	```dot
17	digraph when_to_use {
18	    "Have implementation plan?" [shape=diamond];
19	    "Tasks mostly independent?" [shape=diamond];
20	    "Stay in this session?" [shape=diamond];
21	    "subagent-driven-development" [shape=box];
22	    "executing-plans" [shape=box];
23	    "Manual execution or brainstorm first" [shape=box];
24	
25	    "Have implementation plan?" -> "Tasks mostly independent?" [label="yes"];
26	    "Have implementation plan?" -> "Manual execution or brainstorm first" [label="no"];
27	    "Tasks mostly independent?" -> "Stay in this session?" [label="yes"];
28	    "Tasks mostly independent?" -> "Manual execution or brainstorm first" [label="no - tightly coupled"];
29	    "Stay in this session?" -> "subagent-driven-development" [label="yes"];
30	    "Stay in this session?" -> "executing-plans" [label="no - parallel session"];
31	}
32	```
33	
34	**vs. Executing Plans (parallel session):**
35	- Same session (no context switch)
36	- Fresh subagent per task (no context pollution)
37	- Two-stage review after each task: spec compliance first, then code quality
38	- Faster iteration (no human-in-loop between tasks)
39	
40	## The Process
41	
42	```dot
43	digraph process {
44	    rankdir=TB;
45	
46	    subgraph cluster_per_task {
47	        label="Per Task";
48	        "Dispatch implementer subagent (./implementer-prompt.md)" [shape=box];
49	        "Implementer subagent asks questions?" [shape=diamond];
50	        "Answer questions, provide context" [shape=box];
51	        "Implementer subagent implements, tests, commits, self-reviews" [shape=box];
52	        "Dispatch spec reviewer subagent (./spec-reviewer-prompt.md)" [shape=box];
53	        "Spec reviewer subagent confirms code matches spec?" [shape=diamond];
54	        "Implementer subagent fixes spec gaps" [shape=box];
55	        "Dispatch code quality reviewer subagent (./code-quality-reviewer-prompt.md)" [shape=box];
56	        "Code quality reviewer subagent approves?" [shape=diamond];
57	        "Implementer subagent fixes quality issues" [shape=box];
58	        "Mark task complete in TodoWrite" [shape=box];
59	    }
60	
61	    "Read plan, extract all tasks with full text, note context, create TodoWrite" [shape=box];
62	    "More tasks remain?" [shape=diamond];
63	    "Dispatch final code reviewer subagent for entire implementation" [shape=box];
64	    "Use superpowers:finishing-a-development-branch" [shape=box style=filled fillcolor=lightgreen];
65	
66	    "Read plan, extract all tasks with full text, note context, create TodoWrite" -> "Dispatch implementer subagent (./implementer-prompt.md)";
67	    "Dispatch implementer subagent (./implementer-prompt.md)" -> "Implementer subagent asks questions?";
68	    "Implementer subagent asks questions?" -> "Answer questions, provide context" [label="yes"];
69	    "Answer questions, provide context" -> "Dispatch implementer subagent (./implementer-prompt.md)";
70	    "Implementer subagent asks questions?" -> "Implementer subagent implements, tests, commits, self-reviews" [label="no"];
71	    "Implementer subagent implements, tests, commits, self-reviews" -> "Dispatch spec reviewer subagent (./spec-reviewer-prompt.md)";
72	    "Dispatch spec reviewer subagent (./spec-reviewer-prompt.md)" -> "Spec reviewer subagent confirms code matches spec?";
73	    "Spec reviewer subagent confirms code matches spec?" -> "Implementer subagent fixes spec gaps" [label="no"];
74	    "Implementer subagent fixes spec gaps" -> "Dispatch spec reviewer subagent (./spec-reviewer-prompt.md)" [label="re-review"];
75	    "Spec reviewer subagent confirms code matches spec?" -> "Dispatch code quality reviewer subagent (./code-quality-reviewer-prompt.md)" [label="yes"];
76	    "Dispatch code quality reviewer subagent (./code-quality-reviewer-prompt.md)" -> "Code quality reviewer subagent approves?";
77	    "Code quality reviewer subagent approves?" -> "Implementer subagent fixes quality issues" [label="no"];
78	    "Implementer subagent fixes quality issues" -> "Dispatch code quality reviewer subagent (./code-quality-reviewer-prompt.md)" [label="re-review"];
79	    "Code quality reviewer subagent approves?" -> "Mark task complete in TodoWrite" [label="yes"];
80	    "Mark task complete in TodoWrite" -> "More tasks remain?";
81	    "More tasks remain?" -> "Dispatch implementer subagent (./implementer-prompt.md)" [label="yes"];
82	    "More tasks remain?" -> "Dispatch final code reviewer subagent for entire implementation" [label="no"];
83	    "Dispatch final code reviewer subagent for entire implementation" -> "Use superpowers:finishing-a-development-branch";
84	}
85	```
86	
87	## Model Selection
88	
89	Use the least powerful model that can handle each role to conserve cost and increase speed.
90	
91	**Mechanical implementation tasks** (isolated functions, clear specs, 1-2 files): use a fast, cheap model. Most implementation tasks are mechanical when the plan is well-specified.
92	
93	**Integration and judgment tasks** (multi-file coordination, pattern matching, debugging): use a standard model.
94	
95	**Architecture, design, and review tasks**: use the most capable available model.
96	
97	**Task complexity signals:**
98	- Touches 1-2 files with a complete spec → cheap model
99	- Touches multiple files with integration concerns → standard model
100	- Requires design judgment or broad codebase understanding → most capable model
101	
102	## Handling Implementer Status
103	
104	Implementer subagents report one of four statuses. Handle each appropriately:
105	
106	**DONE:** Proceed to spec compliance review.
107	
108	**DONE_WITH_CONCERNS:** The implementer completed the work but flagged doubts. Read the concerns before proceeding. If the concerns are about correctness or scope, address them before review. If they're observations (e.g., "this file is getting large"), note them and proceed to review.
109	
110	**NEEDS_CONTEXT:** The implementer needs information that wasn't provided. Provide the missing context and re-dispatch.
111	
112	**BLOCKED:** The implementer cannot complete the task. Assess the blocker:
113	1. If it's a context problem, provide more context and re-dispatch with the same model
114	2. If the task requires more reasoning, re-dispatch with a more capable model
115	3. If the task is too large, break it into smaller pieces
116	4. If the plan itself is wrong, escalate to the human
117	
118	**Never** ignore an escalation or force the same model to retry without changes. If the implementer said it's stuck, something needs to change.
119	
120	## Prompt Templates
121	
122	- `./implementer-prompt.md` - Dispatch implementer subagent
123	- `./spec-reviewer-prompt.md` - Dispatch spec compliance reviewer subagent
124	- `./code-quality-reviewer-prompt.md` - Dispatch code quality reviewer subagent
125	
126	## Example Workflow
127	
128	```
129	You: I'm using Subagent-Driven Development to execute this plan.
130	
131	[Read plan file once: docs/superpowers/plans/feature-plan.md]
132	[Extract all 5 tasks with full text and context]
133	[Create TodoWrite with all tasks]
134	
135	Task 1: Hook installation script
136	
137	[Get Task 1 text and context (already extracted)]
138	[Dispatch implementation subagent with full task text + context]
139	
140	Implementer: "Before I begin - should the hook be installed at user or system level?"
141	
142	You: "User level (~/.config/superpowers/hooks/)"
143	
144	Implementer: "Got it. Implementing now..."
145	[Later] Implementer:
146	  - Implemented install-hook command
147	  - Added tests, 5/5 passing
148	  - Self-review: Found I missed --force flag, added it
149	  - Committed
150	
151	[Dispatch spec compliance reviewer]
152	Spec reviewer: ✅ Spec compliant - all requirements met, nothing extra
153	
154	[Get git SHAs, dispatch code quality reviewer]
155	Code reviewer: Strengths: Good test coverage, clean. Issues: None. Approved.
156	
157	[Mark Task 1 complete]
158	
159	Task 2: Recovery modes
160	
161	[Get Task 2 text and context (already extracted)]
162	[Dispatch implementation subagent with full task text + context]
163	
164	Implementer: [No questions, proceeds]
165	Implementer:
166	  - Added verify/repair modes
167	  - 8/8 tests passing
168	  - Self-review: All good
169	  - Committed
170	
171	[Dispatch spec compliance reviewer]
172	Spec reviewer: ❌ Issues:
173	  - Missing: Progress reporting (spec says "report every 100 items")
174	  - Extra: Added --json flag (not requested)
175	
176	[Implementer fixes issues]
177	Implementer: Removed --json flag, added progress reporting
178	
179	[Spec reviewer reviews again]
180	Spec reviewer: ✅ Spec compliant now
181	
182	[Dispatch code quality reviewer]
183	Code reviewer: Strengths: Solid. Issues (Important): Magic number (100)
184	
185	[Implementer fixes]
186	Implementer: Extracted PROGRESS_INTERVAL constant
187	
188	[Code reviewer reviews again]
189	Code reviewer: ✅ Approved
190	
191	[Mark Task 2 complete]
192	
193	...
194	
195	[After all tasks]
196	[Dispatch final code-reviewer]
197	Final reviewer: All requirements met, ready to merge
198	
199	Done!
200	```
201	
202	## Advantages
203	
204	**vs. Manual execution:**
205	- Subagents follow TDD naturally
206	- Fresh context per task (no confusion)
207	- Parallel-safe (subagents don't interfere)
208	- Subagent can ask questions (before AND during work)
209	
210	**vs. Executing Plans:**
211	- Same session (no handoff)
212	- Continuous progress (no waiting)
213	- Review checkpoints automatic
214	
215	**Efficiency gains:**
216	- No file reading overhead (controller provides full text)
217	- Controller curates exactly what context is needed
218	- Subagent gets complete information upfront
219	- Questions surfaced before work begins (not after)
220	
221	**Quality gates:**
222	- Self-review catches issues before handoff
223	- Two-stage review: spec compliance, then code quality
224	- Review loops ensure fixes actually work
225	- Spec compliance prevents over/under-building
226	- Code quality ensures implementation is well-built
227	
228	**Cost:**
229	- More subagent invocations (implementer + 2 reviewers per task)
230	- Controller does more prep work (extracting all tasks upfront)
231	- Review loops add iterations
232	- But catches issues early (cheaper than debugging later)
233	
234	## Red Flags
235	
236	**Never:**
237	- Start implementation on main/master branch without explicit user consent
238	- Skip reviews (spec compliance OR code quality)
239	- Proceed with unfixed issues
240	- Dispatch multiple implementation subagents in parallel (conflicts)
241	- Make subagent read plan file (provide full text instead)
242	- Skip scene-setting context (subagent needs to understand where task fits)
243	- Ignore subagent questions (answer before letting them proceed)
244	- Accept "close enough" on spec compliance (spec reviewer found issues = not done)
245	- Skip review loops (reviewer found issues = implementer fixes = review again)
246	- Let implementer self-review replace actual review (both are needed)
247	- **Start code quality review before spec compliance is ✅** (wrong order)
248	- Move to next task while either review has open issues
249	
250	**If subagent asks questions:**
251	- Answer clearly and completely
252	- Provide additional context if needed
253	- Don't rush them into implementation
254	
255	**If reviewer finds issues:**
256	- Implementer (same subagent) fixes them
257	- Reviewer reviews again
258	- Repeat until approved
259	- Don't skip the re-review
260	
261	**If subagent fails task:**
262	- Dispatch fix subagent with specific instructions
263	- Don't try to fix manually (context pollution)
264	
265	## Integration
266	
267	**Required workflow skills:**
268	- **superpowers:using-git-worktrees** - REQUIRED: Set up isolated workspace before starting
269	- **superpowers:writing-plans** - Creates the plan this skill executes
270	- **superpowers:requesting-code-review** - Code review template for reviewer subagents
271	- **superpowers:finishing-a-development-branch** - Complete development after all tasks
272	
273	**Subagents should use:**
274	- **superpowers:test-driven-development** - Subagents follow TDD for each task
275	
276	**Alternative workflow:**
277	- **superpowers:executing-plans** - Use for parallel session instead of same-session execution
<system>277 lines read from file starting from line 1. Total lines in file: 277. End of file reached.</system>

</details>

<details><summary>Thinking</summary>

We also need read using-git-worktrees skill because required. Let's read it.

</details>

#### Tool Call: Read (`/Users/benebsworth/.agents/skills/superpowers/using-git-work…`)
<!-- call_id: tool_wP6ZyVBzkE77DXpAkEITfBDI -->
```json
{
  "path": "/Users/benebsworth/.agents/skills/superpowers/using-git-worktrees/SKILL.md",
  "n_lines": 1000
}
```

<details><summary>Tool Result: Read (`/Users/benebsworth/.agents/skills/superpowers/using-git-work…`)</summary>

<!-- call_id: tool_wP6ZyVBzkE77DXpAkEITfBDI -->
1	---
2	name: using-git-worktrees
3	description: Use when starting feature work that needs isolation from current workspace or before executing implementation plans - creates isolated git worktrees with smart directory selection and safety verification
4	---
5	
6	# Using Git Worktrees
7	
8	## Overview
9	
10	Git worktrees create isolated workspaces sharing the same repository, allowing work on multiple branches simultaneously without switching.
11	
12	**Core principle:** Systematic directory selection + safety verification = reliable isolation.
13	
14	**Announce at start:** "I'm using the using-git-worktrees skill to set up an isolated workspace."
15	
16	## Directory Selection Process
17	
18	Follow this priority order:
19	
20	### 1. Check Existing Directories
21	
22	```bash
23	# Check in priority order
24	ls -d .worktrees 2>/dev/null     # Preferred (hidden)
25	ls -d worktrees 2>/dev/null      # Alternative
26	```
27	
28	**If found:** Use that directory. If both exist, `.worktrees` wins.
29	
30	### 2. Check CLAUDE.md
31	
32	```bash
33	grep -i "worktree.*director" CLAUDE.md 2>/dev/null
34	```
35	
36	**If preference specified:** Use it without asking.
37	
38	### 3. Ask User
39	
40	If no directory exists and no CLAUDE.md preference:
41	
42	```
43	No worktree directory found. Where should I create worktrees?
44	
45	1. .worktrees/ (project-local, hidden)
46	2. ~/.config/superpowers/worktrees/<project-name>/ (global location)
47	
48	Which would you prefer?
49	```
50	
51	## Safety Verification
52	
53	### For Project-Local Directories (.worktrees or worktrees)
54	
55	**MUST verify directory is ignored before creating worktree:**
56	
57	```bash
58	# Check if directory is ignored (respects local, global, and system gitignore)
59	git check-ignore -q .worktrees 2>/dev/null || git check-ignore -q worktrees 2>/dev/null
60	```
61	
62	**If NOT ignored:**
63	
64	Per Jesse's rule "Fix broken things immediately":
65	1. Add appropriate line to .gitignore
66	2. Commit the change
67	3. Proceed with worktree creation
68	
69	**Why critical:** Prevents accidentally committing worktree contents to repository.
70	
71	### For Global Directory (~/.config/superpowers/worktrees)
72	
73	No .gitignore verification needed - outside project entirely.
74	
75	## Creation Steps
76	
77	### 1. Detect Project Name
78	
79	```bash
80	project=$(basename "$(git rev-parse --show-toplevel)")
81	```
82	
83	### 2. Create Worktree
84	
85	```bash
86	# Determine full path
87	case $LOCATION in
88	  .worktrees|worktrees)
89	    path="$LOCATION/$BRANCH_NAME"
90	    ;;
91	  ~/.config/superpowers/worktrees/*)
92	    path="~/.config/superpowers/worktrees/$project/$BRANCH_NAME"
93	    ;;
94	esac
95	
96	# Create worktree with new branch
97	git worktree add "$path" -b "$BRANCH_NAME"
98	cd "$path"
99	```
100	
101	### 3. Run Project Setup
102	
103	Auto-detect and run appropriate setup:
104	
105	```bash
106	# Node.js
107	if [ -f package.json ]; then npm install; fi
108	
109	# Rust
110	if [ -f Cargo.toml ]; then cargo build; fi
111	
112	# Python
113	if [ -f requirements.txt ]; then pip install -r requirements.txt; fi
114	if [ -f pyproject.toml ]; then poetry install; fi
115	
116	# Go
117	if [ -f go.mod ]; then go mod download; fi
118	```
119	
120	### 4. Verify Clean Baseline
121	
122	Run tests to ensure worktree starts clean:
123	
124	```bash
125	# Examples - use project-appropriate command
126	npm test
127	cargo test
128	pytest
129	go test ./...
130	```
131	
132	**If tests fail:** Report failures, ask whether to proceed or investigate.
133	
134	**If tests pass:** Report ready.
135	
136	### 5. Report Location
137	
138	```
139	Worktree ready at <full-path>
140	Tests passing (<N> tests, 0 failures)
141	Ready to implement <feature-name>
142	```
143	
144	## Quick Reference
145	
146	| Situation | Action |
147	|-----------|--------|
148	| `.worktrees/` exists | Use it (verify ignored) |
149	| `worktrees/` exists | Use it (verify ignored) |
150	| Both exist | Use `.worktrees/` |
151	| Neither exists | Check CLAUDE.md → Ask user |
152	| Directory not ignored | Add to .gitignore + commit |
153	| Tests fail during baseline | Report failures + ask |
154	| No package.json/Cargo.toml | Skip dependency install |
155	
156	## Common Mistakes
157	
158	### Skipping ignore verification
159	
160	- **Problem:** Worktree contents get tracked, pollute git status
161	- **Fix:** Always use `git check-ignore` before creating project-local worktree
162	
163	### Assuming directory location
164	
165	- **Problem:** Creates inconsistency, violates project conventions
166	- **Fix:** Follow priority: existing > CLAUDE.md > ask
167	
168	### Proceeding with failing tests
169	
170	- **Problem:** Can't distinguish new bugs from pre-existing issues
171	- **Fix:** Report failures, get explicit permission to proceed
172	
173	### Hardcoding setup commands
174	
175	- **Problem:** Breaks on projects using different tools
176	- **Fix:** Auto-detect from project files (package.json, etc.)
177	
178	## Example Workflow
179	
180	```
181	You: I'm using the using-git-worktrees skill to set up an isolated workspace.
182	
183	[Check .worktrees/ - exists]
184	[Verify ignored - git check-ignore confirms .worktrees/ is ignored]
185	[Create worktree: git worktree add .worktrees/auth -b feature/auth]
186	[Run npm install]
187	[Run npm test - 47 passing]
188	
189	Worktree ready at /Users/jesse/myproject/.worktrees/auth
190	Tests passing (47 tests, 0 failures)
191	Ready to implement auth feature
192	```
193	
194	## Red Flags
195	
196	**Never:**
197	- Create worktree without verifying it's ignored (project-local)
198	- Skip baseline test verification
199	- Proceed with failing tests without asking
200	- Assume directory location when ambiguous
201	- Skip CLAUDE.md check
202	
203	**Always:**
204	- Follow directory priority: existing > CLAUDE.md > ask
205	- Verify directory is ignored for project-local
206	- Auto-detect and run project setup
207	- Verify clean test baseline
208	
209	## Integration
210	
211	**Called by:**
212	- **brainstorming** (Phase 4) - REQUIRED when design is approved and implementation follows
213	- **subagent-driven-development** - REQUIRED before executing any tasks
214	- **executing-plans** - REQUIRED before executing any tasks
215	- Any skill needing isolated workspace
216	
217	**Pairs with:**
218	- **finishing-a-development-branch** - REQUIRED for cleanup after work complete
<system>218 lines read from file starting from line 1. Total lines in file: 218. End of file reached.</system>

</details>

<details><summary>Thinking</summary>

The user said 4 to move on. Now we need respond with backlog options and recommendation. We should also consider using TodoList for new tasks. Let's clear stale and add backlog review tasks. We can set current task: "Review backlog and choose next feature" in progress. But we have already reviewed; maybe set "Present backlog options to user" done? Actually we need user input? Since user said look through backlog and pick up next big chunks, we can decide and start. But it's a huge decision; we should present options. Maybe we can be decisive: "I recommend `paprika apply -f` because plan ready and high priority. Setting up worktree and starting implementation." But the user might want to choose. The instruction says when ambiguous ask. The phrase "pick up next big chunks" could be interpreted as "select and start". We can propose and ask for confirmation: "My pick: start with `paprika apply -f` and parallel track Approval Gates planning. OK?" However if we ask, we might stall. But better to align. We can also use AskUserQuestion with options. That seems appropriate: multiple valid directions. Let's ask with 3 options: 1) paprika apply -f (recommended), 2) Approval Gates, 3) Production scaling P0 (diff engine). Since user said "big chunks". Use AskUserQuestion. But we should update TODO list first: clear stale, add "Review backlog and select next epic". Then ask. The system reminder says never mention reminder. Let's do that.

</details>

#### Tool Call: TodoList
<!-- call_id: tool_nu5t88gy3QGy0j0I6gnLilic -->
```json
{
  "todos": [
    {
      "title": "Review backlog and select next epic",
      "status": "in_progress"
    },
    {
      "title": "Set up isolated worktree for chosen feature",
      "status": "pending"
    },
    {
      "title": "Implement chosen feature using subagent-driven-development",
      "status": "pending"
    }
  ]
}
```

<details><summary>Tool Result: TodoList</summary>

<!-- call_id: tool_nu5t88gy3QGy0j0I6gnLilic -->
Todo list updated.
Current todo list:
  [in_progress] Review backlog and select next epic
  [pending] Set up isolated worktree for chosen feature
  [pending] Implement chosen feature using subagent-driven-development

Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.

</details>

<details><summary>Thinking</summary>

Now present options and ask. Use AskUserQuestion.

</details>

I reviewed the backlog. Here's the current state and my shortlist of next big chunks:

**Backlog health note:** `Project-Scoped Policy Governance` is implemented and passing CI/E2E, but `TODO.md` still lists it as pending. I'll update that once we pick a direction.

**Top candidates:**

| # | Epic | Why now | Plan status |
|---|------|---------|-------------|
| 1 | **`paprika apply -f` CLI** (Recommended) | High P2, builds directly on the governance work we just shipped, has a detailed 2,800-line implementation plan, and is user-facing | Ready: `docs/superpowers/plans/2026-06-13-paprika-apply.md` |
| 2 | **Approval Gates** | High P2, big user-facing feature (manual/webhook/Slack gates between stages) | No plan yet — would need `superpowers:writing-plans` first |
| 3 | **Production scaling: informer-based diff engine** | P0 on `PRODUCTION_ROADMAP.md`, highest scaling impact, pure code change | No plan yet — would need design first |

My recommendation is **#1 `paprika apply -f`** because the plan is ready and it's the fastest path to a shippable, high-impact feature.

Which one should I set up a worktree for and start implementing?

#### Tool Call: AskUserQuestion
<!-- call_id: tool_ddZyvjEa0YtL5hsZNmGapEzT -->
```json
{
  "questions": [
    {
      "question": "Which epic should I pick up next?",
      "options": [
        {
          "label": "`paprika apply -f` CLI (Recommended)",
          "description": "Implement Policy CRD, ApplyBundle API, local rendering, and Bubble Tea TUI using the existing detailed plan."
        },
        {
          "label": "Approval Gates",
          "description": "Design and implement manual/webhook/Slack gates between stages; needs a new plan first."
        },
        {
          "label": "Informer-based diff engine",
          "description": "Tackle the P0 scaling bottleneck; needs design work before implementation."
        }
      ]
    }
  ]
}
```

<details><summary>Tool Result: AskUserQuestion</summary>

<!-- call_id: tool_ddZyvjEa0YtL5hsZNmGapEzT -->
{"answers":{"Which epic should I pick up next?":"`paprika apply -f` CLI (Recommended)"}}

</details>

<details><summary>Thinking</summary>

User selected paprika apply -f CLI. Now we need implement using subagent-driven-development. Required workflow: using-git-worktrees first, then read plan, extract tasks, create TodoWrite, dispatch implementer subagents per task, two-stage review. We also need update TODO.md to mark governance done. But maybe after selecting, we should set up worktree first.

Steps:
1. Use using-git-worktrees skill: check .worktrees exists (yes from directory listing). Verify ignored. Create worktree for branch e.g. `feature/paprika-apply-cli`. Run go mod download. Run baseline tests (make test? maybe unit tests). Need ensure clean. This may take time. We can do in background? The skill requires verifying baseline. We can run `make test` maybe heavy; but necessary. Could run `make test` in worktree. We'll need to set up worktree path `.worktrees/paprika-apply-cli`. Then cd there, go mod download, make lint? Actually baseline tests. Let's do it.

2. Read full plan (2878 lines). Need extract all tasks with full text. That's huge; we can chunk by the plan's chunk headings. The plan is already chunked: Chunk 1: Policy CRD and evaluator, Chunk 2: ApplyBundle API and server handler, Chunk 3: CLI apply command, Chunk 4: Bubble Tea TUI, Chunk 5: UI/Next.js integration, Chunk 6: E2E tests, Chunk 7: Documentation. We need to read entire plan maybe in pieces. We can read full file in chunks. The Read tool cap 1000 lines per call. We can read with line offsets. Or we can let subagents read the plan? Skill says "Make subagent read plan file (provide full text instead)" — we should provide full task text. For a huge plan, providing full text per task is okay if we extract tasks. But the plan has sub-tasks with many steps. We can extract each top-level task (e.g., Task 1.1, 1.2, 2.1 etc.) and pass full text. We need read all. 2878 lines / 1000 = 3 reads. Let's read entire plan into context. Then create TodoWrite list of tasks. Then dispatch implementer subagents one by one. But we should not dispatch multiple implementers in parallel; sequential per task. However we can have multiple reviewer subagents? The skill says fresh subagent per task, and don't dispatch multiple implementation subagents in parallel. Reviews can be sequential. We as controller will manage.

But is it realistic to implement entire paprika apply -f in this session? The plan is huge. Maybe we can set a scope: implement Chunk 1 and 2 (Policy CRD/evaluator + ApplyBundle API) as the first "big chunk". That would be a manageable big chunk. The user said "next big chunks" plural; maybe we can do multiple chunks over time, but within session we can aim for first chunk(s). We should communicate scope. The plan says use subagent-driven-development; tasks are independent within chunks maybe. We can start with Chunk 1.

We need also update TODO.md. Let's do that in main repo after worktree setup? Actually worktree shares same repo; we can update TODO.md in main working tree or in worktree? The worktree is a separate branch; we can commit the TODO update on master or on feature branch? Better to update TODO.md on the feature branch or directly on master? Since it's a minor backlog hygiene, we could do it on the feature branch. But the skill says never start implementation on main/master. The TODO update is not implementation; could be on master. But to avoid switching, we can do it in the worktree after creation. The worktree branch is off current master, so it includes TODO.md. We can edit there. But the worktree branch will be for apply feature; updating TODO there is okay but maybe pollutes feature. However it's fine.

We also need to respect AGENTS.md: use kubebuilder create api for Policy CRD. Good.

Let's start by creating worktree and verifying baseline. Then read plan. Then extract tasks.

Use Bash to create worktree. Need branch name `feature/paprika-apply-cli`. Ensure `.worktrees` is ignored. Check.

</details>

#### Tool Call: Bash (`git check-ignore -q .worktrees && echo "ignored" || echo "NO…`)
<!-- call_id: tool_vS7On6OMForzEhWn8biX4FCd -->
```json
{
  "command": "git check-ignore -q .worktrees && echo \"ignored\" || echo \"NOT ignored\"",
  "timeout": 30
}
```

<details><summary>Tool Result: Bash (`git check-ignore -q .worktrees && echo "ignored" || echo "NO…`)</summary>

<!-- call_id: tool_vS7On6OMForzEhWn8biX4FCd -->
ignored


</details>

<details><summary>Thinking</summary>

Good. Create worktree with new branch. Then run go mod download and make test. Make test could take >60s; maybe run with timeout 300 or background. Let's create worktree and download modules first.

</details>

#### Tool Call: Bash (`git worktree add .worktrees/paprika-apply-cli -b feature/pap…`)
<!-- call_id: tool_WR5ygGl51ooyQWYHaCtrpEKP -->
```json
{
  "command": "git worktree add .worktrees/paprika-apply-cli -b feature/paprika-apply-cli && cd .worktrees/paprika-apply-cli && go mod download",
  "timeout": 120
}
```

<details><summary>Tool Result: Bash (`git worktree add .worktrees/paprika-apply-cli -b feature/pap…`)</summary>

<!-- call_id: tool_WR5ygGl51ooyQWYHaCtrpEKP -->
Preparing worktree (new branch 'feature/paprika-apply-cli')
HEAD is now at 6cf4b59 test(e2e): probe AppProject webhook to confirm reachability before specs


</details>

<details><summary>Thinking</summary>

Now run baseline tests. Since this is heavy, we can run `make test` in background. But the skill says verify clean baseline; we should wait. Use timeout 300.

</details>

#### Tool Call: Bash (`cd .worktrees/paprika-apply-cli && make test`)
<!-- call_id: tool_ZSyXmITeQyvAUPrsUEN1FEgH -->
```json
{
  "command": "cd .worktrees/paprika-apply-cli && make test",
  "timeout": 300
}
```

<details><summary>Tool Result: Bash (`cd .worktrees/paprika-apply-cli && make test`)</summary>

<!-- call_id: tool_ZSyXmITeQyvAUPrsUEN1FEgH -->
<system>ERROR: Tool execution failed.</system>
mkdir -p "/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/bin"
Downloading sigs.k8s.io/controller-tools/cmd/controller-gen@v0.20.1
"/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/bin/controller-gen" rbac:roleName=manager-role crd:allowDangerousTypes=true webhook paths="/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/clusters/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/core/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/featureflags/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/pipelines/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/policy/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/rollouts/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/cmd;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/cmd/cloud-run;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/cmd/paprika;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/agent;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/agent/server;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/agentclient;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/analysis;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/auth;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/events;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/mocks;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/paprika/v1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/paprika/v1/v1connect;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/cache;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/cache/mocks;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-c[...truncated]
Generating protobuf clients...
go tool buf generate
Failure: plugin ui/node_modules/.bin/protoc-gen-es: exec: "ui/node_modules/.bin/protoc-gen-es": stat ui/node_modules/.bin/protoc-gen-es: no such file or directory
plugin ui/node_modules/.bin/protoc-gen-connect-es: exec: "ui/node_modules/.bin/protoc-gen-connect-es": stat ui/node_modules/.bin/protoc-gen-connect-es: no such file or directory
plugin protoc-gen-connect-go: context canceled
plugin protoc-gen-go: context canceled
make: *** [generate-proto] Error 1
Command failed with exit code: 2. Output is truncated to fit in the message.

</details>

<details><summary>Thinking</summary>

Baseline `make test` failed because proto generation requires UI node_modules. We need install UI deps or skip proto? The `make test` likely depends on `generate` which includes generate-proto. We can run unit tests directly with `go test ./...` perhaps after `make manifests`? The baseline should be the actual test command for this project; but if `make test` fails due to missing node_modules, it's a pre-existing issue. We can install UI deps (`cd ui && npm install`) then rerun. That may take time but needed for plan (UI chunk). Let's install UI deps in worktree. Then run make test again. Use background maybe. But we need baseline. Let's do npm install in ui.

</details>

#### Tool Call: Bash (`cd .worktrees/paprika-apply-cli/ui && npm install`)
<!-- call_id: tool_ZYQ3ggHBHuccs86hYFP0F6V1 -->
```json
{
  "command": "cd .worktrees/paprika-apply-cli/ui && npm install",
  "timeout": 300
}
```

<details><summary>Tool Result: Bash (`cd .worktrees/paprika-apply-cli/ui && npm install`)</summary>

<!-- call_id: tool_ZYQ3ggHBHuccs86hYFP0F6V1 -->
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@inquirer/ansi@2.0.7',
npm warn EBADENGINE   required: { node: '>=23.5.0 || ^22.13.0 || ^20.17.0' },
npm warn EBADENGINE   current: { node: 'v22.9.0', npm: '10.8.3' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@inquirer/confirm@6.1.1',
npm warn EBADENGINE   required: { node: '>=23.5.0 || ^22.13.0 || ^20.17.0' },
npm warn EBADENGINE   current: { node: 'v22.9.0', npm: '10.8.3' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@inquirer/core@11.2.1',
npm warn EBADENGINE   required: { node: '>=23.5.0 || ^22.13.0 || ^20.17.0' },
npm warn EBADENGINE   current: { node: 'v22.9.0', npm: '10.8.3' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@inquirer/figures@2.0.7',
npm warn EBADENGINE   required: { node: '>=23.5.0 || ^22.13.0 || ^20.17.0' },
npm warn EBADENGINE   current: { node: 'v22.9.0', npm: '10.8.3' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@inquirer/type@4.0.7',
npm warn EBADENGINE   required: { node: '>=23.5.0 || ^22.13.0 || ^20.17.0' },
npm warn EBADENGINE   current: { node: 'v22.9.0', npm: '10.8.3' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: 'eslint-visitor-keys@5.0.1',
npm warn EBADENGINE   required: { node: '^20.19.0 || ^22.13.0 || >=24' },
npm warn EBADENGINE   current: { node: 'v22.9.0', npm: '10.8.3' }
npm warn EBADENGINE }
npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead

added 812 packages, and audited 813 packages in 13s

360 packages are looking for funding
  run `npm fund` for details

5 vulnerabilities (4 moderate, 1 high)

To address issues that do not require attention, run:
  npm audit fix

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.


</details>

<details><summary>Thinking</summary>

Now run make test again in worktree. This may be long; use background with description? We need result. Let's run foreground with timeout 300 maybe.

</details>

#### Tool Call: Bash (`cd .worktrees/paprika-apply-cli && make test`)
<!-- call_id: tool_ITpnR6NhTTC9Wfwmdaw1gMFN -->
```json
{
  "command": "cd .worktrees/paprika-apply-cli && make test",
  "timeout": 300
}
```

<details><summary>Tool Result: Bash (`cd .worktrees/paprika-apply-cli && make test`)</summary>

<!-- call_id: tool_ITpnR6NhTTC9Wfwmdaw1gMFN -->
"/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/bin/controller-gen" rbac:roleName=manager-role crd:allowDangerousTypes=true webhook paths="/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/clusters/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/core/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/featureflags/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/pipelines/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/policy/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/rollouts/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/cmd;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/cmd/cloud-run;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/cmd/paprika;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/agent;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/agent/server;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/agentclient;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/analysis;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/auth;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/events;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/mocks;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/paprika/v1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/paprika/v1/v1connect;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/cache;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/cache/mocks;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-c[...truncated]
Generating protobuf clients...
go tool buf generate
Downloading go.uber.org/mock/mockgen@v0.6.0
"/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/bin/controller-gen" object:headerFile="hack/boilerplate.go.txt",year=2026 paths="/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/clusters/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/core/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/featureflags/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/pipelines/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/policy/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/rollouts/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/cmd;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/cmd/cloud-run;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/cmd/paprika;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/agent;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/agent/server;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/agentclient;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/analysis;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/auth;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/events;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/mocks;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/paprika/v1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/paprika/v1/v1connect;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/cache;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/cache/mocks;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/interna[...truncated]
PATH="/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/bin:/Users/benebsworth/.local/bin:/Users/benebsworth/.kimi-code/bin:/Users/benebsworth/.opencode/bin:/Users/benebsworth/.antigravity/antigravity/bin:/opt/homebrew/opt/postgresql@17/bin:/Users/benebsworth/.codeium/windsurf/bin:/Users/benebsworth/.nvm/versions/node/v22.9.0/bin:/Users/benebsworth/.bun/bin:/Users/benebsworth/.pyenv/shims:/Users/benebsworth/.pyenv/plugins/pyenv-virtualenv/shims:/Users/benebsworth/.pyenv/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/Users/benebsworth/.local/bin:/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/local/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/appleinternal/bin:/pkg/env/global/bin:/Library/Apple/usr/bin:/Users/benebsworth/.cargo/bin:/Applications/Ghostty.app/Contents/MacOS:/Users/benebsworth/go/bin:/Users/benebsworth/Library/Android/sdk/emulator:/Users/benebsworth/Library/Android/sdk/platform-tools:/Users/benebsworth/Downloads/google-cloud-sdk/bin" go generate ./...
go fmt ./...
go vet ./...
Downloading sigs.k8s.io/controller-runtime/tools/setup-envtest@release-0.23
Setting up envtest binaries for Kubernetes version 1.35...
/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/bin/k8s/1.35.0-darwin-arm64KUBEBUILDER_ASSETS="/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/bin/k8s/1.35.0-darwin-arm64" go test $(go list ./... | grep -v /e2e) -coverprofile cover.out
	github.com/benebsworth/paprika/api/clusters/v1alpha1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/api/core/v1alpha1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/api/featureflags/v1alpha1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/api/pipelines/v1alpha1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/api/policy/v1alpha1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/api/rollouts/v1alpha1		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/cmd	3.833s	coverage: 16.6% of statements
	github.com/benebsworth/paprika/cmd/cloud-run		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/cmd/paprika	4.261s	coverage: 15.6% of statements
ok  	github.com/benebsworth/paprika/internal/agent	2.561s	coverage: [no statements]
	github.com/benebsworth/paprika/internal/agent/server		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/agentclient		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/analysis	1.922s	coverage: 15.7% of statements
ok  	github.com/benebsworth/paprika/internal/api	1.214s	coverage: 28.2% of statements
ok  	github.com/benebsworth/paprika/internal/api/auth	5.435s	coverage: 65.4% of statements
ok  	github.com/benebsworth/paprika/internal/api/events	4.729s	coverage: 54.0% of statements
	github.com/benebsworth/paprika/internal/api/mocks		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/api/paprika/v1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/cache	5.611s	coverage: 34.6% of statements
	github.com/benebsworth/paprika/internal/cache/mocks		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/clock		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/controller/bootstrap		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/controller/clusters	26.404s	coverage: 31.5% of statements
ok  	github.com/benebsworth/paprika/internal/controller/core	26.394s	coverage: 37.8% of statements
ok  	github.com/benebsworth/paprika/internal/controller/pipelines	29.090s	coverage: 48.5% of statements
	github.com/benebsworth/paprika/internal/controller/pipelines/mocks		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/controller/policy	26.372s	coverage: 33.3% of statements
	github.com/benebsworth/paprika/internal/controller/rollouts		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/engine	9.147s	coverage: 41.0% of statements
	github.com/benebsworth/paprika/internal/featureflag		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/featureflag/kubernetes		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/featureflag/openfeature		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/gates	10.473s	coverage: 96.6% of statements
ok  	github.com/benebsworth/paprika/internal/governance	9.194s	coverage: 68.2% of statements
ok  	github.com/benebsworth/paprika/internal/health	8.511s	coverage: 51.7% of statements
ok  	github.com/benebsworth/paprika/internal/metrics	8.606s	coverage: 30.8% of statements
ok  	github.com/benebsworth/paprika/internal/observability	8.780s	coverage: 39.0% of statements
ok  	github.com/benebsworth/paprika/internal/policy	8.844s	coverage: 90.0% of statements
ok  	github.com/benebsworth/paprika/internal/ratelimit	8.831s	coverage: 92.1% of statements
ok  	github.com/benebsworth/paprika/internal/reposerver	5.874s	coverage: 14.7% of statements
ok  	github.com/benebsworth/paprika/internal/reposerverclient	5.593s	coverage: 30.0% of statements
ok  	github.com/benebsworth/paprika/internal/repository	5.527s	coverage: 85.7% of statements
	github.com/benebsworth/paprika/internal/rollout		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/rollout/abtest	5.400s	coverage: 67.5% of statements
ok  	github.com/benebsworth/paprika/internal/rollout/bluegreen	5.748s	coverage: 61.1% of statements
ok  	github.com/benebsworth/paprika/internal/rollout/canary	5.654s	coverage: 51.4% of statements
?   	github.com/benebsworth/paprika/internal/rollout/core	[no test files]
	github.com/benebsworth/paprika/internal/rollout/hash		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/rollout/mirror	5.171s	coverage: 62.2% of statements
ok  	github.com/benebsworth/paprika/internal/rollout/rolling	5.403s	coverage: 75.0% of statements
ok  	github.com/benebsworth/paprika/internal/sharding	4.856s	coverage: 92.9% of statements
ok  	github.com/benebsworth/paprika/internal/source	6.172s	coverage: 30.9% of statements
ok  	github.com/benebsworth/paprika/internal/syncwindow	4.645s	coverage: 96.2% of statements
	github.com/benebsworth/paprika/internal/traffic		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/traffic/gatewayapi	4.942s	coverage: 75.5% of statements
ok  	github.com/benebsworth/paprika/internal/traffic/istio	5.230s	coverage: 74.7% of statements
	github.com/benebsworth/paprika/internal/traffic/mocks		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/webhook/core/v1alpha1	5.194s	coverage: 76.7% of statements
ok  	github.com/benebsworth/paprika/internal/webhook/pipelines/v1alpha1	8.354s	coverage: 88.7% of statements
ok  	github.com/benebsworth/paprika/internal/webhook/policy/v1alpha1	5.468s	coverage: 85.5% of statements
ok  	github.com/benebsworth/paprika/internal/webhook/receiver	3.474s	coverage: 72.0% of statements
	github.com/benebsworth/paprika/internal/webhook/rollouts/v1alpha1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/test/utils		coverage: 0.0% of statements
	github.com/benebsworth/paprika/ui/node_modules/flatted/golang/pkg/flatted		coverage: 0.0% of statements
Command executed successfully. Output is truncated to fit in the message.

</details>

<details><summary>Thinking</summary>

Baseline tests pass. Good. Now we need update TODO.md to mark governance done. Then read plan and extract tasks. Since plan is huge, we need decide scope. We can implement Chunk 1 (Policy CRD/evaluator) and Chunk 2 (ApplyBundle API) as first big chunk, leaving CLI/TUI/UI for later. But the user selected the whole epic; we can say we'll tackle it in chunks, starting with backend platform (Policy + ApplyBundle). That is reasonable. We need read plan. Let's read the full plan in chunks. Use Read line offsets.

</details>

#### Tool Call: Bash (`wc -l .worktrees/paprika-apply-cli/docs/superpowers/plans/20…`)
<!-- call_id: tool_82c2VpfF88VXigaasq9t3YDq -->
```json
{
  "command": "wc -l .worktrees/paprika-apply-cli/docs/superpowers/plans/2026-06-13-paprika-apply.md",
  "timeout": 30
}
```

<details><summary>Tool Result: Bash (`wc -l .worktrees/paprika-apply-cli/docs/superpowers/plans/20…`)</summary>

<!-- call_id: tool_82c2VpfF88VXigaasq9t3YDq -->
    2878 .worktrees/paprika-apply-cli/docs/superpowers/plans/2026-06-13-paprika-apply.md


</details>

<details><summary>Thinking</summary>

Read first 1000 lines.

</details>

#### Tool Call: Read (`.worktrees/paprika-apply-cli/docs/superpowers/plans/2026-06-…`)
<!-- call_id: tool_e12m7Z0262mPSYuxtdlRg9xr -->
```json
{
  "path": ".worktrees/paprika-apply-cli/docs/superpowers/plans/2026-06-13-paprika-apply.md",
  "line_offset": 1,
  "n_lines": 1000
}
```

<details><summary>Tool Result: Read (`.worktrees/paprika-apply-cli/docs/superpowers/plans/2026-06-…`)</summary>

<!-- call_id: tool_e12m7Z0262mPSYuxtdlRg9xr -->
1	# `paprika apply -f` Implementation Plan
2	
3	> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.
4	
5	**Goal:** Implement the `paprika apply -f` command and its supporting platform features: a `Policy` CRD, an `ApplyBundle` API, inline Application/Release source types, and a Bubble Tea TUI for watching rollouts.
6	
7	**Architecture:** The CLI renders manifests locally and submits them via `ApplyBundle`. The API server evaluates policies, creates an Application/Stage/Release, and stores a snapshot ConfigMap. The existing controllers apply the snapshot and monitor health. A new `policy` package provides CEL-based policy evaluation.
8	
9	**Tech Stack:** Go 1.26, Kubebuilder, controller-runtime, cel-go, Connect-RPC, Cobra, Bubble Tea, Next.js.
10	
11	---
12	
13	## Chunk 1: Policy CRD and evaluator package
14	
15	This chunk creates the `Policy` CRD, registers it in the scheme, and builds a reusable policy evaluator that can be unit-tested in isolation.
16	
17	### Task 1.1: Scaffold `Policy` CRD
18	
19	**Files:**
20	- Create: `api/policy/v1alpha1/policy_types.go` (via `kubebuilder create api`, then edited)
21	- Create: `api/policy/v1alpha1/groupversion_info.go` (via `kubebuilder create api`)
22	- Create: `api/policy/v1alpha1/zz_generated.deepcopy.go` (via `make generate`)
23	- Modify: `cmd/main.go`
24	- Modify: `PROJECT`
25	
26	> **Convention:** Per `AGENTS.md`, use `kubebuilder create api` to scaffold. Do not hand-write `groupversion_info.go` or `_types.go` from scratch.
27	
28	- [ ] **Step 1: Scaffold the Policy API**
29	
30	```bash
31	kubebuilder create api --group policy --version v1alpha1 --kind Policy --namespaced=false
32	```
33	
34	Expected: `api/policy/v1alpha1/` created with `policy_types.go`, `groupversion_info.go`, `zz_generated.deepcopy.go`, and `config/crd/bases/policy.paprika.io_policies.yaml`.
35	
36	- [ ] **Step 2: Edit `api/policy/v1alpha1/policy_types.go`**
37	
38	Replace the scaffolded `PolicySpec` with:
39	
40	```go
41	type PolicySeverity string
42	const (
43	    PolicySeverityCritical PolicySeverity = "critical"
44	    PolicySeverityWarning  PolicySeverity = "warning"
45	)
46	
47	type PolicyAction string
48	const (
49	    PolicyActionEnforce PolicyAction = "enforce"
50	    PolicyActionWarn    PolicyAction = "warn"
51	)
52	
53	type PolicyMatch struct {
54	    APIGroups     []string              `json:"apiGroups,omitempty"`
55	    Kinds         []string              `json:"kinds,omitempty"`
56	    Namespaces    []string              `json:"namespaces,omitempty"`
57	    LabelSelector *metav1.LabelSelector `json:"labelSelector,omitempty"`
58	}
59	
60	type PolicySpec struct {
61	    Description   string         `json:"description,omitempty"`
62	    // +kubebuilder:validation:Enum=critical;warning
63	    Severity      PolicySeverity `json:"severity"`
64	    // +kubebuilder:validation:Enum=enforce;warn
65	    DefaultAction PolicyAction   `json:"defaultAction,omitempty"`
66	    Match         PolicyMatch    `json:"match"`
67	    Expression    string         `json:"expression"`
68	}
69	
70	type PolicyStatus struct{}
71	```
72	
73	Use the project convention `json:"metadata,omitzero"` for `Policy` and `PolicyList`.
74	
75	Add markers:
76	
77	```go
78	// +kubebuilder:object:root=true
79	// +kubebuilder:resource:scope=Cluster
80	// +kubebuilder:subresource:status
81	// +kubebuilder:printcolumn:name="Severity",type=string,JSONPath=".spec.severity"
82	// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"
83	```
84	
85	- [ ] **Step 3: Register policy scheme in operator mode**
86	
87	Modify `cmd/main.go` to import and register `policyv1alpha1`:
88	
89	```go
90	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
91	```
92	
93	```go
94	utilruntime.Must(policyv1alpha1.AddToScheme(scheme))
95	```
96	
97	- [ ] **Step 4: Register policy scheme in API-only mode**
98	
99	Find `createAPIClient` (or equivalent) in `cmd/main.go` and add:
100	
101	```go
102	utilruntime.Must(policyv1alpha1.AddToScheme(apiScheme))
103	```
104	
105	- [ ] **Step 5: Generate deepcopy and CRDs**
106	
107	Run:
108	```bash
109	make generate
110	make manifests
111	```
112	
113	Expected: `api/policy/v1alpha1/zz_generated.deepcopy.go` and `config/crd/bases/policy.paprika.io_policies.yaml` are created without errors.
114	
115	- [ ] **Step 6: Verify `PROJECT` file**
116	
117	Open `PROJECT` and confirm a new `policy.paprika.io/v1alpha1 Policy` resource entry exists.
118	
119	- [ ] **Step 7: Commit**
120	
121	```bash
122	git add api/policy cmd/main.go config/crd/bases PROJECT
123	git commit -m "feat(policy): add Policy CRD scaffolding"
124	```
125	
126	### Task 1.2: Build the policy evaluator
127	
128	**Files:**
129	- Create: `policy/interfaces.go`
130	- Create: `policy/evaluator.go`
131	- Create: `policy/evaluator_test.go`
132	- Create: `policy/defaults.go`
133	
134	- [ ] **Step 1: Write failing unit test**
135	
136	Create `policy/evaluator_test.go`:
137	
138	```go
139	package policy
140	
141	import (
142	    "context"
143	    "testing"
144	
145	    policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
146	    "github.com/stretchr/testify/require"
147	    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
148	)
149	
150	func TestEvaluator_PassesValidManifest(t *testing.T) {
151	    policies := []policyv1alpha1.Policy{{
152	        ObjectMeta: metav1.ObjectMeta{Name: "no-latest"},
153	        Spec: policyv1alpha1.PolicySpec{
154	            Severity: policyv1alpha1.PolicySeverityCritical,
155	            Match: policyv1alpha1.PolicyMatch{Kinds: []string{"Deployment"}},
156	            Expression: `object.spec.template.spec.containers.all(c, c.image != "latest")`,
157	        },
158	    }}
159	    bundle := []byte(`
160	apiVersion: apps/v1
161	kind: Deployment
162	metadata:
163	  name: nginx
164	spec:
165	  template:
166	    spec:
167	      containers:
168	        - name: nginx
169	          image: nginx:1.25
170	`)
171	    eval := NewEvaluator(policies)
172	    res, err := eval.Evaluate(context.Background(), bundle, EvaluateOptions{})
173	    require.NoError(t, err)
174	    require.True(t, res.Passed)
175	    require.False(t, res.Blocked)
176	}
177	```
178	
179	- [ ] **Step 2: Run the test and confirm it fails**
180	
181	```bash
182	go test ./policy/... -run TestEvaluator_PassesValidManifest -v
183	```
184	
185	Expected: compile or test failure.
186	
187	- [ ] **Step 3: Implement the evaluator**
188	
189	Create `policy/interfaces.go`:
190	
191	```go
192	package policy
193	
194	import (
195	    "context"
196	
197	    policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
198	)
199	
200	type Action string
201	const (
202	    EnforceAction Action = "enforce"
203	    WarnAction    Action = "warn"
204	)
205	
206	type EvaluateOptions struct {
207	    Namespace       string
208	    ApplicationName string
209	    SkipPolicies    []string
210	    PolicyOverrides map[string]Action
211	}
212	
213	type Result struct {
214	    Name     string
215	    Severity string
216	    Action   string
217	    Passed   bool
218	    Message  string
219	}
220	
221	type EvaluationResult struct {
222	    Passed  bool
223	    Results []Result
224	    Blocked bool
225	    Message string
226	}
227	
228	type Evaluator interface {
229	    Evaluate(ctx context.Context, bundle []byte, opts EvaluateOptions) (*EvaluationResult, error)
230	}
231	```
232	
233	Create `policy/defaults.go`:
234	
235	```go
236	package policy
237	
238	import policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
239	
240	func defaultAction(sev policyv1alpha1.PolicySeverity) policyv1alpha1.PolicyAction {
241	    if sev == policyv1alpha1.PolicySeverityWarning {
242	        return policyv1alpha1.PolicyActionWarn
243	    }
244	    return policyv1alpha1.PolicyActionEnforce
245	}
246	```
247	
248	Create `policy/evaluator.go`:
249	
250	```go
251	package policy
252	
253	import (
254	    "context"
255	    "fmt"
256	    "strings"
257	
258	    "github.com/google/cel-go/cel"
259	    "github.com/google/cel-go/common/types/ref"
260	    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
261	    "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
262	    "k8s.io/apimachinery/pkg/labels"
263	    "k8s.io/apimachinery/pkg/util/yaml"
264	
265	    policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
266	)
267	
268	type evaluator struct {
269	    policies []policyv1alpha1.Policy
270	}
271	
272	func NewEvaluator(policies []policyv1alpha1.Policy) Evaluator {
273	    return &evaluator{policies: policies}
274	}
275	
276	func (e *evaluator) Evaluate(ctx context.Context, bundle []byte, opts EvaluateOptions) (*EvaluationResult, error) {
277	    docs := splitYAMLDocuments(bundle)
278	    var results []Result
279	    for _, doc := range docs {
280	        obj := &unstructured.Unstructured{}
281	        if err := yaml.Unmarshal(doc, &obj.Object); err != nil {
282	            return nil, fmt.Errorf("unmarshal manifest: %w", err)
283	        }
284	        if obj.Object == nil {
285	            continue
286	        }
287	        for _, pol := range e.policies {
288	            if skip(opts.SkipPolicies, pol.Name) {
289	                continue
290	            }
291	            if !match(pol.Spec.Match, obj, opts.Namespace) {
292	                continue
293	            }
294	            passed, msg := e.evalPolicy(ctx, pol.Spec.Expression, obj)
295	            action := resolveAction(pol, opts.PolicyOverrides)
296	            results = append(results, Result{
297	                Name:     pol.Name,
298	                Severity: string(pol.Spec.Severity),
299	                Action:   string(action),
300	                Passed:   passed,
301	                Message:  msg,
302	            })
303	        }
304	    }
305	    return aggregate(results), nil
306	}
307	
308	func skip(list []string, name string) bool {
309	    for _, n := range list {
310	        if n == name {
311	            return true
312	        }
313	    }
314	    return false
315	}
316	
317	func resolveAction(pol policyv1alpha1.Policy, overrides map[string]Action) policyv1alpha1.PolicyAction {
318	    if overrides != nil {
319	        if a, ok := overrides[pol.Name]; ok {
320	            return policyv1alpha1.PolicyAction(a)
321	        }
322	    }
323	    if pol.Spec.DefaultAction != "" {
324	        return pol.Spec.DefaultAction
325	    }
326	    return defaultAction(pol.Spec.Severity)
327	}
328	
329	func contains(list []string, val string) bool {
330	    for _, v := range list {
331	        if v == val {
332	            return true
333	        }
334	    }
335	    return false
336	}
337	
338	func matchAPIGroups(groups []string, apiVersion string) bool {
339	    if len(groups) == 0 {
340	        return true
341	    }
342	    group := ""
343	    if i := strings.Index(apiVersion, "/"); i >= 0 {
344	        group = apiVersion[:i]
345	    }
346	    return contains(groups, group)
347	}
348	
349	func match(m policyv1alpha1.PolicyMatch, obj *unstructured.Unstructured, namespace string) bool {
350	    if !matchAPIGroups(m.APIGroups, obj.GetAPIVersion()) {
351	        return false
352	    }
353	    if len(m.Kinds) > 0 && !contains(m.Kinds, obj.GetKind()) {
354	        return false
355	    }
356	    // match.namespaces filters by the resource's own namespace.
357	    if len(m.Namespaces) > 0 && !contains(m.Namespaces, obj.GetNamespace()) {
358	        return false
359	    }
360	    if m.LabelSelector != nil {
361	        selector, err := metav1.LabelSelectorAsSelector(m.LabelSelector)
362	        if err == nil && !selector.Matches(labels.Set(obj.GetLabels())) {
363	            return false
364	        }
365	    }
366	    return true
367	}
368	
369	func splitYAMLDocuments(bundle []byte) [][]byte {
370	    return engine.SplitYAMLDocuments(bundle)
371	}
372	
373	func (e *evaluator) evalPolicy(ctx context.Context, expr string, obj *unstructured.Unstructured) (bool, string) {
374	    env, err := cel.NewEnv(
375	        cel.Variable("object", cel.MapType(cel.StringType, cel.AnyType)),
376	        cel.Variable("kind", cel.StringType),
377	        cel.Variable("apiVersion", cel.StringType),
378	        cel.Variable("name", cel.StringType),
379	        cel.Variable("namespace", cel.StringType),
380	        cel.Variable("labels", cel.MapType(cel.StringType, cel.StringType)),
381	        cel.Variable("annotations", cel.MapType(cel.StringType, cel.StringType)),
382	        cel.Variable("spec", cel.MapType(cel.StringType, cel.AnyType)),
383	    )
384	    if err != nil {
385	        return false, fmt.Sprintf("env error: %v", err)
386	    }
387	    ast, iss := env.Compile(expr)
388	    if iss != nil {
389	        return false, fmt.Sprintf("compile error: %v", iss.Err())
390	    }
391	    prg, err := env.Program(ast)
392	    if err != nil {
393	        return false, fmt.Sprintf("program error: %v", err)
394	    }
395	    labels := obj.GetLabels()
396	    if labels == nil {
397	        labels = map[string]string{}
398	    }
399	    annotations := obj.GetAnnotations()
400	    if annotations == nil {
401	        annotations = map[string]string{}
402	    }
403	    spec, ok := obj.Object["spec"].(map[string]interface{})
404	    if !ok || spec == nil {
405	        spec = map[string]interface{}{}
406	    }
407	    vars := map[string]interface{}{
408	        "object":      obj.Object,
409	        "kind":        obj.GetKind(),
410	        "apiVersion":  obj.GetAPIVersion(),
411	        "name":        obj.GetName(),
412	        "namespace":   obj.GetNamespace(),
413	        "labels":      labels,
414	        "annotations": annotations,
415	        "spec":        spec,
416	    }
417	    out, _, err := prg.Eval(vars)
418	    if err != nil {
419	        return false, fmt.Sprintf("eval error: %v", err)
420	    }
421	    val := out.Value()
422	    if b, ok := val.(bool); ok {
423	        return b, ""
424	    }
425	    return false, "policy did not return boolean"
426	}
427	
428	func aggregate(results []Result) *EvaluationResult {
429	    ev := &EvaluationResult{Passed: true, Results: results}
430	    for _, r := range results {
431	        if !r.Passed && r.Action == string(policyv1alpha1.PolicyActionEnforce) {
432	            ev.Passed = false
433	            ev.Blocked = true
434	            ev.Message = fmt.Sprintf("policy %s failed", r.Name)
435	            return ev
436	        }
437	        if !r.Passed {
438	            ev.Message = fmt.Sprintf("policy %s warned", r.Name)
439	        }
440	    }
441	    return ev
442	}
443	```
444	
445	- [ ] **Step 4: Run tests until they pass**
446	
447	```bash
448	go test ./policy/... -v
449	```
450	
451	Expected: PASS.
452	
453	- [ ] **Step 5: Add comprehensive tests**
454	
455	Add tests covering:
456	- A failing enforce policy blocks.
457	- A warning policy does not block.
458	- `--skip-policy` skips.
459	- `--policy-override` changes action.
460	- `matchAPIGroups` with core group and named group.
461	- `match` with `labelSelector` and `namespaces`.
462	- Empty match matches all resources.
463	
464	- [ ] **Step 6: Commit**
465	
466	```bash
467	git add policy/
468	git commit -m "feat(policy): add CEL policy evaluator"
469	```
470	
471	---
472	
473	## Chunk 2: CRD changes for inline source and policy results
474	
475	This chunk extends the existing `Application` and `Release` CRDs and updates generated code.
476	
477	### Task 2.1: Extend `ApplicationSource`
478	
479	**Files:**
480	- Modify: `api/pipelines/v1alpha1/application_types.go`
481	- Modify: `api/pipelines/v1alpha1/zz_generated.deepcopy.go` (via `make generate`)
482	- Modify: `config/crd/bases/pipelines.paprika.io_applications.yaml` (via `make manifests`)
483	
484	- [ ] **Step 1: Add inline source type**
485	
486	Modify `api/pipelines/v1alpha1/application_types.go`:
487	
488	```go
489	const SourceTypeInline = "inline"
490	
491	type InlineSourceSpec struct {
492	    ConfigMapRef string `json:"configMapRef,omitempty"`
493	}
494	
495	type ApplicationSource struct {
496	    // ... existing fields ...
497	    Inline *InlineSourceSpec `json:"inline,omitempty"`
498	}
499	```
500	
501	Update the enum marker:
502	
503	```go
504	// +kubebuilder:validation:Enum=git;helm;s3;oci;inline
505	```
506	
507	- [ ] **Step 2: Regenerate CRDs**
508	
509	```bash
510	make generate
511	make manifests
512	```
513	
514	Expected: no errors; CRD YAML updated.
515	
516	- [ ] **Step 3: Commit**
517	
518	```bash
519	git add api/pipelines/v1alpha1/application_types.go config/crd/bases/pipelines.paprika.io_applications.yaml
520	git commit -m "feat(api): add inline source type to Application"
521	```
522	
523	### Task 2.2: Extend `Release` with manifest source and policy results
524	
525	**Files:**
526	- Modify: `api/pipelines/v1alpha1/release_types.go`
527	- Modify: `api/pipelines/v1alpha1/zz_generated.deepcopy.go` (via `make generate`)
528	- Modify: `config/crd/bases/pipelines.paprika.io_releases.yaml` (via `make manifests`)
529	
530	- [ ] **Step 1: Add types**
531	
532	Modify `api/pipelines/v1alpha1/release_types.go`:
533	
534	```go
535	type ManifestSource struct {
536	    ConfigMapRef string `json:"configMapRef,omitempty"`
537	}
538	
539	type ReleasePolicyResult struct {
540	    Name     string `json:"name"`
541	    Severity string `json:"severity"`
542	    Action   string `json:"action"`
543	    Passed   bool   `json:"passed"`
544	    Message  string `json:"message,omitempty"`
545	}
546	
547	type ReleaseSpec struct {
548	    // ... existing fields ...
549	    ManifestSource *ManifestSource `json:"manifestSource,omitempty"`
550	}
551	
552	type ReleaseStatus struct {
553	    // ... existing fields ...
554	    PolicyResults []ReleasePolicyResult `json:"policyResults,omitempty"`
555	    RolledBackTo  string                `json:"rolledBackTo,omitempty"`
556	}
557	```
558	
559	- [ ] **Step 2: Regenerate**
560	
561	```bash
562	make generate
563	make manifests
564	```
565	
566	- [ ] **Step 3: Commit**
567	
568	```bash
569	git add api/pipelines/v1alpha1/release_types.go config/crd/bases/pipelines.paprika.io_releases.yaml
570	git commit -m "feat(api): add manifest source and policy results to Release"
571	```
572	
573	---
574	
575	## Chunk 3: Protobuf and API server
576	
577	This chunk adds the `ApplyBundle` RPC, regenerates protobuf code, and implements the handler.
578	
579	### Task 3.1: Update protobuf schema
580	
581	**Files:**
582	- Modify: `proto/paprika/v1/api.proto`
583	- Modify: generated `internal/api/paprika/v1/api.pb.go`
584	- Modify: generated `internal/api/paprika/v1/v1connect/api.connect.go`
585	
586	- [ ] **Step 1: Edit `proto/paprika/v1/api.proto`**
587	
588	Add:
589	
590	```protobuf
591	message ApplyBundleRequest {
592	  string namespace = 1;
593	  string name = 2;
594	  bytes manifests = 3;
595	  repeated string skip_policies = 4;
596	  map<string, string> policy_overrides = 5;
597	  bool dry_run = 6;
598	}
599	
600	message ApplyBundleResponse {
601	  Application application = 1;
602	  Release release = 2;
603	  repeated PolicyResult policy_results = 3;
604	  bool blocked = 4;
605	  string block_reason = 5;
606	}
607	
608	message PolicyResult {
609	  string name = 1;
610	  string severity = 2;
611	  string action = 3;
612	  bool passed = 4;
613	  string message = 5;
614	}
615	
616	message InlineSource {
617	  string config_map_ref = 1;
618	}
619	
620	message ManifestSource {
621	  string config_map_ref = 1;
622	}
623	
624	// Extend ApplicationSource
625	message ApplicationSource {
626	  // existing fields 1-11
627	  InlineSource inline = 12;
628	}
629	
630	// Extend Release
631	message Release {
632	  // existing fields 1-8
633	  ManifestSource manifest_source = 9;
634	  repeated PolicyResult policy_results = 10;
635	  string rolled_back_to = 11;
636	}
637	
638	service PaprikaService {
639	  // existing RPCs
640	  rpc ApplyBundle(ApplyBundleRequest) returns (ApplyBundleResponse);
641	}
642	```
643	
644	- [ ] **Step 2: Regenerate protobuf Go code**
645	
646	The project uses `buf generate`. Run:
647	
648	```bash
649	buf generate
650	```
651	
652	Expected: `internal/api/paprika/v1/api.pb.go` and `internal/api/paprika/v1/v1connect/api.connect.go` updated.
653	
654	- [ ] **Step 3: Commit**
655	
656	```bash
657	git add proto/paprika/v1/api.proto internal/api/paprika/v1/
658	git commit -m "feat(proto): add ApplyBundle RPC and inline/manifest source messages"
659	```
660	
661	### Task 3.2: Implement `ApplyBundle` handler
662	
663	**Files:**
664	- Modify: `internal/api/server.go`
665	- Create: `internal/api/apply_bundle.go`
666	- Modify: `internal/api/server.go` converter functions
667	
668	- [ ] **Step 1: Create `internal/api/apply_bundle.go`**
669	
670	```go
671	package api
672	
673	import (
674	    "context"
675	    "crypto/sha256"
676	    "encoding/hex"
677	    "fmt"
678	    "strconv"
679	    "strings"
680	    "time"
681	
682	    "connectrpc.com/connect"
683	    corev1 "k8s.io/api/core/v1"
684	    apierrors "k8s.io/apimachinery/pkg/api/errors"
685	    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
686	    "k8s.io/apimachinery/pkg/types"
687	    "k8s.io/apimachinery/pkg/util/yaml"
688	    "sigs.k8s.io/controller-runtime/pkg/client"
689	
690	    policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
691	    paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
692	    "github.com/benebsworth/paprika/policy"
693	    paprikarpc "github.com/benebsworth/paprika/internal/api/paprika/v1"
694	)
695	
696	type ApplyBundleHandler struct {
697	    client.Client
698	}
699	
700	func (h *ApplyBundleHandler) Handle(ctx context.Context, req *connect.Request[paprikarpc.ApplyBundleRequest]) (*connect.Response[paprikarpc.ApplyBundleResponse], error) {
701	    ns := req.Msg.Namespace
702	    if ns == "" {
703	        return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("namespace is required"))
704	    }
705	    appName := req.Msg.Name
706	    if appName == "" {
707	        appName = deriveAppName(req.Msg.Manifests)
708	    }
709	
710	    // Ensure namespace exists
711	    if err := h.ensureNamespace(ctx, ns); err != nil {
712	        return nil, fmt.Errorf("ensure namespace: %w", err)
713	    }
714	
715	    // Load and evaluate policies
716	    var policyList policyv1alpha1.PolicyList
717	    if err := h.List(ctx, &policyList); err != nil {
718	        return nil, fmt.Errorf("list policies: %w", err)
719	    }
720	    eval := policy.NewEvaluator(policyList.Items)
721	    evalRes, err := eval.Evaluate(ctx, req.Msg.Manifests, policy.EvaluateOptions{
722	        Namespace:       ns,
723	        ApplicationName: appName,
724	        SkipPolicies:    req.Msg.SkipPolicies,
725	        PolicyOverrides: convertOverrides(req.Msg.PolicyOverrides),
726	    })
727	    if err != nil {
728	        return nil, fmt.Errorf("evaluate policies: %w", err)
729	    }
730	    if evalRes.Blocked {
731	        return connect.NewResponse(&paprikarpc.ApplyBundleResponse{
732	            Blocked:       true,
733	            BlockReason:   evalRes.Message,
734	            PolicyResults: convertPolicyResults(evalRes.Results),
735	        }), nil
736	    }
737	    if req.Msg.DryRun {
738	        return connect.NewResponse(&paprikarpc.ApplyBundleResponse{
739	            PolicyResults: convertPolicyResults(evalRes.Results),
740	        }), nil
741	    }
742	
743	    fullHash := sha256.Sum256(req.Msg.Manifests)
744	    shortHash := hex.EncodeToString(fullHash[:])[:7]
745	    hashStr := hex.EncodeToString(fullHash[:])
746	
747	    // Idempotency: if the active Release is Complete and has the same manifest hash, return it.
748	    var existingApp paprikav1.Application
749	    if err := h.Get(ctx, types.NamespacedName{Name: appName, Namespace: ns}, &existingApp); err == nil && existingApp.Status.ReleaseRef != "" {
750	        var active paprikav1.Release
751	        if err := h.Get(ctx, types.NamespacedName{Name: existingApp.Status.ReleaseRef, Namespace: ns}, &active); err == nil {
752	            if active.Annotations["paprika.io/manifest-sha"] == hashStr && active.Status.Phase == paprikav1.ReleaseComplete {
753	                return connect.NewResponse(&paprikarpc.ApplyBundleResponse{
754	                    Application:   convertApplication(&existingApp),
755	                    Release:       convertRelease(&active),
756	                    PolicyResults: convertPolicyResults(evalRes.Results),
757	                }), nil
758	            }
759	        }
760	    }
761	
762	    ts := strconv.FormatInt(time.Now().Unix(), 10)
763	
764	    // Optimistic-lock loop
765	    const maxRetries = 5
766	    var orphanRelease, orphanCM string
767	    for attempt := 0; attempt < maxRetries; attempt++ {
768	        if orphanRelease != "" {
769	            _ = h.Delete(ctx, &paprikav1.Release{ObjectMeta: metav1.ObjectMeta{Name: orphanRelease, Namespace: ns}})
770	            _ = h.Delete(ctx, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: orphanCM, Namespace: ns}})
771	            orphanRelease = ""
772	            orphanCM = ""
773	        }
774	
775	        releaseName := fmt.Sprintf("%s-release-%s-%s-%d", appName, shortHash, ts, attempt)
776	        cmName := fmt.Sprintf("%s-manifests-%s-%s-%d", appName, shortHash, ts, attempt)
777	
778	        app, err := h.ensureApplication(ctx, ns, appName, cmName)
779	        if err != nil {
780	            return nil, fmt.Errorf("ensure application: %w", err)
781	        }
782	        oldReleaseRef := app.Status.ReleaseRef
783	
784	        // Refuse concurrent applies while a previous Release is still active.
785	        if oldReleaseRef != "" {
786	            var old paprikav1.Release
787	            if err := h.Get(ctx, types.NamespacedName{Name: oldReleaseRef, Namespace: ns}, &old); err == nil {
788	                if !isReleaseTerminal(&old) {
789	                    return nil, connect.NewError(connect.CodeAborted, fmt.Errorf("previous release %s is still %s; wait for it to finish before re-applying", old.Name, old.Status.Phase))
790	                }
791	            }
792	        }
793	
794	        original := app.DeepCopy()
795	        app.Spec.Source.Type = paprikav1.SourceTypeInline
796	        app.Spec.Source.Inline = &paprikav1.InlineSourceSpec{ConfigMapRef: cmName}
797	        if len(app.Spec.Stages) == 0 {
798	            app.Spec.Stages = []paprikav1.ApplicationPromotionStage{{Name: "default", Ring: 1}}
799	        }
800	
801	        patch := client.MergeFromWithOptions(original, client.MergeFromWithOptimisticLock{})
802	        if err := h.Patch(ctx, app, patch); err != nil {
803	            if apierrors.IsConflict(err) {
804	                continue
805	            }
806	            return nil, fmt.Errorf("patch application spec: %w", err)
807	        }
808	
809	        stageName := fmt.Sprintf("%s-default", appName)
810	        stage, err := h.ensureStage(ctx, app, stageName)
811	        if err != nil {
812	            return nil, fmt.Errorf("ensure stage: %w", err)
813	        }
814	
815	        release := buildRelease(app, stage, releaseName, cmName, fullHash, evalRes.Results)
816	        if err := h.Create(ctx, release); err != nil {
817	            return nil, fmt.Errorf("create release: %w", err)
818	        }
819	
820	        labeled := injectLabels(req.Msg.Manifests, appName, releaseName)
821	        cm := buildSnapshotConfigMap(release, appName, cmName, labeled)
822	        if err := h.Create(ctx, cm); err != nil {
823	            _ = h.Delete(ctx, release)
824	            return nil, fmt.Errorf("create snapshot configmap: %w", err)
825	        }
826	
827	        statusOriginal := app.DeepCopy()
828	        app.Status.ReleaseRef = releaseName
829	        statusPatch := client.MergeFromWithOptions(statusOriginal, client.MergeFromWithOptimisticLock{})
830	        if err := h.Status().Patch(ctx, app, statusPatch); err != nil {
831	            if apierrors.IsConflict(err) {
832	                orphanRelease = releaseName
833	                orphanCM = cmName
834	                continue
835	            }
836	            _ = h.Delete(ctx, &paprikav1.Release{ObjectMeta: metav1.ObjectMeta{Name: releaseName, Namespace: ns}})
837	            _ = h.Delete(ctx, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: cmName, Namespace: ns}})
838	            return nil, fmt.Errorf("patch application status: %w", err)
839	        }
840	
841	        // Supersede previous terminal release
842	        if oldReleaseRef != "" {
843	            _ = h.supersedeRelease(ctx, ns, oldReleaseRef)
844	        }
845	
846	        return connect.NewResponse(&paprikarpc.ApplyBundleResponse{
847	            Application:   convertApplication(app),
848	            Release:       convertRelease(release),
849	            PolicyResults: convertPolicyResults(evalRes.Results),
850	        }), nil
851	    }
852	
853	    return nil, connect.NewError(connect.CodeAborted, fmt.Errorf("apply bundle conflict after %d retries", maxRetries))
854	}
855	
856	func buildRelease(app *paprikav1.Application, stage *paprikav1.Stage, releaseName, cmName string, fullHash [32]byte, results []policy.Result) *paprikav1.Release {
857	    return &paprikav1.Release{
858	        ObjectMeta: metav1.ObjectMeta{
859	            Name:      releaseName,
860	            Namespace: app.Namespace,
861	            Labels: map[string]string{
862	                "app.paprika.io/managed-by": "paprika",
863	                "app.paprika.io/name":       app.Name,
864	                "app.paprika.io/release":    releaseName,
865	                "app.paprika.io/history":    "true",
866	            },
867	            OwnerReferences: []metav1.OwnerReference{{
868	                APIVersion: paprikav1.GroupVersion.String(),
869	                Kind:       "Application",
870	                Name:       app.Name,
871	                UID:        app.UID,
872	                Controller: boolPtr(true),
873	            }},
874	            Annotations: map[string]string{
875	                "paprika.io/manifest-sha": hex.EncodeToString(fullHash[:]),
876	            },
877	        },
878	        Spec: paprikav1.ReleaseSpec{
879	            Target:         stage.Name,
880	            ManifestSource: &paprikav1.ManifestSource{ConfigMapRef: cmName},
881	            OnFailure:      app.Spec.OnFailure,
882	            Verify:         stage.Spec.Gates,
883	        },
884	        Status: paprikav1.ReleaseStatus{
885	            PolicyResults: convertToCRDPolicyResults(results),
886	        },
887	    }
888	}
889	
890	func buildSnapshotConfigMap(release *paprikav1.Release, appName, cmName string, manifests []byte) *corev1.ConfigMap {
891	    return &corev1.ConfigMap{
892	        ObjectMeta: metav1.ObjectMeta{
893	            Name:      cmName,
894	            Namespace: release.Namespace,
895	            Labels: map[string]string{
896	                "app.paprika.io/managed-by": "paprika",
897	                "app.paprika.io/name":       appName,
898	                "app.paprika.io/release":    release.Name,
899	                "app.paprika.io/history":    "true",
900	            },
901	            OwnerReferences: []metav1.OwnerReference{{
902	                APIVersion: paprikav1.GroupVersion.String(),
903	                Kind:       "Release",
904	                Name:       release.Name,
905	                UID:        release.UID,
906	                Controller: boolPtr(true),
907	            }},
908	        },
909	        Data: map[string]string{"manifests.yaml": string(manifests)},
910	    }
911	}
912	
913	func (h *ApplyBundleHandler) supersedeRelease(ctx context.Context, ns, name string) error {
914	    var release paprikav1.Release
915	    if err := h.Get(ctx, types.NamespacedName{Name: name, Namespace: ns}, &release); err != nil {
916	        return err
917	    }
918	    // Only supersede failed/rolled-back releases. Keep the previous Complete release
919	    // available for rollback until the janitor removes it based on history limits.
920	    if release.Status.Phase == paprikav1.ReleaseFailed || release.Status.Phase == paprikav1.ReleaseRolledBack {
921	        release.Status.Phase = paprikav1.ReleaseSuperseded
922	        return h.Status().Update(ctx, &release)
923	    }
924	    return nil
925	}
926	
927	func isReleaseTerminal(r *paprikav1.Release) bool {
928	    switch r.Status.Phase {
929	    case paprikav1.ReleaseComplete, paprikav1.ReleaseFailed, paprikav1.ReleaseRolledBack, paprikav1.ReleaseSuperseded:
930	        return true
931	    }
932	    return false
933	}
934	
935	func deriveAppName(manifests []byte) string {
936	    docs := splitYAMLDocuments(manifests)
937	    for _, doc := range docs {
938	        var obj struct {
939	            Metadata struct {
940	                Name string `json:"name"`
941	            } `json:"metadata"`
942	        }
943	        if err := yaml.Unmarshal(doc, &obj); err == nil && obj.Metadata.Name != "" {
944	            return obj.Metadata.Name
945	        }
946	    }
947	    return "app"
948	}
949	
950	func convertOverrides(in map[string]string) map[string]policy.Action {
951	    out := make(map[string]policy.Action, len(in))
952	    for k, v := range in {
953	        out[k] = policy.Action(v)
954	    }
955	    return out
956	}
957	
958	func convertToCRDPolicyResults(results []policy.Result) []paprikav1.ReleasePolicyResult {
959	    out := make([]paprikav1.ReleasePolicyResult, len(results))
960	    for i, r := range results {
961	        out[i] = paprikav1.ReleasePolicyResult{
962	            Name:     r.Name,
963	            Severity: r.Severity,
964	            Action:   r.Action,
965	            Passed:   r.Passed,
966	            Message:  r.Message,
967	        }
968	    }
969	    return out
970	}
971	
972	func boolPtr(b bool) *bool { return &b }
973	
974	func (h *ApplyBundleHandler) ensureNamespace(ctx context.Context, ns string) error {
975	    var namespace corev1.Namespace
976	    err := h.Get(ctx, types.NamespacedName{Name: ns}, &namespace)
977	    if err == nil {
978	        return nil
979	    }
980	    if !apierrors.IsNotFound(err) {
981	        return err
982	    }
983	    namespace.Name = ns
984	    return h.Create(ctx, &namespace)
985	}
986	
987	func (h *ApplyBundleHandler) ensureApplication(ctx context.Context, ns, name, cmName string) (*paprikav1.Application, error) {
988	    var app paprikav1.Application
989	    err := h.Get(ctx, types.NamespacedName{Name: name, Namespace: ns}, &app)
990	    if err == nil {
991	        return &app, nil
992	    }
993	    if !apierrors.IsNotFound(err) {
994	        return nil, err
995	    }
996	    app = paprikav1.Application{
997	        ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
998	        Spec: paprikav1.ApplicationSpec{
999	            Source: paprikav1.ApplicationSource{
1000	                Type:   paprikav1.SourceTypeInline,
<system>1000 lines read from file starting from line 1. Total lines in file: 2878. Max 1000 lines reached.</system>

</details>

<details><summary>Thinking</summary>

We need read rest of plan.

</details>

#### Tool Call: Read (`.worktrees/paprika-apply-cli/docs/superpowers/plans/2026-06-…`)
<!-- call_id: tool_PdGEiX2CR2pCbzENJprjCMa1 -->
```json
{
  "path": ".worktrees/paprika-apply-cli/docs/superpowers/plans/2026-06-13-paprika-apply.md",
  "line_offset": 1001,
  "n_lines": 1000
}
```

<details><summary>Tool Result: Read (`.worktrees/paprika-apply-cli/docs/superpowers/plans/2026-06-…`)</summary>

<!-- call_id: tool_PdGEiX2CR2pCbzENJprjCMa1 -->
1001	                Inline: &paprikav1.InlineSourceSpec{ConfigMapRef: cmName},
1002	            },
1003	            Stages: []paprikav1.ApplicationPromotionStage{{Name: "default", Ring: 1}},
1004	        },
1005	    }
1006	    if err := h.Create(ctx, &app); err != nil {
1007	        return nil, err
1008	    }
1009	    return &app, nil
1010	}
1011	
1012	func (h *ApplyBundleHandler) ensureStage(ctx context.Context, app *paprikav1.Application, stageName string) (*paprikav1.Stage, error) {
1013	    stage := &paprikav1.Stage{
1014	        ObjectMeta: metav1.ObjectMeta{Name: stageName, Namespace: app.Namespace},
1015	        Spec: paprikav1.StageSpec{
1016	            Name:      "default",
1017	            Ring:      1,
1018	            Templates: []string{},
1019	        },
1020	    }
1021	    if err := ctrl.SetControllerReference(app, stage, h.Scheme()); err != nil {
1022	        return nil, err
1023	    }
1024	    var existing paprikav1.Stage
1025	    if err := h.Get(ctx, types.NamespacedName{Name: stageName, Namespace: app.Namespace}, &existing); err == nil {
1026	        existing.Spec = stage.Spec
1027	        return &existing, h.Update(ctx, &existing)
1028	    } else if apierrors.IsNotFound(err) {
1029	        return stage, h.Create(ctx, stage)
1030	    }
1031	    return nil, err
1032	}
1033	
1034	func injectLabels(manifests []byte, appName, releaseName string) []byte {
1035	    docs := strings.Split(string(manifests), "\n---")
1036	    var out []string
1037	    for _, doc := range docs {
1038	        var obj map[string]interface{}
1039	        if err := yaml.Unmarshal([]byte(doc), &obj); err != nil || obj == nil {
1040	            out = append(out, doc)
1041	            continue
1042	        }
1043	        meta, ok := obj["metadata"].(map[string]interface{})
1044	        if !ok {
1045	            meta = map[string]interface{}{}
1046	            obj["metadata"] = meta
1047	        }
1048	        lbls, ok := meta["labels"].(map[string]interface{})
1049	        if !ok {
1050	            lbls = map[string]interface{}{}
1051	            meta["labels"] = lbls
1052	        }
1053	        lbls["app.paprika.io/managed-by"] = "paprika"
1054	        lbls["app.paprika.io/name"] = appName
1055	        lbls["app.paprika.io/release"] = releaseName
1056	        b, _ := yaml.Marshal(obj)
1057	        out = append(out, string(b))
1058	    }
1059	    return []byte(strings.Join(out, "\n---\n"))
1060	}
1061	```
1062	
1063	- [ ] **Step 2: Wire handler into `PaprikaServer`**
1064	
1065	Modify `internal/api/server.go` to add `ApplyBundle` method that delegates to `ApplyBundleHandler`:
1066	
1067	```go
1068	func (s *PaprikaServer) ApplyBundle(ctx context.Context, req *connect.Request[paprikav1.ApplyBundleRequest]) (*connect.Response[paprikav1.ApplyBundleResponse], error) {
1069	    h := &ApplyBundleHandler{Client: s.client}
1070	    return h.Handle(ctx, req)
1071	}
1072	```
1073	
1074	- [ ] **Step 3: Update converters**
1075	
1076	Add `convertPolicyResults`, update `convertRelease` to map `ManifestSource` and `PolicyResults`, and update `convertApplication` to map `Source.Inline`.
1077	
1078	Example changes in `internal/api/server.go`:
1079	
1080	```go
1081	func convertApplication(a *paprikav1.Application) *paprikav1.Application {
1082	    // ... existing mapping ...
1083	    if a.Spec.Source.Inline != nil {
1084	        out.Source.Inline = &paprikav1.InlineSource{
1085	            ConfigMapRef: a.Spec.Source.Inline.ConfigMapRef,
1086	        }
1087	    }
1088	    return out
1089	}
1090	
1091	func convertRelease(r *paprikav1.Release) *paprikav1.Release {
1092	    // ... existing mapping ...
1093	    if r.Spec.ManifestSource != nil {
1094	        out.ManifestSource = &paprikav1.ManifestSource{
1095	            ConfigMapRef: r.Spec.ManifestSource.ConfigMapRef,
1096	        }
1097	    }
1098	    if len(r.Status.PolicyResults) > 0 {
1099	        out.PolicyResults = convertPolicyResults(r.Status.PolicyResults)
1100	    }
1101	    out.RolledBackTo = r.Status.RolledBackTo
1102	    return out
1103	}
1104	
1105	func convertPolicyResults(in []paprikav1.ReleasePolicyResult) []*paprikav1.PolicyResult {
1106	    out := make([]*paprikav1.PolicyResult, len(in))
1107	    for i, r := range in {
1108	        out[i] = &paprikav1.PolicyResult{
1109	            Name:     r.Name,
1110	            Severity: r.Severity,
1111	            Action:   r.Action,
1112	            Passed:   r.Passed,
1113	            Message:  r.Message,
1114	        }
1115	    }
1116	    return out
1117	}
1118	```
1119	
1120	- [ ] **Step 4: Add RBAC markers to handler file**
1121	
1122	Add the following markers at the top of `internal/api/apply_bundle.go`:
1123	
1124	```go
1125	// +kubebuilder:rbac:groups=policy.paprika.io,resources=policies,verbs=get;list;watch
1126	// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications,verbs=get;list;watch;create;update;patch
1127	// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications/status,verbs=get;update;patch
1128	// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=stages,verbs=get;list;watch;create;update;patch
1129	// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=releases,verbs=get;list;watch;create;update;patch;delete
1130	// +kubebuilder:rbac:groups=core,resources=configmaps,verbs=get;list;watch;create;update;patch;delete
1131	// +kubebuilder:rbac:groups=core,resources=namespaces,verbs=get;list;watch;create
1132	// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch
1133	```
1134	
1135	> **Note:** Add required imports (`ctrl "sigs.k8s.io/controller-runtime"`, `yaml "sigs.k8s.io/yaml"`) and ensure it compiles. Remove the `k8s.io/apimachinery/pkg/util/yaml` import if it conflicts.
1136	
1137	- [x] **Step 5: Add integration tests for `ApplyBundle` handler**
1138	
1139	Create `internal/api/apply_bundle_test.go`:
1140	
1141	```go
1142	package api
1143	
1144	import (
1145	    "context"
1146	    "testing"
1147	
1148	    "connectrpc.com/connect"
1149	    "github.com/stretchr/testify/require"
1150	    corev1 "k8s.io/api/core/v1"
1151	    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
1152	    "k8s.io/apimachinery/pkg/runtime"
1153	    "sigs.k8s.io/controller-runtime/pkg/client/fake"
1154	
1155	    policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
1156	    paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
1157	    paprikarpc "github.com/benebsworth/paprika/internal/api/paprika/v1"
1158	)
1159	
1160	func TestApplyBundle_BlockedByPolicy(t *testing.T) {
1161	    scheme := runtime.NewScheme()
1162	    _ = paprikav1.AddToScheme(scheme)
1163	    _ = policyv1alpha1.AddToScheme(scheme)
1164	    _ = corev1.AddToScheme(scheme)
1165	
1166	    pol := &policyv1alpha1.Policy{
1167	        ObjectMeta: metav1.ObjectMeta{Name: "no-latest"},
1168	        Spec: policyv1alpha1.PolicySpec{
1169	            Severity: policyv1alpha1.PolicySeverityCritical,
1170	            Match:    policyv1alpha1.PolicyMatch{Kinds: []string{"Deployment"}},
1171	            Expression: `object.spec.template.spec.containers.all(c, c.image != "latest")`,
1172	        },
1173	    }
1174	    c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pol).Build()
1175	
1176	    handler := &ApplyBundleHandler{Client: c}
1177	    res, err := handler.Handle(context.Background(), connect.NewRequest(&paprikarpc.ApplyBundleRequest{
1178	        Namespace: "dev",
1179	        Name:      "my-app",
1180	        Manifests: []byte(`apiVersion: apps/v1
1181	kind: Deployment
1182	metadata:
1183	  name: nginx
1184	spec:
1185	  template:
1186	    spec:
1187	      containers:
1188	      - name: nginx
1189	        image: latest
1190	`),
1191	    }))
1192	    require.NoError(t, err)
1193	    require.True(t, res.Msg.Blocked)
1194	}
1195	```
1196	
1197	Add tests for:
1198	- Dry-run returns policy results without creating resources.
1199	- Successful apply creates Application, Stage, Release, and ConfigMap.
1200	- Policy results are persisted in `Release.status.policyResults`.
1201	- Previous terminal Release is marked `Superseded`.
1202	- Re-applying the same manifest returns the existing Complete Release (idempotency).
1203	- Re-applying while the previous Release is non-terminal returns an error.
1204	- Status patch conflict cleans up orphan Release and ConfigMap.
1205	- `deriveAppName` extracts the first manifest name.
1206	- `injectLabels` adds release and managed-by labels.
1207	- `parsePolicyOverrides` rejects invalid actions.
1208	
1209	- [ ] **Step 6: Run tests**
1210	
1211	```bash
1212	go test ./internal/api/... -v
1213	make test
1214	```
1215	
1216	Expected: PASS.
1217	
1218	- [ ] **Step 7: Commit**
1219	
1220	```bash
1221	git add internal/api/
1222	git commit -m "feat(api): implement ApplyBundle handler with tests"
1223	```
1224	
1225	---
1226	
1227	## Chunk 4a: Release controller inline manifest path
1228	
1229	This chunk adapts the Release controller to load manifests from a snapshot ConfigMap for inline sources.
1230	
1231	### Task 4a.1: Release controller inline manifest path
1232	
1233	**Files:**
1234	- Modify: `internal/controller/pipelines/release_controller.go`
1235	- Modify: `internal/controller/pipelines/release_controller_test.go`
1236	
1237	- [ ] **Step 1: Add `loadManifestsFromConfigMap`**
1238	
1239	Add to `internal/controller/pipelines/release_controller.go`:
1240	
1241	```go
1242	func (r *ReleaseReconciler) loadManifestsFromConfigMap(ctx context.Context, release *paprikav1.Release) ([]byte, error) {
1243	    if release.Spec.ManifestSource == nil || release.Spec.ManifestSource.ConfigMapRef == "" {
1244	        return nil, fmt.Errorf("release has no inline manifest source")
1245	    }
1246	    var cm corev1.ConfigMap
1247	    ns := release.Namespace
1248	    key := types.NamespacedName{Name: release.Spec.ManifestSource.ConfigMapRef, Namespace: ns}
1249	    if err := r.Get(ctx, key, &cm); err != nil {
1250	        // Backward compatibility: try operator namespace for snapshots created before this change.
1251	        if r.Namespace != "" && r.Namespace != ns {
1252	            key.Namespace = r.Namespace
1253	            if fallbackErr := r.Get(ctx, key, &cm); fallbackErr == nil {
1254	                return []byte(cm.Data["manifests.yaml"]), nil
1255	            }
1256	        }
1257	        return nil, err
1258	    }
1259	    return []byte(cm.Data["manifests.yaml"]), nil
1260	}
1261	```
1262	
1263	- [ ] **Step 2: Branch `promote()` for inline sources**
1264	
1265	Replace the body of `promote()` with:
1266	
1267	```go
1268	func (r *ReleaseReconciler) promote(ctx context.Context, release *paprikav1.Release) error {
1269	    log := logf.FromContext(ctx)
1270	
1271	    stage, _, err := r.fetchStageAndTemplates(ctx, release)
1272	    if err != nil {
1273	        return err
1274	    }
1275	
1276	    var manifests []byte
1277	    if release.Spec.ManifestSource != nil && release.Spec.ManifestSource.ConfigMapRef != "" {
1278	        manifests, err = r.loadManifestsFromConfigMap(ctx, release)
1279	        if err != nil {
1280	            return fmt.Errorf("load inline manifests: %w", err)
1281	        }
1282	    } else {
1283	        params := r.buildPromoteParams(release)
1284	        templates, tErr := r.fetchStageTemplates(ctx, release, stage)
1285	        if tErr != nil {
1286	            return tErr
1287	        }
1288	        manifests, err = r.TemplateRenderer.RenderAll(ctx, templates, params)
1289	        if err != nil {
1290	            return fmt.Errorf("template rendering failed: %w", err)
1291	        }
1292	    }
1293	
1294	    // Ensure the release label is present for cleanup regardless of source.
1295	    manifests = r.ensureReleaseLabel(manifests, release.Name)
1296	
1297	    snapshotName := stage.Name + "-manifest-snapshot"
1298	    if release.Spec.ManifestSource != nil && release.Spec.ManifestSource.ConfigMapRef != "" {
1299	        // For inline sources, reuse the handler-created snapshot for rollback.
1300	        snapshotName = release.Spec.ManifestSource.ConfigMapRef
1301	    }
1302	    if err = r.storeManifestSnapshot(ctx, release, stage, snapshotName, manifests); err != nil {
1303	        return fmt.Errorf("failed to store manifest snapshot: %w", err)
1304	    }
1305	
1306	    release.Status.RenderedManifestSnapshot = snapshotName
1307	
1308	    if err := r.applyPromotedManifests(ctx, release, stage, manifests); err != nil {
1309	        return err
1310	    }
1311	    log.Info("Applied rendered manifests to cluster", "stage", stage.Name, "bytes", len(manifests))
1312	
1313	    log.Info("Promotion rendered manifests", "stage", stage.Name, "bytes", len(manifests))
1314	    return nil
1315	}
1316	```
1317	
1318	Add helper:
1319	
1320	```go
1321	func (r *ReleaseReconciler) ensureReleaseLabel(manifests []byte, releaseName string) []byte {
1322	    docs := engine.SplitYAMLDocuments(manifests)
1323	    var out []string
1324	    for _, doc := range docs {
1325	        var obj map[string]interface{}
1326	        if err := yaml.Unmarshal(doc, &obj); err != nil || obj == nil {
1327	            out = append(out, string(doc))
1328	            continue
1329	        }
1330	        meta, ok := obj["metadata"].(map[string]interface{})
1331	        if !ok {
1332	            meta = map[string]interface{}{}
1333	            obj["metadata"] = meta
1334	        }
1335	        labels, ok := meta["labels"].(map[string]interface{})
1336	        if !ok {
1337	            labels = map[string]interface{}{}
1338	            meta["labels"] = labels
1339	        }
1340	        labels["app.paprika.io/release"] = releaseName
1341	        labels["app.paprika.io/managed-by"] = engine.ManagedByLabelValue
1342	        b, _ := yaml.Marshal(obj)
1343	        out = append(out, string(b))
1344	    }
1345	    return []byte(strings.Join(out, "\n---\n"))
1346	}
1347	```
1348	
1349	- [ ] **Step 3: Move snapshots to Release namespace**
1350	
1351	Update `storeManifestSnapshot`:
1352	
1353	```go
1354	func (r *ReleaseReconciler) storeManifestSnapshot(ctx context.Context, release *paprikav1.Release, stage *paprikav1.Stage, name string, manifests []byte) error {
1355	    cm := &corev1.ConfigMap{
1356	        ObjectMeta: metav1.ObjectMeta{
1357	            Name:      name,
1358	            Namespace: release.Namespace,
1359	            Labels: map[string]string{
1360	                "paprika.io/stage":    stage.Name,
1361	                "paprika.io/release":  release.Name,
1362	                "app.paprika.io/name": release.Labels["app.paprika.io/name"],
1363	            },
1364	        },
1365	        Data: map[string]string{"manifests.yaml": string(manifests)},
1366	    }
1367	
1368	    existing := &corev1.ConfigMap{}
1369	    if err := r.Get(ctx, types.NamespacedName{Name: name, Namespace: release.Namespace}, existing); err == nil {
1370	        existing.Data = cm.Data
1371	        existing.Labels = cm.Labels
1372	        if err := r.Update(ctx, existing); err != nil {
1373	            return fmt.Errorf("updating manifest snapshot: %w", err)
1374	        }
1375	        return nil
1376	    }
1377	
1378	    if err := r.Create(ctx, cm); err != nil {
1379	        return fmt.Errorf("creating manifest snapshot: %w", err)
1380	    }
1381	    return nil
1382	}
1383	```
1384	
1385	Update `rollback` to read from `release.Namespace` (with backward-compatible fallback to `r.Namespace`):
1386	
1387	```go
1388	var cm corev1.ConfigMap
1389	key := types.NamespacedName{Name: release.Status.RenderedManifestSnapshot, Namespace: release.Namespace}
1390	if err := r.Get(ctx, key, &cm); err != nil {
1391	    if r.Namespace != "" && r.Namespace != release.Namespace {
1392	        key.Namespace = r.Namespace
1393	        if fallbackErr := r.Get(ctx, key, &cm); fallbackErr != nil {
1394	            return fmt.Errorf("failed to fetch manifest snapshot %q: %w", release.Status.RenderedManifestSnapshot, err)
1395	        }
1396	    } else {
1397	        return fmt.Errorf("failed to fetch manifest snapshot %q: %w", release.Status.RenderedManifestSnapshot, err)
1398	    }
1399	}
1400	```
1401	
1402	- [ ] **Step 4: Dynamic cleanup by discovered GVRs**
1403	
1404	Replace `cleanup()` with:
1405	
1406	```go
1407	func (r *ReleaseReconciler) cleanup(ctx context.Context, release *paprikav1.Release) error {
1408	    log := logf.FromContext(ctx)
1409	
1410	    // Delete the snapshot ConfigMap(s) for this release.
1411	    cmName := release.Status.RenderedManifestSnapshot
1412	    if cmName != "" {
1413	        for _, ns := range []string{release.Namespace, r.Namespace} {
1414	            if ns == "" {
1415	                continue
1416	            }
1417	            cm := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: cmName, Namespace: ns}}
1418	            if err := r.Delete(ctx, cm); err != nil && !apierrors.IsNotFound(err) {
1419	                return fmt.Errorf("deleting manifest snapshot ConfigMap: %w", err)
1420	            }
1421	        }
1422	        log.Info("Deleted manifest snapshot ConfigMap", "configmap", cmName)
1423	    }
1424	
1425	    // Load the snapshot to discover which GVRs were managed.
1426	    manifests, err := r.loadSnapshotManifests(ctx, release)
1427	    if err != nil {
1428	        log.Error(err, "Could not load snapshot for cleanup; falling back to known GVRs")
1429	    }
1430	
1431	    var gvrs []schema.GroupVersionResource
1432	    if len(manifests) > 0 {
1433	        gvrs = r.discoverGVRs(manifests)
1434	    } else {
1435	        gvrs = managedGVRs
1436	    }
1437	
1438	    labelSelector := labels.Set{"app.paprika.io/release": release.Name}.String()
1439	    for _, gvr := range gvrs {
1440	        items, err := r.DynamicClient.Resource(gvr).Namespace(release.Namespace).List(ctx, metav1.ListOptions{LabelSelector: labelSelector})
1441	        if err != nil {
1442	            return fmt.Errorf("listing %s: %w", gvr.Resource, err)
1443	        }
1444	        for _, item := range items.Items {
1445	            if err := r.DynamicClient.Resource(gvr).Namespace(release.Namespace).Delete(ctx, item.GetName(), metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
1446	                return fmt.Errorf("deleting %s/%s: %w", gvr.Resource, item.GetName(), err)
1447	            }
1448	            log.Info("Deleted managed resource", "resource", gvr.Resource, "name", item.GetName())
1449	        }
1450	    }
1451	
1452	    return nil
1453	}
1454	
1455	func (r *ReleaseReconciler) loadSnapshotManifests(ctx context.Context, release *paprikav1.Release) ([]byte, error) {
1456	    if release.Status.RenderedManifestSnapshot == "" {
1457	        return nil, nil
1458	    }
1459	    var cm corev1.ConfigMap
1460	    key := types.NamespacedName{Name: release.Status.RenderedManifestSnapshot, Namespace: release.Namespace}
1461	    if err := r.Get(ctx, key, &cm); err != nil {
1462	        if r.Namespace != "" && r.Namespace != release.Namespace {
1463	            key.Namespace = r.Namespace
1464	            if fallbackErr := r.Get(ctx, key, &cm); fallbackErr != nil {
1465	                return nil, err
1466	            }
1467	        } else {
1468	            return nil, err
1469	        }
1470	    }
1471	    return []byte(cm.Data["manifests.yaml"]), nil
1472	}
1473	
1474	func (r *ReleaseReconciler) discoverGVRs(manifests []byte) []schema.GroupVersionResource {
1475	    docs := engine.SplitYAMLDocuments(manifests)
1476	    seen := map[schema.GroupVersionResource]struct{}{}
1477	    for _, doc := range docs {
1478	        var obj struct {
1479	            APIVersion string `json:"apiVersion"`
1480	            Kind       string `json:"kind"`
1481	        }
1482	        if err := yaml.Unmarshal(doc, &obj); err != nil || obj.Kind == "" {
1483	            continue
1484	        }
1485	        gvk := schema.FromAPIVersionAndKind(obj.APIVersion, obj.Kind)
1486	        mapping, err := r.RESTMapper().RESTMapping(gvk.GroupKind(), gvk.Version)
1487	        if err != nil {
1488	            // Fallback to heuristic for known kinds.
1489	            group, version := parseAPIVersion(obj.APIVersion)
1490	            gvr, err := r.gvrFromKind(obj.Kind, group, version)
1491	            if err != nil {
1492	                continue
1493	            }
1494	            seen[gvr] = struct{}{}
1495	            continue
1496	        }
1497	        seen[mapping.Resource] = struct{}{}
1498	    }
1499	    out := make([]schema.GroupVersionResource, 0, len(seen))
1500	    for gvr := range seen {
1501	        out = append(out, gvr)
1502	    }
1503	    return out
1504	}
1505	```
1506	
1507	> **Note:** For full cluster-scoped resource support, update `applyDocument` to query `r.RESTMapper().RESTMapping(...)` and call `dynClient.Resource(gvr)` without `.Namespace(...)` when the mapping indicates a cluster-scoped kind. Phase 1 can rely on the fallback heuristic, which works for namespaced resources.
1508	
1509	- [ ] **Step 5: Add RBAC markers**
1510	
1511	Add to the RBAC markers in `release_controller.go`:
1512	
1513	```go
1514	// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications/status,verbs=get;update;patch
1515	// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch
1516	```
1517	
1518	> **Note:** Inline bundles may contain arbitrary resource kinds. Add explicit RBAC markers for every kind your bundles use (e.g., `batch`/`jobs`, `rbac.authorization.k8s.io`/`clusterroles`). For end-to-end testing with the sample Deployment, the existing `apps/deployments`, `core/services`, and `core/configmaps` permissions are sufficient.
1519	
1520	- [ ] **Step 6: Commit**
1521	
1522	```bash
1523	git add internal/controller/pipelines/release_controller.go
1524	git commit -m "feat(controller): support inline manifest source in Release controller"
1525	```
1526	
1527	## Chunk 4b: Application controller inline source handling
1528	
1529	This chunk adapts the Application controller to skip Template creation, wait for the handler-created Release, and prune old Releases.
1530	
1531	### Task 4b.1: Application controller inline source handling
1532	
1533	**Files:**
1534	- Modify: `internal/controller/pipelines/application_controller.go`
1535	
1536	- [ ] **Step 1: Skip Template creation for inline**
1537	
1538	In `reconcileApp`, wrap `reconcileTemplate`:
1539	
1540	```go
1541	if app.Spec.Source.Type != paprikav1.SourceTypeInline {
1542	    if err := r.reconcileTemplate(ctx, app); err != nil {
1543	        log.Error(err, "Failed to reconcile Template")
1544	        r.updatePhase(ctx, app, paprikav1.ApplicationFailed, "TemplateReconciliationFailed", err.Error())
1545	        return ctrl.Result{}, err
1546	    }
1547	}
1548	```
1549	
1550	- [ ] **Step 2: Empty Templates list in Stage**
1551	
1552	Update `buildStageSpec`:
1553	
1554	```go
1555	templates := []string{templateName}
1556	if app.Spec.Source.Type == paprikav1.SourceTypeInline {
1557	    templates = []string{}
1558	}
1559	
1560	return &paprikav1.Stage{
1561	    // ... metadata ...
1562	    Spec: paprikav1.StageSpec{
1563	        Name:      promotionStage.Name,
1564	        Ring:      promotionStage.Ring,
1565	        Cluster:   promotionStage.Cluster,
1566	        Templates: templates,
1567	        Gates:     promotionStage.Gates,
1568	        Canary:    stageCanary,
1569	    },
1570	}
1571	```
1572	
1573	- [ ] **Step 3: Handle inline diff in `evaluateDiff`**
1574	
1575	Update `evaluateDiff` to load the active Release's snapshot when the source is inline:
1576	
1577	```go
1578	func (r *ApplicationReconciler) evaluateDiff(ctx context.Context, app *paprikav1.Application) {
1579	    log := log.FromContext(ctx)
1580	
1581	    if r.DiffEngine == nil {
1582	        return
1583	    }
1584	
1585	    var manifests []byte
1586	    var err error
1587	
1588	    if app.Spec.Source.Type == paprikav1.SourceTypeInline {
1589	        manifests, err = r.loadActiveReleaseManifests(ctx, app)
1590	        if err != nil {
1591	            log.Error(err, "Failed to load inline manifests for diff")
1592	            return
1593	        }
1594	    } else {
1595	        templateName := app.Name + "-template"
1596	        var tmpl paprikav1.Template
1597	        if err = r.Get(ctx, types.NamespacedName{Name: templateName, Namespace: app.Namespace}, &tmpl); err != nil {
1598	            log.Error(err, "Failed to get template for diff")
1599	            return
1600	        }
1601	
1602	        renderer := r.TemplateRenderer
1603	        if renderer == nil {
1604	            renderer = engine.NewHelmSDKRenderer(r.WorkDir)
1605	        }
1606	        manifests, err = renderer.Render(ctx, &tmpl, app.Spec.Parameters)
1607	        if err != nil {
1608	            log.Error(err, "Failed to render template for diff")
1609	            return
1610	        }
1611	    }
1612	
1613	    docs := engine.SplitYAMLDocuments(manifests)
1614	    var desired []unstructured.Unstructured
1615	    for _, doc := range docs {
1616	        var obj map[string]interface{}
1617	        if uErr := yaml.Unmarshal(doc, &obj); uErr != nil {
1618	            continue
1619	        }
1620	        if obj == nil {
1621	            continue
1622	        }
1623	        u := unstructured.Unstructured{Object: obj}
1624	        desired = append(desired, u)
1625	    }
1626	
1627	    labelSelector := engine.ManagedByAppSelector(app.Name).String()
1628	    result, err := r.DiffEngine.ComputeDiff(ctx, desired, engine.DiffOptions{
1629	        Namespace:       app.Namespace,
1630	        LabelSelector:   labelSelector,
1631	        ApplicationName: app.Name,
1632	    })
1633	    if err != nil {
1634	        log.Error(err, "Failed to compute diff")
1635	        return
1636	    }
1637	
1638	    app.Status.Resources = convertDiffToResourceSyncs(result.ResourceSyncs())
1639	    app.Status.OutOfSync = result.OutOfSyncCount()
1640	    app.Status.PrunedResources = len(result.Deleted)
1641	}
1642	
1643	func (r *ApplicationReconciler) loadActiveReleaseManifests(ctx context.Context, app *paprikav1.Application) ([]byte, error) {
1644	    if app.Status.ReleaseRef == "" {
1645	        return nil, fmt.Errorf("no active release")
1646	    }
1647	    var rel paprikav1.Release
1648	    if err := r.Get(ctx, types.NamespacedName{Name: app.Status.ReleaseRef, Namespace: app.Namespace}, &rel); err != nil {
1649	        return nil, err
1650	    }
1651	    if rel.Spec.ManifestSource == nil || rel.Spec.ManifestSource.ConfigMapRef == "" {
1652	        return nil, fmt.Errorf("active release has no inline manifest source")
1653	    }
1654	    var cm corev1.ConfigMap
1655	    if err := r.Get(ctx, types.NamespacedName{Name: rel.Spec.ManifestSource.ConfigMapRef, Namespace: rel.Namespace}, &cm); err != nil {
1656	        return nil, err
1657	    }
1658	    return []byte(cm.Data["manifests.yaml"]), nil
1659	}
1660	```
1661	
1662	- [ ] **Step 4: Short-circuit `checkSourceChanged`**
1663	
1664	Update `resolveSourceHash`:
1665	
1666	```go
1667	func (r *ApplicationReconciler) resolveSourceHash(ctx context.Context, app *paprikav1.Application) (hash, revision string, err error) {
1668	    if app.Spec.Source.Type == paprikav1.SourceTypeInline {
1669	        return "", "", nil
1670	    }
1671	    if app.Spec.Source.Type == paprikav1.SourceTypeGit || app.Spec.Source.Type == paprikav1.SourceTypeS3 {
1672	        return r.resolveVCSSourceHash(ctx, app)
1673	    }
1674	    hash, err = r.resolveHelmSourceHash(ctx, app)
1675	    if err != nil {
1676	        return "", "", err
1677	    }
1678	    return hash, "", nil
1679	}
1680	```
1681	
1682	- [ ] **Step 5: Guard `reconcileRelease` for inline**
1683	
1684	At the start of `reconcileRelease`:
1685	
1686	```go
1687	if app.Spec.Source.Type == paprikav1.SourceTypeInline && app.Status.ReleaseRef == "" {
1688	    r.updatePhase(ctx, app, paprikav1.ApplicationPending, "AwaitingInlineRelease", "waiting for ApplyBundle to create release")
1689	    return ctrl.Result{RequeueAfter: defaultRequeue}, nil
1690	}
1691	```
1692	
1693	> **Race safety:** `ApplyBundle` writes `Application.status.releaseRef` after creating the Release, which races with the Application controller's status updates. Ensure `patchAppStatus` preserves an existing `releaseRef` from the live object when the in-memory status does not set it, otherwise the controller can overwrite the field and stay stuck in `AwaitingInlineRelease`.
1694	
1695	- [x] **Step 5: Guard `reconcileRelease` for inline**
1696	
1697	- [x] **Step 6: Add snapshot janitor**
1698	
1699	In `reconcileApp`, after handling inline source, add:
1700	
1701	```go
1702	if app.Spec.Source.Type == paprikav1.SourceTypeInline {
1703	    if err := r.pruneOldReleases(ctx, app); err != nil {
1704	        log.Error(err, "Failed to prune old releases")
1705	    }
1706	}
1707	```
1708	
1709	Also add the same call at the top of `handleHealthyPhase` so pruning continues after the Application becomes `Healthy`:
1710	
1711	```go
1712	func (r *ApplicationReconciler) handleHealthyPhase(ctx context.Context, app *paprikav1.Application) (ctrl.Result, error) {
1713	    if app.Spec.Source.Type == paprikav1.SourceTypeInline {
1714	        if err := r.pruneOldReleases(ctx, app); err != nil {
1715	            log.FromContext(ctx).Error(err, "Failed to prune old releases")
1716	        }
1717	    }
1718	    // ... existing polling logic ...
1719	}
1720	```
1721	
1722	Implement `pruneOldReleases`:
1723	
1724	```go
1725	const defaultReleaseHistoryLimit = 10
1726	
1727	func (r *ApplicationReconciler) pruneOldReleases(ctx context.Context, app *paprikav1.Application) error {
1728	    var list paprikav1.ReleaseList
1729	    if err := r.List(ctx, &list, client.InNamespace(app.Namespace), client.MatchingLabels{"app.paprika.io/name": app.Name}); err != nil {
1730	        return err
1731	    }
1732	
1733	    limit := defaultReleaseHistoryLimit
1734	
1735	    var all []*paprikav1.Release
1736	    for i := range list.Items {
1737	        all = append(all, &list.Items[i])
1738	    }
1739	
1740	    // Sort newest first.
1741	    sort.Slice(all, func(i, j int) bool {
1742	        return all[i].CreationTimestamp.After(all[j].CreationTimestamp.Time)
1743	    })
1744	
1745	    keep := map[string]struct{}{}
1746	    // Always protect the active release.
1747	    for _, rel := range all {
1748	        if rel.Name == app.Status.ReleaseRef {
1749	            keep[rel.Name] = struct{}{}
1750	            break
1751	        }
1752	    }
1753	    // Protect the most recent non-superseded release for rollback.
1754	    for _, rel := range all {
1755	        if _, ok := keep[rel.Name]; ok {
1756	            continue
1757	        }
1758	        if rel.Status.Phase != paprikav1.ReleaseSuperseded {
1759	            keep[rel.Name] = struct{}{}
1760	            break
1761	        }
1762	    }
1763	    // Protect up to the history limit (including protected releases).
1764	    kept := 0
1765	    for _, rel := range all {
1766	        if _, ok := keep[rel.Name]; ok {
1767	            kept++
1768	            continue
1769	        }
1770	        if kept < limit {
1771	            keep[rel.Name] = struct{}{}
1772	            kept++
1773	        }
1774	    }
1775	
1776	    deleted := 0
1777	    for _, rel := range all {
1778	        if _, ok := keep[rel.Name]; ok {
1779	            continue
1780	        }
1781	        if err := r.Delete(ctx, rel); err != nil && !apierrors.IsNotFound(err) {
1782	            r.recordEvent(app, corev1.EventTypeWarning, "PruneReleaseFailed", fmt.Sprintf("Failed to prune release %s: %v", rel.Name, err))
1783	            return err
1784	        }
1785	        deleted++
1786	    }
1787	    if deleted > 0 {
1788	        r.recordEvent(app, corev1.EventTypeNormal, "PrunedReleases", fmt.Sprintf("Pruned %d old releases", deleted))
1789	    }
1790	    return nil
1791	}
1792	
1793	func (r *ApplicationReconciler) recordEvent(app *paprikav1.Application, eventType, reason, message string) {
1794	    if r.EventRecorder != nil {
1795	        r.EventRecorder.Event(app, eventType, reason, message)
1796	    }
1797	}
1798	```
1799	
1800	Add `EventRecorder record.EventRecorder` to the `ApplicationReconciler` struct and initialize it in `SetupWithManager` via `mgr.GetEventRecorderFor("application-controller")`.
1801	
1802	- [x] **Step 7: Add imports**
1803	
1804	Ensure `application_controller.go` imports:
1805	
1806	```go
1807	import (
1808	    // ... existing imports ...
1809	    "sort"
1810	
1811	    corev1 "k8s.io/api/core/v1"
1812	    apierrors "k8s.io/apimachinery/pkg/api/errors"
1813	    // ... existing imports ...
1814	)
1815	```
1816	
1817	- [x] **Step 8: Add RBAC markers**
1818	
1819	Add to the RBAC markers in `application_controller.go`:
1820	
1821	```go
1822	// +kubebuilder:rbac:groups=core,resources=configmaps,verbs=get;list;watch
1823	// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch
1824	```
1825	
1826	- [x] **Step 9: Commit**
1827	
1828	```bash
1829	git add internal/controller/pipelines/application_controller.go
1830	git commit -m "feat(controller): handle inline source in Application controller"
1831	```
1832	
1833	## Chunk 4c: True rollback
1834	
1835	This chunk implements rollback to a previous Release's snapshot and snapshot cleanup.
1836	
1837	### Task 4c.1: Implement true rollback
1838	
1839	**Files:**
1840	- Modify: `internal/controller/pipelines/release_controller.go`
1841	
1842	- [x] **Step 1: Find previous Complete Release for same Application**
1843	
1844	```go
1845	func (r *ReleaseReconciler) findRollbackTarget(ctx context.Context, release *paprikav1.Release) (*paprikav1.Release, error) {
1846	    appName := release.Labels["app.paprika.io/name"]
1847	    if appName == "" {
1848	        return nil, fmt.Errorf("release missing app.paprika.io/name label")
1849	    }
1850	
1851	    var list paprikav1.ReleaseList
1852	    if err := r.List(ctx, &list, client.InNamespace(release.Namespace), client.MatchingLabels{"app.paprika.io/name": appName}); err != nil {
1853	        return nil, err
1854	    }
1855	
1856	    isViable := func(r *paprikav1.Release) bool {
1857	        return r.Status.Phase == paprikav1.ReleaseComplete ||
1858	            (r.Status.Phase != paprikav1.ReleaseFailed && r.Status.Phase != paprikav1.ReleaseSuperseded && r.Status.RenderedManifestSnapshot != "")
1859	    }
1860	
1861	    var target *paprikav1.Release
1862	    for i := range list.Items {
1863	        other := &list.Items[i]
1864	        if other.Name == release.Name {
1865	            continue
1866	        }
1867	        if other.Spec.Target != release.Spec.Target {
1868	            continue
1869	        }
1870	        if !isViable(other) {
1871	            continue
1872	        }
1873	        if target == nil || other.CreationTimestamp.After(target.CreationTimestamp.Time) {
1874	            target = other
1875	        }
1876	    }
1877	    return target, nil
1878	}
1879	```
1880	
1881	- [x] **Step 2: Implement rollback execution**
1882	
1883	Replace `handleFailedRollback()`:
1884	
1885	```go
1886	func (r *ReleaseReconciler) handleFailedRollback(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {
1887	    log := logf.FromContext(ctx)
1888	
1889	    target, err := r.findRollbackTarget(ctx, release)
1890	    if err != nil {
1891	        *result = resultError
1892	        return ctrl.Result{}, fmt.Errorf("find rollback target: %w", err)
1893	    }
1894	
1895	    if target == nil || target.Status.RenderedManifestSnapshot == "" {
1896	        log.Info("No rollback target available", "release", release.Name)
1897	        release.Status.Phase = paprikav1.ReleaseRolledBack
1898	        release.Status.Conditions = append(release.Status.Conditions, metav1.Condition{
1899	            Type: "RolledBack", Status: metav1.ConditionTrue,
1900	            LastTransitionTime: metav1.Now(),
1901	            Reason: "NoSnapshot", Message: "No rollback snapshot available",
1902	        })
1903	        if err := r.patchReleaseStatus(ctx, release); err != nil {
1904	            *result = resultError
1905	            return ctrl.Result{}, err
1906	        }
1907	        return ctrl.Result{}, nil
1908	    }
1909	
1910	    var cm corev1.ConfigMap
1911	    key := types.NamespacedName{Name: target.Status.RenderedManifestSnapshot, Namespace: target.Namespace}
1912	    if err := r.Get(ctx, key, &cm); err != nil {
1913	        if r.Namespace != "" && r.Namespace != target.Namespace {
1914	            key.Namespace = r.Namespace
1915	            if fallbackErr := r.Get(ctx, key, &cm); fallbackErr != nil {
1916	                *result = resultError
1917	                return ctrl.Result{}, fmt.Errorf("load rollback snapshot: %w", err)
1918	            }
1919	        } else {
1920	            *result = resultError
1921	            return ctrl.Result{}, fmt.Errorf("load rollback snapshot: %w", err)
1922	        }
1923	    }
1924	
1925	    raw, ok := cm.Data["manifests.yaml"]
1926	    if !ok || strings.TrimSpace(raw) == "" {
1927	        *result = resultError
1928	        return ctrl.Result{}, fmt.Errorf("rollback snapshot %s is empty", cm.Name)
1929	    }
1930	
1931	    stage, _, err := r.fetchStageAndTemplates(ctx, release)
1932	    if err != nil {
1933	        *result = resultError
1934	        return ctrl.Result{}, fmt.Errorf("fetch stage for rollback: %w", err)
1935	    }
1936	
1937	    appName := release.Labels["app.paprika.io/name"]
1938	    if err := r.applyManifestsForCluster(ctx, release.Namespace, &stage.Spec.Cluster, appName, []byte(raw)); err != nil {
1939	        *result = resultError
1940	        return ctrl.Result{}, fmt.Errorf("apply rollback manifests: %w", err)
1941	    }
1942	
1943	    release.Status.Phase = paprikav1.ReleaseRolledBack
1944	    release.Status.RolledBackTo = target.Name
1945	    release.Status.Conditions = append(release.Status.Conditions, metav1.Condition{
1946	        Type: "RolledBack", Status: metav1.ConditionTrue,
1947	        LastTransitionTime: metav1.Now(),
1948	        Reason: "RollbackComplete", Message: fmt.Sprintf("Rolled back to %s", target.Name),
1949	    })
1950	    if err := r.patchReleaseStatus(ctx, release); err != nil {
1951	        *result = resultError
1952	        return ctrl.Result{}, err
1953	    }
1954	
1955	    // Patch Application.status.releaseRef back to the target Release using optimistic locking.
1956	    var app paprikav1.Application
1957	    if err := r.Get(ctx, types.NamespacedName{Name: appName, Namespace: release.Namespace}, &app); err == nil {
1958	        original := app.DeepCopy()
1959	        app.Status.ReleaseRef = target.Name
1960	        patch := client.MergeFromWithOptions(original, client.MergeFromWithOptimisticLock{})
1961	        if err := r.Status().Patch(ctx, &app, patch); err != nil {
1962	            log.Error(err, "Failed to update Application releaseRef after rollback")
1963	        }
1964	    }
1965	
1966	    metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "RolledBack").Inc()
1967	    return ctrl.Result{}, nil
1968	}
1969	```
1970	
1971	- [x] **Step 3: Ensure rollback is reachable**
1972	
1973	Modify `reconcileReleasePhase` in `internal/controller/pipelines/release_controller.go` so that rollback is attempted before the terminal-phase short-circuit:
1974	
1975	```go
1976	func (r *ReleaseReconciler) reconcileReleasePhase(ctx context.Context, req ctrl.Request, release *paprikav1.Release, start time.Time, result *string) (ctrl.Result, error) {
1977	    if r.shouldRollback(release) {
1978	        return r.handleFailedRollback(ctx, release, result)
1979	    }
1980	
1981	    if r.isReleaseTerminal(release) {
1982	        return ctrl.Result{}, nil
1983	    }
1984	
1985	    // ... rest of existing logic ...
1986	}
1987	```
1988	
1989	This ensures a `Failed` Release with `OnFailure: rollback` is rolled back instead of short-circuited.
1990	
1991	- [x] **Step 4: Add unit tests**
1992	
1993	Create `internal/controller/pipelines/release_controller_inline_test.go`:
1994	
1995	```go
1996	package controller
1997	
1998	import (
1999	    "context"
2000	    "testing"
<system>1000 lines read from file starting from line 1001. Total lines in file: 2878. Max 1000 lines reached.</system>

</details>

<details><summary>Thinking</summary>

Read remaining lines 2001-2878.

</details>

#### Tool Call: Read (`.worktrees/paprika-apply-cli/docs/superpowers/plans/2026-06-…`)
<!-- call_id: tool_XwHKMUui3nkamGV8sw07HTRO -->
```json
{
  "path": ".worktrees/paprika-apply-cli/docs/superpowers/plans/2026-06-13-paprika-apply.md",
  "line_offset": 2001,
  "n_lines": 1000
}
```

<details><summary>Tool Result: Read (`.worktrees/paprika-apply-cli/docs/superpowers/plans/2026-06-…`)</summary>

<!-- call_id: tool_XwHKMUui3nkamGV8sw07HTRO -->
2001	
2002	    "github.com/stretchr/testify/require"
2003	    corev1 "k8s.io/api/core/v1"
2004	    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
2005	    "k8s.io/apimachinery/pkg/runtime"
2006	    "sigs.k8s.io/controller-runtime/pkg/client/fake"
2007	
2008	    paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
2009	)
2010	
2011	func TestReleaseReconciler_LoadManifestsFromConfigMap(t *testing.T) {
2012	    scheme := runtime.NewScheme()
2013	    _ = paprikav1.AddToScheme(scheme)
2014	    _ = corev1.AddToScheme(scheme)
2015	
2016	    cm := &corev1.ConfigMap{
2017	        ObjectMeta: metav1.ObjectMeta{Name: "snap", Namespace: "dev"},
2018	        Data:       map[string]string{"manifests.yaml": "apiVersion: v1\nkind: ConfigMap"},
2019	    }
2020	    c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(cm).Build()
2021	    r := &ReleaseReconciler{Client: c}
2022	
2023	    release := &paprikav1.Release{
2024	        ObjectMeta: metav1.ObjectMeta{Name: "rel", Namespace: "dev"},
2025	        Spec: paprikav1.ReleaseSpec{
2026	            ManifestSource: &paprikav1.ManifestSource{ConfigMapRef: "snap"},
2027	        },
2028	    }
2029	    data, err := r.loadManifestsFromConfigMap(context.Background(), release)
2030	    require.NoError(t, err)
2031	    require.Contains(t, string(data), "kind: ConfigMap")
2032	}
2033	```
2034	
2035	- [ ] **Step 4: Add rollback envtest**
2036	
2037	Add integration test in `internal/controller/pipelines/release_controller_test.go` that:
2038	- Creates two Releases for the same Application, one Complete with a snapshot, one Failed.
2039	- Reconciles the Failed Release with `OnFailure: rollback`.
2040	- Asserts the Failed Release becomes `RolledBack` and `Application.status.releaseRef` points to the Complete Release.
2041	
2042	- [ ] **Step 5: Commit**
2043	
2044	```bash
2045	git add internal/controller/pipelines/release_controller.go internal/controller/pipelines/release_controller_test.go internal/controller/pipelines/release_controller_inline_test.go
2046	git commit -m "feat(controller): implement true rollback to previous snapshot"
2047	```
2048	
2049	---
2050	
2051	## Chunk 5: CLI apply command and TUI
2052	
2053	This chunk adds the `paprika apply` command with input detection and a Bubble Tea watch UI.
2054	
2055	### Task 5.1: CLI rendering and input detection
2056	
2057	**Files:**
2058	- Create: `cmd/paprika-cli/apply.go`
2059	- Create: `cmd/paprika-cli/render_input.go`
2060	- Create: `cmd/paprika-cli/render_input_test.go`
2061	
2062	- [ ] **Step 1: Add render helpers**
2063	
2064	Create `cmd/paprika-cli/render_input.go`:
2065	
2066	```go
2067	package main
2068	
2069	import (
2070	    "bytes"
2071	    "context"
2072	    "fmt"
2073	    "os"
2074	    "path/filepath"
2075	    "sort"
2076	    "strings"
2077	
2078	    "github.com/benebsworth/paprika/engine"
2079	)
2080	
2081	type RenderedBundle struct {
2082	    Manifests []byte
2083	    Count     int
2084	}
2085	
2086	func renderInputs(ctx context.Context, paths []string) (*RenderedBundle, error) {
2087	    var parts [][]byte
2088	    for _, p := range paths {
2089	        data, err := renderPath(ctx, p)
2090	        if err != nil {
2091	            return nil, fmt.Errorf("render %s: %w", p, err)
2092	        }
2093	        parts = append(parts, data)
2094	    }
2095	    joined := bytes.Join(parts, []byte("\n---\n"))
2096	    docs := engine.SplitYAMLDocuments(joined)
2097	    count := 0
2098	    for _, d := range docs {
2099	        if strings.TrimSpace(string(d)) != "" {
2100	            count++
2101	        }
2102	    }
2103	    return &RenderedBundle{Manifests: joined, Count: count}, nil
2104	}
2105	
2106	func renderPath(ctx context.Context, p string) ([]byte, error) {
2107	    fi, err := os.Stat(p)
2108	    if err != nil {
2109	        return nil, err
2110	    }
2111	    if fi.IsDir() {
2112	        return renderDir(ctx, p)
2113	    }
2114	    return renderFile(ctx, p)
2115	}
2116	
2117	func renderDir(ctx context.Context, p string) ([]byte, error) {
2118	    if _, err := os.Stat(filepath.Join(p, "kustomization.yaml")); err == nil {
2119	        return nil, fmt.Errorf("kustomize support is Phase 2")
2120	    }
2121	    if _, err := os.Stat(filepath.Join(p, "Chart.yaml")); err == nil {
2122	        return nil, fmt.Errorf("helm chart support is Phase 2")
2123	    }
2124	    entries, err := os.ReadDir(p)
2125	    if err != nil {
2126	        return nil, err
2127	    }
2128	    sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
2129	    var parts [][]byte
2130	    for _, e := range entries {
2131	        if e.IsDir() {
2132	            continue
2133	        }
2134	        name := e.Name()
2135	        if strings.HasSuffix(name, ".yaml") || strings.HasSuffix(name, ".yml") {
2136	            data, err := os.ReadFile(filepath.Join(p, name))
2137	            if err != nil {
2138	                return nil, err
2139	            }
2140	            parts = append(parts, data)
2141	        }
2142	    }
2143	    return bytes.Join(parts, []byte("\n---\n")), nil
2144	}
2145	
2146	func renderFile(ctx context.Context, p string) ([]byte, error) {
2147	    if strings.HasSuffix(p, ".tgz") || strings.HasSuffix(p, ".tar.gz") {
2148	        return nil, fmt.Errorf("helm chart archive support is Phase 2")
2149	    }
2150	    return os.ReadFile(p)
2151	}
2152	```
2153	
2154	- [ ] **Step 2: Add tests**
2155	
2156	Create `cmd/paprika-cli/render_input_test.go` with tests for:
2157	- Single YAML file
2158	- Directory of YAMLs
2159	- Kustomize dir returns Phase 2 error
2160	- Helm chart dir returns Phase 2 error
2161	
2162	- [ ] **Step 3: Run tests**
2163	
2164	```bash
2165	go test ./cmd/paprika-cli/... -run TestRender -v
2166	```
2167	
2168	Expected: PASS.
2169	
2170	- [ ] **Step 4: Commit**
2171	
2172	```bash
2173	git add cmd/paprika-cli/render_input.go cmd/paprika-cli/render_input_test.go
2174	git commit -m "feat(cli): add input rendering for apply command"
2175	```
2176	
2177	### Task 5.2: Add Bubble Tea TUI
2178	
2179	**Files:**
2180	- Create: `cmd/paprika-cli/apply_tui.go`
2181	- Modify: `cmd/paprika-cli/apply.go`
2182	
2183	- [ ] **Step 1: Add Bubble Tea dependency**
2184	
2185	```bash
2186	go get github.com/charmbracelet/bubbletea
2187	go get github.com/charmbracelet/lipgloss
2188	```
2189	
2190	- [ ] **Step 2: Create TUI model**
2191	
2192	Create `cmd/paprika-cli/apply_tui.go`:
2193	
2194	```go
2195	package main
2196	
2197	import (
2198	    "context"
2199	    "fmt"
2200	    "time"
2201	
2202	    "github.com/charmbracelet/bubbletea"
2203	    "connectrpc.com/connect"
2204	
2205	    paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
2206	    "github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
2207	)
2208	
2209	type applyModel struct {
2210	    client        v1connect.PaprikaServiceClient
2211	    name          string
2212	    namespace     string
2213	    timeout       time.Duration
2214	    start         time.Time
2215	    phase         string
2216	    health        string
2217	    resources     []*paprikav1.ResourceHealth
2218	    policyResults []*paprikav1.PolicyResult
2219	    err           error
2220	    done          bool
2221	    lastMessage   string
2222	}
2223	
2224	type tickMsg struct{}
2225	type errMsg struct{ err error }
2226	
2227	func (m applyModel) Init() tea.Cmd {
2228	    return tea.Batch(
2229	        func() tea.Msg { return tickMsg{} },
2230	        tea.Tick(2*time.Second, func(time.Time) tea.Msg { return tickMsg{} }),
2231	    )
2232	}
2233	
2234	func (m applyModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
2235	    switch msg := msg.(type) {
2236	    case tea.KeyMsg:
2237	        if msg.String() == "q" || msg.String() == "ctrl+c" {
2238	            return m, tea.Quit
2239	        }
2240	    case errMsg:
2241	        m.err = msg.err
2242	        m.done = true
2243	        return m, tea.Quit
2244	    case tickMsg:
2245	        if time.Since(m.start) > m.timeout {
2246	            m.err = fmt.Errorf("watch timed out after %s", m.timeout)
2247	            m.done = true
2248	            return m, tea.Quit
2249	        }
2250	        res, err := m.client.GetApplication(context.Background(), connect.NewRequest(&paprikav1.GetApplicationRequest{
2251	            Name: m.name, Namespace: m.namespace,
2252	        }))
2253	        if err != nil {
2254	            return m, func() tea.Msg { return errMsg{err: err} }
2255	        }
2256	        app := res.Msg.Application
2257	        m.phase = app.Phase
2258	        m.health = app.Health
2259	        m.resources = app.ResourceHealth
2260	        if terminalPhase(app.Phase) {
2261	            m.done = true
2262	            if app.Phase == "Healthy" {
2263	                m.lastMessage = fmt.Sprintf("✓ %s is %s", m.name, app.Phase)
2264	            } else {
2265	                m.lastMessage = fmt.Sprintf("✗ %s is %s", m.name, app.Phase)
2266	            }
2267	            return m, tea.Quit
2268	        }
2269	        return m, tea.Tick(2*time.Second, func(time.Time) tea.Msg { return tickMsg{} })
2270	    }
2271	    return m, nil
2272	}
2273	
2274	func (m applyModel) View() string {
2275	    if m.err != nil {
2276	        return fmt.Sprintf("Error: %v\n", m.err)
2277	    }
2278	    s := fmt.Sprintf("Apply: %s/%s\nPhase: %s\nHealth: %s\n", m.namespace, m.name, m.phase, m.health)
2279	    if len(m.policyResults) > 0 {
2280	        s += "\nPolicies:\n"
2281	        for _, r := range m.policyResults {
2282	            status := "passed"
2283	            if !r.Passed {
2284	                status = "failed"
2285	            }
2286	            s += fmt.Sprintf("  [%s/%s] %s: %s\n", r.Severity, r.Action, r.Name, status)
2287	        }
2288	    }
2289	    s += "\nResources:\n"
2290	    for _, r := range m.resources {
2291	        s += fmt.Sprintf("  %s/%s/%s: %s\n", r.Kind, r.Namespace, r.Name, r.Health)
2292	    }
2293	    if m.done {
2294	        s += "\n" + m.lastMessage + "\n"
2295	    }
2296	    return s
2297	}
2298	
2299	func terminalPhase(phase string) bool {
2300	    switch phase {
2301	    case "Healthy", "Degraded", "Failed", "RolledBack":
2302	        return true
2303	    }
2304	    return false
2305	}
2306	```
2307	
2308	- [ ] **Step 3: Create `apply.go` command**
2309	
2310	Create `cmd/paprika-cli/apply.go`:
2311	
2312	```go
2313	package main
2314	
2315	import (
2316	    "context"
2317	    "fmt"
2318	    "io"
2319	    "os"
2320	    "strings"
2321	    "time"
2322	
2323	    "connectrpc.com/connect"
2324	    "github.com/charmbracelet/bubbletea"
2325	    "github.com/mattn/go-isatty"
2326	    "github.com/spf13/cobra"
2327	
2328	    paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
2329	    "github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
2330	)
2331	
2332	func newApplyCmd(clientFn func() (v1connect.PaprikaServiceClient, error), nsFn func() string, output *string) *cobra.Command {
2333	    var (
2334	        files           []string
2335	        appName         string
2336	        skipPolicies    []string
2337	        policyOverrides []string
2338	        dryRun          bool
2339	        wait            bool
2340	        timeout         int
2341	    )
2342	    cmd := &cobra.Command{
2343	        Use:   "apply -f <path> [-f <path> ...]",
2344	        Short: "Apply manifests with Paprika intelligence",
2345	        RunE: func(cmd *cobra.Command, args []string) error {
2346	            ctx := cmd.Context()
2347	            client, err := clientFn()
2348	            if err != nil {
2349	                return err
2350	            }
2351	            bundle, err := renderInputs(ctx, files)
2352	            if err != nil {
2353	                return err
2354	            }
2355	            overrides, err := parsePolicyOverrides(policyOverrides)
2356	            if err != nil {
2357	                return err
2358	            }
2359	            res, err := client.ApplyBundle(ctx, connect.NewRequest(&paprikav1.ApplyBundleRequest{
2360	                Namespace:       nsFn(),
2361	                Name:            appName,
2362	                Manifests:       bundle.Manifests,
2363	                SkipPolicies:    skipPolicies,
2364	                PolicyOverrides: overrides,
2365	                DryRun:          dryRun,
2366	            }))
2367	            if err != nil {
2368	                return fmt.Errorf("apply bundle: %w", err)
2369	            }
2370	            if res.Msg.Blocked {
2371	                printPolicyResults(cmd.OutOrStdout(), res.Msg.PolicyResults)
2372	                return fmt.Errorf("apply blocked: %s", res.Msg.BlockReason)
2373	            }
2374	            if dryRun {
2375	                printPolicyResults(cmd.OutOrStdout(), res.Msg.PolicyResults)
2376	                fmt.Fprintln(cmd.OutOrStdout(), "Dry run complete")
2377	                return nil
2378	            }
2379	            if res.Msg.Application == nil {
2380	                return fmt.Errorf("apply returned no application")
2381	            }
2382	            if !wait {
2383	                return writeApplication(cmd.OutOrStdout(), *output, res.Msg.Application)
2384	            }
2385	            if isatty.IsTerminal(os.Stdout.Fd()) {
2386	                finalModel, err := tea.NewProgram(applyModel{
2387	                    client:        client,
2388	                    name:          res.Msg.Application.Name,
2389	                    namespace:     res.Msg.Application.Namespace,
2390	                    timeout:       time.Duration(timeout) * time.Second,
2391	                    start:         time.Now(),
2392	                    policyResults: res.Msg.PolicyResults,
2393	                }).Run()
2394	                if err != nil {
2395	                    return err
2396	                }
2397	                m := finalModel.(applyModel)
2398	                if m.err != nil {
2399	                    return m.err
2400	                }
2401	                if isFailurePhase(m.phase) {
2402	                    return fmt.Errorf("rollout %s", m.phase)
2403	                }
2404	                return nil
2405	            }
2406	            return watchPlain(cmd.OutOrStdout(), client, res.Msg.Application.Name, res.Msg.Application.Namespace, timeout)
2407	        },
2408	    }
2409	    cmd.Flags().StringArrayVarP(&files, "file", "f", nil, "Manifest file, directory, or archive")
2410	    _ = cmd.MarkFlagRequired("file")
2411	    cmd.Flags().StringVar(&appName, "name", "", "Application name")
2412	    cmd.Flags().StringArrayVar(&skipPolicies, "skip-policy", nil, "Skip a policy")
2413	    cmd.Flags().StringArrayVar(&policyOverrides, "policy-override", nil, "Override policy action")
2414	    cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Render and evaluate policies without applying")
2415	    cmd.Flags().BoolVar(&wait, "wait", true, "Wait for rollout to complete")
2416	    cmd.Flags().IntVar(&timeout, "timeout", 300, "Watch timeout")
2417	    return cmd
2418	}
2419	
2420	func parsePolicyOverrides(in []string) (map[string]string, error) {
2421	    out := make(map[string]string, len(in))
2422	    for _, s := range in {
2423	        parts := strings.SplitN(s, "=", 2)
2424	        if len(parts) != 2 {
2425	            return nil, fmt.Errorf("invalid policy override %q (expected name=action)", s)
2426	        }
2427	        if parts[1] != "enforce" && parts[1] != "warn" {
2428	            return nil, fmt.Errorf("invalid action %q (expected enforce or warn)", parts[1])
2429	        }
2430	        out[parts[0]] = parts[1]
2431	    }
2432	    return out, nil
2433	}
2434	
2435	func printPolicyResults(w io.Writer, results []*paprikav1.PolicyResult) {
2436	    for _, r := range results {
2437	        status := "passed"
2438	        if !r.Passed {
2439	            status = "failed"
2440	        }
2441	        fmt.Fprintf(w, "[%s/%s] %s: %s\n", r.Severity, r.Action, r.Name, status)
2442	        if r.Message != "" {
2443	            fmt.Fprintf(w, "  %s\n", r.Message)
2444	        }
2445	    }
2446	}
2447	
2448	func isFailurePhase(phase string) bool {
2449	    switch phase {
2450	    case "Failed", "Degraded", "RolledBack":
2451	        return true
2452	    }
2453	    return false
2454	}
2455	
2456	func watchPlain(w io.Writer, client v1connect.PaprikaServiceClient, name, namespace string, timeoutSec int) error {
2457	    ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
2458	    defer cancel()
2459	    ticker := time.NewTicker(2 * time.Second)
2460	    defer ticker.Stop()
2461	    var lastPhase string
2462	    for {
2463	        res, err := client.GetApplication(ctx, connect.NewRequest(&paprikav1.GetApplicationRequest{
2464	            Name: name, Namespace: namespace,
2465	        }))
2466	        if err != nil {
2467	            return err
2468	        }
2469	        app := res.Msg.Application
2470	        lastPhase = app.Phase
2471	        fmt.Fprintf(w, "[%s] phase: %s health: %s\n", time.Now().Format(time.RFC3339), app.Phase, app.Health)
2472	        if terminalPhase(app.Phase) {
2473	            if isFailurePhase(app.Phase) {
2474	                return fmt.Errorf("rollout %s", app.Phase)
2475	            }
2476	            return nil
2477	        }
2478	        select {
2479	        case <-ctx.Done():
2480	            return fmt.Errorf("watch timed out (last phase: %s)", lastPhase)
2481	        case <-ticker.C:
2482	        }
2483	    }
2484	}
2485	```
2486	
2487	- [ ] **Step 4: Register command in `main.go`**
2488	
2489	Modify `cmd/paprika-cli/main.go`:
2490	
2491	```go
2492	root.AddCommand(newApplyCmd(clientFn, nsFn, &globalOutput))
2493	```
2494	
2495	- [ ] **Step 5: Add dependency**
2496	
2497	```bash
2498	go get github.com/mattn/go-isatty
2499	go get github.com/charmbracelet/bubbletea
2500	```
2501	
2502	- [ ] **Step 6: Build CLI**
2503	
2504	```bash
2505	make build-cli
2506	```
2507	
2508	Expected: `bin/paprika` builds successfully.
2509	
2510	- [ ] **Step 7: Commit**
2511	
2512	```bash
2513	git add cmd/paprika-cli/apply.go cmd/paprika-cli/apply_tui.go cmd/paprika-cli/main.go go.mod go.sum
2514	git commit -m "feat(cli): add paprika apply command with TUI"
2515	```
2516	
2517	---
2518	
2519	## Chunk 6: UI, RBAC manifests, and final integration
2520	
2521	### Task 6.1: Regenerate RBAC and install manifests
2522	
2523	**Files:**
2524	- Modify: `config/rbac/role.yaml` (via `make manifests`)
2525	- Modify: `dist/install.yaml` (via `make build-installer`)
2526	
2527	- [ ] **Step 1: Regenerate RBAC**
2528	
2529	```bash
2530	make manifests
2531	```
2532	
2533	Expected: `config/rbac/role.yaml` includes new Policy and ConfigMap permissions.
2534	
2535	- [ ] **Step 2: Build installer**
2536	
2537	```bash
2538	make build-installer IMG=ghcr.io/benebsworth/paprika:latest
2539	```
2540	
2541	Expected: `dist/install.yaml` updated.
2542	
2543	- [ ] **Step 3: Commit**
2544	
2545	```bash
2546	git add config/rbac/role.yaml dist/install.yaml
2547	git commit -m "chore(manifests): regenerate RBAC for apply and policies"
2548	```
2549	
2550	### Task 6.2: Dashboard updates
2551	
2552	**Files:**
2553	- Modify: `ui/src/app/dashboard/page.tsx`
2554	- Modify: `ui/src/components/dashboard/application-card.tsx`
2555	- Create: `ui/src/app/dashboard/applications/[name]/page.tsx`
2556	
2557	- [ ] **Step 1: Extend ApplicationCard to show policy results**
2558	
2559	Modify `ui/src/components/dashboard/application-card.tsx` to display:
2560	- Current Release name
2561	- Number of policy warnings
2562	- Rollout phase
2563	
2564	- [x] **Step 2: Add Application detail page**
2565	
2566	Created `ui/src/app/dashboard/application/page.tsx` (query-param route for static export) showing:
2567	- Release history list
2568	- Managed resources table
2569	- Policy results
2570	- Rollback button (Phase 3)
2571	
2572	- [ ] **Step 3: Add UI generate script and regenerate protobuf client**
2573	
2574	Ensure `ui/package.json` has a `generate` script that runs from the project root so it finds `buf.gen.yaml`:
2575	
2576	```json
2577	"scripts": {
2578	  "generate": "cd .. && buf generate"
2579	}
2580	```
2581	
2582	Also ensure the UI protoc plugins are installed:
2583	
2584	```bash
2585	cd ui && npm install -D @bufbuild/protoc-gen-es @connectrpc/protoc-gen-connect-es
2586	```
2587	
2588	Then run:
2589	
2590	```bash
2591	cd ui && npm run generate
2592	```
2593	
2594	- [ ] **Step 4: Commit**
2595	
2596	```bash
2597	git add ui/src/
2598	git commit -m "feat(ui): show apply policy results and release history"
2599	```
2600	
2601	### Task 6.3: Integration and E2E tests
2602	
2603	**Files:**
2604	- Create: `test/e2e/apply_test.go`
2605	- Modify: `internal/api/server_test.go` if exists
2606	
2607	- [x] **Step 1: Add E2E test**
2608	
2609	Create `test/e2e/apply_test.go`:
2610	
2611	```go
2612	package e2e
2613	
2614	import (
2615	    "context"
2616	    "testing"
2617	
2618	    "github.com/stretchr/testify/require"
2619	)
2620	
2621	func TestApplyRawYAML(t *testing.T) {
2622	    // Setup kind cluster, deploy operator
2623	    // Run paprika apply -f testdata/deployment.yaml --name e2e-apply
2624	    // Assert Application/Release created, Deployment healthy
2625	}
2626	```
2627	
2628	- [ ] **Step 2: Run E2E**
2629	
2630	```bash
2631	make test-e2e
2632	```
2633	
2634	Expected: PASS (may take several minutes).
2635	
2636	- [ ] **Step 3: Commit**
2637	
2638	```bash
2639	git add test/e2e/
2640	git commit -m "test(e2e): add apply -f end-to-end test"
2641	```
2642	
2643	### Task 6.4: Final integration check
2644	
2645	- [x] **Step 1: Run full test suite**
2646	
2647	```bash
2648	make test
2649	make lint
2650	make build-cli
2651	```
2652	
2653	Expected: all pass.
2654	
2655	- [x] **Step 2: Update CLI documentation**
2656	
2657	Update `docs/cli.md` with `paprika apply` reference:
2658	- Usage examples for raw YAML, directories, dry-run, and policy overrides.
2659	- Explanation of `--wait`, `--timeout`, and TUI behavior.
2660	
2661	- [x] **Step 3: Update API documentation**
2662	
2663	Update `docs/api.md` with the new `ApplyBundle` RPC:
2664	- Request/response message reference.
2665	- Behavior for blocked, dry-run, and idempotent applies.
2666	- Policy result semantics.
2667	
2668	- [ ] **Step 4: Final commit**
2669	
2670	```bash
2671	git add docs/cli.md docs/api.md
2672	git commit -m "docs(cli,api): document paprika apply and ApplyBundle RPC"
2673	```
2674	
2675	### Task 6.5: Add protobuf generation to Makefile
2676	
2677	**Files:**
2678	- Modify: `Makefile`
2679	
2680	- [ ] **Step 1: Add `buf` and protoc plugin tool definitions**
2681	
2682	Add the tool definitions near the other tool definitions in `Makefile` (e.g., next to `CONTROLLER_GEN`):
2683	
2684	```makefile
2685	BUF ?= $(LOCALBIN)/buf
2686	PROTOC_GEN_GO ?= $(LOCALBIN)/protoc-gen-go
2687	PROTOC_GEN_CONNECT_GO ?= $(LOCALBIN)/protoc-gen-connect-go
2688	
2689	.PHONY: buf
2690	buf: $(BUF) ## Download buf locally if necessary.
2691	$(BUF): $(LOCALBIN)
2692		$(call go-install-tool,$(BUF),github.com/bufbuild/buf/cmd/buf,v1.50.0)
2693	
2694	.PHONY: protoc-gen-go
2695	protoc-gen-go: $(PROTOC_GEN_GO) ## Download protoc-gen-go locally if necessary.
2696	$(PROTOC_GEN_GO): $(LOCALBIN)
2697		$(call go-install-tool,$(PROTOC_GEN_GO),google.golang.org/protobuf/cmd/protoc-gen-go,v1.36.0)
2698	
2699	.PHONY: protoc-gen-connect-go
2700	protoc-gen-connect-go: $(PROTOC_GEN_CONNECT_GO) ## Download protoc-gen-connect-go locally if necessary.
2701	$(PROTOC_GEN_CONNECT_GO): $(LOCALBIN)
2702		$(call go-install-tool,$(PROTOC_GEN_CONNECT_GO),connectrpc.com/connect/cmd/protoc-gen-connect-go,v1.18.0)
2703	```
2704	
2705	> **Note:** For the UI, ensure `protoc-gen-es` and `protoc-gen-connect-es` are installed via `npm install -D @bufbuild/protoc-gen-es @connectrpc/protoc-gen-connect-es` and available on `PATH`, or use `npx` in `ui/package.json`.
2706	
2707	Add the `generate-proto` target near `generate`:
2708	
2709	```makefile
2710	.PHONY: generate-proto
2711	generate-proto: buf protoc-gen-go protoc-gen-connect-go ## Generate Connect-RPC Go code from protobuf definitions.
2712		PATH="$(LOCALBIN):$$PATH" $(BUF) generate
2713	```
2714	
2715	- [ ] **Step 2: Wire proto generation into `generate`**
2716	
2717	Update the `generate` target to depend on `generate-proto`:
2718	
2719	```makefile
2720	.PHONY: generate
2721	generate: generate-proto controller-gen ## Generate code containing DeepCopy, DeepCopyInto, and DeepCopyObject method implementations.
2722		"$(CONTROLLER_GEN)" object:headerFile="hack/boilerplate.go.txt",year=$(YEAR) paths="./..."
2723	```
2724	
2725	- [ ] **Step 3: Commit**
2726	
2727	```bash
2728	git add Makefile
2729	git commit -m "build(make): add generate-proto target"
2730	```
2731	
2732	### Task 6.6: Fix PROJECT file drift
2733	
2734	**Files:**
2735	- Modify: `PROJECT`
2736	
2737	- [x] **Step 1: Correct Application path**
2738	
2739	Open `PROJECT` and ensure the `Application` resource entry uses:
2740	
2741	```yaml
2742	path: github.com/benebsworth/paprika/api/pipelines/v1alpha1
2743	```
2744	
2745	(not `api/v1alpha1`).
2746	
2747	- [ ] **Step 2: Commit**
2748	
2749	```bash
2750	git add PROJECT
2751	git commit -m "chore(project): fix Application API path"
2752	```
2753	
2754	### Task 6.7: Package Policy CRD
2755	
2756	**Files:**
2757	- Modify: `config/crd/kustomization.yaml`
2758	- Modify: `charts/chart/templates/` if generated CRDs are packaged there
2759	
2760	- [x] **Step 1: Add Policy CRD to kustomization**
2761	
2762	After `make manifests`, add `policy.paprika.io_policies.yaml` to `config/crd/kustomization.yaml` under `resources:`.
2763	
2764	- [ ] **Step 2: Verify Helm chart packaging**
2765	
2766	If `charts/chart/templates/` does not include the new Policy CRD, copy or regenerate the Helm chart after CRD generation.
2767	
2768	- [ ] **Step 3: Commit**
2769	
2770	```bash
2771	git add config/crd/kustomization.yaml charts/
2772	git commit -m "chore(manifests): package Policy CRD with kustomize and helm"
2773	```
2774	
2775	---
2776	
2777	## Chunk 7: Validation webhooks
2778	
2779	### Task 7.1: Add Application source validation webhook
2780	
2781	**Files:**
2782	- Modify: `internal/webhook/pipelines/v1alpha1/application_webhook.go`
2783	- Modify: `internal/api/server.go` if necessary
2784	
2785	- [x] **Step 1: Validate inline source consistency**
2786	
2787	Modify `validateSource` in `internal/webhook/pipelines/v1alpha1/application_webhook.go`:
2788	
2789	```go
2790	func (v *ApplicationCustomValidator) validateSource(app *pipelinesv1alpha1.Application) field.ErrorList {
2791	    var allErrs field.ErrorList
2792	    sourcePath := field.NewPath("spec").Child("source")
2793	
2794	    if app.Spec.Source.Type == "" {
2795	        allErrs = append(allErrs, field.Required(sourcePath.Child("type"), "Source type is required"))
2796	        return allErrs
2797	    }
2798	
2799	    switch app.Spec.Source.Type {
2800	    case pipelinesv1alpha1.SourceTypeInline:
2801	        if app.Spec.Source.Inline == nil || app.Spec.Source.Inline.ConfigMapRef == "" {
2802	            allErrs = append(allErrs, field.Required(sourcePath.Child("inline").Child("configMapRef"), "configMapRef is required for inline source"))
2803	        }
2804	    case pipelinesv1alpha1.SourceTypeGit:
2805	        if app.Spec.Source.RepoURL == "" {
2806	            allErrs = append(allErrs, field.Required(sourcePath.Child("repoUrl"), "Repo URL is required for git sources"))
2807	        }
2808	    case pipelinesv1alpha1.SourceTypeOCI:
2809	        if app.Spec.Source.Image == "" {
2810	            allErrs = append(allErrs, field.Required(sourcePath.Child("image"), "Image is required for oci sources"))
2811	        }
2812	    }
2813	    return allErrs
2814	}
2815	```
2816	
2817	- [x] **Step 2: Skip repo authorization for inline sources**
2818	
2819	Update `validateApplication`:
2820	
2821	```go
2822	func (v *ApplicationCustomValidator) validateApplication(ctx context.Context, app *pipelinesv1alpha1.Application) error {
2823	    allErrs := v.validateSource(app)
2824	
2825	    if len(app.Spec.Stages) == 0 {
2826	        allErrs = append(allErrs, field.Required(field.NewPath("spec").Child("stages"), "At least one stage is required"))
2827	    }
2828	
2829	    if app.Spec.Project != "" && v.enforcer != nil && app.Spec.Source.Type != pipelinesv1alpha1.SourceTypeInline {
2830	        if err := v.enforcer.AuthorizeApplication(ctx, app.Namespace, app.Spec.Project, app.Spec.Source.RepoURL, app.Spec.Source.RepoRef, ""); err != nil {
2831	            allErrs = append(allErrs, field.Forbidden(field.NewPath("spec").Child("project"), err.Error()))
2832	        }
2833	        stageErrs := v.enforcer.AuthorizeDestinations(ctx, app.Namespace, app.Spec.Project, app.Spec.Stages)
2834	        allErrs = append(allErrs, stageErrs...)
2835	    }
2836	
2837	    if len(allErrs) == 0 {
2838	        return nil
2839	    }
2840	    return apierrors.NewInvalid(
2841	        schema.GroupKind{Group: "pipelines.paprika.io", Kind: "Application"},
2842	        app.Name,
2843	        allErrs,
2844	    )
2845	}
2846	```
2847	
2848	- [x] **Step 3: Add webhook tests**
2849	
2850	Add table-driven tests in `internal/webhook/pipelines/v1alpha1/application_webhook_test.go`:
2851	- Inline source without `configMapRef` is rejected.
2852	- Inline source with `configMapRef` is accepted.
2853	- Inline source with a project does not require repo authorization.
2854	
2855	- [ ] **Step 4: Run webhook tests**
2856	
2857	```bash
2858	go test ./internal/webhook/... -v
2859	```
2860	
2861	Expected: PASS.
2862	
2863	- [ ] **Step 5: Commit**
2864	
2865	```bash
2866	git add internal/webhook/
2867	git commit -m "feat(webhook): validate Application inline source"
2868	```
2869	
2870	---
2871	
2872	## Execution Notes
2873	
2874	- Follow TDD: write a failing test before each production change.
2875	- Keep commits small and focused (one concern per commit).
2876	- Run `make lint` and `make test` before each commit.
2877	- If a task grows beyond 2-5 minutes, split it into smaller steps.
2878	- Coordinate with @superpowers:subagent-driven-development for parallel execution of independent chunks.
<system>878 lines read from file starting from line 2001. Total lines in file: 2878. End of file reached.</system>

</details>

<details><summary>Thinking</summary>

We have read full plan. Need update todo: mark review done, worktree setup done, then start implementation. But implementation of entire plan is huge. We can update todo to reflect actual tasks from plan. Better to create a detailed todo list of chunks. The skill says create TodoWrite with all tasks. We should create todos for each chunk/task. We can also update TODO.md to mark governance done. Let's do that first.

The plan has tasks with some already checked (x) in doc (maybe already done in prior work? The x's are inside plan; maybe they were completed previously? We need verify. Some tasks in chunk 4b/4c/6/7 are checked. We should not redo them. But as controller, we need extract tasks with unchecked boxes as remaining. However the checked boxes in the plan might be inaccurate relative to current code. We need assess. But for now, treat unchecked steps as remaining. There are many. We can group into manageable implementation phases. Since this is huge, we should perhaps aim to implement Chunks 1-3 and 4a in this session, leaving CLI/UI/E2E for next. That would be a "big chunk". The user said "next big chunks" maybe expect multiple. But we should set expectations. We'll say: "The full plan is 7 chunks. I'll tackle the platform/backend chunks first (Policy CRD, ApplyBundle API, Release controller inline path) so the CLI/UI have something to call. Then we can do CLI/UI in the next chunk." But the user may want all. We can start with chunk 1 and iterate.

We need update TODO.md first. Let's edit it in worktree? The worktree shares repo; we can edit `.worktrees/paprika-apply-cli/TODO.md` and commit. But the feature branch will include this change. Fine. Use Edit.

Find the line for Project-Scoped Policy Governance and mark done. Also maybe move to Implemented. We'll modify.

</details>

#### Tool Call: Edit (`.worktrees/paprika-apply-cli/TODO.md`)
<!-- call_id: tool_93nzXaSh4DR0ohW61iAJAmK6 -->
```json
{
  "path": ".worktrees/paprika-apply-cli/TODO.md",
  "old_string": "- [x] Self-healing (auto-sync on drift, auto-revert on health failure)\n- [x] Feature flags (`FeatureFlag` / `FeatureFlagBinding` CRDs + OpenFeature bridge)\n\n## P2 — Planned Next",
  "new_string": "- [x] Self-healing (auto-sync on drift, auto-revert on health failure)\n- [x] Feature flags (`FeatureFlag` / `FeatureFlagBinding` CRDs + OpenFeature bridge)\n- [x] Project-Scoped Policy Governance — enforce `AppProject` boundaries and `Policy` rules in webhooks, controllers, and API; scope authorization by project\n\n## P2 — Planned Next"
}
```

<details><summary>Tool Result: Edit (`.worktrees/paprika-apply-cli/TODO.md`)</summary>

<!-- call_id: tool_93nzXaSh4DR0ohW61iAJAmK6 -->
Replaced 1 occurrence in .worktrees/paprika-apply-cli/TODO.md

</details>

<details><summary>Thinking</summary>

Now remove the duplicate P2 entry.

</details>

#### Tool Call: Edit (`.worktrees/paprika-apply-cli/TODO.md`)
<!-- call_id: tool_vUqy0lMIg3ggTyxW4VPtEgep -->
```json
{
  "path": ".worktrees/paprika-apply-cli/TODO.md",
  "old_string": "- [ ] **Project-Scoped Policy Governance** — enforce `AppProject` boundaries and `Policy` rules in webhooks, controllers, and API; scope authorization by project\n  - Priority: high\n  - Plan: [docs/superpowers/plans/2026-06-13-project-scoped-policy-governance.md](docs/superpowers/plans/2026-06-13-project-scoped-policy-governance.md)\n  - Spec: [docs/superpowers/specs/2026-06-13-project-scoped-policy-governance-design.md](docs/superpowers/specs/2026-06-13-project-scoped-policy-governance-design.md)\n  - Owner: TBD\n\n- [ ] **`paprika apply -f` CLI** — render manifests locally and submit via `ApplyBundle`; `Policy` CRD; Bubble Tea TUI",
  "new_string": "- [ ] **`paprika apply -f` CLI** — render manifests locally and submit via `ApplyBundle`; `Policy` CRD; Bubble Tea TUI"
}
```

<details><summary>Tool Result: Edit (`.worktrees/paprika-apply-cli/TODO.md`)</summary>

<!-- call_id: tool_vUqy0lMIg3ggTyxW4VPtEgep -->
Replaced 1 occurrence in .worktrees/paprika-apply-cli/TODO.md

</details>

<details><summary>Thinking</summary>

Good. Commit this hygiene change.

</details>

#### Tool Call: Bash (`cd .worktrees/paprika-apply-cli && git add TODO.md && git co…`)
<!-- call_id: tool_1tfCDWtw0nHnmh5deqSyNFba -->
```json
{
  "command": "cd .worktrees/paprika-apply-cli && git add TODO.md && git commit -m \"chore(todo): mark project-scoped policy governance as implemented\"",
  "timeout": 60
}
```

<details><summary>Tool Result: Bash (`cd .worktrees/paprika-apply-cli && git add TODO.md && git co…`)</summary>

<!-- call_id: tool_1tfCDWtw0nHnmh5deqSyNFba -->
[feature/paprika-apply-cli a49580f] chore(todo): mark project-scoped policy governance as implemented
 1 file changed, 1 insertion(+), 6 deletions(-)


</details>

<details><summary>Thinking</summary>

Now update todo list to reflect worktree done and tasks. We need extract tasks. The plan has chunks 1-7. Many tasks. We can set todos as chunks. But better to list the main tasks. For subagent-driven-development, we need per task. We can group. Maybe we start with Chunk 1 Task 1.1 and 1.2. Then Chunk 2, 3, 4a, 4b, 4c, 5, 6, 7. That's a lot. We can create todos for each chunk and mark chunk 1 in progress. Let's create todos.

</details>

#### Tool Call: TodoList
<!-- call_id: tool_eJ3nj1oCwDBJs0sCZWvorsVf -->
```json
{
  "todos": [
    {
      "title": "Review backlog and select next epic",
      "status": "done"
    },
    {
      "title": "Set up isolated worktree for chosen feature",
      "status": "done"
    },
    {
      "title": "Chunk 1: Policy CRD and evaluator package",
      "status": "in_progress"
    },
    {
      "title": "Chunk 2: CRD changes for inline source and policy results",
      "status": "pending"
    },
    {
      "title": "Chunk 3: Protobuf and ApplyBundle API server handler",
      "status": "pending"
    },
    {
      "title": "Chunk 4a: Release controller inline manifest path",
      "status": "pending"
    },
    {
      "title": "Chunk 4b: Application controller inline source handling",
      "status": "pending"
    },
    {
      "title": "Chunk 4c: True rollback",
      "status": "pending"
    },
    {
      "title": "Chunk 5: CLI apply command and TUI",
      "status": "pending"
    },
    {
      "title": "Chunk 6: UI, RBAC manifests, and final integration",
      "status": "pending"
    },
    {
      "title": "Chunk 7: Validation webhooks",
      "status": "pending"
    }
  ]
}
```

<details><summary>Tool Result: TodoList</summary>

<!-- call_id: tool_eJ3nj1oCwDBJs0sCZWvorsVf -->
Todo list updated.
Current todo list:
  [done] Review backlog and select next epic
  [done] Set up isolated worktree for chosen feature
  [in_progress] Chunk 1: Policy CRD and evaluator package
  [pending] Chunk 2: CRD changes for inline source and policy results
  [pending] Chunk 3: Protobuf and ApplyBundle API server handler
  [pending] Chunk 4a: Release controller inline manifest path
  [pending] Chunk 4b: Application controller inline source handling
  [pending] Chunk 4c: True rollback
  [pending] Chunk 5: CLI apply command and TUI
  [pending] Chunk 6: UI, RBAC manifests, and final integration
  [pending] Chunk 7: Validation webhooks

Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.

</details>

<details><summary>Thinking</summary>

Now start Chunk 1 with subagent-driven-development. Need dispatch implementer subagent. The skill says provide full task text + context. We need craft implementer prompt. Since we have the plan text, we can include the task text. For Task 1.1 and 1.2 maybe combine into one chunk because they are closely related. But subagent can handle chunk. The skill says fresh subagent per task; a chunk with two tasks could be one subagent if we define task as Chunk 1. We can dispatch implementer with full Chunk 1 text. The subagent will work in the worktree. We need tell it the worktree path. It should read files there. We can pass the full task text from plan lines 13-470. That's large but okay. However there is a risk: the `policy` package already exists? The repo has `policy/` directory at root with evaluator etc. Wait the project already has `policy/` directory with `defaults.go`, `evaluator.go`, `evaluator_test.go`, `interfaces.go`. The plan says create `policy/interfaces.go`, `policy/evaluator.go`. It seems a `policy` package already exists at root. Let's check. The directory listing shows `policy/` at root. It contains interfaces, evaluator, defaults. So maybe some of chunk 1 is already partially implemented. Indeed the plan may be older or the code may already have a policy package. We need inspect current state to avoid overwriting. Use Read or Grep. Let's check `api/policy/v1alpha1` exists? The directory listing shows `api/policy/v1alpha1`? The tree shows api/ has clusters, core, featureflags, pipelines, policy, rollouts. Yes `api/policy/v1alpha1` exists. So Policy CRD likely already exists. The plan may be outdated. The actual task may be to build apply feature assuming policy exists. We need verify. Let's inspect `api/policy/v1alpha1/policy_types.go` and `policy/evaluator.go`.

</details>

#### Tool Call: Read (`.worktrees/paprika-apply-cli/api/policy/v1alpha1/policy_type…`)
<!-- call_id: tool_xL2C7O8h8ctV4oyPF3CCWllP -->
```json
{
  "path": ".worktrees/paprika-apply-cli/api/policy/v1alpha1/policy_types.go",
  "n_lines": 200
}
```

#### Tool Call: Read (`.worktrees/paprika-apply-cli/policy/evaluator.go`)
<!-- call_id: tool_ARhKb2gM457N0gbA6s3FcMGB -->
```json
{
  "path": ".worktrees/paprika-apply-cli/policy/evaluator.go",
  "n_lines": 200
}
```

#### Tool Call: Read (`.worktrees/paprika-apply-cli/policy/interfaces.go`)
<!-- call_id: tool_RbI6PdMOvxY2P72cKIkVRyXm -->
```json
{
  "path": ".worktrees/paprika-apply-cli/policy/interfaces.go",
  "n_lines": 200
}
```

<details><summary>Tool Result: Read (`.worktrees/paprika-apply-cli/api/policy/v1alpha1/policy_type…`)</summary>

<!-- call_id: tool_xL2C7O8h8ctV4oyPF3CCWllP -->
1	/*
2	Copyright 2026.
3	
4	Licensed under the Apache License, Version 2.0 (the "License");
5	you may not use this file except in compliance with the License.
6	You may obtain a copy of the License at
7	
8	    http://www.apache.org/licenses/LICENSE-2.0
9	
10	Unless required by applicable law or agreed to in writing, software
11	distributed under the License is distributed on an "AS IS" BASIS,
12	WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
13	See the License for the specific language governing permissions and
14	limitations under the License.
15	*/
16	
17	package v1alpha1
18	
19	import (
20		metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
21	)
22	
23	// EDIT THIS FILE!  THIS IS SCAFFOLDING FOR YOU TO OWN!
24	// NOTE: json tags are required.  Any new fields you add must have json tags for the fields to be serialized.
25	
26	type PolicySeverity string
27	
28	const (
29		PolicySeverityCritical PolicySeverity = "critical"
30		PolicySeverityWarning  PolicySeverity = "warning"
31	)
32	
33	type PolicyAction string
34	
35	const (
36		PolicyActionEnforce PolicyAction = "enforce"
37		PolicyActionWarn    PolicyAction = "warn"
38	)
39	
40	type PolicyMatch struct {
41		APIGroups     []string              `json:"apiGroups,omitempty"`
42		Kinds         []string              `json:"kinds,omitempty"`
43		Namespaces    []string              `json:"namespaces,omitempty"`
44		LabelSelector *metav1.LabelSelector `json:"labelSelector,omitempty"`
45	}
46	
47	// PolicySpec defines the desired state of Policy
48	type PolicySpec struct {
49		Description string `json:"description,omitempty"`
50		// +kubebuilder:validation:Enum=critical;warning
51		Severity PolicySeverity `json:"severity"`
52		// +kubebuilder:validation:Enum=enforce;warn
53		DefaultAction PolicyAction `json:"defaultAction,omitempty"`
54		Match         PolicyMatch  `json:"match"`
55		Expression    string       `json:"expression"`
56		Projects      []string     `json:"projects,omitempty"`
57	}
58	
59	// PolicyStatus defines the observed state of Policy.
60	type PolicyStatus struct{}
61	
62	// +kubebuilder:object:root=true
63	// +kubebuilder:resource:scope=Cluster
64	// +kubebuilder:subresource:status
65	// +kubebuilder:printcolumn:name="Severity",type=string,JSONPath=".spec.severity"
66	// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"
67	
68	// Policy is the Schema for the policies API
69	type Policy struct {
70		metav1.TypeMeta `json:",inline"`
71	
72		// metadata is a standard object metadata
73		// +optional
74		metav1.ObjectMeta `json:"metadata,omitzero"`
75	
76		// spec defines the desired state of Policy
77		// +required
78		Spec PolicySpec `json:"spec"`
79	
80		// status defines the observed state of Policy
81		// +optional
82		Status PolicyStatus `json:"status,omitzero"`
83	}
84	
85	// +kubebuilder:object:root=true
86	
87	// PolicyList contains a list of Policy
88	type PolicyList struct {
89		metav1.TypeMeta `json:",inline"`
90		metav1.ListMeta `json:"metadata,omitzero"`
91		Items           []Policy `json:"items"`
92	}
93	
94	func init() {
95		SchemeBuilder.Register(&Policy{}, &PolicyList{})
96	}
<system>96 lines read from file starting from line 1. Total lines in file: 96. End of file reached.</system>

</details>

<details><summary>Tool Result: Read (`.worktrees/paprika-apply-cli/policy/evaluator.go`)</summary>

<!-- call_id: tool_ARhKb2gM457N0gbA6s3FcMGB -->
<system>ERROR: Tool execution failed.</system>
".worktrees/paprika-apply-cli/policy/evaluator.go" does not exist.

</details>

<details><summary>Tool Result: Read (`.worktrees/paprika-apply-cli/policy/interfaces.go`)</summary>

<!-- call_id: tool_RbI6PdMOvxY2P72cKIkVRyXm -->
<system>ERROR: Tool execution failed.</system>
".worktrees/paprika-apply-cli/policy/interfaces.go" does not exist.

</details>

<details><summary>Thinking</summary>

Interesting: `policy/evaluator.go` doesn't exist at root; `internal/policy` exists maybe. The repo has `internal/policy`? Directory listing shows `internal/` with agent, api, cache, controller, featureflag, governance, observability, ratelimit, repository, reposerver, rollout, sharding, source, syncwindow, traffic, webhook, ... and 4 more. Could include `internal/policy`. Also root `policy/` directory from listing? The tree shows `policy/` at root with defaults.go, evaluator_test.go, evaluator.go, interfaces.go. But in worktree maybe path? Wait listing in prompt showed `policy/` at root. But Read failed for `policy/evaluator.go`. Maybe root `policy` directory exists but files not? Let's list.

</details>

#### Tool Call: Bash (`ls -la .worktrees/paprika-apply-cli/policy/ .worktrees/papri…`)
<!-- call_id: tool_5amwcH3kYiLbOsm2EN0iCdnG -->
```json
{
  "command": "ls -la .worktrees/paprika-apply-cli/policy/ .worktrees/paprika-apply-cli/internal/policy/ 2>&1 | head -50",
  "timeout": 30
}
```

<details><summary>Tool Result: Bash (`ls -la .worktrees/paprika-apply-cli/policy/ .worktrees/papri…`)</summary>

<!-- call_id: tool_5amwcH3kYiLbOsm2EN0iCdnG -->
ls: .worktrees/paprika-apply-cli/policy/: No such file or directory
.worktrees/paprika-apply-cli/internal/policy/:
total 48
drwxr-xr-x@  6 benebsworth  staff   192 Jun 19 14:13 .
drwxr-xr-x@ 27 benebsworth  staff   864 Jun 19 14:13 ..
-rw-r--r--@  1 benebsworth  staff   315 Jun 19 14:13 defaults.go
-rw-r--r--@  1 benebsworth  staff  8128 Jun 19 14:13 evaluator_test.go
-rw-r--r--@  1 benebsworth  staff  5207 Jun 19 14:13 evaluator.go
-rw-r--r--@  1 benebsworth  staff   456 Jun 19 14:13 interfaces.go


</details>

<details><summary>Thinking</summary>

So `internal/policy` exists. The plan references `policy/` package at root. The code has it under `internal/policy`. We need follow existing codebase. The Policy CRD exists. The evaluator likely exists. Let's read internal/policy files.

</details>

#### Tool Call: Read (`.worktrees/paprika-apply-cli/internal/policy/evaluator.go`)
<!-- call_id: tool_b0gmL2xpHra49UIvQWg7JzAD -->
```json
{
  "path": ".worktrees/paprika-apply-cli/internal/policy/evaluator.go",
  "n_lines": 300
}
```

#### Tool Call: Read (`.worktrees/paprika-apply-cli/internal/policy/interfaces.go`)
<!-- call_id: tool_IyDgchdTFS3M0Op0eAsOJbZE -->
```json
{
  "path": ".worktrees/paprika-apply-cli/internal/policy/interfaces.go",
  "n_lines": 200
}
```

#### Tool Call: Read (`.worktrees/paprika-apply-cli/internal/policy/defaults.go`)
<!-- call_id: tool_pr3BV8hVHQCogx6OA6Kn5x2C -->
```json
{
  "path": ".worktrees/paprika-apply-cli/internal/policy/defaults.go",
  "n_lines": 100
}
```

<details><summary>Tool Result: Read (`.worktrees/paprika-apply-cli/internal/policy/evaluator.go`)</summary>

<!-- call_id: tool_b0gmL2xpHra49UIvQWg7JzAD -->
1	package policy
2	
3	import (
4		"context"
5		"fmt"
6		"strings"
7	
8		"github.com/google/cel-go/cel"
9		metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
10		"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
11		"k8s.io/apimachinery/pkg/labels"
12		"k8s.io/apimachinery/pkg/util/yaml"
13	
14		policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
15		"github.com/benebsworth/paprika/internal/engine"
16	)
17	
18	type CELEvaluator struct {
19		policies []policyv1alpha1.Policy
20	}
21	
22	// NewCELEvaluator creates a CEL-based policy evaluator from the given policies.
23	func NewCELEvaluator(policies []policyv1alpha1.Policy) *CELEvaluator {
24		return &CELEvaluator{policies: policies}
25	}
26	
27	func (e *CELEvaluator) Evaluate(ctx context.Context, bundle []byte, opts EvaluateOptions) (*EvaluationResult, error) {
28		docs := splitYAMLDocuments(bundle)
29		var results []Result
30		for _, doc := range docs {
31			obj := &unstructured.Unstructured{}
32			if err := yaml.Unmarshal(doc, &obj.Object); err != nil {
33				return nil, fmt.Errorf("unmarshal manifest: %w", err)
34			}
35			if obj.Object == nil {
36				continue
37			}
38			for i := range e.policies {
39				pol := &e.policies[i]
40				if skip(opts.SkipPolicies, pol.Name) {
41					continue
42				}
43				if !match(&pol.Spec.Match, obj, opts.Namespace) {
44					continue
45				}
46				passed, msg := e.evalPolicy(ctx, pol.Spec.Expression, obj)
47				action := resolveAction(pol, opts.PolicyOverrides)
48				results = append(results, Result{
49					Name:     pol.Name,
50					Severity: string(pol.Spec.Severity),
51					Action:   string(action),
52					Passed:   passed,
53					Message:  msg,
54				})
55			}
56		}
57		return aggregate(results), nil
58	}
59	
60	func skip(list []string, name string) bool {
61		for _, n := range list {
62			if n == name {
63				return true
64			}
65		}
66		return false
67	}
68	
69	func resolveAction(pol *policyv1alpha1.Policy, overrides map[string]Action) policyv1alpha1.PolicyAction {
70		if overrides != nil {
71			if a, ok := overrides[pol.Name]; ok {
72				return policyv1alpha1.PolicyAction(a)
73			}
74		}
75		if pol.Spec.DefaultAction != "" {
76			return pol.Spec.DefaultAction
77		}
78		return defaultAction(pol.Spec.Severity)
79	}
80	
81	func contains(list []string, val string) bool {
82		for _, v := range list {
83			if v == val {
84				return true
85			}
86		}
87		return false
88	}
89	
90	func matchAPIGroups(groups []string, apiVersion string) bool {
91		if len(groups) == 0 {
92			return true
93		}
94		group := ""
95		if i := strings.Index(apiVersion, "/"); i >= 0 {
96			group = apiVersion[:i]
97		}
98		return contains(groups, group)
99	}
100	
101	func match(m *policyv1alpha1.PolicyMatch, obj *unstructured.Unstructured, namespace string) bool {
102		if !matchAPIGroups(m.APIGroups, obj.GetAPIVersion()) {
103			return false
104		}
105		if len(m.Kinds) > 0 && !contains(m.Kinds, obj.GetKind()) {
106			return false
107		}
108		// match.namespaces filters by the resource's own namespace.
109		if len(m.Namespaces) > 0 && !contains(m.Namespaces, obj.GetNamespace()) {
110			return false
111		}
112		if m.LabelSelector != nil {
113			selector, err := metav1.LabelSelectorAsSelector(m.LabelSelector)
114			if err == nil && !selector.Matches(labels.Set(obj.GetLabels())) {
115				return false
116			}
117		}
118		return true
119	}
120	
121	func splitYAMLDocuments(bundle []byte) [][]byte {
122		return engine.SplitYAMLDocuments(bundle)
123	}
124	
125	func (e *CELEvaluator) evalPolicy(ctx context.Context, expr string, obj *unstructured.Unstructured) (passed bool, msg string) {
126		env, err := cel.NewEnv(
127			cel.Variable("object", cel.MapType(cel.StringType, cel.AnyType)),
128			cel.Variable("kind", cel.StringType),
129			cel.Variable("apiVersion", cel.StringType),
130			cel.Variable("name", cel.StringType),
131			cel.Variable("namespace", cel.StringType),
132			cel.Variable("labels", cel.MapType(cel.StringType, cel.StringType)),
133			cel.Variable("annotations", cel.MapType(cel.StringType, cel.StringType)),
134			cel.Variable("spec", cel.MapType(cel.StringType, cel.AnyType)),
135		)
136		if err != nil {
137			return false, fmt.Sprintf("env error: %v", err)
138		}
139		ast, iss := env.Compile(expr)
140		if iss != nil {
141			return false, fmt.Sprintf("compile error: %v", iss.Err())
142		}
143		prg, err := env.Program(ast)
144		if err != nil {
145			return false, fmt.Sprintf("program error: %v", err)
146		}
147		labels := obj.GetLabels()
148		if labels == nil {
149			labels = map[string]string{}
150		}
151		annotations := obj.GetAnnotations()
152		if annotations == nil {
153			annotations = map[string]string{}
154		}
155		spec, ok := obj.Object["spec"].(map[string]interface{})
156		if !ok || spec == nil {
157			spec = map[string]interface{}{}
158		}
159		vars := map[string]interface{}{
160			"object":      obj.Object,
161			"kind":        obj.GetKind(),
162			"apiVersion":  obj.GetAPIVersion(),
163			"name":        obj.GetName(),
164			"namespace":   obj.GetNamespace(),
165			"labels":      labels,
166			"annotations": annotations,
167			"spec":        spec,
168		}
169		out, _, err := prg.Eval(vars)
170		if err != nil {
171			return false, fmt.Sprintf("eval error: %v", err)
172		}
173		val := out.Value()
174		if b, ok := val.(bool); ok {
175			return b, ""
176		}
177		return false, "policy did not return boolean"
178	}
179	
180	func aggregate(results []Result) *EvaluationResult {
181		ev := &EvaluationResult{Passed: true, Results: results}
182		for _, r := range results {
183			if !r.Passed && r.Action == string(policyv1alpha1.PolicyActionEnforce) {
184				ev.Passed = false
185				ev.Blocked = true
186				ev.Message = fmt.Sprintf("policy %s failed", r.Name)
187				return ev
188			}
189			if !r.Passed {
190				ev.Message = fmt.Sprintf("policy %s warned", r.Name)
191			}
192		}
193		return ev
194	}
<system>194 lines read from file starting from line 1. Total lines in file: 194. End of file reached.</system>

</details>

<details><summary>Tool Result: Read (`.worktrees/paprika-apply-cli/internal/policy/interfaces.go`)</summary>

<!-- call_id: tool_IyDgchdTFS3M0Op0eAsOJbZE -->
1	package policy
2	
3	type Action string
4	
5	const (
6		EnforceAction Action = "enforce"
7		WarnAction    Action = "warn"
8	)
9	
10	type EvaluateOptions struct {
11		Namespace       string
12		ApplicationName string
13		SkipPolicies    []string
14		PolicyOverrides map[string]Action
15	}
16	
17	type Result struct {
18		Name     string
19		Severity string
20		Action   string
21		Passed   bool
22		Message  string
23	}
24	
25	type EvaluationResult struct {
26		Passed  bool
27		Results []Result
28		Blocked bool
29		Message string
30	}
<system>30 lines read from file starting from line 1. Total lines in file: 30. End of file reached.</system>

</details>

<details><summary>Tool Result: Read (`.worktrees/paprika-apply-cli/internal/policy/defaults.go`)</summary>

<!-- call_id: tool_pr3BV8hVHQCogx6OA6Kn5x2C -->
1	package policy
2	
3	import policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
4	
5	func defaultAction(sev policyv1alpha1.PolicySeverity) policyv1alpha1.PolicyAction {
6		if sev == policyv1alpha1.PolicySeverityWarning {
7			return policyv1alpha1.PolicyActionWarn
8		}
9		return policyv1alpha1.PolicyActionEnforce
10	}
<system>10 lines read from file starting from line 1. Total lines in file: 10. End of file reached.</system>

</details>

<details><summary>Thinking</summary>

So Chunk 1 is mostly already implemented. We need check if cmd/main.go registers policy scheme, etc. But likely already. Chunk 1 done. We can mark done and move to Chunk 2. Need inspect Application/Release CRDs for inline source and policy results. Let's check `api/pipelines/v1alpha1/application_types.go` and release_types.go.

</details>

#### Tool Call: Grep (`.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/applicat…`)
<!-- call_id: tool_tREnPlgO1Xj4r9FPFOqVLspQ -->
```json
{
  "path": ".worktrees/paprika-apply-cli/api/pipelines/v1alpha1/application_types.go",
  "pattern": "SourceTypeInline|InlineSourceSpec|inline",
  "output_mode": "content",
  "-n": true
}
```

#### Tool Call: Grep (`.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/release_…`)
<!-- call_id: tool_cYKv9nCKpglOSLdCjMBr2TDO -->
```json
{
  "path": ".worktrees/paprika-apply-cli/api/pipelines/v1alpha1/release_types.go",
  "pattern": "ManifestSource|ReleasePolicyResult|PolicyResults|RolledBackTo",
  "output_mode": "content",
  "-n": true
}
```

<details><summary>Tool Result: Grep (`.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/applicat…`)</summary>

<!-- call_id: tool_tREnPlgO1Xj4r9FPFOqVLspQ -->
.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/application_types.go:162:	SourceTypeInline    = "inline"
.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/application_types.go:165:// InlineSourceSpec references a manifest snapshot ConfigMap for inline sources.
.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/application_types.go:166:type InlineSourceSpec struct {
.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/application_types.go:175:	// +kubebuilder:validation:Enum=git;helm;kustomize;s3;oci;inline
.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/application_types.go:178:	// precedence over inline URL/credentials fields.
.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/application_types.go:209:	// Inline references a manifest snapshot ConfigMap (for type=inline).
.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/application_types.go:211:	Inline *InlineSourceSpec `json:"inline,omitempty"`
.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/application_types.go:534:	metav1.TypeMeta   `json:",inline"`
.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/application_types.go:547:	metav1.TypeMeta `json:",inline"`

</details>

<details><summary>Tool Result: Grep (`.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/release_…`)</summary>

<!-- call_id: tool_cYKv9nCKpglOSLdCjMBr2TDO -->
.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/release_types.go:36:// ManifestSource references a manifest snapshot ConfigMap owned by a Release.
.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/release_types.go:37:type ManifestSource struct {
.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/release_types.go:43:// ReleasePolicyResult records the outcome of a single policy evaluation for a release.
.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/release_types.go:44:type ReleasePolicyResult struct {
.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/release_types.go:69:	// ManifestSource references a pre-rendered inline manifest snapshot ConfigMap.
.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/release_types.go:72:	ManifestSource *ManifestSource `json:"manifestSource,omitempty"`
.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/release_types.go:90:	// PolicyResults records the outcome of policy evaluation for this release.
.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/release_types.go:92:	PolicyResults []ReleasePolicyResult `json:"policyResults,omitempty"`
.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/release_types.go:93:	// RolledBackTo records the release name that a rolled-back release re-applied.
.worktrees/paprika-apply-cli/api/pipelines/v1alpha1/release_types.go:95:	RolledBackTo string `json:"rolledBackTo,omitempty"`

</details>

<details><summary>Thinking</summary>

Chunk 2 also already implemented. So the backend CRDs exist. We need verify protobuf and ApplyBundle handler. Check proto.

</details>

#### Tool Call: Grep (`.worktrees/paprika-apply-cli/proto/paprika/v1/api.proto`)
<!-- call_id: tool_bQ1b1O8FgVsBLF2jrCcPXYLA -->
```json
{
  "path": ".worktrees/paprika-apply-cli/proto/paprika/v1/api.proto",
  "pattern": "ApplyBundle|InlineSource|ManifestSource|PolicyResult",
  "output_mode": "content",
  "-n": true
}
```

<details><summary>Tool Result: Grep (`.worktrees/paprika-apply-cli/proto/paprika/v1/api.proto`)</summary>

<!-- call_id: tool_bQ1b1O8FgVsBLF2jrCcPXYLA -->
.worktrees/paprika-apply-cli/proto/paprika/v1/api.proto:35:message InlineSource {
.worktrees/paprika-apply-cli/proto/paprika/v1/api.proto:60:  InlineSource inline = 12;
.worktrees/paprika-apply-cli/proto/paprika/v1/api.proto:183:message ManifestSource {
.worktrees/paprika-apply-cli/proto/paprika/v1/api.proto:187:message PolicyResult {
.worktrees/paprika-apply-cli/proto/paprika/v1/api.proto:205:  ManifestSource manifest_source = 9;
.worktrees/paprika-apply-cli/proto/paprika/v1/api.proto:206:  repeated PolicyResult policy_results = 10;
.worktrees/paprika-apply-cli/proto/paprika/v1/api.proto:421:message ApplyBundleRequest {
.worktrees/paprika-apply-cli/proto/paprika/v1/api.proto:431:message ApplyBundleResponse {
.worktrees/paprika-apply-cli/proto/paprika/v1/api.proto:434:  repeated PolicyResult policy_results = 3;
.worktrees/paprika-apply-cli/proto/paprika/v1/api.proto:516:  rpc ApplyBundle(ApplyBundleRequest) returns (ApplyBundleResponse);

</details>

<details><summary>Thinking</summary>

Protobuf already has ApplyBundle. Check if internal/api/apply_bundle.go exists.

</details>

#### Tool Call: Bash (`ls .worktrees/paprika-apply-cli/internal/api/apply_bundle.go…`)
<!-- call_id: tool_2WKEuwnhNXRkqWOMwlbjhzwn -->
```json
{
  "command": "ls .worktrees/paprika-apply-cli/internal/api/apply_bundle.go .worktrees/paprika-apply-cli/internal/api/apply_bundle_test.go 2>&1",
  "timeout": 30
}
```

<details><summary>Tool Result: Bash (`ls .worktrees/paprika-apply-cli/internal/api/apply_bundle.go…`)</summary>

<!-- call_id: tool_2WKEuwnhNXRkqWOMwlbjhzwn -->
.worktrees/paprika-apply-cli/internal/api/apply_bundle_test.go
.worktrees/paprika-apply-cli/internal/api/apply_bundle.go


</details>

<details><summary>Thinking</summary>

ApplyBundle handler exists too. So much of the plan is already implemented. We need check what's missing: maybe CLI apply command, TUI, controller inline handling, rollback, UI, webhooks. We need inspect git log to see what already done. Use git log.

</details>

#### Tool Call: Bash (`cd .worktrees/paprika-apply-cli && git log --oneline -20`)
<!-- call_id: tool_4vTojwAzQLlTGsq9K1d0j8Wz -->
```json
{
  "command": "cd .worktrees/paprika-apply-cli && git log --oneline -20",
  "timeout": 30
}
```

<details><summary>Tool Result: Bash (`cd .worktrees/paprika-apply-cli && git log --oneline -20`)</summary>

<!-- call_id: tool_4vTojwAzQLlTGsq9K1d0j8Wz -->
a49580f chore(todo): mark project-scoped policy governance as implemented
6cf4b59 test(e2e): probe AppProject webhook to confirm reachability before specs
fa49748 test(e2e): wait for webhook service endpoints before running specs
5d3ecd2 docs(skill): add CI e2e validation section to debugging skill
5ad5790 ci(e2e): switch to workflow_dispatch with focus and retain options
337cf72 ci(e2e): pre-build images with GH cache, skip rebuild in suite
6e6f759 test(e2e): lint fixes for kind load fallback
99006f0 test(e2e): fall back to docker save + kind load image-archive on load failures
f22bd88 test(controller): add release controller governance gate unit test
3591bab refactor: internalize packages, consolidate CLI, fix Helm chart, and cleanups
d2649ca docs: add TODO.md tracking implemented and planned features
423de49 test(e2e): add Application self-heal drift sync coverage and harden webhook cert readiness (#15)
0ebefe4 feat(feature-flags): add FeatureFlag/FeatureFlagBinding CRDs, providers, and routing abstractions
f0c0003 Merge branch feat/advanced-rollout-strategies
7e89570 wip(rollout): checkpoint advanced rollout strategies
049bf70 Merge branch feat/analysis-templates
9258b2c Merge branch feat/notifications
4e68dd3 chore(build): exclude git worktrees from controller-gen paths; regenerate manifests and design docs
c18b1b9 chore(chart): regenerate Helm chart and installer manifests
7a4c66d docs(samples): add AnalysisTemplate samples and guide


</details>

<details><summary>Thinking</summary>

The commit `3591bab refactor: internalize packages, consolidate CLI, fix Helm chart, and cleanups` likely included a lot of apply feature. We need see what remains. Let's inspect internal/api/apply_bundle.go to see if fully implemented. Also check cmd/paprika-cli for apply.go.

</details>

#### Tool Call: Bash (`ls .worktrees/paprika-apply-cli/cmd/paprika-cli/`)
<!-- call_id: tool_SkM49wdVnK8u1NyhQaCwzUPv -->
```json
{
  "command": "ls .worktrees/paprika-apply-cli/cmd/paprika-cli/",
  "timeout": 30
}
```

#### Tool Call: Bash (`ls .worktrees/paprika-apply-cli/internal/api/apply_bundle*.g…`)
<!-- call_id: tool_3KPWVFJzjXz1JDti6FdrAOLj -->
```json
{
  "command": "ls .worktrees/paprika-apply-cli/internal/api/apply_bundle*.go .worktrees/paprika-apply-cli/internal/api/server.go",
  "timeout": 30
}
```

<details><summary>Tool Result: Bash (`ls .worktrees/paprika-apply-cli/cmd/paprika-cli/`)</summary>

<!-- call_id: tool_SkM49wdVnK8u1NyhQaCwzUPv -->
<system>ERROR: Tool execution failed.</system>
ls: .worktrees/paprika-apply-cli/cmd/paprika-cli/: No such file or directory
Command failed with exit code: 1.

</details>

<details><summary>Tool Result: Bash (`ls .worktrees/paprika-apply-cli/internal/api/apply_bundle*.g…`)</summary>

<!-- call_id: tool_3KPWVFJzjXz1JDti6FdrAOLj -->
.worktrees/paprika-apply-cli/internal/api/apply_bundle_test.go
.worktrees/paprika-apply-cli/internal/api/apply_bundle.go
.worktrees/paprika-apply-cli/internal/api/server.go


</details>

<details><summary>Thinking</summary>

No `cmd/paprika-cli` directory; CLI may be in `cmd/paprika`. The plan references `cmd/paprika-cli` but the project has `cmd/paprika`. The `cmd/paprika` directory from tree includes apply.go, watch_test.go, etc. So CLI apply likely exists in `cmd/paprika`. Need inspect. Also check apply_bundle.go.

</details>

#### Tool Call: Bash (`ls .worktrees/paprika-apply-cli/cmd/paprika/`)
<!-- call_id: tool_gM76GrOrDI8n0X1p3abTipAn -->
```json
{
  "command": "ls .worktrees/paprika-apply-cli/cmd/paprika/",
  "timeout": 30
}
```

<details><summary>Tool Result: Bash (`ls .worktrees/paprika-apply-cli/cmd/paprika/`)</summary>

<!-- call_id: tool_gM76GrOrDI8n0X1p3abTipAn -->
apply_test.go
apply.go
apps.go
client.go
config_cmd.go
config_test.go
config.go
gates.go
main.go
output.go
pipelines.go
releases.go
render.go
resolve.go
stages.go
template.go
watch_test.go
watch.go


</details>

<details><summary>Thinking</summary>

Apply.go exists. So much of plan already done. We need determine what's actually missing. The plan may have been partially implemented. We should check current state against plan, identify gaps. This requires comparing. We can use subagents to audit. But since user wants us to pick up next big chunks, maybe the apply feature is largely done; the next missing chunk is something else like Approval Gates, or the remaining apply pieces (TUI, UI dashboard, E2E tests, docs). We need find out.

Let's inspect `cmd/paprika/apply.go` and `internal/api/apply_bundle.go` to see if they are complete. Also check if UI detail page exists. Use explore agent maybe to audit apply feature completeness. But we can do direct reads.

Read apply.go.

</details>

#### Tool Call: Read (`.worktrees/paprika-apply-cli/cmd/paprika/apply.go`)
<!-- call_id: tool_TnepsJLRJx0tZPMux9xQemL1 -->
```json
{
  "path": ".worktrees/paprika-apply-cli/cmd/paprika/apply.go",
  "n_lines": 300
}
```

<details><summary>Tool Result: Read (`.worktrees/paprika-apply-cli/cmd/paprika/apply.go`)</summary>

<!-- call_id: tool_TnepsJLRJx0tZPMux9xQemL1 -->
1	package main
2	
3	import (
4		"context"
5		"errors"
6		"fmt"
7		"net/http"
8		"os"
9		"path/filepath"
10		"sort"
11		"strings"
12		"time"
13	
14		"connectrpc.com/connect"
15		"github.com/spf13/cobra"
16		"k8s.io/apimachinery/pkg/util/yaml"
17		"k8s.io/client-go/tools/clientcmd"
18	
19		paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
20		"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
21	)
22	
23	type applyOptions struct {
24		files           []string
25		namespace       string
26		name            string
27		project         string
28		skipPolicies    []string
29		policyOverrides []string
30		dryRun          bool
31		wait            bool
32		timeout         time.Duration
33		server          string
34	}
35	
36	func newApplyCmd(ctx context.Context) *cobra.Command {
37		opts := &applyOptions{}
38		cmd := &cobra.Command{
39			Use:   "apply -f <path> [-f <path>...]",
40			Short: "Apply a manifest bundle to Paprika",
41			Long:  "Render raw YAML files or directories into a manifest bundle and submit it to the Paprika API server.",
42			RunE: func(cmd *cobra.Command, args []string) error {
43				return runApply(ctx, opts)
44			},
45		}
46		cmd.Flags().StringArrayVarP(&opts.files, "file", "f", nil, "File, directory, or archive to apply (repeatable)")
47		cmd.Flags().StringVarP(&opts.namespace, "namespace", "n", "", "Target namespace (defaults to current kubeconfig context)")
48		cmd.Flags().StringVar(&opts.name, "name", "", "Application name (defaults to first resource or path name)")
49		cmd.Flags().StringVar(&opts.project, "project", "", "AppProject that governs this application (defaults to default)")
50		cmd.Flags().StringArrayVar(&opts.skipPolicies, "skip-policy", nil, "Skip a named Policy for this apply")
51		cmd.Flags().StringArrayVar(&opts.policyOverrides, "policy-override", nil, "Override a policy action (name=enforce|warn)")
52		cmd.Flags().BoolVar(&opts.dryRun, "dry-run", false, "Render and evaluate policies without mutating the cluster")
53		cmd.Flags().BoolVar(&opts.wait, "wait", true, "Block and watch until terminal phase")
54		cmd.Flags().DurationVar(&opts.timeout, "timeout", 5*time.Minute, "Watch timeout")
55		cmd.Flags().StringVar(&opts.server, "server", defaultServer(), "Paprika API server URL")
56		cobra.CheckErr(cmd.MarkFlagRequired("file"))
57		return cmd
58	}
59	
60	func defaultServer() string {
61		if s := os.Getenv("PAPRIKA_SERVER"); s != "" {
62			return s
63		}
64		return "http://localhost:3000"
65	}
66	
67	//nolint:cyclop // apply reconciles multiple resource types
68	func runApply(ctx context.Context, opts *applyOptions) error {
69		if len(opts.files) == 0 {
70			return errors.New("at least one -f path is required")
71		}
72	
73		bundle, suggestedName, err := loadManifestBundle(opts.files)
74		if err != nil {
75			return fmt.Errorf("load manifests: %w", err)
76		}
77	
78		namespace := opts.namespace
79		if namespace == "" {
80			namespace = currentNamespace()
81		}
82	
83		appName := opts.name
84		if appName == "" {
85			appName, err = deriveAppName(bundle, opts.files[0], suggestedName)
86			if err != nil {
87				return fmt.Errorf("derive application name: %w", err)
88			}
89		}
90	
91		overrides, err := parsePolicyOverrides(opts.policyOverrides)
92		if err != nil {
93			return fmt.Errorf("parse policy overrides: %w", err)
94		}
95	
96		client := v1connect.NewPaprikaServiceClient(http.DefaultClient, opts.server)
97	
98		resp, err := client.ApplyBundle(ctx, connect.NewRequest(&paprikav1.ApplyBundleRequest{
99			Namespace:       namespace,
100			Name:            appName,
101			Project:         opts.project,
102			Manifests:       bundle,
103			SkipPolicies:    opts.skipPolicies,
104			PolicyOverrides: overrides,
105			DryRun:          opts.dryRun,
106		}))
107		if err != nil {
108			return fmt.Errorf("apply bundle RPC failed: %w", err)
109		}
110	
111		if resp.Msg.Blocked {
112			printPolicyResults(resp.Msg.PolicyResults)
113			return fmt.Errorf("apply blocked: %s", resp.Msg.BlockReason)
114		}
115	
116		if opts.dryRun {
117			fmt.Println("Dry run complete. No resources were created.")
118			printPolicyResults(resp.Msg.PolicyResults)
119			return nil
120		}
121	
122		if !opts.wait {
123			fmt.Printf("Submitted %s/%s\n", namespace, appName)
124			printPolicyResults(resp.Msg.PolicyResults)
125			return nil
126		}
127	
128		return watchApplication(ctx, client, namespace, appName, resp.Msg.Release, resp.Msg.PolicyResults, opts.timeout)
129	}
130	
131	func loadManifestBundle(paths []string) (bundle []byte, suggestedName string, err error) {
132		var docs []string
133		for _, p := range paths {
134			loaded, name, loadErr := loadPath(p)
135			if loadErr != nil {
136				return nil, "", fmt.Errorf("load path %q: %w", p, loadErr)
137			}
138			if suggestedName == "" {
139				suggestedName = name
140			}
141			docs = append(docs, loaded...)
142		}
143		if len(docs) == 0 {
144			return nil, "", fmt.Errorf("no manifests found in paths: %v", paths)
145		}
146		return []byte(strings.Join(docs, "\n---\n")), suggestedName, nil
147	}
148	
149	func loadPath(p string) (docs []string, suggestedName string, err error) {
150		info, err := os.Stat(p)
151		if err != nil {
152			return nil, "", fmt.Errorf("stat path: %w", err)
153		}
154		if !info.IsDir() {
155			data, readErr := os.ReadFile(p)
156			if readErr != nil {
157				return nil, "", fmt.Errorf("read file: %w", readErr)
158			}
159			return []string{string(data)}, fileBaseName(p), nil
160		}
161	
162		entries, err := os.ReadDir(p)
163		if err != nil {
164			return nil, "", fmt.Errorf("read directory: %w", err)
165		}
166		files := yamlFiles(entries, p)
167	
168		docs = make([]string, 0, len(files))
169		for _, f := range files {
170			data, readErr := os.ReadFile(f)
171			if readErr != nil {
172				return nil, "", fmt.Errorf("read file %q: %w", f, readErr)
173			}
174			docs = append(docs, string(data))
175		}
176		return docs, filepath.Base(p), nil
177	}
178	
179	func yamlFiles(entries []os.DirEntry, dir string) []string {
180		var files []string
181		for _, e := range entries {
182			if e.IsDir() {
183				continue
184			}
185			ext := strings.ToLower(filepath.Ext(e.Name()))
186			if ext == ".yaml" || ext == ".yml" {
187				files = append(files, filepath.Join(dir, e.Name()))
188			}
189		}
190		sort.Strings(files)
191		return files
192	}
193	
194	func fileBaseName(p string) string {
195		return filepath.Base(strings.TrimSuffix(p, filepath.Ext(p)))
196	}
197	
198	func deriveAppName(bundle []byte, firstPath, suggestedName string) (string, error) {
199		docs := strings.Split(string(bundle), "\n---\n")
200		for _, doc := range docs {
201			var obj map[string]interface{}
202			if err := yaml.Unmarshal([]byte(doc), &obj); err != nil {
203				continue
204			}
205			if obj == nil {
206				continue
207			}
208			meta, ok := obj["metadata"].(map[string]interface{})
209			if !ok {
210				if obj["metadata"] == nil {
211					continue
212				}
213				return "", errors.New("manifest metadata is not an object")
214			}
215			if meta == nil {
216				continue
217			}
218			if name, ok := meta["name"].(string); ok && name != "" {
219				return name, nil
220			}
221		}
222		if suggestedName != "" {
223			return suggestedName, nil
224		}
225		return fileBaseName(firstPath), nil
226	}
227	
228	func parsePolicyOverrides(in []string) (map[string]string, error) {
229		out := make(map[string]string, len(in))
230		for _, raw := range in {
231			parts := strings.SplitN(raw, "=", 2)
232			if len(parts) != 2 {
233				return nil, fmt.Errorf("invalid policy override %q (expected name=enforce|warn)", raw)
234			}
235			action := strings.ToLower(parts[1])
236			if action != "enforce" && action != "warn" {
237				return nil, fmt.Errorf("invalid policy override action %q (expected enforce or warn)", parts[1])
238			}
239			out[parts[0]] = action
240		}
241		return out, nil
242	}
243	
244	func currentNamespace() string {
245		loadingRules := clientcmd.NewDefaultClientConfigLoadingRules()
246		config := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
247			loadingRules,
248			&clientcmd.ConfigOverrides{},
249		)
250		ns, _, err := config.Namespace()
251		if err != nil || ns == "" {
252			return "default"
253		}
254		return ns
255	}
256	
257	func printPolicyResults(results []*paprikav1.PolicyResult) {
258		if len(results) == 0 {
259			return
260		}
261		fmt.Println("Policy results:")
262		for _, r := range results {
263			status := "PASS"
264			if !r.Passed {
265				status = "FAIL"
266			}
267			fmt.Printf("  %-30s %s  severity=%s action=%s", r.Name, status, r.Severity, r.Action)
268			if r.Message != "" {
269				fmt.Printf("  (%s)", r.Message)
270			}
271			fmt.Println()
272		}
273	}
<system>273 lines read from file starting from line 1. Total lines in file: 273. End of file reached.</system>

</details>

<details><summary>Thinking</summary>

We see apply.go exists and uses watchApplication, not Bubble Tea TUI. The plan's chunk 5 TUI may be missing. We need inspect watch.go to see if it has TUI or plain. Also check apply_test.go. Also check apply_bundle.go completeness. And controller inline paths. And UI page. We need systematically audit what's implemented vs plan. We can use an explore subagent to compare the plan against code and report gaps. But we need provide plan path. Since the plan is huge, maybe better to dispatch an explore agent with the task: "Audit the current implementation of the paprika apply -f feature against the plan at docs/superpowers/plans/2026-06-13-paprika-apply.md. Report which chunks/tasks are already implemented, partially implemented, or missing. Focus on functional gaps, not docs." This is a read-only task; use explore. Then we can decide next chunk. That would save context. Let's do that.

</details>

#### Tool Call: Agent (`Audit apply feature gaps`)
<!-- call_id: tool_0bE82icPoDbf9cXzA7f6vuiF -->
```json
{
  "description": "Audit apply feature gaps",
  "subagent_type": "explore",
  "prompt": "In the Paprika Go repo at /Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli, audit the current implementation of the `paprika apply -f` feature against the detailed implementation plan in `docs/superpowers/plans/2026-06-13-paprika-apply.md`.\n\nRead the plan and inspect the relevant code files. For each chunk/task in the plan, report:\n- ALREADY IMPLEMENTED (matches the plan and has tests if required)\n- PARTIALLY IMPLEMENTED (exists but differs from plan or missing tests)\n- MISSING (not present)\n- UNKNOWN (couldn't determine)\n\nFocus on functional/backend gaps rather than documentation. Pay special attention to:\n1. Policy CRD/evaluator (api/policy/v1alpha1, internal/policy)\n2. Inline source and policy result CRD fields (api/pipelines/v1alpha1)\n3. ApplyBundle protobuf + handler (proto/paprika/v1/api.proto, internal/api/apply_bundle.go, internal/api/server.go)\n4. Release controller inline manifest path and rollback (internal/controller/pipelines/release_controller.go)\n5. Application controller inline source handling (internal/controller/pipelines/application_controller.go)\n6. CLI apply command and watch/TUI (cmd/paprika/apply.go, cmd/paprika/watch.go)\n7. Validation webhooks for inline source (internal/webhook/pipelines/v1alpha1/application_webhook.go)\n8. UI dashboard policy results/release history (ui/src/)\n9. RBAC/manifests (config/rbac/role.yaml, config/crd/kustomization.yaml)\n\nReturn a concise table or list with status and specific file paths. Do not modify any files."
}
```

<details><summary>Tool Result: Agent (`Audit apply feature gaps`)</summary>

<!-- call_id: tool_0bE82icPoDbf9cXzA7f6vuiF -->
agent_id: agent-79
actual_subagent_type: explore
status: completed

[summary]
I audited the worktree against the implementation plan. Here is the status by chunk/task.

| # | Area / Task | Status | Notes & File Paths |
|---|---|---|---|
| **Chunk 1** | **Policy CRD and evaluator** | | |
| 1.1 | `Policy` CRD scaffolding | **PARTIALLY IMPLEMENTED** | `api/policy/v1alpha1/policy_types.go` exists with plan fields, but adds an unplanned `Projects []string` field. `groupversion_info.go`, `zz_generated.deepcopy.go`, `config/crd/bases/policy.paprika.io_policies.yaml` generated. `cmd/main.go` registers `policyv1alpha1` in scheme. `PROJECT` entry is correct. |
| 1.2 | CEL policy evaluator | **PARTIALLY IMPLEMENTED** | Evaluator lives in `internal/policy/` (plan expected `policy/` at repo root). Type is `CELEvaluator` / `NewCELEvaluator` (plan expected `evaluator` / `NewEvaluator`). `interfaces.go`, `evaluator.go`, `defaults.go`, `evaluator_test.go` present. `Evaluator` interface moved to `internal/api/evaluator.go`. Tests cover pass/block/warn/skip/override/match but not every plan case (e.g., no standalone `matchAPIGroups` test). |
| **Chunk 2** | **CRD changes for inline source & policy results** | | |
| 2.1 | `ApplicationSource` inline type | **ALREADY IMPLEMENTED** | `api/pipelines/v1alpha1/application_types.go` has `SourceTypeInline`, `InlineSourceSpec`, `ApplicationSource.Inline`; enum updated. Generated deepcopy/CRD updated. |
| 2.2 | `Release` manifest source & policy results | **ALREADY IMPLEMENTED** | `api/pipelines/v1alpha1/release_types.go` has `ManifestSource`, `ReleasePolicyResult`, `ReleaseSpec.ManifestSource`, `ReleaseStatus.PolicyResults`, `ReleaseStatus.RolledBackTo`. Generated files updated. |
| **Chunk 3** | **Protobuf and API server** | | |
| 3.1 | Protobuf schema | **ALREADY IMPLEMENTED** | `proto/paprika/v1/api.proto` has `ApplyBundleRequest` (with extra `project=7`), `ApplyBundleResponse`, `PolicyResult`, `InlineSource`, `ManifestSource`, extended `ApplicationSource`/`Release`, and `rpc ApplyBundle`. Generated `internal/api/paprika/v1/api.pb.go` and `v1connect/api.connect.go` updated. |
| 3.2 | `ApplyBundle` handler | **PARTIALLY IMPLEMENTED** | Handler implemented in `internal/api/apply_bundle.go` and wired in `internal/api/server.go`. RBAC markers present. **Deviations from plan:** requires `name` (no `deriveAppName` fallback), no idempotency check for identical complete releases, no superseding of previous terminal release, no optimistic-lock retry loop, no `injectLabels` (uses `prepareDocument` instead), snapshot name derived differently. Tests in `internal/api/apply_bundle_test.go` cover success, block, dry-run, override, but not idempotency, supersede, or conflict cleanup. |
| **Chunk 4a** | **Release controller inline manifest path** | **PARTIALLY IMPLEMENTED** | `internal/controller/pipelines/release_controller.go` has `hasInlineManifests`, `renderManifests`, `loadManifestsFromConfigMap`, `storeManifestSnapshot` in release namespace, `gvrsFromSnapshot` for dynamic cleanup, and `rollback`. **Missing:** backward-compatible operator-namespace ConfigMap fallback, standalone `ensureReleaseLabel`, and `release_controller_inline_test.go`. |
| **Chunk 4b** | **Application controller inline source handling** | **ALREADY IMPLEMENTED** | `internal/controller/pipelines/application_controller.go` skips `reconcileTemplate` for inline, builds Stage with empty `Templates`, short-circuits `resolveSourceHash`, loads inline manifests in `evaluateDiff` via `desiredManifests`/`loadInlineManifests`, guards `reconcileRelease`, and prunes old releases. `patchAppStatus` preserves a concurrently-set `ReleaseRef` (race safety). |
| **Chunk 4c** | **True rollback** | **ALREADY IMPLEMENTED** | `findRollbackTarget`, `rollback`, `markRolledBack`, `patchApplicationReleaseRef` implemented. `reconcileReleasePhase` checks `shouldRollback` before terminal short-circuit. |
| **Chunk 5** | **CLI apply command and TUI** | **PARTIALLY IMPLEMENTED** | Implemented in `cmd/paprika/apply.go` and `cmd/paprika/watch.go` (plan expected `cmd/paprika-cli/apply.go`, `render_input.go`, `apply_tui.go`). Functional: `-f`, `--name`, `--namespace`, `--project`, `--skip-policy`, `--policy-override`, `--dry-run`, `--wait`, `--timeout`, Bubble Tea TUI, plain watch. **Missing/different:** no kustomize/helm directory detection, no separate `render_input.go`, name does not derive from first manifest when omitted. Tests in `cmd/paprika/apply_test.go` and `cmd/paprika/watch_test.go` exist. |
| **Chunk 6** | **UI, RBAC manifests, integration** | | |
| 6.1 | Regenerate RBAC & installer | **ALREADY IMPLEMENTED** | `config/rbac/role.yaml` includes policy, configmap, namespace permissions. `dist/install.yaml` includes `policy.paprika.io` CRDs/RBAC. |
| 6.2 | Dashboard updates | **ALREADY IMPLEMENTED** | `ui/src/components/dashboard/application-card.tsx` shows release ref, policy results, rollout phase, inline source info. `ui/src/app/dashboard/application/page.tsx` shows release history, policy results, managed resources, rollback button. Generated UI protobuf client includes new types. |
| 6.3 | E2E apply test | **MISSING** | `test/e2e/apply_test.go` not present. |
| 6.5 | Makefile proto target | **ALREADY IMPLEMENTED** | `Makefile` has `generate-proto` target wired into `generate`; uses `go tool buf generate` rather than the exact tool definitions in the plan, but functionally equivalent. |
| 6.6 | `PROJECT` path fix | **ALREADY IMPLEMENTED** | `Application` and `Policy` paths are correct in `PROJECT`. |
| 6.7 | Package Policy CRD | **ALREADY IMPLEMENTED** | `config/crd/kustomization.yaml` includes `policy.paprika.io_policies.yaml`. Helm chart packaging not verified. UI `package.json` lacks a `generate` script (plan requested `"generate": "cd .. && buf generate"`) — plugins are installed but script is missing. |
| **Chunk 7** | **Validation webhooks** | | |
| 7.1 | Application inline source validation | **ALREADY IMPLEMENTED** | `internal/webhook/pipelines/v1alpha1/application_webhook.go` validates `inline.configMapRef`, skips repo checks naturally for inline. Table-driven tests in `internal/webhook/pipelines/v1alpha1/application_webhook_test.go` cover inline rejection/acceptance and project-without-repo case. |

### Summary
- **Already implemented:** CRD extensions, protobuf schema, Application-controller inline handling, true rollback, RBAC/manifests/PROJECT, validation webhooks, dashboard.
- **Partially implemented:** Policy CRD/evaluator (extra field, different package/type names), ApplyBundle handler (works but missing idempotency/supersede/derive-name/lock-loop), Release controller inline path (works but missing fallback/tests), CLI apply/TUI (works but different file layout and missing derive-name/kustomize-helm checks).
- **Missing:** E2E apply test (`test/e2e/apply_test.go`), release-controller inline-specific unit test, UI `package.json` `generate` script.

</details>

<details><summary>Thinking</summary>

Excellent audit. The apply feature is largely implemented. The biggest functional gaps:
- ApplyBundle handler missing idempotency, supersede, deriveAppName fallback, optimistic lock loop. But it already works.
- E2E apply test missing.
- UI package.json generate script missing.
- Some tests missing.

Given user wants "next big chunks", maybe we should finish the apply feature: implement E2E test and fill handler gaps. But perhaps the next big chunk after apply is Approval Gates (P2 high) since apply is mostly done. However the user explicitly selected apply. We should complete it before moving on. The missing E2E test is a good next chunk and would validate the feature end-to-end. Also the ApplyBundle handler gaps are important for production. But the E2E test is the "final integration" missing piece. We can tackle:
1. Add E2E test for apply.
2. Fill ApplyBundle handler gaps (idempotency, supersede, derive-name, optimistic-lock loop) to match plan.
3. Add UI generate script.
4. Add release controller inline unit test.

But doing all may be large. We can focus on E2E test and handler hardening. However E2E requires a working local Kind environment, which earlier was blocked by Docker Desktop issues. But CI is the validation path; we can write the test and run it in CI. The user wants to be careful with CI minutes. Writing an E2E test and running it once is okay. The handler hardening is unit-testable.

Alternative: Since apply is mostly implemented, maybe we should move to the next P2 high: Approval Gates. The user said "look through our backlog and pick up next big chunks" and selected apply. But if apply is nearly done, the next big chunk is Approval Gates. We can propose: "apply is ~90% done; the remaining gaps are small. Should I close them out (E2E test + handler hardening) and then move to Approval Gates, or jump straight to Approval Gates?" But maybe too much asking. The user wants us to pick up. We can decide: finish apply's remaining gaps (they are the next concrete work), then move to Approval Gates. That aligns with "next big chunks" plural.

We can create a new set of todos: close apply gaps. Then after that, plan Approval Gates. Let's update todos to reflect apply completion statuses. Mark chunks already done as done, partially done as in_progress. Then define tasks: E2E apply test, ApplyBundle handler hardening, UI generate script, release controller inline test. But we should be systematic.

Actually, since the audit shows many chunks already implemented, we should mark done those fully implemented. Then create tasks for gaps. Use TodoList.

</details>

#### Tool Call: TodoList
<!-- call_id: tool_7PHKHIIDF82SqiFCTUq980N5 -->
```json
{
  "todos": [
    {
      "title": "Review backlog and select next epic",
      "status": "done"
    },
    {
      "title": "Set up isolated worktree for chosen feature",
      "status": "done"
    },
    {
      "title": "Chunk 1: Policy CRD and evaluator package",
      "status": "done"
    },
    {
      "title": "Chunk 2: CRD changes for inline source and policy results",
      "status": "done"
    },
    {
      "title": "Chunk 3: Protobuf and ApplyBundle API server handler",
      "status": "done"
    },
    {
      "title": "Chunk 4a: Release controller inline manifest path",
      "status": "done"
    },
    {
      "title": "Chunk 4b: Application controller inline source handling",
      "status": "done"
    },
    {
      "title": "Chunk 4c: True rollback",
      "status": "done"
    },
    {
      "title": "Chunk 5: CLI apply command and TUI",
      "status": "done"
    },
    {
      "title": "Chunk 6: UI, RBAC manifests, and final integration",
      "status": "done"
    },
    {
      "title": "Chunk 7: Validation webhooks",
      "status": "done"
    },
    {
      "title": "Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)",
      "status": "in_progress"
    }
  ]
}
```

<details><summary>Tool Result: TodoList</summary>

<!-- call_id: tool_7PHKHIIDF82SqiFCTUq980N5 -->
Todo list updated.
Current todo list:
  [done] Review backlog and select next epic
  [done] Set up isolated worktree for chosen feature
  [done] Chunk 1: Policy CRD and evaluator package
  [done] Chunk 2: CRD changes for inline source and policy results
  [done] Chunk 3: Protobuf and ApplyBundle API server handler
  [done] Chunk 4a: Release controller inline manifest path
  [done] Chunk 4b: Application controller inline source handling
  [done] Chunk 4c: True rollback
  [done] Chunk 5: CLI apply command and TUI
  [done] Chunk 6: UI, RBAC manifests, and final integration
  [done] Chunk 7: Validation webhooks
  [in_progress] Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)

Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.

</details>

<details><summary>Thinking</summary>

Now we need decide which gap to tackle. The user said "next big chunks". We can propose to close gaps and then move to Approval Gates. But to be efficient, perhaps we should do the E2E test as the next chunk because it validates the feature and is missing. Also add UI generate script (small). The handler hardening is more complex but important. We can use subagent-driven-development for each gap.

We should communicate to user: "Good news: paprika apply is mostly built. The audit shows the main missing pieces are an E2E test, a few handler hardening items, and a UI generate script. I'll close those out, then we can move to Approval Gates." Then start implementing.

But the user didn't ask for status; we can just proceed. We need use subagents for implementation. Let's start with the E2E apply test. But E2E tests in this project use Ginkgo. We need inspect existing e2e tests structure. Read test/e2e/e2e_test.go and suite.

</details>

#### Tool Call: Read (`.worktrees/paprika-apply-cli/test/e2e/e2e_test.go`)
<!-- call_id: tool_IVszAK5LXc5STHXiwHFHCuUo -->
```json
{
  "path": ".worktrees/paprika-apply-cli/test/e2e/e2e_test.go",
  "n_lines": 300
}
```

<details><summary>Tool Result: Read (`.worktrees/paprika-apply-cli/test/e2e/e2e_test.go`)</summary>

<!-- call_id: tool_IVszAK5LXc5STHXiwHFHCuUo -->
1	//go:build e2e
2	// +build e2e
3	
4	/*
5	Copyright 2026.
6	
7	Licensed under the Apache License, Version 2.0 (the "License");
8	you may not use this file except in compliance with the License.
9	You may obtain a copy of the License at
10	
11	    http://www.apache.org/licenses/LICENSE-2.0
12	
13	Unless required by applicable law or agreed to in writing, software
14	distributed under the License is distributed on an "AS IS" BASIS,
15	WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
16	See the License for the specific language governing permissions and
17	limitations under the License.
18	*/
19	
20	package e2e
21	
22	import (
23		"crypto/tls"
24		"encoding/json"
25		"fmt"
26		"io"
27		"net/http"
28		"os"
29		"os/exec"
30		"path/filepath"
31		"strings"
32		"syscall"
33		"time"
34	
35		. "github.com/onsi/ginkgo/v2"
36		. "github.com/onsi/gomega"
37	
38		"github.com/benebsworth/paprika/test/utils"
39	)
40	
41	const namespace = "paprika-system"
42	
43	const serviceAccountName = "paprika-controller-manager"
44	
45	const metricsServiceName = "paprika-controller-manager-metrics-service"
46	
47	const metricsRoleBindingName = "paprika-metrics-binding"
48	
49	var portForwardCmd *exec.Cmd
50	
51	func waitForWebhookCA() {
52		Eventually(func(g Gomega) {
53			cmd := exec.Command("kubectl", "get", "mutatingwebhookconfiguration", "paprika-mutating-webhook-configuration",
54				"-o", "jsonpath={.webhooks[0].clientConfig.caBundle}")
55			out, err := utils.Run(cmd)
56			g.Expect(err).NotTo(HaveOccurred())
57			g.Expect(out).NotTo(BeEmpty(), "mutating webhook CA bundle not injected")
58	
59			cmd = exec.Command("kubectl", "get", "validatingwebhookconfiguration", "paprika-validating-webhook-configuration",
60				"-o", "jsonpath={.webhooks[0].clientConfig.caBundle}")
61			out, err = utils.Run(cmd)
62			g.Expect(err).NotTo(HaveOccurred())
63			g.Expect(out).NotTo(BeEmpty(), "validating webhook CA bundle not injected")
64	
65			cmd = exec.Command("kubectl", "get", "secret", "webhook-server-cert", "-n", namespace)
66			_, err = utils.Run(cmd)
67			g.Expect(err).NotTo(HaveOccurred(), "webhook-server-cert secret not found")
68		}, 2*time.Minute, 2*time.Second).Should(Succeed())
69	
70		By("waiting for the controller-manager to be ready after webhook cert is available")
71		cmd := exec.Command("kubectl", "wait", "--for=condition=available", "-n", namespace,
72			"deployment/paprika-controller-manager", "--timeout=180s")
73		_, err := utils.Run(cmd)
74		Expect(err).NotTo(HaveOccurred(), "Operator deployment not available after webhook cert ready")
75	
76		By("waiting for webhook service endpoints to be ready")
77		Eventually(func(g Gomega) {
78			cmd := exec.Command("kubectl", "get", "endpoints", "paprika-webhook-service", "-n", namespace,
79				"-o", "jsonpath={.subsets[0].addresses[*].ip}")
80			out, err := utils.Run(cmd)
81			g.Expect(err).NotTo(HaveOccurred())
82			g.Expect(strings.TrimSpace(out)).NotTo(BeEmpty(), "webhook service endpoints have no addresses")
83		}, 2*time.Minute, 2*time.Second).Should(Succeed())
84	
85		By("probing the AppProject webhook until it is reachable")
86		Eventually(func(g Gomega) {
87			probe := fmt.Sprintf(`{"apiVersion":"core.paprika.io/v1alpha1","kind":"AppProject","metadata":{"name":"webhook-probe","namespace":"%s"},"spec":{}}`, namespace)
88			cmd := exec.Command("kubectl", "apply", "-f", "-")
89			cmd.Stdin = strings.NewReader(probe)
90			out, err := utils.Run(cmd)
91			if err == nil {
92				del := exec.Command("kubectl", "delete", "appproject", "webhook-probe", "-n", namespace, "--ignore-not-found")
93				_, _ = utils.Run(del)
94				return
95			}
96			outStr := strings.ToLower(out)
97			if strings.Contains(outStr, "connection refused") || strings.Contains(outStr, "timeout") || strings.Contains(outStr, "no route to host") {
98				g.Expect(outStr).NotTo(ContainSubstring("connection refused"), "webhook is not reachable yet")
99			}
100		}, 2*time.Minute, 5*time.Second).Should(Succeed())
101	}
102	
103	func deployManager() {
104		By("creating manager namespace")
105		nsManifest := fmt.Sprintf(`{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"%s"}}`, namespace)
106		cmd := exec.Command("kubectl", "apply", "-f", "-")
107		cmd.Stdin = strings.NewReader(nsManifest)
108		_, err := utils.Run(cmd)
109		Expect(err).NotTo(HaveOccurred(), "Failed to create namespace")
110	
111		By("labeling the namespace to enforce the restricted security policy")
112		cmd = exec.Command("kubectl", "label", "--overwrite", "ns", namespace,
113			"pod-security.kubernetes.io/enforce=restricted")
114		_, err = utils.Run(cmd)
115		Expect(err).NotTo(HaveOccurred(), "Failed to label namespace")
116	
117		By("installing CRDs")
118		cmd = exec.Command("make", "install")
119		_, err = utils.Run(cmd)
120		Expect(err).NotTo(HaveOccurred(), "Failed to install CRDs")
121	
122		By("deploying the controller-manager")
123		cmd = exec.Command("make", "deploy", fmt.Sprintf("IMG=%s", managerImage))
124		_, err = utils.Run(cmd)
125		Expect(err).NotTo(HaveOccurred(), "Failed to deploy the controller-manager")
126	
127		By("restarting the controller-manager to ensure the freshly built image is used")
128		cmd = exec.Command("kubectl", "rollout", "restart", "-n", namespace, "deployment/paprika-controller-manager")
129		_, err = utils.Run(cmd)
130		Expect(err).NotTo(HaveOccurred(), "Failed to restart the controller-manager")
131	
132		By("waiting for the operator deployment to be ready")
133		cmd = exec.Command("kubectl", "wait", "--for=condition=available", "-n", namespace,
134			"deployment/paprika-controller-manager", "--timeout=180s")
135		_, err = utils.Run(cmd)
136		Expect(err).NotTo(HaveOccurred(), "Operator deployment not available")
137	
138		By("waiting for webhook CA bundles to be injected")
139		waitForWebhookCA()
140	}
141	
142	func teardownManager() {
143		By("stopping port-forward for the UI dashboard")
144		if portForwardCmd != nil && portForwardCmd.Process != nil {
145			_ = portForwardCmd.Process.Signal(syscall.SIGTERM)
146			_, _ = portForwardCmd.Process.Wait()
147		}
148	
149		By("deleting the demo app")
150		cmd := exec.Command("kubectl", "delete", "deployment", "paprika-demo", "-n", namespace, "--ignore-not-found")
151		_, _ = utils.Run(cmd)
152		cmd = exec.Command("kubectl", "delete", "service", "paprika-demo", "-n", namespace, "--ignore-not-found")
153		_, _ = utils.Run(cmd)
154	
155		By("cleaning up the curl pod for metrics")
156		cmd = exec.Command("kubectl", "delete", "pod", "curl-metrics", "-n", namespace, "--ignore-not-found")
157		_, _ = utils.Run(cmd)
158	
159		By("deleting the metrics ClusterRoleBinding")
160		cmd = exec.Command("kubectl", "delete", "clusterrolebinding", metricsRoleBindingName, "--ignore-not-found")
161		_, _ = utils.Run(cmd)
162	
163		By("undeploying the controller-manager")
164		cmd = exec.Command("make", "undeploy")
165		_, _ = utils.Run(cmd)
166	
167		By("uninstalling CRDs")
168		cmd = exec.Command("make", "uninstall", "ignore-not-found=true")
169		_, _ = utils.Run(cmd)
170	
171		By("removing manager namespace")
172		cmd = exec.Command("kubectl", "delete", "ns", namespace, "--ignore-not-found")
173		_, _ = utils.Run(cmd)
174	}
175	
176	var _ = Describe("Manager", Ordered, func() {
177		var controllerPodName string
178	
179		BeforeAll(func() {
180			By("deploying the demo app")
181			demoApp := fmt.Sprintf(`{
182				"apiVersion": "apps/v1",
183				"kind": "Deployment",
184				"metadata": {"name": "paprika-demo", "namespace": "%s"},
185				"spec": {
186					"replicas": 1,
187					"selector": {"matchLabels": {"app": "paprika-demo"}},
188					"template": {
189						"metadata": {"labels": {"app": "paprika-demo"}},
190						"spec": {
191							"serviceAccountName": "%s",
192							"securityContext": {"runAsNonRoot": true, "runAsUser": 1000, "seccompProfile": {"type": "RuntimeDefault"}},
193							"containers": [{
194								"name": "demo",
195								"image": "%s",
196								"imagePullPolicy": "Never",
197								"ports": [{"containerPort": 8080}],
198								"securityContext": {
199									"allowPrivilegeEscalation": false,
200									"capabilities": {"drop": ["ALL"]},
201									"runAsNonRoot": true,
202									"runAsUser": 1000,
203									"seccompProfile": {"type": "RuntimeDefault"}
204								}
205							}]
206						}
207					}
208				}
209			}`, namespace, serviceAccountName, demoImage)
210			cmd := exec.Command("kubectl", "apply", "-f", "-")
211			cmd.Stdin = strings.NewReader(demoApp)
212			_, err := utils.Run(cmd)
213			Expect(err).NotTo(HaveOccurred(), "Failed to deploy the demo app")
214	
215			demoSvc := fmt.Sprintf(`{
216				"apiVersion": "v1",
217				"kind": "Service",
218				"metadata": {"name": "paprika-demo", "namespace": "%s"},
219				"spec": {
220					"selector": {"app": "paprika-demo"},
221					"ports": [{"port": 80, "targetPort": 8080}],
222					"type": "ClusterIP"
223				}
224			}`, namespace)
225			cmd = exec.Command("kubectl", "apply", "-f", "-")
226			cmd.Stdin = strings.NewReader(demoSvc)
227			_, err = utils.Run(cmd)
228			Expect(err).NotTo(HaveOccurred(), "Failed to create demo app service")
229	
230			By("waiting for the operator deployment to be ready")
231			cmd = exec.Command("kubectl", "wait", "--for=condition=available", "-n", namespace,
232				"deployment/paprika-controller-manager", "--timeout=120s")
233			_, err = utils.Run(cmd)
234			Expect(err).NotTo(HaveOccurred(), "Operator deployment not available")
235	
236			By("starting port-forward for the operator UI (port 3000)")
237			pfCmd := exec.Command("kubectl", "port-forward", "-n", namespace,
238				"deployment/paprika-controller-manager", "4000:3000")
239			err = pfCmd.Start()
240			Expect(err).NotTo(HaveOccurred(), "Failed to start port-forward for operator UI")
241			portForwardCmd = pfCmd
242	
243			By("waiting for the port-forward to be ready")
244			verifyPortForward := func(g Gomega) {
245				resp, err := http.Get("http://localhost:4000/")
246				g.Expect(err).NotTo(HaveOccurred(), "Port-forward not yet ready")
247				defer resp.Body.Close()
248				g.Expect(resp.StatusCode).To(Equal(http.StatusOK))
249			}
250			Eventually(verifyPortForward, 30*time.Second, time.Second).Should(Succeed())
251	
252			By("waiting for webhook CA bundles to be injected")
253			waitForWebhookCA()
254		})
255	
256		AfterEach(func() {
257			specReport := CurrentSpecReport()
258			if specReport.Failed() {
259				By("Fetching controller manager pod logs")
260				cmd := exec.Command("kubectl", "logs", controllerPodName, "-n", namespace)
261				controllerLogs, err := utils.Run(cmd)
262				if err == nil {
263					_, _ = fmt.Fprintf(GinkgoWriter, "Controller logs:\n %s", controllerLogs)
264				} else {
265					_, _ = fmt.Fprintf(GinkgoWriter, "Failed to get Controller logs: %s", err)
266				}
267	
268				By("Fetching Kubernetes events")
269				cmd = exec.Command("kubectl", "get", "events", "-n", namespace, "--sort-by=.lastTimestamp")
270				eventsOutput, err := utils.Run(cmd)
271				if err == nil {
272					_, _ = fmt.Fprintf(GinkgoWriter, "Kubernetes events:\n%s", eventsOutput)
273				} else {
274					_, _ = fmt.Fprintf(GinkgoWriter, "Failed to get Kubernetes events: %s", err)
275				}
276	
277				By("Fetching curl-metrics logs")
278				cmd = exec.Command("kubectl", "logs", "curl-metrics", "-n", namespace)
279				metricsOutput, err := utils.Run(cmd)
280				if err == nil {
281					_, _ = fmt.Fprintf(GinkgoWriter, "Metrics logs:\n %s", metricsOutput)
282				} else {
283					_, _ = fmt.Fprintf(GinkgoWriter, "Failed to get curl-metrics logs: %s", err)
284				}
285	
286				By("Fetching controller manager pod description")
287				cmd = exec.Command("kubectl", "describe", "pod", controllerPodName, "-n", namespace)
288				podDescription, err := utils.Run(cmd)
289				if err == nil {
290					fmt.Println("Pod description:\n", podDescription)
291				} else {
292					fmt.Println("Failed to describe controller pod")
293				}
294			}
295		})
296	
297		SetDefaultEventuallyTimeout(2 * time.Minute)
298		SetDefaultEventuallyPollingInterval(time.Second)
299	
300		Context("Pipeline", func() {
<system>300 lines read from file starting from line 1. Total lines in file: 2124.</system>

</details>

<details><summary>Thinking</summary>

The e2e file is large. We need know how to add an apply test. We can create a separate file `test/e2e/apply_test.go` with a Ginkgo spec. It should deploy a sample manifest via `paprika apply` CLI. Need build CLI binary? The suite may build `bin/paprika`. Check suite_test.go.

</details>

#### Tool Call: Read (`.worktrees/paprika-apply-cli/test/e2e/e2e_suite_test.go`)
<!-- call_id: tool_stzoto2t1T61DMCrfX2mLs9r -->
```json
{
  "path": ".worktrees/paprika-apply-cli/test/e2e/e2e_suite_test.go",
  "n_lines": 300
}
```

<details><summary>Tool Result: Read (`.worktrees/paprika-apply-cli/test/e2e/e2e_suite_test.go`)</summary>

<!-- call_id: tool_stzoto2t1T61DMCrfX2mLs9r -->
1	//go:build e2e
2	// +build e2e
3	
4	/*
5	Copyright 2026.
6	
7	Licensed under the Apache License, Version 2.0 (the "License");
8	you may not use this file except in compliance with the License.
9	You may obtain a copy of the License at
10	
11	    http://www.apache.org/licenses/LICENSE-2.0
12	
13	Unless required by applicable law or agreed to in writing, software
14	distributed under the License is distributed on an "AS IS" BASIS,
15	WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
16	See the License for the specific language governing permissions and
17	limitations under the License.
18	*/
19	
20	package e2e
21	
22	import (
23		"fmt"
24		"os"
25		"os/exec"
26		"strings"
27		"testing"
28	
29		. "github.com/onsi/ginkgo/v2"
30		. "github.com/onsi/gomega"
31	
32		"github.com/benebsworth/paprika/test/utils"
33	)
34	
35	var (
36		managerImage = "example.com/paprika:v0.0.1"
37		demoImage    = "localhost/paprika-demo:latest"
38	
39		kindClusterName          = "paprika-test-e2e"
40		shouldCleanupCertManager = false
41		shouldCleanupKindCluster = false
42		oldKubeRC                string
43	)
44	
45	func TestE2E(t *testing.T) {
46		RegisterFailHandler(Fail)
47		_, _ = fmt.Fprintf(GinkgoWriter, "Starting paprika e2e test suite\n")
48		RunSpecs(t, "e2e suite")
49	}
50	
51	var _ = BeforeSuite(func() {
52		By("checking for existing Kind cluster")
53		clusterExists, err := kindClusterExists(kindClusterName)
54		ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to check Kind clusters")
55	
56		if !clusterExists {
57			By(fmt.Sprintf("creating Kind cluster %q", kindClusterName))
58			cmd := exec.Command("kind", "create", "cluster", "--name", kindClusterName)
59			_, err := utils.Run(cmd)
60			ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to create Kind cluster")
61			shouldCleanupKindCluster = true
62		} else {
63			_, _ = fmt.Fprintf(GinkgoWriter, "Kind cluster %q already exists. Skipping creation.\n", kindClusterName)
64			By("switching kubectl context to Kind cluster")
65			cmd := exec.Command("kubectl", "config", "use-context", fmt.Sprintf("kind-%s", kindClusterName))
66			_, err := utils.Run(cmd)
67			ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to switch kubectl context")
68		}
69	
70		if !skipImageBuild() {
71			By("building the manager image")
72			cmd := exec.Command("make", "docker-build", fmt.Sprintf("IMG=%s", managerImage))
73			_, err = utils.Run(cmd)
74			ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to build the manager image")
75		} else {
76			_, _ = fmt.Fprintf(GinkgoWriter, "Skipping manager image build (E2E_SKIP_IMAGE_BUILD=true)\n")
77		}
78	
79		if !skipImageLoad() {
80			By("loading the manager image on Kind")
81			err = utils.LoadImageToKindClusterWithName(managerImage, kindClusterName)
82			ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to load the manager image into Kind")
83		} else {
84			_, _ = fmt.Fprintf(GinkgoWriter, "Skipping manager image load (E2E_SKIP_IMAGE_LOAD=true)\n")
85		}
86	
87		if !skipImageBuild() {
88			By("building the demo app image")
89			cmd := exec.Command("docker", "build", "-t", demoImage, "-f", "demo/Dockerfile", "demo")
90			_, err = utils.Run(cmd)
91			ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to build the demo image")
92		} else {
93			_, _ = fmt.Fprintf(GinkgoWriter, "Skipping demo image build (E2E_SKIP_IMAGE_BUILD=true)\n")
94		}
95	
96		if !skipImageLoad() {
97			By("loading the demo app image on Kind")
98			err = utils.LoadImageToKindClusterWithName(demoImage, kindClusterName)
99			ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to load the demo image into Kind")
100		} else {
101			_, _ = fmt.Fprintf(GinkgoWriter, "Skipping demo image load (E2E_SKIP_IMAGE_LOAD=true)\n")
102		}
103	
104		configureKubectlKubeRC()
105		setupCertManager()
106		deployManager()
107	})
108	
109	var _ = AfterSuite(func() {
110		teardownManager()
111		teardownCertManager()
112	
113		if oldKubeRC == "" {
114			_ = os.Unsetenv("KUBECTL_KUBERC")
115		} else {
116			_ = os.Setenv("KUBECTL_KUBERC", oldKubeRC)
117		}
118	
119		if shouldCleanupKindCluster {
120			By(fmt.Sprintf("deleting Kind cluster %q", kindClusterName))
121			cmd := exec.Command("kind", "delete", "cluster", "--name", kindClusterName)
122			_, err := utils.Run(cmd)
123			if err != nil {
124				_, _ = fmt.Fprintf(GinkgoWriter, "Failed to delete Kind cluster: %v\n", err)
125			}
126		}
127	})
128	
129	func skipImageBuild() bool {
130		return os.Getenv("E2E_SKIP_IMAGE_BUILD") == "true"
131	}
132	
133	func skipImageLoad() bool {
134		return os.Getenv("E2E_SKIP_IMAGE_LOAD") == "true"
135	}
136	
137	func kindClusterExists(name string) (bool, error) {
138		cmd := exec.Command("kind", "get", "clusters")
139		out, err := cmd.CombinedOutput()
140		if err != nil {
141			return false, fmt.Errorf("failed to list Kind clusters: %w", err)
142		}
143		for _, line := range strings.Split(string(out), "\n") {
144			if strings.TrimSpace(line) == name {
145				return true, nil
146			}
147		}
148		return false, nil
149	}
150	
151	func configureKubectlKubeRC() {
152		oldKubeRC = os.Getenv("KUBECTL_KUBERC")
153		if oldKubeRC != "true" {
154			By("disabling kubectl kuberc for test isolation")
155			err := os.Setenv("KUBECTL_KUBERC", "false")
156			ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to disable kubectl kuberc")
157			_, _ = fmt.Fprintf(GinkgoWriter,
158				"kubectl kuberc disabled for consistent test behavior (override with KUBECTL_KUBERC=true)\n")
159		} else {
160			_, _ = fmt.Fprintf(GinkgoWriter, "kubectl kuberc enabled (KUBECTL_KUBERC=true)\n")
161		}
162	}
163	
164	func setupCertManager() {
165		if os.Getenv("CERT_MANAGER_INSTALL_SKIP") == "true" {
166			_, _ = fmt.Fprintf(GinkgoWriter, "Skipping CertManager installation (CERT_MANAGER_INSTALL_SKIP=true)\n")
167			return
168		}
169	
170		By("checking if CertManager is already installed")
171		if utils.IsCertManagerCRDsInstalled() {
172			_, _ = fmt.Fprintf(GinkgoWriter, "CertManager is already installed. Skipping installation.\n")
173			return
174		}
175	
176		shouldCleanupCertManager = true
177	
178		By("installing CertManager")
179		Expect(utils.InstallCertManager()).To(Succeed(), "Failed to install CertManager")
180	}
181	
182	func teardownCertManager() {
183		if !shouldCleanupCertManager {
184			_, _ = fmt.Fprintf(GinkgoWriter, "Skipping CertManager cleanup (not installed by this suite)\n")
185			return
186		}
187	
188		By("uninstalling CertManager")
189		utils.UninstallCertManager()
190	}
<system>190 lines read from file starting from line 1. Total lines in file: 190. End of file reached.</system>

</details>

<details><summary>Thinking</summary>

The E2E suite deploys manager. The apply test would need to use the CLI binary. We need build CLI? The suite doesn't build CLI. We could build `bin/paprika` in the test or rely on existing. The `make build-cli` target likely exists. But running CLI in e2e against API server: the API server is embedded in controller-manager? The manager deployment exposes port 3000? The `portForwardCmd` forwards deployment/paprika-controller-manager 4000:3000. The CLI default server is localhost:3000, but port-forward is 4000. The test could run with `--server http://localhost:4000` or set env. Or create a port-forward on 3000. The existing e2e already port-forwards to 4000 for UI. We can use that.

We need create a test file with build tag e2e. It can be a separate `Describe` block. We need create testdata manifest, e.g. `test/e2e/testdata/apply/deployment.yaml`. The test should run `bin/paprika apply -f testdata --server http://localhost:4000 -n e2e-apply --name e2e-apply --wait --timeout 2m`. Then assert Application/Release/Deployment healthy. Also test policy block maybe.

But before writing, we need ensure the CLI binary is built in e2e suite. We can add a step in BeforeSuite to build CLI or in test. Since `make test-e2e` may not build CLI. We can call `make build-cli` in BeforeSuite or in test. Better in test `BeforeAll` within Describe, build CLI.

Given local e2e is blocked, we can write test and run in CI. But we should at least compile test with `go test -tags e2e -c`? The e2e tests use Ginkgo; compile may succeed. We can run `go test ./test/e2e -tags e2e -run TestE2E -c` to compile. But we can't run without cluster.

We can also implement handler hardening and UI generate script. But maybe focus on E2E test first.

However the user wants "next big chunks". Maybe instead of closing small gaps, we should move to Approval Gates, which is a new big feature. The apply feature has functional gaps but is mostly usable. The user might prefer new big chunk. We should ask? We already asked once; we can ask again with options: "apply is mostly done; should I finish the remaining gaps or move to Approval Gates?" This is a meaningful decision. Use AskUserQuestion. But the instruction says avoid overusing. Yet this is a genuine fork. Let's do it.

But before asking, we can present audit summary. Then ask.

</details>

#### Tool Call: AskUserQuestion
<!-- call_id: tool_m9d4WddKQSmES9xdC1KOigPo -->
```json
{
  "questions": [
    {
      "question": "`paprika apply -f` is already ~90% implemented. What should I do next?",
      "options": [
        {
          "label": "Close out the remaining apply gaps first",
          "description": "Add the missing E2E test, harden the ApplyBundle handler (idempotency, supersede, derive-name), add the UI generate script, and add the release-controller inline unit test. Then move on."
        },
        {
          "label": "Move straight to Approval Gates",
          "description": "Leave the apply gaps as-is and start designing/implementing Approval Gates (manual/webhook/Slack gates between stages), the next high-priority P2 feature."
        }
      ]
    }
  ]
}
```

<details><summary>Tool Result: AskUserQuestion</summary>

<!-- call_id: tool_m9d4WddKQSmES9xdC1KOigPo -->
{"answers":{"`paprika apply -f` is already ~90% implemented. What should I do next?":"Close out the remaining apply gaps first"}}

</details>

<details><summary>Thinking</summary>

User wants close gaps first. Good. We need implement them. We can use subagent-driven-development. The gaps are independent enough:
- UI generate script (small)
- ApplyBundle handler hardening (medium, touches internal/api/apply_bundle.go and tests)
- Release controller inline unit test (small)
- E2E apply test (medium)

We can dispatch implementer subagents sequentially. Since these are independent, but the skill says don't dispatch multiple implementation subagents in parallel. We'll do one at a time.

But before that, we need check current ApplyBundle handler to understand deviations. Read internal/api/apply_bundle.go.

</details>

#### Tool Call: Read (`.worktrees/paprika-apply-cli/internal/api/apply_bundle.go`)
<!-- call_id: tool_bNCtRpJndtmyqdjGMVOS2EV1 -->
```json
{
  "path": ".worktrees/paprika-apply-cli/internal/api/apply_bundle.go",
  "n_lines": 500
}
```

<details><summary>Tool Result: Read (`.worktrees/paprika-apply-cli/internal/api/apply_bundle.go`)</summary>

<!-- call_id: tool_bNCtRpJndtmyqdjGMVOS2EV1 -->
1	package apiserver
2	
3	import (
4		"context"
5		"crypto/sha256"
6		"encoding/hex"
7		"errors"
8		"fmt"
9		"strings"
10		"time"
11	
12		"connectrpc.com/connect"
13		"gopkg.in/yaml.v3"
14		corev1 "k8s.io/api/core/v1"
15		apierrors "k8s.io/apimachinery/pkg/api/errors"
16		metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
17		"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
18		"k8s.io/apimachinery/pkg/types"
19		"k8s.io/client-go/util/retry"
20		"sigs.k8s.io/controller-runtime/pkg/client"
21		"sigs.k8s.io/controller-runtime/pkg/log"
22		k8syaml "sigs.k8s.io/yaml"
23	
24		pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
25		policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
26		paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
27		"github.com/benebsworth/paprika/internal/engine"
28		"github.com/benebsworth/paprika/internal/governance"
29		"github.com/benebsworth/paprika/internal/policy"
30	)
31	
32	// PaprikaServer RBAC for ApplyBundle.
33	// +kubebuilder:rbac:groups=policy.paprika.io,resources=policies,verbs=get;list;watch
34	// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications,verbs=get;list;watch;create;update;patch
35	// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications/status,verbs=get;update;patch
36	// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=stages,verbs=get;list;watch;create;update;patch
37	// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=releases,verbs=get;list;watch;create;update;patch;delete
38	// +kubebuilder:rbac:groups=core,resources=configmaps,verbs=get;list;watch;create;update;patch;delete
39	// +kubebuilder:rbac:groups=core,resources=namespaces,verbs=get;list;watch;create
40	
41	const (
42		managedByLabel     = "app.paprika.io/managed-by"
43		nameLabel          = "app.paprika.io/name"
44		releaseLabel       = "app.paprika.io/release"
45		historyLabel       = "app.paprika.io/history"
46		projectLabelKey    = "app.paprika.io/project"
47		defaultProjectName = "default"
48		rollbackAnnotation = "paprika.io/rollback-requested"
49	)
50	
51	// WithPolicyEvaluator sets the policy evaluator used by ApplyBundle.
52	func WithPolicyEvaluator(e Evaluator) ServerOption {
53		return func(s *PaprikaServer) { s.evaluator = e }
54	}
55	
56	// WithGovernanceValidator sets the project boundary validator used by ApplyBundle.
57	func WithGovernanceValidator(v *governance.ProjectValidator) ServerOption {
58		return func(s *PaprikaServer) { s.governanceValidator = v }
59	}
60	
61	// WithGovernancePolicyEvaluator sets the project-scoped policy evaluator used by ApplyBundle.
62	func WithGovernancePolicyEvaluator(e *governance.PolicyEvaluator) ServerOption {
63		return func(s *PaprikaServer) { s.governancePolicyEvaluator = e }
64	}
65	
66	// ApplyBundle accepts a rendered manifest bundle and creates or updates the
67	// Application, Stage, Release, and manifest snapshot ConfigMap for an inline
68	// apply. It evaluates policies before any mutating operation and honours
69	// dry-run.
70	//
71	//nolint:cyclop // project resolution + validation + policy evaluation flow.
72	func (s *PaprikaServer) ApplyBundle(
73		ctx context.Context,
74		req *connect.Request[paprikav1.ApplyBundleRequest],
75	) (*connect.Response[paprikav1.ApplyBundleResponse], error) {
76		namespace := req.Msg.Namespace
77		if namespace == "" {
78			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("namespace is required"))
79		}
80		appName := req.Msg.Name
81		if appName == "" {
82			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("application name is required"))
83		}
84		project := req.Msg.Project
85		if project == "" {
86			project = defaultProjectName
87		}
88	
89		if err := s.ensureNamespace(ctx, namespace); err != nil {
90			return nil, fmt.Errorf("ensure namespace: %w", err)
91		}
92	
93		bundle, err := s.prepareBundle(req.Msg.Manifests, namespace)
94		if err != nil {
95			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("prepare bundle: %w", err))
96		}
97	
98		var manifests []*unstructured.Unstructured
99		if s.governanceValidator != nil || s.governancePolicyEvaluator != nil {
100			manifests, err = manifestsFromBundle(bundle)
101			if err != nil {
102				return nil, fmt.Errorf("parse bundle: %w", err)
103			}
104		}
105	
106		var boundaryResults []policy.Result
107		if s.governanceValidator != nil {
108			source := pipelinesv1alpha1.ApplicationSource{
109				Type:   pipelinesv1alpha1.SourceTypeInline,
110				Inline: &pipelinesv1alpha1.InlineSourceSpec{ConfigMapRef: ""},
111			}
112	
113			projectObj, resolveErr := s.governanceValidator.ResolveProject(ctx, namespace, project)
114			if resolveErr != nil {
115				return nil, fmt.Errorf("resolve project: %w", resolveErr)
116			}
117	
118			violations, vErr := s.governanceValidator.ValidateBundle(ctx, projectObj, source, nil, namespace, "", manifests)
119			if vErr != nil {
120				return nil, fmt.Errorf("validate bundle: %w", vErr)
121			}
122			if blocking := violations.Blocking(); len(blocking) > 0 {
123				return connect.NewResponse(&paprikav1.ApplyBundleResponse{
124					PolicyResults: convertViolationsToPolicyResults(violations),
125					Blocked:       true,
126					BlockReason:   blocking[0].Message,
127				}), nil
128			}
129			boundaryResults = toPolicyResults(violations)
130		}
131	
132		var evResult *policy.EvaluationResult
133		if s.governancePolicyEvaluator != nil {
134			evResult, err = s.evaluatePoliciesForProject(ctx, project, manifests, namespace, appName, req.Msg.SkipPolicies, req.Msg.PolicyOverrides)
135		} else {
136			evResult, err = s.evaluatePolicies(ctx, bundle, namespace, appName, req.Msg.SkipPolicies, req.Msg.PolicyOverrides)
137		}
138		if err != nil {
139			return nil, fmt.Errorf("evaluate policies: %w", err)
140		}
141		evResult.Results = append(evResult.Results, boundaryResults...)
142	
143		if evResult.Blocked {
144			return connect.NewResponse(&paprikav1.ApplyBundleResponse{
145				PolicyResults: convertPolicyResults(evResult.Results),
146				Blocked:       true,
147				BlockReason:   evResult.Message,
148			}), nil
149		}
150	
151		if req.Msg.DryRun {
152			app := s.buildApplication(appName, namespace, "", project)
153			rel := s.buildRelease(appName, namespace, "", project, bundle, evResult.Results)
154			return connect.NewResponse(&paprikav1.ApplyBundleResponse{
155				Application:   convertApplication(app),
156				Release:       convertRelease(rel),
157				PolicyResults: convertPolicyResults(evResult.Results),
158				Blocked:       false,
159			}), nil
160		}
161	
162		app, release, err := s.applyInline(ctx, appName, namespace, project, bundle, evResult.Results)
163		if err != nil {
164			return nil, fmt.Errorf("apply inline bundle: %w", err)
165		}
166	
167		return connect.NewResponse(&paprikav1.ApplyBundleResponse{
168			Application:   convertApplication(app),
169			Release:       convertRelease(release),
170			PolicyResults: convertPolicyResults(evResult.Results),
171			Blocked:       false,
172		}), nil
173	}
174	
175	func (s *PaprikaServer) ensureNamespace(ctx context.Context, namespace string) error {
176		var ns corev1.Namespace
177		if err := s.client.Get(ctx, types.NamespacedName{Name: namespace}, &ns); err != nil {
178			if !apierrors.IsNotFound(err) {
179				return fmt.Errorf("get namespace: %w", err)
180			}
181			ns.Name = namespace
182			if err := s.client.Create(ctx, &ns); err != nil {
183				return fmt.Errorf("create namespace: %w", err)
184			}
185		}
186		return nil
187	}
188	
189	func (s *PaprikaServer) prepareBundle(raw []byte, namespace string) ([]byte, error) {
190		if len(raw) == 0 {
191			return nil, errors.New("empty manifest bundle")
192		}
193		docs := engine.SplitYAMLDocuments(raw)
194		outDocs := make([]string, 0, len(docs))
195		for _, doc := range docs {
196			prepared, err := prepareDocument(doc, namespace)
197			if err != nil {
198				return nil, fmt.Errorf("prepare document: %w", err)
199			}
200			if prepared == "" {
201				continue
202			}
203			outDocs = append(outDocs, prepared)
204		}
205		if len(outDocs) == 0 {
206			return nil, errors.New("no valid manifests in bundle")
207		}
208		var b strings.Builder
209		for i, d := range outDocs {
210			if i > 0 {
211				b.WriteString("\n---\n")
212			}
213			b.WriteString(d)
214		}
215		return []byte(b.String()), nil
216	}
217	
218	func manifestsFromBundle(bundle []byte) ([]*unstructured.Unstructured, error) {
219		docs := engine.SplitYAMLDocuments(bundle)
220		var out []*unstructured.Unstructured
221		for _, doc := range docs {
222			obj := &unstructured.Unstructured{}
223			if err := k8syaml.Unmarshal(doc, &obj.Object); err != nil {
224				return nil, fmt.Errorf("unmarshal manifest: %w", err)
225			}
226			if obj.Object != nil {
227				out = append(out, obj)
228			}
229		}
230		return out, nil
231	}
232	
233	func prepareDocument(doc []byte, namespace string) (string, error) {
234		trimmed := strings.TrimSpace(string(doc))
235		if trimmed == "" {
236			return "", nil
237		}
238		obj := &unstructured.Unstructured{}
239		if err := k8syaml.Unmarshal([]byte(trimmed), &obj.Object); err != nil {
240			return "", fmt.Errorf("unmarshal manifest: %w", err)
241		}
242		if obj.Object == nil {
243			return "", nil
244		}
245		if obj.GetNamespace() == "" {
246			obj.SetNamespace(namespace)
247		}
248		objLabels := obj.GetLabels()
249		if objLabels == nil {
250			objLabels = map[string]string{}
251		}
252		objLabels[managedByLabel] = "paprika"
253		objLabels[nameLabel] = obj.GetName()
254		obj.SetLabels(objLabels)
255	
256		bytes, err := yaml.Marshal(obj.Object)
257		if err != nil {
258			return "", fmt.Errorf("marshal manifest: %w", err)
259		}
260		return string(bytes), nil
261	}
262	
263	func (s *PaprikaServer) evaluatePolicies(
264		ctx context.Context,
265		bundle []byte,
266		namespace, appName string,
267		skip []string,
268		overrides map[string]string,
269	) (*policy.EvaluationResult, error) {
270		opts := policy.EvaluateOptions{
271			Namespace:       namespace,
272			ApplicationName: appName,
273			SkipPolicies:    skip,
274			PolicyOverrides: toPolicyActions(overrides),
275		}
276		if s.evaluator != nil {
277			res, err := s.evaluator.Evaluate(ctx, bundle, opts)
278			if err != nil {
279				return nil, fmt.Errorf("policy evaluator: %w", err)
280			}
281			return res, nil
282		}
283	
284		var polList policyv1alpha1.PolicyList
285		if err := s.client.List(ctx, &polList); err != nil {
286			return nil, fmt.Errorf("list policies: %w", err)
287		}
288		pols := make([]policyv1alpha1.Policy, len(polList.Items))
289		copy(pols, polList.Items)
290		ev := policy.NewCELEvaluator(pols)
291		res, err := ev.Evaluate(ctx, bundle, opts)
292		if err != nil {
293			return nil, fmt.Errorf("policy evaluator: %w", err)
294		}
295		return res, nil
296	}
297	
298	func (s *PaprikaServer) evaluatePoliciesForProject(
299		ctx context.Context,
300		project string,
301		manifests []*unstructured.Unstructured,
302		namespace, appName string,
303		skip []string,
304		overrides map[string]string,
305	) (*policy.EvaluationResult, error) {
306		opts := policy.EvaluateOptions{
307			Namespace:       namespace,
308			ApplicationName: appName,
309			SkipPolicies:    skip,
310			PolicyOverrides: toPolicyActions(overrides),
311		}
312		violations, err := s.governancePolicyEvaluator.Evaluate(ctx, project, manifests, opts)
313		if err != nil {
314			return nil, fmt.Errorf("evaluate project policies: %w", err)
315		}
316		results := make([]policy.Result, 0, len(violations))
317		passed := true
318		blocked := false
319		var message string
320		for _, v := range violations {
321			results = append(results, violationToPolicyResult(v))
322			if v.Blocking() {
323				passed = false
324				blocked = true
325				message = v.Message
326			} else if message == "" {
327				message = v.Message
328			}
329		}
330		return &policy.EvaluationResult{Passed: passed, Blocked: blocked, Message: message, Results: results}, nil
331	}
332	
333	func violationToPolicyResult(v governance.Violation) policy.Result {
334		return policy.Result{
335			Name:     v.Rule,
336			Severity: v.Severity,
337			Action:   string(v.Action),
338			Passed:   false,
339			Message:  v.Message,
340		}
341	}
342	
343	func toPolicyResults(violations governance.Violations) []policy.Result {
344		out := make([]policy.Result, 0, len(violations))
345		for _, v := range violations {
346			out = append(out, violationToPolicyResult(v))
347		}
348		return out
349	}
350	
351	func convertViolationsToPolicyResults(violations governance.Violations) []*paprikav1.PolicyResult {
352		out := make([]*paprikav1.PolicyResult, 0, len(violations))
353		for _, v := range violations {
354			converted := violationToPolicyResult(v)
355			out = append(out, &paprikav1.PolicyResult{
356				Name:     converted.Name,
357				Severity: converted.Severity,
358				Action:   converted.Action,
359				Passed:   converted.Passed,
360				Message:  converted.Message,
361			})
362		}
363		return out
364	}
365	
366	func toPolicyActions(in map[string]string) map[string]policy.Action {
367		if len(in) == 0 {
368			return nil
369		}
370		out := make(map[string]policy.Action, len(in))
371		for k, v := range in {
372			out[k] = policy.Action(v)
373		}
374		return out
375	}
376	
377	//nolint:cyclop // inline apply orchestration is inherently sequential.
378	func (s *PaprikaServer) applyInline(
379		ctx context.Context,
380		appName, namespace, project string,
381		bundle []byte,
382		policyResults []policy.Result,
383	) (*pipelinesv1alpha1.Application, *pipelinesv1alpha1.Release, error) {
384		releaseName := generateReleaseName(appName, bundle)
385		snapshotName := releaseName + "-manifests"
386		stageName := appName + "-default"
387	
388		app, err := s.createOrUpdateApplication(ctx, appName, namespace, snapshotName, project)
389		if err != nil {
390			return nil, nil, fmt.Errorf("create or update application: %w", err)
391		}
392	
393		if err := s.ensureStage(ctx, appName, namespace, project, releaseName, stageName); err != nil {
394			return nil, nil, fmt.Errorf("ensure stage: %w", err)
395		}
396	
397		release := s.buildRelease(appName, namespace, snapshotName, project, bundle, policyResults)
398		release.OwnerReferences = []metav1.OwnerReference{{
399			APIVersion: pipelinesv1alpha1.GroupVersion.String(),
400			Kind:       "Application",
401			Name:       app.Name,
402			UID:        app.UID,
403			Controller: ptr(true),
404		}}
405		if err := s.client.Create(ctx, release); err != nil {
406			return nil, nil, fmt.Errorf("create release: %w", err)
407		}
408	
409		if err := s.createSnapshot(ctx, release, appName, namespace, project, snapshotName, releaseName, bundle); err != nil {
410			if delErr := s.client.Delete(ctx, release); delErr != nil {
411				log.FromContext(ctx).Error(delErr, "Failed to clean up release after snapshot error", "release", release.Name)
412			}
413			return nil, nil, fmt.Errorf("create manifest snapshot: %w", err)
414		}
415	
416		if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
417			var freshRelease pipelinesv1alpha1.Release
418			if err := s.client.Get(ctx, types.NamespacedName{Name: release.Name, Namespace: release.Namespace}, &freshRelease); err != nil {
419				return fmt.Errorf("fetching release for policy results: %w", err)
420			}
421			freshRelease.Status.PolicyResults = toReleasePolicyResults(policyResults)
422			if err := s.client.Status().Update(ctx, &freshRelease); err != nil {
423				return fmt.Errorf("updating release policy results: %w", err)
424			}
425			return nil
426		}); err != nil {
427			if delErr := s.client.Delete(ctx, release); delErr != nil {
428				log.FromContext(ctx).Error(delErr, "Failed to clean up release after policy result update error", "release", release.Name)
429			}
430			return nil, nil, fmt.Errorf("update release policy results: %w", err)
431		}
432	
433		if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
434			var freshApp pipelinesv1alpha1.Application
435			if err := s.client.Get(ctx, types.NamespacedName{Name: app.Name, Namespace: app.Namespace}, &freshApp); err != nil {
436				return fmt.Errorf("fetching application for releaseRef: %w", err)
437			}
438			freshApp.Status.ReleaseRef = release.Name
439			if err := s.client.Status().Update(ctx, &freshApp); err != nil {
440				return fmt.Errorf("updating application releaseRef: %w", err)
441			}
442			return nil
443		}); err != nil {
444			if delErr := s.client.Delete(ctx, release); delErr != nil {
445				log.FromContext(ctx).Error(delErr, "Failed to clean up release after application releaseRef update error", "release", release.Name)
446			}
447			return nil, nil, fmt.Errorf("update application releaseRef: %w", err)
448		}
449	
450		return app, release, nil
451	}
452	
453	func (s *PaprikaServer) createOrUpdateApplication(
454		ctx context.Context,
455		appName, namespace, snapshotName, project string,
456	) (*pipelinesv1alpha1.Application, error) {
457		app := s.buildApplication(appName, namespace, snapshotName, project)
458		var existing pipelinesv1alpha1.Application
459		if err := s.client.Get(ctx, client.ObjectKey{Namespace: namespace, Name: appName}, &existing); err != nil {
460			if !apierrors.IsNotFound(err) {
461				return nil, fmt.Errorf("get application: %w", err)
462			}
463			if err := s.client.Create(ctx, app); err != nil {
464				return nil, fmt.Errorf("create application: %w", err)
465			}
466			return app, nil
467		}
468		existing.Spec = app.Spec
469		if existing.Labels == nil {
470			existing.Labels = map[string]string{}
471		}
472		for k, v := range app.Labels {
473			existing.Labels[k] = v
474		}
475		if err := s.client.Update(ctx, &existing); err != nil {
476			return nil, fmt.Errorf("update application: %w", err)
477		}
478		return &existing, nil
479	}
480	
481	//nolint:nestif // label update path is straightforward.
482	func (s *PaprikaServer) ensureStage(
483		ctx context.Context,
484		appName, namespace, project, releaseName, stageName string,
485	) error {
486		labels := s.baseLabels(appName, releaseName, project)
487		stage := &pipelinesv1alpha1.Stage{
488			ObjectMeta: metav1.ObjectMeta{
489				Name:      stageName,
490				Namespace: namespace,
491				Labels:    labels,
492			},
493			Spec: pipelinesv1alpha1.StageSpec{
494				Name:      "default",
495				Ring:      1,
496				Templates: []string{},
497			},
498		}
499		if err := s.client.Create(ctx, stage); err != nil {
500			if !apierrors.IsAlreadyExists(err) {
<system>500 lines read from file starting from line 1. Total lines in file: 668.</system>

</details>

<details><summary>Thinking</summary>

Read rest.

</details>

#### Tool Call: Read (`.worktrees/paprika-apply-cli/internal/api/apply_bundle.go`)
<!-- call_id: tool_S8wp7cFoMOmHPOVZ2mRYReG3 -->
```json
{
  "path": ".worktrees/paprika-apply-cli/internal/api/apply_bundle.go",
  "line_offset": 501,
  "n_lines": 300
}
```

<details><summary>Tool Result: Read (`.worktrees/paprika-apply-cli/internal/api/apply_bundle.go`)</summary>

<!-- call_id: tool_S8wp7cFoMOmHPOVZ2mRYReG3 -->
501				return fmt.Errorf("create stage: %w", err)
502			}
503			var existing pipelinesv1alpha1.Stage
504			if getErr := s.client.Get(ctx, client.ObjectKey{Namespace: namespace, Name: stageName}, &existing); getErr != nil {
505				return fmt.Errorf("get existing stage: %w", getErr)
506			}
507			if existing.Labels == nil {
508				existing.Labels = map[string]string{}
509			}
510			changed := false
511			for k, v := range labels {
512				if existing.Labels[k] != v {
513					existing.Labels[k] = v
514					changed = true
515				}
516			}
517			if changed {
518				if updateErr := s.client.Update(ctx, &existing); updateErr != nil {
519					return fmt.Errorf("update stage labels: %w", updateErr)
520				}
521			}
522		}
523		return nil
524	}
525	
526	func (s *PaprikaServer) createSnapshot(
527		ctx context.Context,
528		release *pipelinesv1alpha1.Release,
529		appName, namespace, project, snapshotName, releaseName string,
530		bundle []byte,
531	) error {
532		cm := &corev1.ConfigMap{
533			ObjectMeta: metav1.ObjectMeta{
534				Name:      snapshotName,
535				Namespace: namespace,
536				Labels:    s.baseLabels(appName, releaseName, project),
537				OwnerReferences: []metav1.OwnerReference{{
538					APIVersion: pipelinesv1alpha1.GroupVersion.String(),
539					Kind:       "Release",
540					Name:       release.Name,
541					UID:        release.UID,
542					Controller: ptr(true),
543				}},
544			},
545			Data: map[string]string{
546				"manifests.yaml": string(bundle),
547			},
548		}
549		if err := s.client.Create(ctx, cm); err != nil {
550			return fmt.Errorf("create manifest snapshot: %w", err)
551		}
552		return nil
553	}
554	
555	func (s *PaprikaServer) buildApplication(appName, namespace, snapshotName, project string) *pipelinesv1alpha1.Application {
556		app := &pipelinesv1alpha1.Application{
557			ObjectMeta: metav1.ObjectMeta{
558				Name:      appName,
559				Namespace: namespace,
560				Labels: map[string]string{
561					managedByLabel:  "paprika",
562					projectLabelKey: project,
563				},
564			},
565			Spec: pipelinesv1alpha1.ApplicationSpec{
566				Project: project,
567				Source: pipelinesv1alpha1.ApplicationSource{
568					Type: pipelinesv1alpha1.SourceTypeInline,
569					Inline: &pipelinesv1alpha1.InlineSourceSpec{
570						ConfigMapRef: snapshotName,
571					},
572				},
573				Stages: []pipelinesv1alpha1.ApplicationPromotionStage{
574					{
575						Name: "default",
576						Ring: 1,
577					},
578				},
579				Strategy:   pipelinesv1alpha1.StrategyRolling,
580				SyncPolicy: pipelinesv1alpha1.SyncAuto,
581			},
582		}
583		if snapshotName != "" {
584			app.Spec.Source.Inline.ConfigMapRef = snapshotName
585		}
586		return app
587	}
588	
589	func (s *PaprikaServer) buildRelease(
590		appName, namespace, snapshotName, project string,
591		bundle []byte,
592		policyResults []policy.Result,
593	) *pipelinesv1alpha1.Release {
594		releaseName := generateReleaseName(appName, bundle)
595		return &pipelinesv1alpha1.Release{
596			ObjectMeta: metav1.ObjectMeta{
597				Name:      releaseName,
598				Namespace: namespace,
599				Labels:    s.baseLabels(appName, releaseName, project),
600				Annotations: map[string]string{
601					"paprika.io/bundle-sha": fullBundleSHA(bundle),
602				},
603			},
604			Spec: pipelinesv1alpha1.ReleaseSpec{
605				Pipeline: "",
606				Target:   appName + "-default",
607				ManifestSource: &pipelinesv1alpha1.ManifestSource{
608					ConfigMapRef: snapshotName,
609				},
610			},
611			Status: pipelinesv1alpha1.ReleaseStatus{
612				PolicyResults: toReleasePolicyResults(policyResults),
613			},
614		}
615	}
616	
617	func (s *PaprikaServer) baseLabels(appName, releaseName, project string) map[string]string {
618		return map[string]string{
619			managedByLabel:  "paprika",
620			nameLabel:       appName,
621			releaseLabel:    releaseName,
622			historyLabel:    "true",
623			projectLabelKey: project,
624		}
625	}
626	
627	func generateReleaseName(appName string, bundle []byte) string {
628		hash := sha256.Sum256(bundle)
629		short := hex.EncodeToString(hash[:4])
630		return fmt.Sprintf("%s-release-%s-%d", appName, short, time.Now().Unix())
631	}
632	
633	func fullBundleSHA(bundle []byte) string {
634		return hex.EncodeToString(bundleSHA(bundle))
635	}
636	
637	func bundleSHA(bundle []byte) []byte {
638		hash := sha256.Sum256(bundle)
639		return hash[:]
640	}
641	
642	func toReleasePolicyResults(results []policy.Result) []pipelinesv1alpha1.ReleasePolicyResult {
643		out := make([]pipelinesv1alpha1.ReleasePolicyResult, 0, len(results))
644		for _, r := range results {
645			out = append(out, pipelinesv1alpha1.ReleasePolicyResult{
646				Name:     r.Name,
647				Severity: r.Severity,
648				Action:   r.Action,
649				Passed:   r.Passed,
650				Message:  r.Message,
651			})
652		}
653		return out
654	}
655	
656	func convertPolicyResults(results []policy.Result) []*paprikav1.PolicyResult {
657		out := make([]*paprikav1.PolicyResult, 0, len(results))
658		for _, r := range results {
659			out = append(out, &paprikav1.PolicyResult{
660				Name:     r.Name,
661				Severity: r.Severity,
662				Action:   r.Action,
663				Passed:   r.Passed,
664				Message:  r.Message,
665			})
666		}
667		return out
668	}
<system>168 lines read from file starting from line 501. Total lines in file: 668. End of file reached.</system>

</details>

<details><summary>Thinking</summary>

The current ApplyBundle handler is quite different from plan. It includes governance. Hardening items: deriveAppName fallback when name empty, idempotency check, supersede previous terminal release, optimistic-lock loop, injectLabels (it uses prepareDocument which sets namespace and labels). We can implement these improvements. But it's a significant refactor. We should be careful not to break governance. We can add derive-name when empty, idempotency, supersede. Optimistic lock loop maybe less critical due to retry on status updates. But plan wanted it.

We also need check server.go for ApplyBundle method and converters.

</details>

#### Tool Call: Grep (`.worktrees/paprika-apply-cli/internal/api/server.go`)
<!-- call_id: tool_vmOhAc1Mep0nkXjJ6F0OJqAs -->
```json
{
  "path": ".worktrees/paprika-apply-cli/internal/api/server.go",
  "pattern": "ApplyBundle|convertApplication|convertRelease|convertPolicyResults",
  "output_mode": "content",
  "-n": true,
  "-C": 3
}
```

<details><summary>Tool Result: Grep (`.worktrees/paprika-apply-cli/internal/api/server.go`)</summary>

<!-- call_id: tool_vmOhAc1Mep0nkXjJ6F0OJqAs -->
.worktrees/paprika-apply-cli/internal/api/server.go-232-		if !s.authorizeProjectFromLabels(ctx, rel, auth.ResourceReleases) {
.worktrees/paprika-apply-cli/internal/api/server.go-233-			continue
.worktrees/paprika-apply-cli/internal/api/server.go-234-		}
.worktrees/paprika-apply-cli/internal/api/server.go:235:		releases = append(releases, convertRelease(rel))
.worktrees/paprika-apply-cli/internal/api/server.go-236-	}
.worktrees/paprika-apply-cli/internal/api/server.go-237-	return connect.NewResponse(&paprikav1.ListReleasesResponse{Releases: releases}), nil
.worktrees/paprika-apply-cli/internal/api/server.go-238-}
--
.worktrees/paprika-apply-cli/internal/api/server.go-284-		if err := s.authorizeProject(ctx, auth.ActionRead, auth.ResourceApplications, app.Namespace, project); err != nil {
.worktrees/paprika-apply-cli/internal/api/server.go-285-			continue
.worktrees/paprika-apply-cli/internal/api/server.go-286-		}
.worktrees/paprika-apply-cli/internal/api/server.go:287:		applications = append(applications, convertApplication(app))
.worktrees/paprika-apply-cli/internal/api/server.go-288-	}
.worktrees/paprika-apply-cli/internal/api/server.go-289-	return connect.NewResponse(&paprikav1.ListApplicationsResponse{Applications: applications}), nil
.worktrees/paprika-apply-cli/internal/api/server.go-290-}
--
.worktrees/paprika-apply-cli/internal/api/server.go-326-	}
.worktrees/paprika-apply-cli/internal/api/server.go-327-	sets := make([]*paprikav1.ApplicationSet, 0, len(list.Items))
.worktrees/paprika-apply-cli/internal/api/server.go-328-	for i := range list.Items {
.worktrees/paprika-apply-cli/internal/api/server.go:329:		sets = append(sets, convertApplicationSet(&list.Items[i]))
.worktrees/paprika-apply-cli/internal/api/server.go-330-	}
.worktrees/paprika-apply-cli/internal/api/server.go-331-	return connect.NewResponse(&paprikav1.ListApplicationSetsResponse{Applicationsets: sets}), nil
.worktrees/paprika-apply-cli/internal/api/server.go-332-}
--
.worktrees/paprika-apply-cli/internal/api/server.go-405-		return nil, fmt.Errorf("getting applicationset: %w", err)
.worktrees/paprika-apply-cli/internal/api/server.go-406-	}
.worktrees/paprika-apply-cli/internal/api/server.go-407-	return connect.NewResponse(&paprikav1.GetApplicationSetResponse{
.worktrees/paprika-apply-cli/internal/api/server.go:408:		Applicationset: convertApplicationSet(&set),
.worktrees/paprika-apply-cli/internal/api/server.go-409-	}), nil
.worktrees/paprika-apply-cli/internal/api/server.go-410-}
.worktrees/paprika-apply-cli/internal/api/server.go-411-
--
.worktrees/paprika-apply-cli/internal/api/server.go-422-		return nil, connect.NewError(connect.CodePermissionDenied, err)
.worktrees/paprika-apply-cli/internal/api/server.go-423-	}
.worktrees/paprika-apply-cli/internal/api/server.go-424-	return connect.NewResponse(&paprikav1.GetApplicationResponse{
.worktrees/paprika-apply-cli/internal/api/server.go:425:		Application: convertApplication(&app),
.worktrees/paprika-apply-cli/internal/api/server.go-426-	}), nil
.worktrees/paprika-apply-cli/internal/api/server.go-427-}
.worktrees/paprika-apply-cli/internal/api/server.go-428-
--
.worktrees/paprika-apply-cli/internal/api/server.go-454-	}
.worktrees/paprika-apply-cli/internal/api/server.go-455-
.worktrees/paprika-apply-cli/internal/api/server.go-456-	return connect.NewResponse(&paprikav1.SyncApplicationResponse{
.worktrees/paprika-apply-cli/internal/api/server.go:457:		Application: convertApplication(&refreshed),
.worktrees/paprika-apply-cli/internal/api/server.go-458-	}), nil
.worktrees/paprika-apply-cli/internal/api/server.go-459-}
.worktrees/paprika-apply-cli/internal/api/server.go-460-
--
.worktrees/paprika-apply-cli/internal/api/server.go-494-	}
.worktrees/paprika-apply-cli/internal/api/server.go-495-
.worktrees/paprika-apply-cli/internal/api/server.go-496-	return connect.NewResponse(&paprikav1.ApproveGateResponse{
.worktrees/paprika-apply-cli/internal/api/server.go:497:		Application: convertApplication(&refreshed),
.worktrees/paprika-apply-cli/internal/api/server.go-498-	}), nil
.worktrees/paprika-apply-cli/internal/api/server.go-499-}
.worktrees/paprika-apply-cli/internal/api/server.go-500-
--
.worktrees/paprika-apply-cli/internal/api/server.go-548-	}
.worktrees/paprika-apply-cli/internal/api/server.go-549-
.worktrees/paprika-apply-cli/internal/api/server.go-550-	return connect.NewResponse(&paprikav1.RollbackReleaseResponse{
.worktrees/paprika-apply-cli/internal/api/server.go:551:		Release: convertRelease(&refreshed),
.worktrees/paprika-apply-cli/internal/api/server.go-552-	}), nil
.worktrees/paprika-apply-cli/internal/api/server.go-553-}
.worktrees/paprika-apply-cli/internal/api/server.go-554-
--
.worktrees/paprika-apply-cli/internal/api/server.go-720-	}
.worktrees/paprika-apply-cli/internal/api/server.go-721-}
.worktrees/paprika-apply-cli/internal/api/server.go-722-
.worktrees/paprika-apply-cli/internal/api/server.go:723:func convertRelease(r *pipelinesv1alpha1.Release) *paprikav1.Release {
.worktrees/paprika-apply-cli/internal/api/server.go-724-	promos := make([]*paprikav1.Promotion, 0, len(r.Status.PromotionHistory))
.worktrees/paprika-apply-cli/internal/api/server.go-725-	for _, ph := range r.Status.PromotionHistory {
.worktrees/paprika-apply-cli/internal/api/server.go-726-		promos = append(promos, &paprikav1.Promotion{
--
.worktrees/paprika-apply-cli/internal/api/server.go-794-	return out
.worktrees/paprika-apply-cli/internal/api/server.go-795-}
.worktrees/paprika-apply-cli/internal/api/server.go-796-
.worktrees/paprika-apply-cli/internal/api/server.go:797:func convertApplication(a *pipelinesv1alpha1.Application) *paprikav1.Application {
.worktrees/paprika-apply-cli/internal/api/server.go-798-	stages := make([]*paprikav1.ApplicationStage, 0, len(a.Status.Stages))
.worktrees/paprika-apply-cli/internal/api/server.go-799-	for _, s := range a.Status.Stages {
.worktrees/paprika-apply-cli/internal/api/server.go-800-		stages = append(stages, &paprikav1.ApplicationStage{
--
.worktrees/paprika-apply-cli/internal/api/server.go-868-	}
.worktrees/paprika-apply-cli/internal/api/server.go-869-}
.worktrees/paprika-apply-cli/internal/api/server.go-870-
.worktrees/paprika-apply-cli/internal/api/server.go:871:func convertApplicationSet(set *pipelinesv1alpha1.ApplicationSet) *paprikav1.ApplicationSet {
.worktrees/paprika-apply-cli/internal/api/server.go-872-	phase := "NotReady"
.worktrees/paprika-apply-cli/internal/api/server.go-873-	for _, c := range set.Status.Conditions {
.worktrees/paprika-apply-cli/internal/api/server.go-874-		if c.Type == conditionTypeReady {

</details>

<details><summary>Thinking</summary>

We need inspect convertApplication and convertRelease to see if inline/manifest source/policy results are converted.

</details>

#### Tool Call: Read (`.worktrees/paprika-apply-cli/internal/api/server.go`)
<!-- call_id: tool_tBdzIRNEa7EeAvJUvXPlLTrp -->
```json
{
  "path": ".worktrees/paprika-apply-cli/internal/api/server.go",
  "line_offset": 723,
  "n_lines": 220
}
```

<details><summary>Tool Result: Read (`.worktrees/paprika-apply-cli/internal/api/server.go`)</summary>

<!-- call_id: tool_tBdzIRNEa7EeAvJUvXPlLTrp -->
723	func convertRelease(r *pipelinesv1alpha1.Release) *paprikav1.Release {
724		promos := make([]*paprikav1.Promotion, 0, len(r.Status.PromotionHistory))
725		for _, ph := range r.Status.PromotionHistory {
726			promos = append(promos, &paprikav1.Promotion{
727				Stage:     ph.Stage,
728				Result:    ph.Result,
729				Timestamp: ph.Timestamp.Unix(),
730			})
731		}
732		rel := &paprikav1.Release{
733			Name:             r.Name,
734			Namespace:        r.Namespace,
735			CreatedAt:        r.CreationTimestamp.Unix(),
736			Pipeline:         r.Spec.Pipeline,
737			Target:           r.Spec.Target,
738			Phase:            string(r.Status.Phase),
739			CurrentStage:     r.Status.CurrentStage,
740			PromotionHistory: promos,
741			Application:      r.Labels[engine.ApplicationNameLabelKey],
742			RolledBackTo:     r.Status.RolledBackTo,
743		}
744		if r.Spec.ManifestSource != nil {
745			rel.ManifestSource = &paprikav1.ManifestSource{
746				ConfigMapRef: r.Spec.ManifestSource.ConfigMapRef,
747			}
748		}
749		rel.PolicyResults = make([]*paprikav1.PolicyResult, 0, len(r.Status.PolicyResults))
750		for _, pr := range r.Status.PolicyResults {
751			rel.PolicyResults = append(rel.PolicyResults, &paprikav1.PolicyResult{
752				Name:     pr.Name,
753				Severity: pr.Severity,
754				Action:   pr.Action,
755				Passed:   pr.Passed,
756				Message:  pr.Message,
757			})
758		}
759		return rel
760	}
761	
762	const (
763		phaseReady         = "Ready"
764		conditionTypeReady = "Ready"
765	)
766	
767	func convertStage(st *pipelinesv1alpha1.Stage) *paprikav1.Stage {
768		phase := "Pending"
769		if st.Status.LastPromotion != nil {
770			phase = phaseReady
771		}
772		return &paprikav1.Stage{
773			Name:      st.Name,
774			Namespace: st.Namespace,
775			CreatedAt: st.CreationTimestamp.Unix(),
776			Ring:      safeInt32(st.Spec.Ring),
777			StageName: st.Spec.Name,
778			Phase:     phase,
779		}
780	}
781	
782	func convertConditions(conds []metav1.Condition) []*paprikav1.Condition {
783		out := make([]*paprikav1.Condition, 0, len(conds))
784		for _, c := range conds {
785			out = append(out, &paprikav1.Condition{
786				Type:               c.Type,
787				Status:             string(c.Status),
788				ObservedGeneration: c.ObservedGeneration,
789				LastTransitionTime: c.LastTransitionTime.Format(time.RFC3339),
790				Reason:             c.Reason,
791				Message:            c.Message,
792			})
793		}
794		return out
795	}
796	
797	func convertApplication(a *pipelinesv1alpha1.Application) *paprikav1.Application {
798		stages := make([]*paprikav1.ApplicationStage, 0, len(a.Status.Stages))
799		for _, s := range a.Status.Stages {
800			stages = append(stages, &paprikav1.ApplicationStage{
801				Name:     s.Name,
802				Ring:     safeInt32(s.Ring),
803				Phase:    s.Phase,
804				Release:  s.Release,
805				Revision: s.Revision,
806			})
807		}
808		var source *paprikav1.ApplicationSource
809		if a.Spec.Source.Type != "" {
810			source = &paprikav1.ApplicationSource{
811				Type:         a.Spec.Source.Type,
812				RepoUrl:      a.Spec.Source.RepoURL,
813				Revision:     a.Spec.Source.Revision,
814				Path:         a.Spec.Source.Path,
815				Bucket:       a.Spec.Source.Bucket,
816				Key:          a.Spec.Source.Key,
817				Region:       a.Spec.Source.Region,
818				Endpoint:     a.Spec.Source.Endpoint,
819				SecretRef:    a.Spec.Source.SecretRef,
820				PollInterval: a.Spec.Source.PollInterval,
821				Chart: &paprikav1.ChartRef{
822					Repo:    a.Spec.Source.Chart.Repo,
823					Name:    a.Spec.Source.Chart.Name,
824					Version: a.Spec.Source.Chart.Version,
825					Path:    a.Spec.Source.Chart.Path,
826				},
827			}
828			if a.Spec.Source.Inline != nil {
829				source.Inline = &paprikav1.InlineSource{
830					ConfigMapRef: a.Spec.Source.Inline.ConfigMapRef,
831				}
832			}
833			if a.Spec.Source.OCI != nil {
834				source.Oci = &paprikav1.OCISource{
835					Url:       a.Spec.Source.OCI.URL,
836					Tag:       a.Spec.Source.OCI.Tag,
837					Insecure:  a.Spec.Source.OCI.Insecure,
838					SecretRef: a.Spec.Source.OCI.SecretRef,
839				}
840			}
841		}
842		return &paprikav1.Application{
843			Name:            a.Name,
844			Namespace:       a.Namespace,
845			Project:         a.Spec.Project,
846			Phase:           string(a.Status.Phase),
847			CurrentStage:    a.Status.CurrentStage,
848			Revision:        a.Status.Revision,
849			Synced:          a.Status.Synced,
850			TemplateRef:     a.Status.TemplateRef,
851			PipelineRef:     a.Status.PipelineRef,
852			ReleaseRef:      a.Status.ReleaseRef,
853			Stages:          stages,
854			Source:          source,
855			Strategy:        string(a.Spec.Strategy),
856			SyncPolicy:      string(a.Spec.SyncPolicy),
857			Parameters:      a.Spec.Parameters,
858			SourceHash:      a.Status.SourceHash,
859			SourceRevision:  a.Status.SourceRevision,
860			Health:          string(a.Status.Health),
861			HealthChecks:    convertHealthChecks(a.Status.HealthChecks),
862			Resources:       convertResourceSyncs(a.Status.Resources),
863			ResourceHealth:  convertResourceHealth(a.Status.ResourceHealth),
864			OutOfSync:       safeInt32(a.Status.OutOfSync),
865			PrunedResources: safeInt32(a.Status.PrunedResources),
866			Conditions:      convertConditions(a.Status.Conditions),
867			AnalysisResults: convertAnalysisResults(a.Status.AnalysisResults),
868		}
869	}
870	
871	func convertApplicationSet(set *pipelinesv1alpha1.ApplicationSet) *paprikav1.ApplicationSet {
872		phase := "NotReady"
873		for _, c := range set.Status.Conditions {
874			if c.Type == conditionTypeReady {
875				if c.Status == "True" {
876					phase = phaseReady
877				}
878				break
879			}
880		}
881		return &paprikav1.ApplicationSet{
882			Name:         set.Name,
883			Namespace:    set.Namespace,
884			Applications: safeInt32(int(set.Status.Applications)),
885			Phase:        phase,
886		}
887	}
888	
889	func convertResourceSyncs(syncs []pipelinesv1alpha1.ResourceSync) []*paprikav1.ResourceSync {
890		out := make([]*paprikav1.ResourceSync, 0, len(syncs))
891		for _, s := range syncs {
892			out = append(out, &paprikav1.ResourceSync{
893				Kind:      s.Kind,
894				Name:      s.Name,
895				Namespace: s.Namespace,
896				Status:    s.Status,
897			})
898		}
899		return out
900	}
901	
902	func convertResourceHealth(healths []pipelinesv1alpha1.ResourceHealth) []*paprikav1.ResourceHealth {
903		out := make([]*paprikav1.ResourceHealth, 0, len(healths))
904		for _, h := range healths {
905			out = append(out, &paprikav1.ResourceHealth{
906				Kind:      h.Kind,
907				Name:      h.Name,
908				Namespace: h.Namespace,
909				Health:    h.Health,
910				Message:   h.Message,
911			})
912		}
913		return out
914	}
915	
916	func convertAnalysisResults(results []pipelinesv1alpha1.AnalysisResult) []*paprikav1.AnalysisResult {
917		out := make([]*paprikav1.AnalysisResult, 0, len(results))
918		for _, r := range results {
919			checkedAt := ""
920			if r.CheckedAt != nil {
921				checkedAt = r.CheckedAt.Format(time.RFC3339)
922			}
923			out = append(out, &paprikav1.AnalysisResult{
924				Name:      r.Name,
925				Phase:     string(r.Phase),
926				Passed:    r.Passed,
927				Message:   r.Message,
928				CheckedAt: checkedAt,
929			})
930		}
931		return out
932	}
933	
934	func convertHealthChecks(results []pipelinesv1alpha1.HealthCheckResult) []*paprikav1.HealthCheckResult {
935		out := make([]*paprikav1.HealthCheckResult, 0, len(results))
936		for _, r := range results {
937			hcr := &paprikav1.HealthCheckResult{
938				Name:           r.Name,
939				Status:         string(r.Status),
940				Message:        r.Message,
941				HttpStatusCode: safeInt32(r.HTTPStatusCode),
942				HttpBody:       r.HTTPBody,
<system>220 lines read from file starting from line 723. Total lines in file: 987.</system>

</details>

<details><summary>Thinking</summary>

Converters already handle inline and policy results. Good.

Now we need decide implementation tasks. The ApplyBundle handler hardening can be done by a subagent. But we need be careful because it involves governance. We'll provide current code context and plan requirements.

The E2E test requires building CLI. We can create test/e2e/apply_test.go.

Given the complexity, perhaps we should use subagent-driven-development for each of the four gaps. But we can also do some small ones directly (UI generate script). Let's start with the UI generate script because it's trivial. Check ui/package.json.

</details>

#### Tool Call: Read (`.worktrees/paprika-apply-cli/ui/package.json`)
<!-- call_id: tool_7zFwfVEDo1UcdWvUweqLJH0y -->
```json
{
  "path": ".worktrees/paprika-apply-cli/ui/package.json",
  "n_lines": 100
}
```

<details><summary>Tool Result: Read (`.worktrees/paprika-apply-cli/ui/package.json`)</summary>

<!-- call_id: tool_7zFwfVEDo1UcdWvUweqLJH0y -->
1	{
2	  "name": "ui",
3	  "version": "0.1.0",
4	  "private": true,
5	  "scripts": {
6	    "dev": "next dev",
7	    "build": "next build",
8	    "build:gh-pages": "PAPRIKA_BASE_PATH=/paprika next build",
9	    "start": "next start",
10	    "lint": "eslint"
11	  },
12	  "dependencies": {
13	    "@base-ui/react": "^1.5.0",
14	    "@bufbuild/protobuf": "^1.10.1",
15	    "@connectrpc/connect": "^1.7.0",
16	    "@connectrpc/connect-web": "^1.7.0",
17	    "@tailwindcss/typography": "^0.5.20",
18	    "class-variance-authority": "^0.7.1",
19	    "clsx": "^2.1.1",
20	    "framer-motion": "^12.40.0",
21	    "gray-matter": "^4.0.3",
22	    "lucide-react": "^1.17.0",
23	    "next": "16.2.7",
24	    "next-mdx-remote": "^6.0.0",
25	    "react": "19.2.4",
26	    "react-dom": "19.2.4",
27	    "rehype-slug": "^6.0.0",
28	    "remark-gfm": "^4.0.1",
29	    "shadcn": "^4.10.0",
30	    "tailwind-merge": "^3.6.0",
31	    "tw-animate-css": "^1.4.0"
32	  },
33	  "devDependencies": {
34	    "@bufbuild/protoc-gen-es": "^1.10.1",
35	    "@connectrpc/protoc-gen-connect-es": "^1.7.0",
36	    "@tailwindcss/postcss": "^4",
37	    "@types/node": "^20",
38	    "@types/react": "^19",
39	    "@types/react-dom": "^19",
40	    "eslint": "^9",
41	    "eslint-config-next": "16.2.7",
42	    "rehype-pretty-code": "^0.14.3",
43	    "shiki": "^4.2.0",
44	    "tailwindcss": "^4",
45	    "typescript": "^5"
46	  }
47	}
<system>47 lines read from file starting from line 1. Total lines in file: 47. End of file reached.</system>

</details>

<details><summary>Thinking</summary>

No generate script. Add it. We can do directly.

</details>

#### Tool Call: Edit (`.worktrees/paprika-apply-cli/ui/package.json`)
<!-- call_id: tool_9mKkJY1nFpTn8iHS7l8MzUw0 -->
```json
{
  "path": ".worktrees/paprika-apply-cli/ui/package.json",
  "old_string": "  \"scripts\": {\n    \"dev\": \"next dev\",\n    \"build\": \"next build\",\n    \"build:gh-pages\": \"PAPRIKA_BASE_PATH=/paprika next build\",\n    \"start\": \"next start\",\n    \"lint\": \"eslint\"\n  },",
  "new_string": "  \"scripts\": {\n    \"dev\": \"next dev\",\n    \"build\": \"next build\",\n    \"build:gh-pages\": \"PAPRIKA_BASE_PATH=/paprika next build\",\n    \"start\": \"next start\",\n    \"lint\": \"eslint\",\n    \"generate\": \"cd .. && buf generate\"\n  },"
}
```

<details><summary>Tool Result: Edit (`.worktrees/paprika-apply-cli/ui/package.json`)</summary>

<!-- call_id: tool_9mKkJY1nFpTn8iHS7l8MzUw0 -->
Replaced 1 occurrence in .worktrees/paprika-apply-cli/ui/package.json

</details>

<details><summary>Thinking</summary>

Now verify `npm run generate` works? It requires buf and plugins. Since we already have node_modules and buf (go tool). Let's try.

</details>

#### Tool Call: Bash (`cd .worktrees/paprika-apply-cli/ui && npm run generate`)
<!-- call_id: tool_9mTkzALqKGuUdlUrvU4VbBga -->
```json
{
  "command": "cd .worktrees/paprika-apply-cli/ui && npm run generate",
  "timeout": 120
}
```

<details><summary>Tool Result: Bash (`cd .worktrees/paprika-apply-cli/ui && npm run generate`)</summary>

<!-- call_id: tool_9mTkzALqKGuUdlUrvU4VbBga -->

> ui@0.1.0 generate
> cd .. && buf generate



</details>

<details><summary>Thinking</summary>

Good. UI generate script works. Commit this.

</details>

#### Tool Call: Bash (`cd .worktrees/paprika-apply-cli && git add ui/package.json &…`)
<!-- call_id: tool_ugpvk0N73OzqMKJc8SB3zSOa -->
```json
{
  "command": "cd .worktrees/paprika-apply-cli && git add ui/package.json && git commit -m \"build(ui): add generate script for protobuf clients\"",
  "timeout": 60
}
```

<details><summary>Tool Result: Bash (`cd .worktrees/paprika-apply-cli && git add ui/package.json &…`)</summary>

<!-- call_id: tool_ugpvk0N73OzqMKJc8SB3zSOa -->
[feature/paprika-apply-cli da92b18] build(ui): add generate script for protobuf clients
 1 file changed, 2 insertions(+), 1 deletion(-)


</details>

<details><summary>Thinking</summary>

Now we need tackle other gaps. We can use subagent-driven-development. Let's start with the E2E apply test. We need create test/e2e/apply_test.go and testdata. We can dispatch an implementer subagent. But the E2E test requires the CLI binary built. The suite doesn't build CLI currently. We can either add CLI build to suite or within test. Since local e2e blocked, we can write test to build CLI in BeforeAll. But building CLI in e2e test may be heavy. Better add a step in e2e_suite_test.go BeforeSuite to build CLI if not skipping image build. But modifying suite may affect all e2e. Alternatively, the test can call `go run ./cmd/paprika apply ...`? That would compile each time. Better: in apply_test.go `BeforeAll`, run `make build-cli`. Then use `bin/paprika`.

Need also know how to reach API server. The suite already port-forwards controller-manager 4000:3000. We can use `--server http://localhost:4000`. The apply command uses defaultServer() which reads PAPRIKA_SERVER env or http://localhost:3000. We can pass `--server` flag. Good.

The test should create a test namespace (e2e-apply). ApplyBundle handler ensures namespace. But we can create it. Need also create AppProject? The default project may exist? The default project might be created by bootstrap? Not sure. In e2e, applying with `--project default` may require an AppProject `default` exists. The governance validator may reject if project doesn't exist. We need check. The apply handler resolves project via governanceValidator. If no project object, it may fail. We can create an AppProject `default` that allows namespace `e2e-apply`. Or we can disable governance? The handler always uses governance if set. The server is initialized with governance. Need see if `default` AppProject exists. In e2e, maybe not. We can create it in test. Alternatively use project `default` with namespace pattern. Need inspect AppProject CRD and governance. But perhaps easier: the test can create an AppProject `e2e-apply` allowing namespace `e2e-apply` and use `--project e2e-apply`. But then default project? The ApplyBundle uses defaultProjectName = "default". If `--project` not set, it uses default. We should set `--project` to the test project.

Need also ensure policies don't block. We can create a Policy that allows or none.

This is getting complex. Maybe start with a simpler E2E test that uses `kubectl apply` to create an Application with inline source? But the plan wants `paprika apply` CLI. However to validate the feature, we can test ApplyBundle via the API or CLI.

Given complexity and local inability, perhaps we should focus on unit/integration tests and handler hardening, and add a basic E2E test that can run in CI. We can delegate to subagent to design the E2E test.

But we should be mindful of time. The user expects progress. We can implement handler hardening and release inline test using subagents, and create E2E test. Let's start with release controller inline unit test (small). Then handler hardening. Then E2E test.

Actually, maybe we should do handler hardening first because it's the core. Then tests.

Let's dispatch an implementer subagent for "ApplyBundle handler hardening" with detailed instructions. We need provide current apply_bundle.go and plan requirements. The subagent will work in the worktree path. It should:
- Add deriveAppName fallback when req.Msg.Name is empty (derive from first manifest metadata name).
- Add idempotency: if existing active Release is Complete and has same bundle SHA, return existing Application/Release.
- Supersede previous terminal Release when a new Release is created.
- Keep governance integration intact.
- Add/update unit tests in internal/api/apply_bundle_test.go for idempotency and supersede.
- Run make test and make lint.

But adding optimistic-lock loop might be too invasive; we can include it but note to preserve governance. The current code already uses retry.RetryOnConflict for status updates. The main create path isn't in a loop. We can add a loop with conflict retry and orphan cleanup. This is significant. Maybe do derive-name and idempotency/supersede first; optimistic loop can be later.

We need provide subagent with full context. Since the file is large, we can reference path. The skill says subagent should not read plan file; we provide text. For code context, we can tell it to read the file. That's fine.

Let's craft implementer prompt.

</details>

#### Tool Call: Agent (`Harden ApplyBundle handler`)
<!-- call_id: tool_WgkIxZmxOB7wJMr8gHyXhO8t -->
```json
{
  "description": "Harden ApplyBundle handler",
  "subagent_type": "coder",
  "prompt": "You are implementing a focused hardening task in the Paprika repo worktree at `/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli`.\n\n**Goal:** Harden the `ApplyBundle` handler in `internal/api/apply_bundle.go` to match the missing behaviors from the implementation plan:\n1. When `req.Msg.Name` is empty, derive the application name from the first manifest's `metadata.name` instead of returning an error.\n2. Add idempotency: before creating a new Release, check if the Application already has an active Release that is `Complete` and whose `paprika.io/bundle-sha` annotation matches the current bundle SHA. If so, return the existing Application/Release and policy results without mutating anything.\n3. When creating a new Release, find the previous terminal Release (`Complete`, `Failed`, `RolledBack`, or `Superseded`) for the same Application and mark it as `Superseded` (set `Status.Phase = ReleaseSuperseded`). Do this after the new Release is successfully created and the Application's `releaseRef` has been updated.\n4. Keep all existing governance/policy evaluation, dry-run, namespace creation, and snapshot creation logic unchanged.\n5. Add or extend unit tests in `internal/api/apply_bundle_test.go` covering:\n   - derive name from manifest when request name is empty\n   - idempotent re-apply returns existing complete release\n   - superseding the previous terminal release\n6. Run `make test` and `make lint` in the worktree and fix any failures.\n7. Commit the changes with a clear message.\n\n**Context you need:**\n- The handler lives in package `apiserver` at `internal/api/apply_bundle.go`.\n- Release phases are constants on `pipelinesv1alpha1.Release`, e.g. `ReleaseComplete`, `ReleaseFailed`, `ReleaseRolledBack`, `ReleaseSuperseded`.\n- The bundle SHA helper already exists as `fullBundleSHA(bundle)` and is stored on Release annotations as `paprika.io/bundle-sha`.\n- The Application's active release is in `app.Status.ReleaseRef`.\n- Governance/policy code must not be removed or bypassed.\n\nPlease read the current `internal/api/apply_bundle.go` and `internal/api/apply_bundle_test.go`, implement the changes, run tests/lint, and report what you changed and the test results."
}
```

<details><summary>Tool Result: Agent (`Harden ApplyBundle handler`)</summary>

<!-- call_id: tool_WgkIxZmxOB7wJMr8gHyXhO8t -->
agent_id: agent-80
actual_subagent_type: coder
status: completed

[summary]
Done. I hardened `ApplyBundle` in the `paprika-apply-cli` worktree and committed the changes.

### What changed

**`internal/api/apply_bundle.go`**
- Removed the hard error when `req.Msg.Name` is empty; the name is now derived from the first manifest’s `metadata.name` via `deriveAppName`.
- Added idempotency via `findExistingCompleteRelease`: before creating a new release, if the application has an active `Release` that is `Complete` and its `paprika.io/bundle-sha` annotation matches the current bundle SHA, the handler returns the existing application/release and the current policy results without mutating anything.
- After a new release is created and the application’s `releaseRef` is updated, the previous terminal release (`Complete`, `Failed`, `RolledBack`, or `Superseded`) is marked `Superseded` via `supersedeRelease`.
- Refactored the governance + policy evaluation block into `evaluateBundle()` to keep `ApplyBundle` within lint limits.
- Reused a new `bundleSHAAnnotation` constant for the bundle SHA annotation.

**`internal/api/apply_bundle_test.go`**
- Added `TestApplyBundle_DeriveNameFromManifest`
- Added `TestApplyBundle_IdempotentReapply`
- Added `TestApplyBundle_SupersedesPreviousTerminalRelease`

### Verification

- `make test` — passed (all packages, including `internal/api` at 33.5% coverage)
- `make lint` — passed (0 issues)
- New `TestApplyBundle_*` tests — all pass

### Commit

```
f100ae2 harden(api): derive app name, idempotent re-apply, and supersede previous release in ApplyBundle
```

Only `internal/api/apply_bundle.go` and `internal/api/apply_bundle_test.go` were modified.

</details>

<details><summary>Thinking</summary>

Great. Next gap: release controller inline unit test. We can dispatch a small subagent. Then E2E test. Let's dispatch release inline test.

</details>

#### Tool Call: Agent (`Add release inline unit test`)
<!-- call_id: tool_0uFknFK0xJMVzq8FbM71mrla -->
```json
{
  "description": "Add release inline unit test",
  "subagent_type": "coder",
  "prompt": "You are adding a focused unit test in the Paprika repo worktree at `/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli`.\n\n**Goal:** Add a unit test for the Release controller's inline manifest source loading path in `internal/controller/pipelines/release_controller.go`.\n\n**Task:**\n1. Read `internal/controller/pipelines/release_controller.go` and find the function that loads manifests from a ConfigMap for inline sources (likely named `loadManifestsFromConfigMap` or similar).\n2. Create `internal/controller/pipelines/release_controller_inline_test.go` with a table-driven test that verifies:\n   - A Release with `Spec.ManifestSource.ConfigMapRef` pointing to an existing ConfigMap returns the ConfigMap's `manifests.yaml` data.\n   - A Release with a missing ConfigMapRef returns an error.\n3. Use the controller-runtime fake client and the standard project test packages (`paprikav1`, `corev1`, `runtime`, `require`).\n4. Run `go test ./internal/controller/pipelines/... -run TestReleaseReconciler_LoadManifestsFromConfigMap -v` and ensure it passes.\n5. Run `make lint` and fix any issues.\n6. Commit with message `test(controller): add release controller inline manifest source unit test`.\n\nReport what you created and the test results."
}
```

<details><summary>Tool Result: Agent (`Add release inline unit test`)</summary>

<!-- call_id: tool_0uFknFK0xJMVzq8FbM71mrla -->
agent_id: agent-81
actual_subagent_type: coder
status: completed

[summary]
Created `internal/controller/pipelines/release_controller_inline_test.go` with a table-driven unit test for the `ReleaseReconciler.loadManifestsFromConfigMap` method.

What the test covers:
- **Happy path**: a `Release` with `Spec.ManifestSource.ConfigMapRef` pointing at an existing ConfigMap containing `manifests.yaml` returns that data unchanged.
- **Missing ConfigMap**: a `Release` whose referenced ConfigMap does not exist returns an error containing `fetch manifest snapshot`.

Implementation details:
- Uses controller-runtime `fake.NewClientBuilder`.
- Builds a `runtime.Scheme` with `corev1` and `paprikav1` (pipelines v1alpha1) registered.
- Uses `testify/require` for assertions.
- Test name matches the requested filter: `TestReleaseReconciler_LoadManifestsFromConfigMap`.

Verification:
- `go test ./internal/controller/pipelines/... -run TestReleaseReconciler_LoadManifestsFromConfigMap -v` → **PASS** (both subtests).
- `make lint` → **0 issues**.
- Committed as `a4e136e`: `test(controller): add release controller inline manifest source unit test`.

</details>

<details><summary>Thinking</summary>

Now E2E apply test. This is more involved. We need create test/e2e/apply_test.go and testdata. We should dispatch a subagent to design and implement, but need be careful about governance. Let's inspect if there is a default AppProject or how to create one. Also check existing e2e tests for project governance to see how they set up AppProject. Use Grep in e2e_test.go for AppProject.

</details>

#### Tool Call: Grep (`.worktrees/paprika-apply-cli/test/e2e/e2e_test.go`)
<!-- call_id: tool_J49ROpx61cjVx3lbrhMl2KCP -->
```json
{
  "path": ".worktrees/paprika-apply-cli/test/e2e/e2e_test.go",
  "pattern": "AppProject|appproject|project",
  "output_mode": "content",
  "-n": true,
  "head_limit": 100
}
```

<details><summary>Tool Result: Grep (`.worktrees/paprika-apply-cli/test/e2e/e2e_test.go`)</summary>

<!-- call_id: tool_J49ROpx61cjVx3lbrhMl2KCP -->
.worktrees/paprika-apply-cli/test/e2e/e2e_test.go:85:	By("probing the AppProject webhook until it is reachable")
.worktrees/paprika-apply-cli/test/e2e/e2e_test.go:87:		probe := fmt.Sprintf(`{"apiVersion":"core.paprika.io/v1alpha1","kind":"AppProject","metadata":{"name":"webhook-probe","namespace":"%s"},"spec":{}}`, namespace)
.worktrees/paprika-apply-cli/test/e2e/e2e_test.go:92:			del := exec.Command("kubectl", "delete", "appproject", "webhook-probe", "-n", namespace, "--ignore-not-found")
.worktrees/paprika-apply-cli/test/e2e/e2e_test.go:1891:			By("ensuring the default AppProject exists in the apply test namespace")
.worktrees/paprika-apply-cli/test/e2e/e2e_test.go:1894:				"kind": "AppProject",
.worktrees/paprika-apply-cli/test/e2e/e2e_test.go:1906:			Expect(err).NotTo(HaveOccurred(), "Failed to create default AppProject in apply namespace")
.worktrees/paprika-apply-cli/test/e2e/e2e_test.go:1981:			By("ensuring the default AppProject exists")
.worktrees/paprika-apply-cli/test/e2e/e2e_test.go:1984:				"kind": "AppProject",
.worktrees/paprika-apply-cli/test/e2e/e2e_test.go:1996:			Expect(err).NotTo(HaveOccurred(), "Failed to create default AppProject")
.worktrees/paprika-apply-cli/test/e2e/e2e_test.go:2020:			By("cleaning up the default AppProject")
.worktrees/paprika-apply-cli/test/e2e/e2e_test.go:2021:			cmd = exec.Command("kubectl", "delete", "appproject", "default", "-n", applyCLINamespace, "--ignore-not-found", "--timeout=10s")

</details>

<details><summary>Thinking</summary>

There are already e2e tests around line 1880+ for apply CLI! Let's read that section.

</details>

#### Tool Call: Read (`.worktrees/paprika-apply-cli/test/e2e/e2e_test.go`)
<!-- call_id: tool_CvkbuwgIvhbhGhkb4sGy1ve2 -->
```json
{
  "path": ".worktrees/paprika-apply-cli/test/e2e/e2e_test.go",
  "line_offset": 1850,
  "n_lines": 300
}
```

<details><summary>Tool Result: Read (`.worktrees/paprika-apply-cli/test/e2e/e2e_test.go`)</summary>

<!-- call_id: tool_CvkbuwgIvhbhGhkb4sGy1ve2 -->
1850					strings.NewReader("{}"),
1851				)
1852				Expect(err).NotTo(HaveOccurred(), "Failed to call ListApplications RPC")
1853				defer resp.Body.Close()
1854				Expect(resp.StatusCode).To(Equal(http.StatusOK), "ListApplications RPC should return 200")
1855	
1856				body, err := io.ReadAll(resp.Body)
1857				Expect(err).NotTo(HaveOccurred())
1858				bodyStr := string(body)
1859				Expect(bodyStr).To(ContainSubstring("applications"), "Response should contain applications field")
1860				Expect(bodyStr).To(ContainSubstring("e2e-api-app"), "Response should include the API test application")
1861			})
1862	
1863			It("should accept SyncApplication RPC calls", func() {
1864				By("calling SyncApplication RPC for a non-existent application")
1865				resp, err := http.Post(
1866					fmt.Sprintf("http://localhost:%d/paprika.v1.PaprikaService/SyncApplication", apiPort),
1867					"application/json",
1868					strings.NewReader(`{"name": "nonexistent-app", "namespace": "default"}`),
1869				)
1870				Expect(err).NotTo(HaveOccurred(), "Failed to call SyncApplication RPC")
1871				defer resp.Body.Close()
1872				Expect(resp.StatusCode).To(BeNumerically(">=", 200), "SyncApplication should accept requests")
1873			})
1874		})
1875	
1876		Context("PaprikaApply", func() {
1877			const applyTestNamespace = "e2e-apply-test"
1878			var manifestDir string
1879	
1880			BeforeEach(func() {
1881				By("building the paprika CLI")
1882				cmd := exec.Command("make", "build-cli")
1883				_, err := utils.Run(cmd)
1884				Expect(err).NotTo(HaveOccurred(), "Failed to build paprika CLI")
1885	
1886				By("creating the apply test namespace")
1887				cmd = exec.Command("kubectl", "create", "ns", applyTestNamespace)
1888				_, err = utils.Run(cmd)
1889				Expect(err).NotTo(HaveOccurred(), "Failed to create apply test namespace")
1890	
1891				By("ensuring the default AppProject exists in the apply test namespace")
1892				defaultProject := fmt.Sprintf(`{
1893					"apiVersion": "core.paprika.io/v1alpha1",
1894					"kind": "AppProject",
1895					"metadata": {"name": "default", "namespace": "%s"},
1896					"spec": {
1897						"sourceRepos": ["*"],
1898						"destinations": [{"server": "*", "namespace": "*"}],
1899						"kinds": ["*"],
1900						"roles": [{"name": "default", "subjects": ["*"], "actions": ["read", "write"]}]
1901					}
1902				}`, applyTestNamespace)
1903				cmd = exec.Command("kubectl", "apply", "-f", "-")
1904				cmd.Stdin = strings.NewReader(defaultProject)
1905				_, err = utils.Run(cmd)
1906				Expect(err).NotTo(HaveOccurred(), "Failed to create default AppProject in apply namespace")
1907	
1908				By("creating a temporary directory for apply manifests")
1909				manifestDir, err = os.MkdirTemp("", "paprika-apply-e2e-")
1910				Expect(err).NotTo(HaveOccurred(), "Failed to create manifest temp dir")
1911			})
1912	
1913			AfterEach(func() {
1914				if manifestDir != "" {
1915					_ = os.RemoveAll(manifestDir)
1916				}
1917				By("cleaning up the apply test namespace")
1918				cmd := exec.Command("kubectl", "delete", "ns", applyTestNamespace, "--ignore-not-found")
1919				_, _ = utils.Run(cmd)
1920			})
1921	
1922			It("should apply a raw manifest bundle and reach a healthy terminal phase", func() {
1923				manifest := fmt.Sprintf(`apiVersion: v1
1924	kind: ConfigMap
1925	metadata:
1926	  name: e2e-inline-configmap
1927	  namespace: %s
1928	data:
1929	  greeting: hello-from-paprika-apply
1930	`, applyTestNamespace)
1931				manifestPath := filepath.Join(manifestDir, "configmap.yaml")
1932				Expect(os.WriteFile(manifestPath, []byte(manifest), 0o600)).To(Succeed())
1933	
1934				By("running paprika apply against the operator API")
1935				cmd := exec.Command("bin/paprika", "apply", "-f", manifestPath,
1936					"--name", "e2e-inline-apply",
1937					"--namespace", applyTestNamespace,
1938					"--server", "http://localhost:4000",
1939					"--timeout", "2m",
1940				)
1941				out, err := utils.Run(cmd)
1942				Expect(err).NotTo(HaveOccurred(), "paprika apply failed: %s", out)
1943				Expect(out).To(ContainSubstring("e2e-inline-apply"))
1944	
1945				By("waiting for the Application to report a terminal phase")
1946				verifyAppPhase := func(g Gomega) {
1947					cmd := exec.Command("kubectl", "get", "application", "e2e-inline-apply",
1948						"-n", applyTestNamespace, "-o", "jsonpath={.status.phase}")
1949					phase, err := utils.Run(cmd)
1950					g.Expect(err).NotTo(HaveOccurred())
1951					g.Expect(phase).To(Or(Equal("Healthy"), Equal("Degraded"), Equal("Failed")))
1952				}
1953				Eventually(verifyAppPhase, 2*time.Minute, 2*time.Second).Should(Succeed())
1954	
1955				By("checking that the Application reached Healthy")
1956				cmd = exec.Command("kubectl", "get", "application", "e2e-inline-apply",
1957					"-n", applyTestNamespace, "-o", "jsonpath={.status.phase}")
1958				phase, err := utils.Run(cmd)
1959				Expect(err).NotTo(HaveOccurred())
1960				Expect(phase).To(Equal("Healthy"), "Application should be Healthy")
1961	
1962				By("checking that the ConfigMap was applied")
1963				cmd = exec.Command("kubectl", "get", "configmap", "e2e-inline-configmap",
1964					"-n", applyTestNamespace, "-o", "jsonpath={.data.greeting}")
1965				value, err := utils.Run(cmd)
1966				Expect(err).NotTo(HaveOccurred())
1967				Expect(strings.TrimSpace(value)).To(Equal("hello-from-paprika-apply"))
1968			})
1969		})
1970	
1971		Context("PaprikaApply CLI", Ordered, func() {
1972			const applyCLINamespace = "default"
1973			var manifestDir string
1974	
1975			BeforeAll(func() {
1976				By("building the paprika CLI")
1977				cmd := exec.Command("make", "build-cli")
1978				_, err := utils.Run(cmd)
1979				Expect(err).NotTo(HaveOccurred(), "Failed to build paprika CLI")
1980	
1981				By("ensuring the default AppProject exists")
1982				defaultProject := `{
1983					"apiVersion": "core.paprika.io/v1alpha1",
1984					"kind": "AppProject",
1985					"metadata": {"name": "default", "namespace": "default"},
1986					"spec": {
1987						"sourceRepos": ["*"],
1988						"destinations": [{"server": "*", "namespace": "*"}],
1989						"kinds": ["*"],
1990						"roles": [{"name": "default", "subjects": ["*"], "actions": ["read", "write"]}]
1991					}
1992				}`
1993				cmd = exec.Command("kubectl", "apply", "-f", "-")
1994				cmd.Stdin = strings.NewReader(defaultProject)
1995				_, err = utils.Run(cmd)
1996				Expect(err).NotTo(HaveOccurred(), "Failed to create default AppProject")
1997	
1998				By("creating a temporary directory for apply manifests")
1999				manifestDir, err = os.MkdirTemp("", "paprika-apply-cli-e2e-")
2000				Expect(err).NotTo(HaveOccurred(), "Failed to create manifest temp dir")
2001			})
2002	
2003			AfterAll(func() {
2004				if manifestDir != "" {
2005					_ = os.RemoveAll(manifestDir)
2006				}
2007	
2008				By("cleaning up the apply-e2e application")
2009				cmd := exec.Command("kubectl", "delete", "application", "apply-e2e", "-n", applyCLINamespace, "--ignore-not-found", "--timeout=30s")
2010				_, _ = utils.Run(cmd)
2011	
2012				By("cleaning up the apply-e2e stage")
2013				cmd = exec.Command("kubectl", "delete", "stage", "apply-e2e-default", "-n", applyCLINamespace, "--ignore-not-found", "--timeout=10s")
2014				_, _ = utils.Run(cmd)
2015	
2016				By("cleaning up the applied ConfigMap")
2017				cmd = exec.Command("kubectl", "delete", "configmap", "apply-e2e-configmap", "-n", applyCLINamespace, "--ignore-not-found", "--timeout=10s")
2018				_, _ = utils.Run(cmd)
2019	
2020				By("cleaning up the default AppProject")
2021				cmd = exec.Command("kubectl", "delete", "appproject", "default", "-n", applyCLINamespace, "--ignore-not-found", "--timeout=10s")
2022				_, _ = utils.Run(cmd)
2023			})
2024	
2025			It("should apply a raw manifest bundle via the CLI and reach a terminal phase", func() {
2026				manifest := `apiVersion: v1
2027	kind: ConfigMap
2028	metadata:
2029	  name: apply-e2e-configmap
2030	  namespace: default
2031	data:
2032	  greeting: hello-from-paprika-apply-cli
2033	`
2034				manifestPath := filepath.Join(manifestDir, "configmap.yaml")
2035				Expect(os.WriteFile(manifestPath, []byte(manifest), 0o600)).To(Succeed())
2036	
2037				By("running paprika apply against the API server")
2038				cmd := exec.Command("bin/paprika", "apply", "-f", manifestPath,
2039					"--namespace", "default",
2040					"--name", "apply-e2e",
2041					"--wait",
2042					"--timeout", "5m",
2043					"--server", "http://localhost:4000",
2044				)
2045				out, err := utils.Run(cmd)
2046				Expect(err).NotTo(HaveOccurred(), "paprika apply failed: %s", out)
2047				Expect(out).To(ContainSubstring("apply-e2e"))
2048	
2049				By("waiting for the Application to report a terminal phase")
2050				verifyAppPhase := func(g Gomega) {
2051					cmd := exec.Command("kubectl", "get", "application", "apply-e2e",
2052						"-n", applyCLINamespace, "-o", "jsonpath={.status.phase}")
2053					phase, err := utils.Run(cmd)
2054					g.Expect(err).NotTo(HaveOccurred())
2055					g.Expect(phase).To(Or(Equal("Healthy"), Equal("Degraded"), Equal("Failed")))
2056				}
2057				Eventually(verifyAppPhase, 5*time.Minute, 2*time.Second).Should(Succeed())
2058	
2059				By("checking that the Application reached Healthy")
2060				cmd = exec.Command("kubectl", "get", "application", "apply-e2e",
2061					"-n", applyCLINamespace, "-o", "jsonpath={.status.phase}")
2062				phase, err := utils.Run(cmd)
2063				Expect(err).NotTo(HaveOccurred())
2064				Expect(phase).To(Equal("Healthy"), "Application should be Healthy")
2065	
2066				By("checking that the ConfigMap was applied")
2067				cmd = exec.Command("kubectl", "get", "configmap", "apply-e2e-configmap",
2068					"-n", applyCLINamespace, "-o", "jsonpath={.data.greeting}")
2069				value, err := utils.Run(cmd)
2070				Expect(err).NotTo(HaveOccurred())
2071				Expect(strings.TrimSpace(value)).To(Equal("hello-from-paprika-apply-cli"))
2072			})
2073		})
2074	})
2075	
2076	func serviceAccountToken() (string, error) {
2077		const tokenRequestRawString = `{
2078			"apiVersion": "authentication.k8s.io/v1",
2079			"kind": "TokenRequest"
2080		}`
2081	
2082		By("creating temporary file to store the token request")
2083		secretName := fmt.Sprintf("%s-token-request", serviceAccountName)
2084		tokenRequestFile := filepath.Join("/tmp", secretName)
2085		err := os.WriteFile(tokenRequestFile, []byte(tokenRequestRawString), os.FileMode(0o644))
2086		if err != nil {
2087			return "", err
2088		}
2089	
2090		var out string
2091		verifyTokenCreation := func(g Gomega) {
2092			By("executing kubectl command to create the token")
2093			cmd := exec.Command("kubectl", "create", "--raw", fmt.Sprintf(
2094				"/api/v1/namespaces/%s/serviceaccounts/%s/token",
2095				namespace,
2096				serviceAccountName,
2097			), "-f", tokenRequestFile)
2098	
2099			output, err := cmd.CombinedOutput()
2100			g.Expect(err).NotTo(HaveOccurred())
2101	
2102			By("parsing the JSON output to extract the token")
2103			var token tokenRequest
2104			err = json.Unmarshal(output, &token)
2105			g.Expect(err).NotTo(HaveOccurred())
2106	
2107			out = token.Status.Token
2108		}
2109		Eventually(verifyTokenCreation).Should(Succeed())
2110	
2111		return out, err
2112	}
2113	
2114	func getMetricsOutput() (string, error) {
2115		By("getting the curl-metrics logs")
2116		cmd := exec.Command("kubectl", "logs", "curl-metrics", "-n", namespace)
2117		return utils.Run(cmd)
2118	}
2119	
2120	type tokenRequest struct {
2121		Status struct {
2122			Token string `json:"token"`
2123		} `json:"status"`
2124	}
<system>275 lines read from file starting from line 1850. Total lines in file: 2124. End of file reached.</system>

</details>

<details><summary>Thinking</summary>

E2E tests already exist! So the "missing E2E apply test" is actually present. The audit was slightly off. So apply feature is fully implemented including E2E. Great. We have already done handler hardening, release inline test, UI generate script. The remaining gaps from audit were E2E apply test (already exists) and maybe release controller inline-specific unit test (done). So we have closed gaps.

We should run full tests to ensure everything still passes. Then we can mark todo done and move to next big chunk: Approval Gates. We should update todo list. Then maybe start planning Approval Gates.

But first run `make test` and `make lint` in worktree to verify subagent changes. Use background? It may take ~2-3 min. Use foreground with timeout 300.

</details>

#### Tool Call: Bash (`cd .worktrees/paprika-apply-cli && make test && make lint`)
<!-- call_id: tool_hpFSxeYjOHsjUPJCj15YgTlz -->
```json
{
  "command": "cd .worktrees/paprika-apply-cli && make test && make lint",
  "timeout": 300
}
```

<details><summary>Tool Result: Bash (`cd .worktrees/paprika-apply-cli && make test && make lint`)</summary>

<!-- call_id: tool_hpFSxeYjOHsjUPJCj15YgTlz -->
"/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/bin/controller-gen" rbac:roleName=manager-role crd:allowDangerousTypes=true webhook paths="/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/clusters/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/core/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/featureflags/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/pipelines/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/policy/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/rollouts/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/cmd;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/cmd/cloud-run;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/cmd/paprika;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/agent;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/agent/server;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/agentclient;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/analysis;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/auth;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/events;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/mocks;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/paprika/v1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/paprika/v1/v1connect;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/cache;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/cache/mocks;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-c[...truncated]
Generating protobuf clients...
go tool buf generate
"/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/bin/controller-gen" object:headerFile="hack/boilerplate.go.txt",year=2026 paths="/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/clusters/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/core/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/featureflags/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/pipelines/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/policy/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/api/rollouts/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/cmd;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/cmd/cloud-run;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/cmd/paprika;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/agent;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/agent/server;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/agentclient;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/analysis;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/auth;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/events;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/mocks;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/paprika/v1;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/api/paprika/v1/v1connect;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/cache;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/internal/cache/mocks;/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/interna[...truncated]
PATH="/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/bin:/Users/benebsworth/.local/bin:/Users/benebsworth/.kimi-code/bin:/Users/benebsworth/.opencode/bin:/Users/benebsworth/.antigravity/antigravity/bin:/opt/homebrew/opt/postgresql@17/bin:/Users/benebsworth/.codeium/windsurf/bin:/Users/benebsworth/.nvm/versions/node/v22.9.0/bin:/Users/benebsworth/.bun/bin:/Users/benebsworth/.pyenv/shims:/Users/benebsworth/.pyenv/plugins/pyenv-virtualenv/shims:/Users/benebsworth/.pyenv/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/Users/benebsworth/.local/bin:/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/local/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/appleinternal/bin:/pkg/env/global/bin:/Library/Apple/usr/bin:/Users/benebsworth/.cargo/bin:/Applications/Ghostty.app/Contents/MacOS:/Users/benebsworth/go/bin:/Users/benebsworth/Library/Android/sdk/emulator:/Users/benebsworth/Library/Android/sdk/platform-tools:/Users/benebsworth/Downloads/google-cloud-sdk/bin" go generate ./...
go fmt ./...
go vet ./...
Setting up envtest binaries for Kubernetes version 1.35...
/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/bin/k8s/1.35.0-darwin-arm64KUBEBUILDER_ASSETS="/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/bin/k8s/1.35.0-darwin-arm64" go test $(go list ./... | grep -v /e2e) -coverprofile cover.out
	github.com/benebsworth/paprika/api/clusters/v1alpha1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/api/core/v1alpha1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/api/featureflags/v1alpha1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/api/pipelines/v1alpha1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/api/policy/v1alpha1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/api/rollouts/v1alpha1		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/cmd	(cached)	coverage: 16.6% of statements
	github.com/benebsworth/paprika/cmd/cloud-run		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/cmd/paprika	(cached)	coverage: 15.6% of statements
ok  	github.com/benebsworth/paprika/internal/agent	(cached)	coverage: [no statements]
	github.com/benebsworth/paprika/internal/agent/server		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/agentclient		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/analysis	(cached)	coverage: 15.7% of statements
ok  	github.com/benebsworth/paprika/internal/api	(cached)	coverage: 33.5% of statements
ok  	github.com/benebsworth/paprika/internal/api/auth	(cached)	coverage: 65.4% of statements
ok  	github.com/benebsworth/paprika/internal/api/events	(cached)	coverage: 54.0% of statements
	github.com/benebsworth/paprika/internal/api/mocks		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/api/paprika/v1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/cache	(cached)	coverage: 34.6% of statements
	github.com/benebsworth/paprika/internal/cache/mocks		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/clock		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/controller/bootstrap		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/controller/clusters	6.823s	coverage: 31.5% of statements
ok  	github.com/benebsworth/paprika/internal/controller/core	7.114s	coverage: 37.8% of statements
ok  	github.com/benebsworth/paprika/internal/controller/pipelines	10.021s	coverage: 48.6% of statements
	github.com/benebsworth/paprika/internal/controller/pipelines/mocks		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/controller/policy	7.365s	coverage: 33.3% of statements
	github.com/benebsworth/paprika/internal/controller/rollouts		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/engine	(cached)	coverage: 41.0% of statements
	github.com/benebsworth/paprika/internal/featureflag		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/featureflag/kubernetes		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/featureflag/openfeature		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/gates	(cached)	coverage: 96.6% of statements
ok  	github.com/benebsworth/paprika/internal/governance	(cached)	coverage: 68.2% of statements
ok  	github.com/benebsworth/paprika/internal/health	(cached)	coverage: 51.7% of statements
ok  	github.com/benebsworth/paprika/internal/metrics	(cached)	coverage: 30.8% of statements
ok  	github.com/benebsworth/paprika/internal/observability	(cached)	coverage: 39.0% of statements
ok  	github.com/benebsworth/paprika/internal/policy	(cached)	coverage: 90.0% of statements
ok  	github.com/benebsworth/paprika/internal/ratelimit	(cached)	coverage: 92.1% of statements
ok  	github.com/benebsworth/paprika/internal/reposerver	(cached)	coverage: 14.7% of statements
ok  	github.com/benebsworth/paprika/internal/reposerverclient	(cached)	coverage: 30.0% of statements
ok  	github.com/benebsworth/paprika/internal/repository	(cached)	coverage: 85.7% of statements
	github.com/benebsworth/paprika/internal/rollout		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/rollout/abtest	(cached)	coverage: 67.5% of statements
ok  	github.com/benebsworth/paprika/internal/rollout/bluegreen	(cached)	coverage: 61.1% of statements
ok  	github.com/benebsworth/paprika/internal/rollout/canary	(cached)	coverage: 51.4% of statements
?   	github.com/benebsworth/paprika/internal/rollout/core	[no test files]
	github.com/benebsworth/paprika/internal/rollout/hash		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/rollout/mirror	(cached)	coverage: 62.2% of statements
ok  	github.com/benebsworth/paprika/internal/rollout/rolling	(cached)	coverage: 75.0% of statements
ok  	github.com/benebsworth/paprika/internal/sharding	(cached)	coverage: 92.9% of statements
ok  	github.com/benebsworth/paprika/internal/source	(cached)	coverage: 30.9% of statements
ok  	github.com/benebsworth/paprika/internal/syncwindow	(cached)	coverage: 96.2% of statements
	github.com/benebsworth/paprika/internal/traffic		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/traffic/gatewayapi	(cached)	coverage: 75.5% of statements
ok  	github.com/benebsworth/paprika/internal/traffic/istio	(cached)	coverage: 74.7% of statements
	github.com/benebsworth/paprika/internal/traffic/mocks		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/webhook/core/v1alpha1	(cached)	coverage: 76.7% of statements
ok  	github.com/benebsworth/paprika/internal/webhook/pipelines/v1alpha1	5.390s	coverage: 88.7% of statements
ok  	github.com/benebsworth/paprika/internal/webhook/policy/v1alpha1	(cached)	coverage: 85.5% of statements
ok  	github.com/benebsworth/paprika/internal/webhook/receiver	(cached)	coverage: 72.0% of statements
	github.com/benebsworth/paprika/internal/webhook/rollouts/v1alpha1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/test/utils		coverage: 0.0% of statements
	github.com/benebsworth/paprika/ui/node_modules/flatted/golang/pkg/flatted		coverage: 0.0% of statements
Downloading github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2
Building custom golangci-lint with plugins...
"/Users/benebsworth/projects/paprika/.worktrees/paprika-apply-cli/bin/golangci-lint" run
0 issues.
Command executed successfully. Output is truncated to fit in the message.

</details>

<details><summary>Thinking</summary>

All tests pass, lint green. Great. We can mark gap closure done. Then move to next big chunk: Approval Gates. We should update todo list. We can also create a new worktree for Approval Gates? The current worktree is for paprika-apply-cli. We can either create a new worktree or continue in same? The skill says isolated workspace per feature. Better create new worktree `feature/approval-gates`. But we can also continue in current and create a new branch/worktree. Since subagent-driven-development required worktree for apply; for next feature we should create another. But we can first plan Approval Gates in current? Better to create new worktree.

But before that, we should communicate to user that apply gaps are closed and we're moving to Approval Gates. Then start planning. Since Approval Gates has no plan, we need write one. Use `superpowers:writing-plans` skill. Read that skill.

</details>

#### Tool Call: TodoList
<!-- call_id: tool_WoSBR8nK5SNCUperNFyz7tBo -->
```json
{
  "todos": [
    {
      "title": "Review backlog and select next epic",
      "status": "done"
    },
    {
      "title": "Set up isolated worktree for chosen feature",
      "status": "done"
    },
    {
      "title": "Chunk 1: Policy CRD and evaluator package",
      "status": "done"
    },
    {
      "title": "Chunk 2: CRD changes for inline source and policy results",
      "status": "done"
    },
    {
      "title": "Chunk 3: Protobuf and ApplyBundle API server handler",
      "status": "done"
    },
    {
      "title": "Chunk 4a: Release controller inline manifest path",
      "status": "done"
    },
    {
      "title": "Chunk 4b: Application controller inline source handling",
      "status": "done"
    },
    {
      "title": "Chunk 4c: True rollback",
      "status": "done"
    },
    {
      "title": "Chunk 5: CLI apply command and TUI",
      "status": "done"
    },
    {
      "title": "Chunk 6: UI, RBAC manifests, and final integration",
      "status": "done"
    },
    {
      "title": "Chunk 7: Validation webhooks",
      "status": "done"
    },
    {
      "title": "Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)",
      "status": "done"
    },
    {
      "title": "Set up worktree for Approval Gates",
      "status": "in_progress"
    },
    {
      "title": "Write Approval Gates implementation plan",
      "status": "pending"
    },
    {
      "title": "Implement Approval Gates using subagent-driven-development",
      "status": "pending"
    }
  ]
}
```

<details><summary>Tool Result: TodoList</summary>

<!-- call_id: tool_WoSBR8nK5SNCUperNFyz7tBo -->
Todo list updated.
Current todo list:
  [done] Review backlog and select next epic
  [done] Set up isolated worktree for chosen feature
  [done] Chunk 1: Policy CRD and evaluator package
  [done] Chunk 2: CRD changes for inline source and policy results
  [done] Chunk 3: Protobuf and ApplyBundle API server handler
  [done] Chunk 4a: Release controller inline manifest path
  [done] Chunk 4b: Application controller inline source handling
  [done] Chunk 4c: True rollback
  [done] Chunk 5: CLI apply command and TUI
  [done] Chunk 6: UI, RBAC manifests, and final integration
  [done] Chunk 7: Validation webhooks
  [done] Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)
  [in_progress] Set up worktree for Approval Gates
  [pending] Write Approval Gates implementation plan
  [pending] Implement Approval Gates using subagent-driven-development

Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.

</details>

<details><summary>Thinking</summary>

Now create new worktree for Approval Gates from current master? The apply worktree branch is feature/paprika-apply-cli. We want approval-gates off master. But master in worktree? The main working tree is on master (HEAD at 6cf4b59? Actually main repo after merge has latest master). We can create worktree `.worktrees/approval-gates` from master. Use `git worktree add .worktrees/approval-gates -b feature/approval-gates master`. Need ensure branch name. Then run baseline tests? We already know baseline passes. But per skill, run tests in new worktree. It may take time; we can do it. But maybe we can skip because we just ran tests in apply worktree which is same commit. However worktree is isolated; skill says verify clean baseline. We can run `make test` again. It will be cached for many packages, but still generate proto. Should be okay. Let's create worktree and run go mod download and maybe test.

</details>

#### Tool Call: Bash (`git worktree add .worktrees/approval-gates -b feature/approv…`)
<!-- call_id: tool_0wp13Z2wXsNMjnTKpEW3F0k8 -->
```json
{
  "command": "git worktree add .worktrees/approval-gates -b feature/approval-gates master && cd .worktrees/approval-gates && go mod download",
  "timeout": 120
}
```

<details><summary>Tool Result: Bash (`git worktree add .worktrees/approval-gates -b feature/approv…`)</summary>

<!-- call_id: tool_0wp13Z2wXsNMjnTKpEW3F0k8 -->
Preparing worktree (new branch 'feature/approval-gates')
HEAD is now at 6cf4b59 test(e2e): probe AppProject webhook to confirm reachability before specs


</details>

<details><summary>Thinking</summary>

Wait the new worktree is at 6cf4b59, which is master before apply changes. The apply changes are on feature branch; they aren't merged to master. That's fine; approval gates is independent. But if we want apply improvements in master, we'd need merge later. Not now.

Run baseline tests in approval-gates worktree. Use timeout 300.

</details>

#### Tool Call: Bash (`cd .worktrees/approval-gates && make test`)
<!-- call_id: tool_fcNHA9dmB0YlqYK3SVh3Dlx0 -->
```json
{
  "command": "cd .worktrees/approval-gates && make test",
  "timeout": 300
}
```

<details><summary>Tool Result: Bash (`cd .worktrees/approval-gates && make test`)</summary>

<!-- call_id: tool_fcNHA9dmB0YlqYK3SVh3Dlx0 -->
<system>ERROR: Tool execution failed.</system>
mkdir -p "/Users/benebsworth/projects/paprika/.worktrees/approval-gates/bin"
Downloading sigs.k8s.io/controller-tools/cmd/controller-gen@v0.20.1
"/Users/benebsworth/projects/paprika/.worktrees/approval-gates/bin/controller-gen" rbac:roleName=manager-role crd:allowDangerousTypes=true webhook paths="/Users/benebsworth/projects/paprika/.worktrees/approval-gates/api/clusters/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/api/core/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/api/featureflags/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/api/pipelines/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/api/policy/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/api/rollouts/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/cmd;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/cmd/cloud-run;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/cmd/paprika;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/agent;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/agent/server;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/agentclient;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/analysis;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/api;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/api/auth;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/api/events;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/api/mocks;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/api/paprika/v1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/api/paprika/v1/v1connect;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/cache;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/cache/mocks;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/clock;/Users/benebsworth/projects/paprika/.worktrees/appr[...truncated]
Generating protobuf clients...
go tool buf generate
Failure: plugin ui/node_modules/.bin/protoc-gen-connect-es: exec: "ui/node_modules/.bin/protoc-gen-connect-es": stat ui/node_modules/.bin/protoc-gen-connect-es: no such file or directory
plugin ui/node_modules/.bin/protoc-gen-es: exec: "ui/node_modules/.bin/protoc-gen-es": stat ui/node_modules/.bin/protoc-gen-es: no such file or directory
plugin protoc-gen-connect-go: context canceled
plugin protoc-gen-go: context canceled
make: *** [generate-proto] Error 1
Command failed with exit code: 2. Output is truncated to fit in the message.

</details>

<details><summary>Thinking</summary>

Need install UI node_modules in new worktree. Do that.

</details>

#### Tool Call: Bash (`cd .worktrees/approval-gates/ui && npm install`)
<!-- call_id: tool_66FaAZdlpkbd3XS4MZDM4ngK -->
```json
{
  "command": "cd .worktrees/approval-gates/ui && npm install",
  "timeout": 300
}
```

<details><summary>Tool Result: Bash (`cd .worktrees/approval-gates/ui && npm install`)</summary>

<!-- call_id: tool_66FaAZdlpkbd3XS4MZDM4ngK -->
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@inquirer/ansi@2.0.7',
npm warn EBADENGINE   required: { node: '>=23.5.0 || ^22.13.0 || ^20.17.0' },
npm warn EBADENGINE   current: { node: 'v22.9.0', npm: '10.8.3' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@inquirer/confirm@6.1.1',
npm warn EBADENGINE   required: { node: '>=23.5.0 || ^22.13.0 || ^20.17.0' },
npm warn EBADENGINE   current: { node: 'v22.9.0', npm: '10.8.3' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@inquirer/core@11.2.1',
npm warn EBADENGINE   required: { node: '>=23.5.0 || ^22.13.0 || ^20.17.0' },
npm warn EBADENGINE   current: { node: 'v22.9.0', npm: '10.8.3' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@inquirer/figures@2.0.7',
npm warn EBADENGINE   required: { node: '>=23.5.0 || ^22.13.0 || ^20.17.0' },
npm warn EBADENGINE   current: { node: 'v22.9.0', npm: '10.8.3' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@inquirer/type@4.0.7',
npm warn EBADENGINE   required: { node: '>=23.5.0 || ^22.13.0 || ^20.17.0' },
npm warn EBADENGINE   current: { node: 'v22.9.0', npm: '10.8.3' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: 'eslint-visitor-keys@5.0.1',
npm warn EBADENGINE   required: { node: '^20.19.0 || ^22.13.0 || >=24' },
npm warn EBADENGINE   current: { node: 'v22.9.0', npm: '10.8.3' }
npm warn EBADENGINE }
npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead

added 812 packages, and audited 813 packages in 8s

360 packages are looking for funding
  run `npm fund` for details

5 vulnerabilities (4 moderate, 1 high)

To address issues that do not require attention, run:
  npm audit fix

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.


</details>

<details><summary>Thinking</summary>

Run make test in approval-gates.

</details>

#### Tool Call: Bash (`cd .worktrees/approval-gates && make test`)
<!-- call_id: tool_6KGK2XKtaGoDVBOHNJP60cyQ -->
```json
{
  "command": "cd .worktrees/approval-gates && make test",
  "timeout": 300
}
```

<details><summary>Tool Result: Bash (`cd .worktrees/approval-gates && make test`)</summary>

<!-- call_id: tool_6KGK2XKtaGoDVBOHNJP60cyQ -->
"/Users/benebsworth/projects/paprika/.worktrees/approval-gates/bin/controller-gen" rbac:roleName=manager-role crd:allowDangerousTypes=true webhook paths="/Users/benebsworth/projects/paprika/.worktrees/approval-gates/api/clusters/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/api/core/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/api/featureflags/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/api/pipelines/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/api/policy/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/api/rollouts/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/cmd;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/cmd/cloud-run;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/cmd/paprika;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/agent;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/agent/server;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/agentclient;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/analysis;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/api;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/api/auth;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/api/events;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/api/mocks;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/api/paprika/v1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/api/paprika/v1/v1connect;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/cache;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/cache/mocks;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/clock;/Users/benebsworth/projects/paprika/.worktrees/appr[...truncated]
Generating protobuf clients...
go tool buf generate
Downloading go.uber.org/mock/mockgen@v0.6.0
"/Users/benebsworth/projects/paprika/.worktrees/approval-gates/bin/controller-gen" object:headerFile="hack/boilerplate.go.txt",year=2026 paths="/Users/benebsworth/projects/paprika/.worktrees/approval-gates/api/clusters/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/api/core/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/api/featureflags/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/api/pipelines/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/api/policy/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/api/rollouts/v1alpha1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/cmd;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/cmd/cloud-run;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/cmd/paprika;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/agent;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/agent/server;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/agentclient;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/analysis;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/api;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/api/auth;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/api/events;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/api/mocks;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/api/paprika/v1;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/api/paprika/v1/v1connect;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/cache;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/cache/mocks;/Users/benebsworth/projects/paprika/.worktrees/approval-gates/internal/clock;/Users/benebsworth/projects/paprika/.worktrees/approval-gates[...truncated]
PATH="/Users/benebsworth/projects/paprika/.worktrees/approval-gates/bin:/Users/benebsworth/.local/bin:/Users/benebsworth/.kimi-code/bin:/Users/benebsworth/.opencode/bin:/Users/benebsworth/.antigravity/antigravity/bin:/opt/homebrew/opt/postgresql@17/bin:/Users/benebsworth/.codeium/windsurf/bin:/Users/benebsworth/.nvm/versions/node/v22.9.0/bin:/Users/benebsworth/.bun/bin:/Users/benebsworth/.pyenv/shims:/Users/benebsworth/.pyenv/plugins/pyenv-virtualenv/shims:/Users/benebsworth/.pyenv/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/Users/benebsworth/.local/bin:/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/local/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/appleinternal/bin:/pkg/env/global/bin:/Library/Apple/usr/bin:/Users/benebsworth/.cargo/bin:/Applications/Ghostty.app/Contents/MacOS:/Users/benebsworth/go/bin:/Users/benebsworth/Library/Android/sdk/emulator:/Users/benebsworth/Library/Android/sdk/platform-tools:/Users/benebsworth/Downloads/google-cloud-sdk/bin" go generate ./...
go fmt ./...
go vet ./...
Downloading sigs.k8s.io/controller-runtime/tools/setup-envtest@release-0.23
Setting up envtest binaries for Kubernetes version 1.35...
/Users/benebsworth/projects/paprika/.worktrees/approval-gates/bin/k8s/1.35.0-darwin-arm64KUBEBUILDER_ASSETS="/Users/benebsworth/projects/paprika/.worktrees/approval-gates/bin/k8s/1.35.0-darwin-arm64" go test $(go list ./... | grep -v /e2e) -coverprofile cover.out
	github.com/benebsworth/paprika/api/clusters/v1alpha1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/api/core/v1alpha1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/api/featureflags/v1alpha1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/api/pipelines/v1alpha1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/api/policy/v1alpha1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/api/rollouts/v1alpha1		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/cmd	4.149s	coverage: 16.6% of statements
	github.com/benebsworth/paprika/cmd/cloud-run		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/cmd/paprika	3.006s	coverage: 15.6% of statements
ok  	github.com/benebsworth/paprika/internal/agent	1.151s	coverage: [no statements]
	github.com/benebsworth/paprika/internal/agent/server		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/agentclient		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/analysis	2.603s	coverage: 15.7% of statements
ok  	github.com/benebsworth/paprika/internal/api	2.076s	coverage: 28.2% of statements
ok  	github.com/benebsworth/paprika/internal/api/auth	0.629s	coverage: 65.4% of statements
ok  	github.com/benebsworth/paprika/internal/api/events	4.520s	coverage: 54.0% of statements
	github.com/benebsworth/paprika/internal/api/mocks		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/api/paprika/v1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/cache	4.737s	coverage: 34.6% of statements
	github.com/benebsworth/paprika/internal/cache/mocks		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/clock		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/controller/bootstrap		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/controller/clusters	16.129s	coverage: 31.5% of statements
ok  	github.com/benebsworth/paprika/internal/controller/core	15.963s	coverage: 37.8% of statements
ok  	github.com/benebsworth/paprika/internal/controller/pipelines	17.563s	coverage: 48.5% of statements
	github.com/benebsworth/paprika/internal/controller/pipelines/mocks		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/controller/policy	15.565s	coverage: 33.3% of statements
	github.com/benebsworth/paprika/internal/controller/rollouts		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/engine	2.480s	coverage: 41.0% of statements
	github.com/benebsworth/paprika/internal/featureflag		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/featureflag/kubernetes		coverage: 0.0% of statements
	github.com/benebsworth/paprika/internal/featureflag/openfeature		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/gates	5.855s	coverage: 96.6% of statements
ok  	github.com/benebsworth/paprika/internal/governance	4.707s	coverage: 68.2% of statements
ok  	github.com/benebsworth/paprika/internal/health	2.910s	coverage: 51.7% of statements
ok  	github.com/benebsworth/paprika/internal/metrics	3.433s	coverage: 30.8% of statements
ok  	github.com/benebsworth/paprika/internal/observability	4.990s	coverage: 39.0% of statements
ok  	github.com/benebsworth/paprika/internal/policy	5.783s	coverage: 90.0% of statements
ok  	github.com/benebsworth/paprika/internal/ratelimit	6.180s	coverage: 92.1% of statements
ok  	github.com/benebsworth/paprika/internal/reposerver	4.860s	coverage: 14.7% of statements
ok  	github.com/benebsworth/paprika/internal/reposerverclient	5.458s	coverage: 30.0% of statements
ok  	github.com/benebsworth/paprika/internal/repository	5.471s	coverage: 85.7% of statements
	github.com/benebsworth/paprika/internal/rollout		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/rollout/abtest	5.799s	coverage: 67.5% of statements
ok  	github.com/benebsworth/paprika/internal/rollout/bluegreen	5.867s	coverage: 61.1% of statements
ok  	github.com/benebsworth/paprika/internal/rollout/canary	5.636s	coverage: 51.4% of statements
?   	github.com/benebsworth/paprika/internal/rollout/core	[no test files]
	github.com/benebsworth/paprika/internal/rollout/hash		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/rollout/mirror	5.852s	coverage: 62.2% of statements
ok  	github.com/benebsworth/paprika/internal/rollout/rolling	5.971s	coverage: 75.0% of statements
ok  	github.com/benebsworth/paprika/internal/sharding	6.103s	coverage: 92.9% of statements
ok  	github.com/benebsworth/paprika/internal/source	11.578s	coverage: 30.9% of statements
ok  	github.com/benebsworth/paprika/internal/syncwindow	7.122s	coverage: 96.2% of statements
	github.com/benebsworth/paprika/internal/traffic		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/traffic/gatewayapi	6.874s	coverage: 75.5% of statements
ok  	github.com/benebsworth/paprika/internal/traffic/istio	6.525s	coverage: 74.7% of statements
	github.com/benebsworth/paprika/internal/traffic/mocks		coverage: 0.0% of statements
ok  	github.com/benebsworth/paprika/internal/webhook/core/v1alpha1	6.833s	coverage: 76.7% of statements
ok  	github.com/benebsworth/paprika/internal/webhook/pipelines/v1alpha1	11.338s	coverage: 88.7% of statements
ok  	github.com/benebsworth/paprika/internal/webhook/policy/v1alpha1	6.439s	coverage: 85.5% of statements
ok  	github.com/benebsworth/paprika/internal/webhook/receiver	6.563s	coverage: 72.0% of statements
	github.com/benebsworth/paprika/internal/webhook/rollouts/v1alpha1		coverage: 0.0% of statements
	github.com/benebsworth/paprika/test/utils		coverage: 0.0% of statements
	github.com/benebsworth/paprika/ui/node_modules/flatted/golang/pkg/flatted		coverage: 0.0% of statements
Command executed successfully. Output is truncated to fit in the message.

</details>

<details><summary>Thinking</summary>

Baseline passes. Mark worktree setup done. Now we need write Approval Gates plan. Use writing-plans skill. Read it.

</details>

#### Tool Call: TodoList
<!-- call_id: tool_xnZSvOix3u7bInuo35WUrt01 -->
```json
{
  "todos": [
    {
      "title": "Review backlog and select next epic",
      "status": "done"
    },
    {
      "title": "Set up isolated worktree for chosen feature",
      "status": "done"
    },
    {
      "title": "Chunk 1: Policy CRD and evaluator package",
      "status": "done"
    },
    {
      "title": "Chunk 2: CRD changes for inline source and policy results",
      "status": "done"
    },
    {
      "title": "Chunk 3: Protobuf and ApplyBundle API server handler",
      "status": "done"
    },
    {
      "title": "Chunk 4a: Release controller inline manifest path",
      "status": "done"
    },
    {
      "title": "Chunk 4b: Application controller inline source handling",
      "status": "done"
    },
    {
      "title": "Chunk 4c: True rollback",
      "status": "done"
    },
    {
      "title": "Chunk 5: CLI apply command and TUI",
      "status": "done"
    },
    {
      "title": "Chunk 6: UI, RBAC manifests, and final integration",
      "status": "done"
    },
    {
      "title": "Chunk 7: Validation webhooks",
      "status": "done"
    },
    {
      "title": "Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)",
      "status": "done"
    },
    {
      "title": "Set up worktree for Approval Gates",
      "status": "done"
    },
    {
      "title": "Write Approval Gates implementation plan",
      "status": "in_progress"
    },
    {
      "title": "Implement Approval Gates using subagent-driven-development",
      "status": "pending"
    }
  ]
}
```

<details><summary>Tool Result: TodoList</summary>

<!-- call_id: tool_xnZSvOix3u7bInuo35WUrt01 -->
Todo list updated.
Current todo list:
  [done] Review backlog and select next epic
  [done] Set up isolated worktree for chosen feature
  [done] Chunk 1: Policy CRD and evaluator package
  [done] Chunk 2: CRD changes for inline source and policy results
  [done] Chunk 3: Protobuf and ApplyBundle API server handler
  [done] Chunk 4a: Release controller inline manifest path
  [done] Chunk 4b: Application controller inline source handling
  [done] Chunk 4c: True rollback
  [done] Chunk 5: CLI apply command and TUI
  [done] Chunk 6: UI, RBAC manifests, and final integration
  [done] Chunk 7: Validation webhooks
  [done] Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)
  [done] Set up worktree for Approval Gates
  [in_progress] Write Approval Gates implementation plan
  [pending] Implement Approval Gates using subagent-driven-development

Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.

</details>

<details><summary>Thinking</summary>

Read writing-plans skill.

</details>

#### Tool Call: Read (`/Users/benebsworth/.agents/skills/superpowers/writing-plans/…`)
<!-- call_id: tool_ROqdZu8E9eZPRfAOcfAsNs7Y -->
```json
{
  "path": "/Users/benebsworth/.agents/skills/superpowers/writing-plans/SKILL.md",
  "n_lines": 1000
}
```

<details><summary>Tool Result: Read (`/Users/benebsworth/.agents/skills/superpowers/writing-plans/…`)</summary>

<!-- call_id: tool_ROqdZu8E9eZPRfAOcfAsNs7Y -->
1	---
2	name: writing-plans
3	description: Use when you have a spec or requirements for a multi-step task, before touching code
4	---
5	
6	# Writing Plans
7	
8	## Overview
9	
10	Write comprehensive implementation plans assuming the engineer has zero context for our codebase and questionable taste. Document everything they need to know: which files to touch for each task, code, testing, docs they might need to check, how to test it. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.
11	
12	Assume they are a skilled developer, but know almost nothing about our toolset or problem domain. Assume they don't know good test design very well.
13	
14	**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."
15	
16	**Context:** This should be run in a dedicated worktree (created by brainstorming skill).
17	
18	**Save plans to:** `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`
19	- (User preferences for plan location override this default)
20	
21	## Scope Check
22	
23	If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. If it wasn't, suggest breaking this into separate plans — one per subsystem. Each plan should produce working, testable software on its own.
24	
25	## File Structure
26	
27	Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.
28	
29	- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
30	- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
31	- Files that change together should live together. Split by responsibility, not by technical layer.
32	- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.
33	
34	This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.
35	
36	## Bite-Sized Task Granularity
37	
38	**Each step is one action (2-5 minutes):**
39	- "Write the failing test" - step
40	- "Run it to make sure it fails" - step
41	- "Implement the minimal code to make the test pass" - step
42	- "Run the tests and make sure they pass" - step
43	- "Commit" - step
44	
45	## Plan Document Header
46	
47	**Every plan MUST start with this header:**
48	
49	```markdown
50	# [Feature Name] Implementation Plan
51	
52	> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.
53	
54	**Goal:** [One sentence describing what this builds]
55	
56	**Architecture:** [2-3 sentences about approach]
57	
58	**Tech Stack:** [Key technologies/libraries]
59	
60	---
61	```
62	
63	## Task Structure
64	
65	````markdown
66	### Task N: [Component Name]
67	
68	**Files:**
69	- Create: `exact/path/to/file.py`
70	- Modify: `exact/path/to/existing.py:123-145`
71	- Test: `tests/exact/path/to/test.py`
72	
73	- [ ] **Step 1: Write the failing test**
74	
75	```python
76	def test_specific_behavior():
77	    result = function(input)
78	    assert result == expected
79	```
80	
81	- [ ] **Step 2: Run test to verify it fails**
82	
83	Run: `pytest tests/path/test.py::test_name -v`
84	Expected: FAIL with "function not defined"
85	
86	- [ ] **Step 3: Write minimal implementation**
87	
88	```python
89	def function(input):
90	    return expected
91	```
92	
93	- [ ] **Step 4: Run test to verify it passes**
94	
95	Run: `pytest tests/path/test.py::test_name -v`
96	Expected: PASS
97	
98	- [ ] **Step 5: Commit**
99	
100	```bash
101	git add tests/path/test.py src/path/file.py
102	git commit -m "feat: add specific feature"
103	```
104	````
105	
106	## Remember
107	- Exact file paths always
108	- Complete code in plan (not "add validation")
109	- Exact commands with expected output
110	- Reference relevant skills with @ syntax
111	- DRY, YAGNI, TDD, frequent commits
112	
113	## Plan Review Loop
114	
115	After completing each chunk of the plan:
116	
117	1. Dispatch plan-document-reviewer subagent (see plan-document-reviewer-prompt.md) with precisely crafted review context — never your session history. This keeps the reviewer focused on the plan, not your thought process.
118	   - Provide: chunk content, path to spec document
119	2. If ❌ Issues Found:
120	   - Fix the issues in the chunk
121	   - Re-dispatch reviewer for that chunk
122	   - Repeat until ✅ Approved
123	3. If ✅ Approved: proceed to next chunk (or execution handoff if last chunk)
124	
125	**Chunk boundaries:** Use `## Chunk N: <name>` headings to delimit chunks. Each chunk should be ≤1000 lines and logically self-contained.
126	
127	**Review loop guidance:**
128	- Same agent that wrote the plan fixes it (preserves context)
129	- If loop exceeds 5 iterations, surface to human for guidance
130	- Reviewers are advisory - explain disagreements if you believe feedback is incorrect
131	
132	## Execution Handoff
133	
134	After saving the plan:
135	
136	**"Plan complete and saved to `docs/superpowers/plans/<filename>.md`. Ready to execute?"**
137	
138	**Execution path depends on harness capabilities:**
139	
140	**If harness has subagents (Claude Code, etc.):**
141	- **REQUIRED:** Use superpowers:subagent-driven-development
142	- Do NOT offer a choice - subagent-driven is the standard approach
143	- Fresh subagent per task + two-stage review
144	
145	**If harness does NOT have subagents:**
146	- Execute plan in current session using superpowers:executing-plans
147	- Batch execution with checkpoints for review
<system>147 lines read from file starting from line 1. Total lines in file: 147. End of file reached.</system>

</details>

<details><summary>Thinking</summary>

We need write Approval Gates plan. This is a substantial design task. We should explore existing Stage/Gate/Release structures to design. Let's inspect current types: StageSpec has Gates? ApplicationPromotionStage has Gates? Release controller handles gates? The plan needs to integrate with existing gates package. Let's explore.

</details>

#### Tool Call: Grep (`.worktrees/approval-gates/api/pipelines/v1alpha1`)
<!-- call_id: tool_i01hWsZLRohStTrt4R1aVjAG -->
```json
{
  "path": ".worktrees/approval-gates/api/pipelines/v1alpha1",
  "pattern": "Gate|gate|Gates|Approval|approval|Approver|approver",
  "output_mode": "content",
  "-n": true,
  "head_limit": 100
}
```

<details><summary>Tool Result: Grep (`.worktrees/approval-gates/api/pipelines/v1alpha1`)</summary>

<!-- call_id: tool_i01hWsZLRohStTrt4R1aVjAG -->
.worktrees/approval-gates/api/pipelines/v1alpha1/release_types.go:65:	Verify    []GateConfig   `json:"verify,omitempty"`
.worktrees/approval-gates/api/pipelines/v1alpha1/stage_types.go:29:// GateConfig defines a gate for stage promotion.
.worktrees/approval-gates/api/pipelines/v1alpha1/stage_types.go:30:// GateConfig defines a gate for stage promotion.
.worktrees/approval-gates/api/pipelines/v1alpha1/stage_types.go:31:type GateConfig struct {
.worktrees/approval-gates/api/pipelines/v1alpha1/stage_types.go:86:	// Provider specifies the traffic router provider ("istio" or "gateway-api").
.worktrees/approval-gates/api/pipelines/v1alpha1/stage_types.go:87:	// +kubebuilder:validation:Enum=istio;gateway-api
.worktrees/approval-gates/api/pipelines/v1alpha1/stage_types.go:92:	GatewayAPI *GatewayAPIRouterConfig `json:"gatewayApi,omitempty"`
.worktrees/approval-gates/api/pipelines/v1alpha1/stage_types.go:114:// GatewayAPIRouterConfig defines the Gateway API HTTPRoute configuration for traffic routing.
.worktrees/approval-gates/api/pipelines/v1alpha1/stage_types.go:115:type GatewayAPIRouterConfig struct {
.worktrees/approval-gates/api/pipelines/v1alpha1/stage_types.go:133:	Gates     []GateConfig `json:"gates,omitempty"`
.worktrees/approval-gates/api/pipelines/v1alpha1/application_types.go:41:	// SyncManual requires manual approval to sync changes.
.worktrees/approval-gates/api/pipelines/v1alpha1/application_types.go:92:// AnalysisResult aggregates the latest state of a single AnalysisRun for the UI/API.
.worktrees/approval-gates/api/pipelines/v1alpha1/application_types.go:261:	// Verification gates to run after promotion
.worktrees/approval-gates/api/pipelines/v1alpha1/application_types.go:263:	Gates []GateConfig `json:"gates,omitempty"`
.worktrees/approval-gates/api/pipelines/v1alpha1/application_types.go:323:// ApprovalGate defines a manual or automated approval gate for stage transitions.
.worktrees/approval-gates/api/pipelines/v1alpha1/application_types.go:324:type ApprovalGate struct {
.worktrees/approval-gates/api/pipelines/v1alpha1/application_types.go:325:	// Name of the gate
.worktrees/approval-gates/api/pipelines/v1alpha1/application_types.go:327:	// Stage at which this gate applies (e.g., "prod")
.worktrees/approval-gates/api/pipelines/v1alpha1/application_types.go:329:	// Type of gate: manual, webhook, slack
.worktrees/approval-gates/api/pipelines/v1alpha1/application_types.go:332:	// Whether the gate is required (default true)
.worktrees/approval-gates/api/pipelines/v1alpha1/application_types.go:337:// GateStatus represents the current status of an approval gate.
.worktrees/approval-gates/api/pipelines/v1alpha1/application_types.go:338:type GateStatus struct {
.worktrees/approval-gates/api/pipelines/v1alpha1/application_types.go:406:	// ApprovalGates define manual approval gates for stage transitions.
.worktrees/approval-gates/api/pipelines/v1alpha1/application_types.go:408:	ApprovalGates []ApprovalGate `json:"approvalGates,omitempty"`
.worktrees/approval-gates/api/pipelines/v1alpha1/application_types.go:511:	// Approval gate status
.worktrees/approval-gates/api/pipelines/v1alpha1/application_types.go:513:	Gates []GateStatus `json:"gates,omitempty"`
.worktrees/approval-gates/api/pipelines/v1alpha1/application_types.go:519:	// AnalysisResults aggregate the latest background analysis state.
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:509:	if in.Gates != nil {
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:510:		in, out := &in.Gates, &out.Gates
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:511:		*out = make([]GateConfig, len(*in))
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:743:	if in.ApprovalGates != nil {
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:744:		in, out := &in.ApprovalGates, &out.ApprovalGates
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:745:		*out = make([]ApprovalGate, len(*in))
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:837:	if in.Gates != nil {
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:838:		in, out := &in.Gates, &out.Gates
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:839:		*out = make([]GateStatus, len(*in))
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:882:func (in *ApprovalGate) DeepCopyInto(out *ApprovalGate) {
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:886:// DeepCopy is an autogenerated deepcopy function, copying the receiver, creating a new ApprovalGate.
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:887:func (in *ApprovalGate) DeepCopy() *ApprovalGate {
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:891:	out := new(ApprovalGate)
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:1102:func (in *GateConfig) DeepCopyInto(out *GateConfig) {
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:1106:// DeepCopy is an autogenerated deepcopy function, copying the receiver, creating a new GateConfig.
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:1107:func (in *GateConfig) DeepCopy() *GateConfig {
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:1111:	out := new(GateConfig)
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:1117:func (in *GateStatus) DeepCopyInto(out *GateStatus) {
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:1121:// DeepCopy is an autogenerated deepcopy function, copying the receiver, creating a new GateStatus.
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:1122:func (in *GateStatus) DeepCopy() *GateStatus {
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:1126:	out := new(GateStatus)
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:1132:func (in *GatewayAPIRouterConfig) DeepCopyInto(out *GatewayAPIRouterConfig) {
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:1136:// DeepCopy is an autogenerated deepcopy function, copying the receiver, creating a new GatewayAPIRouterConfig.
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:1137:func (in *GatewayAPIRouterConfig) DeepCopy() *GatewayAPIRouterConfig {
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:1141:	out := new(GatewayAPIRouterConfig)
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:1867:		*out = make([]GateConfig, len(*in))
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:2100:	if in.Gates != nil {
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:2101:		in, out := &in.Gates, &out.Gates
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:2102:		*out = make([]GateConfig, len(*in))
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:2331:	if in.GatewayAPI != nil {
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:2332:		in, out := &in.GatewayAPI, &out.GatewayAPI
.worktrees/approval-gates/api/pipelines/v1alpha1/zz_generated.deepcopy.go:2333:		*out = new(GatewayAPIRouterConfig)

</details>

<details><summary>Thinking</summary>

There are already ApprovalGate types and GateStatus in Application types! So some scaffolding exists. We need inspect them and see what's implemented. The TODO says Approval Gates no plan yet; but types exist. Maybe only types. Let's read application_types around ApprovalGate.

</details>

#### Tool Call: Read (`.worktrees/approval-gates/api/pipelines/v1alpha1/application…`)
<!-- call_id: tool_6qKhCqZkmy0pgC98IRCDGG2P -->
```json
{
  "path": ".worktrees/approval-gates/api/pipelines/v1alpha1/application_types.go",
  "line_offset": 300,
  "n_lines": 120
}
```

<details><summary>Tool Result: Read (`.worktrees/approval-gates/api/pipelines/v1alpha1/application…`)</summary>

<!-- call_id: tool_6qKhCqZkmy0pgC98IRCDGG2P -->
300		// Timeout in seconds (default 5)
301		// +kubebuilder:default=5
302		Timeout int `json:"timeout,omitempty"`
303	}
304	
305	// HealthCheck defines a health check.
306	// HealthCheck defines a health check.
307	type HealthCheck struct {
308		// Name of the health check
309		Name string `json:"name"`
310		// CEL expression to evaluate. Available variables:
311		//   app (Application spec), status (Application status), http (HTTP probe results).
312		// Expression must return a boolean or a string matching HealthStatus.
313		Expression string `json:"expression"`
314		// Optional HTTP probe to run before evaluating the expression.
315		// Results available in CEL as http.status, http.body, http.headers.
316		// +optional
317		HTTPProbe *HTTPProbe `json:"httpProbe,omitempty"`
318		// How often to run this check (default 30s)
319		// +kubebuilder:default="30s"
320		Interval string `json:"interval,omitempty"`
321	}
322	
323	// ApprovalGate defines a manual or automated approval gate for stage transitions.
324	type ApprovalGate struct {
325		// Name of the gate
326		Name string `json:"name"`
327		// Stage at which this gate applies (e.g., "prod")
328		Stage string `json:"stage"`
329		// Type of gate: manual, webhook, slack
330		// +kubebuilder:validation:Enum=manual;webhook;slack
331		Type string `json:"type"`
332		// Whether the gate is required (default true)
333		// +kubebuilder:default=true
334		Required bool `json:"required,omitempty"`
335	}
336	
337	// GateStatus represents the current status of an approval gate.
338	type GateStatus struct {
339		Name       string `json:"name"`
340		Stage      string `json:"stage"`
341		Status     string `json:"status"` // Pending, Approved, Rejected
342		ApprovedBy string `json:"approvedBy,omitempty"`
343	}
344	
345	// HealthCheckResult contains the result of a single health check evaluation.
346	type HealthCheckResult struct {
347		Name      string       `json:"name"`
348		Status    HealthStatus `json:"status"`
349		Message   string       `json:"message,omitempty"`
350		CheckedAt *metav1.Time `json:"checkedAt,omitempty"`
351		// HTTP probe results
352		HTTPStatusCode int    `json:"httpStatusCode,omitempty"`
353		HTTPBody       string `json:"httpBody,omitempty"`
354	}
355	
356	// ApplicationSpec defines the specification for an application.
357	// ApplicationSpec defines the specification for an application.
358	type ApplicationSpec struct {
359		// Project references the AppProject that governs this application.
360		// +optional
361		// +kubebuilder:default:=default
362		Project string `json:"project,omitempty"`
363	
364		// Source defines where the application code/chart lives.
365		Source ApplicationSource `json:"source"`
366	
367		// Build defines the CI pipeline steps (optional — skip if no build needed).
368		// +optional
369		Build *ApplicationBuildSpec `json:"build,omitempty"`
370	
371		// Stages defines the promotion environments (dev, staging, prod, etc.).
372		Stages []ApplicationPromotionStage `json:"stages"`
373	
374		// Strategy is the default delivery strategy for all stages.
375		// Can be overridden per-stage.
376		// +kubebuilder:validation:Enum=Rolling;Canary;BlueGreen
377		// +kubebuilder:default=Rolling
378		Strategy DeliveryStrategy `json:"strategy,omitempty"`
379	
380		// Canary defines the default canary configuration.
381		// Overridden by per-stage canary config.
382		// +optional
383		Canary *CanaryConfig `json:"canary,omitempty"`
384	
385		// SyncPolicy controls whether changes are applied automatically.
386		// +kubebuilder:validation:Enum=Auto;Manual
387		// +kubebuilder:default=Auto
388		SyncPolicy SyncPolicy `json:"syncPolicy,omitempty"`
389	
390		// SyncOptions fine-tunes how manifests are applied and pruned.
391		// +optional
392		SyncOptions *SyncOptions `json:"syncOptions,omitempty"`
393	
394		// Parameters are Helm value overrides passed to all releases.
395		// +optional
396		Parameters map[string]string `json:"parameters,omitempty"`
397	
398		// OnFailure defines the action when a promotion fails.
399		// +optional
400		OnFailure *FailureAction `json:"onFailure,omitempty"`
401	
402		// HealthChecks define custom CEL-based health checks for the application.
403		// +optional
404		HealthChecks []HealthCheck `json:"healthChecks,omitempty"`
405	
406		// ApprovalGates define manual approval gates for stage transitions.
407		// +optional
408		ApprovalGates []ApprovalGate `json:"approvalGates,omitempty"`
409	
410		// SelfHeal controls automatic remediation when drift or health failures are detected.
411		// +optional
412		SelfHeal *SelfHealConfig `json:"selfHeal,omitempty"`
413	
414		// SyncWindows restrict when automatic sync may run.
415		// +optional
416		SyncWindows []SyncWindow `json:"syncWindows,omitempty"`
417	
418		// AnalysisTemplates references reusable analysis templates that run continuously
419		// in the background after the application is healthy.
<system>120 lines read from file starting from line 300. Total lines in file: 571.</system>

</details>

<details><summary>Thinking</summary>

ApprovalGate types exist but are minimal. No implementation. We need design plan for approval gates. The plan should define CRD enhancements (add config fields per gate type), controller logic, API/CLI commands, notifications. This is a big plan. We need understand existing gates package and release controller promotion flow. Let's explore gates package and release controller around gates.

</details>

#### Tool Call: Read (`.worktrees/approval-gates/internal/gates/gates.go`)
<!-- call_id: tool_5qSpFai9a7bRZ3PtwdzXYgNn -->
```json
{
  "path": ".worktrees/approval-gates/internal/gates/gates.go",
  "n_lines": 200
}
```

<details><summary>Tool Result: Read (`.worktrees/approval-gates/internal/gates/gates.go`)</summary>

<!-- call_id: tool_5qSpFai9a7bRZ3PtwdzXYgNn -->
1	// Package gates provides verification gate implementations for pipeline promotion stages.
2	package gates
3	
4	import (
5		"context"
6		"fmt"
7		"net/http"
8		"time"
9	)
10	
11	// GateResult contains the result of a gate execution.
12	type GateResult struct {
13		Passed  bool
14		Message string
15		Error   error
16	}
17	
18	// GateConfig holds the configuration for executing a gate.
19	type GateConfig struct {
20		Type     string `json:"type"`
21		Endpoint string `json:"endpoint,omitempty"`
22		Timeout  int    `json:"timeout,omitempty"`
23	}
24	
25	// SmokeGate performs HTTP smoke tests against an endpoint.
26	type SmokeGate struct {
27		Client *http.Client
28	}
29	
30	// NewSmokeGate creates a new SmokeGate with the given HTTP client.
31	// If client is nil, http.DefaultClient is used.
32	func NewSmokeGate(client *http.Client) *SmokeGate {
33		if client == nil {
34			client = http.DefaultClient
35		}
36		return &SmokeGate{Client: client}
37	}
38	
39	// Execute runs the smoke test against the configured endpoint.
40	func (g *SmokeGate) Execute(ctx context.Context, config GateConfig) GateResult {
41		timeout := config.Timeout
42		if timeout <= 0 {
43			timeout = 300
44		}
45	
46		ctx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
47		defer cancel()
48	
49		req, err := http.NewRequestWithContext(ctx, http.MethodGet, config.Endpoint, http.NoBody)
50		if err != nil {
51			return GateResult{Passed: false, Message: fmt.Sprintf("failed to create request: %v", err), Error: err}
52		}
53	
54		resp, err := g.Client.Do(req)
55		if err != nil {
56			return GateResult{Passed: false, Message: fmt.Sprintf("HTTP request failed: %v", err), Error: err}
57		}
58		defer func() { _ = resp.Body.Close() }() //nolint:errcheck // best-effort body close
59	
60		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
61			return GateResult{Passed: true, Message: fmt.Sprintf("HTTP %d", resp.StatusCode)}
62		}
63	
64		return GateResult{Passed: false, Message: fmt.Sprintf("HTTP %d (expected 2xx)", resp.StatusCode)}
65	}
66	
67	// DurationGate waits for a specified duration as a verification gate.
68	type DurationGate struct{}
69	
70	// Execute runs the duration gate, waiting for the configured timeout.
71	func (g *DurationGate) Execute(ctx context.Context, config GateConfig) GateResult {
72		timeout := config.Timeout
73		if timeout <= 0 {
74			timeout = 60
75		}
76	
77		select {
78		case <-time.After(time.Duration(timeout) * time.Second):
79			return GateResult{Passed: true, Message: fmt.Sprintf("waited %d seconds", timeout)}
80		case <-ctx.Done():
81			return GateResult{Passed: false, Message: "context cancelled during duration gate", Error: ctx.Err()}
82		}
83	}
84	
85	// ExecuteGate dispatches to the appropriate gate implementation based on config type.
86	func ExecuteGate(ctx context.Context, config GateConfig) GateResult {
87		switch config.Type {
88		case "smoke-test":
89			return NewSmokeGate(nil).Execute(ctx, config)
90		case "duration":
91			return (&DurationGate{}).Execute(ctx, config)
92		default:
93			return GateResult{Passed: false, Message: "unknown gate type: " + config.Type}
94		}
95	}
<system>95 lines read from file starting from line 1. Total lines in file: 95. End of file reached.</system>

</details>

<details><summary>Thinking</summary>

Existing gates are verification gates (smoke, duration) run after promotion. Approval gates are different: pause before promotion until approved. We need design. Let's inspect release controller promotion flow and where gates are executed.

</details>

#### Tool Call: Grep (`.worktrees/approval-gates/internal/controller/pipelines/rele…`)
<!-- call_id: tool_73APHND3on6NKoLOz1WsM2i7 -->
```json
{
  "path": ".worktrees/approval-gates/internal/controller/pipelines/release_controller.go",
  "pattern": "promote\\(|reconcileReleasePhase|Gate|gate|Verify|verify|shouldPromote|canPromote|await|Approve|approve",
  "output_mode": "content",
  "-n": true,
  "head_limit": 100
}
```

<details><summary>Tool Result: Grep (`.worktrees/approval-gates/internal/controller/pipelines/rele…`)</summary>

<!-- call_id: tool_73APHND3on6NKoLOz1WsM2i7 -->
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:46:	"github.com/benebsworth/paprika/internal/gates"
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:99:	GateExecutor         GateExecutor
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:140:// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=httproutes,verbs=get;list;watch;update;patch
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:196:	return r.reconcileReleasePhase(ctx, req, &release, start, &result)
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:199:func (r *ReleaseReconciler) reconcileReleasePhase(ctx context.Context, req ctrl.Request, release *paprikav1.Release, start time.Time, result *string) (ctrl.Result, error) {
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:236:	if release.Status.Phase == paprikav1.ReleaseVerifying {
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:237:		return r.handleVerifyingPhase(ctx, release, result)
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:313:func (r *ReleaseReconciler) transitionToVerifying(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:315:	release.Status.Phase = paprikav1.ReleaseVerifying
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:316:	metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Verifying").Inc()
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:319:		return ctrl.Result{}, fmt.Errorf("failed to transition to verifying: %w", err)
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:390:	if err := r.promote(ctx, release); err != nil {
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:403:		release.Status.Phase = paprikav1.ReleaseVerifying
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:404:		metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Verifying").Inc()
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:415:		release.Status.Phase = paprikav1.ReleaseVerifying
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:416:		metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Verifying").Inc()
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:463:		release.Status.Phase = paprikav1.ReleaseVerifying
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:464:		metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Verifying").Inc()
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:525:	if tr.GatewayAPI != nil {
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:526:		out.GatewayAPI = &rolloutsv1alpha1.GatewayAPIRouterConfig{
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:527:			HTTPRoute:     tr.GatewayAPI.HTTPRoute,
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:528:			StableService: tr.GatewayAPI.StableService,
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:529:			CanaryService: tr.GatewayAPI.CanaryService,
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:535:func (r *ReleaseReconciler) handleVerifyingPhase(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:536:	if r.verify(ctx, release) {
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:647:				other.Status.Phase == paprikav1.ReleaseVerifying) {
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:673:func (r *ReleaseReconciler) promote(ctx context.Context, release *paprikav1.Release) error {
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:686:	// Governance gate: parse, normalize, validate, evaluate policies.
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:692:	app, err := r.runGovernanceGate(ctx, release, manifestObjects)
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:694:		return fmt.Errorf("run governance gate: %w", err)
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:802://nolint:cyclop,nestif // governance gate has sequential validation branches.
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:803:func (r *ReleaseReconciler) runGovernanceGate(ctx context.Context, release *paprikav1.Release, manifestObjects []*unstructured.Unstructured) (*paprikav1.Application, error) {
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1292:func (r *ReleaseReconciler) verify(ctx context.Context, release *paprikav1.Release) bool {
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1295:	gateConfigs := release.Spec.Verify
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1296:	if len(gateConfigs) == 0 {
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1300:	for _, cfg := range gateConfigs {
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1301:		gateCfg := gates.GateConfig{
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1306:		result := r.GateExecutor.Execute(ctx, gateCfg)
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1308:			log.Info("Gate failed", "type", cfg.Type, "message", result.Message)
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1311:		log.Info("Gate passed", "type", cfg.Type, "message", result.Message)
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1629:		return r.transitionToVerifying(ctx, release, result)
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1672:	if r.canPromoteCanary(stepIdx, canaryCfg.Steps, currentWeight) {
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1704:func (r *ReleaseReconciler) canPromoteCanary(stepIdx int, steps []int, currentWeight int) bool {
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1714:	if stage.Spec.TrafficRouter.Provider == traffic.ProviderGatewayAPI && stage.Spec.TrafficRouter.GatewayAPI != nil {
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1715:		stableSvc = stage.Spec.TrafficRouter.GatewayAPI.StableService
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1716:		canarySvc = stage.Spec.TrafficRouter.GatewayAPI.CanaryService
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1806:	release.Status.Phase = paprikav1.ReleaseVerifying
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1807:	metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Verifying").Inc()
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1812:		return ctrl.Result{}, fmt.Errorf("failed to transition to verifying: %w", err)
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1852:	app, err := r.runGovernanceGate(ctx, release, manifestObjects)
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1854:		return fmt.Errorf("run governance gate: %w", err)
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1898:	app, err := r.runGovernanceGate(ctx, release, manifestObjects)
.worktrees/approval-gates/internal/controller/pipelines/release_controller.go:1900:		return fmt.Errorf("run governance gate: %w", err)

</details>

<details><summary>Thinking</summary>

Need understand release phases and promotion. Read reconcileReleasePhase around line 199-470.

</details>

#### Tool Call: Read (`.worktrees/approval-gates/internal/controller/pipelines/rele…`)
<!-- call_id: tool_J2mFNLgt9xddeQ1RnlqTUSfK -->
```json
{
  "path": ".worktrees/approval-gates/internal/controller/pipelines/release_controller.go",
  "line_offset": 199,
  "n_lines": 300
}
```

<details><summary>Tool Result: Read (`.worktrees/approval-gates/internal/controller/pipelines/rele…`)</summary>

<!-- call_id: tool_J2mFNLgt9xddeQ1RnlqTUSfK -->
199	func (r *ReleaseReconciler) reconcileReleasePhase(ctx context.Context, req ctrl.Request, release *paprikav1.Release, start time.Time, result *string) (ctrl.Result, error) {
200		if res, handled, err := r.handleResyncAnnotation(ctx, release, result); handled {
201			return res, err
202		}
203	
204		// Handle rollback requests before checking for terminal phases so that a
205		// failed release with OnFailure=rollback, or any release annotated with
206		// paprika.io/rollback-requested, can be rolled back.
207		if r.shouldRollback(release) {
208			return r.handleFailedRollback(ctx, release, result)
209		}
210	
211		if r.isReleaseTerminal(release) {
212			return ctrl.Result{}, nil
213		}
214	
215		if release.Status.Phase == paprikav1.ReleasePending {
216			return r.handlePendingPhase(ctx, release, result)
217		}
218	
219		if err := r.checkConcurrentRelease(ctx, release); err != nil {
220			*result = resultError
221			return ctrl.Result{}, err
222		}
223	
224		if release.Status.Phase == "" {
225			return r.initiateRelease(ctx, release, req.Namespace, result)
226		}
227	
228		if release.Status.Phase == paprikav1.ReleasePromoting {
229			return r.handlePromotingPhase(ctx, release, result)
230		}
231	
232		if release.Status.Phase == paprikav1.ReleaseCanarying {
233			return r.reconcileCanary(ctx, release, start, result)
234		}
235	
236		if release.Status.Phase == paprikav1.ReleaseVerifying {
237			return r.handleVerifyingPhase(ctx, release, result)
238		}
239	
240		return ctrl.Result{}, nil
241	}
242	
243	func (r *ReleaseReconciler) getRelease(ctx context.Context, req ctrl.Request) (paprikav1.Release, error) {
244		var release paprikav1.Release
245		if err := r.client.Get(ctx, req.NamespacedName, &release); err != nil {
246			if client.IgnoreNotFound(err) != nil {
247				return release, fmt.Errorf("getting release: %w", err)
248			}
249			return release, nil
250		}
251		return release, nil
252	}
253	
254	func (r *ReleaseReconciler) ensureReleaseFinalizer(ctx context.Context, release *paprikav1.Release) error {
255		if controllerutil.ContainsFinalizer(release, releaseFinalizer) {
256			return nil
257		}
258		controllerutil.AddFinalizer(release, releaseFinalizer)
259		if err := r.client.Update(ctx, release); err != nil {
260			return fmt.Errorf("adding release finalizer: %w", err)
261		}
262		return nil
263	}
264	
265	func (r *ReleaseReconciler) handleReleaseDeletion(ctx context.Context, release *paprikav1.Release) (ctrl.Result, error) {
266		if !controllerutil.ContainsFinalizer(release, releaseFinalizer) {
267			return ctrl.Result{}, nil
268		}
269		if err := r.cleanup(ctx, release); err != nil {
270			return ctrl.Result{}, fmt.Errorf("cleaning up release: %w", err)
271		}
272		controllerutil.RemoveFinalizer(release, releaseFinalizer)
273		if err := r.client.Update(ctx, release); err != nil {
274			return ctrl.Result{}, fmt.Errorf("removing release finalizer: %w", err)
275		}
276		return ctrl.Result{}, nil
277	}
278	
279	func (r *ReleaseReconciler) isReleaseTerminal(release *paprikav1.Release) bool {
280		return release.Status.Phase == paprikav1.ReleaseComplete ||
281			release.Status.Phase == paprikav1.ReleaseFailed ||
282			release.Status.Phase == paprikav1.ReleaseRolledBack ||
283			release.Status.Phase == paprikav1.ReleaseSuperseded
284	}
285	
286	func (r *ReleaseReconciler) handleResyncAnnotation(ctx context.Context, release *paprikav1.Release, result *string) (res ctrl.Result, handled bool, err error) {
287		if _, ok := release.Annotations[resyncAnnotation]; !ok {
288			return ctrl.Result{}, false, nil
289		}
290	
291		if r.isReleaseTerminal(release) {
292			oldPhase := release.Status.Phase
293			release.Status.Phase = paprikav1.ReleasePending
294			if err := r.patchReleaseStatus(ctx, release, oldPhase); err != nil {
295				*result = resultError
296				return ctrl.Result{}, true, fmt.Errorf("resetting release phase to pending: %w", err)
297			}
298		}
299	
300		patch := client.MergeFrom(release.DeepCopy())
301		delete(release.Annotations, resyncAnnotation)
302		if err := r.client.Patch(ctx, release, patch); err != nil {
303			*result = resultError
304			return ctrl.Result{}, true, fmt.Errorf("clearing resync annotation: %w", err)
305		}
306		return ctrl.Result{RequeueAfter: 1 * time.Second}, true, nil
307	}
308	
309	func (r *ReleaseReconciler) hasCanarySteps(stage *paprikav1.Stage) bool {
310		return stage.Spec.Canary != nil && len(stage.Spec.Canary.Steps) > 0
311	}
312	
313	func (r *ReleaseReconciler) transitionToVerifying(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {
314		oldPhase := release.Status.Phase
315		release.Status.Phase = paprikav1.ReleaseVerifying
316		metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Verifying").Inc()
317		if err := r.patchReleaseStatus(ctx, release, oldPhase); err != nil {
318			*result = resultError
319			return ctrl.Result{}, fmt.Errorf("failed to transition to verifying: %w", err)
320		}
321		return ctrl.Result{Requeue: true}, nil
322	}
323	
324	func (r *ReleaseReconciler) getCanaryInterval(canaryCfg *paprikav1.CanaryConfig) time.Duration {
325		if canaryCfg.IntervalSeconds > 0 {
326			return time.Duration(canaryCfg.IntervalSeconds) * time.Second
327		}
328		return 30 * time.Second
329	}
330	
331	func (r *ReleaseReconciler) shouldRollback(release *paprikav1.Release) bool {
332		// Already rolled-back or superseded releases should not be re-processed.
333		if release.Status.Phase == paprikav1.ReleaseRolledBack ||
334			release.Status.Phase == paprikav1.ReleaseSuperseded {
335			return false
336		}
337		if release.Spec.OnFailure != nil && release.Spec.OnFailure.Action == rollbackAction {
338			if _, ok := release.Annotations[rollbackAnnotation]; ok {
339				return true
340			}
341		}
342		return release.Status.Phase == paprikav1.ReleaseFailed &&
343			release.Spec.OnFailure != nil &&
344			release.Spec.OnFailure.Action == "rollback"
345	}
346	
347	func (r *ReleaseReconciler) handlePendingPhase(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {
348		hasActiveConcurrent, err := r.hasActiveConcurrentRelease(ctx, release)
349		if err != nil {
350			return ctrl.Result{}, fmt.Errorf("checking active concurrent release: %w", err)
351		}
352		if hasActiveConcurrent {
353			return ctrl.Result{}, nil
354		}
355		oldPhase := release.Status.Phase
356		release.Status.Phase = paprikav1.ReleasePromoting
357		metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Promoting").Inc()
358		if err := r.patchReleaseStatus(ctx, release, oldPhase); err != nil {
359			return ctrl.Result{}, fmt.Errorf("failed to transition from pending to promoting: %w", err)
360		}
361		return ctrl.Result{Requeue: true}, nil
362	}
363	
364	func (r *ReleaseReconciler) initiateRelease(ctx context.Context, release *paprikav1.Release, namespace string, result *string) (ctrl.Result, error) {
365		var stage paprikav1.Stage
366		if err := r.client.Get(ctx, types.NamespacedName{Name: release.Spec.Target, Namespace: namespace}, &stage); err != nil {
367			*result = resultError
368			return ctrl.Result{}, fmt.Errorf("target stage %q not found: %w", release.Spec.Target, err)
369		}
370	
371		oldPhase := release.Status.Phase
372		release.Status.Phase = paprikav1.ReleasePromoting
373		metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Promoting").Inc()
374		release.Status.CurrentStage = release.Spec.Target
375		release.Status.PromotionHistory = append(release.Status.PromotionHistory, paprikav1.PromotionEntry{
376			Stage:     release.Spec.Target,
377			Result:    "Pending",
378			Timestamp: metav1.Now(),
379		})
380		if err := r.patchReleaseStatus(ctx, release, oldPhase); err != nil {
381			*result = resultError
382			return ctrl.Result{}, fmt.Errorf("failed to set release promoting: %w", err)
383		}
384		return ctrl.Result{Requeue: true}, nil
385	}
386	
387	func (r *ReleaseReconciler) handlePromotingPhase(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {
388		log := logf.FromContext(ctx)
389		oldPhase := release.Status.Phase
390		if err := r.promote(ctx, release); err != nil {
391			log.Error(err, "Promotion failed", "release", release.Name)
392			release.Status.Phase = paprikav1.ReleaseFailed
393			metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Failed").Inc()
394			if updateErr := r.patchReleaseStatus(ctx, release, oldPhase); updateErr != nil {
395				*result = resultError
396				return ctrl.Result{}, fmt.Errorf("failed to set release failed: %w", updateErr)
397			}
398			return ctrl.Result{}, nil
399		}
400	
401		var stage paprikav1.Stage
402		if err := r.client.Get(ctx, types.NamespacedName{Name: release.Spec.Target, Namespace: release.Namespace}, &stage); err != nil {
403			release.Status.Phase = paprikav1.ReleaseVerifying
404			metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Verifying").Inc()
405		} else if stage.Spec.RolloutStrategy != nil {
406			return r.reconcileRolloutManagedRelease(ctx, release, &stage, result)
407		} else if stage.Spec.Canary != nil && len(stage.Spec.Canary.Steps) > 0 {
408			release.Status.Phase = paprikav1.ReleaseCanarying
409			metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Canarying").Inc()
410			release.Status.CanaryStepIndex = 0
411			if len(stage.Spec.Canary.Steps) > 0 {
412				release.Status.CanaryWeight = stage.Spec.Canary.Steps[0]
413			}
414		} else {
415			release.Status.Phase = paprikav1.ReleaseVerifying
416			metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Verifying").Inc()
417		}
418		if err := r.patchReleaseStatus(ctx, release, oldPhase); err != nil {
419			*result = resultError
420			return ctrl.Result{}, fmt.Errorf("failed to update release phase: %w", err)
421		}
422		return ctrl.Result{Requeue: true}, nil
423	}
424	
425	func (r *ReleaseReconciler) reconcileRolloutManagedRelease(ctx context.Context, release *paprikav1.Release, stage *paprikav1.Stage, result *string) (ctrl.Result, error) {
426		log := logf.FromContext(ctx)
427		rolloutName := release.Name + "-rollout"
428	
429		var ro rolloutsv1alpha1.Rollout
430		err := r.client.Get(ctx, types.NamespacedName{Name: rolloutName, Namespace: release.Namespace}, &ro)
431		if err != nil && !apierrors.IsNotFound(err) {
432			*result = resultError
433			return ctrl.Result{}, fmt.Errorf("getting rollout %s: %w", rolloutName, err)
434		}
435	
436		expected := r.buildRollout(release, stage, rolloutName)
437		if apierrors.IsNotFound(err) {
438			if err := r.client.Create(ctx, expected); err != nil {
439				*result = resultError
440				return ctrl.Result{}, fmt.Errorf("creating rollout %s: %w", rolloutName, err)
441			}
442			release.Status.RolloutRef = rolloutName
443			release.Status.Phase = paprikav1.ReleaseCanarying
444			metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Canarying").Inc()
445			if err := r.patchReleaseStatus(ctx, release, release.Status.Phase); err != nil {
446				*result = resultError
447				return ctrl.Result{}, fmt.Errorf("updating release status: %w", err)
448			}
449			return ctrl.Result{Requeue: true}, nil
450		}
451	
452		ro.Spec = expected.Spec
453		ro.Labels = expected.Labels
454		if err := r.client.Update(ctx, &ro); err != nil {
455			*result = resultError
456			return ctrl.Result{}, fmt.Errorf("updating rollout %s: %w", rolloutName, err)
457		}
458	
459		release.Status.RolloutRef = rolloutName
460		oldPhase := release.Status.Phase
461		switch ro.Status.Phase {
462		case rolloutsv1alpha1.RolloutPhaseHealthy:
463			release.Status.Phase = paprikav1.ReleaseVerifying
464			metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Verifying").Inc()
465		case rolloutsv1alpha1.RolloutPhaseFailed, rolloutsv1alpha1.RolloutPhaseDegraded:
466			release.Status.Phase = paprikav1.ReleaseFailed
467			metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Failed").Inc()
468		case rolloutsv1alpha1.RolloutPhaseRolledBack:
469			release.Status.Phase = paprikav1.ReleaseRolledBack
470			metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "RolledBack").Inc()
471		default:
472			release.Status.Phase = paprikav1.ReleaseCanarying
473		}
474	
475		if err := r.patchReleaseStatus(ctx, release, oldPhase); err != nil {
476			*result = resultError
477			return ctrl.Result{}, fmt.Errorf("patching release status: %w", err)
478		}
479		log.Info("Rollout-managed release reconciled", "rollout", rolloutName, "phase", release.Status.Phase)
480		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
481	}
482	
483	func (r *ReleaseReconciler) buildRollout(release *paprikav1.Release, stage *paprikav1.Stage, name string) *rolloutsv1alpha1.Rollout {
484		ro := &rolloutsv1alpha1.Rollout{
485			ObjectMeta: metav1.ObjectMeta{
486				Name:      name,
487				Namespace: release.Namespace,
488				Labels:    release.Labels,
489				OwnerReferences: []metav1.OwnerReference{{
490					APIVersion: paprikav1.GroupVersion.String(),
491					Kind:       "Release",
492					Name:       release.Name,
493					UID:        release.UID,
494					Controller: ptr(true),
495				}},
496			},
497			Spec: rolloutsv1alpha1.RolloutSpec{
498				Target: rolloutsv1alpha1.RolloutTarget{
<system>300 lines read from file starting from line 199. Total lines in file: 2022.</system>

</details>

<details><summary>Thinking</summary>

The promotion flow: Pending -> Promoting -> promote() -> Verifying/Canarying. Approval gates should pause before promote (in Pending or Promoting). We can introduce a new phase `ReleaseAwaitingApproval` or check in handlePendingPhase / handlePromotingPhase. The Application spec has ApprovalGates list. The Release status has GateStatus list. We need design:

- ApprovalGate CRD fields expanded:
  - Name, Stage (optional? maybe match stage name), Type (manual, webhook, slack)
  - Required bool
  - For webhook: URL, method, headers, timeout, success condition (status code/body)
  - For slack: channel, webhook URL, mention users, timeout
  - Manual: maybe approvers list, message
- GateStatus in Application status tracks pending/approved/rejected per gate.
- A new `Approval` CRD? Or use status updates via API/CLI. The plan says manual/webhook/Slack gates. We can model approvals as:
  - Manual: controller sets gate status Pending and waits. User calls `paprika gates approve <app> --gate <name>` via API, which updates Application status or creates an Approval resource.
  - Webhook: controller calls URL; if returns success, approved.
  - Slack: controller sends message via Slack webhook and waits. User reacts/approves via external Slack integration? Hard to implement fully. Could simulate by expecting an Approval resource created from Slack receiver. We can start with manual and webhook; Slack as future.

Given "no detailed plan yet", we can design a pragmatic Approval Gates v1: manual gates and webhook gates. Slack can be documented as Phase 2.

The controller logic:
- When a Release enters Pending for a stage, evaluate approval gates for that stage from Application spec.
- If all required gates approved, proceed to Promoting.
- If any gate rejected, fail release.
- If pending, set Application status GateStatus and requeue with backoff.
- Add API RPC `ApproveGate`, `RejectGate`, `ListGateStatus`.
- Add CLI commands `paprika gates approve|reject|list`.
- Add webhook gate executor in `internal/gates`.

We also need consider per-stage gates: Application spec ApprovalGates includes stage name. Stage spec currently has `Gates []GateConfig` for verification gates. We can add `ApprovalGates []ApprovalGate` to StageSpec or rely on Application spec. The existing types have ApprovalGates on ApplicationSpec. We can extend that.

The Release controller currently transitions Pending->Promoting immediately. We'll insert approval evaluation in handlePendingPhase or a new phase. To avoid changing too much, we can check approval gates before transitioning to Promoting; if pending, set phase to `ReleaseAwaitingApproval` (need add constant) and requeue.

We need add `ReleaseAwaitingApproval` phase constant? Check release_types phases.

</details>

#### Tool Call: Grep (`.worktrees/approval-gates/api/pipelines/v1alpha1/release_typ…`)
<!-- call_id: tool_6omAY6Cx93Q90mgOwvgnEuDp -->
```json
{
  "path": ".worktrees/approval-gates/api/pipelines/v1alpha1/release_types.go",
  "pattern": "ReleasePhase|ReleasePending|ReleasePromoting|ReleaseComplete|ReleaseFailed|type ReleasePhase",
  "output_mode": "content",
  "-n": true
}
```

<details><summary>Tool Result: Grep (`.worktrees/approval-gates/api/pipelines/v1alpha1/release_typ…`)</summary>

<!-- call_id: tool_6omAY6Cx93Q90mgOwvgnEuDp -->
.worktrees/approval-gates/api/pipelines/v1alpha1/release_types.go:7:// ReleasePhase represents the phase of a release.
.worktrees/approval-gates/api/pipelines/v1alpha1/release_types.go:8:type ReleasePhase string
.worktrees/approval-gates/api/pipelines/v1alpha1/release_types.go:11:	// ReleasePending indicates the release is pending.
.worktrees/approval-gates/api/pipelines/v1alpha1/release_types.go:12:	ReleasePending ReleasePhase = "Pending"
.worktrees/approval-gates/api/pipelines/v1alpha1/release_types.go:13:	// ReleasePromoting indicates the release is promoting.
.worktrees/approval-gates/api/pipelines/v1alpha1/release_types.go:14:	ReleasePromoting ReleasePhase = "Promoting"
.worktrees/approval-gates/api/pipelines/v1alpha1/release_types.go:16:	ReleaseCanarying ReleasePhase = "Canarying"
.worktrees/approval-gates/api/pipelines/v1alpha1/release_types.go:18:	ReleaseVerifying ReleasePhase = "Verifying"
.worktrees/approval-gates/api/pipelines/v1alpha1/release_types.go:19:	// ReleaseComplete indicates the release completed successfully.
.worktrees/approval-gates/api/pipelines/v1alpha1/release_types.go:20:	ReleaseComplete ReleasePhase = "Complete"
.worktrees/approval-gates/api/pipelines/v1alpha1/release_types.go:21:	// ReleaseFailed indicates the release failed.
.worktrees/approval-gates/api/pipelines/v1alpha1/release_types.go:22:	ReleaseFailed ReleasePhase = "Failed"
.worktrees/approval-gates/api/pipelines/v1alpha1/release_types.go:24:	ReleaseRolledBack ReleasePhase = "RolledBack"
.worktrees/approval-gates/api/pipelines/v1alpha1/release_types.go:26:	ReleaseSuperseded ReleasePhase = "Superseded"
.worktrees/approval-gates/api/pipelines/v1alpha1/release_types.go:85:	Phase                    ReleasePhase       `json:"phase,omitempty"`

</details>

<details><summary>Thinking</summary>

We can add `ReleaseAwaitingApproval` phase. Also maybe `ReleaseApprovalPending`? Let's use `AwaitingApproval`.

The plan writing is substantial. We need perhaps delegate the plan writing to a subagent? The skill says the same agent writes the plan, but we can use a plan subagent? The `plan` subagent type exists for read-only implementation planning. We could use it to produce a plan. But writing-plans skill says save plan to docs. We can write the plan ourselves or delegate to a subagent. Since it's a big design, we can use a `plan` subagent to create the plan, then review it. However writing-plans skill says "same agent that wrote the plan fixes it". If subagent writes, same subagent can fix. That's okay.

Let's use a plan subagent to write the Approval Gates implementation plan. Provide it with context: repo path, existing types, release controller flow, gates package, API/CLI patterns. Ask it to save plan to docs/superpowers/plans/2026-06-19-approval-gates.md. Then we can review.

But the `plan` subagent is read-only? It says read-only implementation planning and architecture design. It might not write files. Actually plan subagent tools include Read, Glob, Grep, WebSearch, FetchURL — no Write. So it cannot write the plan file. We need write it ourselves or use coder subagent. The writing-plans skill says write comprehensive plan. We can write it ourselves. But to save context, we can use an explore subagent to gather facts, then we write the plan. Or we can use a coder subagent to draft the plan file. But the skill expects plan file; a coder can write it. However plan subagent maybe better for architecture. Let's gather info with explore subagent about API/CLI patterns, then write plan.

Actually, we can write a concise but complete plan ourselves. We know enough from code. We need to be careful about exact file paths and code. The plan should include:

Chunk 1: Extend CRD types
- Extend `ApprovalGate` in `api/pipelines/v1alpha1/application_types.go` with config fields for manual/webhook.
- Add `ApprovalGate` to `StageSpec` in `api/pipelines/v1alpha1/stage_types.go` maybe optional.
- Add `ReleaseAwaitingApproval` phase constant in `api/pipelines/v1alpha1/release_types.go`.
- Regenerate deepcopy and CRDs.

Chunk 2: Gate evaluator package
- Create `internal/gates/approval_gate.go` with `ApprovalGateEvaluator` interface and implementations `ManualGate`, `WebhookGate`.
- `ManualGate` checks Application status gate statuses.
- `WebhookGate` calls HTTP endpoint.
- Add tests.

Chunk 3: Release controller integration
- Modify `internal/controller/pipelines/release_controller.go`:
  - Add `ApprovalGateEvaluator` dependency.
  - In `handlePendingPhase` (or new `handleAwaitingApprovalPhase`), evaluate approval gates for target stage.
  - If pending, set phase `AwaitingApproval`, update Application status `GateStatus`, requeue after interval.
  - If approved, proceed to Promoting.
  - If rejected, fail release.
- Add RBAC markers.
- Add tests.

Chunk 4: API/Protobuf
- Add `ApproveGate`, `RejectGate`, `ListGateStatus` RPCs in proto.
- Regenerate.
- Implement handlers in `internal/api/server.go` to update Application status gate statuses.
- Add authz checks.
- Add tests.

Chunk 5: CLI
- Add `paprika gates approve`, `reject`, `list` commands in `cmd/paprika/gates.go` (exists? There's gates.go). Use existing client.
- Add tests.

Chunk 6: UI
- Update dashboard application detail page to show approval gates and approve/reject buttons.
- Update generated protobuf client if needed.

Chunk 7: Notifications
- Send notification when gate is pending (reuse notifications package).
- Optional.

Chunk 8: E2E test
- Add e2e test for manual approval gate.

This is a big plan. We need write it in detail with code snippets. That's a lot. We can use a subagent to draft it. Let's use a coder subagent with instructions to write the plan file, not implement. It can inspect existing code and write a detailed plan. Then we review. This may be more efficient.

We need provide the subagent with the worktree path and ask it to save plan to `docs/superpowers/plans/2026-06-19-approval-gates.md`. It should follow writing-plans format. It should read relevant files. Let's dispatch.

</details>

#### Tool Call: Agent (`Draft Approval Gates plan`)
<!-- call_id: tool_s3SUqSWs9WTg7l1uHPrSX1Oc -->
```json
{
  "description": "Draft Approval Gates plan",
  "subagent_type": "coder",
  "prompt": "You are drafting a detailed implementation plan for a new Paprika feature: **Approval Gates**.\n\n**Context**\n- Repo worktree: `/Users/benebsworth/projects/paprika/.worktrees/approval-gates`\n- The feature is listed in `TODO.md` as the next high-priority P2 item: \"Approval Gates — manual/webhook/Slack gates between stages; pause promotion until approved\".\n- There are already minimal scaffolding types in `api/pipelines/v1alpha1/application_types.go`: `ApprovalGate` and `GateStatus`. They are not implemented anywhere.\n- Existing verification gates live in `internal/gates/gates.go` (SmokeGate, DurationGate) and are run after promotion via `release.Spec.Verify`.\n- Approval gates must pause promotion *before* it happens, then allow it to continue once approved.\n\n**Your task**\nWrite a comprehensive implementation plan to `docs/superpowers/plans/2026-06-19-approval-gates.md` following the format required by `superpowers:writing-plans`:\n- Header with goal, architecture, tech stack.\n- Chunked tasks (`## Chunk N: ...`) with file paths and checkbox steps.\n- Each step is one action (2-5 minutes).\n- Include concrete code snippets where helpful.\n- Reference relevant skills (`@superpowers:subagent-driven-development`).\n\n**Scope for v1**\n- Manual approval gates (CLI/API approve/reject).\n- Webhook approval gates (HTTP POST to a configured URL; success = approved).\n- Slack gates: design the interface and outgoing webhook, but mark actual Slack interaction handling as Phase 2 unless it can be done trivially via an incoming webhook receiver.\n- Per-stage gates: gates can be defined on `ApplicationSpec.ApprovalGates` and optionally on `StageSpec.ApprovalGates`.\n- New `ReleaseAwaitingApproval` phase.\n- New API RPCs: `ListGateStatus`, `ApproveGate`, `RejectGate`.\n- New CLI commands: `paprika gates list`, `paprika gates approve`, `paprika gates reject`.\n- UI updates to show pending gates and allow approve/reject.\n- Unit tests and one E2E test for a manual gate.\n\n**Important constraints**\n- Follow existing project conventions (Kubebuilder, controller-runtime, Connect-RPC, Next.js, Ginkgo/Gomega where appropriate).\n- Do not change unrelated code.\n- Keep commits small and focused.\n- The plan must be detailed enough for a subagent to implement without asking clarifying questions.\n\nBefore writing, inspect:\n- `api/pipelines/v1alpha1/application_types.go`, `stage_types.go`, `release_types.go`\n- `internal/controller/pipelines/release_controller.go` (especially `reconcileReleasePhase`, `handlePendingPhase`, `handlePromotingPhase`, `promote`)\n- `internal/gates/gates.go`\n- `internal/api/server.go` and `proto/paprika/v1/api.proto`\n- `cmd/paprika/main.go` and existing gate/CLI files\n- `ui/src/app/dashboard/application/page.tsx`\n\nWrite only the plan file. Do not implement any code. Report the path and a one-paragraph summary when done."
}
```

<details><summary>Tool Result: Agent (`Draft Approval Gates plan`)</summary>

<!-- call_id: tool_s3SUqSWs9WTg7l1uHPrSX1Oc -->
agent_id: agent-82
actual_subagent_type: coder
status: completed

[summary]
Plan saved to `docs/superpowers/plans/2026-06-19-approval-gates.md`.

The plan extends the existing `ApprovalGate`/`GateStatus` CRD types and adds per-stage `ApprovalGates` to `StageSpec`, introduces a new `ReleaseAwaitingApproval` phase, and moves the blocking decision into the Release controller so gates pause promotion before `promote()` runs. It adds a reusable `internal/gates/approval.go` evaluator for manual, webhook, and Phase-2 Slack gates; implements `ListGateStatus` and `RejectGate` Connect-RPCs alongside the existing `ApproveGate`; adds `paprika gates list/reject` CLI commands; surfaces pending gates with approve/reject buttons in the application detail UI; and includes unit tests for the evaluator/release controller plus one Ginkgo envtest for a manual gate. Each chunk contains file paths, concrete code snippets, exact commands, and small commit steps.

</details>

<details><summary>Thinking</summary>

Great. We need review the plan. Read it.

</details>

#### Tool Call: Read (`.worktrees/approval-gates/docs/superpowers/plans/2026-06-19-…`)
<!-- call_id: tool_CrUwEvGiCZ1fqAerWK2wGzbP -->
```json
{
  "path": ".worktrees/approval-gates/docs/superpowers/plans/2026-06-19-approval-gates.md",
  "n_lines": 1000
}
```

<details><summary>Tool Result: Read (`.worktrees/approval-gates/docs/superpowers/plans/2026-06-19-…`)</summary>

<!-- call_id: tool_CrUwEvGiCZ1fqAerWK2wGzbP -->
1	# Approval Gates Implementation Plan
2	
3	> **For agentic workers:** REQUIRED: Use @superpowers:subagent-driven-development (if subagents available) or @superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.
4	
5	**Goal:** Add manual, webhook, and Slack approval gates that pause a Release before promotion to a stage and resume once approved, exposing gate status through new API RPCs, CLI commands, and the UI.
6	
7	**Architecture:** Extend the existing `ApprovalGate`/`GateStatus` CRD types and add per-stage gates on `StageSpec`. Move the blocking decision from the Application controller to the Release controller by evaluating gates at the start of `handlePromotingPhase`; pending gates transition the Release to a new `AwaitingApproval` phase and record status on the owning Application. Manual gates wait for API/UI approval; webhook gates call a configurable HTTP endpoint; Slack gates are scaffolded as Phase 2. New Connect-RPC methods (`ListGateStatus`, `ApproveGate`, `RejectGate`) and CLI/UI commands surface and mutate gate state.
8	
9	**Tech Stack:** Go, Kubernetes controller-runtime, kubebuilder, Protocol Buffers (buf), Ginkgo/Gomega, envtest, React/TypeScript/Next.js, Tailwind CSS.
10	
11	---
12	
13	## Chunk 1: API Schema
14	
15	### Task 1: Extend `ApprovalGate` and `GateStatus` in `Application`
16	
17	**Files:**
18	- Modify: `api/pipelines/v1alpha1/application_types.go`
19	
20	- [ ] **Step 1: Add approval gate constants**
21	
22	  Insert after the existing `ApprovalGate`/`GateStatus` structs (around line 344):
23	
24	  ```go
25	  // ApprovalGateType values.
26	  const (
27	      ApprovalGateTypeManual  = "manual"
28	      ApprovalGateTypeWebhook = "webhook"
29	      ApprovalGateTypeSlack   = "slack"
30	  )
31	
32	  // GateStatus values.
33	  const (
34	      GateStatusPending  = "Pending"
35	      GateStatusApproved = "Approved"
36	      GateStatusRejected = "Rejected"
37	  )
38	  ```
39	
40	- [ ] **Step 2: Replace the `ApprovalGate` struct**
41	
42	  ```go
43	  // ApprovalGate defines a manual or automated approval gate for stage transitions.
44	  type ApprovalGate struct {
45	      // Name of the gate
46	      Name string `json:"name"`
47	      // Stage at which this gate applies (e.g., "prod"). Empty applies to all stages.
48	      // +optional
49	      Stage string `json:"stage,omitempty"`
50	      // Type of gate: manual, webhook, slack
51	      // +kubebuilder:validation:Enum=manual;webhook;slack
52	      Type string `json:"type"`
53	      // Whether the gate is required (default true)
54	      // +kubebuilder:default=true
55	      // +optional
56	      Required bool `json:"required,omitempty"`
57	
58	      // URL is the webhook URL for webhook gates.
59	      // +optional
60	      URL string `json:"url,omitempty"`
61	      // HTTP method for webhook gates. Defaults to POST.
62	      // +kubebuilder:default=POST
63	      // +optional
64	      Method string `json:"method,omitempty"`
65	      // Headers to send with webhook requests.
66	      // +optional
67	      Headers map[string]string `json:"headers,omitempty"`
68	      // Body template sent to webhook gates.
69	      // +optional
70	      Body string `json:"body,omitempty"`
71	      // SuccessStatus is the expected HTTP status code for approval (default any 2xx).
72	      // +kubebuilder:default=200
73	      // +optional
74	      SuccessStatus int `json:"successStatus,omitempty"`
75	      // SecretRef names a Secret in the same namespace whose data is added to webhook headers.
76	      // +optional
77	      SecretRef string `json:"secretRef,omitempty"`
78	
79	      // SlackWebhookURL is the incoming Slack webhook URL used to notify a channel.
80	      // Phase 2: actual Slack interaction handling.
81	      // +optional
82	      SlackWebhookURL string `json:"slackWebhookUrl,omitempty"`
83	      // SlackChannel is the channel to notify for Slack gates.
84	      // +optional
85	      SlackChannel string `json:"slackChannel,omitempty"`
86	  }
87	  ```
88	
89	- [ ] **Step 3: Replace the `GateStatus` struct**
90	
91	  ```go
92	  // GateStatus represents the current status of an approval gate.
93	  type GateStatus struct {
94	      Name       string `json:"name"`
95	      Stage      string `json:"stage"`
96	      Type       string `json:"type,omitempty"`
97	      Status     string `json:"status"` // Pending, Approved, Rejected
98	      ApprovedBy string `json:"approvedBy,omitempty"`
99	      Message    string `json:"message,omitempty"`
100	  }
101	  ```
102	
103	- [ ] **Step 4: Commit the type changes**
104	
105	  ```bash
106	  git add api/pipelines/v1alpha1/application_types.go
107	  git commit -m "feat(approval-gates): extend ApprovalGate and GateStatus types"
108	  ```
109	
110	### Task 2: Add `ReleaseAwaitingApproval` phase
111	
112	**Files:**
113	- Modify: `api/pipelines/v1alpha1/release_types.go`
114	
115	- [ ] **Step 1: Add the phase constant**
116	
117	  Insert after `ReleaseSuperseded` (around line 26):
118	
119	  ```go
120	  // ReleaseAwaitingApproval indicates the release is waiting for approval gates.
121	  ReleaseAwaitingApproval ReleasePhase = "AwaitingApproval"
122	  ```
123	
124	- [ ] **Step 2: Update the status enum marker**
125	
126	  In `ReleaseStatus` update the existing enum marker (around line 84) to:
127	
128	  ```go
129	  // +kubebuilder:validation:Enum=Pending;Promoting;Canarying;Verifying;Complete;Failed;RolledBack;Superseded;AwaitingApproval
130	  ```
131	
132	- [ ] **Step 3: Commit**
133	
134	  ```bash
135	  git add api/pipelines/v1alpha1/release_types.go
136	  git commit -m "feat(approval-gates): add ReleaseAwaitingApproval phase"
137	  ```
138	
139	### Task 3: Add per-stage approval gates
140	
141	**Files:**
142	- Modify: `api/pipelines/v1alpha1/stage_types.go`
143	
144	- [ ] **Step 1: Add `ApprovalGates` to `StageSpec`**
145	
146	  Insert after `Gates []GateConfig` (around line 133):
147	
148	  ```go
149	  // ApprovalGates define manual/webhook/Slack approval gates for promotion into this stage.
150	  // +optional
151	  ApprovalGates []ApprovalGate `json:"approvalGates,omitempty"`
152	  ```
153	
154	- [ ] **Step 2: Commit**
155	
156	  ```bash
157	  git add api/pipelines/v1alpha1/stage_types.go
158	  git commit -m "feat(approval-gates): add ApprovalGates to StageSpec"
159	  ```
160	
161	### Task 4: Regenerate deepcopy and CRDs
162	
163	- [ ] **Step 1: Generate DeepCopy methods**
164	
165	  ```bash
166	  make generate
167	  ```
168	
169	  Expected: `api/pipelines/v1alpha1/zz_generated.deepcopy.go` is updated for the new `ApprovalGate` fields and `StageSpec.ApprovalGates`.
170	
171	- [ ] **Step 2: Generate manifests**
172	
173	  ```bash
174	  make manifests
175	  ```
176	
177	  Expected:
178	  - `config/crd/bases/pipelines.paprika.io_applications.yaml` gains new `approvalGates` fields.
179	  - `config/crd/bases/pipelines.paprika.io_stages.yaml` gains `approvalGates`.
180	  - `config/rbac/role.yaml` is regenerated (we add explicit RBAC markers in Chunk 3).
181	
182	- [ ] **Step 3: Commit generated files**
183	
184	  ```bash
185	  git add api/pipelines/v1alpha1/zz_generated.deepcopy.go config/crd/bases config/rbac/role.yaml
186	  git commit -m "feat(approval-gates): regenerate deepcopy, CRDs and RBAC"
187	  ```
188	
189	### Task 5: Propagate `ApprovalGates` when reconciling stages
190	
191	**Files:**
192	- Modify: `internal/controller/pipelines/application_controller.go`
193	
194	- [ ] **Step 1: Copy per-stage approval gates in `buildStageSpec`**
195	
196	  In `buildStageSpec` (around line 721), add inside `StageSpec` after `Gates: promotionStage.Gates,`:
197	
198	  ```go
199	  ApprovalGates: promotionStage.ApprovalGates,
200	  ```
201	
202	- [ ] **Step 2: Commit**
203	
204	  ```bash
205	  git add internal/controller/pipelines/application_controller.go
206	  git commit -m "feat(approval-gates): propagate ApprovalGates to Stage objects"
207	  ```
208	
209	---
210	
211	## Chunk 2: Approval Gate Engine
212	
213	### Task 1: Create the approval gate evaluator
214	
215	**Files:**
216	- Create: `internal/gates/approval.go`
217	
218	- [ ] **Step 1: Write `internal/gates/approval.go`**
219	
220	  ```go
221	  package gates
222	
223	  import (
224	      "bytes"
225	      "context"
226	      "fmt"
227	      "net/http"
228	      "time"
229	  )
230	
231	  // ApprovalGateType values.
232	  const (
233	      ApprovalGateTypeManual  = "manual"
234	      ApprovalGateTypeWebhook = "webhook"
235	      ApprovalGateTypeSlack   = "slack"
236	  )
237	
238	  // ApprovalGateStatus values.
239	  const (
240	      ApprovalGateStatusPending  = "Pending"
241	      ApprovalGateStatusApproved = "Approved"
242	      ApprovalGateStatusRejected = "Rejected"
243	  )
244	
245	  // ApprovalGate describes an approval gate to be evaluated.
246	  type ApprovalGate struct {
247	      Name            string
248	      Stage           string
249	      Type            string
250	      Required        bool
251	      URL             string
252	      Method          string
253	      Headers         map[string]string
254	      Body            string
255	      SuccessStatus   int
256	      SlackWebhookURL string
257	      SlackChannel    string
258	  }
259	
260	  // ApprovalGatePayload is passed to webhook/Slack gates.
261	  type ApprovalGatePayload struct {
262	      Application string
263	      Namespace   string
264	      Release     string
265	      Stage       string
266	      Gate        string
267	  }
268	
269	  // ApprovalGateResult is the outcome of evaluating one gate.
270	  type ApprovalGateResult struct {
271	      Status     string
272	      ApprovedBy string
273	      Message    string
274	      Error      error
275	  }
276	
277	  // ApprovalGateEvaluator evaluates approval gates.
278	  type ApprovalGateEvaluator struct {
279	      HTTPClient *http.Client
280	  }
281	
282	  // NewApprovalGateEvaluator creates an evaluator with the given HTTP client.
283	  func NewApprovalGateEvaluator(client *http.Client) *ApprovalGateEvaluator {
284	      if client == nil {
285	          client = http.DefaultClient
286	      }
287	      return &ApprovalGateEvaluator{HTTPClient: client}
288	  }
289	
290	  // Evaluate returns the result for a single gate given its current status.
291	  func (e *ApprovalGateEvaluator) Evaluate(ctx context.Context, gate ApprovalGate, payload ApprovalGatePayload, currentStatus string) ApprovalGateResult {
292	      if currentStatus == ApprovalGateStatusApproved {
293	          return ApprovalGateResult{Status: ApprovalGateStatusApproved, ApprovedBy: "manual"}
294	      }
295	      if currentStatus == ApprovalGateStatusRejected {
296	          return ApprovalGateResult{Status: ApprovalGateStatusRejected}
297	      }
298	
299	      switch gate.Type {
300	      case ApprovalGateTypeManual:
301	          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: "waiting for manual approval"}
302	      case ApprovalGateTypeWebhook:
303	          return e.evaluateWebhook(ctx, gate, payload)
304	      case ApprovalGateTypeSlack:
305	          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: "Slack interaction is Phase 2"}
306	      default:
307	          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: "unknown gate type: " + gate.Type}
308	      }
309	  }
310	
311	  func (e *ApprovalGateEvaluator) evaluateWebhook(ctx context.Context, gate ApprovalGate, payload ApprovalGatePayload) ApprovalGateResult {
312	      if gate.URL == "" {
313	          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: "webhook gate missing URL"}
314	      }
315	      method := gate.Method
316	      if method == "" {
317	          method = http.MethodPost
318	      }
319	      body := gate.Body
320	      if body == "" {
321	          body = fmt.Sprintf(`{"application":"%s","namespace":"%s","release":"%s","stage":"%s","gate":"%s"}`,
322	              payload.Application, payload.Namespace, payload.Release, payload.Stage, payload.Gate)
323	      }
324	
325	      req, err := http.NewRequestWithContext(ctx, method, gate.URL, bytes.NewBufferString(body))
326	      if err != nil {
327	          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: fmt.Sprintf("invalid webhook request: %v", err), Error: err}
328	      }
329	      req.Header.Set("Content-Type", "application/json")
330	      for k, v := range gate.Headers {
331	          req.Header.Set(k, v)
332	      }
333	
334	      ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
335	      defer cancel()
336	
337	      resp, err := e.HTTPClient.Do(req.WithContext(ctx))
338	      if err != nil {
339	          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: fmt.Sprintf("webhook call failed: %v", err), Error: err}
340	      }
341	      defer func() { _ = resp.Body.Close() }()
342	
343	      if gate.SuccessStatus > 0 {
344	          if resp.StatusCode == gate.SuccessStatus {
345	              return ApprovalGateResult{Status: ApprovalGateStatusApproved, ApprovedBy: "webhook", Message: fmt.Sprintf("HTTP %d", resp.StatusCode)}
346	          }
347	          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: fmt.Sprintf("HTTP %d (expected %d)", resp.StatusCode, gate.SuccessStatus)}
348	      }
349	      if resp.StatusCode >= 200 && resp.StatusCode < 300 {
350	          return ApprovalGateResult{Status: ApprovalGateStatusApproved, ApprovedBy: "webhook", Message: fmt.Sprintf("HTTP %d", resp.StatusCode)}
351	      }
352	      return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: fmt.Sprintf("HTTP %d (expected 2xx)", resp.StatusCode)}
353	  }
354	  ```
355	
356	- [ ] **Step 2: Commit**
357	
358	  ```bash
359	  git add internal/gates/approval.go
360	  git commit -m "feat(approval-gates): add approval gate evaluator"
361	  ```
362	
363	### Task 2: Unit-test the evaluator
364	
365	**Files:**
366	- Create: `internal/gates/approval_test.go`
367	
368	- [ ] **Step 1: Write tests**
369	
370	  ```go
371	  package gates
372	
373	  import (
374	      "context"
375	      "net/http"
376	      "net/http/httptest"
377	      "testing"
378	  )
379	
380	  func TestApprovalGateEvaluator_manual(t *testing.T) {
381	      e := NewApprovalGateEvaluator(nil)
382	      gate := ApprovalGate{Name: "m", Type: ApprovalGateTypeManual}
383	
384	      if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, ""); got.Status != ApprovalGateStatusPending {
385	          t.Errorf("manual gate = %s, want Pending", got.Status)
386	      }
387	      if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, ApprovalGateStatusApproved); got.Status != ApprovalGateStatusApproved {
388	          t.Errorf("approved manual gate = %s, want Approved", got.Status)
389	      }
390	  }
391	
392	  func TestApprovalGateEvaluator_webhook(t *testing.T) {
393	      srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
394	          w.WriteHeader(http.StatusOK)
395	      }))
396	      defer srv.Close()
397	
398	      e := NewApprovalGateEvaluator(srv.Client())
399	      gate := ApprovalGate{Name: "w", Type: ApprovalGateTypeWebhook, URL: srv.URL, Method: http.MethodPost}
400	      if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, ""); got.Status != ApprovalGateStatusApproved {
401	          t.Errorf("webhook gate = %s, want Approved", got.Status)
402	      }
403	
404	      gate.URL = ""
405	      if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, ""); got.Status != ApprovalGateStatusPending {
406	          t.Errorf("webhook missing url = %s, want Pending", got.Status)
407	      }
408	  }
409	
410	  func TestApprovalGateEvaluator_slack(t *testing.T) {
411	      e := NewApprovalGateEvaluator(nil)
412	      gate := ApprovalGate{Name: "s", Type: ApprovalGateTypeSlack}
413	      if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, ""); got.Status != ApprovalGateStatusPending {
414	          t.Errorf("slack gate = %s, want Pending", got.Status)
415	      }
416	  }
417	  ```
418	
419	- [ ] **Step 2: Run the tests**
420	
421	  ```bash
422	  go test ./internal/gates/... -run TestApprovalGateEvaluator -v
423	  ```
424	
425	  Expected: PASS.
426	
427	- [ ] **Step 3: Commit**
428	
429	  ```bash
430	  git add internal/gates/approval_test.go
431	  git commit -m "test(approval-gates): add evaluator unit tests"
432	  ```
433	
434	---
435	
436	## Chunk 3: Release Controller Integration
437	
438	### Task 1: Define the `ApprovalGateEvaluator` interface and wire the dependency
439	
440	**Files:**
441	- Modify: `internal/controller/pipelines/gate_executor.go`
442	- Modify: `internal/controller/pipelines/release_controller.go`
443	- Modify: `cmd/main_controllers.go`
444	
445	- [ ] **Step 1: Add the interface in `gate_executor.go`**
446	
447	  Append to the file:
448	
449	  ```go
450	  // ApprovalGateEvaluator evaluates approval gates before a Release is promoted.
451	  type ApprovalGateEvaluator interface {
452	      Evaluate(ctx context.Context, gate gates.ApprovalGate, payload gates.ApprovalGatePayload, currentStatus string) gates.ApprovalGateResult
453	  }
454	  ```
455	
456	- [ ] **Step 2: Add the field to `ReleaseReconciler`**
457	
458	  In `release_controller.go` inside the `ReleaseReconciler` struct (after `GateExecutor`), add:
459	
460	  ```go
461	  // ApprovalGateEvaluator evaluates approval gates before promotion.
462	  ApprovalGateEvaluator ApprovalGateEvaluator
463	  ```
464	
465	- [ ] **Step 3: Inject the evaluator in `cmd/main_controllers.go`**
466	
467	  In `setupReleaseController` after `releaseRec.GateExecutor = gates.NewSmokeGate(http.DefaultClient)` add:
468	
469	  ```go
470	  releaseRec.ApprovalGateEvaluator = gates.NewApprovalGateEvaluator(http.DefaultClient)
471	  ```
472	
473	- [ ] **Step 4: Commit**
474	
475	  ```bash
476	  git add internal/controller/pipelines/gate_executor.go internal/controller/pipelines/release_controller.go cmd/main_controllers.go
477	  git commit -m "feat(approval-gates): wire ApprovalGateEvaluator into release reconciler"
478	  ```
479	
480	### Task 2: Implement gate checking helpers in the release controller
481	
482	**Files:**
483	- Modify: `internal/controller/pipelines/release_controller.go`
484	
485	- [ ] **Step 1: Add conversion and collection helpers**
486	
487	  Append near the bottom of `release_controller.go`:
488	
489	  ```go
490	  func (r *ReleaseReconciler) effectiveApprovalGates(app *paprikav1.Application, stage *paprikav1.Stage) []gates.ApprovalGate {
491	      target := stage.Spec.Name
492	      var out []gates.ApprovalGate
493	      for _, g := range app.Spec.ApprovalGates {
494	          if !g.Required {
495	              continue
496	          }
497	          if g.Stage != "" && g.Stage != target {
498	              continue
499	          }
500	          out = append(out, convertApprovalGate(g))
501	      }
502	      for _, g := range stage.Spec.ApprovalGates {
503	          if !g.Required {
504	              continue
505	          }
506	          out = append(out, convertApprovalGate(g))
507	      }
508	      return out
509	  }
510	
511	  func convertApprovalGate(g paprikav1.ApprovalGate) gates.ApprovalGate {
512	      return gates.ApprovalGate{
513	          Name:            g.Name,
514	          Stage:           g.Stage,
515	          Type:            g.Type,
516	          Required:        g.Required,
517	          URL:             g.URL,
518	          Method:          g.Method,
519	          Headers:         g.Headers,
520	          Body:            g.Body,
521	          SuccessStatus:   g.SuccessStatus,
522	          SlackWebhookURL: g.SlackWebhookURL,
523	          SlackChannel:    g.SlackChannel,
524	      }
525	  }
526	
527	  func (r *ReleaseReconciler) findGateStatus(app *paprikav1.Application, name string) paprikav1.GateStatus {
528	      for _, s := range app.Status.Gates {
529	          if s.Name == name {
530	              return s
531	          }
532	      }
533	      return paprikav1.GateStatus{}
534	  }
535	
536	  func (r *ReleaseReconciler) syncApplicationGateStatus(ctx context.Context, app *paprikav1.Application, statuses []paprikav1.GateStatus) error {
537	      return retry.RetryOnConflict(retry.DefaultRetry, func() error {
538	          var fresh paprikav1.Application
539	          if err := r.client.Get(ctx, types.NamespacedName{Name: app.Name, Namespace: app.Namespace}, &fresh); err != nil {
540	              return fmt.Errorf("fetch application for gate sync: %w", err)
541	          }
542	          fresh.Status.Gates = statuses
543	          if err := r.client.Status().Update(ctx, &fresh); err != nil {
544	              return fmt.Errorf("update application gate status: %w", err)
545	          }
546	          return nil
547	      })
548	  }
549	  ```
550	
551	- [ ] **Step 2: Add `checkApprovalGates`**
552	
553	  ```go
554	  func (r *ReleaseReconciler) checkApprovalGates(ctx context.Context, release *paprikav1.Release) (approved bool, rejected bool, err error) {
555	      log := logf.FromContext(ctx)
556	      app, err := r.resolveOwningApplication(ctx, release)
557	      if err != nil {
558	          return false, false, fmt.Errorf("resolve owning application: %w", err)
559	      }
560	      stage, err := r.fetchStage(ctx, release)
561	      if err != nil {
562	          return false, false, fmt.Errorf("fetch stage: %w", err)
563	      }
564	
565	      gateList := r.effectiveApprovalGates(app, stage)
566	      if len(gateList) == 0 {
567	          return true, false, nil
568	      }
569	
570	      payload := gates.ApprovalGatePayload{
571	          Application: app.Name,
572	          Namespace:   app.Namespace,
573	          Release:     release.Name,
574	          Stage:       stage.Spec.Name,
575	      }
576	
577	      statuses := make([]paprikav1.GateStatus, 0, len(gateList))
578	      anyPending := false
579	      anyRejected := false
580	
581	      for _, g := range gateList {
582	          current := r.findGateStatus(app, g.Name)
583	          result := r.ApprovalGateEvaluator.Evaluate(ctx, g, payload, current.Status)
584	          status := paprikav1.GateStatus{
585	              Name:   g.Name,
586	              Stage:  g.Stage,
587	              Type:   g.Type,
588	              Status: result.Status,
589	          }
590	          if result.Status == GateStatusApproved {
591	              status.ApprovedBy = result.ApprovedBy
592	          } else {
593	              status.Message = result.Message
594	          }
595	          statuses = append(statuses, status)
596	          if result.Status == GateStatusPending {
597	              anyPending = true
598	          }
599	          if result.Status == GateStatusRejected {
600	              anyRejected = true
601	          }
602	          log.Info("Evaluated approval gate", "gate", g.Name, "type", g.Type, "status", result.Status)
603	      }
604	
605	      if err := r.syncApplicationGateStatus(ctx, app, statuses); err != nil {
606	          return false, false, fmt.Errorf("sync gate status: %w", err)
607	      }
608	
609	      if anyRejected {
610	          return false, true, nil
611	      }
612	      if anyPending {
613	          return false, false, nil
614	      }
615	      return true, false, nil
616	  }
617	  ```
618	
619	  Note: `GateStatusPending`/`Approved`/`Rejected` constants come from `paprikav1` since the same names are defined there; use the `paprikav1` package constants.
620	
621	- [ ] **Step 3: Commit**
622	
623	  ```bash
624	  git add internal/controller/pipelines/release_controller.go
625	  git commit -m "feat(approval-gates): add release controller gate evaluation helpers"
626	  ```
627	
628	### Task 3: Wire gates into the release lifecycle
629	
630	**Files:**
631	- Modify: `internal/controller/pipelines/release_controller.go`
632	
633	- [ ] **Step 1: Add `AwaitingApproval` handler in `reconcileReleasePhase`**
634	
635	  After the `ReleasePending` branch (around line 217) add:
636	
637	  ```go
638	  if release.Status.Phase == paprikav1.ReleaseAwaitingApproval {
639	      return r.handleAwaitingApprovalPhase(ctx, release, result)
640	  }
641	  ```
642	
643	- [ ] **Step 2: Implement `handleAwaitingApprovalPhase`**
644	
645	  Add near `handlePendingPhase`:
646	
647	  ```go
648	  func (r *ReleaseReconciler) handleAwaitingApprovalPhase(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {
649	      approved, rejected, err := r.checkApprovalGates(ctx, release)
650	      if err != nil {
651	          *result = resultError
652	          return ctrl.Result{}, fmt.Errorf("checking approval gates: %w", err)
653	      }
654	      if rejected {
655	          return r.failRelease(ctx, release, result)
656	      }
657	      if approved {
658	          oldPhase := release.Status.Phase
659	          release.Status.Phase = paprikav1.ReleasePromoting
660	          metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Promoting").Inc()
661	          if err := r.patchReleaseStatus(ctx, release, oldPhase); err != nil {
662	              *result = resultError
663	              return ctrl.Result{}, fmt.Errorf("failed to transition from awaiting approval to promoting: %w", err)
664	          }
665	          return ctrl.Result{Requeue: true}, nil
666	      }
667	      return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
668	  }
669	  ```
670	
671	- [ ] **Step 3: Check gates at the start of `handlePromotingPhase`**
672	
673	  Replace the first lines of `handlePromotingPhase` (currently `oldPhase := release.Status.Phase; if err := r.promote(...)`):
674	
675	  ```go
676	  func (r *ReleaseReconciler) handlePromotingPhase(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {
677	      log := logf.FromContext(ctx)
678	      oldPhase := release.Status.Phase
679	
680	      approved, rejected, err := r.checkApprovalGates(ctx, release)
681	      if err != nil {
682	          log.Error(err, "Failed to check approval gates", "release", release.Name)
683	          release.Status.Phase = paprikav1.ReleaseFailed
684	          metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Failed").Inc()
685	          if updateErr := r.patchReleaseStatus(ctx, release, oldPhase); updateErr != nil {
686	              *result = resultError
687	              return ctrl.Result{}, fmt.Errorf("failed to set release failed: %w", updateErr)
688	          }
689	          return ctrl.Result{}, nil
690	      }
691	      if rejected {
692	          return r.failRelease(ctx, release, result)
693	      }
694	      if !approved {
695	          release.Status.Phase = paprikav1.ReleaseAwaitingApproval
696	          metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "AwaitingApproval").Inc()
697	          if err := r.patchReleaseStatus(ctx, release, oldPhase); err != nil {
698	              *result = resultError
699	              return ctrl.Result{}, fmt.Errorf("failed to transition to awaiting approval: %w", err)
700	          }
701	          return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
702	      }
703	
704	      if err := r.promote(ctx, release); err != nil {
705	          ...
706	      }
707	      ...
708	  }
709	  ```
710	
711	- [ ] **Step 4: Treat `AwaitingApproval` as active in concurrency check**
712	
713	  In `hasActiveConcurrentRelease` (around line 646) change the phase check to:
714	
715	  ```go
716	  if other.Status.Phase == paprikav1.ReleasePromoting ||
717	      other.Status.Phase == paprikav1.ReleaseVerifying ||
718	      other.Status.Phase == paprikav1.ReleaseAwaitingApproval {
719	      return true, nil
720	  }
721	  ```
722	
723	- [ ] **Step 5: Commit**
724	
725	  ```bash
726	  git add internal/controller/pipelines/release_controller.go
727	  git commit -m "feat(approval-gates): evaluate gates before promotion and add AwaitingApproval phase"
728	  ```
729	
730	### Task 4: Remove the old blocking gate check from the Application controller
731	
732	**Files:**
733	- Modify: `internal/controller/pipelines/application_controller.go`
734	
735	- [ ] **Step 1: Remove the blocking call from `reconcileReleaseFlow`**
736	
737	  Replace this block in `reconcileReleaseFlow` (around line 339):
738	
739	  ```go
740	  if blocked, msg := r.checkGates(ctx, app); blocked {
741	      log.Info("Gate blocked release", "app", app.Name, "reason", msg)
742	      r.updatePhase(ctx, app, paprikav1.ApplicationPending, "GatePending", msg)
743	      return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
744	  }
745	  ```
746	
747	  with a comment:
748	
749	  ```go
750	  // Approval gates are now evaluated by the Release controller before promotion.
751	  ```
752	
753	- [ ] **Step 2: Delete the now-unused gate helpers**
754	
755	  Remove these functions (around lines 1193–1318): `checkGates`, `isGateRelevant`, `isGateApproved`, `recordPendingGate`, `gateStatusExists`. Keep `getTargetStage` because it is still used for sync windows.
756	
757	- [ ] **Step 3: Map `ReleaseAwaitingApproval` to an Application phase**
758	
759	  In `handleActiveRelease` (around line 813), add to `phaseMap`:
760	
761	  ```go
762	  paprikav1.ReleaseAwaitingApproval: {paprikav1.ApplicationPromoting, "ReleaseAwaitingApproval", true},
763	  ```
764	
765	- [ ] **Step 4: Commit**
766	
767	  ```bash
768	  git add internal/controller/pipelines/application_controller.go
769	  git commit -m "refactor(approval-gates): move gate blocking from Application to Release controller"
770	  ```
771	
772	### Task 5: Add RBAC markers
773	
774	**Files:**
775	- Modify: `internal/controller/pipelines/release_controller.go`
776	
777	- [ ] **Step 1: Add RBAC markers near the top of the file**
778	
779	  After the existing release RBAC markers (around line 140) add:
780	
781	  ```go
782	  // +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications,verbs=get;update;patch
783	  // +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications/status,verbs=get;update;patch
784	  // +kubebuilder:rbac:groups=core,resources=secrets,verbs=get
785	  ```
786	
787	- [ ] **Step 2: Regenerate manifests**
788	
789	  ```bash
790	  make manifests
791	  ```
792	
793	- [ ] **Step 3: Commit**
794	
795	  ```bash
796	  git add internal/controller/pipelines/release_controller.go config/rbac/role.yaml
797	  git commit -m "feat(approval-gates): add RBAC for application gate status updates"
798	  ```
799	
800	---
801	
802	## Chunk 4: API Server and Protocol Buffers
803	
804	### Task 1: Extend the protobuf schema
805	
806	**Files:**
807	- Modify: `proto/paprika/v1/api.proto`
808	
809	- [ ] **Step 1: Extend `GateStatus`**
810	
811	  Replace the existing `GateStatus` message (around line 114) with:
812	
813	  ```protobuf
814	  message GateStatus {
815	    string name = 1;
816	    string stage = 2;
817	    string status = 3;
818	    string approved_by = 4;
819	    string type = 5;
820	    string message = 6;
821	  }
822	  ```
823	
824	- [ ] **Step 2: Add new request/response messages**
825	
826	  Insert after `ApproveGateResponse` (around line 395):
827	
828	  ```protobuf
829	  message ListGateStatusRequest {
830	    string namespace = 1;
831	    string name = 2;
832	  }
833	
834	  message ListGateStatusResponse {
835	    repeated GateStatus gates = 1;
836	  }
837	
838	  message RejectGateRequest {
839	    string name = 1;
840	    string namespace = 2;
841	    string gate = 3;
842	  }
843	
844	  message RejectGateResponse {
845	    Application application = 1;
846	  }
847	  ```
848	
849	- [ ] **Step 3: Add RPCs to `PaprikaService`**
850	
851	  Add to the service block after `ApproveGate`:
852	
853	  ```protobuf
854	  rpc ListGateStatus(ListGateStatusRequest) returns (ListGateStatusResponse);
855	  rpc RejectGate(RejectGateRequest) returns (RejectGateResponse);
856	  ```
857	
858	- [ ] **Step 4: Regenerate protobuf clients**
859	
860	  ```bash
861	  make generate-proto
862	  ```
863	
864	  Expected: `internal/api/paprika/v1/api.pb.go` and `ui/src/gen/paprika/v1/*` are updated with the new fields and RPCs.
865	
866	- [ ] **Step 5: Commit**
867	
868	  ```bash
869	  git add proto/paprika/v1/api.proto internal/api/paprika/v1/api.pb.go ui/src/gen/paprika/v1
870	  git commit -m "feat(approval-gates): add ListGateStatus and RejectGate RPCs"
871	  ```
872	
873	### Task 2: Implement server handlers
874	
875	**Files:**
876	- Modify: `internal/api/server.go`
877	
878	- [ ] **Step 1: Add RBAC marker for application status**
879	
880	  Above `ApproveGate` (around line 461) add:
881	
882	  ```go
883	  // +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications/status,verbs=get;update;patch
884	  ```
885	
886	- [ ] **Step 2: Add `convertGateStatuses` helper**
887	
888	  Insert near other `convert*` helpers:
889	
890	  ```go
891	  func convertGateStatuses(statuses []pipelinesv1alpha1.GateStatus) []*paprikav1.GateStatus {
892	      out := make([]*paprikav1.GateStatus, 0, len(statuses))
893	      for _, s := range statuses {
894	          out = append(out, &paprikav1.GateStatus{
895	              Name:       s.Name,
896	              Stage:      s.Stage,
897	              Type:       s.Type,
898	              Status:     s.Status,
899	              ApprovedBy: s.ApprovedBy,
900	              Message:    s.Message,
901	          })
902	      }
903	      return out
904	  }
905	  ```
906	
907	- [ ] **Step 3: Surface gate statuses in `convertApplication`**
908	
909	  In `convertApplication` (around line 867), add before the closing `}` of the returned struct:
910	
911	  ```go
912	  Gates: convertGateStatuses(a.Status.Gates),
913	  ```
914	
915	- [ ] **Step 4: Implement `ListGateStatus`**
916	
917	  Add after `ApproveGate`:
918	
919	  ```go
920	  func (s *PaprikaServer) ListGateStatus(
921	      ctx context.Context,
922	      req *connect.Request[paprikav1.ListGateStatusRequest],
923	  ) (*connect.Response[paprikav1.ListGateStatusResponse], error) {
924	      var app pipelinesv1alpha1.Application
925	      if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &app); err != nil {
926	          return nil, fmt.Errorf("getting application: %w", err)
927	      }
928	      if err := s.authorizeApplication(ctx, auth.ActionRead, &app); err != nil {
929	          return nil, connect.NewError(connect.CodePermissionDenied, err)
930	      }
931	      return connect.NewResponse(&paprikav1.ListGateStatusResponse{Gates: convertGateStatuses(app.Status.Gates)}), nil
932	  }
933	  ```
934	
935	- [ ] **Step 5: Implement `RejectGate`**
936	
937	  Add after `ListGateStatus`:
938	
939	  ```go
940	  func (s *PaprikaServer) RejectGate(
941	      ctx context.Context,
942	      req *connect.Request[paprikav1.RejectGateRequest],
943	  ) (*connect.Response[paprikav1.RejectGateResponse], error) {
944	      var app pipelinesv1alpha1.Application
945	      if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &app); err != nil {
946	          return nil, fmt.Errorf("getting application: %w", err)
947	      }
948	      if err := s.authorizeApplication(ctx, auth.ActionWrite, &app); err != nil {
949	          return nil, connect.NewError(connect.CodePermissionDenied, err)
950	      }
951	
952	      found := false
953	      for i, g := range app.Status.Gates {
954	          if g.Name == req.Msg.Gate {
955	              app.Status.Gates[i].Status = pipelinesv1alpha1.GateStatusRejected
956	              app.Status.Gates[i].ApprovedBy = ""
957	              found = true
958	              break
959	          }
960	      }
961	      if !found {
962	          return nil, fmt.Errorf("gate %s not found", req.Msg.Gate)
963	      }
964	
965	      if err := s.client.Status().Update(ctx, &app); err != nil {
966	          return nil, fmt.Errorf("updating gate status: %w", err)
967	      }
968	
969	      var refreshed pipelinesv1alpha1.Application
970	      if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &refreshed); err != nil {
971	          return nil, fmt.Errorf("getting refreshed application: %w", err)
972	      }
973	
974	      return connect.NewResponse(&paprikav1.RejectGateResponse{Application: convertApplication(&refreshed)}), nil
975	  }
976	  ```
977	
978	- [ ] **Step 6: Update `ApproveGate` to use typed constants**
979	
980	  In the existing `ApproveGate` handler, change the status assignment to:
981	
982	  ```go
983	  app.Status.Gates[i].Status = pipelinesv1alpha1.GateStatusApproved
984	  ```
985	
986	- [ ] **Step 7: Commit**
987	
988	  ```bash
989	  git add internal/api/server.go
990	  git commit -m "feat(approval-gates): implement ListGateStatus and RejectGate handlers"
991	  ```
992	
993	---
994	
995	## Chunk 5: CLI Commands
996	
997	### Task 1: Extend `paprika gates`
998	
999	**Files:**
1000	- Modify: `cmd/paprika/gates.go`
<system>1000 lines read from file starting from line 1. Total lines in file: 1603. Max 1000 lines reached.</system>

</details>

<details><summary>Thinking</summary>

The plan is long (1603 lines). It seems reasonably detailed. We need review rest. Read remaining.

</details>

#### Tool Call: Read (`.worktrees/approval-gates/docs/superpowers/plans/2026-06-19-…`)
<!-- call_id: tool_xEr53aoOXzLpHqv1LdIoAqOY -->
```json
{
  "path": ".worktrees/approval-gates/docs/superpowers/plans/2026-06-19-approval-gates.md",
  "line_offset": 1001,
  "n_lines": 700
}
```

<details><summary>Tool Result: Read (`.worktrees/approval-gates/docs/superpowers/plans/2026-06-19-…`)</summary>

<!-- call_id: tool_xEr53aoOXzLpHqv1LdIoAqOY -->
1001	
1002	- [ ] **Step 1: Add helper to render gate statuses**
1003	
1004	  Insert at the top of `cmd/paprika/gates.go` after imports:
1005	
1006	  ```go
1007	  import (
1008	      ...existing imports...
1009	      "io"
1010	      "text/tabwriter"
1011	  )
1012	
1013	  func writeGateStatuses(w io.Writer, output string, gates []*paprikav1.GateStatus) error {
1014	      switch output {
1015	      case outputJSON, outputYAML:
1016	          return writeProtoOutput(w, output, &paprikav1.ListGateStatusResponse{Gates: gates})
1017	      case outputTable:
1018	          tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
1019	          if _, err := fmt.Fprintln(tw, "NAME\tSTAGE\tTYPE\tSTATUS\tAPPROVED BY\tMESSAGE"); err != nil {
1020	              return fmt.Errorf("write header: %w", err)
1021	          }
1022	          for _, g := range gates {
1023	              if _, err := fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", g.Name, g.Stage, g.Type, g.Status, g.ApprovedBy, g.Message); err != nil {
1024	                  return fmt.Errorf("write row: %w", err)
1025	              }
1026	          }
1027	          return tw.Flush()
1028	      default:
1029	          return fmt.Errorf("unknown output format %q", output)
1030	      }
1031	  }
1032	  ```
1033	
1034	- [ ] **Step 2: Add `list` subcommand**
1035	
1036	  Add to `newGatesCmd` before returning `cmd`:
1037	
1038	  ```go
1039	  cmd.AddCommand(&cobra.Command{
1040	      Use:   "list APP",
1041	      Short: "List approval gates for an application",
1042	      Args:  cobra.ExactArgs(1),
1043	      RunE: func(cmd *cobra.Command, args []string) error {
1044	          client, err := clientFn()
1045	          if err != nil {
1046	              return fmt.Errorf("create client: %w", err)
1047	          }
1048	          res, err := client.ListGateStatus(ctx, connect.NewRequest(&paprikav1.ListGateStatusRequest{
1049	              Name:      args[0],
1050	              Namespace: nsFn(),
1051	          }))
1052	          if err != nil {
1053	              return fmt.Errorf("list gate status: %w", err)
1054	          }
1055	          return writeGateStatuses(cmd.OutOrStdout(), *output, res.Msg.Gates)
1056	      },
1057	  })
1058	  ```
1059	
1060	- [ ] **Step 3: Add `reject` subcommand**
1061	
1062	  Add after the `approve` command block:
1063	
1064	  ```go
1065	  cmd.AddCommand(&cobra.Command{
1066	      Use:   "reject APP GATE",
1067	      Short: "Reject a gate for an application",
1068	      Args:  cobra.ExactArgs(2),
1069	      RunE: func(cmd *cobra.Command, args []string) error {
1070	          client, err := clientFn()
1071	          if err != nil {
1072	              return fmt.Errorf("create client: %w", err)
1073	          }
1074	          res, err := client.RejectGate(ctx, connect.NewRequest(&paprikav1.RejectGateRequest{
1075	              Name:      args[0],
1076	              Namespace: nsFn(),
1077	              Gate:      args[1],
1078	          }))
1079	          if err != nil {
1080	              return fmt.Errorf("reject gate: %w", err)
1081	          }
1082	          return writeApplication(cmd.OutOrStdout(), *output, res.Msg.Application)
1083	      },
1084	  })
1085	  ```
1086	
1087	- [ ] **Step 4: Build and test the CLI**
1088	
1089	  ```bash
1090	  go build ./cmd/paprika
1091	  ./paprika gates --help
1092	  ```
1093	
1094	  Expected: `list`, `approve`, and `reject` subcommands are shown.
1095	
1096	- [ ] **Step 5: Commit**
1097	
1098	  ```bash
1099	  git add cmd/paprika/gates.go
1100	  git commit -m "feat(approval-gates): add gates list/reject CLI commands"
1101	  ```
1102	
1103	---
1104	
1105	## Chunk 6: UI Updates
1106	
1107	### Task 1: Display `AwaitingApproval` in the status badge
1108	
1109	**Files:**
1110	- Modify: `ui/src/components/ui/status-badge.tsx`
1111	
1112	- [ ] **Step 1: Add the mapping**
1113	
1114	  Insert into `statusConfig`:
1115	
1116	  ```ts
1117	  AwaitingApproval: {
1118	    icon: PauseCircle,
1119	    className: "bg-warning/10 text-warning border-warning/20",
1120	  },
1121	  ```
1122	
1123	- [ ] **Step 2: Commit**
1124	
1125	  ```bash
1126	  git add ui/src/components/ui/status-badge.tsx
1127	  git commit -m "feat(approval-gates): add AwaitingApproval status badge"
1128	  ```
1129	
1130	### Task 2: Show pending gates and approve/reject buttons
1131	
1132	**Files:**
1133	- Modify: `ui/src/app/dashboard/application/page.tsx`
1134	
1135	- [ ] **Step 1: Import `ShieldAlert` and add state**
1136	
1137	  Add to imports (already imported `ShieldAlert`, confirm it is present). Add state inside `ApplicationDetail`:
1138	
1139	  ```ts
1140	  const [actingGate, setActingGate] = useState<string | null>(null);
1141	  ```
1142	
1143	- [ ] **Step 2: Add approve/reject handlers**
1144	
1145	  After `handleRollback`:
1146	
1147	  ```ts
1148	  const handleGateAction = useCallback(
1149	    async (gateName: string, action: "approve" | "reject") => {
1150	      if (!application) return;
1151	      setActingGate(gateName);
1152	      try {
1153	        if (action === "approve") {
1154	          await client.approveGate({ namespace, name, gate: gateName });
1155	        } else {
1156	          await client.rejectGate({ namespace, name, gate: gateName });
1157	        }
1158	        await fetchData();
1159	      } catch (err) {
1160	        setError(`${action === "approve" ? "Approval" : "Rejection"} failed for ${gateName}`);
1161	        console.error(err);
1162	      } finally {
1163	        setActingGate(null);
1164	      }
1165	    },
1166	    [application, namespace, name, fetchData],
1167	  );
1168	  ```
1169	
1170	- [ ] **Step 3: Render the gates card**
1171	
1172	  Insert after the top metrics grid (after the closing `</div>` of the grid around line 273):
1173	
1174	  ```tsx
1175	  {application.gates && application.gates.length > 0 && (
1176	    <Card>
1177	      <CardHeader>
1178	        <CardTitle className="flex items-center gap-2">
1179	          <ShieldAlert className="h-5 w-5" />
1180	          Approval Gates
1181	        </CardTitle>
1182	        <CardDescription>Gates that must pass before promotion continues.</CardDescription>
1183	      </CardHeader>
1184	      <CardContent>
1185	        <Table>
1186	          <TableHeader>
1187	            <TableRow>
1188	              <TableHead>Name</TableHead>
1189	              <TableHead>Stage</TableHead>
1190	              <TableHead>Type</TableHead>
1191	              <TableHead>Status</TableHead>
1192	              <TableHead>Message</TableHead>
1193	              <TableHead className="text-right">Actions</TableHead>
1194	            </TableRow>
1195	          </TableHeader>
1196	          <TableBody>
1197	            {application.gates.map((gate) => (
1198	              <TableRow key={gate.name}>
1199	                <TableCell className="font-medium">{gate.name}</TableCell>
1200	                <TableCell>{gate.stage || "—"}</TableCell>
1201	                <TableCell>{gate.type || "—"}</TableCell>
1202	                <TableCell>
1203	                  <StatusBadge status={gate.status} />
1204	                </TableCell>
1205	                <TableCell className="text-muted-foreground">{gate.message || "—"}</TableCell>
1206	                <TableCell className="text-right">
1207	                  {gate.status === "Pending" && (
1208	                    <div className="flex justify-end gap-2">
1209	                      <Button
1210	                        variant="outline"
1211	                        size="sm"
1212	                        onClick={() => handleGateAction(gate.name, "approve")}
1213	                        disabled={actingGate === gate.name}
1214	                      >
1215	                        Approve
1216	                      </Button>
1217	                      <Button
1218	                        variant="ghost"
1219	                        size="sm"
1220	                        onClick={() => handleGateAction(gate.name, "reject")}
1221	                        disabled={actingGate === gate.name}
1222	                      >
1223	                        Reject
1224	                      </Button>
1225	                    </div>
1226	                  )}
1227	                </TableCell>
1228	              </TableRow>
1229	            ))}
1230	          </TableBody>
1231	        </Table>
1232	      </CardContent>
1233	    </Card>
1234	  )}
1235	  ```
1236	
1237	- [ ] **Step 4: Run the UI type check**
1238	
1239	  ```bash
1240	  cd ui && npm run typecheck
1241	  ```
1242	
1243	  Expected: no new type errors.
1244	
1245	- [ ] **Step 5: Commit**
1246	
1247	  ```bash
1248	  git add ui/src/app/dashboard/application/page.tsx ui/src/components/ui/status-badge.tsx
1249	  git commit -m "feat(approval-gates): show gates and approve/reject in UI"
1250	  ```
1251	
1252	---
1253	
1254	## Chunk 7: Tests and Verification
1255	
1256	### Task 1: Unit-test the release controller gate flow
1257	
1258	**Files:**
1259	- Modify: `internal/controller/pipelines/release_controller_unit_test.go`
1260	
1261	- [ ] **Step 1: Add a fake approval evaluator**
1262	
1263	  Insert after `fakeGateExecutor`:
1264	
1265	  ```go
1266	  type fakeApprovalEvaluator struct {
1267	      results map[string]gates.ApprovalGateResult
1268	  }
1269	
1270	  func (f *fakeApprovalEvaluator) Evaluate(_ context.Context, gate gates.ApprovalGate, _ gates.ApprovalGatePayload, _ string) gates.ApprovalGateResult {
1271	      if r, ok := f.results[gate.Name]; ok {
1272	          return r
1273	      }
1274	      return gates.ApprovalGateResult{Status: gates.ApprovalGateStatusPending}
1275	  }
1276	  ```
1277	
1278	- [ ] **Step 2: Add tests for pending, approved, and rejected gates**
1279	
1280	  Append to the test file:
1281	
1282	  ```go
1283	  func TestReleaseReconciler_handlePromotingPhase_awaitsApproval(t *testing.T) {
1284	      ctx := context.Background()
1285	      scheme := runtime.NewScheme()
1286	      _ = pipelinesv1alpha1.AddToScheme(scheme)
1287	      _ = corev1.AddToScheme(scheme)
1288	
1289	      app := &pipelinesv1alpha1.Application{
1290	          ObjectMeta: metav1.ObjectMeta{Name: "gate-app", Namespace: "default", UID: types.UID("uid")},
1291	          Spec: pipelinesv1alpha1.ApplicationSpec{
1292	              ApprovalGates: []pipelinesv1alpha1.ApprovalGate{
1293	                  {Name: "manual-gate", Type: pipelinesv1alpha1.ApprovalGateTypeManual, Required: true},
1294	              },
1295	          },
1296	      }
1297	      stage := &pipelinesv1alpha1.Stage{
1298	          ObjectMeta: metav1.ObjectMeta{Name: "gate-stage", Namespace: "default"},
1299	          Spec: pipelinesv1alpha1.StageSpec{Name: "dev", Ring: 1, Templates: []string{}},
1300	      }
1301	      release := &pipelinesv1alpha1.Release{
1302	          ObjectMeta: metav1.ObjectMeta{
1303	              Name:      "gate-release",
1304	              Namespace: "default",
1305	              OwnerReferences: []metav1.OwnerReference{{
1306	                  APIVersion: pipelinesv1alpha1.GroupVersion.String(),
1307	                  Kind:       "Application",
1308	                  Name:       app.Name,
1309	                  UID:        app.UID,
1310	              }},
1311	          },
1312	          Spec: pipelinesv1alpha1.ReleaseSpec{Target: stage.Name},
1313	          Status: pipelinesv1alpha1.ReleaseStatus{Phase: pipelinesv1alpha1.ReleasePromoting},
1314	      }
1315	
1316	      c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app, stage, release).WithStatusSubresource(&pipelinesv1alpha1.Release{}, &pipelinesv1alpha1.Application{}).Build()
1317	      r := &ReleaseReconciler{
1318	          client:                c,
1319	          Scheme:                scheme,
1320	          ApprovalGateEvaluator: &fakeApprovalEvaluator{},
1321	      }
1322	
1323	      _, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: release.Name, Namespace: release.Namespace}})
1324	      if err != nil {
1325	          t.Fatalf("reconcile error: %v", err)
1326	      }
1327	
1328	      var updated pipelinesv1alpha1.Release
1329	      if err := c.Get(ctx, client.ObjectKeyFromObject(release), &updated); err != nil {
1330	          t.Fatalf("get release: %v", err)
1331	      }
1332	      if updated.Status.Phase != pipelinesv1alpha1.ReleaseAwaitingApproval {
1333	          t.Errorf("phase = %s, want AwaitingApproval", updated.Status.Phase)
1334	      }
1335	
1336	      var updatedApp pipelinesv1alpha1.Application
1337	      if err := c.Get(ctx, client.ObjectKeyFromObject(app), &updatedApp); err != nil {
1338	          t.Fatalf("get app: %v", err)
1339	      }
1340	      if len(updatedApp.Status.Gates) != 1 || updatedApp.Status.Gates[0].Status != pipelinesv1alpha1.GateStatusPending {
1341	          t.Errorf("gate status = %+v, want one Pending", updatedApp.Status.Gates)
1342	      }
1343	  }
1344	
1345	  func TestReleaseReconciler_handleAwaitingApprovalPhase_promotesWhenApproved(t *testing.T) {
1346	      ctx := context.Background()
1347	      scheme := runtime.NewScheme()
1348	      _ = pipelinesv1alpha1.AddToScheme(scheme)
1349	      _ = corev1.AddToScheme(scheme)
1350	
1351	      app := &pipelinesv1alpha1.Application{
1352	          ObjectMeta: metav1.ObjectMeta{Name: "gate-app", Namespace: "default", UID: types.UID("uid")},
1353	          Spec: pipelinesv1alpha1.ApplicationSpec{
1354	              ApprovalGates: []pipelinesv1alpha1.ApprovalGate{
1355	                  {Name: "manual-gate", Type: pipelinesv1alpha1.ApprovalGateTypeManual, Required: true},
1356	              },
1357	          },
1358	          Status: pipelinesv1alpha1.ApplicationStatus{
1359	              Gates: []pipelinesv1alpha1.GateStatus{
1360	                  {Name: "manual-gate", Status: pipelinesv1alpha1.GateStatusApproved, ApprovedBy: "test"},
1361	              },
1362	          },
1363	      }
1364	      stage := &pipelinesv1alpha1.Stage{
1365	          ObjectMeta: metav1.ObjectMeta{Name: "gate-stage", Namespace: "default"},
1366	          Spec: pipelinesv1alpha1.StageSpec{Name: "dev", Ring: 1, Templates: []string{}},
1367	      }
1368	      release := &pipelinesv1alpha1.Release{
1369	          ObjectMeta: metav1.ObjectMeta{
1370	              Name:      "gate-release",
1371	              Namespace: "default",
1372	              OwnerReferences: []metav1.OwnerReference{{
1373	                  APIVersion: pipelinesv1alpha1.GroupVersion.String(),
1374	                  Kind:       "Application",
1375	                  Name:       app.Name,
1376	                  UID:        app.UID,
1377	              }},
1378	          },
1379	          Spec: pipelinesv1alpha1.ReleaseSpec{Target: stage.Name},
1380	          Status: pipelinesv1alpha1.ReleaseStatus{Phase: pipelinesv1alpha1.ReleaseAwaitingApproval},
1381	      }
1382	
1383	      c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app, stage, release).WithStatusSubresource(&pipelinesv1alpha1.Release{}, &pipelinesv1alpha1.Application{}).Build()
1384	      r := &ReleaseReconciler{
1385	          client:                c,
1386	          Scheme:                scheme,
1387	          ApprovalGateEvaluator: &fakeApprovalEvaluator{},
1388	      }
1389	
1390	      _, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: release.Name, Namespace: release.Namespace}})
1391	      if err != nil {
1392	          t.Fatalf("reconcile error: %v", err)
1393	      }
1394	
1395	      var updated pipelinesv1alpha1.Release
1396	      if err := c.Get(ctx, client.ObjectKeyFromObject(release), &updated); err != nil {
1397	          t.Fatalf("get release: %v", err)
1398	      }
1399	      if updated.Status.Phase != pipelinesv1alpha1.ReleasePromoting {
1400	          t.Errorf("phase = %s, want Promoting", updated.Status.Phase)
1401	      }
1402	  }
1403	  ```
1404	
1405	- [ ] **Step 3: Run the new unit tests**
1406	
1407	  ```bash
1408	  go test ./internal/controller/pipelines/... -run TestReleaseReconciler_handlePromotingPhase_awaitsApproval -v
1409	  go test ./internal/controller/pipelines/... -run TestReleaseReconciler_handleAwaitingApprovalPhase_promotesWhenApproved -v
1410	  ```
1411	
1412	  Expected: PASS.
1413	
1414	- [ ] **Step 4: Commit**
1415	
1416	  ```bash
1417	  git add internal/controller/pipelines/release_controller_unit_test.go
1418	  git commit -m "test(approval-gates): add release controller gate unit tests"
1419	  ```
1420	
1421	### Task 2: Add an E2E test for a manual gate
1422	
1423	**Files:**
1424	- Modify: `internal/controller/pipelines/release_controller_test.go`
1425	
1426	- [ ] **Step 1: Add a new Ginkgo context**
1427	
1428	  Append inside `Describe("Release Controller", func() { ... })`:
1429	
1430	  ```go
1431	  Context("when a manual approval gate is configured", func() {
1432	      const (
1433	          appName     = "manual-gate-app"
1434	          stageName   = "manual-gate-stage"
1435	          releaseName = "manual-gate-release"
1436	      )
1437	
1438	      ctx := context.Background()
1439	      appKey := types.NamespacedName{Name: appName, Namespace: "default"}
1440	      stageKey := types.NamespacedName{Name: stageName, Namespace: "default"}
1441	      releaseKey := types.NamespacedName{Name: releaseName, Namespace: "default"}
1442	
1443	      BeforeEach(func() {
1444	          app := &pipelinesv1alpha1.Application{
1445	              ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: "default"},
1446	              Spec: pipelinesv1alpha1.ApplicationSpec{
1447	                  Source: pipelinesv1alpha1.ApplicationSource{Type: "inline"},
1448	                  ApprovalGates: []pipelinesv1alpha1.ApprovalGate{
1449	                      {Name: "prod-approval", Type: pipelinesv1alpha1.ApprovalGateTypeManual, Required: true},
1450	                  },
1451	                  Stages: []pipelinesv1alpha1.ApplicationPromotionStage{
1452	                      {Name: stageName, Ring: 1},
1453	                  },
1454	              },
1455	          }
1456	          Expect(k8sClient.Create(ctx, app)).To(Succeed())
1457	
1458	          stage := &pipelinesv1alpha1.Stage{
1459	              ObjectMeta: metav1.ObjectMeta{Name: stageName, Namespace: "default"},
1460	              Spec: pipelinesv1alpha1.StageSpec{Name: stageName, Ring: 1, Templates: []string{}},
1461	          }
1462	          Expect(k8sClient.Create(ctx, stage)).To(Succeed())
1463	      })
1464	
1465	      AfterEach(func() {
1466	          By("cleaning up the release")
1467	          release := &pipelinesv1alpha1.Release{ObjectMeta: metav1.ObjectMeta{Name: releaseName, Namespace: "default"}}
1468	          Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, release))).To(Succeed())
1469	          By("cleaning up the stage")
1470	          stage := &pipelinesv1alpha1.Stage{ObjectMeta: metav1.ObjectMeta{Name: stageName, Namespace: "default"}}
1471	          Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, stage))).To(Succeed())
1472	          By("cleaning up the application")
1473	          app := &pipelinesv1alpha1.Application{ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: "default"}}
1474	          Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, app))).To(Succeed())
1475	      })
1476	
1477	      It("should pause promotion until the gate is approved", func() {
1478	          release := &pipelinesv1alpha1.Release{
1479	              ObjectMeta: metav1.ObjectMeta{
1480	                  Name:      releaseName,
1481	                  Namespace: "default",
1482	                  OwnerReferences: []metav1.OwnerReference{{
1483	                      APIVersion: pipelinesv1alpha1.GroupVersion.String(),
1484	                      Kind:       "Application",
1485	                      Name:       appName,
1486	                  }},
1487	              },
1488	              Spec: pipelinesv1alpha1.ReleaseSpec{
1489	                  Target: stageName,
1490	                  ManifestSource: &pipelinesv1alpha1.ManifestSource{
1491	                      ConfigMapRef: "",
1492	                  },
1493	              },
1494	          }
1495	          Expect(k8sClient.Create(ctx, release)).To(Succeed())
1496	
1497	          controller := &ReleaseReconciler{
1498	              client:                k8sClient,
1499	              Scheme:                k8sClient.Scheme(),
1500	              Namespace:             "default",
1501	              ApprovalGateEvaluator: gates.NewApprovalGateEvaluator(http.DefaultClient),
1502	              Clock:                 clock.NewFake(time.Now()),
1503	          }
1504	
1505	          By("reconciling the release while the gate is pending")
1506	          _, err := controller.Reconcile(ctx, reconcile.Request{NamespacedName: releaseKey})
1507	          Expect(err).NotTo(HaveOccurred())
1508	
1509	          var updated pipelinesv1alpha1.Release
1510	          Eventually(func() pipelinesv1alpha1.ReleasePhase {
1511	              Expect(k8sClient.Get(ctx, releaseKey, &updated)).To(Succeed())
1512	              return updated.Status.Phase
1513	          }, 5*time.Second, 200*time.Millisecond).Should(Equal(pipelinesv1alpha1.ReleaseAwaitingApproval))
1514	
1515	          var app pipelinesv1alpha1.Application
1516	          Expect(k8sClient.Get(ctx, appKey, &app)).To(Succeed())
1517	          Expect(app.Status.Gates).To(HaveLen(1))
1518	          Expect(app.Status.Gates[0].Status).To(Equal(pipelinesv1alpha1.GateStatusPending))
1519	
1520	          By("approving the gate")
1521	          app.Status.Gates[0].Status = pipelinesv1alpha1.GateStatusApproved
1522	          app.Status.Gates[0].ApprovedBy = "e2e"
1523	          Expect(k8sClient.Status().Update(ctx, &app)).To(Succeed())
1524	
1525	          By("reconciling the release after approval")
1526	          _, err = controller.Reconcile(ctx, reconcile.Request{NamespacedName: releaseKey})
1527	          Expect(err).NotTo(HaveOccurred())
1528	
1529	          Eventually(func() pipelinesv1alpha1.ReleasePhase {
1530	              Expect(k8sClient.Get(ctx, releaseKey, &updated)).To(Succeed())
1531	              return updated.Status.Phase
1532	          }, 5*time.Second, 200*time.Millisecond).Should(Equal(pipelinesv1alpha1.ReleasePromoting))
1533	      })
1534	  })
1535	  ```
1536	
1537	  Note: adjust the test if `ManifestSource` is not needed; the important behavior is the phase transition.
1538	
1539	- [ ] **Step 2: Run the E2E test**
1540	
1541	  ```bash
1542	  make test-e2e
1543	  ```
1544	
1545	  Expected: the new manual-gate test passes along with the existing suite.
1546	
1547	- [ ] **Step 3: Commit**
1548	
1549	  ```bash
1550	  git add internal/controller/pipelines/release_controller_test.go
1551	  git commit -m "test(approval-gates): add E2E test for manual gate"
1552	  ```
1553	
1554	### Task 3: Final verification
1555	
1556	- [ ] **Step 1: Run the full Go test suite**
1557	
1558	  ```bash
1559	  make test
1560	  ```
1561	
1562	  Expected: all unit and envtest tests pass.
1563	
1564	- [ ] **Step 2: Run lint**
1565	
1566	  ```bash
1567	  make lint
1568	  ```
1569	
1570	  Expected: no lint errors.
1571	
1572	- [ ] **Step 3: Type-check the UI**
1573	
1574	  ```bash
1575	  cd ui && npm run typecheck
1576	  ```
1577	
1578	  Expected: no type errors.
1579	
1580	- [ ] **Step 4: Verify no unrelated changes**
1581	
1582	  ```bash
1583	  git diff --stat
1584	  ```
1585	
1586	  Expected: only the planned files are modified.
1587	
1588	- [ ] **Step 5: Final review checkpoint**
1589	
1590	  Use @superpowers:verification-before-completion before declaring the feature done. Confirm:
1591	  - `make test` passes
1592	  - `make lint` passes
1593	  - `make test-e2e` passes (manual gate test included)
1594	  - UI typecheck passes
1595	
1596	---
1597	
1598	## Notes for Implementers
1599	
1600	- **Slack gates:** The type/schema and Slack webhook URL fields are added, but actual Slack interaction handling is intentionally Phase 2. The evaluator returns `Pending` with the message `"Slack interaction is Phase 2"`.
1601	- **Webhook gate secrets:** `SecretRef` is defined in the CRD but reading the Secret and injecting headers is also left as a follow-up unless trivial; the evaluator currently uses only `URL`, `Method`, `Headers`, `Body`, and `SuccessStatus`.
1602	- **Approval precedence:** If a gate status already exists on the Application as `Approved` or `Rejected`, the evaluator preserves that state. This is what makes manual/UI approval durable across reconciles.
1603	- **No breaking changes:** Existing `ApprovalGate` and `GateStatus` JSON fields are preserved; only new optional fields are added.
<system>603 lines read from file starting from line 1001. Total lines in file: 1603. End of file reached.</system>

</details>

<details><summary>Thinking</summary>

The plan references existing `ApproveGate` RPC and handler, and `cmd/paprika/gates.go`, and Application controller `checkGates`. We need verify these exist in the approval-gates worktree (master at 6cf4b59). The plan assumes they exist. Let's verify quickly:
- Does proto have GateStatus message and ApproveGate RPC? Grep.
- Does internal/api/server.go have ApproveGate? Grep.
- Does cmd/paprika/gates.go exist? Yes likely.
- Does application_controller.go have checkGates? We saw in plan; need verify.

If not, plan needs adjustment. Let's check.

</details>

#### Tool Call: Grep (`.worktrees/approval-gates/proto/paprika/v1/api.proto`)
<!-- call_id: tool_YOQTTLRAy1J6JqvUCIJicob5 -->
```json
{
  "path": ".worktrees/approval-gates/proto/paprika/v1/api.proto",
  "pattern": "GateStatus|ApproveGate|approveGate|ListGateStatus|RejectGate",
  "output_mode": "content",
  "-n": true
}
```

#### Tool Call: Grep (`.worktrees/approval-gates/internal/api/server.go`)
<!-- call_id: tool_48maSNkcJx56YuLvjgVVeC3l -->
```json
{
  "path": ".worktrees/approval-gates/internal/api/server.go",
  "pattern": "ApproveGate|approveGate|GateStatus|checkGates",
  "output_mode": "content",
  "-n": true
}
```

#### Tool Call: Grep (`.worktrees/approval-gates/internal/controller/pipelines/appl…`)
<!-- call_id: tool_vmqNLOhCn7li5HHgQKbZVckm -->
```json
{
  "path": ".worktrees/approval-gates/internal/controller/pipelines/application_controller.go",
  "pattern": "checkGates|GatePending|ApprovalGate|GateStatus",
  "output_mode": "content",
  "-n": true
}
```

<details><summary>Tool Result: Grep (`.worktrees/approval-gates/proto/paprika/v1/api.proto`)</summary>

<!-- call_id: tool_YOQTTLRAy1J6JqvUCIJicob5 -->
.worktrees/approval-gates/proto/paprika/v1/api.proto:114:message GateStatus {
.worktrees/approval-gates/proto/paprika/v1/api.proto:165:  repeated GateStatus gates = 23;
.worktrees/approval-gates/proto/paprika/v1/api.proto:386:message ApproveGateRequest {
.worktrees/approval-gates/proto/paprika/v1/api.proto:392:message ApproveGateResponse {
.worktrees/approval-gates/proto/paprika/v1/api.proto:513:  rpc ApproveGate(ApproveGateRequest) returns (ApproveGateResponse);

</details>

<details><summary>Tool Result: Grep (`.worktrees/approval-gates/internal/api/server.go`)</summary>

<!-- call_id: tool_48maSNkcJx56YuLvjgVVeC3l -->
.worktrees/approval-gates/internal/api/server.go:461:// ApproveGate approves a manual approval gate for an application.
.worktrees/approval-gates/internal/api/server.go:462:func (s *PaprikaServer) ApproveGate(
.worktrees/approval-gates/internal/api/server.go:464:	req *connect.Request[paprikav1.ApproveGateRequest],
.worktrees/approval-gates/internal/api/server.go:465:) (*connect.Response[paprikav1.ApproveGateResponse], error) {
.worktrees/approval-gates/internal/api/server.go:496:	return connect.NewResponse(&paprikav1.ApproveGateResponse{

</details>

<details><summary>Tool Result: Grep (`.worktrees/approval-gates/internal/controller/pipelines/appl…`)</summary>

<!-- call_id: tool_vmqNLOhCn7li5HHgQKbZVckm -->
.worktrees/approval-gates/internal/controller/pipelines/application_controller.go:339:	if blocked, msg := r.checkGates(ctx, app); blocked {
.worktrees/approval-gates/internal/controller/pipelines/application_controller.go:341:		r.updatePhase(ctx, app, paprikav1.ApplicationPending, "GatePending", msg)
.worktrees/approval-gates/internal/controller/pipelines/application_controller.go:1193:func (r *ApplicationReconciler) checkGates(ctx context.Context, app *paprikav1.Application) (blocked bool, reason string) {
.worktrees/approval-gates/internal/controller/pipelines/application_controller.go:1194:	if len(app.Spec.ApprovalGates) == 0 {
.worktrees/approval-gates/internal/controller/pipelines/application_controller.go:1200:	for _, gate := range app.Spec.ApprovalGates {
.worktrees/approval-gates/internal/controller/pipelines/application_controller.go:1280:func (r *ApplicationReconciler) isGateRelevant(gate paprikav1.ApprovalGate, targetStage string) bool {
.worktrees/approval-gates/internal/controller/pipelines/application_controller.go:1296:func (r *ApplicationReconciler) recordPendingGate(ctx context.Context, app *paprikav1.Application, gate paprikav1.ApprovalGate) error {
.worktrees/approval-gates/internal/controller/pipelines/application_controller.go:1300:	app.Status.Gates = append(app.Status.Gates, paprikav1.GateStatus{

</details>

<details><summary>Thinking</summary>

The plan references existing code correctly. Good. We should review the plan for any issues. The plan has a lot of details. Some potential issues:
- It says add constants `ApprovalGateTypeManual` etc in `api/pipelines/v1alpha1/application_types.go`, but also defines same constants in `internal/gates/approval.go`. That's duplicate but okay; one for CRD, one for engine. Better use CRD constants in engine. But it's fine.
- It says remove blocking call from Application controller. That is a refactor. Good.
- It mentions `cmd/main_controllers.go` for wiring. Need verify file exists. It likely does. Let's check.

</details>

#### Tool Call: Bash (`ls .worktrees/approval-gates/cmd/main_controllers.go .worktr…`)
<!-- call_id: tool_D1xcjxa6Dc831eYipYfo2IOU -->
```json
{
  "command": "ls .worktrees/approval-gates/cmd/main_controllers.go .worktrees/approval-gates/internal/controller/pipelines/gate_executor.go .worktrees/approval-gates/cmd/paprika/gates.go",
  "timeout": 30
}
```

<details><summary>Tool Result: Bash (`ls .worktrees/approval-gates/cmd/main_controllers.go .worktr…`)</summary>

<!-- call_id: tool_D1xcjxa6Dc831eYipYfo2IOU -->
.worktrees/approval-gates/cmd/main_controllers.go
.worktrees/approval-gates/cmd/paprika/gates.go
.worktrees/approval-gates/internal/controller/pipelines/gate_executor.go


</details>

<details><summary>Thinking</summary>

All referenced files exist. The plan seems feasible. We can commit the plan file and then start implementation using subagent-driven-development. But the plan file is in the worktree; we should commit it. Then update todo: plan done, implementation in progress. Then start executing chunks. Since the plan is large, we should use subagent-driven-development: dispatch implementer subagents per chunk. We can start with Chunk 1 (API Schema). But before that, we should maybe run a plan-document reviewer? The writing-plans skill suggests review loop. We can skip if plan looks good. But maybe do a quick self-review or use a subagent reviewer. Given time, maybe proceed.

We need commit the plan file.

</details>

#### Tool Call: Bash (`cd .worktrees/approval-gates && git add docs/superpowers/pla…`)
<!-- call_id: tool_NY26S1fb40ThQaIsAhH4agNn -->
```json
{
  "command": "cd .worktrees/approval-gates && git add docs/superpowers/plans/2026-06-19-approval-gates.md && git commit -m \"docs(plan): add Approval Gates implementation plan\"",
  "timeout": 60
}
```

<details><summary>Tool Result: Bash (`cd .worktrees/approval-gates && git add docs/superpowers/pla…`)</summary>

<!-- call_id: tool_NY26S1fb40ThQaIsAhH4agNn -->
[feature/approval-gates 3b788bb] docs(plan): add Approval Gates implementation plan
 1 file changed, 1603 insertions(+)
 create mode 100644 docs/superpowers/plans/2026-06-19-approval-gates.md


</details>

<details><summary>Thinking</summary>

Now update todos and start implementation. Implementation is big; we can dispatch Chunk 1 implementer. We need extract Chunk 1 text. We have it in context. We can dispatch with the chunk text. The skill says provide full task text + context. We'll provide Chunk 1 summary. Since the plan file is in worktree, we can tell subagent to read it. But the skill says don't make subagent read plan file; provide full text. However for a large chunk, providing full text is okay. We'll include the chunk text.

But before starting, we should update TODO list.

</details>

#### Tool Call: TodoList
<!-- call_id: tool_EWu5SfKtBpHh85KtFnwtTVcN -->
```json
{
  "todos": [
    {
      "title": "Review backlog and select next epic",
      "status": "done"
    },
    {
      "title": "Set up isolated worktree for chosen feature",
      "status": "done"
    },
    {
      "title": "Chunk 1: Policy CRD and evaluator package",
      "status": "done"
    },
    {
      "title": "Chunk 2: CRD changes for inline source and policy results",
      "status": "done"
    },
    {
      "title": "Chunk 3: Protobuf and ApplyBundle API server handler",
      "status": "done"
    },
    {
      "title": "Chunk 4a: Release controller inline manifest path",
      "status": "done"
    },
    {
      "title": "Chunk 4b: Application controller inline source handling",
      "status": "done"
    },
    {
      "title": "Chunk 4c: True rollback",
      "status": "done"
    },
    {
      "title": "Chunk 5: CLI apply command and TUI",
      "status": "done"
    },
    {
      "title": "Chunk 6: UI, RBAC manifests, and final integration",
      "status": "done"
    },
    {
      "title": "Chunk 7: Validation webhooks",
      "status": "done"
    },
    {
      "title": "Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)",
      "status": "done"
    },
    {
      "title": "Set up worktree for Approval Gates",
      "status": "done"
    },
    {
      "title": "Write Approval Gates implementation plan",
      "status": "done"
    },
    {
      "title": "Chunk 1: Approval Gates API schema",
      "status": "in_progress"
    },
    {
      "title": "Chunk 2: Approval gate evaluator package",
      "status": "pending"
    },
    {
      "title": "Chunk 3: Release controller integration",
      "status": "pending"
    },
    {
      "title": "Chunk 4: API server protobuf and handlers",
      "status": "pending"
    },
    {
      "title": "Chunk 5: CLI commands",
      "status": "pending"
    },
    {
      "title": "Chunk 6: UI updates",
      "status": "pending"
    },
    {
      "title": "Chunk 7: Tests and verification",
      "status": "pending"
    }
  ]
}
```

<details><summary>Tool Result: TodoList</summary>

<!-- call_id: tool_EWu5SfKtBpHh85KtFnwtTVcN -->
Todo list updated.
Current todo list:
  [done] Review backlog and select next epic
  [done] Set up isolated worktree for chosen feature
  [done] Chunk 1: Policy CRD and evaluator package
  [done] Chunk 2: CRD changes for inline source and policy results
  [done] Chunk 3: Protobuf and ApplyBundle API server handler
  [done] Chunk 4a: Release controller inline manifest path
  [done] Chunk 4b: Application controller inline source handling
  [done] Chunk 4c: True rollback
  [done] Chunk 5: CLI apply command and TUI
  [done] Chunk 6: UI, RBAC manifests, and final integration
  [done] Chunk 7: Validation webhooks
  [done] Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)
  [done] Set up worktree for Approval Gates
  [done] Write Approval Gates implementation plan
  [in_progress] Chunk 1: Approval Gates API schema
  [pending] Chunk 2: Approval gate evaluator package
  [pending] Chunk 3: Release controller integration
  [pending] Chunk 4: API server protobuf and handlers
  [pending] Chunk 5: CLI commands
  [pending] Chunk 6: UI updates
  [pending] Chunk 7: Tests and verification

Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.

</details>

<details><summary>Thinking</summary>

Now dispatch implementer for Chunk 1. Provide the chunk text from plan. Need include path to worktree. The subagent should follow the plan exactly and commit each task. We'll include the full Chunk 1 text (Tasks 1-5). Since it's ~200 lines, manageable. We can also say read the plan file at docs/superpowers/plans/2026-06-19-approval-gates.md for full details, but the skill says not to make subagent read plan. We'll provide full chunk text.

</details>

#### Tool Call: Agent (`Implement Approval Gates Chunk 1`)
<!-- call_id: tool_E74IgqyrbANYjSJbMHk6P4XS -->
```json
{
  "description": "Implement Approval Gates Chunk 1",
  "subagent_type": "coder",
  "prompt": "You are implementing **Chunk 1: API Schema** of the Approval Gates feature in the Paprika repo worktree at `/Users/benebsworth/projects/paprika/.worktrees/approval-gates`.\n\nFollow the plan below exactly. Make the changes, run `make generate` and `make manifests`, ensure `make test` and `make lint` still pass, and commit each task separately with the provided commit messages.\n\n---\n\n## Chunk 1: API Schema\n\n### Task 1: Extend `ApprovalGate` and `GateStatus` in `Application`\n\n**Files:**\n- Modify: `api/pipelines/v1alpha1/application_types.go`\n\n- [ ] **Step 1: Add approval gate constants**\n\n  Insert after the existing `ApprovalGate`/`GateStatus` structs (around line 344):\n\n  ```go\n  // ApprovalGateType values.\n  const (\n      ApprovalGateTypeManual  = \"manual\"\n      ApprovalGateTypeWebhook = \"webhook\"\n      ApprovalGateTypeSlack   = \"slack\"\n  )\n\n  // GateStatus values.\n  const (\n      GateStatusPending  = \"Pending\"\n      GateStatusApproved = \"Approved\"\n      GateStatusRejected = \"Rejected\"\n  )\n  ```\n\n- [ ] **Step 2: Replace the `ApprovalGate` struct**\n\n  ```go\n  // ApprovalGate defines a manual or automated approval gate for stage transitions.\n  type ApprovalGate struct {\n      // Name of the gate\n      Name string `json:\"name\"`\n      // Stage at which this gate applies (e.g., \"prod\"). Empty applies to all stages.\n      // +optional\n      Stage string `json:\"stage,omitempty\"`\n      // Type of gate: manual, webhook, slack\n      // +kubebuilder:validation:Enum=manual;webhook;slack\n      Type string `json:\"type\"`\n      // Whether the gate is required (default true)\n      // +kubebuilder:default=true\n      // +optional\n      Required bool `json:\"required,omitempty\"`\n\n      // URL is the webhook URL for webhook gates.\n      // +optional\n      URL string `json:\"url,omitempty\"`\n      // HTTP method for webhook gates. Defaults to POST.\n      // +kubebuilder:default=POST\n      // +optional\n      Method string `json:\"method,omitempty\"`\n      // Headers to send with webhook requests.\n      // +optional\n      Headers map[string]string `json:\"headers,omitempty\"`\n      // Body template sent to webhook gates.\n      // +optional\n      Body string `json:\"body,omitempty\"`\n      // SuccessStatus is the expected HTTP status code for approval (default any 2xx).\n      // +kubebuilder:default=200\n      // +optional\n      SuccessStatus int `json:\"successStatus,omitempty\"`\n      // SecretRef names a Secret in the same namespace whose data is added to webhook headers.\n      // +optional\n      SecretRef string `json:\"secretRef,omitempty\"`\n\n      // SlackWebhookURL is the incoming Slack webhook URL used to notify a channel.\n      // Phase 2: actual Slack interaction handling.\n      // +optional\n      SlackWebhookURL string `json:\"slackWebhookUrl,omitempty\"`\n      // SlackChannel is the channel to notify for Slack gates.\n      // +optional\n      SlackChannel string `json:\"slackChannel,omitempty\"`\n  }\n  ```\n\n- [ ] **Step 3: Replace the `GateStatus` struct**\n\n  ```go\n  // GateStatus represents the current status of an approval gate.\n  type GateStatus struct {\n      Name       string `json:\"name\"`\n      Stage      string `json:\"stage\"`\n      Type       string `json:\"type,omitempty\"`\n      Status     string `json:\"status\"` // Pending, Approved, Rejected\n      ApprovedBy string `json:\"approvedBy,omitempty\"`\n      Message    string `json:\"message,omitempty\"`\n  }\n  ```\n\n- [ ] **Step 4: Commit the type changes**\n\n  ```bash\n  git add api/pipelines/v1alpha1/application_types.go\n  git commit -m \"feat(approval-gates): extend ApprovalGate and GateStatus types\"\n  ```\n\n### Task 2: Add `ReleaseAwaitingApproval` phase\n\n**Files:**\n- Modify: `api/pipelines/v1alpha1/release_types.go`\n\n- [ ] **Step 1: Add the phase constant**\n\n  Insert after `ReleaseSuperseded` (around line 26):\n\n  ```go\n  // ReleaseAwaitingApproval indicates the release is waiting for approval gates.\n  ReleaseAwaitingApproval ReleasePhase = \"AwaitingApproval\"\n  ```\n\n- [ ] **Step 2: Update the status enum marker**\n\n  In `ReleaseStatus` update the existing enum marker (around line 84) to:\n\n  ```go\n  // +kubebuilder:validation:Enum=Pending;Promoting;Canarying;Verifying;Complete;Failed;RolledBack;Superseded;AwaitingApproval\n  ```\n\n- [ ] **Step 3: Commit**\n\n  ```bash\n  git add api/pipelines/v1alpha1/release_types.go\n  git commit -m \"feat(approval-gates): add ReleaseAwaitingApproval phase\"\n  ```\n\n### Task 3: Add per-stage approval gates\n\n**Files:**\n- Modify: `api/pipelines/v1alpha1/stage_types.go`\n\n- [ ] **Step 1: Add `ApprovalGates` to `StageSpec`**\n\n  Insert after `Gates []GateConfig` (around line 133):\n\n  ```go\n  // ApprovalGates define manual/webhook/Slack approval gates for promotion into this stage.\n  // +optional\n  ApprovalGates []ApprovalGate `json:\"approvalGates,omitempty\"`\n  ```\n\n- [ ] **Step 2: Commit**\n\n  ```bash\n  git add api/pipelines/v1alpha1/stage_types.go\n  git commit -m \"feat(approval-gates): add ApprovalGates to StageSpec\"\n  ```\n\n### Task 4: Regenerate deepcopy and CRDs\n\n- [ ] **Step 1: Generate DeepCopy methods**\n\n  ```bash\n  make generate\n  ```\n\n  Expected: `api/pipelines/v1alpha1/zz_generated.deepcopy.go` is updated for the new `ApprovalGate` fields and `StageSpec.ApprovalGates`.\n\n- [ ] **Step 2: Generate manifests**\n\n  ```bash\n  make manifests\n  ```\n\n  Expected:\n  - `config/crd/bases/pipelines.paprika.io_applications.yaml` gains new `approvalGates` fields.\n  - `config/crd/bases/pipelines.paprika.io_stages.yaml` gains `approvalGates`.\n  - `config/rbac/role.yaml` is regenerated (we add explicit RBAC markers in Chunk 3).\n\n- [ ] **Step 3: Commit generated files**\n\n  ```bash\n  git add api/pipelines/v1alpha1/zz_generated.deepcopy.go config/crd/bases config/rbac/role.yaml\n  git commit -m \"feat(approval-gates): regenerate deepcopy, CRDs and RBAC\"\n  ```\n\n### Task 5: Propagate `ApprovalGates` when reconciling stages\n\n**Files:**\n- Modify: `internal/controller/pipelines/application_controller.go`\n\n- [ ] **Step 1: Copy per-stage approval gates in `buildStageSpec`**\n\n  In `buildStageSpec` (around line 721), add inside `StageSpec` after `Gates: promotionStage.Gates,`:\n\n  ```go\n  ApprovalGates: promotionStage.ApprovalGates,\n  ```\n\n- [ ] **Step 2: Commit**\n\n  ```bash\n  git add internal/controller/pipelines/application_controller.go\n  git commit -m \"feat(approval-gates): propagate ApprovalGates to Stage objects\"\n  ```\n\n---\n\n**Verification:** After all commits, run `make test` and `make lint` and report the results. If anything fails, fix it before reporting done."
}
```

<details><summary>Tool Result: Agent (`Implement Approval Gates Chunk 1`)</summary>

<!-- call_id: tool_E74IgqyrbANYjSJbMHk6P4XS -->
<system>ERROR: Tool execution failed.</system>
agent_id: agent-83
actual_subagent_type: coder
status: failed

subagent error: Agent timed out after 30 minutes.
resume_hint: Continue with Agent(resume="agent-83", prompt="continue"). Use agent_id only; do not set subagent_type. The subagent retains its prior context; redo any unfinished tool call if its result was lost.

</details>

<details><summary>Thinking</summary>

The subagent timed out. We can resume with continue. It may have partially completed. Let's resume.

</details>

#### Tool Call: Agent (`agent-83`)
<!-- call_id: tool_6o0p0jGhSbOBI4CdImdFQnu6 -->
```json
{
  "resume": "agent-83",
  "description": "Resume Approval Gates Chunk 1",
  "prompt": "continue"
}
```

<details><summary>Tool Result: Agent (`agent-83`)</summary>

<!-- call_id: tool_6o0p0jGhSbOBI4CdImdFQnu6 -->
agent_id: agent-83
actual_subagent_type: coder
status: completed

[summary]
Done. I implemented Chunk 1 in `/Users/benebsworth/projects/paprika/.worktrees/approval-gates` and verified the build.

What was committed:
1. `feat(approval-gates): extend ApprovalGate and GateStatus types`
2. `feat(approval-gates): add ReleaseAwaitingApproval phase`
3. `feat(approval-gates): add ApprovalGates to StageSpec`
4. `feat(approval-gates): regenerate deepcopy, CRDs and RBAC`
5. `feat(approval-gates): propagate ApprovalGates to Stage objects`
6. `feat(approval-gates): add ApprovalGates to ApplicationPromotionStage` *(needed because `buildStageSpec` copies from `promotionStage.ApprovalGates`)*
7. `fix(approval-gates): use pointers for ApprovalGate to satisfy lint` *(fixed `gocritic` `rangeValCopy`/`hugeParam` issues introduced by the larger struct)*

Verification:
- `make generate` ✅
- `make manifests` ✅
- `make test` ✅ (all unit tests pass)
- `make lint` ✅ (`0 issues`)

Working tree is clean and all changes are committed.

</details>

<details><summary>Thinking</summary>

Chunk 1 done. It added ApprovalGates to ApplicationPromotionStage too. Good. Now move to Chunk 2: approval gate evaluator. Dispatch subagent.

</details>

#### Tool Call: TodoList
<!-- call_id: tool_UeSWZ4xkJ7oZYFUVhrVHFiSK -->
```json
{
  "todos": [
    {
      "title": "Review backlog and select next epic",
      "status": "done"
    },
    {
      "title": "Set up isolated worktree for chosen feature",
      "status": "done"
    },
    {
      "title": "Chunk 1: Policy CRD and evaluator package",
      "status": "done"
    },
    {
      "title": "Chunk 2: CRD changes for inline source and policy results",
      "status": "done"
    },
    {
      "title": "Chunk 3: Protobuf and ApplyBundle API server handler",
      "status": "done"
    },
    {
      "title": "Chunk 4a: Release controller inline manifest path",
      "status": "done"
    },
    {
      "title": "Chunk 4b: Application controller inline source handling",
      "status": "done"
    },
    {
      "title": "Chunk 4c: True rollback",
      "status": "done"
    },
    {
      "title": "Chunk 5: CLI apply command and TUI",
      "status": "done"
    },
    {
      "title": "Chunk 6: UI, RBAC manifests, and final integration",
      "status": "done"
    },
    {
      "title": "Chunk 7: Validation webhooks",
      "status": "done"
    },
    {
      "title": "Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)",
      "status": "done"
    },
    {
      "title": "Set up worktree for Approval Gates",
      "status": "done"
    },
    {
      "title": "Write Approval Gates implementation plan",
      "status": "done"
    },
    {
      "title": "Chunk 1: Approval Gates API schema",
      "status": "done"
    },
    {
      "title": "Chunk 2: Approval gate evaluator package",
      "status": "in_progress"
    },
    {
      "title": "Chunk 3: Release controller integration",
      "status": "pending"
    },
    {
      "title": "Chunk 4: API server protobuf and handlers",
      "status": "pending"
    },
    {
      "title": "Chunk 5: CLI commands",
      "status": "pending"
    },
    {
      "title": "Chunk 6: UI updates",
      "status": "pending"
    },
    {
      "title": "Chunk 7: Tests and verification",
      "status": "pending"
    }
  ]
}
```

<details><summary>Tool Result: TodoList</summary>

<!-- call_id: tool_UeSWZ4xkJ7oZYFUVhrVHFiSK -->
Todo list updated.
Current todo list:
  [done] Review backlog and select next epic
  [done] Set up isolated worktree for chosen feature
  [done] Chunk 1: Policy CRD and evaluator package
  [done] Chunk 2: CRD changes for inline source and policy results
  [done] Chunk 3: Protobuf and ApplyBundle API server handler
  [done] Chunk 4a: Release controller inline manifest path
  [done] Chunk 4b: Application controller inline source handling
  [done] Chunk 4c: True rollback
  [done] Chunk 5: CLI apply command and TUI
  [done] Chunk 6: UI, RBAC manifests, and final integration
  [done] Chunk 7: Validation webhooks
  [done] Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)
  [done] Set up worktree for Approval Gates
  [done] Write Approval Gates implementation plan
  [done] Chunk 1: Approval Gates API schema
  [in_progress] Chunk 2: Approval gate evaluator package
  [pending] Chunk 3: Release controller integration
  [pending] Chunk 4: API server protobuf and handlers
  [pending] Chunk 5: CLI commands
  [pending] Chunk 6: UI updates
  [pending] Chunk 7: Tests and verification

Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.

</details>

<details><summary>Thinking</summary>

Dispatch Chunk 2 implementer. Provide chunk text.

</details>

#### Tool Call: Agent (`Implement Approval Gates Chunk 2`)
<!-- call_id: tool_pXQ4ookwc0wW4Q4N4OBgJi4F -->
```json
{
  "description": "Implement Approval Gates Chunk 2",
  "subagent_type": "coder",
  "prompt": "You are implementing **Chunk 2: Approval Gate Engine** of the Approval Gates feature in the Paprika repo worktree at `/Users/benebsworth/projects/paprika/.worktrees/approval-gates`.\n\nFollow the plan below exactly. Create the files, run the tests, ensure `make test` and `make lint` pass, and commit each task.\n\n---\n\n## Chunk 2: Approval Gate Engine\n\n### Task 1: Create the approval gate evaluator\n\n**Files:**\n- Create: `internal/gates/approval.go`\n\n- [ ] **Step 1: Write `internal/gates/approval.go`**\n\n  ```go\n  package gates\n\n  import (\n      \"bytes\"\n      \"context\"\n      \"fmt\"\n      \"net/http\"\n      \"time\"\n  )\n\n  // ApprovalGateType values.\n  const (\n      ApprovalGateTypeManual  = \"manual\"\n      ApprovalGateTypeWebhook = \"webhook\"\n      ApprovalGateTypeSlack   = \"slack\"\n  )\n\n  // ApprovalGateStatus values.\n  const (\n      ApprovalGateStatusPending  = \"Pending\"\n      ApprovalGateStatusApproved = \"Approved\"\n      ApprovalGateStatusRejected = \"Rejected\"\n  )\n\n  // ApprovalGate describes an approval gate to be evaluated.\n  type ApprovalGate struct {\n      Name            string\n      Stage           string\n      Type            string\n      Required        bool\n      URL             string\n      Method          string\n      Headers         map[string]string\n      Body            string\n      SuccessStatus   int\n      SlackWebhookURL string\n      SlackChannel    string\n  }\n\n  // ApprovalGatePayload is passed to webhook/Slack gates.\n  type ApprovalGatePayload struct {\n      Application string\n      Namespace   string\n      Release     string\n      Stage       string\n      Gate        string\n  }\n\n  // ApprovalGateResult is the outcome of evaluating one gate.\n  type ApprovalGateResult struct {\n      Status     string\n      ApprovedBy string\n      Message    string\n      Error      error\n  }\n\n  // ApprovalGateEvaluator evaluates approval gates.\n  type ApprovalGateEvaluator struct {\n      HTTPClient *http.Client\n  }\n\n  // NewApprovalGateEvaluator creates an evaluator with the given HTTP client.\n  func NewApprovalGateEvaluator(client *http.Client) *ApprovalGateEvaluator {\n      if client == nil {\n          client = http.DefaultClient\n      }\n      return &ApprovalGateEvaluator{HTTPClient: client}\n  }\n\n  // Evaluate returns the result for a single gate given its current status.\n  func (e *ApprovalGateEvaluator) Evaluate(ctx context.Context, gate ApprovalGate, payload ApprovalGatePayload, currentStatus string) ApprovalGateResult {\n      if currentStatus == ApprovalGateStatusApproved {\n          return ApprovalGateResult{Status: ApprovalGateStatusApproved, ApprovedBy: \"manual\"}\n      }\n      if currentStatus == ApprovalGateStatusRejected {\n          return ApprovalGateResult{Status: ApprovalGateStatusRejected}\n      }\n\n      switch gate.Type {\n      case ApprovalGateTypeManual:\n          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: \"waiting for manual approval\"}\n      case ApprovalGateTypeWebhook:\n          return e.evaluateWebhook(ctx, gate, payload)\n      case ApprovalGateTypeSlack:\n          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: \"Slack interaction is Phase 2\"}\n      default:\n          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: \"unknown gate type: \" + gate.Type}\n      }\n  }\n\n  func (e *ApprovalGateEvaluator) evaluateWebhook(ctx context.Context, gate ApprovalGate, payload ApprovalGatePayload) ApprovalGateResult {\n      if gate.URL == \"\" {\n          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: \"webhook gate missing URL\"}\n      }\n      method := gate.Method\n      if method == \"\" {\n          method = http.MethodPost\n      }\n      body := gate.Body\n      if body == \"\" {\n          body = fmt.Sprintf(`{\"application\":\"%s\",\"namespace\":\"%s\",\"release\":\"%s\",\"stage\":\"%s\",\"gate\":\"%s\"}`,\n              payload.Application, payload.Namespace, payload.Release, payload.Stage, payload.Gate)\n      }\n\n      req, err := http.NewRequestWithContext(ctx, method, gate.URL, bytes.NewBufferString(body))\n      if err != nil {\n          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: fmt.Sprintf(\"invalid webhook request: %v\", err), Error: err}\n      }\n      req.Header.Set(\"Content-Type\", \"application/json\")\n      for k, v := range gate.Headers {\n          req.Header.Set(k, v)\n      }\n\n      ctx, cancel := context.WithTimeout(ctx, 30*time.Second)\n      defer cancel()\n\n      resp, err := e.HTTPClient.Do(req.WithContext(ctx))\n      if err != nil {\n          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: fmt.Sprintf(\"webhook call failed: %v\", err), Error: err}\n      }\n      defer func() { _ = resp.Body.Close() }()\n\n      if gate.SuccessStatus > 0 {\n          if resp.StatusCode == gate.SuccessStatus {\n              return ApprovalGateResult{Status: ApprovalGateStatusApproved, ApprovedBy: \"webhook\", Message: fmt.Sprintf(\"HTTP %d\", resp.StatusCode)}\n          }\n          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: fmt.Sprintf(\"HTTP %d (expected %d)\", resp.StatusCode, gate.SuccessStatus)}\n      }\n      if resp.StatusCode >= 200 && resp.StatusCode < 300 {\n          return ApprovalGateResult{Status: ApprovalGateStatusApproved, ApprovedBy: \"webhook\", Message: fmt.Sprintf(\"HTTP %d\", resp.StatusCode)}\n      }\n      return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: fmt.Sprintf(\"HTTP %d (expected 2xx)\", resp.StatusCode)}\n  }\n  ```\n\n- [ ] **Step 2: Commit**\n\n  ```bash\n  git add internal/gates/approval.go\n  git commit -m \"feat(approval-gates): add approval gate evaluator\"\n  ```\n\n### Task 2: Unit-test the evaluator\n\n**Files:**\n- Create: `internal/gates/approval_test.go`\n\n- [ ] **Step 1: Write tests**\n\n  ```go\n  package gates\n\n  import (\n      \"context\"\n      \"net/http\"\n      \"net/http/httptest\"\n      \"testing\"\n  )\n\n  func TestApprovalGateEvaluator_manual(t *testing.T) {\n      e := NewApprovalGateEvaluator(nil)\n      gate := ApprovalGate{Name: \"m\", Type: ApprovalGateTypeManual}\n\n      if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, \"\"); got.Status != ApprovalGateStatusPending {\n          t.Errorf(\"manual gate = %s, want Pending\", got.Status)\n      }\n      if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, ApprovalGateStatusApproved); got.Status != ApprovalGateStatusApproved {\n          t.Errorf(\"approved manual gate = %s, want Approved\", got.Status)\n      }\n  }\n\n  func TestApprovalGateEvaluator_webhook(t *testing.T) {\n      srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n          w.WriteHeader(http.StatusOK)\n      }))\n      defer srv.Close()\n\n      e := NewApprovalGateEvaluator(srv.Client())\n      gate := ApprovalGate{Name: \"w\", Type: ApprovalGateTypeWebhook, URL: srv.URL, Method: http.MethodPost}\n      if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, \"\"); got.Status != ApprovalGateStatusApproved {\n          t.Errorf(\"webhook gate = %s, want Approved\", got.Status)\n      }\n\n      gate.URL = \"\"\n      if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, \"\"); got.Status != ApprovalGateStatusPending {\n          t.Errorf(\"webhook missing url = %s, want Pending\", got.Status)\n      }\n  }\n\n  func TestApprovalGateEvaluator_slack(t *testing.T) {\n      e := NewApprovalGateEvaluator(nil)\n      gate := ApprovalGate{Name: \"s\", Type: ApprovalGateTypeSlack}\n      if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, \"\"); got.Status != ApprovalGateStatusPending {\n          t.Errorf(\"slack gate = %s, want Pending\", got.Status)\n      }\n  }\n  ```\n\n- [ ] **Step 2: Run the tests**\n\n  ```bash\n  go test ./internal/gates/... -run TestApprovalGateEvaluator -v\n  ```\n\n  Expected: PASS.\n\n- [ ] **Step 3: Commit**\n\n  ```bash\n  git add internal/gates/approval_test.go\n  git commit -m \"test(approval-gates): add evaluator unit tests\"\n  ```\n\n---\n\n**Verification:** After all commits, run `make test` and `make lint` and report the results. Fix any failures before reporting done."
}
```

<details><summary>Tool Result: Agent (`Implement Approval Gates Chunk 2`)</summary>

<!-- call_id: tool_pXQ4ookwc0wW4Q4N4OBgJi4F -->
agent_id: agent-84
actual_subagent_type: coder
status: completed

[summary]
Chunk 2: Approval Gate Engine is complete.

**Created files:**
- `internal/gates/approval.go`
- `internal/gates/approval_test.go`

**Commits made:**
- `1ffa0cd` feat(approval-gates): add approval gate evaluator
- `3d3e8b6` test(approval-gates): add evaluator unit tests
- `b09abf3` refactor(approval-gates): pointer params and helpers for lint compliance

**Lint-driven refactor note:** The initial implementation failed `make lint` due to `cyclop`, `errcheck`, and `gocritic`/`wrapcheck` rules. I refactored `approval.go` to:
- Pass `*ApprovalGate` and `*ApprovalGatePayload` by pointer (aligning with the existing `1d9911f` pointer refactor in the branch).
- Extract `buildWebhookRequest` and `webhookResultFromResponse` helpers to keep `evaluateWebhook` under the cyclomatic limit.
- Wrap `http.NewRequestWithContext` errors and add the same `//nolint:errcheck` body-close pattern used in `gates.go`.

**Verification:**
- `go test ./internal/gates/... -run TestApprovalGateEvaluator -v` → PASS
- `make test` → PASS
- `make lint` → 0 issues

</details>

<details><summary>Thinking</summary>

Chunk 2 done. Move to Chunk 3: Release controller integration. This is the most complex. Dispatch implementer with chunk text.

</details>

#### Tool Call: TodoList
<!-- call_id: tool_drKFm75apPURmpGKJJ6vcWs4 -->
```json
{
  "todos": [
    {
      "title": "Review backlog and select next epic",
      "status": "done"
    },
    {
      "title": "Set up isolated worktree for chosen feature",
      "status": "done"
    },
    {
      "title": "Chunk 1: Policy CRD and evaluator package",
      "status": "done"
    },
    {
      "title": "Chunk 2: CRD changes for inline source and policy results",
      "status": "done"
    },
    {
      "title": "Chunk 3: Protobuf and ApplyBundle API server handler",
      "status": "done"
    },
    {
      "title": "Chunk 4a: Release controller inline manifest path",
      "status": "done"
    },
    {
      "title": "Chunk 4b: Application controller inline source handling",
      "status": "done"
    },
    {
      "title": "Chunk 4c: True rollback",
      "status": "done"
    },
    {
      "title": "Chunk 5: CLI apply command and TUI",
      "status": "done"
    },
    {
      "title": "Chunk 6: UI, RBAC manifests, and final integration",
      "status": "done"
    },
    {
      "title": "Chunk 7: Validation webhooks",
      "status": "done"
    },
    {
      "title": "Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)",
      "status": "done"
    },
    {
      "title": "Set up worktree for Approval Gates",
      "status": "done"
    },
    {
      "title": "Write Approval Gates implementation plan",
      "status": "done"
    },
    {
      "title": "Chunk 1: Approval Gates API schema",
      "status": "done"
    },
    {
      "title": "Chunk 2: Approval gate evaluator package",
      "status": "done"
    },
    {
      "title": "Chunk 3: Release controller integration",
      "status": "in_progress"
    },
    {
      "title": "Chunk 4: API server protobuf and handlers",
      "status": "pending"
    },
    {
      "title": "Chunk 5: CLI commands",
      "status": "pending"
    },
    {
      "title": "Chunk 6: UI updates",
      "status": "pending"
    },
    {
      "title": "Chunk 7: Tests and verification",
      "status": "pending"
    }
  ]
}
```

<details><summary>Tool Result: TodoList</summary>

<!-- call_id: tool_drKFm75apPURmpGKJJ6vcWs4 -->
Todo list updated.
Current todo list:
  [done] Review backlog and select next epic
  [done] Set up isolated worktree for chosen feature
  [done] Chunk 1: Policy CRD and evaluator package
  [done] Chunk 2: CRD changes for inline source and policy results
  [done] Chunk 3: Protobuf and ApplyBundle API server handler
  [done] Chunk 4a: Release controller inline manifest path
  [done] Chunk 4b: Application controller inline source handling
  [done] Chunk 4c: True rollback
  [done] Chunk 5: CLI apply command and TUI
  [done] Chunk 6: UI, RBAC manifests, and final integration
  [done] Chunk 7: Validation webhooks
  [done] Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)
  [done] Set up worktree for Approval Gates
  [done] Write Approval Gates implementation plan
  [done] Chunk 1: Approval Gates API schema
  [done] Chunk 2: Approval gate evaluator package
  [in_progress] Chunk 3: Release controller integration
  [pending] Chunk 4: API server protobuf and handlers
  [pending] Chunk 5: CLI commands
  [pending] Chunk 6: UI updates
  [pending] Chunk 7: Tests and verification

Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.

</details>

<details><summary>Thinking</summary>

Now Chunk 3. This is large and may time out. We can split into smaller subagents: Task 1 wiring, Task 2 helpers, Task 3 lifecycle, Task 4 Application controller refactor, Task 5 RBAC. But the plan groups them. We can dispatch one implementer for the whole chunk, but 30 min may be tight. We can dispatch sequentially smaller tasks. Let's start with Task 1-2 (interface, dependency, helpers). Then Task 3-5 (lifecycle, application controller refactor, RBAC). However they depend on helpers. Let's do Task 1 and 2 first.

But the subagent can handle. Given time, let's split. First implementer for Task 1 and 2: add interface in gate_executor.go, wire dependency, add helpers in release_controller.go. Then second implementer for Task 3-5.

Let's dispatch Task 1-2.

</details>

#### Tool Call: Agent (`Approval Gates Chunk 3 Tasks 1-2`)
<!-- call_id: tool_TLMHKk7wlJoeLhEDt4A5HIk5 -->
```json
{
  "description": "Approval Gates Chunk 3 Tasks 1-2",
  "subagent_type": "coder",
  "prompt": "You are implementing the first half of **Chunk 3: Release Controller Integration** of the Approval Gates feature in the Paprika repo worktree at `/Users/benebsworth/projects/paprika/.worktrees/approval-gates`.\n\nImplement only **Task 1** and **Task 2** below, then run `make test` and `make lint`, and commit.\n\n---\n\n### Task 1: Define the `ApprovalGateEvaluator` interface and wire the dependency\n\n**Files:**\n- Modify: `internal/controller/pipelines/gate_executor.go`\n- Modify: `internal/controller/pipelines/release_controller.go`\n- Modify: `cmd/main_controllers.go`\n\n- [ ] **Step 1: Add the interface in `gate_executor.go`**\n\n  Append to the file:\n\n  ```go\n  // ApprovalGateEvaluator evaluates approval gates before a Release is promoted.\n  type ApprovalGateEvaluator interface {\n      Evaluate(ctx context.Context, gate *gates.ApprovalGate, payload *gates.ApprovalGatePayload, currentStatus string) *gates.ApprovalGateResult\n  }\n  ```\n\n- [ ] **Step 2: Add the field to `ReleaseReconciler`**\n\n  In `release_controller.go` inside the `ReleaseReconciler` struct (after `GateExecutor`), add:\n\n  ```go\n  // ApprovalGateEvaluator evaluates approval gates before promotion.\n  ApprovalGateEvaluator ApprovalGateEvaluator\n  ```\n\n- [ ] **Step 3: Inject the evaluator in `cmd/main_controllers.go`**\n\n  In `setupReleaseController` after `releaseRec.GateExecutor = gates.NewSmokeGate(http.DefaultClient)` add:\n\n  ```go\n  releaseRec.ApprovalGateEvaluator = gates.NewApprovalGateEvaluator(http.DefaultClient)\n  ```\n\n- [ ] **Step 4: Commit**\n\n  ```bash\n  git add internal/controller/pipelines/gate_executor.go internal/controller/pipelines/release_controller.go cmd/main_controllers.go\n  git commit -m \"feat(approval-gates): wire ApprovalGateEvaluator into release reconciler\"\n  ```\n\n### Task 2: Implement gate checking helpers in the release controller\n\n**Files:**\n- Modify: `internal/controller/pipelines/release_controller.go`\n\n- [ ] **Step 1: Add conversion and collection helpers**\n\n  Append near the bottom of `release_controller.go`:\n\n  ```go\n  func (r *ReleaseReconciler) effectiveApprovalGates(app *paprikav1.Application, stage *paprikav1.Stage) []*gates.ApprovalGate {\n      target := stage.Spec.Name\n      var out []*gates.ApprovalGate\n      for i := range app.Spec.ApprovalGates {\n          g := &app.Spec.ApprovalGates[i]\n          if !g.Required {\n              continue\n          }\n          if g.Stage != \"\" && g.Stage != target {\n              continue\n          }\n          out = append(out, convertApprovalGate(g))\n      }\n      for i := range stage.Spec.ApprovalGates {\n          g := &stage.Spec.ApprovalGates[i]\n          if !g.Required {\n              continue\n          }\n          out = append(out, convertApprovalGate(g))\n      }\n      return out\n  }\n\n  func convertApprovalGate(g *paprikav1.ApprovalGate) *gates.ApprovalGate {\n      return &gates.ApprovalGate{\n          Name:            g.Name,\n          Stage:           g.Stage,\n          Type:            g.Type,\n          Required:        g.Required,\n          URL:             g.URL,\n          Method:          g.Method,\n          Headers:         g.Headers,\n          Body:            g.Body,\n          SuccessStatus:   g.SuccessStatus,\n          SlackWebhookURL: g.SlackWebhookURL,\n          SlackChannel:    g.SlackChannel,\n      }\n  }\n\n  func (r *ReleaseReconciler) findGateStatus(app *paprikav1.Application, name string) *paprikav1.GateStatus {\n      for i := range app.Status.Gates {\n          if app.Status.Gates[i].Name == name {\n              return &app.Status.Gates[i]\n          }\n      }\n      return nil\n  }\n\n  func (r *ReleaseReconciler) syncApplicationGateStatus(ctx context.Context, app *paprikav1.Application, statuses []paprikav1.GateStatus) error {\n      return retry.RetryOnConflict(retry.DefaultRetry, func() error {\n          var fresh paprikav1.Application\n          if err := r.client.Get(ctx, types.NamespacedName{Name: app.Name, Namespace: app.Namespace}, &fresh); err != nil {\n              return fmt.Errorf(\"fetch application for gate sync: %w\", err)\n          }\n          fresh.Status.Gates = statuses\n          if err := r.client.Status().Update(ctx, &fresh); err != nil {\n              return fmt.Errorf(\"update application gate status: %w\", err)\n          }\n          return nil\n      })\n  }\n  ```\n\n- [ ] **Step 2: Add `checkApprovalGates`**\n\n  ```go\n  func (r *ReleaseReconciler) checkApprovalGates(ctx context.Context, release *paprikav1.Release) (approved bool, rejected bool, err error) {\n      log := logf.FromContext(ctx)\n      app, err := r.resolveOwningApplication(ctx, release)\n      if err != nil {\n          return false, false, fmt.Errorf(\"resolve owning application: %w\", err)\n      }\n      stage, err := r.fetchStage(ctx, release)\n      if err != nil {\n          return false, false, fmt.Errorf(\"fetch stage: %w\", err)\n      }\n\n      gateList := r.effectiveApprovalGates(app, stage)\n      if len(gateList) == 0 {\n          return true, false, nil\n      }\n\n      payload := &gates.ApprovalGatePayload{\n          Application: app.Name,\n          Namespace:   app.Namespace,\n          Release:     release.Name,\n          Stage:       stage.Spec.Name,\n      }\n\n      statuses := make([]paprikav1.GateStatus, 0, len(gateList))\n      anyPending := false\n      anyRejected := false\n\n      for _, g := range gateList {\n          current := r.findGateStatus(app, g.Name)\n          currentStatus := \"\"\n          if current != nil {\n              currentStatus = current.Status\n          }\n          result := r.ApprovalGateEvaluator.Evaluate(ctx, g, payload, currentStatus)\n          status := paprikav1.GateStatus{\n              Name:   g.Name,\n              Stage:  g.Stage,\n              Type:   g.Type,\n              Status: result.Status,\n          }\n          if result.Status == paprikav1.GateStatusApproved {\n              status.ApprovedBy = result.ApprovedBy\n          } else {\n              status.Message = result.Message\n          }\n          statuses = append(statuses, status)\n          if result.Status == paprikav1.GateStatusPending {\n              anyPending = true\n          }\n          if result.Status == paprikav1.GateStatusRejected {\n              anyRejected = true\n          }\n          log.Info(\"Evaluated approval gate\", \"gate\", g.Name, \"type\", g.Type, \"status\", result.Status)\n      }\n\n      if err := r.syncApplicationGateStatus(ctx, app, statuses); err != nil {\n          return false, false, fmt.Errorf(\"sync gate status: %w\", err)\n      }\n\n      if anyRejected {\n          return false, true, nil\n      }\n      if anyPending {\n          return false, false, nil\n      }\n      return true, false, nil\n  }\n  ```\n\n- [ ] **Step 3: Commit**\n\n  ```bash\n  git add internal/controller/pipelines/release_controller.go\n  git commit -m \"feat(approval-gates): add release controller gate evaluation helpers\"\n  ```\n\n---\n\n**Important notes:**\n- The evaluator was refactored in Chunk 2 to use pointer parameters (`*gates.ApprovalGate`, `*gates.ApprovalGatePayload`) and return `*gates.ApprovalGateResult`. Use pointer types in the interface and helpers.\n- Use `paprikav1.GateStatusPending`, `paprikav1.GateStatusApproved`, `paprikav1.GateStatusRejected` for status constants (defined in Chunk 1).\n- If `resolveOwningApplication` or `fetchStage` helpers do not exist, use the existing equivalents in the release controller (e.g., find the Application via owner references or labels).\n- Run `make test` and `make lint` after both tasks and fix any failures. Report the results."
}
```

<details><summary>Tool Result: Agent (`Approval Gates Chunk 3 Tasks 1-2`)</summary>

<!-- call_id: tool_TLMHKk7wlJoeLhEDt4A5HIk5 -->
agent_id: agent-85
actual_subagent_type: coder
status: completed

[summary]
Done. I implemented Tasks 1 and 2 of Chunk 3 in `/Users/benebsworth/projects/paprika/.worktrees/approval-gates`.

**Commits made:**
- `4cedeca` — feat(approval-gates): wire ApprovalGateEvaluator into release reconciler
- `4135014` — refactor(approval-gates): return pointer from ApprovalGateEvaluator.Evaluate
- `6f54c02` — feat(approval-gates): add release controller gate evaluation helpers

**What changed:**
- Added `ApprovalGateEvaluator` interface in `internal/controller/pipelines/gate_executor.go`.
- Added `ApprovalGateEvaluator` field to `ReleaseReconciler` and injected `gates.NewApprovalGateEvaluator(http.DefaultClient)` in `cmd/main_controllers.go`.
- Added helpers in `internal/controller/pipelines/release_controller.go`: `effectiveApprovalGates`, `convertApprovalGate`, `findGateStatus`, `syncApplicationGateStatus`, `checkApprovalGates`.
- Updated `internal/gates/approval.go` so `Evaluate` and its helpers return `*ApprovalGateResult` to match the pointer-return interface required by the task.

**Lint fixes applied:**
- Added `//nolint:unused` to the new helpers (they are not yet wired into the promotion flow; will be used in the second half of Chunk 3).
- Wrapped the `retry.RetryOnConflict` error to satisfy `wrapcheck`.
- Combined named return types `(approved bool, rejected bool)` → `(approved, rejected bool)` to satisfy `gocritic`.

**Verification:**
- `make test` — all tests pass.
- `make lint` — 0 issues.

Working tree is clean.

</details>

<details><summary>Thinking</summary>

Now Task 3-5 of Chunk 3. Dispatch implementer with plan text.

</details>

#### Tool Call: Agent (`Approval Gates Chunk 3 Tasks 3-5`)
<!-- call_id: tool_WWWXwq5HDCHZ7TOMN7ckt9uq -->
```json
{
  "description": "Approval Gates Chunk 3 Tasks 3-5",
  "subagent_type": "coder",
  "prompt": "You are implementing the second half of **Chunk 3: Release Controller Integration** of the Approval Gates feature in the Paprika repo worktree at `/Users/benebsworth/projects/paprika/.worktrees/approval-gates`.\n\nThe helpers `checkApprovalGates`, `effectiveApprovalGates`, `convertApprovalGate`, `findGateStatus`, and `syncApplicationGateStatus` are already in place from the previous task. Implement **Task 3**, **Task 4**, and **Task 5** below, run `make test` and `make lint`, and commit.\n\n---\n\n### Task 3: Wire gates into the release lifecycle\n\n**Files:**\n- Modify: `internal/controller/pipelines/release_controller.go`\n\n- [ ] **Step 1: Add `AwaitingApproval` handler in `reconcileReleasePhase`**\n\n  After the `ReleasePending` branch (around line 217) add:\n\n  ```go\n  if release.Status.Phase == paprikav1.ReleaseAwaitingApproval {\n      return r.handleAwaitingApprovalPhase(ctx, release, result)\n  }\n  ```\n\n- [ ] **Step 2: Implement `handleAwaitingApprovalPhase`**\n\n  Add near `handlePendingPhase`:\n\n  ```go\n  func (r *ReleaseReconciler) handleAwaitingApprovalPhase(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {\n      approved, rejected, err := r.checkApprovalGates(ctx, release)\n      if err != nil {\n          *result = resultError\n          return ctrl.Result{}, fmt.Errorf(\"checking approval gates: %w\", err)\n      }\n      if rejected {\n          return r.failRelease(ctx, release, result)\n      }\n      if approved {\n          oldPhase := release.Status.Phase\n          release.Status.Phase = paprikav1.ReleasePromoting\n          metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, \"Promoting\").Inc()\n          if err := r.patchReleaseStatus(ctx, release, oldPhase); err != nil {\n              *result = resultError\n              return ctrl.Result{}, fmt.Errorf(\"failed to transition from awaiting approval to promoting: %w\", err)\n          }\n          return ctrl.Result{Requeue: true}, nil\n      }\n      return ctrl.Result{RequeueAfter: 10 * time.Second}, nil\n  }\n  ```\n\n  If `failRelease` does not exist, set the release phase to `ReleaseFailed` and patch status, then return.\n\n- [ ] **Step 3: Check gates at the start of `handlePromotingPhase`**\n\n  Replace the first lines of `handlePromotingPhase` (currently `oldPhase := release.Status.Phase; if err := r.promote(...)`):\n\n  ```go\n  func (r *ReleaseReconciler) handlePromotingPhase(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {\n      log := logf.FromContext(ctx)\n      oldPhase := release.Status.Phase\n\n      approved, rejected, err := r.checkApprovalGates(ctx, release)\n      if err != nil {\n          log.Error(err, \"Failed to check approval gates\", \"release\", release.Name)\n          release.Status.Phase = paprikav1.ReleaseFailed\n          metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, \"Failed\").Inc()\n          if updateErr := r.patchReleaseStatus(ctx, release, oldPhase); updateErr != nil {\n              *result = resultError\n              return ctrl.Result{}, fmt.Errorf(\"failed to set release failed: %w\", updateErr)\n          }\n          return ctrl.Result{}, nil\n      }\n      if rejected {\n          return r.failRelease(ctx, release, result)\n      }\n      if !approved {\n          release.Status.Phase = paprikav1.ReleaseAwaitingApproval\n          metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, \"AwaitingApproval\").Inc()\n          if err := r.patchReleaseStatus(ctx, release, oldPhase); err != nil {\n              *result = resultError\n              return ctrl.Result{}, fmt.Errorf(\"failed to transition to awaiting approval: %w\", err)\n          }\n          return ctrl.Result{RequeueAfter: 10 * time.Second}, nil\n      }\n\n      if err := r.promote(ctx, release); err != nil {\n          ...\n      }\n      ...\n  }\n  ```\n\n- [ ] **Step 4: Treat `AwaitingApproval` as active in concurrency check**\n\n  In `hasActiveConcurrentRelease` (around line 646) change the phase check to:\n\n  ```go\n  if other.Status.Phase == paprikav1.ReleasePromoting ||\n      other.Status.Phase == paprikav1.ReleaseVerifying ||\n      other.Status.Phase == paprikav1.ReleaseAwaitingApproval {\n      return true, nil\n  }\n  ```\n\n- [ ] **Step 5: Commit**\n\n  ```bash\n  git add internal/controller/pipelines/release_controller.go\n  git commit -m \"feat(approval-gates): evaluate gates before promotion and add AwaitingApproval phase\"\n  ```\n\n### Task 4: Remove the old blocking gate check from the Application controller\n\n**Files:**\n- Modify: `internal/controller/pipelines/application_controller.go`\n\n- [ ] **Step 1: Remove the blocking call from `reconcileReleaseFlow`**\n\n  Replace this block in `reconcileReleaseFlow` (around line 339):\n\n  ```go\n  if blocked, msg := r.checkGates(ctx, app); blocked {\n      log.Info(\"Gate blocked release\", \"app\", app.Name, \"reason\", msg)\n      r.updatePhase(ctx, app, paprikav1.ApplicationPending, \"GatePending\", msg)\n      return ctrl.Result{RequeueAfter: 30 * time.Second}, nil\n  }\n  ```\n\n  with a comment:\n\n  ```go\n  // Approval gates are now evaluated by the Release controller before promotion.\n  ```\n\n- [ ] **Step 2: Delete the now-unused gate helpers**\n\n  Remove these functions (around lines 1193–1318): `checkGates`, `isGateRelevant`, `isGateApproved`, `recordPendingGate`, `gateStatusExists`. Keep `getTargetStage` because it is still used for sync windows.\n\n- [ ] **Step 3: Map `ReleaseAwaitingApproval` to an Application phase**\n\n  In `handleActiveRelease` (around line 813), add to `phaseMap`:\n\n  ```go\n  paprikav1.ReleaseAwaitingApproval: {paprikav1.ApplicationPromoting, \"ReleaseAwaitingApproval\", true},\n  ```\n\n- [ ] **Step 4: Commit**\n\n  ```bash\n  git add internal/controller/pipelines/application_controller.go\n  git commit -m \"refactor(approval-gates): move gate blocking from Application to Release controller\"\n  ```\n\n### Task 5: Add RBAC markers\n\n**Files:**\n- Modify: `internal/controller/pipelines/release_controller.go`\n\n- [ ] **Step 1: Add RBAC markers near the top of the file**\n\n  After the existing release RBAC markers (around line 140) add:\n\n  ```go\n  // +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications,verbs=get;update;patch\n  // +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications/status,verbs=get;update;patch\n  // +kubebuilder:rbac:groups=core,resources=secrets,verbs=get\n  ```\n\n- [ ] **Step 2: Regenerate manifests**\n\n  ```bash\n  make manifests\n  ```\n\n- [ ] **Step 3: Commit**\n\n  ```bash\n  git add internal/controller/pipelines/release_controller.go config/rbac/role.yaml\n  git commit -m \"feat(approval-gates): add RBAC for application gate status updates\"\n  ```\n\n---\n\n**Verification:** After all commits, run `make test` and `make lint` and report the results. Fix any failures before reporting done."
}
```

<details><summary>Tool Result: Agent (`Approval Gates Chunk 3 Tasks 3-5`)</summary>

<!-- call_id: tool_WWWXwq5HDCHZ7TOMN7ckt9uq -->
agent_id: agent-86
actual_subagent_type: coder
status: completed

[summary]
Implemented Tasks 3–5 in `/Users/benebsworth/projects/paprika/.worktrees/approval-gates`.

**Commits made:**
1. `d83db4f` — feat(approval-gates): evaluate gates before promotion and add AwaitingApproval phase
2. `7fbe62b` — refactor(approval-gates): move gate blocking from Application to Release controller
3. `aa19839` — feat(approval-gates): add RBAC for application gate status updates

**Verification:**
- `make test` ✅ all packages passed
- `make lint` ✅ 0 issues

</details>

<details><summary>Thinking</summary>

Chunk 3 done. Move to Chunk 4: API server protobuf and handlers. Dispatch implementer.

</details>

#### Tool Call: TodoList
<!-- call_id: tool_gBShFXrSwaEa9aLLQtbJKupd -->
```json
{
  "todos": [
    {
      "title": "Review backlog and select next epic",
      "status": "done"
    },
    {
      "title": "Set up isolated worktree for chosen feature",
      "status": "done"
    },
    {
      "title": "Chunk 1: Policy CRD and evaluator package",
      "status": "done"
    },
    {
      "title": "Chunk 2: CRD changes for inline source and policy results",
      "status": "done"
    },
    {
      "title": "Chunk 3: Protobuf and ApplyBundle API server handler",
      "status": "done"
    },
    {
      "title": "Chunk 4a: Release controller inline manifest path",
      "status": "done"
    },
    {
      "title": "Chunk 4b: Application controller inline source handling",
      "status": "done"
    },
    {
      "title": "Chunk 4c: True rollback",
      "status": "done"
    },
    {
      "title": "Chunk 5: CLI apply command and TUI",
      "status": "done"
    },
    {
      "title": "Chunk 6: UI, RBAC manifests, and final integration",
      "status": "done"
    },
    {
      "title": "Chunk 7: Validation webhooks",
      "status": "done"
    },
    {
      "title": "Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)",
      "status": "done"
    },
    {
      "title": "Set up worktree for Approval Gates",
      "status": "done"
    },
    {
      "title": "Write Approval Gates implementation plan",
      "status": "done"
    },
    {
      "title": "Chunk 1: Approval Gates API schema",
      "status": "done"
    },
    {
      "title": "Chunk 2: Approval gate evaluator package",
      "status": "done"
    },
    {
      "title": "Chunk 3: Release controller integration",
      "status": "done"
    },
    {
      "title": "Chunk 4: API server protobuf and handlers",
      "status": "in_progress"
    },
    {
      "title": "Chunk 5: CLI commands",
      "status": "pending"
    },
    {
      "title": "Chunk 6: UI updates",
      "status": "pending"
    },
    {
      "title": "Chunk 7: Tests and verification",
      "status": "pending"
    }
  ]
}
```

<details><summary>Tool Result: TodoList</summary>

<!-- call_id: tool_gBShFXrSwaEa9aLLQtbJKupd -->
Todo list updated.
Current todo list:
  [done] Review backlog and select next epic
  [done] Set up isolated worktree for chosen feature
  [done] Chunk 1: Policy CRD and evaluator package
  [done] Chunk 2: CRD changes for inline source and policy results
  [done] Chunk 3: Protobuf and ApplyBundle API server handler
  [done] Chunk 4a: Release controller inline manifest path
  [done] Chunk 4b: Application controller inline source handling
  [done] Chunk 4c: True rollback
  [done] Chunk 5: CLI apply command and TUI
  [done] Chunk 6: UI, RBAC manifests, and final integration
  [done] Chunk 7: Validation webhooks
  [done] Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)
  [done] Set up worktree for Approval Gates
  [done] Write Approval Gates implementation plan
  [done] Chunk 1: Approval Gates API schema
  [done] Chunk 2: Approval gate evaluator package
  [done] Chunk 3: Release controller integration
  [in_progress] Chunk 4: API server protobuf and handlers
  [pending] Chunk 5: CLI commands
  [pending] Chunk 6: UI updates
  [pending] Chunk 7: Tests and verification

Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.

</details>

<details><summary>Thinking</summary>

Dispatch Chunk 4 implementer.

</details>

#### Tool Call: Agent (`Implement Approval Gates Chunk 4`)
<!-- call_id: tool_j2GIwVx6TUfqZWc2v7lEkr7S -->
```json
{
  "description": "Implement Approval Gates Chunk 4",
  "subagent_type": "coder",
  "prompt": "You are implementing **Chunk 4: API Server and Protocol Buffers** of the Approval Gates feature in the Paprika repo worktree at `/Users/benebsworth/projects/paprika/.worktrees/approval-gates`.\n\nFollow the plan below exactly. Regenerate protobuf, implement the handlers, run `make test` and `make lint`, and commit.\n\n---\n\n## Chunk 4: API Server and Protocol Buffers\n\n### Task 1: Extend the protobuf schema\n\n**Files:**\n- Modify: `proto/paprika/v1/api.proto`\n\n- [ ] **Step 1: Extend `GateStatus`**\n\n  Replace the existing `GateStatus` message (around line 114) with:\n\n  ```protobuf\n  message GateStatus {\n    string name = 1;\n    string stage = 2;\n    string status = 3;\n    string approved_by = 4;\n    string type = 5;\n    string message = 6;\n  }\n  ```\n\n- [ ] **Step 2: Add new request/response messages**\n\n  Insert after `ApproveGateResponse` (around line 395):\n\n  ```protobuf\n  message ListGateStatusRequest {\n    string namespace = 1;\n    string name = 2;\n  }\n\n  message ListGateStatusResponse {\n    repeated GateStatus gates = 1;\n  }\n\n  message RejectGateRequest {\n    string name = 1;\n    string namespace = 2;\n    string gate = 3;\n  }\n\n  message RejectGateResponse {\n    Application application = 1;\n  }\n  ```\n\n- [ ] **Step 3: Add RPCs to `PaprikaService`**\n\n  Add to the service block after `ApproveGate`:\n\n  ```protobuf\n  rpc ListGateStatus(ListGateStatusRequest) returns (ListGateStatusResponse);\n  rpc RejectGate(RejectGateRequest) returns (RejectGateResponse);\n  ```\n\n- [ ] **Step 4: Regenerate protobuf clients**\n\n  ```bash\n  make generate-proto\n  ```\n\n  Expected: `internal/api/paprika/v1/api.pb.go` and `ui/src/gen/paprika/v1/*` are updated with the new fields and RPCs.\n\n- [ ] **Step 5: Commit**\n\n  ```bash\n  git add proto/paprika/v1/api.proto internal/api/paprika/v1/api.pb.go ui/src/gen/paprika/v1\n  git commit -m \"feat(approval-gates): add ListGateStatus and RejectGate RPCs\"\n  ```\n\n### Task 2: Implement server handlers\n\n**Files:**\n- Modify: `internal/api/server.go`\n\n- [ ] **Step 1: Add RBAC marker for application status**\n\n  Above `ApproveGate` (around line 461) add:\n\n  ```go\n  // +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications/status,verbs=get;update;patch\n  ```\n\n- [ ] **Step 2: Add `convertGateStatuses` helper**\n\n  Insert near other `convert*` helpers:\n\n  ```go\n  func convertGateStatuses(statuses []pipelinesv1alpha1.GateStatus) []*paprikav1.GateStatus {\n      out := make([]*paprikav1.GateStatus, 0, len(statuses))\n      for i := range statuses {\n          s := &statuses[i]\n          out = append(out, &paprikav1.GateStatus{\n              Name:       s.Name,\n              Stage:      s.Stage,\n              Type:       s.Type,\n              Status:     s.Status,\n              ApprovedBy: s.ApprovedBy,\n              Message:    s.Message,\n          })\n      }\n      return out\n  }\n  ```\n\n- [ ] **Step 3: Surface gate statuses in `convertApplication`**\n\n  In `convertApplication` (around line 867), add before the closing `}` of the returned struct:\n\n  ```go\n  Gates: convertGateStatuses(a.Status.Gates),\n  ```\n\n- [ ] **Step 4: Implement `ListGateStatus`**\n\n  Add after `ApproveGate`:\n\n  ```go\n  func (s *PaprikaServer) ListGateStatus(\n      ctx context.Context,\n      req *connect.Request[paprikav1.ListGateStatusRequest],\n  ) (*connect.Response[paprikav1.ListGateStatusResponse], error) {\n      var app pipelinesv1alpha1.Application\n      if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &app); err != nil {\n          return nil, fmt.Errorf(\"getting application: %w\", err)\n      }\n      if err := s.authorizeApplication(ctx, auth.ActionRead, &app); err != nil {\n          return nil, connect.NewError(connect.CodePermissionDenied, err)\n      }\n      return connect.NewResponse(&paprikav1.ListGateStatusResponse{Gates: convertGateStatuses(app.Status.Gates)}), nil\n  }\n  ```\n\n- [ ] **Step 5: Implement `RejectGate`**\n\n  Add after `ListGateStatus`:\n\n  ```go\n  func (s *PaprikaServer) RejectGate(\n      ctx context.Context,\n      req *connect.Request[paprikav1.RejectGateRequest],\n  ) (*connect.Response[paprikav1.RejectGateResponse], error) {\n      var app pipelinesv1alpha1.Application\n      if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &app); err != nil {\n          return nil, fmt.Errorf(\"getting application: %w\", err)\n      }\n      if err := s.authorizeApplication(ctx, auth.ActionWrite, &app); err != nil {\n          return nil, connect.NewError(connect.CodePermissionDenied, err)\n      }\n\n      found := false\n      for i := range app.Status.Gates {\n          if app.Status.Gates[i].Name == req.Msg.Gate {\n              app.Status.Gates[i].Status = pipelinesv1alpha1.GateStatusRejected\n              app.Status.Gates[i].ApprovedBy = \"\"\n              found = true\n              break\n          }\n      }\n      if !found {\n          return nil, fmt.Errorf(\"gate %s not found\", req.Msg.Gate)\n      }\n\n      if err := s.client.Status().Update(ctx, &app); err != nil {\n          return nil, fmt.Errorf(\"updating gate status: %w\", err)\n      }\n\n      var refreshed pipelinesv1alpha1.Application\n      if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &refreshed); err != nil {\n          return nil, fmt.Errorf(\"getting refreshed application: %w\", err)\n      }\n\n      return connect.NewResponse(&paprikav1.RejectGateResponse{Application: convertApplication(&refreshed)}), nil\n  }\n  ```\n\n- [ ] **Step 6: Update `ApproveGate` to use typed constants**\n\n  In the existing `ApproveGate` handler, change the status assignment to:\n\n  ```go\n  app.Status.Gates[i].Status = pipelinesv1alpha1.GateStatusApproved\n  ```\n\n- [ ] **Step 7: Commit**\n\n  ```bash\n  git add internal/api/server.go\n  git commit -m \"feat(approval-gates): implement ListGateStatus and RejectGate handlers\"\n  ```\n\n---\n\n**Verification:** After all commits, run `make test` and `make lint` and report the results. Fix any failures before reporting done."
}
```

<details><summary>Tool Result: Agent (`Implement Approval Gates Chunk 4`)</summary>

<!-- call_id: tool_j2GIwVx6TUfqZWc2v7lEkr7S -->
agent_id: agent-87
actual_subagent_type: coder
status: completed

[summary]
Chunk 4 completed. All tests and lint pass.

**Summary of changes:**

- Extended `proto/paprika/v1/api.proto`:
  - Added `type` and `message` fields to `GateStatus`
  - Added `ListGateStatusRequest/Response` and `RejectGateRequest/Response`
  - Added `ListGateStatus` and `RejectGate` RPCs to `PaprikaService`

- Regenerated protobuf clients via `make generate-proto`

- Implemented handlers in `internal/api/server.go`:
  - Added `convertGateStatuses` helper
  - Surfaced gate statuses in `convertApplication`
  - Implemented `ListGateStatus` and `RejectGate`
  - Updated `ApproveGate` to use typed constant `pipelinesv1alpha1.GateStatusApproved`

- Added required stubs in other `v1connect.PaprikaServiceHandler` implementations:
  - `internal/agent/server/server.go`
  - `internal/reposerver/server.go`

- Committed generated connect client (`internal/api/paprika/v1/v1connect/api.connect.go`)

**Commits:**
1. `fc3488f` feat(approval-gates): add ListGateStatus and RejectGate RPCs
2. `804f81c` feat(approval-gates): implement ListGateStatus and RejectGate handlers
3. `edaf34a` feat(approval-gates): regenerate connect client and stub agent handlers
4. `e0f2cb8` feat(approval-gates): stub ListGateStatus and RejectGate in repo server

**Verification:**
- `make test` ✅ passed
- `make lint` ✅ 0 issues

Note: Two extra commits were required beyond the plan because the generated `api.connect.go` needed to be committed, and the agent/repo server handler implementations required stub methods to satisfy the updated interface.

</details>

<details><summary>Thinking</summary>

Chunk 4 done. Move to Chunk 5: CLI commands. Dispatch implementer.

</details>

#### Tool Call: TodoList
<!-- call_id: tool_AEi3b0iBGL3FerB8SgbZl8ur -->
```json
{
  "todos": [
    {
      "title": "Review backlog and select next epic",
      "status": "done"
    },
    {
      "title": "Set up isolated worktree for chosen feature",
      "status": "done"
    },
    {
      "title": "Chunk 1: Policy CRD and evaluator package",
      "status": "done"
    },
    {
      "title": "Chunk 2: CRD changes for inline source and policy results",
      "status": "done"
    },
    {
      "title": "Chunk 3: Protobuf and ApplyBundle API server handler",
      "status": "done"
    },
    {
      "title": "Chunk 4a: Release controller inline manifest path",
      "status": "done"
    },
    {
      "title": "Chunk 4b: Application controller inline source handling",
      "status": "done"
    },
    {
      "title": "Chunk 4c: True rollback",
      "status": "done"
    },
    {
      "title": "Chunk 5: CLI apply command and TUI",
      "status": "done"
    },
    {
      "title": "Chunk 6: UI, RBAC manifests, and final integration",
      "status": "done"
    },
    {
      "title": "Chunk 7: Validation webhooks",
      "status": "done"
    },
    {
      "title": "Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)",
      "status": "done"
    },
    {
      "title": "Set up worktree for Approval Gates",
      "status": "done"
    },
    {
      "title": "Write Approval Gates implementation plan",
      "status": "done"
    },
    {
      "title": "Chunk 1: Approval Gates API schema",
      "status": "done"
    },
    {
      "title": "Chunk 2: Approval gate evaluator package",
      "status": "done"
    },
    {
      "title": "Chunk 3: Release controller integration",
      "status": "done"
    },
    {
      "title": "Chunk 4: API server protobuf and handlers",
      "status": "done"
    },
    {
      "title": "Chunk 5: CLI commands",
      "status": "in_progress"
    },
    {
      "title": "Chunk 6: UI updates",
      "status": "pending"
    },
    {
      "title": "Chunk 7: Tests and verification",
      "status": "pending"
    }
  ]
}
```

<details><summary>Tool Result: TodoList</summary>

<!-- call_id: tool_AEi3b0iBGL3FerB8SgbZl8ur -->
Todo list updated.
Current todo list:
  [done] Review backlog and select next epic
  [done] Set up isolated worktree for chosen feature
  [done] Chunk 1: Policy CRD and evaluator package
  [done] Chunk 2: CRD changes for inline source and policy results
  [done] Chunk 3: Protobuf and ApplyBundle API server handler
  [done] Chunk 4a: Release controller inline manifest path
  [done] Chunk 4b: Application controller inline source handling
  [done] Chunk 4c: True rollback
  [done] Chunk 5: CLI apply command and TUI
  [done] Chunk 6: UI, RBAC manifests, and final integration
  [done] Chunk 7: Validation webhooks
  [done] Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)
  [done] Set up worktree for Approval Gates
  [done] Write Approval Gates implementation plan
  [done] Chunk 1: Approval Gates API schema
  [done] Chunk 2: Approval gate evaluator package
  [done] Chunk 3: Release controller integration
  [done] Chunk 4: API server protobuf and handlers
  [in_progress] Chunk 5: CLI commands
  [pending] Chunk 6: UI updates
  [pending] Chunk 7: Tests and verification

Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.

</details>

<details><summary>Thinking</summary>

Dispatch Chunk 5 implementer.

</details>

#### Tool Call: Agent (`Implement Approval Gates Chunk 5`)
<!-- call_id: tool_kBJQS8Vrpt11EEAS6mdLgpqy -->
```json
{
  "description": "Implement Approval Gates Chunk 5",
  "subagent_type": "coder",
  "prompt": "You are implementing **Chunk 5: CLI Commands** of the Approval Gates feature in the Paprika repo worktree at `/Users/benebsworth/projects/paprika/.worktrees/approval-gates`.\n\nFollow the plan below exactly. Modify `cmd/paprika/gates.go`, build the CLI, run `make test` and `make lint`, and commit.\n\n---\n\n## Chunk 5: CLI Commands\n\n### Task 1: Extend `paprika gates`\n\n**Files:**\n- Modify: `cmd/paprika/gates.go`\n\n- [ ] **Step 1: Add helper to render gate statuses**\n\n  Insert at the top of `cmd/paprika/gates.go` after imports:\n\n  ```go\n  import (\n      ...existing imports...\n      \"io\"\n      \"text/tabwriter\"\n  )\n\n  func writeGateStatuses(w io.Writer, output string, gates []*paprikav1.GateStatus) error {\n      switch output {\n      case outputJSON, outputYAML:\n          return writeProtoOutput(w, output, &paprikav1.ListGateStatusResponse{Gates: gates})\n      case outputTable:\n          tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)\n          if _, err := fmt.Fprintln(tw, \"NAME\\tSTAGE\\tTYPE\\tSTATUS\\tAPPROVED BY\\tMESSAGE\"); err != nil {\n              return fmt.Errorf(\"write header: %w\", err)\n          }\n          for _, g := range gates {\n              if _, err := fmt.Fprintf(tw, \"%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n\", g.Name, g.Stage, g.Type, g.Status, g.ApprovedBy, g.Message); err != nil {\n                  return fmt.Errorf(\"write row: %w\", err)\n              }\n          }\n          return tw.Flush()\n      default:\n          return fmt.Errorf(\"unknown output format %q\", output)\n      }\n  }\n  ```\n\n- [ ] **Step 2: Add `list` subcommand**\n\n  Add to `newGatesCmd` before returning `cmd`:\n\n  ```go\n  cmd.AddCommand(&cobra.Command{\n      Use:   \"list APP\",\n      Short: \"List approval gates for an application\",\n      Args:  cobra.ExactArgs(1),\n      RunE: func(cmd *cobra.Command, args []string) error {\n          client, err := clientFn()\n          if err != nil {\n              return fmt.Errorf(\"create client: %w\", err)\n          }\n          res, err := client.ListGateStatus(ctx, connect.NewRequest(&paprikav1.ListGateStatusRequest{\n              Name:      args[0],\n              Namespace: nsFn(),\n          }))\n          if err != nil {\n              return fmt.Errorf(\"list gate status: %w\", err)\n          }\n          return writeGateStatuses(cmd.OutOrStdout(), *output, res.Msg.Gates)\n      },\n  })\n  ```\n\n- [ ] **Step 3: Add `reject` subcommand**\n\n  Add after the `approve` command block:\n\n  ```go\n  cmd.AddCommand(&cobra.Command{\n      Use:   \"reject APP GATE\",\n      Short: \"Reject a gate for an application\",\n      Args:  cobra.ExactArgs(2),\n      RunE: func(cmd *cobra.Command, args []string) error {\n          client, err := clientFn()\n          if err != nil {\n              return fmt.Errorf(\"create client: %w\", err)\n          }\n          res, err := client.RejectGate(ctx, connect.NewRequest(&paprikav1.RejectGateRequest{\n              Name:      args[0],\n              Namespace: nsFn(),\n              Gate:      args[1],\n          }))\n          if err != nil {\n              return fmt.Errorf(\"reject gate: %w\", err)\n          }\n          return writeApplication(cmd.OutOrStdout(), *output, res.Msg.Application)\n      },\n  })\n  ```\n\n- [ ] **Step 4: Build and test the CLI**\n\n  ```bash\n  go build ./cmd/paprika\n  ./paprika gates --help\n  ```\n\n  Expected: `list`, `approve`, and `reject` subcommands are shown.\n\n- [ ] **Step 5: Commit**\n\n  ```bash\n  git add cmd/paprika/gates.go\n  git commit -m \"feat(approval-gates): add gates list/reject CLI commands\"\n  ```\n\n---\n\n**Verification:** After the commit, run `make test` and `make lint` and report the results. Fix any failures before reporting done."
}
```

<details><summary>Tool Result: Agent (`Implement Approval Gates Chunk 5`)</summary>

<!-- call_id: tool_kBJQS8Vrpt11EEAS6mdLgpqy -->
agent_id: agent-88
actual_subagent_type: coder
status: completed

[summary]
Chunk 5: CLI Commands is complete.

**What was changed:**
- Modified `cmd/paprika/gates.go` in `/Users/benebsworth/projects/paprika/.worktrees/approval-gates`
- Added `writeGateStatuses` helper with JSON/YAML/table output support
- Added `list APP` subcommand (`ListGateStatus`)
- Added `reject APP GATE` subcommand (`RejectGate`)

**Verification:**
- `go build ./cmd/paprika` succeeded
- `./paprika gates --help` shows `approve`, `list`, and `reject` subcommands
- `make test` passed
- `make lint` initially failed on `wrapcheck` for `tw.Flush()`; fixed by wrapping the error, then lint passed

**Commit:**
- `3ad06a2 feat(approval-gates): add gates list/reject CLI commands`

</details>

<details><summary>Thinking</summary>

Chunk 5 done. Move to Chunk 6: UI updates. Dispatch implementer.

</details>

#### Tool Call: TodoList
<!-- call_id: tool_VlDwUrOm5Zix27MMtAsgzjM0 -->
```json
{
  "todos": [
    {
      "title": "Review backlog and select next epic",
      "status": "done"
    },
    {
      "title": "Set up isolated worktree for chosen feature",
      "status": "done"
    },
    {
      "title": "Chunk 1: Policy CRD and evaluator package",
      "status": "done"
    },
    {
      "title": "Chunk 2: CRD changes for inline source and policy results",
      "status": "done"
    },
    {
      "title": "Chunk 3: Protobuf and ApplyBundle API server handler",
      "status": "done"
    },
    {
      "title": "Chunk 4a: Release controller inline manifest path",
      "status": "done"
    },
    {
      "title": "Chunk 4b: Application controller inline source handling",
      "status": "done"
    },
    {
      "title": "Chunk 4c: True rollback",
      "status": "done"
    },
    {
      "title": "Chunk 5: CLI apply command and TUI",
      "status": "done"
    },
    {
      "title": "Chunk 6: UI, RBAC manifests, and final integration",
      "status": "done"
    },
    {
      "title": "Chunk 7: Validation webhooks",
      "status": "done"
    },
    {
      "title": "Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)",
      "status": "done"
    },
    {
      "title": "Set up worktree for Approval Gates",
      "status": "done"
    },
    {
      "title": "Write Approval Gates implementation plan",
      "status": "done"
    },
    {
      "title": "Chunk 1: Approval Gates API schema",
      "status": "done"
    },
    {
      "title": "Chunk 2: Approval gate evaluator package",
      "status": "done"
    },
    {
      "title": "Chunk 3: Release controller integration",
      "status": "done"
    },
    {
      "title": "Chunk 4: API server protobuf and handlers",
      "status": "done"
    },
    {
      "title": "Chunk 5: CLI commands",
      "status": "done"
    },
    {
      "title": "Chunk 6: UI updates",
      "status": "in_progress"
    },
    {
      "title": "Chunk 7: Tests and verification",
      "status": "pending"
    }
  ]
}
```

<details><summary>Tool Result: TodoList</summary>

<!-- call_id: tool_VlDwUrOm5Zix27MMtAsgzjM0 -->
Todo list updated.
Current todo list:
  [done] Review backlog and select next epic
  [done] Set up isolated worktree for chosen feature
  [done] Chunk 1: Policy CRD and evaluator package
  [done] Chunk 2: CRD changes for inline source and policy results
  [done] Chunk 3: Protobuf and ApplyBundle API server handler
  [done] Chunk 4a: Release controller inline manifest path
  [done] Chunk 4b: Application controller inline source handling
  [done] Chunk 4c: True rollback
  [done] Chunk 5: CLI apply command and TUI
  [done] Chunk 6: UI, RBAC manifests, and final integration
  [done] Chunk 7: Validation webhooks
  [done] Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)
  [done] Set up worktree for Approval Gates
  [done] Write Approval Gates implementation plan
  [done] Chunk 1: Approval Gates API schema
  [done] Chunk 2: Approval gate evaluator package
  [done] Chunk 3: Release controller integration
  [done] Chunk 4: API server protobuf and handlers
  [done] Chunk 5: CLI commands
  [in_progress] Chunk 6: UI updates
  [pending] Chunk 7: Tests and verification

Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.

</details>

<details><summary>Thinking</summary>

Dispatch Chunk 6 implementer.

</details>

#### Tool Call: Agent (`Implement Approval Gates Chunk 6`)
<!-- call_id: tool_EWOI8TOhLYevyW0nJq8a0uue -->
```json
{
  "description": "Implement Approval Gates Chunk 6",
  "subagent_type": "coder",
  "prompt": "You are implementing **Chunk 6: UI Updates** of the Approval Gates feature in the Paprika repo worktree at `/Users/benebsworth/projects/paprika/.worktrees/approval-gates`.\n\nFollow the plan below exactly. Modify the UI files, run the type check, run `make test` and `make lint` (Go side), and commit.\n\n---\n\n## Chunk 6: UI Updates\n\n### Task 1: Display `AwaitingApproval` in the status badge\n\n**Files:**\n- Modify: `ui/src/components/ui/status-badge.tsx`\n\n- [ ] **Step 1: Add the mapping**\n\n  Insert into `statusConfig`:\n\n  ```ts\n  AwaitingApproval: {\n    icon: PauseCircle,\n    className: \"bg-warning/10 text-warning border-warning/20\",\n  },\n  ```\n\n- [ ] **Step 2: Commit**\n\n  ```bash\n  git add ui/src/components/ui/status-badge.tsx\n  git commit -m \"feat(approval-gates): add AwaitingApproval status badge\"\n  ```\n\n### Task 2: Show pending gates and approve/reject buttons\n\n**Files:**\n- Modify: `ui/src/app/dashboard/application/page.tsx`\n\n- [ ] **Step 1: Import `ShieldAlert` and add state**\n\n  Add to imports (already imported `ShieldAlert`, confirm it is present). Add state inside `ApplicationDetail`:\n\n  ```ts\n  const [actingGate, setActingGate] = useState<string | null>(null);\n  ```\n\n- [ ] **Step 2: Add approve/reject handlers**\n\n  After `handleRollback`:\n\n  ```ts\n  const handleGateAction = useCallback(\n    async (gateName: string, action: \"approve\" | \"reject\") => {\n      if (!application) return;\n      setActingGate(gateName);\n      try {\n        if (action === \"approve\") {\n          await client.approveGate({ namespace, name, gate: gateName });\n        } else {\n          await client.rejectGate({ namespace, name, gate: gateName });\n        }\n        await fetchData();\n      } catch (err) {\n        setError(`${action === \"approve\" ? \"Approval\" : \"Rejection\"} failed for ${gateName}`);\n        console.error(err);\n      } finally {\n        setActingGate(null);\n      }\n    },\n    [application, namespace, name, fetchData],\n  );\n  ```\n\n- [ ] **Step 3: Render the gates card**\n\n  Insert after the top metrics grid (after the closing `</div>` of the grid around line 273):\n\n  ```tsx\n  {application.gates && application.gates.length > 0 && (\n    <Card>\n      <CardHeader>\n        <CardTitle className=\"flex items-center gap-2\">\n          <ShieldAlert className=\"h-5 w-5\" />\n          Approval Gates\n        </CardTitle>\n        <CardDescription>Gates that must pass before promotion continues.</CardDescription>\n      </CardHeader>\n      <CardContent>\n        <Table>\n          <TableHeader>\n            <TableRow>\n              <TableHead>Name</TableHead>\n              <TableHead>Stage</TableHead>\n              <TableHead>Type</TableHead>\n              <TableHead>Status</TableHead>\n              <TableHead>Message</TableHead>\n              <TableHead className=\"text-right\">Actions</TableHead>\n            </TableRow>\n          </TableHeader>\n          <TableBody>\n            {application.gates.map((gate) => (\n              <TableRow key={gate.name}>\n                <TableCell className=\"font-medium\">{gate.name}</TableCell>\n                <TableCell>{gate.stage || \"—\"}</TableCell>\n                <TableCell>{gate.type || \"—\"}</TableCell>\n                <TableCell>\n                  <StatusBadge status={gate.status} />\n                </TableCell>\n                <TableCell className=\"text-muted-foreground\">{gate.message || \"—\"}</TableCell>\n                <TableCell className=\"text-right\">\n                  {gate.status === \"Pending\" && (\n                    <div className=\"flex justify-end gap-2\">\n                      <Button\n                        variant=\"outline\"\n                        size=\"sm\"\n                        onClick={() => handleGateAction(gate.name, \"approve\")}\n                        disabled={actingGate === gate.name}\n                      >\n                        Approve\n                      </Button>\n                      <Button\n                        variant=\"ghost\"\n                        size=\"sm\"\n                        onClick={() => handleGateAction(gate.name, \"reject\")}\n                        disabled={actingGate === gate.name}\n                      >\n                        Reject\n                      </Button>\n                    </div>\n                  )}\n                </TableCell>\n              </TableRow>\n            ))}\n          </TableBody>\n        </Table>\n      </CardContent>\n    </Card>\n  )}\n  ```\n\n- [ ] **Step 4: Run the UI type check**\n\n  ```bash\n  cd ui && npm run typecheck\n  ```\n\n  Expected: no new type errors.\n\n- [ ] **Step 5: Commit**\n\n  ```bash\n  git add ui/src/app/dashboard/application/page.tsx ui/src/components/ui/status-badge.tsx\n  git commit -m \"feat(approval-gates): show gates and approve/reject in UI\"\n  ```\n\n---\n\n**Verification:** After all commits, run `make test`, `make lint`, and `cd ui && npm run typecheck` and report the results. Fix any failures before reporting done."
}
```

<details><summary>Tool Result: Agent (`Implement Approval Gates Chunk 6`)</summary>

<!-- call_id: tool_EWOI8TOhLYevyW0nJq8a0uue -->
agent_id: agent-89
actual_subagent_type: coder
status: completed

[summary]
Chunk 6 UI Updates complete.

**Changes made:**
- `ui/src/components/ui/status-badge.tsx`: Added `AwaitingApproval` status badge mapping.
- `ui/src/app/dashboard/application/page.tsx`: Added `actingGate` state, `handleGateAction` approve/reject handler, and rendered the Approval Gates card with action buttons.

**Commits:**
- `fb7a1ef` feat(approval-gates): add AwaitingApproval status badge
- `faa90bd` feat(approval-gates): show gates and approve/reject in UI

**Verification results:**
- `make test`: Passed (all Go unit tests green).
- `make lint`: Passed (0 issues).
- UI type check: `npm run typecheck` script does not exist in this project, so I ran the equivalent checks:
  - `npx tsc --noEmit`: Passed with no errors.
  - `npm run build`: Passed with no TypeScript errors and built successfully.

One unrelated untracked file `paprika` remains in the worktree; I did not touch it.

</details>

<details><summary>Thinking</summary>

Chunk 6 done. Now Chunk 7: Tests and verification. This includes unit tests for release controller gate flow and E2E test. We can dispatch implementer. But E2E test may be heavy; we can at least add unit tests. The E2E test can be added but not run. We'll add it and maybe run unit tests. Let's dispatch Chunk 7 implementer with unit tests and E2E test.

</details>

#### Tool Call: TodoList
<!-- call_id: tool_H2CpZnlZiXVeK10XOY5WjqIx -->
```json
{
  "todos": [
    {
      "title": "Review backlog and select next epic",
      "status": "done"
    },
    {
      "title": "Set up isolated worktree for chosen feature",
      "status": "done"
    },
    {
      "title": "Chunk 1: Policy CRD and evaluator package",
      "status": "done"
    },
    {
      "title": "Chunk 2: CRD changes for inline source and policy results",
      "status": "done"
    },
    {
      "title": "Chunk 3: Protobuf and ApplyBundle API server handler",
      "status": "done"
    },
    {
      "title": "Chunk 4a: Release controller inline manifest path",
      "status": "done"
    },
    {
      "title": "Chunk 4b: Application controller inline source handling",
      "status": "done"
    },
    {
      "title": "Chunk 4c: True rollback",
      "status": "done"
    },
    {
      "title": "Chunk 5: CLI apply command and TUI",
      "status": "done"
    },
    {
      "title": "Chunk 6: UI, RBAC manifests, and final integration",
      "status": "done"
    },
    {
      "title": "Chunk 7: Validation webhooks",
      "status": "done"
    },
    {
      "title": "Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)",
      "status": "done"
    },
    {
      "title": "Set up worktree for Approval Gates",
      "status": "done"
    },
    {
      "title": "Write Approval Gates implementation plan",
      "status": "done"
    },
    {
      "title": "Chunk 1: Approval Gates API schema",
      "status": "done"
    },
    {
      "title": "Chunk 2: Approval gate evaluator package",
      "status": "done"
    },
    {
      "title": "Chunk 3: Release controller integration",
      "status": "done"
    },
    {
      "title": "Chunk 4: API server protobuf and handlers",
      "status": "done"
    },
    {
      "title": "Chunk 5: CLI commands",
      "status": "done"
    },
    {
      "title": "Chunk 6: UI updates",
      "status": "done"
    },
    {
      "title": "Chunk 7: Tests and verification",
      "status": "in_progress"
    }
  ]
}
```

<details><summary>Tool Result: TodoList</summary>

<!-- call_id: tool_H2CpZnlZiXVeK10XOY5WjqIx -->
Todo list updated.
Current todo list:
  [done] Review backlog and select next epic
  [done] Set up isolated worktree for chosen feature
  [done] Chunk 1: Policy CRD and evaluator package
  [done] Chunk 2: CRD changes for inline source and policy results
  [done] Chunk 3: Protobuf and ApplyBundle API server handler
  [done] Chunk 4a: Release controller inline manifest path
  [done] Chunk 4b: Application controller inline source handling
  [done] Chunk 4c: True rollback
  [done] Chunk 5: CLI apply command and TUI
  [done] Chunk 6: UI, RBAC manifests, and final integration
  [done] Chunk 7: Validation webhooks
  [done] Close paprika apply gaps (E2E test, handler hardening, UI generate script, release inline test)
  [done] Set up worktree for Approval Gates
  [done] Write Approval Gates implementation plan
  [done] Chunk 1: Approval Gates API schema
  [done] Chunk 2: Approval gate evaluator package
  [done] Chunk 3: Release controller integration
  [done] Chunk 4: API server protobuf and handlers
  [done] Chunk 5: CLI commands
  [done] Chunk 6: UI updates
  [in_progress] Chunk 7: Tests and verification

Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.

</details>

<details><summary>Thinking</summary>

Dispatch Chunk 7 implementer. Include unit tests and E2E test plan.

</details>

#### Tool Call: Agent (`Implement Approval Gates Chunk 7`)
<!-- call_id: tool_3N8425tAKsFFUf3i6OMtVqhG -->
```json
{
  "description": "Implement Approval Gates Chunk 7",
  "subagent_type": "coder",
  "prompt": "You are implementing **Chunk 7: Tests and Verification** of the Approval Gates feature in the Paprika repo worktree at `/Users/benebsworth/projects/paprika/.worktrees/approval-gates`.\n\nFollow the plan below. Add the unit tests, add the E2E test, run `make test` and `make lint`, and commit. The E2E test does not need to be run locally (we will validate in CI), but it must compile.\n\n---\n\n## Chunk 7: Tests and Verification\n\n### Task 1: Unit-test the release controller gate flow\n\n**Files:**\n- Modify: `internal/controller/pipelines/release_controller_unit_test.go`\n\n- [ ] **Step 1: Add a fake approval evaluator**\n\n  Insert after `fakeGateExecutor`:\n\n  ```go\n  type fakeApprovalEvaluator struct {\n      results map[string]*gates.ApprovalGateResult\n  }\n\n  func (f *fakeApprovalEvaluator) Evaluate(_ context.Context, gate *gates.ApprovalGate, _ *gates.ApprovalGatePayload, _ string) *gates.ApprovalGateResult {\n      if r, ok := f.results[gate.Name]; ok {\n          return r\n      }\n      return &gates.ApprovalGateResult{Status: gates.ApprovalGateStatusPending}\n  }\n  ```\n\n- [ ] **Step 2: Add tests for pending, approved, and rejected gates**\n\n  Append to the test file:\n\n  ```go\n  func TestReleaseReconciler_handlePromotingPhase_awaitsApproval(t *testing.T) {\n      ctx := context.Background()\n      scheme := runtime.NewScheme()\n      _ = pipelinesv1alpha1.AddToScheme(scheme)\n      _ = corev1.AddToScheme(scheme)\n\n      app := &pipelinesv1alpha1.Application{\n          ObjectMeta: metav1.ObjectMeta{Name: \"gate-app\", Namespace: \"default\", UID: types.UID(\"uid\")},\n          Spec: pipelinesv1alpha1.ApplicationSpec{\n              ApprovalGates: []pipelinesv1alpha1.ApprovalGate{\n                  {Name: \"manual-gate\", Type: pipelinesv1alpha1.ApprovalGateTypeManual, Required: true},\n              },\n          },\n      }\n      stage := &pipelinesv1alpha1.Stage{\n          ObjectMeta: metav1.ObjectMeta{Name: \"gate-stage\", Namespace: \"default\"},\n          Spec: pipelinesv1alpha1.StageSpec{Name: \"dev\", Ring: 1, Templates: []string{}},\n      }\n      release := &pipelinesv1alpha1.Release{\n          ObjectMeta: metav1.ObjectMeta{\n              Name:      \"gate-release\",\n              Namespace: \"default\",\n              OwnerReferences: []metav1.OwnerReference{{\n                  APIVersion: pipelinesv1alpha1.GroupVersion.String(),\n                  Kind:       \"Application\",\n                  Name:       app.Name,\n                  UID:        app.UID,\n              }},\n          },\n          Spec: pipelinesv1alpha1.ReleaseSpec{Target: stage.Name},\n          Status: pipelinesv1alpha1.ReleaseStatus{Phase: pipelinesv1alpha1.ReleasePromoting},\n      }\n\n      c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app, stage, release).WithStatusSubresource(&pipelinesv1alpha1.Release{}, &pipelinesv1alpha1.Application{}).Build()\n      r := &ReleaseReconciler{\n          client:                c,\n          Scheme:                scheme,\n          ApprovalGateEvaluator: &fakeApprovalEvaluator{},\n      }\n\n      _, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: release.Name, Namespace: release.Namespace}})\n      if err != nil {\n          t.Fatalf(\"reconcile error: %v\", err)\n      }\n\n      var updated pipelinesv1alpha1.Release\n      if err := c.Get(ctx, client.ObjectKeyFromObject(release), &updated); err != nil {\n          t.Fatalf(\"get release: %v\", err)\n      }\n      if updated.Status.Phase != pipelinesv1alpha1.ReleaseAwaitingApproval {\n          t.Errorf(\"phase = %s, want AwaitingApproval\", updated.Status.Phase)\n      }\n\n      var updatedApp pipelinesv1alpha1.Application\n      if err := c.Get(ctx, client.ObjectKeyFromObject(app), &updatedApp); err != nil {\n          t.Fatalf(\"get app: %v\", err)\n      }\n      if len(updatedApp.Status.Gates) != 1 || updatedApp.Status.Gates[0].Status != pipelinesv1alpha1.GateStatusPending {\n          t.Errorf(\"gate status = %+v, want one Pending\", updatedApp.Status.Gates)\n      }\n  }\n\n  func TestReleaseReconciler_handleAwaitingApprovalPhase_promotesWhenApproved(t *testing.T) {\n      ctx := context.Background()\n      scheme := runtime.NewScheme()\n      _ = pipelinesv1alpha1.AddToScheme(scheme)\n      _ = corev1.AddToScheme(scheme)\n\n      app := &pipelinesv1alpha1.Application{\n          ObjectMeta: metav1.ObjectMeta{Name: \"gate-app\", Namespace: \"default\", UID: types.UID(\"uid\")},\n          Spec: pipelinesv1alpha1.ApplicationSpec{\n              ApprovalGates: []pipelinesv1alpha1.ApprovalGate{\n                  {Name: \"manual-gate\", Type: pipelinesv1alpha1.ApprovalGateTypeManual, Required: true},\n              },\n          },\n          Status: pipelinesv1alpha1.ApplicationStatus{\n              Gates: []pipelinesv1alpha1.GateStatus{\n                  {Name: \"manual-gate\", Status: pipelinesv1alpha1.GateStatusApproved, ApprovedBy: \"test\"},\n              },\n          },\n      }\n      stage := &pipelinesv1alpha1.Stage{\n          ObjectMeta: metav1.ObjectMeta{Name: \"gate-stage\", Namespace: \"default\"},\n          Spec: pipelinesv1alpha1.StageSpec{Name: \"dev\", Ring: 1, Templates: []string{}},\n      }\n      release := &pipelinesv1alpha1.Release{\n          ObjectMeta: metav1.ObjectMeta{\n              Name:      \"gate-release\",\n              Namespace: \"default\",\n              OwnerReferences: []metav1.OwnerReference{{\n                  APIVersion: pipelinesv1alpha1.GroupVersion.String(),\n                  Kind:       \"Application\",\n                  Name:       app.Name,\n                  UID:        app.UID,\n              }},\n          },\n          Spec: pipelinesv1alpha1.ReleaseSpec{Target: stage.Name},\n          Status: pipelinesv1alpha1.ReleaseStatus{Phase: pipelinesv1alpha1.ReleaseAwaitingApproval},\n      }\n\n      c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app, stage, release).WithStatusSubresource(&pipelinesv1alpha1.Release{}, &pipelinesv1alpha1.Application{}).Build()\n      r := &ReleaseReconciler{\n          client:                c,\n          Scheme:                scheme,\n          ApprovalGateEvaluator: &fakeApprovalEvaluator{},\n      }\n\n      _, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: release.Name, Namespace: release.Namespace}})\n      if err != nil {\n          t.Fatalf(\"reconcile error: %v\", err)\n      }\n\n      var updated pipelinesv1alpha1.Release\n      if err := c.Get(ctx, client.ObjectKeyFromObject(release), &updated); err != nil {\n          t.Fatalf(\"get release: %v\", err)\n      }\n      if updated.Status.Phase != pipelinesv1alpha1.ReleasePromoting {\n          t.Errorf(\"phase = %s, want Promoting\", updated.Status.Phase)\n      }\n  }\n  ```\n\n- [ ] **Step 3: Run the new unit tests**\n\n  ```bash\n  go test ./internal/controller/pipelines/... -run TestReleaseReconciler_handlePromotingPhase_awaitsApproval -v\n  go test ./internal/controller/pipelines/... -run TestReleaseReconciler_handleAwaitingApprovalPhase_promotesWhenApproved -v\n  ```\n\n  Expected: PASS.\n\n- [ ] **Step 4: Commit**\n\n  ```bash\n  git add internal/controller/pipelines/release_controller_unit_test.go\n  git commit -m \"test(approval-gates): add release controller gate unit tests\"\n  ```\n\n### Task 2: Add an E2E test for a manual gate\n\n**Files:**\n- Modify: `test/e2e/e2e_test.go`\n\n- [ ] **Step 1: Add a new Ginkgo context**\n\n  Append inside `Describe(\"Manager\", Ordered, func() { ... })` near the end before the helper functions:\n\n  ```go\n  Context(\"when a manual approval gate is configured\", func() {\n      const (\n          appName     = \"manual-gate-app\"\n          stageName   = \"manual-gate-stage\"\n          releaseName = \"manual-gate-release\"\n      )\n\n      ctx := context.Background()\n      appKey := types.NamespacedName{Name: appName, Namespace: \"default\"}\n      stageKey := types.NamespacedName{Name: stageName, Namespace: \"default\"}\n      releaseKey := types.NamespacedName{Name: releaseName, Namespace: \"default\"}\n\n      BeforeEach(func() {\n          app := &pipelinesv1alpha1.Application{\n              ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: \"default\"},\n              Spec: pipelinesv1alpha1.ApplicationSpec{\n                  Source: pipelinesv1alpha1.ApplicationSource{Type: \"inline\"},\n                  ApprovalGates: []pipelinesv1alpha1.ApprovalGate{\n                      {Name: \"prod-approval\", Type: pipelinesv1alpha1.ApprovalGateTypeManual, Required: true},\n                  },\n                  Stages: []pipelinesv1alpha1.ApplicationPromotionStage{\n                      {Name: stageName, Ring: 1},\n                  },\n              },\n          }\n          Expect(k8sClient.Create(ctx, app)).To(Succeed())\n\n          stage := &pipelinesv1alpha1.Stage{\n              ObjectMeta: metav1.ObjectMeta{Name: stageName, Namespace: \"default\"},\n              Spec: pipelinesv1alpha1.StageSpec{Name: stageName, Ring: 1, Templates: []string{}},\n          }\n          Expect(k8sClient.Create(ctx, stage)).To(Succeed())\n      })\n\n      AfterEach(func() {\n          By(\"cleaning up the release\")\n          release := &pipelinesv1alpha1.Release{ObjectMeta: metav1.ObjectMeta{Name: releaseName, Namespace: \"default\"}}\n          Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, release))).To(Succeed())\n          By(\"cleaning up the stage\")\n          stage := &pipelinesv1alpha1.Stage{ObjectMeta: metav1.ObjectMeta{Name: stageName, Namespace: \"default\"}}\n          Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, stage))).To(Succeed())\n          By(\"cleaning up the application\")\n          app := &pipelinesv1alpha1.Application{ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: \"default\"}}\n          Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, app))).To(Succeed())\n      })\n\n      It(\"should pause promotion until the gate is approved\", func() {\n          release := &pipelinesv1alpha1.Release{\n              ObjectMeta: metav1.ObjectMeta{\n                  Name:      releaseName,\n                  Namespace: \"default\",\n                  OwnerReferences: []metav1.OwnerReference{{\n                      APIVersion: pipelinesv1alpha1.GroupVersion.String(),\n                      Kind:       \"Application\",\n                      Name:       appName,\n                  }},\n              },\n              Spec: pipelinesv1alpha1.ReleaseSpec{\n                  Target: stageName,\n                  ManifestSource: &pipelinesv1alpha1.ManifestSource{\n                      ConfigMapRef: \"\",\n                  },\n              },\n          }\n          Expect(k8sClient.Create(ctx, release)).To(Succeed())\n\n          controller := &ReleaseReconciler{\n              client:                k8sClient,\n              Scheme:                k8sClient.Scheme(),\n              Namespace:             \"default\",\n              ApprovalGateEvaluator: gates.NewApprovalGateEvaluator(http.DefaultClient),\n          }\n\n          By(\"reconciling the release while the gate is pending\")\n          _, err := controller.Reconcile(ctx, reconcile.Request{NamespacedName: releaseKey})\n          Expect(err).NotTo(HaveOccurred())\n\n          var updated pipelinesv1alpha1.Release\n          Eventually(func() pipelinesv1alpha1.ReleasePhase {\n              Expect(k8sClient.Get(ctx, releaseKey, &updated)).To(Succeed())\n              return updated.Status.Phase\n          }, 5*time.Second, 200*time.Millisecond).Should(Equal(pipelinesv1alpha1.ReleaseAwaitingApproval))\n\n          var app pipelinesv1alpha1.Application\n          Expect(k8sClient.Get(ctx, appKey, &app)).To(Succeed())\n          Expect(app.Status.Gates).To(HaveLen(1))\n          Expect(app.Status.Gates[0].Status).To(Equal(pipelinesv1alpha1.GateStatusPending))\n\n          By(\"approving the gate\")\n          app.Status.Gates[0].Status = pipelinesv1alpha1.GateStatusApproved\n          app.Status.Gates[0].ApprovedBy = \"e2e\"\n          Expect(k8sClient.Status().Update(ctx, &app)).To(Succeed())\n\n          By(\"reconciling the release after approval\")\n          _, err = controller.Reconcile(ctx, reconcile.Request{NamespacedName: releaseKey})\n          Expect(err).NotTo(HaveOccurred())\n\n          Eventually(func() pipelinesv1alpha1.ReleasePhase {\n              Expect(k8sClient.Get(ctx, releaseKey, &updated)).To(Succeed())\n              return updated.Status.Phase\n          }, 5*time.Second, 200*time.Millisecond).Should(Equal(pipelinesv1alpha1.ReleasePromoting))\n      })\n  })\n  ```\n\n  Note: adjust the test if `ManifestSource` is not needed; the important behavior is the phase transition.\n\n- [ ] **Step 2: Commit**\n\n  ```bash\n  git add test/e2e/e2e_test.go\n  git commit -m \"test(approval-gates): add E2E test for manual gate\"\n  ```\n\n### Task 3: Final verification\n\n- [ ] **Step 1: Run the full Go test suite**\n\n  ```bash\n  make test\n  ```\n\n  Expected: all unit and envtest tests pass.\n\n- [ ] **Step 2: Run lint**\n\n  ```bash\n  make lint\n  ```\n\n  Expected: no lint errors.\n\n- [ ] **Step 3: Verify no unrelated changes**\n\n  ```bash\n  git diff --stat\n  ```\n\n  Expected: only the planned files are modified.\n\n---\n\n**Verification:** Run `make test` and `make lint` and report the results. Fix any failures before reporting done. The E2E test only needs to compile (it is guarded by `//go:build e2e`); unit tests must pass."
}
```

<details><summary>Tool Result: Agent (`Implement Approval Gates Chunk 7`)</summary>

<!-- call_id: tool_3N8425tAKsFFUf3i6OMtVqhG -->
agent_id: agent-90
actual_subagent_type: coder
status: completed

[summary]
Chunk 7 is complete.

**What was done:**

1. **Unit tests** (`internal/controller/pipelines/release_controller_unit_test.go`)
   - Added `fakeApprovalEvaluator` helper.
   - Added `TestReleaseReconciler_handlePromotingPhase_awaitsApproval` — verifies a Promoting release moves to `AwaitingApproval` and the Application gate status becomes `Pending`.
   - Added `TestReleaseReconciler_handleAwaitingApprovalPhase_promotesWhenApproved` — verifies an `AwaitingApproval` release moves back to `Promoting` once the gate is approved.
   - Minor plan deviations required for passing tests:
     - Added `Finalizers: []string{releaseFinalizer}` to both releases (the reconciler requires the finalizer before phase handling).
     - Configured the fake evaluator in the approval test to return `Approved` for `manual-gate`, because the provided fake ignores `currentStatus`.

2. **E2E test** (`test/e2e/e2e_test.go`)
   - Added the `Context("when a manual approval gate is configured", ...)` block.
   - Added necessary imports and a package-level `k8sClient client.Client`.
   - Initialized `k8sClient` from in-cluster kubeconfig in `BeforeEach`.
   - Used `pipelines.NewReleaseReconciler(k8sClient)` (the unexported `client` field cannot be set from the `e2e` package).
   - Added finalizer and initial `ReleasePromoting` phase to the release so a single reconcile reaches `AwaitingApproval`.
   - Removed the unused `stageKey` variable.

3. **Verification**
   - New unit tests pass:
     ```bash
     go test ./internal/controller/pipelines/... -run 'TestReleaseReconciler_handlePromotingPhase_awaitsApproval|TestReleaseReconciler_handleAwaitingApprovalPhase_promotesWhenApproved' -v
     ```
   - Full `make test` passes.
   - `make lint` passes with `0 issues`.
   - E2E test compiles:
     ```bash
     go test -tags e2e ./test/e2e/... -run TestE2E -count=1 -c -o /dev/null
     ```
   - `git diff --stat` is empty.

**Commits:**
- `17639b9 test(approval-gates): add release controller gate unit tests`
- `532896b test(approval-gates): add E2E test for manual gate`
- `bf10226 style: apply gofmt to approval gate unit tests`

Note: an untracked `paprika` executable exists at the repo root (a pre-existing build artifact, not produced by these changes); it was left untouched.

</details>

## Turn 4

### User

export

### Assistant

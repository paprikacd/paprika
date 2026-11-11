# Deployment and release competitor analysis

Research snapshot published in the Paprika Space on 11 November 2026. [Source page](https://chatgpt.com/space/page_e4546cbcba148191a29044971c5a57f5). This document preserves that dated analysis and its source links; publication in this catalogue does not imply a new competitor-capability verification.

Paprika’s deployment and release roadmap is best evaluated against three complementary benchmarks: **Argo CD for Kubernetes reconciliation and resource review, Kargo for artifact promotion between environments, and Buildkite for pipeline execution and attempt-level investigation**. Flux, Argo Rollouts, Argo Workflows, GitHub Actions and Octopus Deploy provide additional comparisons for controller contracts, progressive delivery, approval boundaries and reproducible releases.

**Product direction:** make the exact candidate, target-specific intent, authorization, evidence and recovery choice understandable throughout a release. This is a positioning hypothesis to validate through implementation and operator testing. The established products already cover substantial parts of this workflow; Paprika’s opportunity is the coherence and precision of the whole experience.

**Assessment date: 11 November 2026, Australia/Melbourne.** Argo CD references use its stable documentation channel. Kargo’s latest-release redirect resolves to [v1.12.5](https://github.com/akuity/kargo/releases/tag/v1.12.5); individual features below retain their edition qualifications. Buildkite and adjacent products use their current official documentation. Paprika’s source baseline is [17a651ab](https://github.com/paprikacd/paprika/tree/17a651ab8edf20337ac5319af93ae7fb2c389b47). This is a documentation and source comparison, not a measured product benchmark.

# Comparison map

| Product or project | Primary comparison for Paprika | Boundary to preserve |
| --- | --- | --- |
| Argo CD | Desired/live state, resource inspection, synchronization, projects and fleet progression | Keep core reconciliation separate from Argo Rollouts and Argo Workflows. [Argo projects](https://argoproj.github.io/) |
| Kargo | Artifact sets, stage eligibility, promotion procedures and verification | Promotion changes desired state; a deployment agent such as Argo CD reconciles it. [Core concepts](https://docs.kargo.io/user-guide/core-concepts) |
| Buildkite | Dynamic execution graphs, worker queues, retries, artifacts and job investigation | Its control plane is hosted; workers can be customer-managed or hosted. [Architecture](https://buildkite.com/docs/pipelines/architecture) |
| Flux | Reconciliation APIs, dependencies and Helm remediation | Compare the relevant controller; Flagger is a separate progressive-delivery component. [Toolkit](https://fluxcd.io/flux/components/) · [Flagger](https://fluxcd.io/flagger/) |
| Argo Rollouts | Canary/blue-green workload progression and analysis | A workload rollout controller is a different layer from environment promotion. [Argo projects](https://argoproj.github.io/) |
| Argo Workflows | DAG and step execution | Workflow execution is a different contract from accepted deployment state. [Argo projects](https://argoproj.github.io/) |
| GitHub Actions | Environment protection, reviewers and CI-to-deployment handoff | Availability depends on plan and repository visibility. [Environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) |
| Octopus Deploy | Release snapshots and promotion through lifecycle environments | A release snapshot has defined exclusions, including tenant variables. [Releases](https://octopus.com/docs/releases) |

# Paprika baseline and proposed advantage

Paprika already has exact-release promotion, immutable inline artifact validation, target-change re-verification, rollback execution, dependency-aware step retry, sync-window evaluation and ApplicationSet RollingSync. The new backlog concentrates on exposing and extending those owners through review APIs, UI and durable history. [Promotion controller](https://github.com/paprikacd/paprika/blob/17a651ab8edf20337ac5319af93ae7fb2c389b47/internal/controller/pipelines/application_promotion.go) · [Inline artifact validation](https://github.com/paprikacd/paprika/blob/17a651ab8edf20337ac5319af93ae7fb2c389b47/internal/controller/pipelines/application_inline_artifact.go) · [Retry owner](https://github.com/paprikacd/paprika/blob/17a651ab8edf20337ac5319af93ae7fb2c389b47/internal/api/pipeline_handler.go).

| Area | Audited current foundation | Proposed product work |
| --- | --- | --- |
| Candidate promotion | Exact candidate and accepted-deployment contracts exist in controller state. | Project them into the console and bind review/actions to the displayed identity. [#239](https://github.com/paprikacd/paprika/issues/239) |
| Artifact publication | Immutable component and target-manifest validation exists; legacy ApplyBundle protects promotion intent. | Add a purpose-built composition and publication flow. [#240](https://github.com/paprikacd/paprika/issues/240) |
| Recovery | The rollback controller selects an eligible retained snapshot. | Preview and bind the exact restore target, current release and target configuration. [#241](https://github.com/paprikacd/paprika/issues/241) |
| Deployment planning | Target-aware reads/diff and per-resource admission dry-run exist. | Add a non-mutating release-wide plan with explicit check coverage. [#242](https://github.com/paprikacd/paprika/issues/242) |
| Operating clarity | Window and retry engines exist. | Explain interval eligibility, preserved work and stop checks. [#243](https://github.com/paprikacd/paprika/issues/243) · [#244](https://github.com/paprikacd/paprika/issues/244) |
| Shared planning and history | RollingSync exists; history feed contracts currently lack a recorder. | Add read-only version-set review and durable causal execution records. [#245](https://github.com/paprikacd/paprika/issues/245) · [#246](https://github.com/paprikacd/paprika/issues/246) |

These eight issues remain open at this assessment. The [deployment and release backlog](https://chatgpt.com/space/page_c1489ae2ec508191ab0dfa3188240ee0) contains their native specifications and illustrative UI studies. The comparison does not treat those designs as shipped features.

# Argo CD

## Resource review and deployment planning

Argo CD is a strong baseline for reading the relationship between desired and live Kubernetes state. Its Resources view aggregates managed, declared resources across accessible Applications; controller-created descendants such as Pods and ReplicaSets remain accessible through an Application’s resource tree. This distinction is useful for Paprika: a prospective change ledger, a managed-resource inventory and a descendant tree should expose different relationships. [Resources view](https://argo-cd.readthedocs.io/en/stable/user-guide/resources-view/).

Server-Side Diff is stable in Argo CD’s documentation since v3.1.0. It predicts the result of server-side apply through dry-run and can expose admission validation failures during comparison. The documented calculation skips new resources, and mutation-webhook effects require separate configuration. Paprika should make resource/check coverage explicit in [#242](https://github.com/paprikacd/paprika/issues/242), including create versus update and checks that were unavailable. [Diff strategies](https://argo-cd.readthedocs.io/en/stable/user-guide/diff-strategies/).

## Automation windows and recovery

Argo CD configures automatic sync, pruning, self-healing and empty-target protection separately. Its automated-sync documentation also prohibits the rollback operation while automatic sync is enabled. A useful Paprika review therefore needs both the selected recovery snapshot and the effective automation policy that may act afterward. [Automated sync](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/).

Sync windows combine application selectors with allow/deny rules and configured manual overrides. The stable documentation also describes overrun behavior for work already in progress. Paprika’s window inspector should distinguish admission to start from continuation of existing work, while displaying Paprika’s own evaluator semantics. [Sync windows](https://argo-cd.readthedocs.io/en/stable/user-guide/sync_windows/).

Sync phases, waves and hooks encode ordering and lifecycle position. Hooks are omitted during selective sync, so a selected execution mode changes what will actually run. This motivates an explicit execution-mode and hook-capability row in Paprika preflight, and durable hook outcomes in the execution journal. [Phases and waves](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/).

## Fleet progression and authorization

ApplicationSet Progressive Syncs is labeled **Beta since v3.3.0** in the current stable documentation and requires explicit enablement. RollingSync selects groups through labels, constrains updates with maxUpdate and waits for group health. It disables generated-Application autosync and observes sync windows. Applications outside every group are excluded and require manual sync. [Progressive Syncs](https://argo-cd.readthedocs.io/en/stable/operator-manual/applicationset/Progressive-Syncs/).

Paprika’s audited RollingSync processes unmatched Applications last. The familiar name therefore does not establish identical scheduling semantics. [#245](https://github.com/paprikacd/paprika/issues/245) should expose membership, owning ApplicationSet and the actual policy result, including unmatched members. [Paprika ApplicationSet owner](https://github.com/paprikacd/paprika/blob/17a651ab8edf20337ac5319af93ae7fb2c389b47/internal/controller/pipelines/applicationset_controller.go).

Argo CD AppProjects constrain source repositories, destination clusters/namespaces and resource kinds, with project roles for scoped permissions. Those dimensions belong in deployment review context: an operator should be able to see whether the intended target is allowed and which action the current identity can perform. [Projects](https://argo-cd.readthedocs.io/en/stable/user-guide/projects/).

**Design implication:** use Argo CD as a benchmark for resource navigation, diff depth and controller transparency. Evaluate Paprika on whether an operator can carry one exact candidate and target identity through preflight, approval, execution and recovery without reconstructing the context.

# Kargo

## Artifact and stage model

Kargo explicitly represents the artifacts moving through delivery. Warehouses discover versions, Freight groups artifact references, Stages define promotion targets and Projects organize the system. Its model separates changing a stage’s desired state from the deployment agent’s subsequent reconciliation. [Core concepts](https://docs.kargo.io/user-guide/core-concepts).

Freight can combine image, Git and chart references. Kargo derives its resource name from a canonical representation of those references and provides a friendlier mutable alias for display. This is a useful identity pattern; it is not itself proof of signature verification. Paprika’s composer should likewise show a friendly version beside exact component digests, source revision and target-manifest identity. [Working with Freight](https://docs.kargo.io/user-guide/how-to-guides/working-with-freight).

Stage eligibility can depend on upstream verification, with OneOf/All policies for named upstream stages. Automatic selection operates per requested artifact origin and can select the newest eligible Freight or follow a sole upstream stage. Paprika’s candidate view should distinguish the newest discovered version, the version selected by policy and the version eligible for the requested target. [Working with Stages](https://docs.kargo.io/user-guide/how-to-guides/working-with-stages).

## Procedures and verification

Promotion Templates assemble steps; PromotionTask and ClusterPromotionTask provide reusable parameterized procedures. Kargo expands task steps into a Promotion at creation. That distinction between reusable definition and concrete execution is useful for Paprika’s attempt history and any future procedure authoring. [Templates](https://docs.kargo.io/user-guide/reference-docs/promotion-templates) · [Tasks](https://docs.kargo.io/user-guide/reference-docs/promotion-tasks).

Kargo’s optional verification uses Argo Rollouts analysis resources after a successful promotion. A successful analysis can make Freight eligible downstream, while incomplete verification prevents another queued promotion to that Stage from running. The UI exposes verification attempts separately. Paprika should retain the same conceptual separation among promotion execution, workload health and verification evidence. [Verification](https://docs.kargo.io/user-guide/how-to-guides/verification).

Kargo’s Argo CD integration can change an Application and request sync, with an authorized-stage annotation identifying which stages may act. This supports an owner-aware Paprika plan: target readiness and authority must be tied to the real execution owner, rather than inferred from transport connectivity. [Argo CD integration](https://docs.kargo.io/user-guide/how-to-guides/argo-cd-integration).

## Approval edition and recovery distinctions

| Capability | Documented scope | Paprika consequence |
| --- | --- | --- |
| Manual Freight approval | Grants a Freight eligibility for a specified Stage and can bypass upstream verification; it does not itself start a Promotion. [Freight approval](https://docs.kargo.io/user-guide/how-to-guides/working-with-freight) | Name eligibility bypass and execution approval separately. |
| wait-for-approval step | Akuity Platform v1.12+; pauses a running Promotion for distinct human responses and retains the decision trail. [Approval step](https://docs.kargo.io/user-guide/reference-docs/promotion-steps/wait-for-approval) | Show the exact subject, authority and outcome of a human gate; link [#235](https://github.com/paprikacd/paprika/issues/235) receipts. |
| Promotion windows | Enterprise v1.12+; OSS accepts the compatible field without enforcing its schedule. [Windows](https://docs.kargo.io/user-guide/how-to-guides/promotion-windows) | Record edition explicitly in comparisons and use Paprika’s actual evaluator behavior. |
| Automatic rollback | Identified as an Enterprise-only field in the window documentation. [Edition boundary](https://docs.kargo.io/user-guide/how-to-guides/promotion-windows) | Compare a named edition; a generic Kargo checkmark is insufficient. |

Enterprise windows reject new Promotions when closed; running Promotions continue, while admitted but still-pending Promotions can be removed when the window closes. This illustrates why a window UI must distinguish admission, pending work and in-flight work. [Window execution semantics](https://docs.kargo.io/user-guide/how-to-guides/promotion-windows).

A successful user promotion of non-candidate Freight establishes an origin-specific automatic-promotion hold. Promoting the current automatic candidate releases that hold; failed Promotions do neither. Paprika’s rollback design should explicitly state what later automation will do after the requested restore. [Stage hold semantics](https://docs.kargo.io/user-guide/how-to-guides/working-with-stages).

**Design implication:** Kargo is the closest comparator for [#239](https://github.com/paprikacd/paprika/issues/239) and [#240](https://github.com/paprikacd/paprika/issues/240). Study its artifact-to-stage continuity, eligibility explanations and attempt inspection. Paprika’s proposed distinction is a target-bound review that carries accepted deployment configuration, immutable component mappings and recovery context through its own controllers.

# Buildkite

## Execution architecture and effective plans

Buildkite coordinates pipelines through a hosted control plane. Jobs execute on either customer-managed agents or Buildkite-hosted infrastructure; using self-hosted workers does not make the control plane self-hosted. Its documented Argo CD integration treats CI and Kubernetes reconciliation as complementary responsibilities. [Architecture](https://buildkite.com/docs/pipelines/architecture) · [Argo CD handoff](https://buildkite.com/docs/pipelines/deployments/with-argo-cd).

Dynamic pipelines can upload generated YAML or JSON steps into a running build. For Paprika, the relevant lesson is to preserve the effective execution graph and its inputs with an attempt. A retry plan should use what the engine actually executed, not reconstruct a graph from a newer template. [Dynamic pipelines](https://buildkite.com/docs/pipelines/configure/dynamic-pipelines).

## Human waits concurrency and retries

| Mechanism | Documented behavior | Review lesson |
| --- | --- | --- |
| Block step | Pauses progress with implicit dependencies; explicit depends_on relationships can change the dependency behavior. Team restrictions are supported. [Block step](https://buildkite.com/docs/pipelines/configure/step-types/block-step) | Show which downstream work a human gate controls. |
| Input step | Collects information and prevents build completion without automatically blocking unrelated steps. [Input step](https://buildkite.com/docs/pipelines/configure/step-types/input-step) | Data entry and authorization should have different language. |
| Concurrency group | Coordinates shared-resource access across pipelines. Retries retain the original scheduling timestamp but release the concurrency slot between attempts, so other work may run before the retry. [Concurrency](https://buildkite.com/docs/pipelines/configure/workflows/controlling-concurrency) | Window eligibility and readiness do not reserve execution capacity. |
| Retry | Creates a new job while retaining prior immutable attempt history; policies can disable manual retry and explain the reason. [Retry](https://buildkite.com/docs/pipelines/configure/retry) | Keep old results, fresh identity and an explicit scope of work in [#244](https://github.com/paprikacd/paprika/issues/244). |

Paprika’s retry engine already preserves successful prerequisites and resets affected descendants. Its UI should make those semantics inspectable: affected steps, preserved results, prior Job termination, action authorization and the identity assigned after acceptance. Buildkite is a useful benchmark for presenting lineage; Paprika must keep its own retry rules authoritative. [Paprika retry owner](https://github.com/paprikacd/paprika/blob/17a651ab8edf20337ac5319af93ae7fb2c389b47/internal/api/pipeline_handler.go).

## Artifact provenance and investigation

Buildkite artifacts retain originating build details and integrity metadata, and can use managed or customer storage. Selecting artifacts from earlier retried jobs is explicit. A Paprika artifact handoff should therefore retain producer/run/job/attempt identity with the exact output digest. [Artifacts](https://buildkite.com/docs/pipelines/configure/artifacts).

The documented SLSA-generation workflow combines Buildkite Pipelines with Package Registries. It is an Enterprise capability and excludes OCI-based packages, including Docker OCI and Helm OCI. Paprika should only display provenance claims for evidence that applies to the exact artifact ecosystem and digest. [SLSA provenance](https://buildkite.com/docs/package-registries/security/slsa-provenance).

Queue metrics distinguish jobs waiting for user input or dependencies from runnable jobs awaiting agents, startup and execution. Dispatch wait begins when work becomes runnable; freshness and missing data are explicit. That is a useful model for Paprika’s waiting reasons: approval, policy window, dependency, previous execution cleanup, target access and capacity should each have their own clock and owner. [Queue metrics](https://buildkite.com/docs/pipelines/insights/queue-metrics).

Buildkite’s waterfall covers finished steps and omits wait, block and input steps. Canceled, timed-out, expired and skipped jobs produce blank rows; passed and failed execution retains its timing bars. A Paprika release journal should represent those human and policy waits explicitly alongside resource application and health events, so elapsed release time can be explained without inferring missing history. [Waterfall](https://buildkite.com/docs/pipelines/insights/waterfall).

**Design implication:** use Buildkite to benchmark attempt lineage, execution investigation and CI handoff. [#246](https://github.com/paprikacd/paprika/issues/246) should connect those external events to Paprika’s candidate, target and outcome rather than reducing a release to a successful CI build.

# Adjacent products

## Flux and progressive delivery controllers

Flux’s toolkit separates source, Kustomize, Helm, notification and image-automation responsibilities into controllers. Kustomization dependencies can use CEL readiness expressions to verify matching version conditions; a custom expression replaces built-in readiness unless the additive feature gate is enabled. This is a useful reference for the distinction between a declared dependency, a version constraint and observed readiness in [#245](https://github.com/paprikacd/paprika/issues/245). [Toolkit](https://fluxcd.io/flux/components/) · [Kustomization dependencies](https://fluxcd.io/flux/components/kustomize/kustomizations/).

Flux HelmRelease supports operation-specific remediation, including rollback or uninstall between configured retries, and separately configured drift detection. Paprika’s journal should retain install/upgrade, test, health and remediation outcomes as separate facts. [HelmRelease](https://fluxcd.io/flux/components/helm/helmreleases/).

Argo Rollouts and Flagger are additional references for metric-driven progressive delivery. Argo Workflows is a reference for step and DAG execution. Evaluate those projects as separate components, then describe the integration needed to connect their outputs to a release review. [Argo projects](https://argoproj.github.io/) · [Flagger](https://fluxcd.io/flagger/).

## GitHub Actions and Octopus Deploy

GitHub environments support reviewers, optional prevention of self-review, wait timers, branch/tag restrictions and custom deployment protection rules, with plan and repository-visibility restrictions. A CI environment approval can become linked evidence in Paprika; it should not silently authorize a different candidate or target. [Deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

Octopus defines a release as a snapshot of a deployment process and associated scripts, package references and variables, promoted through lifecycle environments. Tenant variables are excluded from that snapshot. The lesson for Paprika is to identify precisely what is pinned and what is resolved per target or at execution time. [Releases](https://octopus.com/docs/releases) · [Lifecycles](https://octopus.com/docs/best-practices/deployments/lifecycles-and-environments).

# Implications for the existing backlog

| Backlog item | Product lesson | Companion image and concrete validation question |
| --- | --- | --- |
| [#239](https://github.com/paprikacd/paprika/issues/239) Promotion workbench | Kargo’s candidate eligibility and Argo CD’s distinct reconciliation states support explicit identity and readiness. | Expired review after cfg-042 → cfg-043. Can the operator tell what changed and why the old approval no longer applies? |
| [#240](https://github.com/paprikacd/paprika/issues/240) Artifact composer | Kargo artifact sets and Buildkite producer lineage support immutable component mappings. | Mutable-tag binding error. Can the operator identify the precise container reference to repair? |
| [#241](https://github.com/paprikacd/paprika/issues/241) Rollback plan | Argo CD rollback/automation interaction and Kargo hold semantics make post-recovery intent important. | Current rel-281 replaced by rel-282. Does the preview invalidate without substituting a restore target? |
| [#242](https://github.com/paprikacd/paprika/issues/242) Deployment preflight | Argo CD’s diff coverage and actual target capabilities require a typed coverage model. | Missing target namespace. Are unchecked admission and ownership visibly different from passed checks? |
| [#243](https://github.com/paprikacd/paprika/issues/243) Window inspector | Time policy needs scope, edition and execution-phase semantics. | Narrow screen agenda. Can the operator explain why the next interval begins at 15:15 rather than 14:45? |
| [#244](https://github.com/paprikacd/paprika/issues/244) Retry preview | Buildkite attempt lineage supports preserved versus rerun work and explicit next execution identity. | Completed stop checks. Is the review enabled without claiming a retry has already started? |
| [#245](https://github.com/paprikacd/paprika/issues/245) Release-train plan | Kargo artifact identity, Flux dependency constraints and ApplicationSet ownership are separate inputs. | One changed candidate. Can a new review be prepared while the original pins remain inspectable? |
| [#246](https://github.com/paprikacd/paprika/issues/246) Execution journal | Buildkite execution history and controller evidence should form a causal record. | Apply succeeded, then health failed. Can both facts remain visible without presenting deployment success? |

These are refinements and validation scenarios for the existing eight issues. The [release backlog](https://chatgpt.com/space/page_c1489ae2ec508191ab0dfa3188240ee0) retains the complete acceptance criteria and image-to-issue mapping; [#235](https://github.com/paprikacd/paprika/issues/235) remains the owner of typed gate decision receipts, and [#236](https://github.com/paprikacd/paprika/issues/236) remains the owner of drift collection.

# Proposed integration boundary

An integration with existing CI should preserve each system’s authority. The following is a proposed contract for Paprika with a provider such as Buildkite, GitHub Actions or Cuttlefish; it does not imply a connector is already implemented.

| Owner | Responsibility |
| --- | --- |
| CI provider and worker platform | Source checkout, worker placement, build/test execution, artifact production and attempt logs. |
| Paprika | Candidate identity, target-specific intent, promotion authority, deployment/health evaluation and recovery review. |
| Shared evidence contract | Provider, repository, commit, run, job and attempt IDs; immutable output digests; occurrence/recording timestamps; terminal result; authorized links to retained evidence. |

Start with a read-only evidence handoff into [#240](https://github.com/paprikacd/paprika/issues/240) and [#246](https://github.com/paprikacd/paprika/issues/246). An external CI pass should be a named input, not an implicit grant to deploy. Retain the external job reference if logs expire, and make the expiry visible. Preserve source revision and produced bytes as distinct identities.

# Evaluation protocol

Use the same synthetic checkout application and failure cases across prototype evaluations. Record the exact product version, enabled features, edition and target setup. The scenarios below define future comparisons; they are not reported benchmark results.

| Scenario | Evidence to record | Paprika issue |
| --- | --- | --- |
| Candidate replaced after review | Which identity stays visible; whether approval is invalidated; operator steps to recover. | [#239](https://github.com/paprikacd/paprika/issues/239) |
| Target configuration changes | Evidence binding, re-verification reason and accepted deployment continuity. | [#239](https://github.com/paprikacd/paprika/issues/239) |
| Mutable image tag conflicts with declared digest | Exact repair location and whether publication can proceed. | [#240](https://github.com/paprikacd/paprika/issues/240) |
| Selected rollback snapshot disappears | Preview invalidation and absence of silent fallback. | [#241](https://github.com/paprikacd/paprika/issues/241) |
| Desired resource does not yet exist | Admission coverage, create/update distinction and unknown results. | [#242](https://github.com/paprikacd/paprika/issues/242) |
| Remote target is unreachable or unauthorized | Which checks remain available, target identity and actionable blocker. | [#242](https://github.com/paprikacd/paprika/issues/242) |
| Overlapping windows and DST transition | Local/UTC instants, combined eligibility and start/continue behavior. | [#243](https://github.com/paprikacd/paprika/issues/243) |
| Failed step has successful prerequisites and an old Job deleting | Preserved work, reset set, stop evidence and action availability. | [#244](https://github.com/paprikacd/paprika/issues/244) |
| Application is unmatched by a fleet group | Owning controller, membership and actual scheduling result. | [#245](https://github.com/paprikacd/paprika/issues/245) |
| Apply completes but health later fails and logs expire | Separate event outcomes, causal linkage, evidence retention and gaps. | [#246](https://github.com/paprikacd/paprika/issues/246) |

Measure task completion, time to identify the exact blocker, incorrect assumptions about authority or success, and the number of context changes needed to reach the supporting evidence. Keep product-specific policy differences visible rather than forcing identical outcomes.

# Research follow ups

Continue with a hands-on comparison of the highest-priority three workflows: candidate review, target preflight and rollback preview. Extend the product set with Harness, Spinnaker and Tekton only around a concrete unanswered workflow. A later deployment-cost comparison should specify worker topology, retention, scale, hosting responsibility and commercial plan before comparing prices.

[Paprika knowledge base](https://chatgpt.com/space/page_6ae45780924881918c18270064f72c2c) · [Deployment and release feature backlog](https://chatgpt.com/space/page_c1489ae2ec508191ab0dfa3188240ee0) · [Shared art direction](https://chatgpt.com/space/page_956c0483705c8191a694894abf25e041).

"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createPromiseClient } from "@connectrpc/connect";
import { createTransport } from "@/lib/transport";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  LayoutGrid,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  XCircle,
  Boxes,
  Stethoscope,
  Layers,
  Network,
  List,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  ResourceListTable,
  type FlatTreeNode as ResourceTableNode,
  mergeResourcesFromApplication,
  type MergedResource,
} from "@/components/dashboard/resource-list-table";
import { ResourceDetailPanel } from "@/components/dashboard/resource-detail-panel";
import { ResourceGraph, type ResourceGraphNode } from "@/components/dashboard/resource-graph";
import { InvestigationTriage } from "@/components/dashboard/investigation-triage";
import { SyncDiffWorkbench } from "@/components/dashboard/sync-diff-workbench";
import { ApplicationReleaseHistory } from "@/components/dashboard/application-release-history";
import { useConnection } from "@/lib/connection-context";
import { useFocusedRefresh } from "@/lib/fleet-refresh";

import { PaprikaService } from "@/gen/paprika/v1/api_connect";
import type { Application, InvestigateResponse, Release } from "@/gen/paprika/v1/api_pb";

const transport = createTransport();
const client = createPromiseClient(PaprikaService, transport);

function SkeletonCard() {
  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex items-start justify-between">
          <div className="space-y-2">
            <div className="h-4 w-32 rounded bg-muted animate-pulse" />
            <div className="h-3 w-24 rounded bg-muted animate-pulse" />
          </div>
          <div className="h-5 w-20 rounded-full bg-muted animate-pulse" />
        </div>
        <div className="h-1.5 rounded-full bg-muted animate-pulse" />
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="size-3.5 rounded-full bg-muted animate-pulse" />
              <div className="h-3 flex-1 rounded bg-muted animate-pulse" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function PolicySeverityBadge({ severity }: { severity: string }) {
  const variant =
    severity === "critical"
      ? "destructive"
      : severity === "warning"
      ? "default"
      : "secondary";
  return <Badge variant={variant}>{severity}</Badge>;
}

function HealthCheckBadge({ status }: { status: string }) {
  const config: Record<string, { variant: "default" | "destructive" | "secondary"; color: string }> = {
    Healthy: { variant: "default", color: "text-emerald-500" },
    Degraded: { variant: "destructive", color: "text-destructive" },
    Progressing: { variant: "secondary", color: "text-amber-500" },
    Unknown: { variant: "secondary", color: "text-muted-foreground" },
  }
  const c = config[status] ?? config.Unknown
  return <Badge variant={c.variant}>{status}</Badge>
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{children}</span>
    </div>
  );
}

function formatDate(ts?: bigint): string {
  if (ts === undefined || ts === null) return "-";
  return new Date(Number(ts) * 1000).toLocaleString();
}

function ApplicationDetail() {
  const searchParams = useSearchParams();
  const namespace = searchParams.get("namespace") ?? "";
  const name = searchParams.get("name") ?? "";

  const [application, setApplication] = useState<Application | null>(null);
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [actingGate, setActingGate] = useState<string | null>(null);
  const [selectedResource, setSelectedResource] = useState<MergedResource | null>(null);
  const [viewMode, setViewMode] = useState<"graph" | "list">("graph");
  const [treeNodes, setTreeNodes] = useState<ResourceGraphNode[]>([]);
  const [detailedTreeNodes, setDetailedTreeNodes] = useState<ResourceTableNode[]>([]);
  const { reportRequestOutcome } = useConnection();

  const fetchData = useCallback(async () => {
    if (!namespace || !name) return;
    setLoading(true);
    setError(null);
    try {
      const [appRes, relRes] = await Promise.all([
        client.getApplication({ namespace, name }),
        client.listReleases({ namespace, applicationName: name }),
      ]);
      setApplication(appRes.application ?? null);
      setReleases(relRes.releases ?? []);
    } catch (err) {
      setError("Failed to load application details");
      console.error(err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [namespace, name]);

  useFocusedRefresh(fetchData, {
    enabled: Boolean(namespace && name),
    onRequestOutcome: reportRequestOutcome,
  });

  // Fetch resource tree when application is loaded.
  useEffect(() => {
    if (!namespace || !name) return;
    client.getResourceTree({ namespace, name }).then((res) => {
      setTreeNodes(res.nodes as unknown as ResourceGraphNode[])
    }).catch(() => {
      console.warn("getResourceTree failed - resource graph will fall back to flat list")
    })
    client.getResourceTreeDetailed({ applicationNamespace: namespace, applicationName: name }).then((res) => {
      setDetailedTreeNodes(res.nodes as unknown as ResourceTableNode[])
    }).catch(() => {
      console.warn("getResourceTreeDetailed failed - list view will fall back to merged resources")
    })
  }, [namespace, name, application?.phase, application?.outOfSync]);

  const filteredReleases = useMemo(
    () =>
      releases
        .filter((r) => r.application === name && r.namespace === namespace)
        .sort((a, b) => Number(b.createdAt) - Number(a.createdAt)),
    [releases, namespace, name],
  );

  const currentRelease = useMemo(() => {
    if (!application?.releaseRef) return null;
    return (
      filteredReleases.find(
        (r) => r.name === application.releaseRef && r.namespace === application.namespace,
      ) ?? null
    );
  }, [application, filteredReleases]);

  const handleRollback = useCallback(
    async (release: Release) => {
      setRollingBack(release.name);
      try {
        await client.rollbackRelease({
          namespace: release.namespace,
          name: release.name,
        });
        setTimeout(() => void fetchData().catch(() => {}), 1500);
      } catch (err) {
        setError(`Rollback failed for ${release.name}`);
        console.error(err);
      } finally {
        setRollingBack(null);
      }
    },
    [fetchData],
  );

  const handleGateAction = useCallback(
    async (gateName: string, action: "approve" | "reject") => {
      if (!application) return;
      setActingGate(gateName);
      try {
        if (action === "approve") {
          await client.approveGate({ namespace, name, gate: gateName });
        } else {
          await client.rejectGate({ namespace, name, gate: gateName });
        }
        await fetchData();
      } catch (err) {
        setError(`${action === "approve" ? "Approval" : "Rejection"} failed for ${gateName}`);
        console.error(err);
      } finally {
        setActingGate(null);
      }
    },
    [application, namespace, name, fetchData],
  );

  const handleInvestigateResource = useCallback(
    async (resource: MergedResource): Promise<InvestigateResponse> => {
      return client.investigate({
        applicationNamespace: namespace,
        applicationName: name,
        resourceKind: resource.kind,
        resourceName: resource.name,
        resourceNamespace: resource.namespace,
      });
    },
    [namespace, name],
  );

  const pageTitle = application?.name ?? name;
  const pageNamespace = application?.namespace ?? namespace;

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-6 py-8">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link
          href="/dashboard"
          className="flex items-center gap-1 hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Dashboard
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground">{pageTitle}</span>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{pageTitle}</h1>
          <p className="text-muted-foreground">{pageNamespace}</p>
        </div>
        <Button
          variant="outline"
          onClick={() => void fetchData().catch(() => {})}
          disabled={loading}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && !application ? (
        <div className="space-y-4">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : !application ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Application not found.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Current Phase</CardDescription>
                <CardTitle className="text-lg">
                  <StatusBadge status={application.phase} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">
                  Strategy: {application.strategy || "-"}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Current Release</CardDescription>
                <CardTitle className="text-lg truncate">
                  {currentRelease ? currentRelease.name : "-"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground truncate">
                  {currentRelease?.target || "No active release"}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Policy Results</CardDescription>
                <CardTitle className="text-lg">
                  {currentRelease?.policyResults?.length ?? 0}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">
                  {currentRelease?.policyResults?.some((p) => !p.passed)
                    ? "Failures present"
                    : currentRelease?.policyResults?.length
                    ? "All passed"
                    : "No policies evaluated"}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Release History</CardDescription>
                <CardTitle className="text-lg">{filteredReleases.length}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">
                  Releases tracked for this application
                </p>
              </CardContent>
            </Card>
          </div>

          <InvestigationTriage
            application={application}
            investigate={handleInvestigateResource}
            onSelectResource={setSelectedResource}
          />

          <SyncDiffWorkbench
            application={application}
            onSelectResource={setSelectedResource}
          />

          {/* Managed Resources */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Boxes className="h-5 w-5" />
                    Managed Resources
                  </CardTitle>
                  <CardDescription>
                    {(application.resources?.length ?? 0)} resource{application.resources?.length === 1 ? "" : "s"} ·{" "}
                    <span className="tabular-nums">{application.outOfSync}</span> out of sync ·{" "}
                    <span className="tabular-nums">{application.prunedResources}</span> pruned
                  </CardDescription>
                </div>
                  <div className="flex items-center gap-1 rounded-lg bg-muted/40 p-0.5 ring-1 ring-foreground/5">
                    <button
                      onClick={() => setViewMode("graph")}
                      className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-[color,background-color] ${
                        viewMode === "graph" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Network className="size-3.5" />
                      Graph
                    </button>
                    <button
                      onClick={() => setViewMode("list")}
                      className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-[color,background-color] ${
                        viewMode === "list" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <List className="size-3.5" />
                      List
                    </button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {viewMode === "graph" ? (
                  <ResourceGraph
                    nodes={
                      treeNodes.length > 0
                        ? treeNodes
                        : mergeResourcesFromApplication(application).map((r) => ({
                            kind: r.kind,
                            name: r.name,
                            namespace: r.namespace,
                            syncStatus: r.syncStatus,
                            health: r.health,
                            healthMessage: r.healthMessage,
                            parentKind: "",
                            parentName: "",
                            uid: "",
                            managed: true,
                          }))
                    }
                    onSelectNode={(n) =>
                      setSelectedResource({
                        kind: n.kind,
                        name: n.name,
                        namespace: n.namespace,
                        syncStatus: n.syncStatus,
                        health: n.health,
                        healthMessage: n.healthMessage,
                      })
                    }
                  />
                ) : (
                  <ResourceListTable
                    nodes={
                      detailedTreeNodes.length > 0
                        ? detailedTreeNodes
                        : mergeResourcesFromApplication(application).map((r) => ({
                            kind: r.kind,
                            name: r.name,
                            namespace: r.namespace,
                            syncStatus: r.syncStatus,
                            health: r.health,
                            healthMessage: r.healthMessage,
                            managed: true,
                          }))
                    }
                    onSelect={(n) =>
                      setSelectedResource({
                        kind: n.kind,
                        name: n.name,
                        namespace: n.namespace,
                        syncStatus: n.syncStatus,
                        health: n.health,
                        healthMessage: n.healthMessage,
                      })
                    }
                  />
                )}
              </CardContent>
            </Card>

          {/* Health Checks */}
          {application.healthChecks && application.healthChecks.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Stethoscope className="h-5 w-5" />
                  Health Checks
                </CardTitle>
                <CardDescription>CEL-based health check results.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>HTTP</TableHead>
                      <TableHead>Message</TableHead>
                      <TableHead>Checked</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {application.healthChecks.map((check) => (
                      <TableRow key={check.name}>
                        <TableCell className="font-mono text-xs font-medium">{check.name}</TableCell>
                        <TableCell>
                          <HealthCheckBadge status={check.status} />
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {check.httpStatusCode > 0 ? check.httpStatusCode : "-"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{check.message || "-"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground tabular-nums">
                          {formatDate(check.checkedAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* Stages */}
          {application.stages && application.stages.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Layers className="h-5 w-5" />
                  Promotion Stages
                </CardTitle>
                <CardDescription>Per-stage ring, release, and phase breakdown.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {application.stages.map((stage) => (
                    <div
                      key={stage.name}
                      className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 ring-1 ring-foreground/5"
                    >
                      <span className="flex size-5 items-center justify-center rounded-full bg-background text-[10px] font-bold ring-1 ring-border tabular-nums">
                        {stage.ring}
                      </span>
                      <div>
                        <span className="font-mono text-xs font-medium">{stage.name}</span>
                        <div className="flex items-center gap-2 mt-0.5">
                          <StatusBadge status={stage.phase} />
                          {stage.release && (
                            <span className="text-[10px] text-muted-foreground">{stage.release}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {application.gates && application.gates.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldAlert className="h-5 w-5" />
                  Approval Gates
                </CardTitle>
                <CardDescription>Gates that must pass before promotion continues.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Stage</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Message</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {application.gates.map((gate) => (
                      <TableRow key={gate.name}>
                        <TableCell className="font-medium">{gate.name}</TableCell>
                        <TableCell>{gate.stage || "-"}</TableCell>
                        <TableCell>{gate.type || "-"}</TableCell>
                        <TableCell>
                          <StatusBadge status={gate.status} />
                        </TableCell>
                        <TableCell className="text-muted-foreground">{gate.message || "-"}</TableCell>
                        <TableCell className="text-right">
                          {gate.status === "Pending" && (
                            <div className="flex justify-end gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleGateAction(gate.name, "approve")}
                                disabled={actingGate === gate.name}
                              >
                                Approve
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleGateAction(gate.name, "reject")}
                                disabled={actingGate === gate.name}
                              >
                                Reject
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          <ApplicationReleaseHistory
            releases={filteredReleases}
            rollingBack={rollingBack}
            onRollback={handleRollback}
          />

          {currentRelease && currentRelease.policyResults.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5" />
                  Current Policy Results
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Policy</TableHead>
                      <TableHead>Result</TableHead>
                      <TableHead>Severity</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Message</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {currentRelease.policyResults.map((result, idx) => (
                      <TableRow key={idx}>
                        <TableCell className="font-medium">{result.name}</TableCell>
                        <TableCell>
                          <Badge variant={result.passed ? "default" : "destructive"}>
                            {result.passed ? "pass" : "fail"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <PolicySeverityBadge severity={result.severity} />
                        </TableCell>
                        <TableCell className="font-mono text-xs">{result.action}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {result.message || "-"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <LayoutGrid className="h-5 w-5" />
                Source
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DetailRow label="Repository URL">
                {application.source?.repoUrl ?? "-"}
              </DetailRow>
              <Separator />
              <DetailRow label="Path">{application.source?.path ?? "-"}</DetailRow>
              <Separator />
              <DetailRow label="Revision">
                {application.source?.revision ?? application.revision ?? "-"}
              </DetailRow>
              <Separator />
              <DetailRow label="Sync Policy">
                {application.syncPolicy || "Disabled"}
              </DetailRow>
              <Separator />
              <DetailRow label="Strategy">{application.strategy || "-"}</DetailRow>
            </CardContent>
          </Card>

          {application.conditions && application.conditions.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-5 w-5" />
                  Conditions
                </CardTitle>
              </CardHeader>
              <CardContent>
                {application.conditions.map((cond, idx) => (
                  <div key={cond.type}>
                    {idx > 0 && <Separator />}
                    <div className="flex items-center justify-between py-2">
                      <span className="text-sm text-muted-foreground">{cond.type}</span>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={cond.status === "True" ? "default" : "destructive"}
                          className="text-xs"
                        >
                          {cond.status}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{cond.reason}</span>
                      </div>
                    </div>
                    {cond.message && (
                      <p className="pb-2 text-xs text-muted-foreground">{cond.message}</p>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <AnalysisResultsCard results={application.analysisResults} />
        </>
      )}

      {selectedResource && application && (
        <ResourceDetailPanel
          applicationNamespace={application.namespace}
          applicationName={application.name}
          resource={selectedResource}
          onClose={() => setSelectedResource(null)}
        />
      )}
    </div>
  );
}

function AnalysisResultsCard({ results }: { results?: Application["analysisResults"] }) {
  if (!results || results.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5" />
          Analysis Results
        </CardTitle>
        <CardDescription>Continuous analysis checks for this application.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Template</TableHead>
              <TableHead>Phase</TableHead>
              <TableHead>Passed</TableHead>
              <TableHead>Message</TableHead>
              <TableHead>Checked</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((result, idx) => (
              <TableRow key={idx}>
                <TableCell className="font-medium">{result.name}</TableCell>
                <TableCell><StatusBadge status={result.phase} /></TableCell>
                <TableCell>{result.passed ? <CheckCircle2 className="size-4 text-emerald-500" /> : <XCircle className="size-4 text-destructive" />}</TableCell>
                <TableCell className="text-muted-foreground">{result.message || "-"}</TableCell>
                <TableCell className="text-muted-foreground">{result.checkedAt || "-"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export default function ApplicationDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-7xl space-y-8 px-6 py-8">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      }
    >
      <ApplicationDetail />
    </Suspense>
  );
}

"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createPromiseClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import {
  Activity,
  ArrowLeft,
  ChevronRight,
  History,
  LayoutGrid,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
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

import { PaprikaService } from "@/gen/paprika/v1/api_connect";
import type { Application, Release } from "@/gen/paprika/v1/api_pb";

const transport = createConnectTransport({ baseUrl: "" });
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

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{children}</span>
    </div>
  );
}

function formatDate(ts?: bigint): string {
  if (ts === undefined || ts === null) return "—";
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

  const fetchData = useCallback(async () => {
    if (!namespace || !name) return;
    setLoading(true);
    setError(null);
    try {
      const [appRes, relRes] = await Promise.all([
        client.getApplication({ namespace, name }),
        client.listReleases({}),
      ]);
      setApplication(appRes.application ?? null);
      setReleases(relRes.releases ?? []);
    } catch (err) {
      setError("Failed to load application details");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [namespace, name]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData();
  }, [fetchData]);

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
        setTimeout(fetchData, 1500);
      } catch (err) {
        setError(`Rollback failed for ${release.name}`);
        console.error(err);
      } finally {
        setRollingBack(null);
      }
    },
    [fetchData],
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
        <Button variant="outline" onClick={fetchData} disabled={loading}>
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
                  Strategy: {application.strategy || "—"}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Current Release</CardDescription>
                <CardTitle className="text-lg truncate">
                  {currentRelease ? currentRelease.name : "—"}
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

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <History className="h-5 w-5" />
                Release History
              </CardTitle>
              <CardDescription>
                Prior releases and rollbacks for this application.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {filteredReleases.length === 0 ? (
                <p className="text-sm text-muted-foreground">No releases found.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Phase</TableHead>
                      <TableHead>Pipeline</TableHead>
                      <TableHead>Target</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Policies</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredReleases.map((release) => (
                      <TableRow key={release.name}>
                        <TableCell className="font-medium">
                          <div className="flex flex-col">
                            <span>{release.name}</span>
                            {release.rolledBackTo && (
                              <span className="text-xs text-muted-foreground">
                                rolled back to {release.rolledBackTo}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={release.phase} />
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {release.pipeline || "—"}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {release.target || "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDate(release.createdAt)}
                        </TableCell>
                        <TableCell>
                          {release.policyResults && release.policyResults.length > 0 ? (
                            <div className="flex items-center gap-1">
                              {release.policyResults.some((p) => !p.passed) ? (
                                <ShieldAlert className="h-4 w-4 text-red-500" />
                              ) : (
                                <ShieldCheck className="h-4 w-4 text-green-500" />
                              )}
                              <span className="text-xs">
                                {release.policyResults.filter((p) => p.passed).length} /{" "}
                                {release.policyResults.length}
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRollback(release)}
                            disabled={
                              rollingBack === release.name || release.phase === "RolledBack"
                            }
                          >
                            <RotateCcw className="mr-1 h-4 w-4" />
                            Rollback
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

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
                          {result.message || "—"}
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
                {application.source?.repoUrl ?? "—"}
              </DetailRow>
              <Separator />
              <DetailRow label="Path">{application.source?.path ?? "—"}</DetailRow>
              <Separator />
              <DetailRow label="Revision">
                {application.source?.revision ?? application.revision ?? "—"}
              </DetailRow>
              <Separator />
              <DetailRow label="Sync Policy">
                {application.syncPolicy || "Disabled"}
              </DetailRow>
              <Separator />
              <DetailRow label="Strategy">{application.strategy || "—"}</DetailRow>
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
        </>
      )}
    </div>
  );
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

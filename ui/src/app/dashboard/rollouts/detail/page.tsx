"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createPromiseClient } from "@connectrpc/connect";
import { createTransport } from "@/lib/transport";
import {
  ArrowLeft,
  ChevronRight,
  RefreshCw,
  Play,
  Square,
  Rocket,
  AlertTriangle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";

import { PaprikaService } from "@/gen/paprika/v1/api_connect";
import type { Rollout } from "@/gen/paprika/v1/api_pb";
import { RolloutDebugPanel } from "@/components/dashboard/rollout-debug-panel";

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
      </CardContent>
    </Card>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{children}</span>
    </div>
  );
}

function RolloutDetail() {
  const searchParams = useSearchParams();
  const namespace = searchParams.get("namespace") ?? "";
  const name = searchParams.get("name") ?? "";

  const [rollout, setRollout] = useState<Rollout | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!namespace || !name) return;
    setLoading(true);
    setError(null);
    try {
      const res = await client.getRollout({ namespace, name });
      setRollout(res.rollout ?? null);
    } catch (err) {
      setError("Failed to load rollout details");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [namespace, name]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchData();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchData]);

  const handlePromote = useCallback(async () => {
    if (!rollout) return;
    setActing("promote");
    try {
      await client.promoteRollout({ namespace: rollout.namespace, name: rollout.name });
      setTimeout(fetchData, 1000);
    } catch (err) {
      setError(`Promote failed for ${rollout.name}`);
      console.error(err);
    } finally {
      setActing(null);
    }
  }, [rollout, fetchData]);

  const handleAbort = useCallback(async () => {
    if (!rollout) return;
    setActing("abort");
    try {
      await client.abortRollout({ namespace: rollout.namespace, name: rollout.name });
      setTimeout(fetchData, 1000);
    } catch (err) {
      setError(`Abort failed for ${rollout.name}`);
      console.error(err);
    } finally {
      setActing(null);
    }
  }, [rollout, fetchData]);

  const pageTitle = rollout?.name ?? name;
  const pageNamespace = rollout?.namespace ?? namespace;

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-6 py-8">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/dashboard" className="flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Dashboard
        </Link>
        <ChevronRight className="h-4 w-4" />
        <Link href="/dashboard/rollouts" className="hover:text-foreground">
          Rollouts
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground">{pageTitle}</span>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{pageTitle}</h1>
          <p className="text-muted-foreground">{pageNamespace}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={fetchData} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            variant="outline"
            onClick={handlePromote}
            disabled={
              acting === "promote" ||
              !rollout ||
              rollout.phase === "Healthy" ||
              rollout.phase === "RolledBack"
            }
          >
            <Play className="mr-2 h-4 w-4" />
            Promote
          </Button>
          <Button
            variant="ghost"
            onClick={handleAbort}
            disabled={
              acting === "abort" ||
              !rollout ||
              rollout.phase === "Healthy" ||
              rollout.phase === "RolledBack"
            }
          >
            <Square className="mr-2 h-4 w-4" />
            Abort
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && !rollout ? (
        <div className="space-y-4">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : !rollout ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Rollout not found.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Strategy</CardDescription>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Rocket className="h-4 w-4" />
                  {rollout.strategyType || "—"}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Phase</CardDescription>
                <CardTitle className="text-lg">
                  <StatusBadge status={rollout.phase} />
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Current Step</CardDescription>
                <CardTitle className="text-lg">
                  {rollout.currentStep > 0 ? rollout.currentStep : "—"}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Current Weight</CardDescription>
                <CardTitle className="text-lg">
                  {rollout.currentWeight > 0 ? `${rollout.currentWeight}%` : "—"}
                </CardTitle>
              </CardHeader>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
              <CardDescription>Observed state and target workload.</CardDescription>
            </CardHeader>
            <CardContent>
              <DetailRow label="Target">
                {rollout.targetKind ? `${rollout.targetKind}/${rollout.targetName}` : "—"}
              </DetailRow>
              <Separator />
              <DetailRow label="Stable ReplicaSet">{rollout.stableRs || "—"}</DetailRow>
              <Separator />
              <DetailRow label="Canary ReplicaSet">{rollout.canaryRs || "—"}</DetailRow>
              <Separator />
              <DetailRow label="Active Service">{rollout.activeService || "—"}</DetailRow>
              <Separator />
              <DetailRow label="Preview Service">{rollout.previewService || "—"}</DetailRow>
              <Separator />
              <DetailRow label="Observed Generation">
                {rollout.observedGeneration?.toString() ?? "—"}
              </DetailRow>
              <Separator />
              <DetailRow label="Message">
                <span className="max-w-md truncate">{rollout.message || "—"}</span>
              </DetailRow>
            </CardContent>
          </Card>

          <RolloutDebugPanel rollout={rollout} />

          {rollout.conditions && rollout.conditions.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5" />
                  Conditions
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {rollout.conditions.map((c, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between rounded-md border px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={c.status === "True" ? "default" : "secondary"}
                        >
                          {c.status}
                        </Badge>
                        <span className="text-sm font-medium">{c.type}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">{c.reason}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

export default function RolloutDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-7xl space-y-8 px-6 py-8">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      }
    >
      <RolloutDetail />
    </Suspense>
  );
}

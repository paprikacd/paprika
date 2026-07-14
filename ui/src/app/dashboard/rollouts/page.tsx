"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { fleetDetailHref, fleetHref } from "@/lib/fleet-navigation";
import { createPromiseClient } from "@connectrpc/connect";
import { createTransport } from "@/lib/transport";
import {
  ArrowLeft,
  ChevronRight,
  RefreshCw,
  Rocket,
  Play,
  Square,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  FleetFilter,
  FleetGroupDimension,
  FleetObjectKey,
  FleetSizeMetric,
  type Release,
  type Rollout,
} from "@/gen/paprika/v1/api_pb";
import {
  buildRolloutApplicationAssociations,
  flattenMapApplicationAssociations,
  rolloutMatchesFleetScope,
} from "@/lib/fleet-resource-scope";
import { useFleetScope, type FleetScope } from "@/lib/fleet-scope-context";

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

function RolloutsList() {
  const searchParams = useSearchParams();
  const { state } = useFleetScope();
  const scope = useMemo<FleetScope>(
    () => ({
      projects: state.projects,
      clusters: state.clusters,
      stages: state.stages,
      namespaces: state.namespaces,
    }),
    [state.clusters, state.namespaces, state.projects, state.stages],
  );

  const [rollouts, setRollouts] = useState<Rollout[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<Record<string, string>>({});
  const requestGeneration = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const actionRefreshTimers = useRef(new Set<number>());
  const actionRefreshMounted = useRef(false);

  const fetchData = useCallback(async () => {
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const namespaceRequests = planNamespaceRequests(scope.namespaces);
      const [rolloutResponses, releaseResponses, mapResponse] = await Promise.all([
        Promise.all(
          namespaceRequests.map((request) =>
            client.listRollouts(request, { signal: controller.signal }),
          ),
        ),
        Promise.all(
          namespaceRequests.map((request) =>
            client.listReleases(request, { signal: controller.signal }),
          ),
        ),
        client.queryFleetMap(
          {
            filter: fleetScopeFilter(scope),
            search: "",
            group: FleetGroupDimension.PROJECT,
            sizeMetric: FleetSizeMetric.RESOURCE_COUNT,
          },
          { signal: controller.signal },
        ),
      ]);
      if (controller.signal.aborted || generation !== requestGeneration.current) return;

      const mergedRollouts = mergeRollouts(
        rolloutResponses.map((response) => response.rollouts ?? []),
      );
      const releases: Release[] = releaseResponses.flatMap(
        (response) => response.releases ?? [],
      );
      const applications = flattenMapApplicationAssociations(mapResponse.roots ?? []);
      if (BigInt(applications.length) !== mapResponse.total) {
        throw new Error("Fleet map did not contain every Application leaf");
      }
      const associations = buildRolloutApplicationAssociations(
        mergedRollouts,
        releases,
        applications,
      );
      setRollouts(
        mergedRollouts.filter((rollout) =>
          rolloutMatchesFleetScope(
            rollout,
            associations.get(resourceKey(rollout.namespace, rollout.name)),
            scope,
          ),
        ),
      );
    } catch (err) {
      if (controller.signal.aborted || generation !== requestGeneration.current) return;
      setRollouts([]);
      setError("Failed to load rollouts");
      console.error(err);
    } finally {
      if (!controller.signal.aborted && generation === requestGeneration.current) {
        setLoading(false);
      }
    }
  }, [scope]);

  const currentFetchData = useRef(fetchData);
  useEffect(() => {
    currentFetchData.current = fetchData;
  }, [fetchData]);

  const scheduleActionRefresh = useCallback(() => {
    if (!actionRefreshMounted.current) return;
    const timer = window.setTimeout(() => {
      actionRefreshTimers.current.delete(timer);
      void currentFetchData.current();
    }, 1000);
    actionRefreshTimers.current.add(timer);
  }, []);

  useEffect(() => {
    const timers = actionRefreshTimers.current;
    actionRefreshMounted.current = true;
    return () => {
      actionRefreshMounted.current = false;
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchData();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      activeController.current?.abort();
    };
  }, [fetchData]);

  const handlePromote = useCallback(
    async (ro: Rollout) => {
      const key = resourceKey(ro.namespace, ro.name);
      setActing((prev) => ({ ...prev, [key]: "promote" }));
      try {
        await client.promoteRollout({ namespace: ro.namespace, name: ro.name });
        scheduleActionRefresh();
      } catch (err) {
        setError(`Promote failed for ${ro.name}`);
        console.error(err);
      } finally {
        setActing((prev) => ({ ...prev, [key]: "" }));
      }
    },
    [scheduleActionRefresh],
  );

  const handleAbort = useCallback(
    async (ro: Rollout) => {
      const key = resourceKey(ro.namespace, ro.name);
      setActing((prev) => ({ ...prev, [key]: "abort" }));
      try {
        await client.abortRollout({ namespace: ro.namespace, name: ro.name });
        scheduleActionRefresh();
      } catch (err) {
        setError(`Abort failed for ${ro.name}`);
        console.error(err);
      } finally {
        setActing((prev) => ({ ...prev, [key]: "" }));
      }
    },
    [scheduleActionRefresh],
  );

  const activeCount = useMemo(
    () => rollouts.filter((r) => r.phase === "Progressing" || r.phase === "Paused").length,
    [rollouts],
  );
  const healthyCount = useMemo(
    () => rollouts.filter((r) => r.phase === "Healthy").length,
    [rollouts],
  );

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-6 py-8">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href={fleetHref("/dashboard", searchParams)} className="flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Dashboard
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground">Rollouts</span>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Rollouts</h1>
          <p className="text-muted-foreground">
            Advanced deployment strategies across namespaces
          </p>
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

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Rollouts</CardDescription>
            <CardTitle className="text-lg">{rollouts.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Active</CardDescription>
            <CardTitle className="text-lg">{activeCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Healthy</CardDescription>
            <CardTitle className="text-lg">{healthyCount}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {loading && rollouts.length === 0 ? (
        <div className="space-y-4">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Rocket className="h-5 w-5" />
              Rollouts
            </CardTitle>
            <CardDescription>
              Canary, blue-green, A/B and mirror rollouts.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {rollouts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No rollouts found.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Namespace</TableHead>
                    <TableHead>Strategy</TableHead>
                    <TableHead>Phase</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Step / Weight</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rollouts.map((ro) => {
                    const key = resourceKey(ro.namespace, ro.name);
                    return (
                      <TableRow key={key}>
                        <TableCell className="font-medium">
                          <Link
                            href={fleetDetailHref("rollout", ro, searchParams)}
                            className="hover:underline"
                          >
                            {ro.name}
                          </Link>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{ro.namespace}</TableCell>
                        <TableCell>{ro.strategyType || "—"}</TableCell>
                        <TableCell>
                          <StatusBadge status={ro.phase} />
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {ro.targetKind ? `${ro.targetKind}/${ro.targetName}` : "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">
                          {ro.currentStep > 0 ? `step ${ro.currentStep}` : "—"}
                          {ro.currentWeight > 0 ? ` / ${ro.currentWeight}%` : ""}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handlePromote(ro)}
                              disabled={
                                acting[key] === "promote" ||
                                ro.phase === "Healthy" ||
                                ro.phase === "RolledBack"
                              }
                            >
                              <Play className="mr-1 h-4 w-4" />
                              Promote
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleAbort(ro)}
                              disabled={
                                acting[key] === "abort" ||
                                ro.phase === "RolledBack" ||
                                ro.phase === "Healthy"
                              }
                            >
                              <Square className="mr-1 h-4 w-4" />
                              Abort
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function planNamespaceRequests(namespaces: readonly string[]): Array<{ namespace?: string }> {
  const unique = [...new Set(namespaces.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
  return unique.length > 0 ? unique.map((namespace) => ({ namespace })) : [{}];
}

function fleetScopeFilter(scope: FleetScope): FleetFilter {
  return new FleetFilter({
    projects: scope.projects.map((project) => new FleetObjectKey(project)),
    clusters: scope.clusters.map((cluster) => new FleetObjectKey(cluster)),
    stages: [...scope.stages],
    namespaces: [...scope.namespaces],
  });
}

function mergeRollouts(responses: readonly (readonly Rollout[])[]): Rollout[] {
  const seen = new Set<string>();
  const rollouts: Rollout[] = [];
  for (const response of responses) {
    for (const rollout of response) {
      const key = resourceKey(rollout.namespace, rollout.name);
      if (seen.has(key)) continue;
      seen.add(key);
      rollouts.push(rollout);
    }
  }
  return rollouts;
}

function resourceKey(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

export default function RolloutsPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-7xl space-y-8 px-6 py-8">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      }
    >
      <RolloutsList />
    </Suspense>
  );
}

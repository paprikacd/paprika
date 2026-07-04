"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createPromiseClient } from "@connectrpc/connect";
import { createTransport } from "@/lib/transport";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  FolderTree,
  RefreshCw,
  Rocket,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";

import { PaprikaService } from "@/gen/paprika/v1/api_connect";
import type { ApplicationSet } from "@/gen/paprika/v1/api_pb";

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
      </CardContent>
    </Card>
  );
}

function ApplicationSetList() {
  const [sets, setSets] = useState<ApplicationSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.listApplicationSets({});
      setSets(res.applicationsets ?? []);
    } catch (err) {
      setError("Failed to load application sets");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData();
  }, [fetchData]);

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
        <span className="text-foreground">Application Sets</span>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Application Sets</h1>
          <p className="text-muted-foreground">
            Templated application generators
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

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : sets.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted">
              <FolderTree className="size-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">No application sets yet</p>
            <p className="text-xs text-muted-foreground">
              Create an ApplicationSet resource to generate Applications from templates
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {sets.map((set) => {
            const detailHref = `/dashboard/applicationsets/detail?namespace=${encodeURIComponent(set.namespace)}&name=${encodeURIComponent(set.name)}`;
            return (
              <Card
                key={`${set.namespace}/${set.name}`}
                className="group transition-all duration-200 hover:ring-primary/30 hover:shadow-lg hover:shadow-primary/5"
              >
                <CardContent className="space-y-4 pt-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate font-mono text-sm font-medium group-hover:text-primary">
                        {set.name}
                      </h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        ns/{set.namespace}
                      </p>
                    </div>
                    <StatusBadge status={set.phase} />
                  </div>

                  <div className="flex items-center gap-1.5 rounded-lg bg-muted/50 px-2.5 py-2">
                    <Rocket className="size-3.5 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] text-muted-foreground">Applications</p>
                      <p className="truncate font-mono text-xs font-medium">
                        {set.applications}
                      </p>
                    </div>
                  </div>

                  <Link
                    href={detailHref}
                    className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-border/50 bg-background px-2 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    View
                    <ArrowRight className="size-3" />
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function ApplicationSetsPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-7xl space-y-8 px-6 py-8">
          <SkeletonCard />
        </div>
      }
    >
      <ApplicationSetList />
    </Suspense>
  );
}

"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createPromiseClient } from "@connectrpc/connect";
import { createTransport } from "@/lib/transport";
import {
  ArrowLeft,
  ChevronRight,
  FolderTree,
  RefreshCw,
  Rocket,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

function ApplicationSetDetail() {
  const searchParams = useSearchParams();
  const namespace = searchParams.get("namespace") ?? "";
  const name = searchParams.get("name") ?? "";

  const [set, setSet] = useState<ApplicationSet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!namespace || !name) return;
    setLoading(true);
    setError(null);
    try {
      const res = await client.getApplicationSet({ namespace, name });
      setSet(res.applicationset ?? null);
    } catch (err) {
      setError("Failed to load application set");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [namespace, name]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData();
  }, [fetchData]);

  const pageTitle = set?.name ?? name;
  const pageNamespace = set?.namespace ?? namespace;

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
        <Link
          href="/dashboard/applicationsets"
          className="hover:text-foreground"
        >
          Application Sets
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

      {loading && !set ? (
        <div className="space-y-4">
          <SkeletonCard />
        </div>
      ) : !set ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Application set not found.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-lg">
                <FolderTree className="h-5 w-5" />
                Status
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between py-2 text-sm">
                <span className="text-muted-foreground">Phase</span>
                <StatusBadge status={set.phase} />
              </div>
              <div className="flex items-center justify-between py-2 text-sm">
                <span className="text-muted-foreground">Applications generated</span>
                <span className="font-medium">{set.applications}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Rocket className="h-5 w-5" />
                Generated Applications
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {set.applications === 0
                  ? "This application set has not generated any applications yet."
                  : `${set.applications} application${set.applications === 1 ? "" : "s"} managed by this set.`}
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

export default function ApplicationSetDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-7xl space-y-8 px-6 py-8">
          <SkeletonCard />
        </div>
      }
    >
      <ApplicationSetDetail />
    </Suspense>
  );
}

import { Box } from "lucide-react"

import { cn } from "@/lib/utils"

const ICONS: Record<string, string> = {
  Pod: "pod", Deployment: "deploy", ReplicaSet: "rs", StatefulSet: "sts",
  DaemonSet: "ds", Job: "job", CronJob: "cronjob", Service: "svc",
  Endpoints: "ep", EndpointSlice: "ep", Ingress: "ing", ConfigMap: "cm",
  Secret: "secret", Namespace: "ns", ServiceAccount: "sa", Role: "role",
  RoleBinding: "rb", ClusterRole: "c-role", ClusterRoleBinding: "crb",
  PersistentVolume: "pv", PersistentVolumeClaim: "pvc", StorageClass: "sc",
  NetworkPolicy: "netpol", ResourceQuota: "quota", LimitRange: "limits",
  HorizontalPodAutoscaler: "hpa", CustomResourceDefinition: "crd",
}

/** Official, locally served Kubernetes icons. Unknown CRDs keep their own kind label. */
export function ResourceKindIcon({ kind, className }: { kind: string; className?: string }) {
  const icon = ICONS[kind]
  if (!icon) return <Box aria-hidden="true" className={cn("size-7 shrink-0 text-steel-600", className)} />
  return (
    // These small SVGs are already vectors; no image optimizer or external request is needed.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/kubernetes/70a4bb2d8cc3/${icon}.svg`}
      alt=""
      aria-hidden="true"
      width={28}
      height={28}
      draggable={false}
      className={cn("size-7 shrink-0", className)}
    />
  )
}

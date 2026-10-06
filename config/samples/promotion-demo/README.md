# Promotion demo workload

This Helm chart serves `/healthz` (`ok`), `/environment`, and `/version` over
an internal ClusterIP Service. Deploy each environment with its own namespace
and Helm values. The chart creates only a ConfigMap, Deployment, and Service.
The container runs without root privileges on amd64 nodes and requests
10m CPU / 8Mi memory, with 100m CPU / 24Mi limits.

The workload and verification Jobs use the linux/amd64 child digest of
`docker.io/library/busybox:1.37.0-musl`, verified with
`docker buildx imagetools inspect` and a local nonroot container run.
See [the deployment instructions](../../../deploy/promotion-demo/README.md)
for the GitOps → automatic staging → approved production chain.

Render locally:

```sh
helm lint config/samples/promotion-demo
helm template promotion-demo config/samples/promotion-demo \
  --namespace paprika-promotion-dev --set environment=dev
```

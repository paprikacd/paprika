import { describe, expect, it } from "vitest";
import { repositoryWorkspaceMetadata, repositoryWorkspaceProviders } from "./repository-workspace";

const metricsProvider = repositoryWorkspaceProviders.find((provider) => provider.capabilities.includes("metrics"))!;

describe("repository workspace metadata", () => {
  it("answers a label-values source for the Edge Watch cluster, so a sourced variable loads in a static export", async () => {
    const response = await repositoryWorkspaceMetadata(metricsProvider.id, { kind: "values", label: "cluster" }, undefined);
    expect(response.values).toEqual(["omega", "delta"]);
  });

  it("answers an unknown label with no values rather than failing", async () => {
    const response = await repositoryWorkspaceMetadata(metricsProvider.id, { kind: "values", label: "no_such_label" }, undefined);
    expect(response.values).toEqual([]);
  });
});

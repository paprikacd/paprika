import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const copyToClipboard = vi
  .fn<(text: string) => Promise<void>>()
  .mockResolvedValue(undefined)

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: (text: string) => copyToClipboard(text),
}))

import { ArtifactCard } from "@/components/dashboard/artifact-card"
import { ArtifactRef } from "@/gen/paprika/v1/api_pb"

function makeArtifact(props: Partial<ArtifactRef> = {}): ArtifactRef {
  return new ArtifactRef({
    name: "build-image",
    kind: "oci",
    phase: "Ready",
    digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef",
    resolvedReference: "ghcr.io/acme/checkout-api:9f3a1c2",
    producingStep: "build",
    createdAt: BigInt(1_700_000_000),
    ...props,
  })
}

function renderRow(node: React.ReactNode) {
  return render(<ul>{node}</ul>)
}

describe("ArtifactCard", () => {
  beforeEach(() => {
    copyToClipboard.mockClear()
  })

  it("leads with the reference an operator would paste, keeping the name in the meta", () => {
    renderRow(<ArtifactCard artifact={makeArtifact()} />)
    expect(screen.getByText("ghcr.io/acme/checkout-api:9f3a1c2")).toBeInTheDocument()
    expect(screen.getByText(/build-image/)).toBeInTheDocument()
    expect(screen.getByText(/oci/)).toBeInTheDocument()
  })

  it("falls back to the artifact name when there is no reference", () => {
    renderRow(
      <ArtifactCard
        artifact={makeArtifact({ resolvedReference: "", reference: "" })}
      />
    )
    expect(screen.getByText("build-image")).toBeInTheDocument()
  })

  it("truncates the digest instead of overflowing the row", () => {
    renderRow(<ArtifactCard artifact={makeArtifact()} />)
    expect(
      screen.queryByText(/0123456789abcdef0123456789abcdef0123456789abcdef/)
    ).not.toBeInTheDocument()
    expect(screen.getByText(/sha256:0123456789a/)).toBeInTheDocument()
  })

  it("states the artifact phase in words, not only in colour", () => {
    renderRow(<ArtifactCard artifact={makeArtifact({ phase: "Failed" })} />)
    expect(screen.getByText("Failed")).toBeInTheDocument()
  })

  it("copies the resolved reference and announces that it did", async () => {
    const user = userEvent.setup()
    renderRow(<ArtifactCard artifact={makeArtifact()} />)
    await user.click(
      screen.getByRole("button", { name: "Copy reference for build-image" })
    )
    expect(copyToClipboard).toHaveBeenCalledWith("ghcr.io/acme/checkout-api:9f3a1c2")
    expect(
      await screen.findByText("Reference for build-image copied")
    ).toBeInTheDocument()
  })

  it("falls back to the unresolved reference", async () => {
    const user = userEvent.setup()
    renderRow(
      <ArtifactCard
        artifact={makeArtifact({ resolvedReference: "", reference: "oci://ref" })}
      />
    )
    await user.click(
      screen.getByRole("button", { name: "Copy reference for build-image" })
    )
    expect(copyToClipboard).toHaveBeenCalledWith("oci://ref")
  })

  it("offers a named download link instead of copy when one is available", () => {
    renderRow(
      <ArtifactCard
        artifact={makeArtifact({ kind: "configmap" })}
        downloadUrl="data:application/json;base64,eyJoZWxsIjoid29ybGQifQ=="
      />
    )
    const link = screen.getByRole("link", { name: "Download build-image" })
    expect(link).toHaveAttribute("download")
    expect(
      screen.queryByRole("button", { name: /copy reference/i })
    ).not.toBeInTheDocument()
  })

  it("explains a failed artifact", () => {
    renderRow(
      <ArtifactCard
        artifact={makeArtifact({ phase: "Failed", failedReason: "digest mismatch" })}
      />
    )
    expect(screen.getByText("digest mismatch")).toBeInTheDocument()
  })

  it("shows caller-supplied provenance only when it is passed", () => {
    const { rerender } = renderRow(
      <ArtifactCard artifact={makeArtifact({ name: "junit-report.xml" })} />
    )
    expect(screen.queryByText(/tests/)).not.toBeInTheDocument()

    rerender(
      <ul>
        <ArtifactCard
          artifact={makeArtifact({ name: "junit-report.xml" })}
          extraMeta="214 tests · 1 flaked"
        />
      </ul>
    )
    expect(screen.getByText(/214 tests · 1 flaked/)).toBeInTheDocument()
  })
})

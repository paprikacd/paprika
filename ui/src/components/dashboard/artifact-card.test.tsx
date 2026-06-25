import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const copyToClipboard = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)

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
    resolvedReference: "registry.example.com/app@sha256:abc",
    producingStep: "build",
    createdAt: BigInt(1_700_000_000),
    ...props,
  })
}

describe("ArtifactCard", () => {
  beforeEach(() => {
    copyToClipboard.mockClear()
  })

  it("renders artifact name, kind badge, and phase badge", () => {
    render(<ArtifactCard artifact={makeArtifact()} />)
    expect(screen.getByText("build-image")).toBeInTheDocument()
    expect(screen.getByText("oci")).toBeInTheDocument()
    expect(screen.getByText("Ready")).toBeInTheDocument()
  })

  it("renders truncated digest", () => {
    render(<ArtifactCard artifact={makeArtifact()} />)
    expect(screen.getByText(/0123456789a/)).toBeInTheDocument()
    expect(
      screen.queryByText(/0123456789abcdef0123456789abcdef0123456789abcdef/)
    ).not.toBeInTheDocument()
  })

  it("renders created-at timestamp", () => {
    render(<ArtifactCard artifact={makeArtifact()} />)
    expect(screen.getByText(/2023/)).toBeInTheDocument()
  })

  it("shows Copy reference button and copies resolvedReference when no downloadUrl", async () => {
    const user = userEvent.setup()
    render(<ArtifactCard artifact={makeArtifact()} />)
    const btn = screen.getByRole("button", { name: /copy reference/i })
    await user.click(btn)
    expect(copyToClipboard).toHaveBeenCalledWith(
      "registry.example.com/app@sha256:abc"
    )
    expect(await screen.findByText("Copied")).toBeInTheDocument()
  })

  it("falls back to reference when resolvedReference is empty", async () => {
    const user = userEvent.setup()
    render(
      <ArtifactCard
        artifact={makeArtifact({ resolvedReference: "", reference: "oci://ref" })}
      />
    )
    await user.click(screen.getByRole("button", { name: /copy reference/i }))
    expect(copyToClipboard).toHaveBeenCalledWith("oci://ref")
  })

  it("shows Download button when downloadUrl is present", () => {
    render(
      <ArtifactCard
        artifact={makeArtifact({ kind: "configmap" })}
        downloadUrl="data:application/json;base64,eyJoZWxsIjoid29ybGQifQ=="
      />
    )
    const link = screen.getByRole("link", { name: /download/i })
    expect(link).toHaveAttribute(
      "href",
      "data:application/json;base64,eyJoZWxsIjoid29ybGQifQ=="
    )
    expect(link).toHaveAttribute("download")
  })

  it("does not show Copy reference when downloadUrl is present", () => {
    render(
      <ArtifactCard
        artifact={makeArtifact({ kind: "configmap" })}
        downloadUrl="data:application/json;base64,eyJoZWxsIjoid29ybGQifQ=="
      />
    )
    expect(screen.queryByRole("button", { name: /copy reference/i })).not.toBeInTheDocument()
  })

  it("renders failed reason when phase is Failed", () => {
    render(
      <ArtifactCard
        artifact={makeArtifact({ phase: "Failed", failedReason: "digest mismatch" })}
      />
    )
    expect(screen.getByText("digest mismatch")).toBeInTheDocument()
  })
})

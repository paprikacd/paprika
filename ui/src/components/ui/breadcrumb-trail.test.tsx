import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { BreadcrumbTrail } from "@/components/ui/breadcrumb-trail"

describe("BreadcrumbTrail", () => {
  it("links ancestors and marks only the last crumb as current", () => {
    render(
      <BreadcrumbTrail
        items={[
          { label: "Applications", href: "/dashboard/applications/" },
          {
            label: "payments/core",
            href: "/dashboard/applications/?project=payments%2Fcore",
          },
          { label: "checkout-api" },
        ]}
      />
    )

    expect(
      screen.getByRole("navigation", { name: "Breadcrumb" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "Applications" })
    ).toHaveAttribute("href", "/dashboard/applications")
    expect(
      screen.getByRole("link", { name: "payments/core" })
    ).toHaveAttribute(
      "href",
      "/dashboard/applications?project=payments%2Fcore"
    )
    expect(screen.getByText("checkout-api")).toHaveAttribute(
      "aria-current",
      "page"
    )
    expect(
      screen.getByRole("link", { name: "Applications" })
    ).not.toHaveAttribute("aria-current")
  })

  it("renders a single current crumb without a link", () => {
    render(<BreadcrumbTrail items={[{ label: "Overview" }]} />)
    expect(screen.getByText("Overview")).toHaveAttribute(
      "aria-current",
      "page"
    )
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
  })
})

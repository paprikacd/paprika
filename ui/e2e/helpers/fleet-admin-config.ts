type FleetAdminEnvironment = Pick<
  Record<string, string | undefined>,
  "PAPRIKA_E2E_FIXTURE_MODE" | "PAPRIKA_E2E_ADMIN_SESSION_STUB"
>

export function fixtureModeFromEnvironment(environment: FleetAdminEnvironment) {
  const fixtureMode = environment.PAPRIKA_E2E_FIXTURE_MODE ?? "local"
  if (
    fixtureMode === "live" &&
    environment.PAPRIKA_E2E_ADMIN_SESSION_STUB === "1"
  ) {
    throw new Error(
      "PAPRIKA_E2E_ADMIN_SESSION_STUB=1 is forbidden when " +
        "PAPRIKA_E2E_FIXTURE_MODE=live",
    )
  }
  if (fixtureMode !== "local" && fixtureMode !== "live") {
    throw new Error("PAPRIKA_E2E_FIXTURE_MODE must be local or live")
  }
  return fixtureMode
}

export function expectedLiveFilterStableIds(
  namespace: string,
  dimension: "project" | "cluster" | "stage",
) {
  const names = dimension === "stage"
    ? ["billing", "checkout", "ledger"]
    : ["billing", "ledger", "notifications"]
  return names.map((name) => `a:${namespace}/${name}`)
}

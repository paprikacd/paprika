// Test-only script that uses the reference dashboard environment the way the e2e
// suites do: no supervisor, no signal handling of its own. Usage:
//   node reference-environment-child.mjs <repository>
import { createReferenceDashboardEnvironment } from "./reference-dashboard-environment.mjs"

const repository = process.argv[2]
const environment = await createReferenceDashboardEnvironment(repository, undefined)
console.log(`READY ${environment.temporaryDirectory}`)
setInterval(() => {}, 1000)

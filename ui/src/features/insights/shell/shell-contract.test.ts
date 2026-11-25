import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

// The shell hooks take positional parameters and return tuples, and the shell views are render functions with
// positional parameters, so minified code carries no names for them (object keys would). Positions are only safe
// while every call site lists the same names in the same order as the definition. This test holds that: the root's
// arguments match each hook's and view's parameters, the root destructures each hook's tuple into the names the hook
// returns, and shell/types.ts names each tuple the same way.
const dir = join(process.cwd(), "src/features/insights")
const parse = (path: string) => ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const root = parse(join(dir, "insights-app.tsx"))
const shellFiles = readdirSync(join(dir, "shell")).filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts"))
const exported = new Map<string, ts.FunctionDeclaration>()
for (const file of shellFiles) {
  for (const statement of parse(join(dir, "shell", file)).statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && /^(use|render)[A-Z]/.test(statement.name.text)) exported.set(statement.name.text, statement)
  }
}
const names = (list: readonly ts.Node[]) => list.map((node) => node.getText())
function returnedTuple(fn: ts.FunctionDeclaration): string[] | undefined {
  const last = fn.body?.statements.at(-1)
  if (!last || !ts.isReturnStatement(last) || !last.expression) return undefined
  const value = ts.isAsExpression(last.expression) ? last.expression.expression : last.expression
  return ts.isArrayLiteralExpression(value) ? names(value.elements) : undefined
}
const calls: { name: string; args: string[]; bound?: string[] }[] = []
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && exported.has(node.expression.text)) {
    const parent = node.parent
    const bound = ts.isVariableDeclaration(parent) && ts.isArrayBindingPattern(parent.name) ? names(parent.name.elements) : undefined
    calls.push({ name: node.expression.text, args: names(node.arguments), bound })
  }
  ts.forEachChild(node, visit)
}
visit(root)
const types = readFileSync(join(dir, "shell/types.ts"), "utf8")

describe("shell call contract", () => {
  it("calls every shell hook and view from the root once", () => {
    expect(calls.map((call) => call.name).sort()).toEqual([...exported.keys()].sort())
  })

  it.each(calls.map((call) => [call.name, call] as const))("%s gets its parameters in order", (_, call) => {
    const fn = exported.get(call.name)!
    expect(call.args).toEqual(fn.parameters.map((parameter) => parameter.name.getText()))
  })

  it.each(calls.filter((call) => call.name.startsWith("use")).map((call) => [call.name, call] as const))("%s is destructured into the names it returns", (_, call) => {
    const tuple = returnedTuple(exported.get(call.name)!)
    expect(call.bound ?? []).toEqual(tuple ?? [])
    if (tuple) {
      const declared = new RegExp(`export type ${call.name.replace(/^use/, "")}Names = \\[([^\\]]*)\\]`).exec(types)
      expect(declared?.[1].split(",").map((entry) => entry.trim().replace(/"/g, "")).filter(Boolean)).toEqual(tuple)
    }
  })
})

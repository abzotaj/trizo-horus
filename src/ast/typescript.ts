import ts from "typescript"
import type { CodeFact, FactKind } from "./types.js"

/**
 * Real-AST fact extraction for TS/TSX/JS/JSX via the TypeScript compiler API.
 * This is pattern-matching over a real parse tree (call-expression shapes,
 * decorators, literal arguments), not framework-aware type analysis -- it
 * recognizes common conventions (Express/Fastify/Koa-style route
 * registration, Nest.js route decorators, fetch/axios-style outbound calls,
 * publish/subscribe method names) rather than understanding any one
 * framework's types. Matches become CodeFact entries; nothing here throws
 * on unrecognized code, it just doesn't produce a fact for it.
 */

const ROUTE_METHODS = new Set(["get", "post", "put", "delete", "patch", "all"])
const ROUTE_DECORATORS = new Set(["Get", "Post", "Put", "Delete", "Patch", "All"])
const HTTP_CLIENT_METHODS = new Set(["get", "post", "put", "delete", "patch", "request"])
const HTTP_CLIENT_HINTS = /axios|http|client|fetch/i
const QUEUE_PUBLISH_METHODS = new Set(["publish", "sendmessage", "emit", "produce", "send"])
const QUEUE_CONSUME_METHODS = new Set(["subscribe", "consume"])
const SQL_KEYWORD_PATTERN = /^[`'"]?\s*(select|insert\s+into|update|delete\s+from)\b/i

export function extractTypeScriptFacts(filePath: string, content: string): CodeFact[] {
  const facts: CodeFact[] = []
  const scriptKind = filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind)

  const lineOf = (pos: number) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1
  const snippetOf = (node: ts.Node) => node.getText(sourceFile).slice(0, 200).replace(/\s+/g, " ").trim()

  function push(node: ts.Node, kind: FactKind, target: string) {
    facts.push({
      file: filePath,
      startLine: lineOf(node.getStart(sourceFile)),
      endLine: lineOf(node.getEnd()),
      kind,
      target,
      snippet: snippetOf(node),
    })
  }

  function firstStringLiteralArg(args: ts.NodeArray<ts.Expression>): string | undefined {
    const first = args[0]
    return first && ts.isStringLiteralLike(first) ? first.text : undefined
  }

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression

      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
        const method = callee.name.text.toLowerCase()
        const literalArg = firstStringLiteralArg(node.arguments)
        const looksLikeHttpClient = HTTP_CLIENT_HINTS.test(callee.expression.getText(sourceFile))

        if (ROUTE_METHODS.has(method) && literalArg?.startsWith("/") && !looksLikeHttpClient) {
          push(node, "route", literalArg)
        } else if (HTTP_CLIENT_METHODS.has(method) && literalArg && looksLikeHttpClient) {
          push(node, "httpCall", literalArg)
        } else if (QUEUE_PUBLISH_METHODS.has(method)) {
          push(node, "queuePublish", literalArg ?? `${callee.expression.getText(sourceFile)}.${method}(...)`)
        } else if (QUEUE_CONSUME_METHODS.has(method)) {
          push(node, "queueConsume", literalArg ?? `${callee.expression.getText(sourceFile)}.${method}(...)`)
        }
      }

      if (ts.isIdentifier(callee) && callee.text === "fetch") {
        const literalArg = firstStringLiteralArg(node.arguments)
        if (literalArg) push(node, "httpCall", literalArg)
      }
    }

    // @Get("/path"), @Post("/path"), ... (Nest.js-style route decorators)
    if (ts.canHaveDecorators(node)) {
      for (const decorator of ts.getDecorators(node) ?? []) {
        if (ts.isCallExpression(decorator.expression) && ts.isIdentifier(decorator.expression.expression)) {
          const name = decorator.expression.expression.text
          if (ROUTE_DECORATORS.has(name)) {
            push(decorator, "route", firstStringLiteralArg(decorator.expression.arguments) ?? "/")
          }
        }
      }
    }

    // Raw SQL in a string/template literal, e.g. db.query(`SELECT * FROM users`)
    if ((ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) && SQL_KEYWORD_PATTERN.test(node.getText(sourceFile))) {
      push(
        node,
        "dbQuery",
        node
          .getText(sourceFile)
          .replace(/^[`'"]|[`'"]$/g, "")
          .slice(0, 80)
          .replace(/\s+/g, " ")
          .trim(),
      )
    }

    ts.forEachChild(node, visit)
  }

  try {
    visit(sourceFile)
  } catch {
    // Malformed/unparsable source -- fall back to no facts rather than failing the whole repo scan.
    return []
  }

  return facts
}

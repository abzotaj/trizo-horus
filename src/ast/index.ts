import { extractPatternFacts, JAVA_RULES, PHP_RULES, POWERSHELL_RULES, PYTHON_RULES, SHELL_RULES, TERRAFORM_RULES } from "./patterns.js"
import { extractTypeScriptFacts } from "./typescript.js"
import type { CodeFact } from "./types.js"

export type { CodeFact, FactKind } from "./types.js"

const TS_JS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])

/**
 * Extracts deterministic CodeFacts for one file, dispatched by extension.
 * TS/JS/JSX get a real AST walk (src/ast/typescript.ts); PHP, Terraform,
 * Java, Python, and shell/PowerShell get regex-pattern extraction (see
 * src/ast/patterns.ts for why). Any other extension (YAML, Markdown, plain
 * config, ...) returns no facts -- the surveyor still sees its raw content,
 * just without a facts list layered on top.
 */
export function extractFacts(filePath: string, content: string): CodeFact[] {
  const ext = extensionOf(filePath)

  try {
    if (TS_JS_EXTENSIONS.has(ext)) return extractTypeScriptFacts(filePath, content)
    if (ext === ".php") return extractPatternFacts(filePath, content, PHP_RULES)
    if (ext === ".tf" || ext === ".tf.json") return extractPatternFacts(filePath, content, TERRAFORM_RULES)
    if (ext === ".java") return extractPatternFacts(filePath, content, JAVA_RULES)
    if (ext === ".py") return extractPatternFacts(filePath, content, PYTHON_RULES)
    if (ext === ".sh" || ext === ".bash") return extractPatternFacts(filePath, content, SHELL_RULES)
    if (ext === ".ps1" || ext === ".psm1") return extractPatternFacts(filePath, content, POWERSHELL_RULES)
  } catch {
    // Extraction is a best-effort hint for the surveyor, never a reason to fail the scan.
    return []
  }

  return []
}

function extensionOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".")
  if (dot === -1) return ""
  // Handle the two-part ".tf.json" convention explicitly before falling back to the last extension.
  if (filePath.toLowerCase().endsWith(".tf.json")) return ".tf.json"
  return filePath.slice(dot).toLowerCase()
}

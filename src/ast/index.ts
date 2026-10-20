import { extractPatternFacts, POWERSHELL_RULES } from "./patterns.js"
import { extractTreeSitterFacts, type TreeSitterLanguageName } from "./tree-sitter.js"
import { extractTypeScriptFacts } from "./typescript.js"
import type { CodeFact } from "./types.js"

export type { CodeFact, FactKind } from "./types.js"

const TS_JS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])

const TREE_SITTER_EXTENSIONS: Record<string, TreeSitterLanguageName> = {
  ".php": "php",
  ".java": "java",
  ".py": "python",
  ".sh": "bash",
  ".bash": "bash",
  ".tf": "terraform",
  ".tf.json": "terraform",
}

/**
 * Extracts deterministic CodeFacts for one file, dispatched by extension.
 * TS/JS/JSX get a real AST walk via the TypeScript compiler API
 * (src/ast/typescript.ts) -- already a precise, dependency-light real
 * parser for this language, so there's no reason to route it through
 * tree-sitter too. PHP, Java, Python, Bash, and Terraform get a real
 * tree-sitter parse (src/ast/tree-sitter.ts, WASM grammars, no native
 * build step). PowerShell has no mainstream prebuilt tree-sitter grammar,
 * so it stays on regex-pattern extraction (src/ast/patterns.ts). Any other
 * extension (YAML, Markdown, plain config, ...) returns no facts -- the
 * surveyor still sees its raw content, just without a facts list layered
 * on top.
 */
export async function extractFacts(filePath: string, content: string): Promise<CodeFact[]> {
  const ext = extensionOf(filePath)

  try {
    if (TS_JS_EXTENSIONS.has(ext)) return extractTypeScriptFacts(filePath, content)
    const treeSitterLanguage = TREE_SITTER_EXTENSIONS[ext]
    if (treeSitterLanguage) return await extractTreeSitterFacts(treeSitterLanguage, filePath, content)
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

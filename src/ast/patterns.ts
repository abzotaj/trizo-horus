import type { CodeFact, FactKind } from "./types.js"

/**
 * Regex-pattern fact extraction for languages with no lightweight, dependency-free
 * AST parser available in the JS ecosystem (PHP, Terraform/HCL, Java, Python,
 * shell/bash, PowerShell). This is intentionally NOT a real parse tree --
 * tree-sitter grammars or per-language parser packages (php-parser,
 * java-parser, ...) would give one, at the cost of several new native/WASM
 * or heavyweight dependencies per language. These rules target the same
 * signal kinds (route declarations, outbound HTTP/queue calls, Terraform
 * resources) via well-scoped regexes instead, which is what most lightweight
 * polyglot code-intel tools do in practice.
 */
export type PatternRule = {
  kind: FactKind
  /** Must have exactly one or more capture groups for the target, or none (falls back to the whole match). */
  regex: RegExp
}

export function extractPatternFacts(filePath: string, content: string, rules: PatternRule[]): CodeFact[] {
  const facts: CodeFact[] = []
  const lineStarts = computeLineStarts(content)

  for (const rule of rules) {
    const flags = rule.regex.flags.includes("g") ? rule.regex.flags : `${rule.regex.flags}g`
    const regex = new RegExp(rule.regex.source, flags)
    let match: RegExpExecArray | null
    while ((match = regex.exec(content))) {
      const groups = match.slice(1).filter((g): g is string => Boolean(g))
      const target = (groups.length > 0 ? groups.join(".") : match[0]).trim()
      const line = lineOfOffset(lineStarts, match.index)
      facts.push({
        file: filePath,
        startLine: line,
        endLine: line,
        kind: rule.kind,
        target,
        snippet: match[0].slice(0, 200).replace(/\s+/g, " ").trim(),
      })
      if (match[0].length === 0) regex.lastIndex++
    }
  }

  return facts
}

function computeLineStarts(content: string): number[] {
  const starts = [0]
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") starts.push(i + 1)
  }
  return starts
}

/** Binary search for the 1-indexed line containing `offset`. */
function lineOfOffset(lineStarts: number[], offset: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

export const PHP_RULES: PatternRule[] = [
  { kind: "route", regex: /Route::(?:get|post|put|patch|delete|any)\s*\(\s*['"]([^'"]+)['"]/gi },
  { kind: "httpCall", regex: /Http::(?:get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi },
  { kind: "httpCall", regex: /curl_setopt\s*\([^,]+,\s*CURLOPT_URL\s*,\s*['"]([^'"]+)['"]/gi },
  { kind: "queuePublish", regex: /(?:Queue::push|dispatch)\s*\(\s*(?:new\s+)?([A-Za-z0-9_\\]+)/g },
  { kind: "dbQuery", regex: /DB::(?:select|insert|update|delete|statement)\s*\(\s*['"]([^'"]+)['"]/gi },
]

export const TERRAFORM_RULES: PatternRule[] = [
  { kind: "terraformResource", regex: /resource\s+"([^"]+)"\s+"([^"]+)"/g },
  { kind: "terraformResource", regex: /data\s+"([^"]+)"\s+"([^"]+)"/g },
  { kind: "terraformResource", regex: /module\s+"([^"]+)"/g },
]

export const SHELL_RULES: PatternRule[] = [
  { kind: "httpCall", regex: /\bcurl\b[^\n]*?["']?(https?:\/\/\S+?)["']?(?=\s|$)/g },
  { kind: "httpCall", regex: /\bwget\b[^\n]*?["']?(https?:\/\/\S+?)["']?(?=\s|$)/g },
  {
    kind: "queuePublish",
    regex: /aws\s+(?:sqs|sns)\s+(?:send-message|publish)\s+.*?--(?:queue-url|topic-arn)\s+["']?(\S+?)["']?(?=\s|$)/g,
  },
  {
    kind: "scriptInvocation",
    regex: /\b(kubectl\s+apply[^\n]*|docker\s+(?:build|push|run)[^\n]*|terraform\s+(?:apply|plan)[^\n]*|ssh\s+\S+[^\n]*|scp\s+[^\n]*)/g,
  },
]

export const POWERSHELL_RULES: PatternRule[] = [
  { kind: "httpCall", regex: /Invoke-(?:RestMethod|WebRequest)\s+.*?-Uri\s+["']?([^\s"']+)["']?/gi },
  { kind: "scriptInvocation", regex: /\b(New-AzResource[^\n]*|New-AzureRmResource[^\n]*|Start-AzVM[^\n]*|Publish-AzWebapp[^\n]*)/gi },
]

export const JAVA_RULES: PatternRule[] = [
  { kind: "route", regex: /@(?:Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g },
  { kind: "route", regex: /@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g },
  { kind: "httpCall", regex: /restTemplate\.(?:getForObject|postForObject|exchange|getForEntity|postForEntity)\s*\(\s*["']([^"']+)["']/g },
  { kind: "queuePublish", regex: /kafkaTemplate\.send\s*\(\s*["']([^"']+)["']/g },
  { kind: "queueConsume", regex: /@KafkaListener\s*\(\s*(?:topics\s*=\s*)?["']([^"']+)["']/g },
  { kind: "dbQuery", regex: /@Query\s*\(\s*["']([^"']+)["']/g },
]

export const PYTHON_RULES: PatternRule[] = [
  { kind: "route", regex: /@app\.route\s*\(\s*["']([^"']+)["']/g },
  { kind: "route", regex: /@app\.(?:get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/gi },
  { kind: "route", regex: /@(?:router|blueprint)\.(?:get|post|put|delete|patch|route)\s*\(\s*["']([^"']+)["']/gi },
  { kind: "httpCall", regex: /requests\.(?:get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/gi },
  { kind: "queuePublish", regex: /\w+\.(?:delay|apply_async)\s*\(/g },
  { kind: "queueConsume", regex: /@(?:app|celery)\.task\b/gi },
]

import type { CodeFact, FactKind } from "./types.js";

/**
 * Regex-pattern fact extraction for PowerShell -- the one target language
 * with no mainstream prebuilt tree-sitter grammar (see src/ast/tree-sitter.ts
 * for PHP/Java/Python/Bash/Terraform, which all moved off regex onto real
 * parse trees). These rules target the same signal kinds (outbound HTTP
 * calls, provisioning/deploy commands) via well-scoped regexes instead.
 */
export type PatternRule = {
  kind: FactKind;
  /** Must have exactly one or more capture groups for the target, or none (falls back to the whole match). */
  regex: RegExp;
};

export function extractPatternFacts(
  filePath: string,
  content: string,
  rules: PatternRule[],
): CodeFact[] {
  const facts: CodeFact[] = [];
  const lineStarts = computeLineStarts(content);

  for (const rule of rules) {
    const flags = rule.regex.flags.includes("g") ? rule.regex.flags : `${rule.regex.flags}g`;
    const regex = new RegExp(rule.regex.source, flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content))) {
      const groups = match.slice(1).filter((g): g is string => Boolean(g));
      const target = (groups.length > 0 ? groups.join(".") : match[0]).trim();
      const line = lineOfOffset(lineStarts, match.index);
      facts.push({
        file: filePath,
        startLine: line,
        endLine: line,
        kind: rule.kind,
        target,
        snippet: match[0].slice(0, 200).replace(/\s+/g, " ").trim(),
      });
      if (match[0].length === 0) regex.lastIndex++;
    }
  }

  return facts;
}

function computeLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** Binary search for the 1-indexed line containing `offset`. */
function lineOfOffset(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export const POWERSHELL_RULES: PatternRule[] = [
  {
    kind: "httpCall",
    regex: /Invoke-(?:RestMethod|WebRequest)\s+.*?-Uri\s+["']?([^\s"']+)["']?/gi,
  },
  {
    kind: "scriptInvocation",
    regex:
      /\b(New-AzResource[^\n]*|New-AzureRmResource[^\n]*|Start-AzVM[^\n]*|Publish-AzWebapp[^\n]*)/gi,
  },
];

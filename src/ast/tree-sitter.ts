import { createRequire } from "node:module";
import type { Language as LanguageInstance, Node, Tree } from "web-tree-sitter";
import type { CodeFact, FactKind } from "./types.js";

/**
 * Real-AST fact extraction for PHP, Java, Python, Bash, and Terraform via
 * tree-sitter (web-tree-sitter + prebuilt WASM grammars -- no native
 * compilation step, unlike node-tree-sitter bindings, which keeps this
 * dependency-safe in a sandboxed/cloud build). PowerShell has no mainstream
 * prebuilt tree-sitter grammar, so it stays on the regex rules in
 * src/ast/patterns.ts.
 *
 * web-tree-sitter's ESM entry point has a bug under plain Node (a dynamic
 * `require("fs/promises")` call inside its own CJS->ESM interop shim that
 * throws "Dynamic require ... is not supported") -- loading it through
 * `createRequire` to get its CJS build instead works correctly. Verified
 * against web-tree-sitter 0.25.0 and the grammars below.
 */
const nodeRequire = createRequire(import.meta.url);
const webTreeSitter: typeof import("web-tree-sitter") = nodeRequire("web-tree-sitter");
const { Parser, Language } = webTreeSitter;

export type TreeSitterLanguageName = "php" | "java" | "python" | "bash" | "terraform";

const WASM_PATHS: Record<TreeSitterLanguageName, string> = {
  php: "tree-sitter-wasms/out/tree-sitter-php.wasm",
  java: "tree-sitter-wasms/out/tree-sitter-java.wasm",
  python: "tree-sitter-wasms/out/tree-sitter-python.wasm",
  bash: "tree-sitter-wasms/out/tree-sitter-bash.wasm",
  terraform: "@tree-sitter-grammars/tree-sitter-hcl/tree-sitter-terraform.wasm",
};

let initPromise: Promise<void> | undefined;
const languageCache = new Map<TreeSitterLanguageName, Promise<LanguageInstance>>();

function loadLanguage(name: TreeSitterLanguageName): Promise<LanguageInstance> {
  let cached = languageCache.get(name);
  if (!cached) {
    initPromise ??= Parser.init();
    cached = initPromise.then(() => Language.load(nodeRequire.resolve(WASM_PATHS[name])));
    languageCache.set(name, cached);
  }
  return cached;
}

async function parse(name: TreeSitterLanguageName, content: string): Promise<Tree | null> {
  const language = await loadLanguage(name);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser.parse(content);
}

function push(facts: CodeFact[], file: string, node: Node, kind: FactKind, target: string): void {
  facts.push({
    file,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    kind,
    target,
    snippet: node.text.slice(0, 200).replace(/\s+/g, " ").trim(),
  });
}

function definedNodes(nodes: (Node | null)[]): Node[] {
  return nodes.filter((n): n is Node => n !== null);
}

// ---------------------------------------------------------------- PHP ----

const PHP_ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "any"]);
const PHP_HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const PHP_DB_METHODS = new Set(["select", "insert", "update", "delete", "statement"]);

function phpStringLiteral(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "argument") return phpStringLiteral(node.namedChildren[0]);
  if (node.type === "string")
    return node.namedChildren.find((c) => c?.type === "string_content")?.text;
  return undefined;
}

function extractPhpFacts(file: string, tree: Tree): CodeFact[] {
  const facts: CodeFact[] = [];
  const root = tree.rootNode;

  for (const call of definedNodes(root.descendantsOfType("scoped_call_expression"))) {
    const scope = call.childForFieldName("scope")?.text;
    const method = call.childForFieldName("name")?.text?.toLowerCase();
    const args = call.childForFieldName("arguments");
    const firstArg = phpStringLiteral(args?.namedChildren[0]);
    if (!scope || !method || !firstArg) continue;

    if (scope === "Route" && PHP_ROUTE_METHODS.has(method))
      push(facts, file, call, "route", firstArg);
    else if (scope === "Http" && PHP_HTTP_METHODS.has(method))
      push(facts, file, call, "httpCall", firstArg);
    else if (scope === "DB" && PHP_DB_METHODS.has(method))
      push(facts, file, call, "dbQuery", firstArg);
    else if (scope === "Queue" && method === "push")
      push(facts, file, call, "queuePublish", firstArg);
  }

  for (const call of definedNodes(root.descendantsOfType("function_call_expression"))) {
    const func = call.childForFieldName("function")?.text;
    const args = call.childForFieldName("arguments");

    if (func === "dispatch") {
      const target =
        phpStringLiteral(args?.namedChildren[0]) ?? args?.namedChildren[0]?.text ?? "dispatch(...)";
      push(facts, file, call, "queuePublish", target.slice(0, 80));
    } else if (func === "curl_setopt" && args?.namedChildren[1]?.text === "CURLOPT_URL") {
      const target = phpStringLiteral(args.namedChildren[2]);
      if (target) push(facts, file, call, "httpCall", target);
    }
  }

  return facts;
}

// --------------------------------------------------------------- Java ----

const JAVA_ROUTE_ANNOTATIONS = new Set([
  "GetMapping",
  "PostMapping",
  "PutMapping",
  "DeleteMapping",
  "PatchMapping",
  "RequestMapping",
]);
const JAVA_HTTP_METHODS = new Set([
  "getforobject",
  "postforobject",
  "getforentity",
  "postforentity",
  "exchange",
]);

function javaStringLiteral(node: Node | null | undefined): string | undefined {
  if (!node || node.type !== "string_literal") return undefined;
  return node.namedChildren.find((c) => c?.type === "string_fragment")?.text;
}

function javaAnnotationLiteral(annotation: Node): string | undefined {
  const args = annotation.childForFieldName("arguments");
  for (const child of definedNodes(args?.namedChildren ?? [])) {
    if (child.type === "string_literal") {
      const literal = javaStringLiteral(child);
      if (literal) return literal;
    }
    if (child.type === "element_value_pair") {
      const key = child.childForFieldName("key")?.text;
      if (key === "value" || key === "path" || key === "topics") {
        const literal = javaStringLiteral(child.childForFieldName("value"));
        if (literal) return literal;
      }
    }
  }
  return undefined;
}

function extractJavaFacts(file: string, tree: Tree): CodeFact[] {
  const facts: CodeFact[] = [];
  const root = tree.rootNode;

  for (const annotation of [
    ...definedNodes(root.descendantsOfType("annotation")),
    ...definedNodes(root.descendantsOfType("marker_annotation")),
  ]) {
    const name = annotation.childForFieldName("name")?.text;
    if (!name) continue;

    if (JAVA_ROUTE_ANNOTATIONS.has(name))
      push(facts, file, annotation, "route", javaAnnotationLiteral(annotation) ?? "/");
    else if (name === "KafkaListener")
      push(
        facts,
        file,
        annotation,
        "queueConsume",
        javaAnnotationLiteral(annotation) ?? "@KafkaListener",
      );
    else if (name === "Query")
      push(facts, file, annotation, "dbQuery", javaAnnotationLiteral(annotation) ?? "@Query");
  }

  for (const call of definedNodes(root.descendantsOfType("method_invocation"))) {
    const object = call.childForFieldName("object")?.text ?? "";
    const method = call.childForFieldName("name")?.text?.toLowerCase() ?? "";
    const args = call.childForFieldName("arguments");
    const firstArg = javaStringLiteral(args?.namedChildren[0]);
    if (!firstArg) continue;

    if (/restTemplate|webClient|httpClient/i.test(object) && JAVA_HTTP_METHODS.has(method)) {
      push(facts, file, call, "httpCall", firstArg);
    } else if (/kafkaTemplate/i.test(object) && method === "send") {
      push(facts, file, call, "queuePublish", firstArg);
    }
  }

  return facts;
}

// ------------------------------------------------------------- Python ----

const PY_ROUTE_METHODS = new Set(["route", "get", "post", "put", "delete", "patch"]);
const PY_HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch"]);

function pyStringLiteral(node: Node | null | undefined): string | undefined {
  if (!node || node.type !== "string") return undefined;
  return node.namedChildren.find((c) => c?.type === "string_content")?.text;
}

function extractPythonFacts(file: string, tree: Tree): CodeFact[] {
  const facts: CodeFact[] = [];
  const root = tree.rootNode;

  for (const decorator of definedNodes(root.descendantsOfType("decorator"))) {
    const inner = decorator.namedChildren[0];
    if (!inner) continue;

    if (inner.type === "call") {
      const fn = inner.childForFieldName("function");
      const attribute =
        fn?.type === "attribute"
          ? fn.childForFieldName("attribute")?.text?.toLowerCase()
          : undefined;
      const firstArg = pyStringLiteral(inner.childForFieldName("arguments")?.namedChildren[0]);
      if (attribute && PY_ROUTE_METHODS.has(attribute) && firstArg)
        push(facts, file, decorator, "route", firstArg);
    } else if (
      inner.type === "attribute" &&
      inner.childForFieldName("attribute")?.text?.toLowerCase() === "task"
    ) {
      push(facts, file, decorator, "queueConsume", decorator.text.replace(/^@/, "").trim());
    }
  }

  for (const call of definedNodes(root.descendantsOfType("call"))) {
    const fn = call.childForFieldName("function");
    if (fn?.type !== "attribute") continue;
    const object = fn.childForFieldName("object")?.text ?? "";
    const attribute = fn.childForFieldName("attribute")?.text?.toLowerCase() ?? "";
    const firstArg = pyStringLiteral(call.childForFieldName("arguments")?.namedChildren[0]);

    if (/requests/i.test(object) && PY_HTTP_METHODS.has(attribute) && firstArg) {
      push(facts, file, call, "httpCall", firstArg);
    } else if (attribute === "delay" || attribute === "apply_async") {
      push(facts, file, call, "queuePublish", fn.text);
    }
  }

  return facts;
}

// --------------------------------------------------------------- Bash ----

const SHELL_SCRIPT_COMMANDS = new Set(["kubectl", "docker", "terraform", "ssh", "scp"]);

function stripQuotes(text: string): string {
  return text.replace(/^["']|["']$/g, "");
}

function extractBashFacts(file: string, tree: Tree): CodeFact[] {
  const facts: CodeFact[] = [];
  const root = tree.rootNode;

  for (const command of definedNodes(root.descendantsOfType("command"))) {
    const name = command.childForFieldName("name")?.text;
    if (!name) continue;
    const argTexts = definedNodes(command.namedChildren.slice(1)).map((a) => stripQuotes(a.text));

    if (name === "curl" || name === "wget") {
      const url = argTexts.find((t) => /^https?:\/\//.test(t));
      if (url) push(facts, file, command, "httpCall", url);
    } else if (name === "aws" && (argTexts.includes("sqs") || argTexts.includes("sns"))) {
      const flagIndex = argTexts.findIndex((t) => t === "--queue-url" || t === "--topic-arn");
      const target = flagIndex !== -1 ? argTexts[flagIndex + 1] : undefined;
      if (target) push(facts, file, command, "queuePublish", target);
    } else if (SHELL_SCRIPT_COMMANDS.has(name)) {
      push(facts, file, command, "scriptInvocation", command.text.slice(0, 160));
    }
  }

  return facts;
}

// ---------------------------------------------------------- Terraform ----

function hclLiteral(node: Node | null | undefined): string {
  return node?.namedChildren.find((c) => c?.type === "template_literal")?.text ?? "";
}

function extractTerraformFacts(file: string, tree: Tree): CodeFact[] {
  const facts: CodeFact[] = [];
  const root = tree.rootNode;

  for (const block of definedNodes(root.descendantsOfType("block"))) {
    const blockType = block.namedChildren[0]?.text;
    const labels = definedNodes(block.namedChildren)
      .filter((c) => c.type === "string_lit")
      .map(hclLiteral);

    if ((blockType === "resource" || blockType === "data") && labels.length > 0) {
      push(facts, file, block, "terraformResource", labels.join("."));
    } else if (blockType === "module" && labels[0]) {
      push(facts, file, block, "terraformResource", labels[0]);
    }
  }

  return facts;
}

// -------------------------------------------------------------- shared ----

export async function extractTreeSitterFacts(
  language: TreeSitterLanguageName,
  file: string,
  content: string,
): Promise<CodeFact[]> {
  try {
    const tree = await parse(language, content);
    if (!tree) return [];
    switch (language) {
      case "php":
        return extractPhpFacts(file, tree);
      case "java":
        return extractJavaFacts(file, tree);
      case "python":
        return extractPythonFacts(file, tree);
      case "bash":
        return extractBashFacts(file, tree);
      case "terraform":
        return extractTerraformFacts(file, tree);
    }
  } catch {
    // Unparsable/corrupt input or a grammar load failure -- never fail the whole repo scan over a fact-extraction hint.
    return [];
  }
}

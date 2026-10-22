/**
 * A mechanically-extracted signal about one call-site or declaration in a
 * source file -- a route registration, an outbound HTTP/queue call, a
 * Terraform resource block, etc. Unlike a Step (which an LLM infers with a
 * confidence rating), a CodeFact is deterministic: given the same file
 * content, extraction always produces the same facts. Fed into the surveyor
 * prompt alongside raw file text so the model has exact locations and
 * literal target strings to anchor on, instead of having to find and cite
 * everything itself by reading prose.
 */
export type FactKind =
  | "route" // an HTTP/RPC route or handler registration
  | "httpCall" // an outbound HTTP/HTTPS request
  | "queuePublish" // a publish/send to a queue or topic
  | "queueConsume" // a subscribe/consume/listener on a queue or topic
  | "grpcCall" // an outbound gRPC client call
  | "dbQuery" // a read/write against a datastore
  | "terraformResource" // a Terraform resource/module/data block
  | "scriptInvocation"; // a provisioning/deploy command in a bash/PowerShell script

export type CodeFact = {
  file: string;
  startLine: number;
  endLine: number;
  kind: FactKind;
  /** The literal path/topic/resource/table name extracted from the call-site, as written in source. */
  target: string;
  /** The matched source text (trimmed), for context -- not a full AST node dump. */
  snippet: string;
};

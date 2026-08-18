/**
 * The vocabulary the AI layer shares.
 *
 * Extracted from `broker-learn.ts`, which needed all of this to teach itself a
 * broker's statement layout and now shares it with the insight engine. The shape
 * of that problem turned out to be general: ask a model for JSON matching a
 * schema, validate the answer locally, and hand the failures back rather than
 * re-asking blind.
 *
 * Deliberately narrow. There is no chat here, no streaming to a UI, no tool use —
 * one method that returns the model's JSON as text. Everything above it
 * (`task.ts`) is about *not trusting* that text.
 *
 * Pure types and one error pair. No fetch, no Prisma.
 */

/** A JSON Schema document, as the structured-output APIs want it. */
export type JsonSchema = Record<string, unknown>;

export type Turn = { role: "user" | "assistant"; text: string };

/** One ask: a system prompt, a conversation, and the shape the answer must take. */
export interface StructuredRequest {
  system: string;
  turns: Turn[];
  /** JSON Schema the answer is constrained to. */
  schema: JsonSchema;
  /** snake_case name for the schema — some backends require one. */
  schemaName: string;
  /**
   * Ceiling on the answer. On a thinking model this covers reasoning *and* the
   * answer, so a tight value truncates mid-JSON rather than merely shortening it.
   */
  maxTokens: number;
}

/** A model that can answer a `StructuredRequest`. */
export interface AiProvider {
  /** Recorded against whatever the model wrote, so its author is auditable. */
  readonly label: string;
  /** Returns the raw JSON text. Parsing and validation are the caller's job. */
  complete(request: StructuredRequest): Promise<string>;
}

/** Thrown when nothing is configured to run a model with. */
export class AiUnavailableError extends Error {}

/** Thrown when the model could not produce an answer that survives validation. */
export class StructuredTaskError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
  ) {
    super(message);
  }
}

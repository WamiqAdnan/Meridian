/**
 * Ask, validate, and hand the failures back.
 *
 * The one thing every model call in this app has in common: the answer is not
 * trusted. It is parsed, checked against rules that live here in code, and only
 * used if it survives. When it doesn't, the specific failures go back to the model
 * verbatim — which is far more effective than re-asking blind, and is the reason
 * a small local model can produce a usable answer at all.
 *
 * Generalised out of `broker-learn.ts`, where the validator ran a parser spec over
 * a whole statement and checked the arithmetic closed. The insight engine's
 * validator checks that every claim cites evidence it was actually given. Same
 * loop; the loop does not care which.
 */
import { parseJsonAnswer } from "./json";
import { requireProvider } from "./provider";
import {
  StructuredTaskError,
  type AiProvider,
  type JsonSchema,
  type Turn,
} from "./types";

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * A validator's verdict.
 *
 * `repair` is the message the model sees on rejection. Supplying one is where the
 * quality is: "row 14 has a quantity of 0" gets a fix, "invalid" gets a reroll.
 * Omit it and the errors are relayed plainly.
 */
export type Review<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[]; repair?: string };

export interface StructuredTask<T> {
  system: string;
  /** The opening user message. */
  request: string;
  schema: JsonSchema;
  /** snake_case, for backends that name the schema. */
  schemaName: string;
  maxTokens: number;
  maxAttempts?: number;
  /** Check the parsed answer. Anything it throws is treated as a rejection. */
  review(draft: unknown): Review<T>;
  /** Overridable so a check script can drive the whole loop with a stub. */
  provider?: AiProvider;
  /**
   * Called after each rejected attempt — for dry-run harnesses. Seeing which
   * answer was rejected and why is the difference between "the model failed" and
   * knowing whether the prompt is at fault.
   */
  onRejected?(info: { attempt: number; answer: string; errors: string[] }): void;
}

export interface TaskOutcome<T> {
  value: T;
  /** Which model produced it. Worth storing next to whatever it wrote. */
  model: string;
  attempts: number;
}

/**
 * Run one structured task to a validated answer.
 *
 * Throws `AiUnavailableError` when nothing is configured, and
 * `StructuredTaskError` when every attempt was rejected — never a half-valid
 * answer. Refusing beats writing something plausible and wrong.
 */
export async function runStructuredTask<T>(task: StructuredTask<T>): Promise<TaskOutcome<T>> {
  const provider = task.provider ?? requireProvider();
  const maxAttempts = task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const turns: Turn[] = [{ role: "user", text: task.request }];
  let lastFailure = "the model did not return a usable answer";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const answer = await provider.complete({
      system: task.system,
      turns,
      schema: task.schema,
      schemaName: task.schemaName,
      maxTokens: task.maxTokens,
    });

    let review: Review<T>;
    try {
      review = task.review(parseJsonAnswer(answer));
    } catch (e) {
      review = { ok: false, errors: [(e as Error).message] };
    }

    if (review.ok) {
      return { value: review.value, model: provider.label, attempts: attempt };
    }

    lastFailure = review.errors.join(" ");
    task.onRejected?.({ attempt, answer, errors: review.errors });
    turns.push(
      { role: "assistant", text: answer },
      { role: "user", text: review.repair ?? defaultRepair(review.errors) },
    );
  }

  throw new StructuredTaskError(
    `No usable answer after ${maxAttempts} attempts. Last problem: ${lastFailure}`,
    maxAttempts,
  );
}

function defaultRepair(errors: string[]): string {
  return `That answer was rejected:\n${errors.map((e) => `- ${e}`).join("\n")}\n\nReturn a corrected answer.`;
}

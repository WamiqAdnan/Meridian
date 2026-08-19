/**
 * Getting JSON out of an answer that was supposed to be nothing but JSON.
 *
 * Both backends are asked for schema-constrained output, so in the good case this
 * is `JSON.parse`. Small local models still wrap the object in prose or a fence
 * often enough to be worth the fallback, and a broken answer should read as a
 * validation failure the model can be told about — not as a crash.
 *
 * Pure.
 */

/** Thrown when an answer holds no parseable JSON object. */
export class NotJsonError extends Error {}

/**
 * Parse a model's answer, tolerating a prose or fenced wrapper.
 *
 * Returns `unknown` on purpose: a schema-constrained answer is still just bytes
 * off a network, and the caller validates it before believing any of it.
 */
export function parseJsonAnswer(text: string): unknown {
  if (!text.trim()) throw new NotJsonError("The model returned nothing.");
  try {
    return JSON.parse(text);
  } catch {
    // Take the outermost object and try again.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) throw new NotJsonError("The model's answer wasn't JSON.");
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new NotJsonError("The model's answer wasn't JSON.");
    }
  }
}

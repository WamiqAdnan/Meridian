/**
 * The AI layer's public surface.
 *
 * One model-backed capability, used by two callers that have nothing else in
 * common: `broker-learn.ts` writes a parser for an unfamiliar statement, and
 * `insights/` explains a week in a market. Both ask for schema-shaped JSON and
 * neither believes a word of it until it validates.
 */
export { parseJsonAnswer, NotJsonError } from "./json";
export { aiBackendLabel, isAiConfigured, requireProvider, resolveProvider } from "./provider";
export { runStructuredTask, type Review, type StructuredTask, type TaskOutcome } from "./task";
export {
  AiUnavailableError,
  StructuredTaskError,
  type AiProvider,
  type JsonSchema,
  type StructuredRequest,
  type Turn,
} from "./types";

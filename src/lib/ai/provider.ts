/**
 * Which model to run, and how to talk to it.
 *
 * Two backends, chosen by environment: the Anthropic API, or any OpenAI-compatible
 * server — Ollama, LM Studio, llama.cpp, vLLM. Pointing it at a local model means
 * the prompt never leaves the machine, which for financial statements is the more
 * interesting property of the two.
 *
 * Both are asked for JSON constrained by a schema, which is the whole reason this
 * file only has one method: everything downstream assumes the answer is JSON and
 * checks it anyway.
 */
import Anthropic from "@anthropic-ai/sdk";
import { AiUnavailableError, type AiProvider, type StructuredRequest } from "./types";

const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";

/**
 * Local models are slow — a reasoning model on consumer hardware can spend minutes
 * on one answer — and these tasks run once per broker or once per week, so wait
 * rather than fail. Override with AI_TIMEOUT_MS.
 */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Read the first of these variables that is set.
 *
 * The `LEARNING_*` names came first, when learning a broker's layout was the only
 * thing here that called a model. They still work — they are what is documented in
 * `.env` and what the user has configured — but `AI_*` is the name that describes
 * what this actually is now, and it wins where both are set.
 */
function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

/**
 * Which backend to run with:
 *   AI_BASE_URL   an OpenAI-compatible endpoint, e.g. http://localhost:11434/v1
 *                 (with AI_MODEL naming the model). Wins when set.
 *   ANTHROPIC_API_KEY  the Anthropic API, on AI_MODEL or claude-opus-5.
 */
export function resolveProvider(): AiProvider | null {
  const baseUrl = env("AI_BASE_URL", "LEARNING_BASE_URL")?.replace(/\/$/, "");
  if (baseUrl) {
    const model = env("AI_MODEL", "LEARNING_MODEL");
    if (!model) {
      throw new AiUnavailableError(
        "AI_BASE_URL is set but AI_MODEL isn't — name the model to use.",
      );
    }
    return openAiCompatibleProvider(baseUrl, model, env("AI_API_KEY", "LEARNING_API_KEY"));
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return anthropicProvider(env("AI_MODEL", "LEARNING_MODEL") ?? DEFAULT_ANTHROPIC_MODEL);
  }
  return null;
}

export function isAiConfigured(): boolean {
  try {
    return resolveProvider() !== null;
  } catch {
    return false; // misconfigured counts as unavailable; the error explains why
  }
}

/** Where a model would run, for display. `null` when none can. */
export function aiBackendLabel(): string | null {
  try {
    return resolveProvider()?.label ?? null;
  } catch {
    return null;
  }
}

/** The configured provider, or a thrown explanation of why there isn't one. */
export function requireProvider(): AiProvider {
  const provider = resolveProvider();
  if (!provider) {
    throw new AiUnavailableError(
      "Nothing is configured to run a model with. Set ANTHROPIC_API_KEY, or point AI_BASE_URL and AI_MODEL at a local model.",
    );
  }
  return provider;
}

function anthropicProvider(model: string): AiProvider {
  return {
    label: model,
    async complete(request: StructuredRequest) {
      const client = new Anthropic();
      const message = await client.messages.create({
        model,
        max_tokens: request.maxTokens,
        system: request.system,
        output_config: { format: { type: "json_schema", schema: request.schema } },
        messages: request.turns.map((t) => ({ role: t.role, content: t.text })),
      });
      return message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
    },
  };
}

/**
 * Read an OpenAI-style SSE stream down to its concatenated content.
 *
 * We stream even though we only want the final JSON: a local model can think for
 * minutes before its first token, and an unstreamed response sends no headers until
 * it finishes — which trips Node's 300s headers timeout regardless of our own.
 */
async function readStream(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let content = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });

    const lines = buffered.split("\n");
    buffered = lines.pop() ?? ""; // keep the partial line for the next chunk
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        content += chunk.choices?.[0]?.delta?.content ?? "";
      } catch {
        // A keepalive or a comment frame; nothing to add.
      }
    }
  }
  return content;
}

function timeoutMs(): number {
  const raw = Number(env("AI_TIMEOUT_MS", "LEARNING_TIMEOUT_MS"));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Any server speaking OpenAI's /chat/completions with `response_format:
 * json_schema` — which is how Ollama, LM Studio, llama.cpp and vLLM all expose
 * grammar-constrained decoding.
 */
function openAiCompatibleProvider(baseUrl: string, model: string, apiKey?: string): AiProvider {
  const reasoningEffort = env("AI_REASONING_EFFORT", "LEARNING_REASONING_EFFORT");
  return {
    label: `${model} (${new URL(baseUrl).host})`,
    async complete(request: StructuredRequest) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Local servers ignore this; hosted ones need it.
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: request.system },
            ...request.turns.map((t) => ({ role: t.role, content: t.text })),
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: request.schemaName, strict: true, schema: request.schema },
          },
          // No max_tokens on this path, deliberately: `request.maxTokens` is sized
          // for a hosted model's billing, and a local reasoning model routinely
          // spends more than that thinking before it writes a character. Capping it
          // here truncates mid-JSON. The timeout is the bound that matters locally.
          temperature: 0,
          stream: true,
          // Thinking generally earns its keep here — inferring a regex from a table,
          // or weighing a headline against a price move — so it's left on unless
          // asked otherwise. Set AI_REASONING_EFFORT=none to trade quality for speed
          // on a local reasoning model.
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs()),
      });

      if (!res.ok) {
        throw new Error(`${model} at ${baseUrl} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      if (!res.body) throw new Error(`${model} at ${baseUrl} returned an empty response.`);

      const content = await readStream(res.body);
      // Reasoning models sometimes leak a think block into the content despite the
      // schema; the JSON is what follows it.
      return content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    },
  };
}

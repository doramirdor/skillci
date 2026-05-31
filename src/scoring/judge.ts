/**
 * LLM-as-judge — the qualitative dimension of scoring.
 *
 * Scores an agent run against a task's {@link JudgeRubric} using the Anthropic
 * SDK. The rubric/system block is sent with `cache_control` so repeated judging
 * across many tasks/configs reuses the cached prompt prefix (prompt caching).
 *
 * The judge is OPTIONAL and must never throw in a way that breaks scoring:
 * - If no `ANTHROPIC_API_KEY` is present (and no client is injected), it returns
 *   `undefined` — the judge dimension is simply omitted.
 * - Any API/parse error is swallowed and also yields `undefined`.
 * - Tests inject a fake {@link JudgeFn} to stay fully offline.
 */
import Anthropic from '@anthropic-ai/sdk';

import type { AgentRunResult, JudgeScore, SandboxResult, Task } from '../core/index.js';

/** The default model used for judging when none is configured. */
export const DEFAULT_JUDGE_MODEL = 'claude-3-5-sonnet-latest';

/**
 * The pluggable judging function. Real judging goes through Anthropic; tests
 * inject a deterministic fake. Returning `undefined` means "no judgment"
 * (e.g. judge disabled / unavailable) and the dimension is dropped.
 */
export interface JudgeFn {
  (task: Task, runResult: AgentRunResult, sandbox: SandboxResult): Promise<JudgeScore | undefined>;
}

/** Options controlling {@link judgeWithLLM}. */
export interface JudgeOptions {
  /**
   * Inject a fake judge (tests, or to swap the backend entirely). When set,
   * this is used verbatim and no Anthropic client is constructed.
   */
  judgeFn?: JudgeFn;
  /** Anthropic model id. Defaults to {@link DEFAULT_JUDGE_MODEL}. */
  model?: string;
  /** Inject an Anthropic client (tests). When absent one is built from env. */
  client?: Pick<Anthropic, 'messages'>;
  /**
   * Explicit API key. Falls back to `process.env.ANTHROPIC_API_KEY`. When
   * neither is present and no client/judgeFn is injected, judging is skipped.
   */
  apiKey?: string;
  /** Max tokens for the judge's JSON response. */
  maxTokens?: number;
}

/**
 * Judge an agent run against the task rubric.
 *
 * Returns `undefined` when there is no rubric, judging is unavailable, or any
 * error occurs — judging is strictly best-effort and never throws.
 */
export async function judgeWithLLM(
  task: Task,
  runResult: AgentRunResult,
  sandbox: SandboxResult,
  options: JudgeOptions = {},
): Promise<JudgeScore | undefined> {
  // No rubric => nothing to judge.
  if (!task.judgeRubric) return undefined;

  // Injected judge wins (tests / alternate backends).
  if (options.judgeFn) {
    try {
      return await options.judgeFn(task, runResult, sandbox);
    } catch {
      return undefined;
    }
  }

  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const client = options.client ?? (apiKey ? new Anthropic({ apiKey }) : undefined);
  if (!client) return undefined; // offline / no key => skip gracefully.

  const model = options.model ?? DEFAULT_JUDGE_MODEL;
  const maxTokens = options.maxTokens ?? 512;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      // The rubric + instructions form a stable prefix across runs; cache it.
      system: [
        {
          type: 'text',
          text: buildJudgeSystemPrompt(task.judgeRubric.criteria),
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: buildJudgeUserPrompt(task, runResult),
        },
      ],
    });

    return parseJudgeResponse(extractText(response.content));
  } catch {
    // Network/auth/parse failure: judge is optional, degrade silently.
    return undefined;
  }
}

/** The stable, cacheable system prompt: rubric + fixed output contract. */
export function buildJudgeSystemPrompt(criteria: string): string {
  return [
    'You are an impartial evaluator (LLM-as-judge) for SkillCI, a CI system that',
    'tests changes to coding-agent configuration. You score how well a coding',
    "agent's run satisfies a rubric.",
    '',
    'Score STRICTLY against the rubric below. Do not reward effort or verbosity.',
    '',
    'RUBRIC:',
    criteria,
    '',
    'Respond with ONLY a single JSON object, no prose, no markdown fences:',
    '{"score": <number between 0 and 1>, "rationale": "<one or two sentences>"}',
  ].join('\n');
}

/** The per-run user prompt: the task and the agent transcript under review. */
export function buildJudgeUserPrompt(task: Task, runResult: AgentRunResult): string {
  return [
    `TASK TITLE: ${task.title}`,
    `TASK PROMPT GIVEN TO AGENT:`,
    task.prompt,
    '',
    `AGENT TRANSCRIPT / FINAL OUTPUT:`,
    runResult.transcript,
    '',
    'Score this run against the rubric.',
  ].join('\n');
}

/**
 * Parse the judge's JSON reply into a {@link JudgeScore}. Tolerant of fenced
 * code blocks and surrounding prose; clamps score into [0, 1]. Returns
 * `undefined` if nothing parseable is found.
 */
export function parseJudgeResponse(text: string): JudgeScore | undefined {
  const json = extractJsonObject(text);
  if (!json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const rawScore = obj.score;
  if (typeof rawScore !== 'number' || Number.isNaN(rawScore)) return undefined;
  const score0to1 = clamp01(rawScore);
  const rationale = typeof obj.rationale === 'string' ? obj.rationale : '';
  return { score0to1, rationale };
}

function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  return text.slice(start, end + 1);
}

/** Concatenate the text from a message's content blocks. */
function extractText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim();
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

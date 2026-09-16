import {
  Agent,
  type SDKAgent,
  type SDKCustomTool,
  type SDKJsonValue,
  type SDKMessage,
} from "@cursor/sdk";
import {
  AgentRunner,
  AgentSession,
  OpenSessionOptions,
  RunEvent,
  RunRequest,
  RunResult,
  RunUsage,
} from "./runner.js";

export interface CursorRunnerConfig {
  apiKey: string;
  model: string;
  sandbox?: boolean;
  autoReview?: boolean;
}

class CursorSession implements AgentSession {
  readonly id: string;

  constructor(private readonly agent: SDKAgent) {
    this.id = agent.agentId;
  }

  async run(
    request: RunRequest,
    onEvent?: (event: RunEvent) => void,
  ): Promise<RunResult> {
    const run = await this.agent.send(request.prompt, {
      mode: request.mode ?? "agent",
    });

    if (onEvent) {
      for await (const event of run.stream()) {
        emitEvent(event, onEvent);
      }
    }

    const result = await run.wait();
    const branch = result.git?.branches[0]?.branch;
    return {
      text: result.result ?? "",
      status: result.status,
      ...(branch ? { branch } : {}),
      ...(result.usage
        ? {
            usage: {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              totalTokens: result.usage.totalTokens,
            },
          }
        : {}),
      ...(result.requestId ? { requestId: result.requestId } : {}),
      ...(result.error?.message ? { error: result.error.message } : {}),
    };
  }

  async getUsage(): Promise<RunUsage> {
    const { usage } = await this.agent.getUsage();
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    };
  }

  async dispose(): Promise<void> {
    await this.agent[Symbol.asyncDispose]();
  }
}

export class CursorAgentRunner implements AgentRunner {
  readonly kind = "cursor" as const;

  constructor(private readonly config: CursorRunnerConfig) {}

  async open(options: OpenSessionOptions): Promise<AgentSession> {
    if (options.allowTools?.length || options.denyTools?.length) {
      throw new Error(
        "The current Cursor SDK does not expose per-agent allowTools/denyTools. Use repository permissions and hooks.",
      );
    }

    const customTools = options.tools
      ? Object.fromEntries(
          Object.entries(options.tools).map(([name, tool]) => {
            const sdkTool: SDKCustomTool = {
              description: tool.description,
              inputSchema: tool.inputSchema as Record<string, SDKJsonValue>,
              annotations: {
                readOnlyHint: tool.readOnly ?? false,
                destructiveHint: false,
                idempotentHint: tool.readOnly ?? false,
                openWorldHint: false,
              },
              execute: (args) => tool.execute(args),
            };
            return [name, sdkTool];
          }),
        )
      : undefined;

    const agent = await Agent.create({
      apiKey: this.config.apiKey,
      model: { id: this.config.model },
      ...(options.label ? { name: options.label } : {}),
      local: {
        cwd: options.cwd,
        autoReview: this.config.autoReview ?? true,
        sandboxOptions: { enabled: this.config.sandbox ?? true },
        ...(customTools ? { customTools } : {}),
      },
    });

    return new CursorSession(agent);
  }
}

function emitEvent(
  event: SDKMessage,
  onEvent: (event: RunEvent) => void,
): void {
  switch (event.type) {
    case "assistant":
      for (const block of event.message.content) {
        if (block.type === "text") {
          onEvent({ type: "assistant", text: block.text });
        }
      }
      break;
    case "thinking":
      onEvent({ type: "thinking", text: event.text });
      break;
    case "tool_call":
      onEvent({
        type: "tool_call",
        name: event.name,
        status: event.status,
      });
      break;
    case "status":
      onEvent({ type: "status", status: event.status });
      break;
  }
}

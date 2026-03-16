import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
  type RuntimeMode,
  type ProviderInteractionMode,
} from "@t3tools/contracts";

type OpenCodeSessionStatus = "idle" | "busy" | "retry";

interface OpenCodeSessionSnapshot {
  readonly id: string;
  readonly title: string;
}

interface OpenCodeRuntimeSessionContext {
  session: ProviderSession;
  readonly providerSessionId: string;
  activeTurnId?: TurnId;
  pendingApprovalIds: Set<ApprovalRequestId>;
  pendingUserInputIds: Set<ApprovalRequestId>;
}

export interface OpenCodeStartSessionInput {
  readonly threadId: ThreadId;
  readonly provider?: "opencode";
  readonly cwd?: string;
  readonly model?: string;
  readonly resumeCursor?: unknown;
  readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
  readonly runtimeMode: RuntimeMode;
}

export interface OpenCodeSendTurnInput {
  readonly threadId: ThreadId;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{ type: "image"; url: string }>;
  readonly model?: string;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface OpenCodeThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface OpenCodeThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<OpenCodeThreadTurnSnapshot>;
}

export interface OpenCodePermissionResponse {
  readonly response: "once" | "always" | "reject";
}

export interface OpenCodeRuntimeClient {
  readonly createSession: (input: { title?: string }) => Promise<OpenCodeSessionSnapshot>;
  readonly getSession: (sessionId: string) => Promise<OpenCodeSessionSnapshot>;
  readonly listSessions: () => Promise<ReadonlyArray<OpenCodeSessionSnapshot>>;
  readonly deleteSession: (sessionId: string) => Promise<boolean>;
  readonly abortSession: (sessionId: string) => Promise<boolean>;
  readonly promptAsync: (input: {
    sessionId: string;
    messageId: string;
    providerId: string;
    modelId: string;
    text: string;
  }) => Promise<void>;
  readonly listMessages: (sessionId: string) => Promise<ReadonlyArray<{ info: { id: string }; parts: unknown[] }>>;
  readonly revertSession: (sessionId: string, messageId: string) => Promise<void>;
  readonly respondToPermission: (
    sessionId: string,
    permissionId: string,
    response: OpenCodePermissionResponse,
  ) => Promise<void>;
}

export interface OpenCodeRuntimeEventEnvelope {
  readonly directory?: string;
  readonly payload: {
    readonly type: string;
    readonly properties: Record<string, unknown>;
  };
}

export interface OpenCodeRuntimeManagerEvents {
  event: [event: ProviderEvent];
}

const DEFAULT_OPENCODE_MODEL = "github-copilot/gpt-5.4";

function splitModelProvider(model: string | undefined): { providerId: string; modelId: string } {
  const normalized = model?.trim() || DEFAULT_OPENCODE_MODEL;
  const index = normalized.indexOf("/");
  if (index === -1) {
    return { providerId: "github-copilot", modelId: normalized };
  }
  return {
    providerId: normalized.slice(0, index),
    modelId: normalized.slice(index + 1),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeEventId(): EventId {
  return EventId.makeUnsafe(randomUUID());
}

function makeTurnId(): TurnId {
  return TurnId.makeUnsafe(`turn_${randomUUID()}`);
}

function normalizeResumeCursor(resumeCursor: unknown): { sessionId?: string } | undefined {
  const record = asObject(resumeCursor);
  const sessionId = asString(record?.sessionId);
  return sessionId ? { sessionId } : undefined;
}

function messageTextFromParts(parts: ReadonlyArray<unknown>): string {
  const text = parts
    .map((part) => {
      const record = asObject(part);
      if (!record) return undefined;
      const type = asString(record.type);
      if (type === "text" || type === "reasoning") {
        return asString(record.text);
      }
      return undefined;
    })
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
  return text;
}

export class OpenCodeRuntimeManager extends EventEmitter<OpenCodeRuntimeManagerEvents> {
  private readonly sessions = new Map<ThreadId, OpenCodeRuntimeSessionContext>();

  constructor(private readonly client: OpenCodeRuntimeClient) {
    super();
  }

  async startSession(input: OpenCodeStartSessionInput): Promise<ProviderSession> {
    const existingResume = normalizeResumeCursor(input.resumeCursor);
    const providerSession = existingResume?.sessionId
      ? await this.client.getSession(existingResume.sessionId)
      : await this.client.createSession({ title: `Thread ${input.threadId}` });

    const now = nowIso();
    const session: ProviderSession = {
      provider: "opencode",
      status: "ready",
      runtimeMode: input.runtimeMode,
      threadId: input.threadId,
      cwd: input.cwd,
      model: input.model ?? DEFAULT_OPENCODE_MODEL,
      resumeCursor: { sessionId: providerSession.id },
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(input.threadId, {
      session,
      providerSessionId: providerSession.id,
      pendingApprovalIds: new Set(),
      pendingUserInputIds: new Set(),
    });

    this.emitProviderEvent({
      kind: "session",
      provider: "opencode",
      threadId: input.threadId,
      method: "session/started",
      message: "OpenCode session started",
      payload: { resumeCursor: session.resumeCursor, sessionId: providerSession.id },
    });
    this.emitProviderEvent({
      kind: "notification",
      provider: "opencode",
      threadId: input.threadId,
      method: "thread/started",
      payload: { thread: { id: providerSession.id } },
    });
    this.emitProviderEvent({
      kind: "notification",
      provider: "opencode",
      threadId: input.threadId,
      method: "session/ready",
      message: `Connected to OpenCode session ${providerSession.id}`,
    });

    return session;
  }

  async sendTurn(input: OpenCodeSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    const turnId = makeTurnId();
    context.activeTurnId = turnId;
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt: nowIso(),
    };

    const textParts = [input.input ?? ""];
    for (const attachment of input.attachments ?? []) {
      if (attachment.type === "image") {
        textParts.push(`Attached image: ${attachment.url}`);
      }
    }
    const text = textParts.filter((value) => value.trim().length > 0).join("\n\n");
    const modelId = input.model ?? context.session.model ?? DEFAULT_OPENCODE_MODEL;
    const resolvedModel = splitModelProvider(modelId);
    await this.client.promptAsync({
      sessionId: context.providerSessionId,
      messageId: `msg_${randomUUID()}`,
      providerId: resolvedModel.providerId,
      modelId: resolvedModel.modelId,
      text,
    });

    this.emitProviderEvent({
      kind: "notification",
      provider: "opencode",
      threadId: input.threadId,
      turnId,
      method: "turn/started",
      payload: {
        turn: {
          id: turnId,
          model: modelId,
          interactionMode: input.interactionMode ?? "default",
        },
      },
    });

    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: { sessionId: context.providerSessionId },
    };
  }

  async interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    const context = this.requireSession(threadId);
    await this.client.abortSession(context.providerSessionId);
    this.emitProviderEvent({
      kind: "notification",
      provider: "opencode",
      threadId,
      ...(turnId ? { turnId } : {}),
      method: "turn/aborted",
      message: "OpenCode turn aborted",
      payload: { reason: "Turn aborted by user" },
    });
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    await this.client.respondToPermission(context.providerSessionId, requestId, {
      response:
        decision === "acceptForSession"
          ? "always"
          : decision === "accept"
            ? "once"
            : "reject",
    });
    context.pendingApprovalIds.delete(requestId);
    this.emitProviderEvent({
      kind: "notification",
      provider: "opencode",
      threadId,
      requestId,
      method: "serverRequest/resolved",
      payload: {
        requestId,
        response: decision,
        request: { method: "item/commandExecution/requestApproval" },
      },
    });
  }

  async respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    context.pendingUserInputIds.delete(requestId);
    this.emitProviderEvent({
      kind: "notification",
      provider: "opencode",
      threadId,
      requestId,
      method: "item/tool/requestUserInput/answered",
      payload: { answers },
    });
  }

  stopSession(threadId: ThreadId): void {
    this.sessions.delete(threadId);
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values(), (context) => context.session);
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  async readThread(threadId: ThreadId): Promise<OpenCodeThreadSnapshot> {
    const context = this.requireSession(threadId);
    const messages = await this.client.listMessages(context.providerSessionId);
    return {
      threadId,
      turns: messages.map((message) => ({
        id: TurnId.makeUnsafe(message.info.id),
        items: message.parts,
      })),
    };
  }

  async rollbackThread(threadId: ThreadId, numTurns: number): Promise<OpenCodeThreadSnapshot> {
    const context = this.requireSession(threadId);
    const messages = await this.client.listMessages(context.providerSessionId);
    const candidates = messages.filter((message) => message.parts.length > 0);
    const target = candidates.at(-Math.max(1, numTurns));
    if (target) {
      await this.client.revertSession(context.providerSessionId, target.info.id);
    }
    return this.readThread(threadId);
  }

  stopAll(): void {
    this.sessions.clear();
  }

  ingestEvent(event: OpenCodeRuntimeEventEnvelope): void {
    const payloadType = event.payload.type;
    const properties = event.payload.properties;
    const sessionId = asString(properties.sessionID);
    const context = sessionId ? this.findSessionByProviderSessionId(sessionId) : undefined;
    if (!context) {
      return;
    }

    switch (payloadType) {
      case "session.status": {
        const status = asObject(properties.status);
        const statusType = asString(status?.type) as OpenCodeSessionStatus | undefined;
        this.emitProviderEvent({
          kind: "notification",
          provider: "opencode",
          threadId: context.session.threadId,
          method: statusType === "busy" ? "session/running" : "session/ready",
          payload: { state: statusType ?? "idle", detail: properties },
        });
        return;
      }

      case "message.part.updated": {
        const part = asObject(properties.part);
        const delta = asString(properties.delta);
        if (!part) return;
        this.handleMessagePartUpdated(context, part, delta);
        return;
      }

      case "message.updated": {
        const info = asObject(properties.info);
        if (!info) return;
        const role = asString(info.role);
        if (role !== "assistant") return;
        const error = asObject(info.error);
        if (error) {
          this.emitProviderEvent({
            kind: "error",
            provider: "opencode",
            threadId: context.session.threadId,
            turnId: context.activeTurnId,
            method: "runtime/error",
            message: asString(asObject(error.data)?.message) ?? "OpenCode assistant error",
            payload: { error },
          });
        }
        return;
      }

      case "permission.updated": {
        const permissionId = asString(properties.id);
        if (!permissionId) return;
        const requestId = ApprovalRequestId.makeUnsafe(permissionId);
        context.pendingApprovalIds.add(requestId);
        this.emitProviderEvent({
          kind: "request",
          provider: "opencode",
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          requestId,
          requestKind: "command",
          method: "item/commandExecution/requestApproval",
          payload: {
            command: asString(properties.title) ?? "Tool approval required",
            metadata: properties.metadata,
          },
        });
        return;
      }

      case "permission.replied": {
        const permissionId = asString(properties.permissionID);
        if (!permissionId) return;
        const requestId = ApprovalRequestId.makeUnsafe(permissionId);
        context.pendingApprovalIds.delete(requestId);
        this.emitProviderEvent({
          kind: "notification",
          provider: "opencode",
          threadId: context.session.threadId,
          requestId,
          method: "serverRequest/resolved",
          payload: {
            requestId,
            response: asString(properties.response),
            request: { method: "item/commandExecution/requestApproval" },
          },
        });
        return;
      }

      case "session.idle": {
        const activeTurnId = context.activeTurnId;
        if (!activeTurnId) return;
        context.activeTurnId = undefined;
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: nowIso(),
        };
        this.emitProviderEvent({
          kind: "notification",
          provider: "opencode",
          threadId: context.session.threadId,
          turnId: activeTurnId,
          method: "turn/completed",
          payload: {
            turn: {
              id: activeTurnId,
              status: "completed",
            },
          },
        });
        return;
      }

      case "session.error": {
        const error = asObject(properties.error);
        const message = asString(asObject(error?.data)?.message) ?? "OpenCode session error";
        this.emitProviderEvent({
          kind: "error",
          provider: "opencode",
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          method: "runtime/error",
          message,
          payload: properties,
        });
        return;
      }
    }
  }

  private handleMessagePartUpdated(
    context: OpenCodeRuntimeSessionContext,
    part: Record<string, unknown>,
    delta: string | undefined,
  ): void {
    const partType = asString(part.type);
    const partId = asString(part.id) ?? `part_${randomUUID()}`;
    const itemId = ProviderItemId.makeUnsafe(partId);
    const turnId = context.activeTurnId;
    if (!turnId) {
      return;
    }

    if (partType === "text") {
      if (delta && delta.length > 0) {
        this.emitProviderEvent({
          kind: "notification",
          provider: "opencode",
          threadId: context.session.threadId,
          turnId,
          itemId,
          method: "item/agentMessage/delta",
          textDelta: delta,
          payload: { delta },
        });
      }
      return;
    }

    if (partType === "reasoning") {
      const text = delta ?? asString(part.text);
      if (!text) return;
      this.emitProviderEvent({
        kind: "notification",
        provider: "opencode",
        threadId: context.session.threadId,
        turnId,
        itemId,
        method: "item/reasoning/textDelta",
        textDelta: text,
        payload: { delta: text },
      });
      return;
    }

    if (partType === "tool") {
      const state = asObject(part.state);
      const status = asString(state?.status);
      const toolName = asString(part.tool) ?? "tool";
      if (status === "running") {
        this.emitProviderEvent({
          kind: "notification",
          provider: "opencode",
          threadId: context.session.threadId,
          turnId,
          itemId,
          method: "item/started",
          payload: {
            item: {
              type: toolName.includes("command") ? "command_execution" : "dynamic_tool_call",
              title: asString(state?.title) ?? toolName,
            },
          },
        });
        return;
      }
      if (status === "completed" || status === "error") {
        const output = asString(state?.output) ?? asString(state?.error) ?? messageTextFromParts([]);
        if (output) {
          this.emitProviderEvent({
            kind: "notification",
            provider: "opencode",
            threadId: context.session.threadId,
            turnId,
            itemId,
            method: toolName.includes("command")
              ? "item/commandExecution/outputDelta"
              : "item/agentMessage/delta",
            textDelta: output,
            payload: { delta: output },
          });
        }
        this.emitProviderEvent({
          kind: "notification",
          provider: "opencode",
          threadId: context.session.threadId,
          turnId,
          itemId,
          method: "item/completed",
          payload: {
            item: {
              type: toolName.includes("command") ? "command_execution" : "dynamic_tool_call",
              title: toolName,
              summary: output,
            },
          },
        });
      }
    }
  }

  private requireSession(threadId: ThreadId): OpenCodeRuntimeSessionContext {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`Unknown provider session: ${threadId}`);
    }
    return session;
  }

  private findSessionByProviderSessionId(
    sessionId: string,
  ): OpenCodeRuntimeSessionContext | undefined {
    for (const session of this.sessions.values()) {
      if (session.providerSessionId === sessionId) {
        return session;
      }
    }
    return undefined;
  }

  private emitProviderEvent(
    input: Omit<ProviderEvent, "id" | "createdAt"> & { createdAt?: string },
  ): void {
    this.emit("event", {
      ...input,
      id: makeEventId(),
      createdAt: input.createdAt ?? nowIso(),
    });
  }
}

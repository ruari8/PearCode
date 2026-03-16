import {
  type CanonicalItemType,
  type CanonicalRequestType,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import {
  OpenCodeRuntimeManager,
  type OpenCodeRuntimeClient,
  type OpenCodeRuntimeEventEnvelope,
} from "../../opencodeRuntimeManager.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { OpenCodeAdapter, type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "opencode" as const;

export interface OpenCodeAdapterLiveOptions {
  readonly manager?: OpenCodeRuntimeManager;
  readonly client?: OpenCodeRuntimeClient;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

type OpenCodeSdkResponse = {
  readonly data?: unknown;
};

function unwrapResponse<T>(response: OpenCodeSdkResponse | T): T {
  if (response && typeof response === "object" && "data" in (response as Record<string, unknown>)) {
    return ((response as OpenCodeSdkResponse).data ?? response) as T;
  }
  return response as T;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeItemType(raw: unknown): string {
  const type = asString(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toCanonicalItemType(raw: unknown): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning")) return "reasoning";
  if (type.includes("plan")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch")) return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("tool")) return "dynamic_tool_call";
  if (type.includes("error")) return "error";
  return "unknown";
}

function toRequestType(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    default:
      return "unknown";
  }
}

function eventRawSource(event: ProviderEvent): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "opencode.server.request" : "opencode.server.event";
}

function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: RuntimeItemId.makeUnsafe(event.itemId) } : {}),
    ...(event.requestId ? { requestId: RuntimeRequestId.makeUnsafe(event.requestId) } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);

  if (event.kind === "error") {
    if (!event.message) return [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: event.message,
          class: "provider_error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.kind === "request") {
    if (event.method === "item/tool/requestUserInput") {
      const questions = payload?.questions;
      if (!Array.isArray(questions)) return [];
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: {
            questions: questions as ProviderRuntimeEvent["payload"] extends { questions: infer T }
              ? T
              : never,
          },
        },
      ];
    }

    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType: toRequestType(event.method),
          ...(asString(payload?.command) ? { detail: asString(payload?.command) } : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  switch (event.method) {
    case "session/started":
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "session.started",
          payload: {
            ...(event.message ? { message: event.message } : {}),
            ...(payload ? { resume: payload } : {}),
          },
        },
      ];
    case "session/ready":
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "session.state.changed",
          payload: {
            state: "ready",
            ...(event.message ? { reason: event.message } : {}),
          },
        },
      ];
    case "session/running":
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "session.state.changed",
          payload: {
            state: "running",
            ...(event.message ? { reason: event.message } : {}),
            ...(payload ? { detail: payload } : {}),
          },
        },
      ];
    case "thread/started":
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "thread.started",
          payload: {
            ...(asString(asObject(payload?.thread)?.id) ? { providerThreadId: asString(asObject(payload?.thread)?.id) } : {}),
          },
        },
      ];
    case "turn/started":
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.started",
          payload: {
            ...(asString(asObject(payload?.turn)?.model) ? { model: asString(asObject(payload?.turn)?.model) } : {}),
          },
        },
      ];
    case "turn/completed":
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.completed",
          payload: {
            state: "completed",
          },
        },
      ];
    case "turn/aborted":
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.aborted",
          payload: {
            reason: event.message ?? "Turn aborted",
          },
        },
      ];
    case "item/started": {
      const item = asObject(payload?.item) ?? payload;
      if (!item) return [];
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          ...(event.itemId ? { itemId: RuntimeItemId.makeUnsafe(event.itemId) } : {}),
          type: "item.started",
          payload: {
            itemType: toCanonicalItemType(item.type ?? item.kind),
            status: "inProgress",
            ...(asString(item.title) ? { title: asString(item.title) } : {}),
            ...(asString(item.summary) ? { detail: asString(item.summary) } : {}),
            ...(payload ? { data: payload } : {}),
          },
        },
      ];
    }
    case "item/completed": {
      const item = asObject(payload?.item) ?? payload;
      if (!item) return [];
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          ...(event.itemId ? { itemId: RuntimeItemId.makeUnsafe(event.itemId) } : {}),
          type: "item.completed",
          payload: {
            itemType: toCanonicalItemType(item.type ?? item.kind),
            status: asString(item.status) === "error" ? "failed" : "completed",
            ...(asString(item.title) ? { title: asString(item.title) } : {}),
            ...(asString(item.summary) ? { detail: asString(item.summary) } : {}),
            ...(payload ? { data: payload } : {}),
          },
        },
      ];
    }
    case "item/agentMessage/delta":
    case "item/reasoning/textDelta":
    case "item/commandExecution/outputDelta": {
      const delta = event.textDelta ?? asString(payload?.delta) ?? asString(payload?.text);
      if (!delta) return [];
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "content.delta",
          payload: {
            streamKind:
              event.method === "item/reasoning/textDelta"
                ? "reasoning_text"
                : event.method === "item/commandExecution/outputDelta"
                  ? "command_output"
                  : "assistant_text",
            delta,
            ...(asNumber(payload?.contentIndex) !== undefined
              ? { contentIndex: asNumber(payload?.contentIndex) }
              : {}),
          },
        },
      ];
    }
    case "serverRequest/resolved":
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "request.resolved",
          payload: {
            requestType: "command_execution_approval",
            ...(asString(payload?.response) ? { decision: asString(payload?.response) } : {}),
            ...(payload ? { resolution: payload } : {}),
          },
        },
      ];
    case "item/tool/requestUserInput/answered":
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.resolved",
          payload: {
            answers: (payload?.answers as Record<string, unknown>) ?? {},
          },
        },
      ];
    default:
      return [];
  }
}

function makeAuthorizationHeader(password: string | undefined): string | undefined {
  return password
    ? `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
    : undefined;
}

async function requestOpenCode<T>(input: {
  readonly baseUrl: string;
  readonly password?: string;
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
}): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  const authorization = makeAuthorizationHeader(input.password);
  if (authorization) {
    headers.set("authorization", authorization);
  }

  let body: string | undefined;
  if (input.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(input.body);
  }

  const response = await fetch(`${input.baseUrl.replace(/\/$/, "")}${input.path}`, {
    method: input.method ?? (body ? "POST" : "GET"),
    headers,
    ...(body ? { body } : {}),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail.trim().length > 0
        ? `OpenCode request failed (${response.status}): ${detail.trim()}`
        : `OpenCode request failed (${response.status})`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  if (text.trim().length === 0) {
    return undefined as T;
  }

  return unwrapResponse<T>(JSON.parse(text) as OpenCodeSdkResponse | T);
}

function createFetchClient(baseUrl: string, password: string | undefined): OpenCodeRuntimeClient {
  return {
    createSession: async ({ title }) => {
      const session = await requestOpenCode<Record<string, unknown>>({
        baseUrl,
        password,
        path: "/session",
        method: "POST",
        body: title ? { title } : {},
      });
      return { id: String(session.id), title: asString(session.title) ?? "Session" };
    },
    getSession: async (sessionId) => {
      const session = await requestOpenCode<Record<string, unknown>>({
        baseUrl,
        password,
        path: `/session/${encodeURIComponent(sessionId)}`,
      });
      return { id: String(session.id), title: asString(session.title) ?? "Session" };
    },
    listSessions: async () => {
      const sessions = await requestOpenCode<ReadonlyArray<Record<string, unknown>>>({
        baseUrl,
        password,
        path: "/session",
      });
      return sessions.map((session) => ({
        id: String(session.id),
        title: asString(session.title) ?? "Session",
      }));
    },
    deleteSession: async (sessionId) => {
      await requestOpenCode<void>({
        baseUrl,
        password,
        path: `/session/${encodeURIComponent(sessionId)}`,
        method: "DELETE",
      });
      return true;
    },
    abortSession: async (sessionId) => {
      await requestOpenCode<void>({
        baseUrl,
        password,
        path: `/session/${encodeURIComponent(sessionId)}/abort`,
        method: "POST",
      });
      return true;
    },
    promptAsync: async ({ sessionId, messageId, providerId, modelId, text }) => {
      await requestOpenCode<void>({
        baseUrl,
        password,
        path: `/session/${encodeURIComponent(sessionId)}/prompt/async`,
        method: "POST",
        body: {
          messageID: messageId,
          model: { providerID: providerId, modelID: modelId },
          parts: [{ type: "text", text }],
        },
      });
    },
    listMessages: async (sessionId) =>
      requestOpenCode<ReadonlyArray<{ info: { id: string }; parts: unknown[] }>>({
        baseUrl,
        password,
        path: `/session/${encodeURIComponent(sessionId)}/messages`,
      }),
    revertSession: async (sessionId, messageId) => {
      await requestOpenCode<void>({
        baseUrl,
        password,
        path: `/session/${encodeURIComponent(sessionId)}/revert`,
        method: "POST",
        body: { messageID: messageId },
      });
    },
    respondToPermission: async (sessionId, permissionId, response) => {
      await requestOpenCode<void>({
        baseUrl,
        password,
        path: `/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(permissionId)}`,
        method: "POST",
        body: response,
      });
    },
  } satisfies OpenCodeRuntimeClient;
}

async function subscribeToOpenCodeEvents(
  baseUrl: string,
  password: string | undefined,
  onEvent: (event: OpenCodeRuntimeEventEnvelope) => void,
): Promise<() => void> {
  const headers = new Headers();
  const authorization = makeAuthorizationHeader(password);
  if (authorization) {
    headers.set("Authorization", authorization);
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/event`, { headers });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to subscribe to OpenCode event stream: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let disposed = false;

  const pump = async (): Promise<void> => {
    while (!disposed) {
      const next = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (next.done) {
        break;
      }
      buffer += decoder.decode(next.value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLines = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .filter((line) => line.length > 0);
        if (dataLines.length === 0) continue;
        try {
          const payload = JSON.parse(dataLines.join("\n")) as OpenCodeRuntimeEventEnvelope;
          onEvent(payload);
        } catch {
          // ignore malformed frames
        }
      }
    }
  };

  void pump();

  return async () => {
    disposed = true;
    try {
      await reader.cancel();
    } catch {
      // ignore cancel failures
    }
  };
}

export const OpenCodeAdapterLive = Layer.effect(
  OpenCodeAdapter,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const nativeEventLogger = yield* makeEventNdjsonLogger(
      `${config.stateDir}/logs/provider/opencode-events.log`,
      { stream: "native" },
    ).pipe(Effect.orElseSucceed(() => undefined));

    const baseUrl = process.env.T3CODE_OPENCODE_BASE_URL ?? "http://127.0.0.1:4096";
    const password = process.env.T3CODE_OPENCODE_SERVER_PASSWORD;
    const client = createFetchClient(baseUrl, password);
    const manager = new OpenCodeRuntimeManager(client);
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    manager.on("event", (event) => {
      void Effect.runPromise(
        Effect.gen(function* () {
          if (nativeEventLogger) {
            yield* nativeEventLogger.write(event, event.threadId);
          }
          const runtimeEvents = mapToRuntimeEvents(event, event.threadId);
          yield* Effect.forEach(runtimeEvents, (runtimeEvent) => Queue.offer(runtimeEventQueue, runtimeEvent), {
            concurrency: "unbounded",
          }).pipe(Effect.asVoid);
        }),
      );
    });

    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => subscribeToOpenCodeEvents(baseUrl, password, (event) => manager.ingestEvent(event)),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: "global",
            detail: toMessage(cause, "Failed to subscribe to OpenCode event stream"),
            cause,
          }),
      }).pipe(
        Effect.catchAll((cause) =>
          Effect.logWarning("OpenCode event stream unavailable at startup", {
            provider: PROVIDER,
            detail: cause.message,
          }).pipe(Effect.as(undefined)),
        ),
      ),
      (dispose) =>
        Effect.gen(function* () {
          if (dispose) {
            yield* Effect.tryPromise({
              try: () => dispose(),
              catch: () => undefined,
            }).pipe(Effect.asVoid);
          }
          yield* Queue.shutdown(runtimeEventQueue);
        }),
    );

    const adapter: OpenCodeAdapterShape = {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "restart-session" },
      startSession: (input) =>
        Effect.tryPromise({
          try: () => manager.startSession(input),
          catch: (cause) => toRequestError(input.threadId, "session.start", cause),
        }),
      sendTurn: (input) =>
        Effect.tryPromise({
          try: () => manager.sendTurn(input),
          catch: (cause) => toRequestError(input.threadId, "turn.send", cause),
        }),
      interruptTurn: (threadId, turnId) =>
        Effect.tryPromise({
          try: () => manager.interruptTurn(threadId, turnId),
          catch: (cause) => toRequestError(threadId, "turn.interrupt", cause),
        }),
      respondToRequest: (threadId, requestId, decision) =>
        Effect.tryPromise({
          try: () => manager.respondToRequest(threadId, requestId, decision),
          catch: (cause) => toRequestError(threadId, "request.respond", cause),
        }),
      respondToUserInput: (threadId, requestId, answers) =>
        Effect.tryPromise({
          try: () => manager.respondToUserInput(threadId, requestId, answers),
          catch: (cause) => toRequestError(threadId, "userInput.respond", cause),
        }),
      stopSession: (threadId) =>
        Effect.sync(() => {
          manager.stopSession(threadId);
        }),
      listSessions: () => Effect.sync(() => manager.listSessions()),
      hasSession: (threadId) => Effect.sync(() => manager.hasSession(threadId)),
      readThread: (threadId) =>
        Effect.tryPromise({
          try: () => manager.readThread(threadId),
          catch: (cause) => toRequestError(threadId, "thread.read", cause),
        }),
      rollbackThread: (threadId, numTurns) =>
        Effect.tryPromise({
          try: () => manager.rollbackThread(threadId, numTurns),
          catch: (cause) => toRequestError(threadId, "thread.rollback", cause),
        }),
      stopAll: () =>
        Effect.sync(() => {
          manager.stopAll();
        }),
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    };

    return adapter;
  }),
);

export function makeOpenCodeAdapterLive(options?: OpenCodeAdapterLiveOptions) {
  if (!options) {
    return OpenCodeAdapterLive;
  }
  return Layer.effect(
    OpenCodeAdapter,
    Effect.gen(function* () {
      if (options.manager) {
        const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
        options.manager.on("event", (event) => {
          void Effect.runPromise(
            Effect.forEach(mapToRuntimeEvents(event, event.threadId), (runtimeEvent) =>
              Queue.offer(runtimeEventQueue, runtimeEvent),
            ).pipe(Effect.asVoid),
          );
        });
        yield* Effect.addFinalizer(() => Queue.shutdown(runtimeEventQueue));
        return {
          provider: PROVIDER,
          capabilities: { sessionModelSwitch: "restart-session" },
          startSession: (input) =>
            Effect.tryPromise({
              try: () => options.manager!.startSession(input),
              catch: (cause) => toRequestError(input.threadId, "session.start", cause),
            }),
          sendTurn: (input) =>
            Effect.tryPromise({
              try: () => options.manager!.sendTurn(input),
              catch: (cause) => toRequestError(input.threadId, "turn.send", cause),
            }),
          interruptTurn: (threadId, turnId) =>
            Effect.tryPromise({
              try: () => options.manager!.interruptTurn(threadId, turnId),
              catch: (cause) => toRequestError(threadId, "turn.interrupt", cause),
            }),
          respondToRequest: (threadId, requestId, decision) =>
            Effect.tryPromise({
              try: () => options.manager!.respondToRequest(threadId, requestId, decision),
              catch: (cause) => toRequestError(threadId, "request.respond", cause),
            }),
          respondToUserInput: (threadId, requestId, answers) =>
            Effect.tryPromise({
              try: () => options.manager!.respondToUserInput(threadId, requestId, answers),
              catch: (cause) => toRequestError(threadId, "userInput.respond", cause),
            }),
          stopSession: (threadId) => Effect.sync(() => options.manager!.stopSession(threadId)),
          listSessions: () => Effect.sync(() => options.manager!.listSessions()),
          hasSession: (threadId) => Effect.sync(() => options.manager!.hasSession(threadId)),
          readThread: (threadId) =>
            Effect.tryPromise({
              try: () => options.manager!.readThread(threadId),
              catch: (cause) => toRequestError(threadId, "thread.read", cause),
            }),
          rollbackThread: (threadId, numTurns) =>
            Effect.tryPromise({
              try: () => options.manager!.rollbackThread(threadId, numTurns),
              catch: (cause) => toRequestError(threadId, "thread.rollback", cause),
            }),
          stopAll: () => Effect.sync(() => options.manager!.stopAll()),
          streamEvents: Stream.fromQueue(runtimeEventQueue),
        } satisfies OpenCodeAdapterShape;
      }
      if (options.client) {
        const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
        const manager = new OpenCodeRuntimeManager(options.client);
        manager.on("event", (event) => {
          void Effect.runPromise(
            Effect.gen(function* () {
              if (options.nativeEventLogger) {
                yield* options.nativeEventLogger.write(event, event.threadId);
              }
              yield* Queue.offerAll(runtimeEventQueue, mapToRuntimeEvents(event, event.threadId));
            }),
          );
        });
        yield* Effect.addFinalizer(() => Queue.shutdown(runtimeEventQueue));
        return {
          provider: PROVIDER,
          capabilities: { sessionModelSwitch: "restart-session" },
          startSession: (input) =>
            Effect.tryPromise({
              try: () => manager.startSession(input),
              catch: (cause) => toRequestError(input.threadId, "session.start", cause),
            }),
          sendTurn: (input) =>
            Effect.tryPromise({
              try: () => manager.sendTurn(input),
              catch: (cause) => toRequestError(input.threadId, "turn.send", cause),
            }),
          interruptTurn: (threadId, turnId) =>
            Effect.tryPromise({
              try: () => manager.interruptTurn(threadId, turnId),
              catch: (cause) => toRequestError(threadId, "turn.interrupt", cause),
            }),
          respondToRequest: (threadId, requestId, decision) =>
            Effect.tryPromise({
              try: () => manager.respondToRequest(threadId, requestId, decision),
              catch: (cause) => toRequestError(threadId, "request.respond", cause),
            }),
          respondToUserInput: (threadId, requestId, answers) =>
            Effect.tryPromise({
              try: () => manager.respondToUserInput(threadId, requestId, answers),
              catch: (cause) => toRequestError(threadId, "userInput.respond", cause),
            }),
          stopSession: (threadId) => Effect.sync(() => manager.stopSession(threadId)),
          listSessions: () => Effect.sync(() => manager.listSessions()),
          hasSession: (threadId) => Effect.sync(() => manager.hasSession(threadId)),
          readThread: (threadId) =>
            Effect.tryPromise({
              try: () => manager.readThread(threadId),
              catch: (cause) => toRequestError(threadId, "thread.read", cause),
            }),
          rollbackThread: (threadId, numTurns) =>
            Effect.tryPromise({
              try: () => manager.rollbackThread(threadId, numTurns),
              catch: (cause) => toRequestError(threadId, "thread.rollback", cause),
            }),
          stopAll: () => Effect.sync(() => manager.stopAll()),
          streamEvents: Stream.fromQueue(runtimeEventQueue),
        } satisfies OpenCodeAdapterShape;
      }
      return yield* OpenCodeAdapterLive;
    }),
  );
}

import { ProxyAgent } from "undici";
import { UnifiedChatRequest } from "../types/llm";

export type StreamProbeResult = {
  empty: boolean;
  response: Response;
};

function rebuildStream(
  bufferedChunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>
) {
  const queue = [...bufferedChunks];

  return new ReadableStream({
    async pull(controller) {
      try {
        if (queue.length) {
          controller.enqueue(queue.shift()!);
          return;
        }

        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }

        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

function rebuildResponse(
  response: Response,
  bufferedChunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>
) {
  return new Response(rebuildStream(bufferedChunks, reader), {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
}

function inspectSseBlock(
  block: string,
  state: {
    hasContent: boolean;
    hasToolCalls: boolean;
    sawFinishReason: boolean;
  }
) {
  const payload = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();

  if (!payload || payload === "[DONE]") {
    return;
  }

  try {
    const chunk = JSON.parse(payload);
    const choice = chunk.choices?.[0];
    if (!choice) {
      return;
    }

    if (choice?.delta?.content) {
      state.hasContent = true;
    }
    if (choice?.delta?.tool_calls) {
      state.hasToolCalls = true;
    }
    if (choice?.finish_reason) {
      state.sawFinishReason = true;
    }
  } catch {
    // ignore non-JSON SSE payloads
  }
}

export async function probeEmptyStreamResponse(
  response: Response
): Promise<StreamProbeResult> {
  if (!response.body) {
    return { empty: false, response };
  }

  const reader = response.body.getReader();
  const bufferedChunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  const state = {
    hasContent: false,
    hasToolCalls: false,
    sawFinishReason: false,
  };
  let pendingText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    bufferedChunks.push(value);
    pendingText += decoder.decode(value, { stream: true }).replace(/\r/g, "");

    const blocks = pendingText.split("\n\n");
    pendingText = blocks.pop() ?? "";

    for (const block of blocks) {
      inspectSseBlock(block, state);

      if (state.hasContent || state.hasToolCalls || state.sawFinishReason) {
        return {
          empty:
            !state.hasContent && !state.hasToolCalls && state.sawFinishReason,
          response: rebuildResponse(response, bufferedChunks, reader),
        };
      }
    }
  }

  pendingText += decoder.decode().replace(/\r/g, "");
  if (pendingText.trim()) {
    inspectSseBlock(pendingText, state);
  }

  return {
    empty: !state.hasContent && !state.hasToolCalls && state.sawFinishReason,
    response: rebuildResponse(response, bufferedChunks, reader),
  };
}

export function sendUnifiedRequest(
  url: URL | string,
  request: UnifiedChatRequest,
  config: any,
  logger?: any,
  context: any
): Promise<Response> {
  const headers = new Headers({
    "Content-Type": "application/json",
  });
  if (config.headers) {
    Object.entries(config.headers).forEach(([key, value]) => {
      if (value) {
        headers.set(key, value as string);
      }
    });
  }
  let combinedSignal: AbortSignal;
  const timeoutSignal = AbortSignal.timeout(config.TIMEOUT ?? 60 * 1000 * 60);

  if (config.signal) {
    const controller = new AbortController();
    const abortHandler = () => controller.abort();
    config.signal.addEventListener("abort", abortHandler);
    timeoutSignal.addEventListener("abort", abortHandler);
    combinedSignal = controller.signal;
  } else {
    combinedSignal = timeoutSignal;
  }

  const fetchOptions: RequestInit = {
    method: "POST",
    headers: headers,
    body: JSON.stringify(request),
    signal: combinedSignal,
  };

  if (config.httpsProxy) {
    (fetchOptions as any).dispatcher = new ProxyAgent(
      new URL(config.httpsProxy).toString()
    );
  }
  logger?.debug(
    {
      reqId: context.req.id,
      request: fetchOptions,
      headers: Object.fromEntries(headers.entries()),
      requestUrl: typeof url === "string" ? url : url.toString(),
      useProxy: config.httpsProxy,
    },
    "final request"
  );
  return fetch(typeof url === "string" ? url : url.toString(), fetchOptions);
}

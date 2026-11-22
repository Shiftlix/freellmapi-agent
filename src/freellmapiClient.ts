import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import OpenAI from 'openai';

export interface UsageRecord {
  id: string;
  timestamp: string;
  requestedModel: string;
  resolvedModel: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
}

export interface GatewayTelemetry {
  usage: Record<string, unknown> | null;
  quotaForecast: Record<string, unknown> | null;
}

export interface TelemetrySummary {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalUsedTokens: number;
  lastModel: string;
  lastDurationMs: number;
  history: UsageRecord[];
  byModel: Record<string, number>;
  gateway: GatewayTelemetry;
}

export class FreeLLMClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey.trim();
  }

  public static async autoDetectConfig(): Promise<{
    baseUrl: string;
    apiKey?: string;
    detectedFrom: string[];
  }> {
    const detectedFrom: string[] = [];
    const candidateBases = new Set<string>([
      'http://127.0.0.1:31415/v1',
      'http://127.0.0.1:3001/v1'
    ]);

    const configPaths = [
      path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'FreeLLMAPI',
        'config.json'
      ),
      path.join(os.homedir(), '.config', 'FreeLLMAPI', 'config.json'),
      process.env.APPDATA
        ? path.join(process.env.APPDATA, 'FreeLLMAPI', 'config.json')
        : ''
    ].filter(Boolean);

    for (const cfgPath of configPaths) {
      try {
        if (fs.existsSync(cfgPath)) {
          const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<
            string,
            unknown
          >;
          const port = raw.port ?? raw.serverPort ?? raw.apiPort;
          if (
            typeof port === 'number' ||
            (typeof port === 'string' && /^\d+$/.test(port))
          ) {
            candidateBases.add(`http://127.0.0.1:${port}/v1`);
            detectedFrom.push(cfgPath);
          }
        }
      } catch {
        // Ignorar archivos de configuración no válidos
      }
    }

    const envKey =
      process.env.FREELLMAPI_API_KEY?.trim() ||
      (process.env.OPENAI_API_KEY?.trim().startsWith('freellmapi-')
        ? process.env.OPENAI_API_KEY.trim()
        : '');

    if (envKey) {
      detectedFrom.push('variables de entorno');
    }

    for (const baseUrl of candidateBases) {
      try {
        const headers: Record<string, string> = {};
        if (envKey) {
          headers.Authorization = `Bearer ${envKey}`;
        }
        const res = await fetch(`${baseUrl}/models`, { headers });
        if (res.ok) {
          detectedFrom.push(baseUrl);
          return {
            baseUrl,
            apiKey: envKey || undefined,
            detectedFrom
          };
        }
      } catch {
        // Probar siguiente URL candidata
      }
    }

    return {
      baseUrl: 'http://127.0.0.1:31415/v1',
      apiKey: envKey || undefined,
      detectedFrom
    };
  }

  private createSdk(): OpenAI {
    return new OpenAI({
      baseURL: this.baseUrl,
      apiKey: this.apiKey || 'freellmapi-local'
    });
  }

  public async listModels(): Promise<string[]> {
    try {
      const sdk = this.createSdk();
      const page = await sdk.models.list();
      const ids = page.data.map((m) => m.id).filter(Boolean);
      return Array.from(new Set(['auto', 'auto:fast', 'auto:smart', ...ids]));
    } catch {
      return ['auto', 'auto:fast', 'auto:smart'];
    }
  }

  public async fetchGatewayTelemetry(): Promise<GatewayTelemetry> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const [usageRes, quotaRes] = await Promise.allSettled([
      fetch(`${this.baseUrl}/usage`, { headers }),
      fetch(`${this.baseUrl}/quota-forecast`, { headers })
    ]);

    const usage =
      usageRes.status === 'fulfilled' && usageRes.value.ok
        ? ((await usageRes.value.json()) as Record<string, unknown>)
        : null;

    const quotaForecast =
      quotaRes.status === 'fulfilled' && quotaRes.value.ok
        ? ((await quotaRes.value.json()) as Record<string, unknown>)
        : null;

    return { usage, quotaForecast };
  }

  public async streamChat(params: {
    model: string;
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
    onToken: (deltaText: string, activeModel: string) => void;
    onToolCalls?: (
      toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[]
    ) => void;
  }): Promise<{
    content: string;
    resolvedModel: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    durationMs: number;
    toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
  }> {
    const start = Date.now();
    const sdk = this.createSdk();

    const stream = await sdk.chat.completions.create({
      model: params.model,
      messages: params.messages,
      tools: params.tools && params.tools.length > 0 ? params.tools : undefined,
      stream: true,
      stream_options: { include_usage: true }
    });

    let fullContent = '';
    let resolvedModel = params.model;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;

    const toolCallMap = new Map<
      number,
      {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }
    >();

    for await (const chunk of stream) {
      if (chunk.model) {
        resolvedModel = chunk.model;
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;

      if (delta?.content) {
        fullContent += delta.content;
        params.onToken(delta.content, resolvedModel);
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const existing = toolCallMap.get(idx) ?? {
            id: tc.id || `call_${idx}`,
            type: 'function' as const,
            function: { name: '', arguments: '' }
          };
          if (tc.id) {
            existing.id = tc.id;
          }
          if (tc.function?.name) {
            existing.function.name += tc.function.name;
          }
          if (tc.function?.arguments) {
            existing.function.arguments += tc.function.arguments;
          }
          toolCallMap.set(idx, existing);
        }
      }

      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
        completionTokens = chunk.usage.completion_tokens ?? completionTokens;
        totalTokens =
          chunk.usage.total_tokens ?? promptTokens + completionTokens;
      }
    }

    if (totalTokens === 0 && fullContent.length > 0) {
      const promptChars = JSON.stringify(params.messages).length;
      promptTokens = Math.max(1, Math.round(promptChars / 4));
      completionTokens = Math.max(1, Math.round(fullContent.length / 4));
      totalTokens = promptTokens + completionTokens;
    }

    const toolCalls = Array.from(toolCallMap.values());
    if (toolCalls.length > 0 && params.onToolCalls) {
      params.onToolCalls(toolCalls);
    }

    return {
      content: fullContent,
      resolvedModel,
      promptTokens,
      completionTokens,
      totalTokens,
      durationMs: Date.now() - start,
      toolCalls
    };
  }
}
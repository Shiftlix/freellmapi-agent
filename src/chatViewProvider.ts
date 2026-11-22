import * as vscode from 'vscode';
import type OpenAI from 'openai';
import {
  FreeLLMClient,
  GatewayTelemetry,
  TelemetrySummary,
  UsageRecord
} from './freellmapiClient';
import { AGENT_TOOL_DEFINITIONS, executeAgentTool } from './agentTools';

const STORAGE_KEY_USAGE = 'freellmapi.usageHistory.v1';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'freellmapi.chatView';

  private view?: vscode.WebviewView;
  private conversation: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content:
        'Eres un asistente de programación agéntico dentro de VS Code. Responde en español de forma clara y concisa. Cuando necesites inspeccionar o modificar el proyecto, usa las herramientas disponibles.'
    }
  ];
  private usageHistory: UsageRecord[] = [];
  private gatewayTelemetry: GatewayTelemetry = {
    usage: null,
    quotaForecast: null
  };
  private selectedModel = 'auto';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalState: vscode.Memento
  ) {
    const cfg = vscode.workspace.getConfiguration('freellmapi');
    this.selectedModel = cfg.get<string>('defaultMode') || 'auto';
    this.usageHistory = this.globalState.get<UsageRecord[]>(STORAGE_KEY_USAGE, []);
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          await this.syncInitialState();
          break;
        case 'getConfig':
          this.pushConfig();
          break;
        case 'saveConfig': {
          const cfg = vscode.workspace.getConfiguration('freellmapi');
          const nextBaseUrl =
            String(msg.baseUrl || '').trim() || 'http://127.0.0.1:31415/v1';
          const nextApiKey = String(msg.apiKey || '').trim();
          await cfg.update(
            'baseUrl',
            nextBaseUrl,
            vscode.ConfigurationTarget.Global
          );
          await cfg.update(
            'apiKey',
            nextApiKey,
            vscode.ConfigurationTarget.Global
          );
          this.pushConfig();
          await this.syncInitialState();
          vscode.window.setStatusBarMessage(
            'Configuración de FreeLLMAPI guardada',
            2500
          );
          break;
        }
        case 'autoDetectConfig': {
          const found = await FreeLLMClient.autoDetectConfig();
          this.view?.webview.postMessage({
            type: 'configDetected',
            ...found
          });
          break;
        }
        case 'changeModel':
          this.selectedModel = String(msg.model || 'auto');
          break;
        case 'sendMessage':
          await this.handleUserPrompt(
            String(msg.text || ''),
            Boolean(msg.includeContext)
          );
          break;
        case 'insertCode':
          await this.insertCodeAtCursor(String(msg.code || ''));
          break;
        case 'replaceSelection':
          await this.replaceSelection(String(msg.code || ''));
          break;
        case 'copyCode':
          await vscode.env.clipboard.writeText(String(msg.code || ''));
          vscode.window.setStatusBarMessage(
            'Código copiado al portapapeles',
            2000
          );
          break;
        case 'clearChat':
          this.clearConversation();
          break;
        case 'refreshModels':
          await this.pushModels();
          break;
        case 'refreshTelemetry':
          await this.refreshGatewayTelemetry();
          break;
      }
    });
  }

  public async focusWithPrompt(prefillText: string): Promise<void> {
    await vscode.commands.executeCommand(
      'workbench.view.extension.freellmapi-sidebar'
    );
    this.view?.webview.postMessage({
      type: 'prefillPrompt',
      text: prefillText
    });
  }

  public clearConversation(): void {
    this.conversation = [this.conversation[0]];
    this.view?.webview.postMessage({ type: 'resetUi' });
    this.pushTelemetry();
  }

  public async refreshGatewayTelemetry(): Promise<void> {
    const client = this.getClient();
    this.gatewayTelemetry = await client.fetchGatewayTelemetry();
    this.pushTelemetry();
  }

  private getClient(): FreeLLMClient {
    const cfg = vscode.workspace.getConfiguration('freellmapi');
    const baseUrl =
      cfg.get<string>('baseUrl') || 'http://127.0.0.1:31415/v1';
    const apiKey = cfg.get<string>('apiKey') || '';
    return new FreeLLMClient(baseUrl, apiKey);
  }

  private async saveUsageHistory(): Promise<void> {
    await this.globalState.update(STORAGE_KEY_USAGE, this.usageHistory);
  }

  private pushConfig(): void {
    const cfg = vscode.workspace.getConfiguration('freellmapi');
    this.view?.webview.postMessage({
      type: 'configLoaded',
      baseUrl: cfg.get<string>('baseUrl') || 'http://127.0.0.1:31415/v1',
      apiKey: cfg.get<string>('apiKey') || ''
    });
  }

  private async syncInitialState(): Promise<void> {
    this.pushConfig();
    await Promise.all([this.pushModels(), this.refreshGatewayTelemetry()]);
  }

  private async pushModels(): Promise<void> {
    const client = this.getClient();
    const models = await client.listModels();
    if (!models.includes(this.selectedModel)) {
      models.unshift(this.selectedModel);
    }
    this.view?.webview.postMessage({
      type: 'modelsLoaded',
      models,
      selectedModel: this.selectedModel
    });
  }

  private buildTelemetry(): TelemetrySummary {
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalUsedTokens = 0;
    const byModel: Record<string, number> = {};

    for (const item of this.usageHistory) {
      totalPromptTokens += item.promptTokens;
      totalCompletionTokens += item.completionTokens;
      totalUsedTokens += item.totalTokens;
      byModel[item.resolvedModel] =
        (byModel[item.resolvedModel] || 0) + item.totalTokens;
    }

    const last = this.usageHistory[this.usageHistory.length - 1];

    return {
      totalPromptTokens,
      totalCompletionTokens,
      totalUsedTokens,
      lastModel: last?.resolvedModel || '—',
      lastDurationMs: last?.durationMs || 0,
      history: this.usageHistory.slice(-14),
      byModel,
      gateway: this.gatewayTelemetry
    };
  }

  private pushTelemetry(): void {
    this.view?.webview.postMessage({
      type: 'telemetryUpdate',
      telemetry: this.buildTelemetry()
    });
  }

  private getEditorContextSnippet(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return '';
    }
    const relPath = vscode.workspace.asRelativePath(editor.document.uri);
    const selection = editor.document.getText(editor.selection);
    if (selection.trim().length > 0) {
      return `\n\n[Contexto activo - ${relPath} (selección)]\n\`\`\`\n${selection}\n\`\`\``;
    }
    const visibleText = editor.document.getText().slice(0, 4000);
    return `\n\n[Contexto activo - ${relPath} (extracto)]\n\`\`\`\n${visibleText}\n\`\`\``;
  }

  private async handleUserPrompt(
    rawText: string,
    includeContext: boolean
  ): Promise<void> {
    const trimmed = rawText.trim();
    if (!trimmed) {
      return;
    }

    const contextBlock = includeContext ? this.getEditorContextSnippet() : '';
    const finalContent = `${trimmed}${contextBlock}`;

    this.conversation.push({ role: 'user', content: finalContent });
    this.view?.webview.postMessage({
      type: 'userMessage',
      text: trimmed,
      withContext: includeContext
    });

    const cfg = vscode.workspace.getConfiguration('freellmapi');
    const enableTools = cfg.get<boolean>('enableTools') ?? true;
    const tools = enableTools ? AGENT_TOOL_DEFINITIONS : undefined;
    const client = this.getClient();

    this.view?.webview.postMessage({
      type: 'startAssistantStream',
      model: this.selectedModel
    });

    try {
      let maxLoops = 6;
      while (maxLoops-- > 0) {
        let turnText = '';
        const res = await client.streamChat({
          model: this.selectedModel,
          messages: this.conversation,
          tools,
          onToken: (delta, activeModel) => {
            turnText += delta;
            this.view?.webview.postMessage({
              type: 'streamDelta',
              delta,
              resolvedModel: activeModel
            });
          }
        });

        this.usageHistory.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: new Date().toLocaleTimeString(),
          requestedModel: this.selectedModel,
          resolvedModel: res.resolvedModel,
          promptTokens: res.promptTokens,
          completionTokens: res.completionTokens,
          totalTokens: res.totalTokens,
          durationMs: res.durationMs
        });
        await this.saveUsageHistory();
        this.pushTelemetry();

        if (res.toolCalls.length > 0) {
          this.conversation.push({
            role: 'assistant',
            content: res.content || null,
            tool_calls: res.toolCalls
          });

          for (const tc of res.toolCalls) {
            if (tc.type !== 'function') {
              continue;
            }
            this.view?.webview.postMessage({
              type: 'toolStatus',
              text: `Ejecutando herramienta: ${tc.function.name}...`
            });
            const toolOutput = await executeAgentTool(
              tc.function.name,
              tc.function.arguments
            );
            this.conversation.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: toolOutput
            });
          }
          this.view?.webview.postMessage({ type: 'resetAssistantStream' });
          continue;
        }

        this.conversation.push({
          role: 'assistant',
          content: res.content || turnText
        });
        break;
      }

      await this.refreshGatewayTelemetry();
      this.view?.webview.postMessage({ type: 'endAssistantStream' });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.view?.webview.postMessage({ type: 'streamError', error: msg });
    }
  }

  private async insertCodeAtCursor(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage(
        'Abre un archivo en el editor para insertar código.'
      );
      return;
    }
    await editor.edit((eb) => eb.insert(editor.selection.active, code));
  }

  private async replaceSelection(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage(
        'Abre un archivo en el editor para reemplazar selección.'
      );
      return;
    }
    await editor.edit((eb) => eb.replace(editor.selection, code));
  }

  private getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 10px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    display: flex;
    flex-direction: column;
    gap: 10px;
    height: 100vh;
  }
  .toolbar {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  select, button, textarea, input {
    font-family: inherit;
    font-size: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
  }
  select { flex: 1; padding: 5px 6px; min-width: 0; }
  button {
    padding: 5px 8px;
    cursor: pointer;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    white-space: nowrap;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    color: var(--vscode-secondaryButton-foreground);
    background: var(--vscode-secondaryButton-background);
  }
  .settings-panel {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
    border-radius: 6px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .settings-title { font-size: 11px; font-weight: 600; }
  .settings-panel input {
    width: 100%;
    padding: 5px 6px;
  }
  .settings-actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }
  .settings-hint {
    font-size: 10px;
    opacity: 0.8;
  }
  .telemetry-card {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
    border-radius: 6px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .telemetry-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }
  .model-badge {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 2px 6px;
    border-radius: 999px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 175px;
    display: inline-block;
    vertical-align: middle;
  }
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    font-size: 11px;
  }
  .stat-box {
    padding: 4px 5px;
    border-radius: 4px;
    background: rgba(128,128,128,0.08);
  }
  .stat-label { opacity: 0.75; font-size: 10px; }
  .stat-val { font-weight: 600; }
  .chart-bars {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 42px;
    padding-top: 4px;
  }
  .bar-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    height: 100%;
    justify-content: flex-end;
  }
  .bar {
    width: 100%;
    min-height: 2px;
    background: var(--vscode-charts-blue, #3794ff);
    border-radius: 2px 2px 0 0;
  }
  .models-breakdown {
    font-size: 10px;
    opacity: 0.9;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .chip {
    background: rgba(128,128,128,0.12);
    padding: 2px 6px;
    border-radius: 4px;
  }
  details.gw-details summary {
    cursor: pointer;
    font-size: 10px;
    opacity: 0.8;
    user-select: none;
  }
  pre.gw-json {
    max-height: 110px;
    overflow: auto;
    font-size: 10px;
    background: rgba(0,0,0,0.25);
    padding: 6px;
    border-radius: 4px;
    margin: 4px 0 0;
  }
  .chat-log {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-right: 2px;
    min-height: 120px;
  }
  .msg {
    padding: 8px;
    border-radius: 6px;
    line-height: 1.45;
    word-break: break-word;
  }
  .msg.user {
    background: var(--vscode-editor-selectionBackground, rgba(0,122,204,0.25));
  }
  .msg.assistant {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
  }
  pre.code-block {
    background: rgba(0,0,0,0.25);
    padding: 8px;
    border-radius: 4px;
    overflow-x: auto;
    margin: 4px 0 6px;
  }
  .code-actions {
    display: flex;
    gap: 4px;
    margin-top: 6px;
    flex-wrap: wrap;
  }
  .code-actions button {
    font-size: 11px;
    padding: 2px 6px;
  }
  .composer {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  textarea {
    width: 100%;
    min-height: 60px;
    resize: vertical;
    padding: 6px;
  }
  .composer-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
  }
  label.ctx-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    cursor: pointer;
  }
</style>
</head>
<body>
  <div class="toolbar">
    <select id="modelSelect" title="Modo o modelo"></select>
    <button class="secondary" id="refreshModelsBtn" title="Actualizar modelos">↻</button>
    <button class="secondary" id="refreshStatsBtn" title="Actualizar métricas de FreeLLMAPI">📊</button>
    <button class="secondary" id="clearBtn" title="Limpiar chat">Limpiar</button>
    <button class="secondary" id="toggleSettingsBtn" title="Configuración de acceso">⚙</button>
  </div>

  <div class="settings-panel" id="settingsPanel" style="display: none;">
    <div class="settings-title">Acceso a FreeLLMAPI</div>
    <input id="baseUrlInput" type="text" placeholder="http://127.0.0.1:31415/v1" />
    <input id="apiKeyInput" type="password" placeholder="API Key (freellmapi-...)" />
    <div class="settings-actions">
      <button class="secondary" id="autoDetectBtn" type="button">Autodetectar</button>
      <button id="saveConfigBtn" type="button">Guardar y conectar</button>
    </div>
    <div class="settings-hint" id="detectHint"></div>
  </div>

  <div class="telemetry-card">
    <div class="telemetry-top">
      <span>Modelo: <span class="model-badge" id="lastModel">—</span></span>
      <span id="lastLatency">—</span>
    </div>
    <div class="stats-grid">
      <div class="stat-box">
        <div class="stat-label">Tokens sesión</div>
        <div class="stat-val" id="usedTokens">0</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">In / Out</div>
        <div class="stat-val" id="ioTokens">0 / 0</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Gateway</div>
        <div class="stat-val" id="gwStatus">—</div>
      </div>
    </div>
    <div class="chart-bars" id="turnChart" title="Tokens por turno reciente"></div>
    <div class="models-breakdown" id="byModelChips"></div>
    <details class="gw-details">
      <summary>Métricas del servidor (/v1/usage y /v1/quota-forecast)</summary>
      <pre class="gw-json" id="gwRawJson">Sin datos aún</pre>
    </details>
  </div>

  <div class="chat-log" id="chatLog"></div>

  <div class="composer">
    <textarea id="promptInput" placeholder="Pide código, refactorizaciones o que lea/edite archivos del proyecto..."></textarea>
    <div class="composer-footer">
      <label class="ctx-toggle">
        <input type="checkbox" id="includeContext" checked />
        Incluir archivo/selección
      </label>
      <button id="sendBtn">Enviar</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const chatLog = document.getElementById('chatLog');
    const promptInput = document.getElementById('promptInput');
    const sendBtn = document.getElementById('sendBtn');
    const modelSelect = document.getElementById('modelSelect');
    const refreshModelsBtn = document.getElementById('refreshModelsBtn');
    const refreshStatsBtn = document.getElementById('refreshStatsBtn');
    const clearBtn = document.getElementById('clearBtn');
    const toggleSettingsBtn = document.getElementById('toggleSettingsBtn');
    const settingsPanel = document.getElementById('settingsPanel');
    const baseUrlInput = document.getElementById('baseUrlInput');
    const apiKeyInput = document.getElementById('apiKeyInput');
    const autoDetectBtn = document.getElementById('autoDetectBtn');
    const saveConfigBtn = document.getElementById('saveConfigBtn');
    const detectHint = document.getElementById('detectHint');
    const includeContext = document.getElementById('includeContext');

    let currentAssistantEl = null;
    let currentRawText = '';

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function renderMarkdownLite(raw) {
      const parts = raw.split(/(\`\`\`[\s\S]*?\`\`\`)/g);
      return parts.map((part) => {
        if (part.startsWith('\`\`\`') && part.endsWith('\`\`\`')) {
          const inner = part.slice(3, -3).replace(/^[a-zA-Z0-9_-]+\n/, '');
          const encoded = encodeURIComponent(inner);
          return \`
            <div class="code-actions">
              <button data-act="insert" data-code="\${encoded}">Insertar</button>
              <button data-act="replace" data-code="\${encoded}">Reemplazar selección</button>
              <button data-act="copy" data-code="\${encoded}">Copiar</button>
            </div>
            <pre class="code-block"><code>\${escapeHtml(inner)}</code></pre>
          \`;
        }
        return escapeHtml(part).replace(/\n/g, '<br/>');
      }).join('');
    }

    function sendCurrentPrompt() {
      const text = promptInput.value.trim();
      if (!text) return;
      promptInput.value = '';
      vscode.postMessage({
        type: 'sendMessage',
        text,
        includeContext: includeContext.checked
      });
    }

    sendBtn.addEventListener('click', sendCurrentPrompt);
    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendCurrentPrompt();
      }
    });

    modelSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'changeModel', model: modelSelect.value });
    });

    refreshModelsBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'refreshModels' });
    });

    refreshStatsBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'refreshTelemetry' });
    });

    clearBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'clearChat' });
    });

    toggleSettingsBtn.addEventListener('click', () => {
      const isHidden = settingsPanel.style.display === 'none';
      settingsPanel.style.display = isHidden ? 'flex' : 'none';
      if (isHidden) vscode.postMessage({ type: 'getConfig' });
    });

    autoDetectBtn.addEventListener('click', () => {
      detectHint.textContent = 'Buscando servidor y credenciales...';
      vscode.postMessage({ type: 'autoDetectConfig' });
    });

    saveConfigBtn.addEventListener('click', () => {
      vscode.postMessage({
        type: 'saveConfig',
        baseUrl: baseUrlInput.value,
        apiKey: apiKeyInput.value
      });
      settingsPanel.style.display = 'none';
    });

    chatLog.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const code = decodeURIComponent(btn.getAttribute('data-code') || '');
      const act = btn.getAttribute('data-act');
      if (act === 'insert') vscode.postMessage({ type: 'insertCode', code });
      if (act === 'replace') vscode.postMessage({ type: 'replaceSelection', code });
      if (act === 'copy') vscode.postMessage({ type: 'copyCode', code });
    });

    function updateTelemetry(t) {
      document.getElementById('lastModel').textContent = t.lastModel;
      document.getElementById('lastLatency').textContent = t.lastDurationMs ? t.lastDurationMs + ' ms' : '—';
      document.getElementById('usedTokens').textContent = Number(t.totalUsedTokens || 0).toLocaleString();
      document.getElementById('ioTokens').textContent = (t.totalPromptTokens || 0) + ' / ' + (t.totalCompletionTokens || 0);

      const gw = t.gateway || {};
      const hasGw = Boolean(gw.usage || gw.quotaForecast);
      document.getElementById('gwStatus').textContent = hasGw ? 'Activo' : 'N/D';
      document.getElementById('gwRawJson').textContent = hasGw
        ? JSON.stringify({ usage: gw.usage, quotaForecast: gw.quotaForecast }, null, 2)
        : 'Sin respuesta de /v1/usage o /v1/quota-forecast';

      const chart = document.getElementById('turnChart');
      chart.innerHTML = '';
      const history = Array.isArray(t.history) ? t.history : [];
      const maxVal = Math.max(1, ...history.map((h) => h.totalTokens || 0));
      for (const h of history) {
        const col = document.createElement('div');
        col.className = 'bar-col';
        col.title = (h.resolvedModel || 'modelo') + ': ' + (h.totalTokens || 0) + ' tokens';
        const bar = document.createElement('div');
        bar.className = 'bar';
        bar.style.height = Math.max(8, Math.round(((h.totalTokens || 0) / maxVal) * 100)) + '%';
        col.appendChild(bar);
        chart.appendChild(col);
      }

      const chipsEl = document.getElementById('byModelChips');
      chipsEl.innerHTML = '';
      const entries = Object.entries(t.byModel || {});
      for (const [modelName, tok] of entries) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = modelName + ': ' + Number(tok).toLocaleString();
        chipsEl.appendChild(chip);
      }
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'configLoaded') {
        baseUrlInput.value = msg.baseUrl || 'http://127.0.0.1:31415/v1';
        apiKeyInput.value = msg.apiKey || '';
      } else if (msg.type === 'configDetected') {
        baseUrlInput.value = msg.baseUrl || baseUrlInput.value;
        if (msg.apiKey) apiKeyInput.value = msg.apiKey;
        detectHint.textContent = msg.detectedFrom?.length
          ? 'Detectado: ' + msg.detectedFrom.join(' · ')
          : 'No se detectó servidor activo; verifica URL y API Key.';
      } else if (msg.type === 'modelsLoaded') {
        modelSelect.innerHTML = '';
        for (const m of msg.models || []) {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          if (m === msg.selectedModel) opt.selected = true;
          modelSelect.appendChild(opt);
        }
      } else if (msg.type === 'telemetryUpdate') {
        updateTelemetry(msg.telemetry);
      } else if (msg.type === 'userMessage') {
        const el = document.createElement('div');
        el.className = 'msg user';
        el.innerHTML = escapeHtml(msg.text) + (msg.withContext ? '<br/><small>📎 Contexto incluido</small>' : '');
        chatLog.appendChild(el);
        chatLog.scrollTop = chatLog.scrollHeight;
      } else if (msg.type === 'startAssistantStream') {
        currentRawText = '';
        currentAssistantEl = document.createElement('div');
        currentAssistantEl.className = 'msg assistant';
        currentAssistantEl.textContent = 'Pensando...';
        chatLog.appendChild(currentAssistantEl);
        chatLog.scrollTop = chatLog.scrollHeight;
      } else if (msg.type === 'streamDelta') {
        currentRawText += msg.delta;
        if (currentAssistantEl) {
          currentAssistantEl.innerHTML = renderMarkdownLite(currentRawText);
          chatLog.scrollTop = chatLog.scrollHeight;
        }
      } else if (msg.type === 'toolStatus') {
        if (currentAssistantEl) {
          currentAssistantEl.innerHTML = renderMarkdownLite(currentRawText) + '<br/><small>🛠 ' + escapeHtml(msg.text) + '</small>';
        }
      } else if (msg.type === 'resetAssistantStream') {
        currentRawText = '';
      } else if (msg.type === 'streamError') {
        if (currentAssistantEl) {
          currentAssistantEl.innerHTML = '<strong>Error:</strong> ' + escapeHtml(msg.error);
        }
      } else if (msg.type === 'prefillPrompt') {
        promptInput.value = msg.text;
        promptInput.focus();
      } else if (msg.type === 'resetUi') {
        chatLog.innerHTML = '';
        currentAssistantEl = null;
        currentRawText = '';
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
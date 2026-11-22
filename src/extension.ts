import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context.extensionUri, context.globalState);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('freellmapi.focusChat', async () => {
      await vscode.commands.executeCommand(
        'workbench.view.extension.freellmapi-sidebar'
      );
    }),
    vscode.commands.registerCommand('freellmapi.sendSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      const selected = editor ? editor.document.getText(editor.selection) : '';
      await provider.focusWithPrompt(
        selected
          ? `Analiza y mejora este código:\n\`\`\`\n${selected}\n\`\`\``
          : 'Ayúdame con este archivo:'
      );
    }),
    vscode.commands.registerCommand('freellmapi.clearChat', () => {
      provider.clearConversation();
    }),
    vscode.commands.registerCommand('freellmapi.refreshStats', async () => {
      await provider.refreshGatewayTelemetry();
      vscode.window.setStatusBarMessage(
        'Métricas de FreeLLMAPI actualizadas',
        2500
      );
    })
  );
}

export function deactivate(): void {}
import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type OpenAI from 'openai';

const execAsync = promisify(exec);

export const AGENT_TOOL_DEFINITIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Lista archivos del workspace (excluyendo node_modules, .git, out y dist).',
      parameters: {
        type: 'object',
        properties: {
          globPattern: {
            type: 'string',
            description: 'Patrón glob opcional relativo al workspace, ej: src/**/*'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Lee el contenido de un archivo relativo a la raíz del workspace.',
      parameters: {
        type: 'object',
        properties: {
          relativePath: {
            type: 'string',
            description: 'Ruta relativa del archivo, ej: src/extension.ts'
          }
        },
        required: ['relativePath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Crea o reemplaza por completo el contenido de un archivo en el workspace.',
      parameters: {
        type: 'object',
        properties: {
          relativePath: {
            type: 'string',
            description: 'Ruta relativa del archivo a crear o sobrescribir'
          },
          content: {
            type: 'string',
            description: 'Contenido completo que se escribirá en el archivo'
          }
        },
        required: ['relativePath', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Ejecuta un comando de shell en la raíz del workspace.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Comando de shell a ejecutar'
          }
        },
        required: ['command']
      }
    }
  }
];

function resolveWorkspaceUri(relativePath: string): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const root = folders[0].uri.fsPath;
  const normalizedRoot = path.resolve(root);
  const target = path.resolve(normalizedRoot, relativePath);

  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error('Acceso denegado: la ruta apunta fuera del workspace.');
  }
  return vscode.Uri.file(target);
}

export async function executeAgentTool(
  name: string,
  rawArgs: string
): Promise<string> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return 'Error: No hay ninguna carpeta o workspace abierto en VS Code.';
  }
  const workspaceRoot = folders[0].uri.fsPath;

  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return 'Error: Argumentos JSON inválidos en la llamada a la herramienta.';
  }

  if (name === 'list_files') {
    const pattern =
      typeof args.globPattern === 'string' && args.globPattern.trim().length > 0
        ? args.globPattern.trim()
        : '**/*';

    const uris = await vscode.workspace.findFiles(
      pattern,
      '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}',
      150
    );
    const files = uris.map((u) => vscode.workspace.asRelativePath(u));
    return JSON.stringify({ count: files.length, files }, null, 2);
  }

  if (name === 'read_file') {
    const rel = String(args.relativePath || '').trim();
    if (!rel) {
      return 'Error: Falta relativePath.';
    }
    try {
      const uri = resolveWorkspaceUri(rel);
      if (!uri) {
        return 'Error: Workspace no disponible.';
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf8');
      return text.length > 20000
        ? `${text.slice(0, 20000)}\n... [truncado por longitud]`
        : text;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error al leer archivo "${rel}": ${msg}`;
    }
  }

  if (name === 'write_file') {
    const rel = String(args.relativePath || '').trim();
    const content = String(args.content ?? '');
    if (!rel) {
      return 'Error: Falta relativePath.';
    }
    try {
      const uri = resolveWorkspaceUri(rel);
      if (!uri) {
        return 'Error: Workspace no disponible.';
      }

      const choice = await vscode.window.showInformationMessage(
        `El agente quiere escribir en "${rel}". ¿Permitir?`,
        { modal: false },
        'Permitir',
        'Denegar'
      );
      if (choice !== 'Permitir') {
        return `Acción cancelada por el usuario: no se modificó "${rel}".`;
      }

      await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(path.dirname(uri.fsPath))
      );
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
      return `Archivo guardado correctamente: ${rel}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error al escribir archivo "${rel}": ${msg}`;
    }
  }

  if (name === 'run_command') {
    const command = String(args.command || '').trim();
    if (!command) {
      return 'Error: Comando vacío.';
    }

    const choice = await vscode.window.showWarningMessage(
      `El agente quiere ejecutar: ${command}`,
      { modal: false },
      'Ejecutar',
      'Cancelar'
    );
    if (choice !== 'Ejecutar') {
      return `Comando cancelado por el usuario: ${command}`;
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: workspaceRoot,
        timeout: 30000,
        maxBuffer: 1024 * 1024
      });
      return JSON.stringify(
        {
          stdout: stdout.trim(),
          stderr: stderr.trim()
        },
        null,
        2
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error al ejecutar comando: ${msg}`;
    }
  }

  return `Herramienta desconocida: ${name}`;
}
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';

export class QuarkdownPreviewManager {
    private static instance: QuarkdownPreviewManager;
    private runningProcesses = new Map<string, ChildProcess>();
    private webviewPanels = new Map<string, vscode.WebviewPanel>();
    private activePorts = new Map<string, number>();
    private activeTempDirs = new Map<string, string>();

    public static getInstance(): QuarkdownPreviewManager {
        if (!QuarkdownPreviewManager.instance) {
            QuarkdownPreviewManager.instance = new QuarkdownPreviewManager();
        }
        return QuarkdownPreviewManager.instance;
    }

    public async openPreview(document: vscode.TextDocument, toSide: boolean = false): Promise<void> {
        const filePath = document.uri.fsPath;
        const fileName = path.basename(filePath, '.qmd');

        const existingPanel = this.webviewPanels.get(filePath);
        if (existingPanel) {
            existingPanel.reveal();
            return;
        }

        if (document.isDirty) {
            const saveResult = await vscode.window.showWarningMessage(
                'File must be saved before preview. Save now?', { modal: true }, 'Save & Preview', 'Cancel'
            );
            if (saveResult === 'Save & Preview') {
                await document.save();
            } else {
                return;
            }
        }

        this.stopProcess(filePath);

        const panel = vscode.window.createWebviewPanel(
            'quarkdownPreview',
            `Preview: ${fileName}`,
            toSide ? vscode.ViewColumn.Beside : vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [],
            }
        );

        panel.webview.html = this.getWebviewContent();

        panel.onDidDispose(() => {
            this.webviewPanels.delete(filePath);
            this.stopProcess(filePath);
        });

        this.webviewPanels.set(filePath, panel);

        this.startPreviewInBackground(document, panel).catch(error => {
            this.handlePreviewError(error, filePath);
        });
    }

    private async startPreviewInBackground(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
        const filePath = document.uri.fsPath;
        const postMessage = (message: any) => panel.webview.postMessage(message);

        try {
            postMessage({ command: 'updateStatus', text: 'Creating temporary preview directory...' });
            const tempDir = this.createTempDirectory(path.basename(filePath, '.qmd'));
            this.activeTempDirs.set(filePath, tempDir);

            postMessage({ command: 'updateStatus', text: 'Compiling document...' });
            await this.executeQuarkdownCommand(['c', filePath, '-o', tempDir], path.dirname(filePath));

            postMessage({ command: 'updateStatus', text: 'Looking for preview files...' });
            let serveDir = tempDir;
            const htmlFiles = this.findFilesRecursively(tempDir, '*.html');
            const indexHtmlFile = htmlFiles.find(f => path.basename(f) === 'index.html');

            if (indexHtmlFile) {
                serveDir = path.dirname(indexHtmlFile);
            } else {
                try {
                    const entries = fs.readdirSync(tempDir, { withFileTypes: true });
                    const directories = entries.filter(e => e.isDirectory());
                    if (directories.length === 1) {
                        serveDir = path.join(tempDir, directories[0].name);
                        console.log(`index.html not found, but found unique subdirectory, will use: ${serveDir}`);
                    }
                } catch (e) {
                    console.error("Error finding output subdirectory: ", e);
                }
            }

            postMessage({ command: 'updateStatus', text: 'Starting preview server...' });
            const port = await this.getAvailablePort();
            const config = vscode.workspace.getConfiguration('quarkdownPreview');
            const quarkdownPath = config.get<string>('quarkdownPath', 'quarkdown');

            const serverArgs = ['start', '-f', serveDir, '--port', port.toString()];
            const serverProcess = spawn(quarkdownPath, serverArgs, {
                cwd: path.dirname(filePath),
                stdio: 'pipe'
            });

            serverProcess.on('exit', (code) => {
                if (code !== 0 && code !== null) {
                    postMessage({ command: 'showError', text: `Preview server exited abnormally with code: ${code}` });
                }
                this.stopProcess(filePath);
            });
            serverProcess.on('error', (err) => {
                postMessage({ command: 'showError', text: `Failed to start server: ${err.message}` });
                this.stopProcess(filePath);
            });

            this.runningProcesses.set(filePath, serverProcess);
            this.activePorts.set(filePath, port);

            await new Promise<void>((resolve, reject) => {
                let errorOutput = '';
                let resolved = false;

                const resolveOnce = () => { if (!resolved) { resolved = true; resolve(); } };
                const rejectOnce = (err: Error) => { if (!resolved) { resolved = true; reject(err); } };

                serverProcess.stdout?.on('data', (data) => {
                    if (data.toString().includes('Serving') || data.toString().includes('Webserver running')) {
                        resolveOnce();
                    }
                });
                serverProcess.stderr?.on('data', (data) => { errorOutput += data.toString(); });
                serverProcess.on('error', (err) => rejectOnce(err));
                serverProcess.on('exit', (code) => {
                    if (code !== 0 && code !== null) {
                        rejectOnce(new Error(`Server process exited abnormally with code: ${code}. Details: ${errorOutput}`));
                    }
                });

                setTimeout(() => {
                    if (!resolved && !serverProcess.killed) resolveOnce();
                    else if (!resolved) rejectOnce(new Error('Server startup timeout'));
                }, 8000);
            });

            postMessage({ command: 'loadUrl', url: `http://localhost:${port}` });

        } catch (error: any) {
            postMessage({ command: 'showError', text: error.message });
            this.stopProcess(filePath);
        }
    }

    public async recompileForPreview(document: vscode.TextDocument): Promise<void> {
        const filePath = document.uri.fsPath;
        const tempDir = this.activeTempDirs.get(filePath);

        if (this.runningProcesses.has(filePath) && tempDir) {
            try {
                const statusBarMessage = vscode.window.setStatusBarMessage('$(sync~spin) Recompiling Quarkdown preview...');
                await this.executeQuarkdownCommand(
                    ['c', filePath, '-o', tempDir],
                    path.dirname(filePath)
                );
                statusBarMessage.dispose();
                vscode.window.setStatusBarMessage('$(check) Preview updated', 3000);

                const panel = this.webviewPanels.get(filePath);
                if (panel) {
                    panel.webview.postMessage({ command: 'reload' });
                }
            } catch (error) {
                this.handlePreviewError(error, filePath);
            }
        }
    }



    public async createProject(): Promise<void> {
        try {
            const folderOptions: vscode.OpenDialogOptions = {
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                openLabel: 'Select Project Directory'
            };

            const folderUri = await vscode.window.showOpenDialog(folderOptions);
            if (!folderUri || folderUri.length === 0) {
                return;
            }

            const projectPath = folderUri[0].fsPath;

            const projectName = await vscode.window.showInputBox({
                prompt: 'Enter project name',
                placeHolder: 'My Quarkdown Project',
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) {
                        return 'Project name cannot be empty';
                    }
                    return null;
                }
            });

            if (!projectName) {
                return;
            }

            const authors = await vscode.window.showInputBox({
                prompt: 'Enter author names (separate multiple authors with commas)',
                placeHolder: 'Author Name, Another Author'
            });

            const docTypeOptions = ['paged', 'slides', 'plain'];
            const docType = await vscode.window.showQuickPick(docTypeOptions, {
                placeHolder: 'Select document type'
            });

            if (!docType) {
                return;
            }

            const languageOptions = [
                { label: '中文 (zh)', value: 'zh' },
                { label: 'English (en)', value: 'en' },
                { label: '日本語 (ja)', value: 'ja' },
                { label: 'Français (fr)', value: 'fr' },
                { label: 'Deutsch (de)', value: 'de' }
            ];

            const selectedLanguage = await vscode.window.showQuickPick(languageOptions, {
                placeHolder: 'Select document language'
            });

            const language = selectedLanguage?.value || 'en';

            const args = [
                'create', projectPath,
                '--name', projectName,
                ...(authors ? ['--authors', authors] : []),
                '--type', docType,
                '--lang', language
            ];

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Creating Quarkdown project...',
                cancellable: true,
            }, (progress, token) => {
                return this.executeQuarkdownCommand(args, undefined, progress, token);
            });

            vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectPath), true);

        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create project: ${error}`);
        }
    }

    public async compileDocument(document: vscode.TextDocument, toPdf: boolean = false): Promise<void> {
        const filePath = document.uri.fsPath;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('Unable to determine workspace folder');
            return;
        }

        if (document.isDirty) {
            const saveResult = await vscode.window.showWarningMessage('File must be saved before compilation. Save now?', { modal: true }, 'Save & Compile', 'Cancel');
            if (saveResult === 'Save & Compile') {
                await document.save();
            } else {
                return;
            }
        }

        const defaultTempDir = this.createTempDirectory(path.basename(filePath, '.qmd'));
        const folderOptions: vscode.OpenDialogOptions = {
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Open',
            defaultUri: vscode.Uri.file(defaultTempDir)
        };
        const folderUri = await vscode.window.showOpenDialog(folderOptions);
        if (!folderUri || folderUri.length === 0) {
            return;
        }
        const outputDir = folderUri[0].fsPath;

        const progressTitle = toPdf ? 'Compiling to PDF...' : 'Compiling document...';

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: progressTitle,
            cancellable: true
        }, async (progress, token) => {
            try {
                progress.report({ increment: 10, message: 'Starting compilation...' });

                const args = ['c', filePath, '-o', outputDir];
                if (toPdf) {
                    args.push('--pdf');
                }

                await this.executeQuarkdownCommand(args, workspaceFolder.uri.fsPath, progress, token);

                progress.report({ increment: 80, message: 'Searching for output files...' });
                await new Promise(resolve => setTimeout(resolve, 500));

                const foundFiles = this.findOutputFiles(filePath, outputDir, toPdf);

                progress.report({ increment: 100, message: 'Done!' });
                await new Promise(resolve => setTimeout(resolve, 500));

                this.showCompilationResult(foundFiles, outputDir, toPdf);
            } catch (error) {
                this.handlePreviewError(error, filePath);
            }
        });
    }

    private findOutputFiles(sourcePath: string, outputDir: string, isPdf: boolean): string[] {
        const fileName = path.basename(sourcePath, '.qmd');
        const baseName = fileName === 'test-example' ? 'Untitled-Quarkdown-Document' : fileName;
        let foundFiles: string[] = [];

        try {
            if (isPdf) {
                const pdfFile = path.join(outputDir, `${baseName}.pdf`);
                if (fs.existsSync(pdfFile)) {
                    foundFiles.push(pdfFile);
                }
            } else {
                const projectDir = path.join(outputDir, baseName);
                const htmlFile = path.join(projectDir, 'index.html');
                if (fs.existsSync(htmlFile)) {
                    foundFiles.push(htmlFile);
                }
            }

            if (foundFiles.length === 0) {
                const searchPattern = isPdf ? '*.pdf' : '*.html';
                const allFiles = this.findFilesRecursively(outputDir, searchPattern);
                foundFiles = allFiles.filter(file => {
                    const fileBaseName = path.basename(file, path.extname(file));
                    return fileBaseName.includes(fileName) ||
                        fileBaseName.includes(baseName) ||
                        fileBaseName === 'index';
                });
            }
        } catch (e) {
            console.log('Error checking output files:', e);
        }
        return foundFiles;
    }

    private showCompilationResult(foundFiles: string[], outputDir: string, toPdf: boolean): void {
        if (foundFiles.length > 0) {
            const outputFile = foundFiles[0];
            const message = toPdf ? `✅ PDF compilation completed!\nOutput file: ${outputFile}` : `✅ Document compilation completed!\nOutput file: ${outputFile}`;
            vscode.window.showInformationMessage(
                message,
                'Open File', 'Open Output Directory', 'Show in File Explorer'
            ).then(selection => {
                if (selection === 'Open File') {
                    vscode.env.openExternal(vscode.Uri.file(outputFile));
                } else if (selection === 'Open Output Directory') {
                    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(outputDir), false);
                } else if (selection === 'Show in File Explorer') {
                    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outputFile));
                }
            });
        } else {
            try {
                const files = fs.readdirSync(outputDir);
                const message = `✅ Compilation completed!\nOutput directory: ${outputDir}\nFound ${files.length} items`;
                vscode.window.showInformationMessage(
                    message,
                    'Open Output Directory', 'Show in File Explorer'
                ).then(selection => {
                    if (selection === 'Open Output Directory') {
                        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(outputDir), false);
                    } else if (selection === 'Show in File Explorer') {
                        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outputDir));
                    }
                });
            } catch (e) {
                vscode.window.showInformationMessage(
                    `✅ Compilation completed! Output directory: ${outputDir}`,
                    'Open Output Directory'
                ).then(selection => {
                    if (selection === 'Open Output Directory') {
                        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(outputDir), false);
                    }
                });
            }
        }
    }

    private createTempDirectory(baseName: string): string {
        const config = vscode.workspace.getConfiguration('quarkdownPreview');
        const customOutputDir = config.get<string>('outputDirectory', '');

        const tempBase = customOutputDir || os.tmpdir();
        const tempDirName = `quarkdown-preview-${baseName}-${Date.now()}`;
        const tempDir = path.join(tempBase, tempDirName);

        try {
            fs.mkdirSync(tempDir, { recursive: true });
            console.log(`Created output directory: ${tempDir}`);
        } catch (error) {
            console.error('Failed to create output directory:', error);
            throw new Error(`Unable to create output directory: ${error}`);
        }

        return tempDir;
    }

    private async getAvailablePort(): Promise<number> {
        return new Promise((resolve, reject) => {
            const server = net.createServer();
            server.listen(0, () => {
                const port = (server.address() as net.AddressInfo)?.port;
                server.close(() => {
                    if (port) {
                        resolve(port);
                    } else {
                        reject(new Error('Unable to get available port'));
                    }
                });
            });
            server.on('error', reject);
        });
    }

    private async executeQuarkdownCommand(
        args: string[],
        cwd?: string,
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        token?: vscode.CancellationToken
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const config = vscode.workspace.getConfiguration('quarkdownPreview');
            const quarkdownPath = config.get<string>('quarkdownPath', 'quarkdown');

            console.log(`Executing command: ${quarkdownPath} ${args.join(' ')}`);
            console.log(`Working directory: ${cwd || process.cwd()}`);

            const childProcess = spawn(quarkdownPath, args, {
                cwd: cwd,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            token?.onCancellationRequested(() => {
                console.log('User cancelled operation');
                childProcess.kill('SIGTERM');
            });

            let output = '';
            let errorOutput = '';
            let progressReported = 10;

            childProcess.stdout?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                output += chunk;
                console.log(`Quarkdown stdout: ${chunk.trim()}`);

                if (progressReported < 70) {
                    progressReported += 5;
                    progress?.report({ increment: 5, message: 'Compiling...' });
                }
            });

            childProcess.stderr?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                errorOutput += chunk;
                console.log(`Quarkdown stderr: ${chunk.trim()}`);
            });

            childProcess.on('close', (code: number | null) => {
                console.log(`Quarkdown command completed with exit code: ${code}`);
                if (code === 0) {
                    resolve();
                } else {
                    let errorMessage = errorOutput || output || `Process exited abnormally with code: ${code}`;
                    if (errorOutput.includes('No such file') || errorOutput.includes('cannot find')) {
                        errorMessage = `File not found. Please check if the path is correct.\nDetails: ${errorOutput}`;
                    } else if (errorOutput.includes('Permission denied')) {
                        errorMessage = `Permission denied. Please check file permissions.\nDetails: ${errorOutput}`;
                    } else if (errorOutput.includes('syntax error') || errorOutput.includes('parse error')) {
                        errorMessage = `Syntax error. Please check Quarkdown file syntax.\nDetails: ${errorOutput}`;
                    }
                    reject(new Error(errorMessage));
                }
            });

            childProcess.on('error', (error: Error) => {
                console.log(`Failed to start Quarkdown process: ${error.message}`);
                reject(error);
            });

            if (token?.isCancellationRequested) {
                childProcess.kill('SIGTERM');
            }
        });
    }

    private handlePreviewError(error: any, filePath: string): void {
        const errorMessage = error?.message || error?.toString() || 'Unknown error';

        if (errorMessage.includes('Cannot call function row')) {
            const suggestion = this.getSyntaxSuggestion(errorMessage, 'row');
            vscode.window.showErrorMessage(
                `Quarkdown syntax error: ${suggestion}`,
                'View Syntax Reference',
                'View Detailed Error in Terminal'
            ).then(selection => {
                if (selection === 'View Syntax Reference') {
                    this.openSyntaxReference();
                } else if (selection === 'View Detailed Error in Terminal') {
                    this.showDetailedError(errorMessage, filePath);
                }
            });
        } else if (errorMessage.includes('Cannot call function')) {
            const functionName = this.extractFunctionName(errorMessage);
            const suggestion = this.getSyntaxSuggestion(errorMessage, functionName);
            vscode.window.showErrorMessage(
                `Quarkdown function call error: ${suggestion}`,
                'View Syntax Reference',
                'View Detailed Error in Terminal'
            ).then(selection => {
                if (selection === 'View Syntax Reference') {
                    this.openSyntaxReference();
                } else if (selection === 'View Detailed Error in Terminal') {
                    this.showDetailedError(errorMessage, filePath);
                }
            });
        } else {
            vscode.window.showErrorMessage(
                `Quarkdown preview failed: ${errorMessage}`,
                'View Details',
                'Check Installation'
            ).then(selection => {
                if (selection === 'View Details') {
                    this.showDetailedError(errorMessage, filePath);
                } else if (selection === 'Check Installation') {
                    this.checkQuarkdownInstallation();
                }
            });
        }
    }

    private getSyntaxSuggestion(errorMessage: string, functionName: string): string {
        switch (functionName) {
            case 'row':
                if (errorMessage.includes('No such element')) {
                    return 'Please check the alignment parameter for .row function. Valid values include: start, center, end, spacebetween, spacearound, spaceevenly';
                }
                return 'Please check the parameter format for .row function. Correct format: .row alignment:{center} gap:{10px}';

            case 'col':
                return 'Please check the parameter format for .col function. Parameters are the same as .row';

            case 'container':
                return 'Please check the parameter format for .container function. Example: .container width:{80%}';

            default:
                return `Please check if the syntax for .${functionName} function is correct`;
        }
    }

    private extractFunctionName(errorMessage: string): string {
        const match = errorMessage.match(/Cannot call function (\w+)/);
        return match ? match[1] : 'unknown';
    }

    private openSyntaxReference(): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            const syntaxFilePath = path.join(workspaceFolder.uri.fsPath, 'quarkdown-syntax.md');
            if (fs.existsSync(syntaxFilePath)) {
                vscode.workspace.openTextDocument(syntaxFilePath).then(doc => {
                    vscode.window.showTextDocument(doc);
                });
            } else {
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/iamgio/quarkdown'));
            }
        }
    }

    private showDetailedError(errorMessage: string, filePath: string): void {
        const outputChannel = vscode.window.createOutputChannel('Quarkdown Preview');
        outputChannel.appendLine('='.repeat(50));
        outputChannel.appendLine(`Error time: ${new Date().toLocaleString()}`);
        outputChannel.appendLine(`File path: ${filePath}`);
        outputChannel.appendLine(`Error message: ${errorMessage}`);
        outputChannel.appendLine('='.repeat(50));
        outputChannel.show();
    }

    private checkQuarkdownInstallation(): void {
        validateQuarkdownInstallation().then(isInstalled => {
            if (!isInstalled) {
                vscode.window.showErrorMessage(
                    'Quarkdown is not properly installed. Please check installation and configuration',
                    'Open Installation Guide',
                    'Open Settings'
                ).then(selection => {
                    if (selection === 'Open Installation Guide') {
                        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                        if (workspaceFolder) {
                            const installFilePath = path.join(workspaceFolder.uri.fsPath, 'INSTALL.md');
                            if (fs.existsSync(installFilePath)) {
                                vscode.workspace.openTextDocument(installFilePath).then(doc => {
                                    vscode.window.showTextDocument(doc);
                                });
                            }
                        }
                    } else if (selection === 'Open Settings') {
                        vscode.commands.executeCommand('workbench.action.openSettings', 'quarkdownPreview.quarkdownPath');
                    }
                });
            } else {
                vscode.window.showInformationMessage('Quarkdown installation is normal, this might be a file syntax issue');
            }
        });
    }

    public stopProcess(filePath: string): void {
        const process = this.runningProcesses.get(filePath);
        if (process) {
            process.kill('SIGTERM');
            this.runningProcesses.delete(filePath);
        }
        this.activePorts.delete(filePath);
        this.activeTempDirs.delete(filePath);
    }

    public stopAllProcesses(): void {
        for (const [filePath, process] of this.runningProcesses) {
            process.kill('SIGTERM');
        }
        this.runningProcesses.clear();
        this.activePorts.clear();
        this.activeTempDirs.clear();
    }

    public dispose(): void {
        this.stopAllProcesses();

        for (const panel of this.webviewPanels.values()) {
            panel.dispose();
        }
        this.webviewPanels.clear();
    }

    private findFilesRecursively(dir: string, pattern: string): string[] {
        const results: string[] = [];

        try {
            const files = fs.readdirSync(dir);

            for (const file of files) {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);

                if (stat.isDirectory()) {
                    results.push(...this.findFilesRecursively(fullPath, pattern));
                } else if (stat.isFile()) {
                    if (pattern === '*.pdf' && file.endsWith('.pdf')) {
                        results.push(fullPath);
                    } else if (pattern === '*.html' && file.endsWith('.html')) {
                        results.push(fullPath);
                    }
                }
            }
        } catch (e) {
            console.log(`Error reading directory ${dir}:`, e);
        }

        return results;
    }

    private getWebviewContent(): string {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none';
                    frame-src http://localhost:*;
                    script-src 'vscode-resource:' 'unsafe-inline';
                    style-src 'unsafe-inline';
                    img-src data: http: https:;">
                <title>Quarkdown Preview</title>
                <style>
                    body, html {
                        margin: 0;
                        padding: 0;
                        height: 100%;
                        overflow: hidden;
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        background-color: var(--vscode-editor-background);
                        color: var(--vscode-editor-foreground);
                    }
                    iframe {
                        width: 100%;
                        height: 100vh;
                        border: none;
                    }
                    .loading, .error {
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        flex-direction: column;
                    }
                    .loading-spinner {
                        width: 40px;
                        height: 40px;
                        border: 4px solid var(--vscode-editor-foreground, #f3f3f3);
                        border-top: 4px solid var(--vscode-button-background, #007acc);
                        opacity: 0.3;
                        border-radius: 50%;
                        animation: spin 1s linear infinite;
                        margin-bottom: 15px;
                    }
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                    .error {
                        display: none;
                        color: var(--vscode-errorForeground);
                        text-align: center;
                        padding: 20px;
                    }
                    .error-details {
                        margin-top: 15px;
                        padding: 15px;
                        background-color: var(--vscode-textBlockQuote-background);
                        border-radius: 6px;
                        font-size: 13px;
                        max-width: 600px;
                        line-height: 1.4;
                        text-align: left;
                    }
                    .retry-button {
                        margin-top: 20px;
                        padding: 10px 20px;
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 14px;
                    }
                </style>
            </head>
            <body>
                <div class="loading" id="loading">
                    <div class="loading-spinner"></div>
                    <div id="loading-message">Preparing preview environment...</div>
                </div>
                <div class="error" id="error">
                    <h3>❌ Preview Loading Failed</h3>
                    <p id="error-message-details">An unknown error occurred.</p>
                    <div class="error-details">
                        <strong>Common causes:</strong><br>
                        • Quarkdown is not properly installed or path configuration is incorrect<br>
                        • .qmd file contains syntax errors<br>
                        • Insufficient permissions to read/write temporary directory
                    </div>
                    <button class="retry-button" onclick="vscode.postMessage({ command: 'retry' })">
                        Retry
                    </button>
                </div>
                <iframe id="preview" style="display: none;"></iframe>

                <script>
                    const vscode = acquireVsCodeApi();
                    const iframe = document.getElementById('preview');
                    const loading = document.getElementById('loading');
                    const loadingMessage = document.getElementById('loading-message');
                    const error = document.getElementById('error');
                    const errorMessageDetails = document.getElementById('error-message-details');

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.command) {
                            case 'updateStatus':
                                loading.style.display = 'flex';
                                error.style.display = 'none';
                                iframe.style.display = 'none';
                                if (loadingMessage) {
                                    loadingMessage.textContent = message.text;
                                }
                                break;
                            case 'loadUrl':
                                loading.style.display = 'none';
                                error.style.display = 'none';
                                iframe.style.display = 'block';
                                iframe.src = message.url;
                                break;
                            case 'showError':
                                loading.style.display = 'none';
                                error.style.display = 'flex';
                                iframe.style.display = 'none';
                                if (errorMessageDetails) {
                                    errorMessageDetails.textContent = message.text;
                                }
                                break;
                            case 'reload':
                                const iframeSrc = iframe.src;
                                if (iframeSrc && iframeSrc !== 'about:blank') {
                                    iframe.src = 'about:blank';
                                    setTimeout(() => { iframe.src = iframeSrc; }, 100);
                                }
                                break;
                        }
                    });

                    // Handle retry button
                    const retryButton = document.querySelector('.retry-button');
                    if (retryButton) {
                        retryButton.addEventListener('click', () => {
                            vscode.postMessage({ command: 'retry' });
                        });
                    }
                </script>
            </body>
            </html>
        `;
    }
}

export function validateQuarkdownInstallation(): Promise<boolean> {
    return new Promise((resolve) => {
        const config = vscode.workspace.getConfiguration('quarkdownPreview');
        const quarkdownPath = config.get<string>('quarkdownPath', 'quarkdown');

        console.log(`Starting Quarkdown installation detection: ${quarkdownPath}`);

        const process = spawn(quarkdownPath, ['--help'], {
            stdio: 'pipe',
            timeout: 15000,
            shell: true
        });

        let hasResolved = false;
        let stdoutData = '';
        let stderrData = '';

        const resolveOnce = (result: boolean, reason?: string) => {
            if (!hasResolved) {
                hasResolved = true;
                const status = result ? 'Installed' : 'Not installed';
                const message = reason ? `${status} (${reason})` : status;
                console.log(`Quarkdown detection result: ${message}`);

                if (!result) {
                    console.log('Detection details:');
                    console.log(`- Configured path: ${quarkdownPath}`);
                    console.log(`- stdout output: ${stdoutData || '(none)'}`);
                    console.log(`- stderr output: ${stderrData || '(none)'}`);
                }

                resolve(result);
            }
        };

        process.stdout?.on('data', (data) => {
            const output = data.toString();
            stdoutData += output;
            console.log(`Quarkdown stdout: ${output.trim()}`);

            const lowercaseOutput = output.toLowerCase();
            if (lowercaseOutput.includes('usage: quarkdown') ||
                lowercaseOutput.includes('commands:') ||
                (lowercaseOutput.includes('quarkdown') && (lowercaseOutput.includes('help') || lowercaseOutput.includes('options')))) {
                resolveOnce(true, 'Detected Quarkdown help information');
            }
        });

        process.stderr?.on('data', (data) => {
            const error = data.toString();
            stderrData += error;
            console.log(`Quarkdown stderr: ${error.trim()}`);
        });

        process.on('close', (code, signal) => {
            console.log(`Quarkdown detection process exited - code: ${code}, signal: ${signal}`);

            if (code === 0) {
                if (stdoutData.includes('Usage: quarkdown') || stdoutData.includes('Commands:')) {
                    resolveOnce(true, 'Detected Quarkdown program');
                } else {
                    resolveOnce(false, 'Output format does not match');
                }
            } else if (code === null && signal) {
                resolveOnce(false, `Process terminated by signal: ${signal}`);
            } else {
                if (stdoutData.includes('Usage: quarkdown') || stderrData.includes('quarkdown')) {
                    resolveOnce(true, 'Program exists but exited with non-zero code');
                } else {
                    resolveOnce(false, `Process exited abnormally: ${code}`);
                }
            }
        });

        process.on('error', (error) => {
            console.log(`Quarkdown detection process error: ${error.message}`);

            let errorReason = 'Unknown error';
            if (error.message.includes('ENOENT')) {
                errorReason = 'Executable file not found';
                console.log(`Suggested checks:
1. Is the file path correct: ${quarkdownPath}
2. Does the file exist
3. Does it have execution permissions`);
            } else if (error.message.includes('EACCES')) {
                errorReason = 'Insufficient permissions';
                console.log('Suggested to check file execution permissions');
            } else if (error.message.includes('EMFILE') || error.message.includes('ENFILE')) {
                errorReason = 'System resource limit';
            }

            resolveOnce(false, errorReason);
        });

        process.on('spawn', () => {
            console.log('Quarkdown detection process started');
        });

        setTimeout(() => {
            if (!hasResolved) {
                console.log('Quarkdown detection timeout, forcing process termination');
                try {
                    process.kill('SIGTERM');
                    setTimeout(() => {
                        if (!process.killed) {
                            console.log('Force killing process');
                            process.kill('SIGKILL');
                        }
                    }, 2000);
                } catch (e) {
                    console.log('Error occurred while terminating process:', e);
                }
                resolveOnce(false, 'Detection timeout');
            }
        }, 15000);
    });
}
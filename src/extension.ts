// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { QuarkdownPreviewManager, validateQuarkdownInstallation } from './quarkdownPreview';

let previewManager: QuarkdownPreviewManager;
let installationCheckCache: { isValid: boolean; result: boolean; timestamp: number } | null = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache

// Lazy installation check
async function checkInstallationIfNeeded(showWarning: boolean = true): Promise<boolean> {
	const now = Date.now();

	// Check if cache is valid
	if (installationCheckCache &&
		installationCheckCache.isValid &&
		(now - installationCheckCache.timestamp) < CACHE_DURATION) {
		return installationCheckCache.result;
	}

	// Perform check
	const isInstalled = await validateQuarkdownInstallation();

	// Update cache
	installationCheckCache = {
		isValid: true,
		result: isInstalled,
		timestamp: now
	};

	// Show warning only when explicitly requested and not installed
	if (!isInstalled && showWarning) {
		vscode.window.showWarningMessage(
			'Quarkdown is not installed or not in PATH. Please install Quarkdown or configure the correct path in settings.',
			'Open Settings',
			'Learn More',
			'Don\'t Show Again'
		).then(selection => {
			if (selection === 'Open Settings') {
				vscode.commands.executeCommand('workbench.action.openSettings', 'quarkdownPreview.quarkdownPath');
			} else if (selection === 'Learn More') {
				vscode.env.openExternal(vscode.Uri.parse('https://github.com/iamgio/quarkdown'));
			} else if (selection === 'Don\'t Show Again') {
				// User chose not to show again, set a long-term cache
				installationCheckCache = {
					isValid: true,
					result: true, // Pretend it's installed to avoid future prompts
					timestamp: now
				};
			}
		});
	}

	return isInstalled;
}

// Clear installation check cache
function clearInstallationCache() {
	installationCheckCache = null;
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	console.log('Quarkdown Preview extension activated');

	// Initialize preview manager
	previewManager = QuarkdownPreviewManager.getInstance();

	// Register open preview command
	const openPreviewCommand = vscode.commands.registerCommand(
		'quarkdown-preview.openPreview',
		async () => {
			const activeEditor = vscode.window.activeTextEditor;
			if (!activeEditor) {
				vscode.window.showInformationMessage('Please open a .qmd file first');
				return;
			}

			const document = activeEditor.document;
			if (!document.fileName.endsWith('.qmd') && !document.fileName.endsWith('.qd')) {
				vscode.window.showInformationMessage('Current file is not a .qmd or .qd file');
				return;
			}

			// Check installation before using functionality
			const isInstalled = await checkInstallationIfNeeded();
			if (!isInstalled) {
				return; // Stop execution if not installed
			}

			await previewManager.openPreview(document, false);
		}
	);

	// Register open preview to side command
	const openPreviewToSideCommand = vscode.commands.registerCommand(
		'quarkdown-preview.openPreviewToSide',
		async () => {
			const activeEditor = vscode.window.activeTextEditor;
			if (!activeEditor) {
				vscode.window.showInformationMessage('Please open a .qmd file first');
				return;
			}

			const document = activeEditor.document;
			if (!document.fileName.endsWith('.qmd') && !document.fileName.endsWith('.qd')) {
				vscode.window.showInformationMessage('Current file is not a .qmd or .qd file');
				return;
			}

			// Check installation before using functionality
			const isInstalled = await checkInstallationIfNeeded();
			if (!isInstalled) {
				return; // Stop execution if not installed
			}

			await previewManager.openPreview(document, true);
		}
	);

	// Register create project command
	const createProjectCommand = vscode.commands.registerCommand(
		'quarkdown-preview.createProject',
		async () => {
			// Check installation before using functionality
			const isInstalled = await checkInstallationIfNeeded();
			if (!isInstalled) {
				return; // Stop execution if not installed
			}

			await previewManager.createProject();
		}
	);

	// Register compile document command
	const compileCommand = vscode.commands.registerCommand(
		'quarkdown-preview.compile',
		async () => {
			const activeEditor = vscode.window.activeTextEditor;
			if (!activeEditor) {
				vscode.window.showInformationMessage('Please open a .qmd file first');
				return;
			}

			const document = activeEditor.document;
			if (!document.fileName.endsWith('.qmd') && !document.fileName.endsWith('.qd')) {
				vscode.window.showInformationMessage('Current file is not a .qmd or .qd file');
				return;
			}

			// Check installation before using functionality
			const isInstalled = await checkInstallationIfNeeded();
			if (!isInstalled) {
				return; // Stop execution if not installed
			}

			await previewManager.compileDocument(document, false);
		}
	);

	// Register compile to PDF command
	const compileToPdfCommand = vscode.commands.registerCommand(
		'quarkdown-preview.compileToPdf',
		async () => {
			const activeEditor = vscode.window.activeTextEditor;
			if (!activeEditor) {
				vscode.window.showInformationMessage('Please open a .qmd file first');
				return;
			}

			const document = activeEditor.document;
			if (!document.fileName.endsWith('.qmd') && !document.fileName.endsWith('.qd')) {
				vscode.window.showInformationMessage('Current file is not a .qmd or .qd file');
				return;
			}

			// Check installation before using functionality
			const isInstalled = await checkInstallationIfNeeded();
			if (!isInstalled) {
				return; // Stop execution if not installed
			}

			await previewManager.compileDocument(document, true);
		}
	);

	// Listen for document save events to auto-update preview
	const onDocumentSaveDisposable = vscode.workspace.onDidSaveTextDocument(async (document) => {
		if (document.fileName.endsWith('.qmd') || document.fileName.endsWith('.qd')) {
			// Recompile preview if this document's preview is open
			await previewManager.recompileForPreview(document);
		}
	});

	// Listen for active editor changes
	const onActiveEditorChangeDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
		if (editor && (editor.document.fileName.endsWith('.qmd') || editor.document.fileName.endsWith('.qd'))) {
			// Could add status bar info or other UI updates here
		}
	});

	// Register status bar item
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

	const updateStatusBar = () => {
		const activeEditor = vscode.window.activeTextEditor;
		if (activeEditor && (activeEditor.document.fileName.endsWith('.qmd') || activeEditor.document.fileName.endsWith('.qd'))) {
			statusBarItem.text = '$(open-preview) Quarkdown';
			statusBarItem.tooltip = 'Click to preview current Quarkdown file';
			statusBarItem.command = 'quarkdown-preview.openPreviewToSide';
			statusBarItem.show();
		} else {
			statusBarItem.hide();
		}
	};

	// Initial status bar update
	updateStatusBar();

	// Listen for editor changes to update status bar
	const statusBarUpdateDisposable = vscode.window.onDidChangeActiveTextEditor(updateStatusBar);

	// Register configuration change listener
	const configChangeDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration('quarkdownPreview')) {
			// Clear cache when configuration changes, but don't immediately check
			clearInstallationCache();
			console.log('Quarkdown configuration changed, cache cleared');
		}
	});

	// Add resource cleanup
	context.subscriptions.push(
		openPreviewCommand,
		openPreviewToSideCommand,
		createProjectCommand,
		compileCommand,
		compileToPdfCommand,
		onDocumentSaveDisposable,
		onActiveEditorChangeDisposable,
		statusBarUpdateDisposable,
		configChangeDisposable,
		statusBarItem
	);
}

// This method is called when your extension is deactivated
export function deactivate() {
	if (previewManager) {
		previewManager.dispose();
	}
}

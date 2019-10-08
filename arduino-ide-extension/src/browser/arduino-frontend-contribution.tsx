import * as React from 'react';
import { injectable, inject, postConstruct } from 'inversify';
import URI from '@theia/core/lib/common/uri';
import { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { CommandContribution, CommandRegistry, Command } from '@theia/core/lib/common/command';
import { TabBarToolbarContribution, TabBarToolbarRegistry } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { BoardsService } from '../common/protocol/boards-service';
import { ArduinoCommands } from './arduino-commands';
import { CoreService } from '../common/protocol/core-service';
import { WorkspaceServiceExt } from './workspace-service-ext';
import { ToolOutputServiceClient } from '../common/protocol/tool-output-service';
import { QuickPickService } from '@theia/core/lib/common/quick-pick-service';
import { BoardsListWidgetFrontendContribution } from './boards/boards-widget-frontend-contribution';
import { BoardsServiceClientImpl } from './boards/boards-service-client-impl';
import { WorkspaceRootUriAwareCommandHandler, WorkspaceCommands } from '@theia/workspace/lib/browser/workspace-commands';
import { SelectionService, MenuContribution, MenuModelRegistry, MAIN_MENU_BAR, MenuPath } from '@theia/core';
import { ArduinoToolbar } from './toolbar/arduino-toolbar';
import { EditorManager, EditorMainMenu } from '@theia/editor/lib/browser';
import {
    ContextMenuRenderer,
    OpenerService,
    Widget,
    StatusBar,
    ShellLayoutRestorer,
    StatusBarAlignment,
    QuickOpenService
} from '@theia/core/lib/browser';
import { OpenFileDialogProps, FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { FileSystem, FileStat } from '@theia/filesystem/lib/common';
import { Sketch, SketchesService } from '../common/protocol/sketches-service';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { CommonCommands, CommonMenus } from '@theia/core/lib/browser/common-frontend-contribution';
import { FileSystemCommands } from '@theia/filesystem/lib/browser/filesystem-frontend-contribution';
import { FileDownloadCommands } from '@theia/filesystem/lib/browser/download/file-download-command-contribution';
import { MonacoMenus } from '@theia/monaco/lib/browser/monaco-menu';
import { TerminalMenus } from '@theia/terminal/lib/browser/terminal-frontend-contribution';
import { MaybePromise } from '@theia/core/lib/common/types';
import { BoardsConfigDialog } from './boards/boards-config-dialog';
import { BoardsToolBarItem } from './boards/boards-toolbar-item';
import { BoardsConfig } from './boards/boards-config';
import { MonitorService } from '../common/protocol/monitor-service';
import { ConfigService } from '../common/protocol/config-service';
import { MonitorConnection } from './monitor/monitor-connection';
import { MonitorViewContribution } from './monitor/monitor-view-contribution';
import { ArduinoWorkspaceService } from './arduino-workspace-service';

export namespace ArduinoMenus {
    export const SKETCH = [...MAIN_MENU_BAR, '3_sketch'];
    export const TOOLS = [...MAIN_MENU_BAR, '4_tools'];
}

export namespace ArduinoToolbarContextMenu {
    export const OPEN_SKETCH_PATH: MenuPath = ['arduino-open-sketch-context-menu'];
    export const OPEN_GROUP: MenuPath = [...OPEN_SKETCH_PATH, '1_open'];
    export const WS_SKETCHES_GROUP: MenuPath = [...OPEN_SKETCH_PATH, '2_sketches'];
    export const EXAMPLE_SKETCHES_GROUP: MenuPath = [...OPEN_SKETCH_PATH, '3_examples'];
}

export namespace ArduinoAdvancedMode {
    export const LS_ID = 'arduino-advanced-mode';
    export const TOGGLED: boolean = (() => {
        const advancedModeStr = window.localStorage.getItem(LS_ID);
        return advancedModeStr === 'true';
    })();
}

@injectable()
export class ArduinoFrontendContribution implements TabBarToolbarContribution, CommandContribution, MenuContribution {

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(BoardsService)
    protected readonly boardsService: BoardsService;

    @inject(CoreService)
    protected readonly coreService: CoreService;

    @inject(MonitorService)
    protected readonly monitorService: MonitorService;

    @inject(WorkspaceServiceExt)
    protected readonly workspaceServiceExt: WorkspaceServiceExt;

    @inject(ToolOutputServiceClient)
    protected readonly toolOutputServiceClient: ToolOutputServiceClient;

    @inject(QuickPickService)
    protected readonly quickPickService: QuickPickService;

    @inject(BoardsListWidgetFrontendContribution)
    protected readonly boardsListWidgetFrontendContribution: BoardsListWidgetFrontendContribution;

    @inject(BoardsServiceClientImpl)
    protected readonly boardsServiceClient: BoardsServiceClientImpl;

    @inject(SelectionService)
    protected readonly selectionService: SelectionService;

    @inject(EditorManager)
    protected readonly editorManager: EditorManager;

    @inject(ContextMenuRenderer)
    protected readonly contextMenuRenderer: ContextMenuRenderer;

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

    @inject(FileSystem)
    protected readonly fileSystem: FileSystem;

    @inject(OpenerService)
    protected readonly openerService: OpenerService;

    @inject(WindowService)
    protected readonly windowService: WindowService;

    @inject(SketchesService)
    protected readonly sketchService: SketchesService;

    @inject(BoardsConfigDialog)
    protected readonly boardsConfigDialog: BoardsConfigDialog;

    @inject(MenuModelRegistry)
    protected readonly menuRegistry: MenuModelRegistry;

    @inject(CommandRegistry)
    protected readonly commands: CommandRegistry;

    @inject(StatusBar)
    protected readonly statusBar: StatusBar;

    @inject(ShellLayoutRestorer)
    protected readonly layoutRestorer: ShellLayoutRestorer;

    @inject(QuickOpenService)
    protected readonly quickOpenService: QuickOpenService;

    @inject(ArduinoWorkspaceService)
    protected readonly workspaceService: ArduinoWorkspaceService;

    @inject(ConfigService)
    protected readonly configService: ConfigService;

    @inject(MonitorConnection)
    protected readonly monitorConnection: MonitorConnection;

    protected boardsToolbarItem: BoardsToolBarItem | null;
    protected wsSketchCount: number = 0;

    @postConstruct()
    protected async init(): Promise<void> {
        // This is a hack. Otherwise, the backend services won't bind.
        await this.workspaceServiceExt.roots();

        const updateStatusBar = (config: BoardsConfig.Config) => {
            this.statusBar.setElement('arduino-selected-board', {
                alignment: StatusBarAlignment.RIGHT,
                text: BoardsConfig.Config.toString(config)
            });
        }
        this.boardsServiceClient.onBoardsConfigChanged(updateStatusBar);
        updateStatusBar(this.boardsServiceClient.boardsConfig);

        this.registerSketchesInMenu(this.menuRegistry);

        this.boardsService.getAttachedBoards().then(({ boards }) => this.boardsServiceClient.tryReconnect(boards));
    }

    registerToolbarItems(registry: TabBarToolbarRegistry): void {
        registry.registerItem({
            id: ArduinoCommands.VERIFY.id,
            command: ArduinoCommands.VERIFY.id,
            tooltip: 'Verify'
        });
        registry.registerItem({
            id: ArduinoCommands.UPLOAD.id,
            command: ArduinoCommands.UPLOAD.id,
            tooltip: 'Upload'
        });
        registry.registerItem({
            id: ArduinoCommands.SHOW_OPEN_CONTEXT_MENU.id,
            command: ArduinoCommands.SHOW_OPEN_CONTEXT_MENU.id,
            tooltip: 'Open'
        });
        registry.registerItem({
            id: ArduinoCommands.SAVE_SKETCH.id,
            command: ArduinoCommands.SAVE_SKETCH.id,
            tooltip: 'Save'
        });
        registry.registerItem({
            id: BoardsToolBarItem.TOOLBAR_ID,
            render: () => <BoardsToolBarItem
                key='boardsToolbarItem'
                ref={ref => this.boardsToolbarItem = ref}
                commands={this.commands}
                boardsServiceClient={this.boardsServiceClient}
                boardService={this.boardsService} />,
            isVisible: widget => ArduinoToolbar.is(widget) && widget.side === 'left'
        });
        registry.registerItem({
            id: 'toggle-serial-monitor',
            command: MonitorViewContribution.OPEN_SERIAL_MONITOR,
            tooltip: 'Toggle Serial Monitor',
            isVisible: widget => ArduinoToolbar.is(widget) && widget.side === 'right'
        });

        registry.registerItem({
            id: ArduinoCommands.TOGGLE_ADVANCED_MODE.id,
            command: ArduinoCommands.TOGGLE_ADVANCED_MODE.id,
            tooltip: 'Toggle Advanced Mode',
            text: (ArduinoAdvancedMode.TOGGLED ? '$(toggle-on)' : '$(toggle-off)'),
            isVisible: widget => ArduinoToolbar.is(widget) && widget.side === 'right'
        });
    }

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(ArduinoCommands.VERIFY, {
            isVisible: widget => ArduinoToolbar.is(widget) && widget.side === 'left',
            isEnabled: widget => true,
            execute: async () => {
                const widget = this.getCurrentWidget();
                if (widget instanceof EditorWidget) {
                    await widget.saveable.save();
                }

                const uri = this.toUri(widget);
                if (!uri) {
                    return;
                }

                try {
                    const { boardsConfig } = this.boardsServiceClient;
                    if (!boardsConfig || !boardsConfig.selectedBoard) {
                        throw new Error('No boards selected. Please select a board.');
                    }
                    if (!boardsConfig.selectedBoard.fqbn) {
                        throw new Error(`No core is installed for ${boardsConfig.selectedBoard.name}. Please install the board.`);
                    }
                    await this.coreService.compile({ uri: uri.toString(), board: boardsConfig.selectedBoard });
                } catch (e) {
                    await this.messageService.error(e.toString());
                }
            }
        });
        registry.registerCommand(ArduinoCommands.UPLOAD, {
            isVisible: widget => ArduinoToolbar.is(widget) && widget.side === 'left',
            isEnabled: widget => true,
            execute: async () => {
                const widget = this.getCurrentWidget();
                if (widget instanceof EditorWidget) {
                    await widget.saveable.save();
                }

                const uri = this.toUri(widget);
                if (!uri) {
                    return;
                }

                const connectionConfig = this.monitorConnection.connectionConfig;
                await this.monitorConnection.disconnect();

                try {
                    const { boardsConfig } = this.boardsServiceClient;
                    if (!boardsConfig || !boardsConfig.selectedBoard) {
                        throw new Error('No boards selected. Please select a board.');
                    }
                    const { selectedPort } = boardsConfig;
                    if (!selectedPort) {
                        throw new Error('No ports selected. Please select a port.');
                    }
                    await this.coreService.upload({ uri: uri.toString(), board: boardsConfig.selectedBoard, port: selectedPort });
                } catch (e) {
                    await this.messageService.error(e.toString());
                } finally {
                    if (connectionConfig) {
                        await this.monitorConnection.connect(connectionConfig);
                    }
                }
            }
        });
        registry.registerCommand(ArduinoCommands.SHOW_OPEN_CONTEXT_MENU, {
            isVisible: widget => ArduinoToolbar.is(widget) && widget.side === 'left',
            isEnabled: widget => ArduinoToolbar.is(widget) && widget.side === 'left',
            execute: async (widget: Widget, target: EventTarget) => {
                if (this.wsSketchCount) {
                    const el = (target as HTMLElement).parentElement;
                    if (el) {
                        this.contextMenuRenderer.render(ArduinoToolbarContextMenu.OPEN_SKETCH_PATH, {
                            x: el.getBoundingClientRect().left,
                            y: el.getBoundingClientRect().top + el.offsetHeight
                        });
                    }
                } else {
                    this.commands.executeCommand(ArduinoCommands.OPEN_FILE_NAVIGATOR.id);
                }
            }
        });
        registry.registerCommand(ArduinoCommands.OPEN_FILE_NAVIGATOR, {
            isEnabled: () => true,
            execute: () => this.doOpenFile()
        })
        registry.registerCommand(ArduinoCommands.OPEN_SKETCH, {
            isEnabled: () => true,
            execute: async (sketch: Sketch) => {
                this.workspaceService.open(new URI(sketch.uri));
            }
        })
        registry.registerCommand(ArduinoCommands.SAVE_SKETCH, {
            isEnabled: widget => ArduinoToolbar.is(widget) && widget.side === 'left',
            isVisible: widget => ArduinoToolbar.is(widget) && widget.side === 'left',
            execute: async (sketch: Sketch) => {
                registry.executeCommand(CommonCommands.SAVE_ALL.id);
            }
        })
        registry.registerCommand(ArduinoCommands.NEW_SKETCH, new WorkspaceRootUriAwareCommandHandler(this.workspaceService, this.selectionService, {
            execute: async uri => {
                try {
                    // hack: sometimes we don't get the workspace root, but the currently active file: correct for that
                    if (uri.path.ext !== "") {
                        uri = uri.withPath(uri.path.dir.dir);
                    }

                    const sketch = await this.sketchService.createNewSketch(uri.toString());
                    this.workspaceService.open(new URI(sketch.uri));
                } catch (e) {
                    await this.messageService.error(e.toString());
                }
            }
        }));
        registry.registerCommand(ArduinoCommands.OPEN_BOARDS_DIALOG, {
            isEnabled: () => true,
            execute: async () => {
                const boardsConfig = await this.boardsConfigDialog.open();
                if (boardsConfig) {
                    this.boardsServiceClient.boardsConfig = boardsConfig;
                }
            }
        })
        registry.registerCommand(ArduinoCommands.TOGGLE_ADVANCED_MODE, {
            execute: () => {
                const oldModeState = ArduinoAdvancedMode.TOGGLED;
                window.localStorage.setItem(ArduinoAdvancedMode.LS_ID, oldModeState ? 'false' : 'true');
                registry.executeCommand('reset.layout');
            },
            isVisible: widget => ArduinoToolbar.is(widget) && widget.side === 'right',
            isToggled: () => ArduinoAdvancedMode.TOGGLED
        })
    }

    registerMenus(registry: MenuModelRegistry) {
        if (!ArduinoAdvancedMode.TOGGLED) {
            // If are not in pro-mode, we have to disable the context menu for the tabs.
            // Such as `Close`, `Close All`, etc.
            for (const command of [
                CommonCommands.CLOSE_TAB,
                CommonCommands.CLOSE_OTHER_TABS,
                CommonCommands.CLOSE_RIGHT_TABS,
                CommonCommands.CLOSE_ALL_TABS,
                CommonCommands.COLLAPSE_PANEL,
                CommonCommands.TOGGLE_MAXIMIZED
            ]) {
                registry.unregisterMenuAction(command);
            }

            registry.unregisterMenuAction(FileSystemCommands.UPLOAD);
            registry.unregisterMenuAction(FileDownloadCommands.DOWNLOAD);

            registry.unregisterMenuAction(WorkspaceCommands.NEW_FOLDER);

            registry.unregisterMenuAction(WorkspaceCommands.OPEN_FOLDER);
            registry.unregisterMenuAction(WorkspaceCommands.OPEN_WORKSPACE);
            registry.unregisterMenuAction(WorkspaceCommands.OPEN_RECENT_WORKSPACE);
            registry.unregisterMenuAction(WorkspaceCommands.SAVE_WORKSPACE_AS);
            registry.unregisterMenuAction(WorkspaceCommands.CLOSE);

            registry.getMenu(MAIN_MENU_BAR).removeNode(this.getMenuId(MonacoMenus.SELECTION));
            registry.getMenu(MAIN_MENU_BAR).removeNode(this.getMenuId(EditorMainMenu.GO));
            registry.getMenu(MAIN_MENU_BAR).removeNode(this.getMenuId(TerminalMenus.TERMINAL));
            registry.getMenu(MAIN_MENU_BAR).removeNode(this.getMenuId(CommonMenus.VIEW));
        }

        registry.registerSubmenu(ArduinoMenus.SKETCH, 'Sketch');
        registry.registerMenuAction(ArduinoMenus.SKETCH, {
            commandId: ArduinoCommands.VERIFY.id,
            label: 'Verify/Compile',
            order: '1'
        });
        registry.registerMenuAction(ArduinoMenus.SKETCH, {
            commandId: ArduinoCommands.UPLOAD.id,
            label: 'Upload',
            order: '2'
        });
        registry.registerMenuAction(ArduinoToolbarContextMenu.OPEN_GROUP, {
            commandId: ArduinoCommands.OPEN_FILE_NAVIGATOR.id,
            label: 'Open...'
        });

        registry.registerSubmenu(ArduinoMenus.TOOLS, 'Tools');

        registry.registerMenuAction(CommonMenus.HELP, {
            commandId: ArduinoCommands.TOGGLE_ADVANCED_MODE.id,
            label: 'Advanced Mode'
        });

        registry.registerMenuAction([...CommonMenus.FILE, '0_new_sketch'], {
            commandId: ArduinoCommands.NEW_SKETCH.id
        });
    }

    protected getMenuId(menuPath: string[]): string {
        const index = menuPath.length - 1;
        const menuId = menuPath[index];
        return menuId;
    }

    protected async registerSketchesInMenu(registry: MenuModelRegistry): Promise<void> {
        this.sketchService.getSketches().then(sketches => {
            this.wsSketchCount = sketches.length;
            sketches.forEach(sketch => {
                const command: Command = {
                    id: 'openSketch' + sketch.name
                }
                this.commands.registerCommand(command, {
                    execute: () => this.commands.executeCommand(ArduinoCommands.OPEN_SKETCH.id, sketch)
                });

                registry.registerMenuAction(ArduinoToolbarContextMenu.WS_SKETCHES_GROUP, {
                    commandId: command.id,
                    label: sketch.name
                });
            })
        })
    }

    async openSketchFiles(uri: string): Promise<void> {
        this.sketchService.getSketchFiles(uri).then(uris => {
            for (const uri of uris) {
                this.editorManager.open(new URI(uri));
            }
        });
    }

    /**
     * Opens a file after prompting the `Open File` dialog. Resolves to `undefined`, if
     *  - the workspace root is not set,
     *  - the file to open does not exist, or
     *  - it was not a file, but a directory.
     *
     * Otherwise, resolves to the URI of the file.
     */
    protected async doOpenFile(): Promise<URI | undefined> {
        const props: OpenFileDialogProps = {
            title: WorkspaceCommands.OPEN_FILE.dialogLabel,
            canSelectFolders: false,
            canSelectFiles: true
        };
        const [rootStat] = await this.workspaceService.roots;
        const destinationFileUri = await this.fileDialogService.showOpenDialog(props, rootStat);
        if (destinationFileUri) {
            const destinationFile = await this.fileSystem.getFileStat(destinationFileUri.toString());
            if (destinationFile && !destinationFile.isDirectory) {
                const message = await this.validate(destinationFile);
                if (!message) {
                    await this.workspaceService.open(destinationFileUri);
                    return destinationFileUri;
                } else {
                    this.messageService.warn(message);
                }
            }
        }
        return undefined;
    }

    protected getCurrentWidget(): EditorWidget | undefined {
        let widget = this.editorManager.currentEditor;
        if (!widget) {
            const visibleWidgets = this.editorManager.all.filter(w => w.isVisible);
            if (visibleWidgets.length > 0) {
                widget = visibleWidgets[0];
            }
        }
        return widget;
    }

    /**
     * Returns `undefined` if the `file` is valid. Otherwise, returns with the validation error message.
     */
    protected validate(file: FileStat): MaybePromise<string | undefined> {
        const uri = new URI(file.uri);
        const path = uri.path;
        const { name, ext, dir } = path;
        if (ext !== '.ino') {
            return "Only sketches with '.ino' extension can be opened.";
        }
        if (name !== dir.name) {
            return `The file "${name}${ext}" needs to be inside a sketch folder named "${name}".`;
        }
        return undefined;
    }

    private toUri(arg: any): URI | undefined {
        if (arg instanceof URI) {
            return arg;
        }
        if (typeof arg === 'string') {
            return new URI(arg);
        }
        if (arg instanceof EditorWidget) {
            return arg.editor.uri;
        }
        return undefined;
    }

}

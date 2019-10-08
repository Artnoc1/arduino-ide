import { injectable, inject, postConstruct } from 'inversify';
import { Emitter } from '@theia/core/lib/common/event';
import { ILogger } from '@theia/core/lib/common/logger';
import { LocalStorageService } from '@theia/core/lib/browser/storage-service';
import { RecursiveRequired } from '../../common/types';
import { BoardsServiceClient, AttachedBoardsChangeEvent, BoardInstalledEvent, AttachedSerialBoard, Board } from '../../common/protocol/boards-service';
import { BoardsConfig } from './boards-config';
import { MaybePromise } from '@theia/core';

@injectable()
export class BoardsServiceClientImpl implements BoardsServiceClient {

    @inject(ILogger)
    protected logger: ILogger;

    @inject(LocalStorageService)
    protected storageService: LocalStorageService;

    protected readonly onBoardInstalledEmitter = new Emitter<BoardInstalledEvent>();
    protected readonly onAttachedBoardsChangedEmitter = new Emitter<AttachedBoardsChangeEvent>();
    protected readonly onSelectedBoardsConfigChangedEmitter = new Emitter<BoardsConfig.Config>();

    /**
     * Used for the auto-reconnecting. Sometimes, the attached board gets disconnected after uploading something to it.
     * It happens with certain boards on Windows. For example, the `MKR1000` boards is selected on post `COM5` on Windows,
     * perform an upload, the board automatically disconnects and reconnects, but on another port, `COM10`.
     * We have to listen on such changes and auto-reconnect the same board on another port.
     * See: https://arduino.slack.com/archives/CJJHJCJSJ/p1568645417013000?thread_ts=1568640504.009400&cid=CJJHJCJSJ
     */
    protected latestValidBoardsConfig: RecursiveRequired<BoardsConfig.Config> | undefined = undefined;
    protected _boardsConfig: BoardsConfig.Config = {};

    readonly onBoardsChanged = this.onAttachedBoardsChangedEmitter.event;
    readonly onBoardInstalled = this.onBoardInstalledEmitter.event;
    readonly onBoardsConfigChanged = this.onSelectedBoardsConfigChangedEmitter.event;

    @postConstruct()
    protected init(): void {
        this.loadState();
    }

    notifyAttachedBoardsChanged(event: AttachedBoardsChangeEvent): void {
        this.logger.info('Attached boards changed: ', JSON.stringify(event));
        const { detached, attached } = AttachedBoardsChangeEvent.diff(event);
        const detachedBoards = detached.filter(AttachedSerialBoard.is).map(({ port }) => port);
        const { selectedPort, selectedBoard } = this.boardsConfig;
        this.onAttachedBoardsChangedEmitter.fire(event);
        // Dynamically unset the port if the selected board was an attached one and we detached it.
        if (!!selectedPort && detachedBoards.indexOf(selectedPort) !== -1) {
            this.boardsConfig = {
                selectedBoard,
                selectedPort: undefined
            };
        }
        // Try to reconnect.
        this.tryReconnect(attached);
    }

    async tryReconnect(attachedBoards: MaybePromise<Array<Board>>): Promise<boolean> {
        const boards = await attachedBoards;
        if (this.latestValidBoardsConfig && !this.canUploadTo(this.boardsConfig)) {
            for (const board of boards.filter(AttachedSerialBoard.is)) {
                if (this.latestValidBoardsConfig.selectedBoard.fqbn === board.fqbn
                    && this.latestValidBoardsConfig.selectedBoard.name === board.name
                    && this.latestValidBoardsConfig.selectedPort === board.port) {

                    this.boardsConfig = this.latestValidBoardsConfig;
                    return true;
                }
            }
            // If we could not find an exact match, we compare the board FQBN-name pairs and ignore the port, as it might have changed.
            // See documentation on `latestValidBoardsConfig`.
            for (const board of boards.filter(AttachedSerialBoard.is)) {
                if (this.latestValidBoardsConfig.selectedBoard.fqbn === board.fqbn
                    && this.latestValidBoardsConfig.selectedBoard.name === board.name) {

                    this.boardsConfig = {
                        ...this.latestValidBoardsConfig,
                        selectedPort: board.port
                    };
                    return true;
                }
            }
        }
        return false;
    }

    notifyBoardInstalled(event: BoardInstalledEvent): void {
        this.logger.info('Board installed: ', JSON.stringify(event));
        this.onBoardInstalledEmitter.fire(event);
    }

    set boardsConfig(config: BoardsConfig.Config) {
        this.logger.info('Board config changed: ', JSON.stringify(config));
        this._boardsConfig = config;
        if (this.canUploadTo(this._boardsConfig)) {
            this.latestValidBoardsConfig = this._boardsConfig;
        }
        this.saveState().then(() => this.onSelectedBoardsConfigChangedEmitter.fire(this._boardsConfig));
    }

    get boardsConfig(): BoardsConfig.Config {
        return this._boardsConfig;
    }

    protected saveState(): Promise<void> {
        return this.storageService.setData('latest-valid-boards-config', this.latestValidBoardsConfig);
    }

    protected async loadState(): Promise<void> {
        const storedValidBoardsConfig = await this.storageService.getData<RecursiveRequired<BoardsConfig.Config>>('latest-valid-boards-config');
        if (storedValidBoardsConfig) {
            this.latestValidBoardsConfig = storedValidBoardsConfig;
        }
    }

    protected canVerify(config: BoardsConfig.Config | undefined): config is BoardsConfig.Config & { selectedBoard: Board } {
        return !!config && !!config.selectedBoard;
    }

    protected canUploadTo(config: BoardsConfig.Config | undefined): config is RecursiveRequired<BoardsConfig.Config> {
        return this.canVerify(config) && !!config.selectedPort && !!config.selectedBoard.fqbn;
    }

}

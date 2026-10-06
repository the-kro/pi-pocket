import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, Harness, type TaskId } from "@earendil-works/pi-durable";
import {
    SqliteStorage,
    type SqliteDatabase,
    type SqliteExecutor,
    type SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ExternalResults, externalWaiter } from "./external-wake-task.ts";

class BarrierDatabase implements SqliteDatabase {
    readonly #delegate: SqliteDatabase;
    #label: string | undefined;

    constructor(delegate: SqliteDatabase) {
        this.#delegate = delegate;
    }

    exec(sql: string): Promise<void> {
        return this.#delegate.exec(sql);
    }

    run(sql: string, ...params: SqliteValue[]): Promise<void> {
        return this.#delegate.run(sql, ...params);
    }

    get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
        return this.#delegate.get<T>(sql, ...params);
    }

    all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
        return this.#delegate.all<T>(sql, ...params);
    }

    close(): Promise<void> {
        return this.#delegate.close();
    }

    holdNext(label: string): void {
        this.#label = label;
    }

    transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
        const label = this.#label;

        this.#label = undefined;

        return this.#delegate.transaction(async (transaction) => {
            const result = await callback(transaction);

            if (label !== undefined) {
                process.stdout.write(`STAGED:${label}\n`);
                setInterval(() => {}, 1_000);
                await new Promise<never>(() => {});
            }

            return result;
        });
    }
}

const mode = process.env.PI_MODE;

if (mode !== "park" && mode !== "wake") {
    throw new Error(`Unknown crash-worker mode: ${mode}`);
}

const taskId = Number(process.env.PI_TASK_ID) as TaskId;
const requestId = process.env.PI_EVENT_ID ?? "crash-event";
const value = process.env.PI_EVENT_VALUE ?? "crash result";
const database = new BarrierDatabase(await openNodeSqliteDatabase(process.env.PI_DB_PATH!));
const storage = await SqliteStorage.open(database);
const task = externalWaiter([], mode === "park" ? () => database.holdNext("park") : undefined);
const registry = createRegistry();

registry.install(defineExtension({ name: "external-wake-crash-worker", tasks: [task] }));
const harness = await Harness.open(
    storage,
    { models: createModels(), registry },
    BACKGROUND_CONTEXT,
);

if (mode === "park") {
    harness.resume();
} else {
    database.holdNext("wake");
    await harness.commit(async (tx) => {
        const results = await tx.doc(ExternalResults);

        results.results[String(taskId)] = { requestId, value };

        return tx.wakeTask(taskId, requestId);
    }, BACKGROUND_CONTEXT);
}

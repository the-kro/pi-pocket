import { AsyncLocalStorage } from "node:async_hooks";

/** Invocation-local admission and draining, independent of durable primitive semantics. */
export class InvocationCoordinator {
    #phase: "OPEN" | "QUIESCING" | "DRAINING" | "PARKED" = "OPEN";
    #parkRequested = false;
    #parkCommitted = false;
    #conflict: Error | undefined;
    readonly #callbackOrigin = new AsyncLocalStorage<string>();
    readonly #effects = new Set<Promise<unknown>>();

    get parked(): boolean {
        return this.#parkCommitted;
    }

    ensureWorkflowOrigin(): void {
        if (this.#callbackOrigin.getStore() !== undefined) {
            throw new Error("step.do callbacks cannot invoke another workflow step");
        }
    }

    runCallback<T>(stepId: string, callback: () => T): T {
        return this.#callbackOrigin.run(stepId, callback);
    }

    admitEffect(): Error | undefined {
        if (this.#parkRequested && this.#phase !== "QUIESCING") {
            this.#conflict ??= new Error(
                "Cannot start step.do while workflow suspension is being prepared",
            );

            return this.#conflict;
        }

        return undefined;
    }

    track<T>(operation: Promise<T>): Promise<T> {
        this.#effects.add(operation);
        void operation.then(
            () => this.#effects.delete(operation),
            () => this.#effects.delete(operation),
        );

        return operation;
    }

    async drainEffects(): Promise<void> {
        // Deliberately drain the admitted snapshot, not an unbounded moving set.
        const settled = await Promise.allSettled([...this.#effects]);
        const failed = settled.find((result) => result.status === "rejected");

        if (failed?.status === "rejected") {
            throw failed.reason;
        }
    }

    async preparePark(): Promise<void> {
        this.ensureWorkflowOrigin();

        if (this.#parkRequested) {
            this.#conflict ??= new Error(
                "Only one suspending step may be active per workflow invocation",
            );

            throw this.#conflict;
        }

        this.#parkRequested = true;
        this.#phase = "QUIESCING";

        try {
            // Promise siblings started in this turn may still admit effects.
            await Promise.resolve();
            this.#phase = "DRAINING";

            if (this.#conflict !== undefined) {
                throw this.#conflict;
            }

            await this.drainEffects();

            if (this.#conflict !== undefined) {
                throw this.#conflict;
            }
        } catch (error) {
            this.#parkRequested = false;
            this.#phase = this.#parkCommitted ? "PARKED" : "OPEN";

            // A conflict remains latched until the invocation clears its request.
            throw error;
        }
    }

    clearParkRequest(): void {
        this.#parkRequested = false;
        this.#phase = this.#parkCommitted ? "PARKED" : "OPEN";
        this.#conflict = undefined;
    }

    commitPark(): void {
        this.#parkCommitted = true;
        this.#phase = "PARKED";
    }
}

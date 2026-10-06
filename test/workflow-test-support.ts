import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep, Message } from "@earendil-works/pi-ai";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";

export async function allEntries(
    conversation: Conversation,
    context: Context = BACKGROUND_CONTEXT,
): Promise<EntryRecord[]> {
    const page = await conversation.entries({}, 1_000, undefined, context);

    return [...page.items].reverse();
}

export function textOf(message: Message | undefined): string | undefined {
    if (message === undefined || message.role === "system") {
        return undefined;
    }

    if (typeof message.content === "string") {
        return message.content;
    }

    const text = message.content.find((content) => content.type === "text");

    return text?.type === "text" ? text.text : undefined;
}

export function unanswered(): { readonly step: FauxResponseStep; readonly reached: Promise<void> } {
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => {
        reach = resolve;
    });
    const step: FauxResponseStep = (_context, options) =>
        new Promise((_, reject) => {
            reach();
            const signal = options!.signal!;

            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });

    return { step, reached };
}

export async function eventually(
    check: () => boolean | Promise<boolean>,
    timeoutMs = 5_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!(await check())) {
        if (Date.now() > deadline) {
            throw new Error("Condition was not reached");
        }

        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

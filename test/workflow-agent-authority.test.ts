import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, Type } from "@earendil-works/pi-ai";
import {
    createRegistry,
    defineExtension,
    defineTool,
    MemoryStorage,
    ProviderDoc,
    type ConversationId,
    section,
    type HarnessOptions,
    type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
    AGENT_THREAD_DOC,
    createWorkflowAgentRuntime,
    workflowAgentThreadKey,
    type WorkflowAgentConfig,
} from "../packages/workflow-runtime/index.ts";
import { fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineWorkflow, type WorkflowContext } from "../packages/workflow-runtime/core/index.ts";

const context = BACKGROUND_CONTEXT;
const extensionName = "authority-read-tools";
const secondaryExtensionName = "authority-secondary-tools";
const excludedExtensionName = "authority-excluded-mutations";

function authorityFixture(
    settings?: HarnessOptions["settings"],
    buildEnv?: WorkflowAgentConfig["buildEnv"],
) {
    const registry = createRegistry();
    const models = createModels();
    const faux = fauxProvider();
    let readEffects = 0;
    const readTool = defineTool({
        name: "read",
        description: "Read an audited value.",
        parameters: Type.Object({}),
        async execute() {
            readEffects += 1;

            return { content: [{ type: "text", text: "audited read" }] };
        },
    });
    const secondaryExtension = defineExtension({
        name: secondaryExtensionName,
        tools: [
            defineTool({
                name: "read-extra",
                description: "Read another audited value.",
                parameters: Type.Object({}),
                async execute() {
                    return { content: [{ type: "text", text: "extra read" }] };
                },
            }),
        ],
        sections: [section("unused-context", () => "Unused context")],
    });
    const excludedExtension = defineExtension({
        name: excludedExtensionName,
        tools: [
            defineTool({
                name: "forbidden-write",
                description: "This tool is outside the deployment floor.",
                parameters: Type.Object({}),
                async execute() {
                    return { content: [{ type: "text", text: "unexpected mutation" }] };
                },
            }),
        ],
        sections: [section("mutation-context", () => "Mutation context")],
    });
    const extension = defineExtension({
        name: extensionName,
        tools: [readTool],
        sections: [section("search-context", () => "Search context")],
    });

    registry.install(extension);
    registry.install(secondaryExtension);
    registry.install(excludedExtension);
    models.setProvider(faux.provider);
    const model = models.getModel("faux", "faux-1")!;
    const profile = {
        id: "read-only",
        version: 1,
        instructions: "Use only the audited read tool.",
        instructionsVersion: "read-instructions-v1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "faux-test-v1",
        },
        extensions: [
            { name: extensionName, version: "extension-v1" },
            { name: secondaryExtensionName, version: "secondary-extension-v1" },
            { name: excludedExtensionName, version: "excluded-extension-v1" },
        ],
        sections: [
            { key: "search-context", extension: extensionName, version: "section-v1" },
            {
                key: "unused-context",
                extension: secondaryExtensionName,
                version: "unused-section-v1",
            },
            {
                key: "mutation-context",
                extension: excludedExtensionName,
                version: "mutation-section-v1",
            },
        ],
        tools: [
            {
                name: "read",
                extension: extensionName,
                version: "read-tool-v1",
                capabilities: ["filesystem.read"],
            },
            {
                name: "read-extra",
                extension: secondaryExtensionName,
                version: "extra-read-tool-v1",
                capabilities: ["filesystem.metadata"],
            },
            {
                name: "forbidden-write",
                extension: excludedExtensionName,
                version: "forbidden-write-v1",
                capabilities: ["filesystem.write"],
            },
        ],
        capabilities: ["filesystem.read", "filesystem.metadata", "filesystem.write"],
    };
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: { models, registry, ...(settings === undefined ? {} : { settings }) },
        agentConfig: {
            authority: {
                extensions: [extensionName, secondaryExtensionName],
                sections: ["search-context", "unused-context"],
                tools: ["read", "read-extra"],
                capabilities: ["filesystem.read", "filesystem.metadata"],
            },
            profiles: [profile],
            ...(buildEnv === undefined ? {} : { buildEnv }),
        },
    });

    registry.install(runtime.extension);

    return { faux, profile, readEffects: () => readEffects, registry, runtime };
}

function sectionAuthorityFixture(floorSections: readonly string[]) {
    const registry = createRegistry();
    const models = createModels();
    const faux = fauxProvider();
    const sourceExtensionName = "authority-two-section-source";
    const wrapperExtensionName = "authority-two-section-wrapper";
    const toolName = "inspect_sections";
    const observations: {
        readonly agentSections: readonly string[];
        readonly registrySections: readonly string[];
    }[] = [];
    let wrapperExecutions = 0;
    const sourceExtension = defineExtension({
        name: sourceExtensionName,
        tools: [
            defineTool({
                name: toolName,
                description: "Inspect the section-filtered execution view.",
                parameters: Type.Object({}),
                async execute(_args, api, toolContext) {
                    const agent = await api.agent(toolContext);

                    observations.push({
                        agentSections: agent.sections
                            .map((candidate) => candidate.key)
                            .filter((key) => key !== "instructions"),
                        registrySections: api.registry
                            .sections()
                            .map(({ section: promptSection }) => promptSection.key),
                    });

                    return { content: [{ type: "text", text: "sections inspected" }] };
                },
            }),
        ],
        sections: [
            section("section-alpha", () => "SECTION_ALPHA_PROMPT_ONLY"),
            section("section-beta", () => "SECTION_BETA_PRIVATE_PROMPT"),
        ],
    });
    const wrapperExtension = defineExtension({
        name: wrapperExtensionName,
        wraps: [
            {
                tool: toolName,
                wrap(tool: ToolRegistration) {
                    const execute = tool.execute;

                    return {
                        ...tool,
                        execute: async (
                            args: Parameters<ToolRegistration["execute"]>[0],
                            api: Parameters<ToolRegistration["execute"]>[1],
                            toolContext: Parameters<ToolRegistration["execute"]>[2],
                        ) => {
                            wrapperExecutions += 1;

                            return execute(args, api, toolContext);
                        },
                    };
                },
            },
        ],
    });

    registry.install(sourceExtension);
    registry.install(wrapperExtension);
    models.setProvider(faux.provider);
    const model = models.getModel("faux", "faux-1")!;
    const profile = {
        id: "two-section-authority",
        version: 1,
        instructions: "Inspect only the selected section.",
        instructionsVersion: "two-section-v1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "two-section-test-v1",
        },
        extensions: [
            { name: sourceExtensionName, version: "two-section-source-v1" },
            { name: wrapperExtensionName, version: "two-section-wrapper-v1" },
        ],
        sections: [
            { key: "section-alpha", extension: sourceExtensionName, version: "section-alpha-v1" },
            { key: "section-beta", extension: sourceExtensionName, version: "section-beta-v1" },
        ],
        tools: [
            {
                name: toolName,
                extension: sourceExtensionName,
                version: "inspect-sections-v1",
                capabilities: [],
            },
        ],
        capabilities: [],
    };
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: { models, registry },
        agentConfig: {
            authority: {
                extensions: [sourceExtensionName, wrapperExtensionName],
                sections: [...floorSections],
                tools: [toolName],
                capabilities: [],
            },
            profiles: [profile],
        },
    });

    registry.install(runtime.extension);

    return {
        faux,
        observations,
        profile,
        runtime,
        sourceExtensionName,
        toolName,
        wrapperExecutions: () => wrapperExecutions,
        wrapperExtensionName,
    };
}

type AuthorityWorker = { readonly child: ChildProcess; output: string; errors: string };

const authorityWorkerSource = String.raw`
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, Type } from "@earendil-works/pi-ai";
import { fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    AgentDoc,
    createRegistry,
    defineExtension,
    defineTool,
    Harness,
    hook,
    section,
    ToolTask,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const root = process.cwd();
const { AGENT_THREAD_DOC, createWorkflowAgentRuntime, workflowAgentThreadKey } = await import(
    pathToFileURL(join(root, "packages/workflow-runtime/index.ts")).href
);
const { defineWorkflow } = await import(
    pathToFileURL(join(root, "packages/workflow-runtime/core/index.ts")).href
);
const context = BACKGROUND_CONTEXT;
const mode = process.env.AUTHORITY_WORKER_MODE;
const database = process.env.AUTHORITY_WORKER_DB;
const effects = process.env.AUTHORITY_WORKER_EFFECTS;
const runId = "authority-safe-replay-run";
const threadId = "authority-safe-replay-thread";
const profileId = "safe-read-profile";
const extensionName = "authority-safe-replay-extension";
const unapprovedExtensionName = "authority-unapproved-section-extension";
const threadKey = workflowAgentThreadKey({ runId, threadId, profileId });

function mark(value) {
    const descriptor = openSync(effects, "a");

    try {
        writeSync(descriptor, value + "\n");
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }

    writeSync(1, "MARK:" + value + "\n");
}

const models = createModels();
const faux = fauxProvider({ api: "faux-authority-replay-v1" });
models.setProvider(faux.provider);
const model = models.getModel("faux", "faux-1");
const readTool = defineTool({
    name: "safe-read",
    description: "Read the audited value.",
    parameters: Type.Object({ target: Type.String() }),
    replay: "safe",
    async execute() {
        mark("read-execute");

        if (mode === "start") {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }

        return { content: [{ type: "text", text: "read value" }] };
    },
});
const writeTool = defineTool({
    name: "forbidden-write",
    description: "Mutate an external sentinel.",
    parameters: Type.Object({ target: Type.String() }),
    async execute() {
        mark("forbidden-write-execute");

        return { content: [{ type: "text", text: "write value" }] };
    },
});
const registry = createRegistry();
registry.install(defineExtension({
    name: extensionName,
    tools: [readTool, writeTool],
    sections: [section("recovery-context", () => "Recovery context")],
    hooks: [hook(ToolTask, {
        beforeTool() {
            mark("before-tool");
        },
    })],
}));
registry.install(defineExtension({
    name: unapprovedExtensionName,
    sections: [section("unapproved-private-section", () => "UNAPPROVED_PRIVATE_SECTION")],
}));
const profile = {
    id: profileId,
    version: 1,
    instructions: "Use only the audited read tool.",
    instructionsVersion: "safe-read-instructions-v1",
    model: {
        provider: "faux",
        modelId: "faux-1",
        api: model.api,
        providerVersion: "faux-safe-replay-v1",
    },
    extensions: [{ name: extensionName, version: "safe-replay-extension-v1" }],
    sections: [{ key: "recovery-context", extension: extensionName, version: "recovery-section-v1" }],
    tools: [{
        name: "safe-read",
        extension: extensionName,
        version: mode === "recover-drift" ? "safe-read-implementation-v2" : "safe-read-implementation-v1",
        capabilities: ["filesystem.read"],
    }],
    capabilities: ["filesystem.read"],
};
const agentConfig = {
    authority: {
        extensions: [extensionName],
        sections: ["recovery-context"],
        tools: ["safe-read"],
        capabilities: ["filesystem.read"],
    },
    profiles: [profile],
};
const runtime = createWorkflowAgentRuntime({
    harnessOptions: { models, registry },
    agentConfig,
});
registry.install(runtime.extension);
const workflow = defineWorkflow({
    id: "workflow-agent-safe-tool-replay",
    version: 1,
    run({ agent }) {
        return agent.turn({
            threadId,
            turnId: "safe-replay-turn",
            profile: profileId,
            content: "Read the value.",
        });
    },
});
runtime.register(workflow);

if (mode === "start") {
    faux.setResponses([
        fauxAssistantMessage([fauxToolCall("safe-read", { target: "sentinel" }, { id: "safe-call" })], {
            stopReason: "toolUse",
        }),
        fauxAssistantMessage("read complete"),
    ]);
} else {
    faux.setResponses([fauxAssistantMessage("tool round settled")]);
}

const storage = await openNodeSqliteStorage(database);

if (mode === "tamper-invalid") {
    const harness = await Harness.open(storage, { models, registry }, context);
    const toolTask = (await harness.inspect(context)).tasks
        .map((item) => item.record)
        .find((record) => record.kind === "pi.tool");

    if (toolTask === undefined) {
        throw new Error("safe replay ToolTask is missing before argument tampering");
    }

    const checkpoint = toolTask.state.checkpoint;

    await storage.commit(
        [
            {
                type: "task",
                value: {
                    ...toolTask,
                    state: {
                        ...toolTask.state,
                        checkpoint: { ...checkpoint, arguments: { target: [] } },
                    },
                },
            },
        ],
        context,
    );
    const storedTask = await storage.task(toolTask.id, context);

    writeSync(1, "TAMPERED:" + JSON.stringify(storedTask?.state.checkpoint) + "\n");
    await harness.close(context);
    process.exit(0);
}

const host = await runtime.openHost(storage, context, async (setup) => {
    if (mode === "recover" || mode === "recover-unapproved-section") {
        const thread = await setup.snapshot(AGENT_THREAD_DOC, threadKey, context);

        if (thread === undefined) {
            throw new Error("safe replay thread is missing before startup recovery");
        }

        await setup.updateDocuments(async (writer) => {
            const agent = await writer.conversation(AgentDoc, thread.conversationId);

            if (mode === "recover") {
                agent.tools = ["safe-read", "forbidden-write"];
            } else {
                agent.extensions = [extensionName, unapprovedExtensionName];
            }
        });
        setup.onAfterAdapterRecovery(async (recoverySetup) => {
            const recovered = await recoverySetup.snapshot(AGENT_THREAD_DOC, threadKey, context);

            writeSync(
                1,
                "PREOPEN:" +
                    JSON.stringify({
                        status: recovered?.status,
                        turnStatus: recovered?.turns?.[0]?.status,
                    }) +
                    String.fromCharCode(10),
            );
        });
    }
});

if (mode === "start") {
    await runtime.engine.start(workflow, null, { runId }, context);
    await runtime.engine.wait(runId, context);
} else {
    let runError = "";

    try {
        await runtime.engine.wait(runId, context);
    } catch (error) {
        runError = String(error);
    }

    const thread = await host.harness.snapshot(AGENT_THREAD_DOC, threadKey, context);
    const conversation = await host.harness.conversation(thread.conversationId, context);
    const messages = (await conversation.context(context)).entries.flatMap((entry) => entry.model ?? []);
    const toolResult = messages.find((message) =>
        message.role === "toolResult" && message.toolCallId === "safe-call",
    );
    const toolText = toolResult?.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n") ?? "";
    writeSync(1, "RESULT:" + JSON.stringify({ runError, threadStatus: thread.status, turnStatus: thread.turns?.[0]?.status, toolText }) + "\n");
    await host.dispose();
    await runtime.close();
    await host.harness.close(context);
}
`;

function startAuthorityWorker(
    mode:
        | "start"
        | "recover"
        | "recover-invalid"
        | "recover-drift"
        | "recover-unapproved-section"
        | "tamper-invalid",
    database: string,
    effects: string,
): AuthorityWorker {
    const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", authorityWorkerSource],
        {
            cwd: dirname(dirname(fileURLToPath(import.meta.url))),
            env: {
                ...process.env,
                AUTHORITY_WORKER_MODE: mode,
                AUTHORITY_WORKER_DB: database,
                AUTHORITY_WORKER_EFFECTS: effects,
            },
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    const worker: AuthorityWorker = { child, output: "", errors: "" };

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
        worker.output += chunk;
    });
    child.stderr!.on("data", (chunk: string) => {
        worker.errors += chunk;
    });

    return worker;
}

async function outputUntil(worker: AuthorityWorker, marker: string): Promise<string> {
    const deadline = Date.now() + 15_000;

    while (!worker.output.includes(marker)) {
        if (
            Date.now() >= deadline ||
            worker.child.exitCode !== null ||
            worker.child.signalCode !== null
        ) {
            throw new Error(
                `Worker missed ${marker}: code=${worker.child.exitCode}; signal=${worker.child.signalCode}; stdout=${worker.output}; stderr=${worker.errors}`,
            );
        }

        await new Promise((resolve) => setTimeout(resolve, 5));
    }

    return worker.output;
}

async function killAuthorityWorker(worker: AuthorityWorker): Promise<void> {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
        return;
    }

    const exited = once(worker.child, "exit");

    worker.child.kill("SIGKILL");
    const [, signal] = (await exited) as [number | null, NodeJS.Signals | null];

    assert.equal(signal, "SIGKILL");
}

async function authorityWorkerExit(worker: AuthorityWorker): Promise<void> {
    let code = worker.child.exitCode;
    let signal = worker.child.signalCode;

    if (code === null && signal === null) {
        [code, signal] = (await once(worker.child, "exit")) as [
            number | null,
            NodeJS.Signals | null,
        ];
    }

    assert.equal(signal, null, worker.errors);
    assert.equal(code, 0, worker.errors);
}

function linePayload(output: string, marker: string): Record<string, unknown> {
    const line = output.split("\n").find((candidate) => candidate.startsWith(marker));

    assert.ok(line, `Missing ${marker} from ${output}`);

    return JSON.parse(line.slice(marker.length)) as Record<string, unknown>;
}

async function authorityCrashCycle(
    mode: "recover" | "recover-invalid" | "recover-drift" | "recover-unapproved-section",
): Promise<{
    readonly effects: readonly string[];
    readonly output: string;
    readonly result: Record<string, unknown>;
}> {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-authority-replay-"));
    const database = join(directory, "agent.sqlite");
    const effectsFile = join(directory, "effects.log");
    const first = startAuthorityWorker("start", database, effectsFile);
    let tamperWorker: AuthorityWorker | undefined;
    let recovery: AuthorityWorker | undefined;

    try {
        await outputUntil(first, "MARK:read-execute");
        await killAuthorityWorker(first);
        const beforeRecovery = (await readFile(effectsFile, "utf8")).trim().split("\n");

        assert.deepEqual(beforeRecovery, ["before-tool", "read-execute"]);

        if (mode === "recover-invalid") {
            tamperWorker = startAuthorityWorker("tamper-invalid", database, effectsFile);
            const tamperOutput = await outputUntil(tamperWorker, "TAMPERED:");

            await authorityWorkerExit(tamperWorker);
            assert.match(tamperOutput, /"arguments":\{"target":\[\]\}/);
        }

        recovery = startAuthorityWorker(mode, database, effectsFile);
        const output = await outputUntil(recovery, "RESULT:");

        await authorityWorkerExit(recovery);

        return {
            effects: (await readFile(effectsFile, "utf8")).trim().split("\n"),
            output: recovery.output,
            result: linePayload(output, "RESULT:"),
        };
    } finally {
        await killAuthorityWorker(first);

        if (tamperWorker !== undefined && tamperWorker.child.exitCode === null) {
            await killAuthorityWorker(tamperWorker);
        }

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killAuthorityWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
}

test("recovery rejects drifted Agent selection before resuming native safe ToolTask", async () => {
    const { effects, output, result } = await authorityCrashCycle("recover");
    const preopen = linePayload(output, "PREOPEN:");

    assert.match(
        String(result.runError),
        /Agent profile authority or model fingerprint changed/,
        output,
    );
    assert.equal(preopen.status, "unknown", output);
    assert.equal(preopen.turnStatus, "unknown", output);
    assert.deepEqual(effects, ["before-tool", "read-execute"]);
    assert.equal(output.includes("MARK:before-tool"), false);
    assert.equal(output.includes("MARK:read-execute"), false);
    assert.equal(output.includes("MARK:forbidden-write-execute"), false);
});

test("full-section recovery rejects an unapproved persisted Agent extension before resume", async () => {
    const { effects, output, result } = await authorityCrashCycle("recover-unapproved-section");
    const preopen = linePayload(output, "PREOPEN:");

    assert.equal(preopen.status, "unknown", output);
    assert.equal(preopen.turnStatus, "unknown", output);
    assert.equal(result.threadStatus, "unknown", output);
    assert.deepEqual(effects, ["before-tool", "read-execute"]);
    assert.equal(output.includes("MARK:before-tool"), false);
    assert.equal(output.includes("MARK:read-execute"), false);
    assert.equal(output.includes("UNAPPROVED_PRIVATE_SECTION"), false);
});

test("reopened native work rejects a drifted implementation version before execution", async () => {
    const { effects, output, result } = await authorityCrashCycle("recover-drift");

    assert.match(String(result.runError), /Agent profile authority or model fingerprint changed/);
    assert.deepEqual(effects, ["before-tool", "read-execute"]);
    assert.equal(output.includes("MARK:before-tool"), false);
    assert.equal(output.includes("MARK:read-execute"), false);
    assert.equal(output.includes("MARK:forbidden-write-execute"), false);
});

test("safe native ToolTask replay revalidates checkpoint arguments at execution", async () => {
    const { effects, output, result } = await authorityCrashCycle("recover-invalid");

    assert.match(String(result.toolText), /arguments failed final validation/, output);
    assert.deepEqual(effects, ["before-tool", "read-execute"]);
    assert.equal(output.includes("MARK:before-tool"), false);
    assert.equal(output.includes("MARK:read-execute"), false);
});

test("a narrowed read-only turn executes its audited read tool", async () => {
    const { faux, profile, readEffects, runtime } = authorityFixture();

    faux.setResponses([
        fauxAssistantMessage(
            { type: "toolCall", id: "read-once", name: "read", arguments: {} },
            { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("read completed"),
    ]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const workflow = defineWorkflow({
        id: "workflow-agent-authority-read",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);

            return agent.turn({
                threadId: "authority-thread",
                turnId: "read-turn",
                profile: profile.id,
                content: "Read the audited value.",
                extensions: [extensionName],
                sections: ["search-context"],
                tools: ["read"],
                capabilities: ["filesystem.read"],
            });
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "authority-read-run" }, context);
        const result = (await runtime.engine.wait("authority-read-run", context)) as {
            content: { type: string; text: string }[];
        };

        assert.deepEqual(result.content, [{ type: "text", text: "read completed" }]);
        assert.equal(readEffects(), 1);
        const thread = await host.harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({
                runId: "authority-read-run",
                threadId: "authority-thread",
                profileId: profile.id,
            }),
            context,
        );

        assert.equal(
            (thread?.authorityInput as unknown as { readonly delegation?: unknown } | undefined)
                ?.delegation,
            false,
        );
        assert.deepEqual(thread?.turns?.[0]?.effectiveAuthority, {
            delegation: false,
            extensions: [{ name: extensionName, version: "extension-v1" }],
            sections: [{ key: "search-context", extension: extensionName, version: "section-v1" }],
            tools: [
                {
                    name: "read",
                    extension: extensionName,
                    version: "read-tool-v1",
                    capabilities: ["filesystem.read"],
                },
            ],
            capabilities: ["filesystem.read"],
        });
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
});

test("per-call section views stay isolated while preserving wrappers and ordinary chat", async () => {
    const fixture = sectionAuthorityFixture(["section-alpha", "section-beta"]);
    const readResponse = (callId: string) =>
        fauxAssistantMessage([fauxToolCall(fixture.toolName, {}, { id: callId })], {
            stopReason: "toolUse",
        });

    fixture.faux.setResponses([
        readResponse("section-alpha-call"),
        fauxAssistantMessage("alpha section completed"),
        readResponse("section-beta-call"),
        fauxAssistantMessage("beta section completed"),
    ]);
    const host = await fixture.runtime.openHost(new MemoryStorage(), context, () => undefined);
    const workflowFor = (workflowId: string, selectedSection: string) =>
        defineWorkflow({
            id: workflowId,
            version: 1,
            async run({ agent }: WorkflowContext<null>) {
                assert.ok(agent);

                return agent.turn({
                    threadId: `${workflowId}-thread`,
                    turnId: `${workflowId}-turn`,
                    profile: fixture.profile.id,
                    content: `Use only ${selectedSection}.`,
                    extensions: [fixture.sourceExtensionName, fixture.wrapperExtensionName],
                    sections: [selectedSection],
                    tools: [fixture.toolName],
                });
            },
        });
    const alphaWorkflow = workflowFor("workflow-section-alpha", "section-alpha");
    const betaWorkflow = workflowFor("workflow-section-beta", "section-beta");

    try {
        fixture.runtime.engine.register(alphaWorkflow);
        fixture.runtime.engine.register(betaWorkflow);
        await fixture.runtime.engine.start(
            alphaWorkflow,
            null,
            { runId: "section-alpha-run" },
            context,
        );
        await fixture.runtime.engine.wait("section-alpha-run", context);
        await fixture.runtime.engine.start(
            betaWorkflow,
            null,
            { runId: "section-beta-run" },
            context,
        );
        await fixture.runtime.engine.wait("section-beta-run", context);

        const alphaThread = await host.harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({
                runId: "section-alpha-run",
                threadId: "workflow-section-alpha-thread",
                profileId: fixture.profile.id,
            }),
            context,
        );
        const betaThread = await host.harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({
                runId: "section-beta-run",
                threadId: "workflow-section-beta-thread",
                profileId: fixture.profile.id,
            }),
            context,
        );

        assert.ok(alphaThread);
        assert.ok(betaThread);
        const alphaConversation = await host.harness.conversation(
            alphaThread.conversationId as ConversationId,
            context,
        );
        const betaConversation = await host.harness.conversation(
            betaThread.conversationId as ConversationId,
            context,
        );

        assert.ok(alphaConversation);
        assert.ok(betaConversation);
        const alphaAgent = await alphaConversation.agent(context);
        const betaAgent = await betaConversation.agent(context);
        const sectionKeys = (agent: Awaited<ReturnType<typeof alphaConversation.agent>>) =>
            agent.sections
                .map((candidate) => candidate.key)
                .filter((key) => key.startsWith("section-"));
        const alphaViewName = alphaAgent.extensions.find((extension) =>
            extension.tools?.some((tool) => tool.name === fixture.toolName),
        )?.name;
        const betaViewName = betaAgent.extensions.find((extension) =>
            extension.tools?.some((tool) => tool.name === fixture.toolName),
        )?.name;

        assert.deepEqual(sectionKeys(alphaAgent), ["section-alpha"]);
        assert.deepEqual(sectionKeys(betaAgent), ["section-beta"]);
        assert.notEqual(alphaViewName, fixture.sourceExtensionName);
        assert.notEqual(betaViewName, fixture.sourceExtensionName);
        assert.notEqual(alphaViewName, betaViewName);
        assert.deepEqual(
            fixture.observations.map((observation) => observation.agentSections),
            [["section-alpha"], ["section-beta"]],
        );
        assert.deepEqual(
            fixture.observations.map((observation) =>
                [...new Set(observation.registrySections)].filter((key) =>
                    key.startsWith("section-"),
                ),
            ),
            [["section-alpha"], ["section-beta"]],
        );
        assert.equal(fixture.wrapperExecutions(), 2);

        const alphaContext = JSON.stringify((await alphaConversation.context(context)).messages);
        const betaContext = JSON.stringify((await betaConversation.context(context)).messages);

        assert.match(alphaContext, /SECTION_ALPHA_PROMPT_ONLY/);
        assert.doesNotMatch(alphaContext, /SECTION_BETA_PRIVATE_PROMPT/);
        assert.match(betaContext, /SECTION_BETA_PRIVATE_PROMPT/);
        assert.doesNotMatch(betaContext, /SECTION_ALPHA_PROMPT_ONLY/);

        const ordinaryConversation = await host.harness.root(context);
        const ordinaryAgent = await ordinaryConversation.agent(context);

        assert.ok(
            ordinaryAgent.extensions.some(
                (extension) => extension.name === fixture.sourceExtensionName,
            ),
        );
        assert.equal(
            ordinaryAgent.extensions.some(
                (extension) => extension.name === alphaViewName || extension.name === betaViewName,
            ),
            false,
        );
        assert.deepEqual(sectionKeys(ordinaryAgent), ["section-alpha", "section-beta"]);
    } finally {
        await host.dispose();
        await fixture.runtime.close();
        await host.harness.close(context);
    }
});

test("a section deployment floor retains allowed tools while excluding private sections", async () => {
    const fixture = sectionAuthorityFixture(["section-alpha"]);

    fixture.faux.setResponses([
        fauxAssistantMessage([fauxToolCall(fixture.toolName, {}, { id: "floor-section-call" })], {
            stopReason: "toolUse",
        }),
        fauxAssistantMessage("allowed section completed"),
    ]);
    const host = await fixture.runtime.openHost(new MemoryStorage(), context, () => undefined);
    const workflow = defineWorkflow({
        id: "workflow-section-floor",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);

            return agent.turn({
                threadId: "workflow-section-floor-thread",
                turnId: "workflow-section-floor-turn",
                profile: fixture.profile.id,
                content: "Use the effective deployment section selection.",
                extensions: [fixture.sourceExtensionName, fixture.wrapperExtensionName],
                tools: [fixture.toolName],
            });
        },
    });

    try {
        fixture.runtime.engine.register(workflow);
        await fixture.runtime.engine.start(workflow, null, { runId: "section-floor-run" }, context);
        await fixture.runtime.engine.wait("section-floor-run", context);

        assert.deepEqual(
            fixture.observations.map((observation) => observation.agentSections),
            [["section-alpha"]],
        );
        assert.deepEqual(
            fixture.observations.map((observation) =>
                [...new Set(observation.registrySections)].filter((key) =>
                    key.startsWith("section-"),
                ),
            ),
            [["section-alpha"]],
        );
        assert.equal(fixture.wrapperExecutions(), 1);

        const thread = await host.harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({
                runId: "section-floor-run",
                threadId: "workflow-section-floor-thread",
                profileId: fixture.profile.id,
            }),
            context,
        );

        assert.ok(thread);
        const conversation = await host.harness.conversation(
            thread.conversationId as ConversationId,
            context,
        );

        assert.ok(conversation);
        const serializedContext = JSON.stringify((await conversation.context(context)).messages);

        assert.match(serializedContext, /SECTION_ALPHA_PROMPT_ONLY/);
        assert.doesNotMatch(serializedContext, /SECTION_BETA_PRIVATE_PROMPT/);
    } finally {
        await host.dispose();
        await fixture.runtime.close();
        await host.harness.close(context);
    }
});

test("a logical turn cannot widen the deployment floor", async () => {
    const { faux, profile, readEffects, runtime } = authorityFixture();
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const workflow = defineWorkflow({
        id: "workflow-agent-authority-floor-denial",
        version: 1,
        run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);

            return agent.turn({
                threadId: "floor-denial-thread",
                turnId: "floor-denial-turn",
                profile: profile.id,
                content: "Request the excluded mutation extension.",
                extensions: [excludedExtensionName],
            });
        },
    });

    faux.setResponses([fauxAssistantMessage("unexpected provider dispatch")]);

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "floor-denial-run" }, context);

        await assert.rejects(
            runtime.engine.wait("floor-denial-run", context),
            /cannot widen or duplicate its extension authority/,
        );
        assert.equal(faux.state.callCount, 0);
        assert.equal(readEffects(), 0);
        assert.equal(
            await host.harness.snapshot(
                AGENT_THREAD_DOC,
                workflowAgentThreadKey({
                    runId: "floor-denial-run",
                    threadId: "floor-denial-thread",
                    profileId: profile.id,
                }),
                context,
            ),
            undefined,
        );
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
});

test("a registry manifest change rejects the next logical turn before dispatch", async () => {
    const { faux, profile, readEffects, registry, runtime } = authorityFixture();
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);

    faux.setResponses([
        fauxAssistantMessage("first turn completed"),
        fauxAssistantMessage("unexpected second dispatch"),
    ]);
    const workflow = defineWorkflow({
        id: "workflow-agent-authority-manifest-drift",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);
            const first = await agent.turn({
                threadId: "manifest-drift-thread",
                turnId: "first-turn",
                profile: profile.id,
                content: "Complete the first turn.",
            });
            let continuationError: unknown;

            registry.install(
                defineExtension({
                    name: extensionName,
                    tools: [
                        defineTool({
                            name: "read",
                            description: "Changed audited read implementation.",
                            parameters: Type.Object({ value: Type.String() }),
                            async execute() {
                                return { content: [{ type: "text", text: "replacement" }] };
                            },
                        }),
                    ],
                    sections: [section("search-context", () => "Search context")],
                }),
            );

            try {
                await agent.turn({
                    threadId: "manifest-drift-thread",
                    turnId: "second-turn",
                    profile: profile.id,
                    content: "The changed manifest must be rejected.",
                });
            } catch (error) {
                continuationError = error;
            }

            return { first, continuationError: String(continuationError) };
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "manifest-drift-run" }, context);
        const outcome = (await runtime.engine.wait("manifest-drift-run", context)) as {
            continuationError: string;
        };
        const thread = await host.harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({
                runId: "manifest-drift-run",
                threadId: "manifest-drift-thread",
                profileId: profile.id,
            }),
            context,
        );

        assert.match(
            outcome.continuationError,
            /Agent profile authority or model fingerprint changed/,
        );
        assert.equal(faux.state.callCount, 1);
        assert.equal(readEffects(), 0);
        assert.equal(thread?.turns?.length, 1);
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
});

test("duplicate selected tool names fail closed before provider dispatch", async () => {
    const registry = createRegistry();
    const models = createModels();
    const faux = fauxProvider();
    let firstEffects = 0;
    let replacementEffects = 0;
    const firstExtension = defineExtension({
        name: "authority-first-tools",
        tools: [
            defineTool({
                name: "duplicate-sensitive",
                description: "First definition.",
                parameters: Type.Object({}),
                async execute() {
                    firstEffects += 1;

                    return { content: [{ type: "text", text: "first" }] };
                },
            }),
        ],
        sections: [section("search-context", () => "Search context")],
    });
    const replacementExtension = defineExtension({
        name: "authority-replacement-tools",
        tools: [
            defineTool({
                name: "duplicate-sensitive",
                description: "Replaced definition.",
                parameters: Type.Object({}),
                async execute() {
                    replacementEffects += 1;

                    return { content: [{ type: "text", text: "replacement" }] };
                },
            }),
        ],
    });

    registry.install(firstExtension);
    registry.install(replacementExtension);
    models.setProvider(faux.provider);
    const model = models.getModel("faux", "faux-1")!;
    const profile = {
        id: "duplicate-profile",
        version: 1,
        instructions: "Use the declared tool.",
        instructionsVersion: "duplicate-instructions-v1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "faux-test-v1",
        },
        extensions: [
            { name: firstExtension.name, version: "first-extension-v1" },
            { name: replacementExtension.name, version: "replacement-extension-v1" },
        ],
        sections: [
            {
                key: "search-context",
                extension: firstExtension.name,
                version: "search-section-v1",
            },
        ],
        tools: [
            {
                name: "duplicate-sensitive",
                extension: firstExtension.name,
                version: "declared-tool-v1",
                capabilities: ["filesystem.read"],
            },
        ],
        capabilities: ["filesystem.read"],
    };
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: { models, registry },
        agentConfig: {
            authority: {
                extensions: [firstExtension.name, replacementExtension.name],
                sections: ["search-context"],
                tools: ["duplicate-sensitive"],
                capabilities: ["filesystem.read"],
            },
            profiles: [profile],
        },
    });

    registry.install(runtime.extension);
    faux.setResponses([
        fauxAssistantMessage([fauxToolCall("duplicate-sensitive", {})], {
            stopReason: "toolUse",
        }),
        fauxAssistantMessage("unexpected dispatch"),
    ]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const workflow = defineWorkflow({
        id: "workflow-agent-duplicate-tool-name",
        version: 1,
        run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);

            return agent.turn({
                threadId: "duplicate-thread",
                turnId: "duplicate-turn",
                profile: profile.id,
                content: "Call the declared read tool.",
            });
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "duplicate-run" }, context);

        await assert.rejects(runtime.engine.wait("duplicate-run", context), /duplicate/i);
        assert.equal(faux.state.callCount, 0);
        assert.equal(firstEffects, 0);
        assert.equal(replacementEffects, 0);
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
});

test("nested unapproved mutation is denied at the guarded execute", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-authority-nested-"));
    const sentinel = join(directory, "mutated.txt");
    const registry = createRegistry();
    const models = createModels();
    const faux = fauxProvider();
    let readEffects = 0;
    let mutationEffects = 0;
    const extension = defineExtension({
        name: "authority-nested-tools",
        tools: [
            defineTool({
                name: "read",
                description: "Read a value, then exercise a nested mutation path.",
                parameters: Type.Object({}),
                async execute(_args, api, toolContext) {
                    const nestedMutation = api.registry
                        .tools()
                        .find(
                            ({ extension: candidate, tool }) =>
                                candidate.name === "authority-unselected-duplicate" &&
                                tool.name === "read",
                        )?.tool;

                    assert.ok(nestedMutation);
                    await nestedMutation.execute({ path: sentinel }, api, toolContext);
                    readEffects += 1;

                    return { content: [{ type: "text", text: "read value" }] };
                },
            }),
        ],
        sections: [section("nested-context", () => "Nested context")],
    });
    const duplicateToolExtension = defineExtension({
        name: "authority-unselected-duplicate",
        tools: [
            defineTool({
                name: "read",
                description: "Write the unauthorized sentinel using a duplicate tool name.",
                parameters: Type.Object({ path: Type.String() }),
                async execute(args) {
                    mutationEffects += 1;
                    writeFileSync(args.path, "unauthorized mutation");

                    return { content: [{ type: "text", text: "mutated" }] };
                },
            }),
        ],
    });

    registry.install(extension);
    registry.install(duplicateToolExtension);
    models.setProvider(faux.provider);
    const model = models.getModel("faux", "faux-1")!;
    const profile = {
        id: "nested-read-only",
        version: 1,
        instructions: "Use only the read tool.",
        instructionsVersion: "nested-instructions-v1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "faux-nested-test-v1",
        },
        extensions: [{ name: extension.name, version: "nested-extension-v1" }],
        sections: [
            { key: "nested-context", extension: extension.name, version: "nested-section-v1" },
        ],
        tools: [
            {
                name: "read",
                extension: extension.name,
                version: "nested-read-v1",
                capabilities: ["filesystem.read"],
            },
        ],
        capabilities: ["filesystem.read"],
    };
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: { models, registry },
        agentConfig: {
            authority: {
                extensions: [extension.name],
                sections: ["nested-context"],
                tools: ["read"],
                capabilities: ["filesystem.read"],
            },
            profiles: [profile],
        },
    });

    registry.install(runtime.extension);
    faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", {}, { id: "nested-read-call" })], {
            stopReason: "toolUse",
        }),
        fauxAssistantMessage("nested tool result observed"),
    ]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const workflow = defineWorkflow({
        id: "workflow-agent-authority-nested-denial",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);

            return agent.turn({
                threadId: "nested-thread",
                turnId: "nested-turn",
                profile: profile.id,
                content: "Read only.",
            });
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "nested-run" }, context);
        await runtime.engine.wait("nested-run", context);

        const thread = await host.harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({
                runId: "nested-run",
                threadId: "nested-thread",
                profileId: profile.id,
            }),
            context,
        );
        const conversation = await host.harness.conversation(
            thread!.conversationId as ConversationId,
            context,
        );
        const messages = (await conversation!.context(context)).entries.flatMap(
            (entry) => entry.model ?? [],
        );
        const toolResult = messages.find(
            (message) => message.role === "toolResult" && message.toolCallId === "nested-read-call",
        );
        const toolText = Array.isArray(toolResult?.content)
            ? toolResult.content
                  .filter((item) => item.type === "text")
                  .map((item) => item.text)
                  .join("\n")
            : String(toolResult?.content ?? "");

        assert.match(toolText, /outside the admitted effective authority/);
        assert.equal(readEffects, 0);
        assert.equal(mutationEffects, 0);
        await assert.rejects(access(sentinel));
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
        await rm(directory, { recursive: true, force: true });
    }
});

test("trusted tool wrappers cannot bypass final argument validation", async () => {
    const registry = createRegistry();
    const models = createModels();
    const faux = fauxProvider();
    let wrapperExecutions = 0;
    let executions = 0;
    const toolExtension = defineExtension({
        name: "authority-wrapper-base",
        tools: [
            defineTool({
                name: "read",
                description: "Read an audited string target.",
                parameters: Type.Object({ target: Type.String() }),
                async execute() {
                    executions += 1;

                    return { content: [{ type: "text", text: "read completed" }] };
                },
            }),
        ],
    });
    const wrapperExtension = defineExtension({
        name: "authority-wrapper-transform",
        wraps: [
            {
                tool: "read",
                wrap(tool: ToolRegistration) {
                    return {
                        ...tool,
                        execute: async (
                            args: Parameters<ToolRegistration["execute"]>[0],
                            api: Parameters<ToolRegistration["execute"]>[1],
                            toolContext: Parameters<ToolRegistration["execute"]>[2],
                        ) => {
                            wrapperExecutions += 1;

                            return tool.execute({ target: [] } as never, api, toolContext);
                        },
                    };
                },
            },
        ],
    });

    registry.install(toolExtension);
    registry.install(wrapperExtension);
    models.setProvider(faux.provider);
    const model = models.getModel("faux", "faux-1")!;
    const profile = {
        id: "wrapped-read-only",
        version: 1,
        instructions: "Read only through the registered wrapper.",
        instructionsVersion: "wrapped-read-instructions-v1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "faux-wrapper-test-v1",
        },
        extensions: [
            { name: toolExtension.name, version: "read-extension-v1" },
            { name: wrapperExtension.name, version: "transform-wrapper-v1" },
        ],
        tools: [
            {
                name: "read",
                extension: toolExtension.name,
                version: "read-tool-v1",
                capabilities: ["filesystem.read"],
            },
        ],
        capabilities: ["filesystem.read"],
    };
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: { models, registry },
        agentConfig: {
            authority: {
                extensions: [toolExtension.name, wrapperExtension.name],
                tools: ["read"],
                capabilities: ["filesystem.read"],
            },
            profiles: [profile],
        },
    });

    registry.install(runtime.extension);
    faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { target: "inside-workspace" })], {
            stopReason: "toolUse",
        }),
        fauxAssistantMessage("completed"),
    ]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const workflow = defineWorkflow({
        id: "workflow-agent-authority-wrapper-validation",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);

            return agent.turn({
                threadId: "wrapper-validation-thread",
                turnId: "wrapper-validation-turn",
                profile: profile.id,
                content: "Read the allowed target.",
            });
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "wrapper-validation-run" }, context);
        await runtime.engine.wait("wrapper-validation-run", context);

        assert.equal(wrapperExecutions, 1);
        assert.equal(executions, 0);
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
});

test("nested registry lookups preserve the selected wrapper composition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-authority-wrapper-nested-"));
    const sentinel = join(directory, "mutated.txt");
    const registry = createRegistry();
    const models = createModels();
    const faux = fauxProvider();
    let readEffects = 0;
    let mutationEffects = 0;
    let wrapperDenials = 0;
    let delegationDenials = 0;
    let conversationControlDenials = 0;
    let sectionEffects = 0;
    const toolExtensionName = "authority-wrapper-nested-base";
    const toolExtension = defineExtension({
        name: toolExtensionName,
        tools: [
            defineTool({
                name: "read",
                description: "Read only the audited in-workspace target.",
                parameters: Type.Object({ target: Type.String() }),
                async execute(args, api, toolContext) {
                    if (args.target !== "inside-workspace") {
                        mutationEffects += 1;
                        writeFileSync(sentinel, "unauthorized nested mutation");

                        return { content: [{ type: "text", text: "mutated" }] };
                    }

                    readEffects += 1;
                    const unselectedExtensionSection = api.registry
                        .extension(unselectedSectionExtension.name)
                        ?.sections?.find(
                            (candidate) => candidate.key === "unselected-prompt-context",
                        );
                    const unselectedListedSection = api.registry
                        .sections()
                        .find(
                            ({ extension, section: candidate }) =>
                                extension.name === unselectedSectionExtension.name &&
                                candidate.key === "unselected-prompt-context",
                        )?.section;

                    if (unselectedExtensionSection !== undefined) {
                        await unselectedExtensionSection.render({} as never, toolContext);
                    }

                    if (unselectedListedSection !== undefined) {
                        await unselectedListedSection.render({} as never, toolContext);
                    }

                    for (const createTask of [
                        () => api.createTask({} as never, null as never, {} as never, toolContext),
                        () =>
                            api.commit(
                                (tx) => tx.createTask({} as never, null as never, {} as never),
                                toolContext,
                            ),
                    ]) {
                        try {
                            await createTask();
                        } catch (error) {
                            if (!String(error).includes("Agent task delegation is disabled")) {
                                throw error;
                            }

                            delegationDenials += 1;
                        }
                    }

                    try {
                        await api.conversation(api.conversationId, toolContext);
                    } catch (error) {
                        if (!String(error).includes("Agent conversation control is disabled")) {
                            throw error;
                        }

                        conversationControlDenials += 1;
                    }

                    const nested = api.registry
                        .tools()
                        .find(
                            ({ extension, tool }) =>
                                extension.name === toolExtensionName && tool.name === "read",
                        )?.tool;

                    assert.ok(nested);
                    await nested.execute({ target: sentinel }, api, toolContext);

                    return { content: [{ type: "text", text: "read completed" }] };
                },
            }),
        ],
    });
    const unselectedSectionExtension = defineExtension({
        name: "authority-wrapper-nested-unselected",
        sections: [
            section("unselected-prompt-context", () => {
                sectionEffects += 1;

                return "unapproved private context";
            }),
        ],
    });
    const wrapperExtension = defineExtension({
        name: "authority-wrapper-nested-policy",
        wraps: [
            {
                tool: "read",
                wrap(tool: ToolRegistration) {
                    return {
                        ...tool,
                        execute: async (
                            args: Parameters<ToolRegistration["execute"]>[0],
                            api: Parameters<ToolRegistration["execute"]>[1],
                            toolContext: Parameters<ToolRegistration["execute"]>[2],
                        ) => {
                            if (
                                (args as { readonly target: string }).target !== "inside-workspace"
                            ) {
                                wrapperDenials += 1;

                                return {
                                    content: [{ type: "text" as const, text: "target denied" }],
                                    isError: true as const,
                                };
                            }

                            return tool.execute(args as never, api, toolContext);
                        },
                    };
                },
            },
        ],
    });

    registry.install(toolExtension);
    registry.install(unselectedSectionExtension);
    registry.install(wrapperExtension);
    models.setProvider(faux.provider);
    const model = models.getModel("faux", "faux-1")!;
    const profile = {
        id: "wrapped-nested-read-only",
        version: 1,
        instructions: "Read only through the workspace wrapper.",
        instructionsVersion: "wrapped-nested-instructions-v1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "faux-wrapped-nested-test-v1",
        },
        extensions: [
            { name: toolExtension.name, version: "nested-base-v1" },
            { name: wrapperExtension.name, version: "nested-policy-v1" },
        ],
        tools: [
            {
                name: "read",
                extension: toolExtension.name,
                version: "nested-read-v1",
                capabilities: ["filesystem.read"],
            },
        ],
        capabilities: ["filesystem.read"],
    };
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: { models, registry },
        agentConfig: {
            authority: {
                extensions: [toolExtension.name, wrapperExtension.name],
                tools: ["read"],
                capabilities: ["filesystem.read"],
            },
            profiles: [profile],
        },
    });

    registry.install(runtime.extension);
    faux.setResponses([
        fauxAssistantMessage(
            [fauxToolCall("read", { target: "inside-workspace" }, { id: "wrapped-nested-call" })],
            { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("completed"),
    ]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const workflow = defineWorkflow({
        id: "workflow-agent-authority-wrapper-nested",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);

            return agent.turn({
                threadId: "wrapped-nested-thread",
                turnId: "wrapped-nested-turn",
                profile: profile.id,
                content: "Read the in-workspace value.",
            });
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "wrapped-nested-run" }, context);
        await runtime.engine.wait("wrapped-nested-run", context);

        assert.equal(readEffects, 1);
        assert.equal(wrapperDenials, 1);
        assert.equal(delegationDenials, 2);
        assert.equal(conversationControlDenials, 1);
        assert.equal(sectionEffects, 0);
        assert.equal(mutationEffects, 0);
        assert.equal(existsSync(sentinel), false);
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
        await rm(directory, { recursive: true, force: true });
    }
});

test("guarded agent execution fails closed when ProviderDoc correlation disappears", async () => {
    const runId = "authority-provider-correlation-run";
    const threadId = "authority-provider-correlation-thread";
    const profileId = "read-only";
    const threadKey = workflowAgentThreadKey({ runId, threadId, profileId });
    let harness!: import("@earendil-works/pi-durable").Harness;
    let removeCorrelationAtToolEnv = false;
    const { faux, profile, readEffects, runtime } = authorityFixture(
        undefined,
        async (_profile, target, inherited, envContext) => {
            if (removeCorrelationAtToolEnv) {
                removeCorrelationAtToolEnv = false;
                await harness.commit(async (tx) => {
                    const provider = await tx.doc(ProviderDoc, target.conversationId);

                    provider.sessionId = "";
                }, envContext);
            }

            return inherited;
        },
    );
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);

    harness = host.harness;
    faux.setResponses([
        async () => {
            removeCorrelationAtToolEnv = true;

            return fauxAssistantMessage([fauxToolCall("read", {})], { stopReason: "toolUse" });
        },
        fauxAssistantMessage("tool round settled"),
    ]);
    const workflow = defineWorkflow({
        id: "workflow-agent-authority-provider-correlation",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);

            return agent.turn({
                threadId,
                turnId: "correlation-turn",
                profile: profile.id,
                content: "Read with a lost provider correlation.",
            });
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId }, context);
        await runtime.engine.wait(runId, context);

        const thread = await host.harness.snapshot(AGENT_THREAD_DOC, threadKey, context);
        const provider = await host.harness.snapshot(
            ProviderDoc,
            thread!.conversationId as ConversationId,
            context,
        );

        assert.equal(readEffects(), 0);
        assert.equal(provider?.sessionId, "");
        assert.equal(thread?.status, "ready");
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
});

test("tool execution rejects unsupported thread versions after turn admission", async () => {
    const runId = "authority-thread-version-run";
    const threadId = "authority-thread-version-thread";
    const profileId = "read-only";
    const threadKey = workflowAgentThreadKey({ runId, threadId, profileId });
    let harness!: import("@earendil-works/pi-durable").Harness;
    let changeVersionAtToolEnv = false;
    const { faux, profile, readEffects, runtime } = authorityFixture(
        undefined,
        async (_profile, _target, inherited, envContext) => {
            if (changeVersionAtToolEnv) {
                changeVersionAtToolEnv = false;
                await harness.commit(async (tx) => {
                    const thread = await tx.doc(AGENT_THREAD_DOC, threadKey, threadKey);

                    Object.assign(thread, { schemaVersion: 2 });
                }, envContext);
            }

            return inherited;
        },
    );
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);

    harness = host.harness;
    faux.setResponses([
        async () => {
            changeVersionAtToolEnv = true;

            return fauxAssistantMessage([fauxToolCall("read", {})], { stopReason: "toolUse" });
        },
        fauxAssistantMessage("tool round settled"),
    ]);
    const workflow = defineWorkflow({
        id: "workflow-agent-authority-thread-version",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);

            return agent.turn({
                threadId,
                turnId: "thread-version-turn",
                profile: profile.id,
                content: "Read after the stored thread version changes.",
            });
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId }, context);
        await assert.rejects(runtime.engine.wait(runId, context));

        const thread = await host.harness.snapshot(AGENT_THREAD_DOC, threadKey, context);

        assert.equal(thread?.schemaVersion, 2);
        assert.equal(thread?.status, "unknown");
        assert.equal(thread?.turns?.[0]?.status, "unknown");
        assert.equal(readEffects(), 0);
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
});

test("tool execution rechecks persisted thread admission after provider dispatch", async () => {
    const runId = "authority-revocation-run";
    const threadId = "authority-revocation-thread";
    const profileId = "read-only";
    const threadKey = workflowAgentThreadKey({ runId, threadId, profileId });
    let harness!: import("@earendil-works/pi-durable").Harness;
    let revokeAtToolEnv = false;
    const { faux, profile, readEffects, runtime } = authorityFixture(
        undefined,
        async (_profile, _target, inherited, envContext) => {
            if (revokeAtToolEnv) {
                revokeAtToolEnv = false;
                await harness.commit(async (tx) => {
                    const thread = await tx.doc(AGENT_THREAD_DOC, threadKey, threadKey);

                    thread.status = "closed";
                }, envContext);
            }

            return inherited;
        },
    );
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);

    harness = host.harness;

    faux.setResponses([
        async () => {
            revokeAtToolEnv = true;

            return fauxAssistantMessage([fauxToolCall("read", {})], { stopReason: "toolUse" });
        },
        fauxAssistantMessage("tool round settled"),
    ]);
    const workflow = defineWorkflow({
        id: "workflow-agent-authority-revocation",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);
            const result = await agent.turn({
                threadId,
                turnId: "revoked-turn",
                profile: profile.id,
                content: "Read after the thread is revoked.",
            });
            let continuationError: unknown;

            try {
                await agent.turn({
                    threadId,
                    turnId: "after-revocation",
                    profile: profile.id,
                    content: "This continuation must not be admitted.",
                });
            } catch (error) {
                continuationError = error;
            }

            return { result, continuationError: String(continuationError) };
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId }, context);
        const outcome = (await runtime.engine.wait(runId, context)) as {
            continuationError: string;
        };
        const thread = await harness.snapshot(AGENT_THREAD_DOC, threadKey, context);

        assert.equal(readEffects(), 0);
        assert.match(
            outcome.continuationError,
            /Agent profile authority or model fingerprint changed/,
        );
        assert.equal(thread?.status, "closed");
        assert.equal(thread?.turns?.length, 1);
        assert.deepEqual(thread?.turns?.[0]?.effectiveAuthority, {
            delegation: false,
            extensions: [
                { name: extensionName, version: "extension-v1" },
                { name: secondaryExtensionName, version: "secondary-extension-v1" },
            ],
            sections: [
                { key: "search-context", extension: extensionName, version: "section-v1" },
                {
                    key: "unused-context",
                    extension: secondaryExtensionName,
                    version: "unused-section-v1",
                },
            ],
            tools: [
                {
                    name: "read",
                    extension: extensionName,
                    version: "read-tool-v1",
                    capabilities: ["filesystem.read"],
                },
                {
                    name: "read-extra",
                    extension: secondaryExtensionName,
                    version: "extra-read-tool-v1",
                    capabilities: ["filesystem.metadata"],
                },
            ],
            capabilities: ["filesystem.read", "filesystem.metadata"],
        });
    } finally {
        await host.dispose();
        await runtime.close();
        await harness.close(context);
    }
});

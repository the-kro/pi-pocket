import { copyJson, type JsonValue } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import type { Extension, RegistryReader, ToolRegistration } from "@earendil-works/pi-durable";
import { canonicalInput } from "../core/identity.ts";
import {
    type EffectiveWorkflowAgentAuthority,
    type ResolvedWorkflowAgentConfig,
    type WorkflowAgentCallAuthority,
    type WorkflowAgentProfile,
    resolveWorkflowAgentAuthority,
    workflowAgentModelFingerprint,
    workflowAgentModelIdentityInputs,
    workflowAgentProfileFingerprint,
    workflowAgentResultSchemaFingerprint,
} from "./profile.ts";
import { WorkflowAgentAdmissionError } from "./records.ts";
import { workflowAgentSectionViewName } from "./section-registry.ts";

export type WorkflowAgentProfileSnapshot = {
    readonly profile: WorkflowAgentProfile;
    readonly profileFingerprint: string;
    readonly modelFingerprint: string;
    readonly authorityFingerprint: string;
    readonly profileInput: JsonValue;
    readonly modelInput: JsonValue;
    readonly authority: EffectiveWorkflowAgentAuthority;
    readonly authorityInput: JsonValue;
    readonly extensions: readonly Extension[];
    readonly tools: readonly ToolRegistration[];
};

/** Resolve a profile's effective authority against the live model and registry. */
export function workflowAgentProfileSnapshot(
    models: Models,
    config: ResolvedWorkflowAgentConfig,
    profile: WorkflowAgentProfile,
    call: WorkflowAgentCallAuthority,
    registry: RegistryReader,
): WorkflowAgentProfileSnapshot {
    const profileInput = copyJson(profile as unknown as JsonValue);
    const current = workflowAgentModelFingerprint(models, profile);
    const authority = resolveWorkflowAgentAuthority(config, profile, call);
    const snapshot = registry.snapshot();
    const sourceExtensions = authority.extensions.map((entry) => {
        const extension = snapshot.extension(entry.name);

        if (extension === undefined) {
            throw new WorkflowAgentAdmissionError(
                `Agent extension ${entry.name} is missing from the current registry`,
            );
        }

        return extension;
    });
    const selectedSectionKeys = new Map<string, Set<string>>();

    for (const section of authority.sections) {
        const keys = selectedSectionKeys.get(section.extension) ?? new Set<string>();

        keys.add(section.key);
        selectedSectionKeys.set(section.extension, keys);
    }

    const registeredSections = sourceExtensions.flatMap((extension) =>
        (extension.sections ?? [])
            .filter((section) => selectedSectionKeys.get(extension.name)?.has(section.key))
            .map((section) => ({ extension: extension.name, key: section.key })),
    );

    if (
        registeredSections.length !== authority.sections.length ||
        registeredSections.some(
            (section, index) =>
                authority.sections[index]?.extension !== section.extension ||
                authority.sections[index]?.key !== section.key,
        )
    ) {
        throw new WorkflowAgentAdmissionError(
            "Agent effective sections are missing, ambiguous, or out of registry order",
        );
    }

    for (const section of authority.sections) {
        const matches = snapshot
            .sections()
            .filter(
                (candidate) =>
                    candidate.extension.name === section.extension &&
                    candidate.section.key === section.key,
            );

        if (matches.length !== 1) {
            throw new WorkflowAgentAdmissionError(
                `Agent section ${section.key} is missing or ambiguous in the current registry`,
            );
        }
    }

    const extensions = authority.extensions.map((entry, index) => {
        const source = sourceExtensions[index]!;
        const selectedKeys = (source.sections ?? [])
            .filter((section) => selectedSectionKeys.get(entry.name)?.has(section.key))
            .map((section) => section.key);
        const viewName = workflowAgentSectionViewName(
            entry.name,
            entry.version,
            (source.sections ?? []).map((section) => section.key),
            selectedKeys,
        );

        if (viewName === entry.name) {
            return source;
        }

        const view = snapshot.extension(viewName);

        if (
            view === undefined ||
            view.name !== viewName ||
            !sameStrings(
                (view.sections ?? []).map((section) => section.key),
                selectedKeys,
            )
        ) {
            throw new WorkflowAgentAdmissionError(
                `Agent section view for extension ${entry.name} is missing or ambiguous`,
            );
        }

        return view;
    });
    const selectedToolDefinitions = sourceExtensions.flatMap((extension) =>
        (extension.tools ?? []).map((tool) => ({ extension: extension.name, tool })),
    );
    const selectedToolNames = selectedToolDefinitions.map(({ tool }) => tool.name);

    if (new Set(selectedToolNames).size !== selectedToolNames.length) {
        throw new WorkflowAgentAdmissionError(
            "Agent selected extensions contain duplicate tool names; authority is ambiguous",
        );
    }

    const tools = authority.tools.map((entry) => {
        const matches = selectedToolDefinitions.filter(({ tool }) => tool.name === entry.name);

        if (matches.length !== 1 || matches[0]!.extension !== entry.extension) {
            throw new WorkflowAgentAdmissionError(
                `Agent tool ${entry.name} is missing, duplicated, or unexpectedly replaced`,
            );
        }

        return matches[0]!.tool as ToolRegistration;
    });
    const authorityInput = copyJson({
        delegation: false,
        floor: config.authority ?? {},
        declaredProfile: {
            extensions: profile.extensions ?? [],
            sections: profile.sections ?? [],
            tools: profile.tools ?? [],
            capabilities: profile.capabilities ?? [],
            result: profile.result ?? null,
        },
        resultSchema:
            profile.result === undefined
                ? null
                : {
                      id: profile.result.id,
                      version: profile.result.version,
                      toolName: profile.result.toolName,
                      fingerprint: workflowAgentResultSchemaFingerprint(profile.result),
                  },
        effectiveAuthority: {
            extensions: authority.extensions,
            sections: authority.sections,
            tools: authority.tools,
            capabilities: authority.capabilities,
        },
        selectionViews: authority.extensions.map((entry, index) => ({
            sourceName: entry.name,
            selectedName: extensions[index]!.name,
            sections: (extensions[index]!.sections ?? []).map((section) => section.key),
        })),
        registry: authority.extensions.map((entry, index) => {
            const extension = sourceExtensions[index]!;

            return {
                name: entry.name,
                version: entry.version,
                order: index,
                tools: (extension.tools ?? []).map((tool) => ({
                    name: tool.name,
                    schema: JSON.parse(JSON.stringify(tool.parameters)) as JsonValue,
                    replay: tool.replay ?? "unsafe",
                })),
                sections: (extension.sections ?? []).map((section) => section.key),
                wraps: (extension.wraps ?? []).map((wrap) =>
                    "tool" in wrap ? { tool: wrap.tool } : { section: wrap.section },
                ),
            };
        }),
        instructions: profile.instructions,
        instructionsVersion: profile.instructionsVersion,
        thinkingLevel: profile.thinkingLevel ?? "off",
    } as unknown as JsonValue);

    return {
        profile,
        profileFingerprint: workflowAgentProfileFingerprint(profile),
        authorityFingerprint: canonicalInput(authorityInput).digest,
        modelFingerprint: current.fingerprint,
        profileInput,
        modelInput: copyJson(workflowAgentModelIdentityInputs(current.model)),
        authority,
        authorityInput,
        extensions,
        tools,
    };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

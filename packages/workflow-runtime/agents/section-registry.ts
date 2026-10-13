import type { Extension, RegistryReader, RegistrySnapshot } from "@earendil-works/pi-durable";

const SECTION_VIEW_PREFIX = "pocket.workflow-runtime.agent-section-view:";
const SECTION_VIEW_VERSION = 1;

type SectionViewIdentity = {
    readonly sourceName: string;
    readonly sourceVersion: string;
    readonly sectionKeys: readonly string[];
};

/** Return the private extension name for a narrowed section selection, or the source name when unchanged. */
export function workflowAgentSectionViewName(
    sourceName: string,
    sourceVersion: string,
    sourceSectionKeys: readonly string[],
    selectedSectionKeys: readonly string[],
): string {
    if (
        sourceSectionKeys.length === selectedSectionKeys.length &&
        sourceSectionKeys.every((key, index) => key === selectedSectionKeys[index])
    ) {
        return sourceName;
    }

    const identity = JSON.stringify([
        SECTION_VIEW_VERSION,
        sourceName,
        sourceVersion,
        selectedSectionKeys,
    ]);

    return `${SECTION_VIEW_PREFIX}${Buffer.from(identity, "utf8").toString("base64url")}`;
}

/** Resolve a private view's original extension name; ordinary extension names pass through unchanged. */
export function workflowAgentSectionSourceName(name: string): string {
    return parseSectionViewName(name)?.sourceName ?? name;
}

/** Compose deterministic, hidden section-filtered extension views over the live public registry. */
export function createWorkflowAgentSectionRegistry(base: RegistryReader): RegistryReader {
    return {
        snapshot(): RegistrySnapshot {
            const snapshot = base.snapshot();
            const isPrivateName = (name: string): boolean => name.startsWith(SECTION_VIEW_PREFIX);

            return {
                installed: () =>
                    snapshot.installed().filter((extension) => !isPrivateName(extension.name)),
                extension: (name) => {
                    const identity = parseSectionViewName(name);

                    if (identity === undefined) {
                        return snapshot.extension(name);
                    }

                    if (snapshot.extension(name) !== undefined) {
                        return undefined;
                    }

                    const source = snapshot.extension(identity.sourceName);

                    if (source === undefined) {
                        return undefined;
                    }

                    const sourceSections = source.sections ?? [];
                    const selectedKeys = new Set(identity.sectionKeys);
                    const sections = sourceSections.filter((section) =>
                        selectedKeys.has(section.key),
                    );

                    if (
                        sections.length !== identity.sectionKeys.length ||
                        sections.some(
                            (section, index) => section.key !== identity.sectionKeys[index],
                        ) ||
                        (sourceSections.length === sections.length &&
                            sourceSections.every(
                                (section, index) => section.key === sections[index]?.key,
                            ))
                    ) {
                        return undefined;
                    }

                    const view: Extension = {
                        ...source,
                        name,
                        sections,
                    };

                    return view;
                },
                tools: () =>
                    snapshot.tools().filter(({ extension }) => !isPrivateName(extension.name)),
                sections: () =>
                    snapshot.sections().filter(({ extension }) => !isPrivateName(extension.name)),
                tasks: () => snapshot.tasks(),
                task: (name) => snapshot.task(name),
            };
        },
        subscribe: (listener) => base.subscribe(listener),
    };
}

function parseSectionViewName(name: string): SectionViewIdentity | undefined {
    if (!name.startsWith(SECTION_VIEW_PREFIX)) {
        return undefined;
    }

    const encoded = name.slice(SECTION_VIEW_PREFIX.length);

    if (encoded.length === 0) {
        return undefined;
    }

    try {
        const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));

        if (
            !Array.isArray(parsed) ||
            parsed.length !== 4 ||
            parsed[0] !== SECTION_VIEW_VERSION ||
            typeof parsed[1] !== "string" ||
            parsed[1].length === 0 ||
            typeof parsed[2] !== "string" ||
            parsed[2].length === 0 ||
            !Array.isArray(parsed[3]) ||
            parsed[3].some((key) => typeof key !== "string" || key.length === 0) ||
            new Set(parsed[3]).size !== parsed[3].length
        ) {
            return undefined;
        }

        const identity = JSON.stringify(parsed);

        if (Buffer.from(identity, "utf8").toString("base64url") !== encoded) {
            return undefined;
        }

        return {
            sourceName: parsed[1],
            sourceVersion: parsed[2],
            sectionKeys: parsed[3],
        };
    } catch {
        return undefined;
    }
}

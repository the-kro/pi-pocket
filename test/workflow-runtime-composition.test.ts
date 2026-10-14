import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = join(projectRoot, "packages/workflow-runtime");

async function resolveLocalImport(
    fromFile: string,
    specifier: string,
): Promise<string | undefined> {
    const base = resolve(dirname(fromFile), specifier);
    const candidates = extname(base) === "" ? [`${base}.ts`, join(base, "index.ts")] : [base];

    for (const candidate of candidates) {
        try {
            await access(candidate);

            return candidate;
        } catch {
            // A missing relative target is reported through the importing module by TypeScript.
        }
    }

    return undefined;
}

async function importClosure(entries: readonly string[]): Promise<Set<string>> {
    const pending = entries.map((entry) => resolve(runtimeRoot, entry));
    const visited = new Set<string>();

    while (pending.length > 0) {
        const file = pending.pop()!;

        if (visited.has(file)) {
            continue;
        }

        visited.add(file);
        const source = ts.createSourceFile(
            file,
            await readFile(file, "utf8"),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const specifiers: string[] = [];

        for (const statement of source.statements) {
            if (
                (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
                statement.moduleSpecifier !== undefined &&
                ts.isStringLiteral(statement.moduleSpecifier)
            ) {
                specifiers.push(statement.moduleSpecifier.text);
            }
        }

        const collectDynamicImports = (node: ts.Node): void => {
            if (
                ts.isCallExpression(node) &&
                node.expression.kind === ts.SyntaxKind.ImportKeyword &&
                node.arguments.length === 1 &&
                node.arguments[0] !== undefined &&
                ts.isStringLiteral(node.arguments[0])
            ) {
                specifiers.push(node.arguments[0].text);
            }

            ts.forEachChild(node, collectDynamicImports);
        };

        collectDynamicImports(source);

        for (const specifier of specifiers) {
            if (!specifier.startsWith(".")) {
                continue;
            }

            const target = await resolveLocalImport(file, specifier);

            if (target !== undefined) {
                pending.push(target);
            }
        }
    }

    return visited;
}

test("generic agent import closure contains no Review or Verify modules", async () => {
    const closure = await importClosure(["agents/index.ts"]);
    const forbidden = [...closure]
        .map((file) => relative(runtimeRoot, file))
        .filter((file) => /(?:^|\/)(?:review|verification)(?:\/|$)|review-policy/i.test(file))
        .sort();

    assert.deepEqual(forbidden, []);
});

test("generic agent records and configuration contain no Review admission fields", async () => {
    const files = [
        "agents/host.ts",
        "agents/profile.ts",
        "agents/records.ts",
        "agents/recovery.ts",
        "agents/runner.ts",
    ];
    const source = (
        await Promise.all(files.map((file) => readFile(join(runtimeRoot, file), "utf8")))
    ).join("\n");
    const reviewFields = source.match(
        /\b(?:WorkflowAgentReview\w*|reviewerIdentity|freshThread|readonly\s+review\??\s*:|purpose\??\s*:\s*["']review["'])\b/g,
    );

    assert.deepEqual(reviewFields ?? [], []);
});

test("Verify import closure remains independent of Review and generic agent execution", async () => {
    const closure = await importClosure(["verification/index.ts"]);
    const files = [...closure].map((file) => relative(runtimeRoot, file));
    const forbidden = files.filter((file) =>
        /(?:^|\/)review(?:\/|$)|agents\/(?:host|runner|recovery)\.ts$/i.test(file),
    );

    assert.deepEqual(forbidden, []);
});

test("core, agents, Verify, and Review expose independent package entrypoints", async () => {
    const [core, agents, verification, review] = await Promise.all([
        import("../packages/workflow-runtime/core/index.ts"),
        import("../packages/workflow-runtime/agents/index.ts"),
        import("../packages/workflow-runtime/verification/index.ts"),
        import("../packages/workflow-runtime/review/index.ts"),
    ]);

    assert.equal(typeof core.defineWorkflow, "function");
    assert.equal(typeof agents.createWorkflowAgentRuntime, "function");
    assert.equal(typeof verification.verify, "function");
    assert.equal(typeof review.review, "function");
});

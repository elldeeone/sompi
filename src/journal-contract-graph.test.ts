import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = path.join(ROOT, "src");

const PHASE_6_IMPLEMENTATION_REGION = [
  "purchase/journal.ts",
  "transfer/journal.ts",
  "treasury/lease-lifecycle.ts",
  "treasury/operation-adapters.ts",
  "treasury/operation-journal.ts",
  "treasury/operations.ts",
] as const;

const C2_REMOVED_BACK_EDGES = [
  "treasury/lease-lifecycle.ts -> purchase/journal.ts",
  "treasury/operation-journal.ts -> purchase/journal.ts",
  "treasury/operations.ts -> purchase/journal.ts",
] as const;

const C3_IMPLEMENTATION_EDGES = [
  "purchase/journal.ts -> transfer/journal.ts",
  "purchase/journal.ts -> treasury/operation-journal.ts",
  "transfer/journal.ts -> treasury/operation-journal.ts",
  "treasury/lease-lifecycle.ts -> treasury/operation-journal.ts",
  "treasury/operation-adapters.ts -> treasury/operation-journal.ts",
  "treasury/operations.ts -> treasury/lease-lifecycle.ts",
  "treasury/operations.ts -> treasury/operation-adapters.ts",
  "treasury/operations.ts -> treasury/operation-journal.ts",
] as const;

const SHARED_JOURNAL_CONTRACTS = [
  "EffectClaim",
  "EffectObservation",
  "EffectObservationRecord",
  "EffectRecord",
  "EffectState",
  "EffectTransitionRecord",
  "EvidenceArtifactRecord",
  "EvidenceAttachmentRecord",
  "EvidenceVerificationInput",
  "JournalEffectBusyError",
  "JournalFencingError",
  "JournalInvariantError",
  "JournalNotFoundError",
  "JournalRequestConflictError",
  "LeaseToken",
  "PlanEffectInput",
  "StoreEvidenceInput",
] as const;

const PURCHASE_JOURNAL_CONTRACTS = [
  "AuthorizationRecord",
  "AuthorizationRequestRecord",
  "BindCheckoutTermsInput",
  "CheckoutTermsRecord",
  "CreatePaymentAttemptInput",
  "CreatePurchaseInput",
  "CreatePurchaseWithEvidenceInput",
  "EvidenceAdmissionError",
  "EvidenceLinkRecord",
  "FulfilmentRecord",
  "JournalAdmissionStatus",
  "PaymentAttemptRecord",
  "PaymentPreparationRecord",
  "PreparePaymentAttemptInput",
  "PURCHASE_RECEIPT_PROFILE",
  "PurchaseAdmissionError",
  "PurchaseExecutionPlanRecord",
  "PurchaseRecord",
  "PurchaseSettlementRecord",
  "PurchaseTransitionRecord",
  "ReceiptRecord",
  "ReconciliationRunRecord",
  "RecordAuthorizationDecisionInput",
  "RecordAuthorizationRequestInput",
  "RecordFulfilmentInput",
  "RecordPurchaseSettlementInput",
  "RecordReceiptInput",
] as const;

test("C2 removes the contract back-edges from the implementation region", () => {
  const graph = productionImportGraph();
  const edges = componentEdges(graph, new Set(PHASE_6_IMPLEMENTATION_REGION));
  assert.deepEqual(
    C2_REMOVED_BACK_EDGES.filter((edge) => edges.includes(edge)),
    [],
  );
});

test("C2 gives shared and Purchase Journal contracts one direct owner", () => {
  const contracts = [
    ...SHARED_JOURNAL_CONTRACTS.map(
      (name) => [name, "journal/contracts.ts"] as const,
    ),
    ...PURCHASE_JOURNAL_CONTRACTS.map(
      (name) => [name, "purchase/journal-contracts.ts"] as const,
    ),
  ];
  const sharedOwner = exportedDeclarationNames("journal/contracts.ts");
  const purchaseOwner = exportedDeclarationNames(
    "purchase/journal-contracts.ts",
  );
  const owners = productionDeclarationOwners();

  assert.deepEqual(
    SHARED_JOURNAL_CONTRACTS.filter((name) => !sharedOwner.has(name)),
    [],
    "the neutral Journal contract owner is incomplete",
  );
  assert.deepEqual(
    PURCHASE_JOURNAL_CONTRACTS.filter((name) => !purchaseOwner.has(name)),
    [],
    "the Purchase Journal contract owner is incomplete",
  );
  for (const [name, expectedOwner] of contracts) {
    assert.deepEqual(
      owners.get(name) ?? [],
      [expectedOwner],
      `${name} must have one direct contract owner`,
    );
  }

  assert.deepEqual(
    reexportSpecifiers("purchase/journal.ts"),
    [],
    "the concrete Purchase Journal must not forward moved contracts",
  );
  assert.deepEqual(
    identifierUsers("TreasuryStagingPreparationLease"),
    [],
    "the duplicate Treasury staging lease contract still exists",
  );

  const treasuryJournal = sourceText("treasury/operation-journal.ts");
  assert.match(treasuryJournal, /input: StoreEvidenceInput/);
  assert.match(treasuryJournal, /input: EvidenceVerificationInput/);

  const ownerDependencies = new Map<string, readonly string[]>([
    ["journal/contracts.ts", ["purchase/types.ts"]],
    [
      "purchase/journal-contracts.ts",
      [
        "journal/contracts.ts",
        "purchase/execution-plan.ts",
        "purchase/types.ts",
      ],
    ],
  ]);
  for (const [owner, expectedDependencies] of ownerDependencies) {
    const source = parsedSource(owner);
    const dependencies = staticModuleSpecifiers(source)
      .map((specifier) => resolvedSourceFilename(owner, specifier))
      .filter((dependency): dependency is string => dependency !== undefined)
      .sort();
    assert.deepEqual(
      dependencies,
      expectedDependencies,
      `${owner} has an unowned dependency`,
    );
  }

  const concreteJournal = sourceText("purchase/journal.ts");
  assert.doesNotMatch(concreteJournal, /\bEFFECT_STATES\b/);
  assert.doesNotMatch(concreteJournal, /\bPAYMENT_ATTEMPT_STATES\b/);
});

test("C3 gives Treasury and Transfer contracts one direct owner", () => {
  const owners = productionDeclarationOwners();
  const contracts = [
    ["PolicyReservationError", "treasury/operation-journal.ts"],
    ["TreasuryOperationView", "treasury/operation-journal.ts"],
    ["TransferJournal", "transfer/journal.ts"],
    ["TransferJournalIntent", "transfer/journal.ts"],
  ] as const;

  for (const [name, expectedOwner] of contracts) {
    assert.deepEqual(
      owners.get(name) ?? [],
      [expectedOwner],
      `${name} must have one direct contract owner`,
    );
  }
});

test("C3 removes Treasury and Transfer dependencies on implementations", () => {
  const graph = productionImportGraph();
  assert.deepEqual(
    componentEdges(graph, new Set(PHASE_6_IMPLEMENTATION_REGION)),
    [...C3_IMPLEMENTATION_EDGES],
  );

  const concreteJournalImporters = [...graph]
    .filter(([source, dependencies]) =>
      (source.startsWith("treasury/") || source.startsWith("transfer/")) &&
      dependencies.includes("purchase/journal.ts")
    )
    .map(([source]) => source)
    .sort();
  assert.deepEqual(
    concreteJournalImporters,
    [],
    "Treasury and Transfer must not import the concrete Purchase Journal",
  );
});

function productionImportGraph(): ReadonlyMap<string, readonly string[]> {
  const filenames = sourceFiles(SOURCE_ROOT)
    .filter((filename) => !filename.endsWith(".test.ts"))
    .sort();
  const productionFiles = new Set(filenames.map(normalizeFilename));
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
  };
  const graph = new Map<string, readonly string[]>();

  for (const filename of filenames) {
    const source = ts.createSourceFile(
      filename,
      fs.readFileSync(filename, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const dependencies = new Set<string>();
    for (const specifier of staticModuleSpecifiers(source)) {
      const resolved = ts.resolveModuleName(
        specifier,
        filename,
        compilerOptions,
        ts.sys,
      ).resolvedModule?.resolvedFileName;
      if (!resolved) continue;
      const normalized = normalizeFilename(resolved);
      if (productionFiles.has(normalized)) {
        dependencies.add(relativeSourceFilename(normalized));
      }
    }
    graph.set(
      relativeSourceFilename(filename),
      [...dependencies].sort(),
    );
  }
  return graph;
}

function staticModuleSpecifiers(source: ts.SourceFile): readonly string[] {
  return source.statements.flatMap((statement) => {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return [statement.moduleSpecifier.text];
    }
    return [];
  });
}

function componentEdges(
  graph: ReadonlyMap<string, readonly string[]>,
  component: ReadonlySet<string>,
): readonly string[] {
  return [...component]
    .sort()
    .flatMap((source) =>
      (graph.get(source) ?? [])
        .filter((target) => component.has(target))
        .map((target) => `${source} -> ${target}`)
  );
}

function exportedDeclarationNames(
  relativeFilename: string,
): ReadonlySet<string> {
  const source = parsedSource(relativeFilename);
  const names = new Set<string>();

  for (const statement of source.statements) {
    const exported = ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
    if (!exported) continue;

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
      continue;
    }
    if (
      (ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
    }
  }
  return names;
}

function productionDeclarationOwners(): ReadonlyMap<
  string,
  readonly string[]
> {
  const owners = new Map<string, string[]>();
  for (const filename of sourceFiles(SOURCE_ROOT)
    .filter((candidate) => !candidate.endsWith(".test.ts"))
    .sort()) {
    const owner = relativeSourceFilename(filename);
    const source = ts.createSourceFile(
      filename,
      fs.readFileSync(filename, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const statement of source.statements) {
      const names: string[] = [];
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            names.push(declaration.name.text);
          }
        }
      } else if (
        (ts.isClassDeclaration(statement) ||
          ts.isFunctionDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement)) &&
        statement.name
      ) {
        names.push(statement.name.text);
      }
      for (const name of names) {
        const current = owners.get(name) ?? [];
        current.push(owner);
        owners.set(name, current);
      }
    }
  }
  return owners;
}

function reexportSpecifiers(relativeFilename: string): readonly string[] {
  return parsedSource(relativeFilename).statements.flatMap((statement) =>
    ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : []
  );
}

function identifierUsers(name: string): readonly string[] {
  return sourceFiles(SOURCE_ROOT)
    .filter((filename) => !filename.endsWith(".test.ts"))
    .filter((filename) => {
      let found = false;
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === name) found = true;
        if (!found) ts.forEachChild(node, visit);
      };
      visit(
        ts.createSourceFile(
          filename,
          fs.readFileSync(filename, "utf8"),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        ),
      );
      return found;
    })
    .map(relativeSourceFilename)
    .sort();
}

function parsedSource(relativeFilename: string): ts.SourceFile {
  const filename = path.join(SOURCE_ROOT, relativeFilename);
  return ts.createSourceFile(
    filename,
    fs.readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function sourceText(relativeFilename: string): string {
  return fs.readFileSync(path.join(SOURCE_ROOT, relativeFilename), "utf8");
}

function resolvedSourceFilename(
  sourceRelativeFilename: string,
  specifier: string,
): string | undefined {
  const resolved = ts.resolveModuleName(
    specifier,
    path.join(SOURCE_ROOT, sourceRelativeFilename),
    {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
    },
    ts.sys,
  ).resolvedModule?.resolvedFileName;
  return resolved ? relativeSourceFilename(resolved) : undefined;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(filename));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(filename);
  }
  return files;
}

function normalizeFilename(filename: string): string {
  return path.normalize(filename);
}

function relativeSourceFilename(filename: string): string {
  return path.relative(SOURCE_ROOT, filename).split(path.sep).join("/");
}

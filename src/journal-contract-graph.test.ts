import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = path.join(ROOT, "src");
const COMPILER_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
};

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
  "PaymentAttemptState",
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

test("production TypeScript dependency graph is acyclic", () => {
  assert.deepEqual(cyclicComponents(productionImportGraph()), []);
});

test("moved Journal contracts have one direct owner and no forwarding path", () => {
  const contracts = [
    ...SHARED_JOURNAL_CONTRACTS.map(
      (name) => [name, "journal/contracts.ts"] as const,
    ),
    ...PURCHASE_JOURNAL_CONTRACTS.map(
      (name) => [name, "purchase/journal-contracts.ts"] as const,
    ),
    ["PolicyReservationError", "treasury/operation-journal.ts"] as const,
    ["TreasuryOperationView", "treasury/operation-journal.ts"] as const,
    ["TransferJournal", "transfer/journal.ts"] as const,
    ["TransferJournalIntent", "transfer/journal.ts"] as const,
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

  for (const oldOwner of [
    "purchase/journal.ts",
    "treasury/operations.ts",
    "treasury/purchase-staging.ts",
  ]) {
    assert.deepEqual(
      forwardingExports(oldOwner),
      [],
      `${oldOwner} must not forward a moved contract`,
    );
  }
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

test("Treasury and Transfer do not import the concrete Purchase Journal", () => {
  const graph = productionImportGraph();
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

test("one concrete Purchase Journal owns both domain Journal seams", () => {
  const program = productionProgram();
  assert.deepEqual(
    concreteJournalImplementations(
      program,
      "transfer/journal.ts",
      "TransferJournal",
    ),
    ["purchase/journal.ts:PurchaseJournal:class"],
  );
  assert.deepEqual(
    journalContractDeclarations(
      program,
      "transfer/journal.ts",
      "TransferJournal",
    ),
    ["transfer/journal.ts:TransferJournal:interface"],
  );
  assert.deepEqual(
    concreteJournalImplementations(
      program,
      "treasury/operation-journal.ts",
      "TreasuryOperationJournal",
    ),
    ["purchase/journal.ts:PurchaseJournal:class"],
  );
  assert.deepEqual(
    journalContractDeclarations(
      program,
      "treasury/operation-journal.ts",
      "TreasuryOperationJournal",
    ),
    ["treasury/operation-journal.ts:TreasuryOperationJournal:interface"],
  );

  assert.deepEqual(crossDomainSqliteImporters(), [
    "purchase/journal-schema.ts",
    "purchase/journal.ts",
  ]);
  assert.deepEqual(
    databaseConstructorArguments("purchase/journal-schema.ts"),
    [":memory:", ":memory:", ":memory:", ":memory:"],
  );
  assert.deepEqual(
    databaseConstructorArguments("purchase/journal.ts"),
    ["filename"],
  );
});

function productionImportGraph(): ReadonlyMap<string, readonly string[]> {
  const filenames = productionSourceFiles();
  const productionFiles = new Set(filenames.map(normalizeFilename));
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
        COMPILER_OPTIONS,
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

function cyclicComponents(
  graph: ReadonlyMap<string, readonly string[]>,
): readonly (readonly string[])[] {
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  const visit = (node: string): void => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const dependency of graph.get(node) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node)!, lowLinks.get(dependency)!),
        );
      } else if (onStack.has(dependency)) {
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node)!, indices.get(dependency)!),
        );
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    component.sort();
    if (
      component.length > 1 ||
      (graph.get(component[0]) ?? []).includes(component[0])
    ) {
      components.push(component);
    }
  };

  for (const node of [...graph.keys()].sort()) {
    if (!indices.has(node)) visit(node);
  }
  return components.sort((left, right) =>
    left.join("\0").localeCompare(right.join("\0"))
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

function forwardingExports(relativeFilename: string): readonly string[] {
  const source = parsedSource(relativeFilename);
  return source.statements
    .filter(ts.isExportDeclaration)
    .map((statement) => statement.getText(source))
    .sort();
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

function productionProgram(): ts.Program {
  return ts.createProgram({
    rootNames: productionSourceFiles(),
    options: {
      ...COMPILER_OPTIONS,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
    },
  });
}

function concreteJournalImplementations(
  program: ts.Program,
  targetFilename: string,
  targetName: string,
): readonly string[] {
  const checker = program.getTypeChecker();
  const target = namedTypeDeclaration(program, targetFilename, targetName);
  const targetType = checker.getTypeAtLocation(target.name);
  const implementations = new Set<string>();

  for (const source of productionProgramSources(program)) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isClassDeclaration(node) &&
        node.name &&
        isAssignableImplementation(
          checker,
          checker.getTypeAtLocation(node.name),
          targetType,
        )
      ) {
        implementations.add(
          `${relativeSourceFilename(source.fileName)}:${node.name.text}:class`,
        );
      } else if (
        ts.isClassExpression(node) &&
        isAssignableImplementation(
          checker,
          classExpressionInstanceType(checker, node),
          targetType,
        )
      ) {
        const line = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        ).line + 1;
        implementations.add(
          `${relativeSourceFilename(source.fileName)}:${line}:class-expression`,
        );
      } else if (
        (ts.isObjectLiteralExpression(node) ||
          (ts.isAsExpression(node) &&
            (ts.isClassExpression(node.expression) ||
              ts.isObjectLiteralExpression(node.expression)))) &&
        isAssignableImplementation(
          checker,
          checker.getTypeAtLocation(node),
          targetType,
        )
      ) {
        const line = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        ).line + 1;
        implementations.add(
          `${relativeSourceFilename(source.fileName)}:${line}:${
            ts.isObjectLiteralExpression(node) ? "object" : "assertion"
          }`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...implementations].sort();
}

function journalContractDeclarations(
  program: ts.Program,
  targetFilename: string,
  targetName: string,
): readonly string[] {
  const checker = program.getTypeChecker();
  const target = namedTypeDeclaration(program, targetFilename, targetName);
  const targetType = checker.getTypeAtLocation(target.name);
  const contracts = new Set<string>();

  for (const source of productionProgramSources(program)) {
    for (const statement of source.statements) {
      if (
        !(
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement)
        ) ||
        !statement.name
      ) {
        continue;
      }
      const candidateType = checker.getTypeAtLocation(statement.name);
      if (
        !isAssignableImplementation(checker, candidateType, targetType)
      ) {
        continue;
      }
      contracts.add(
        `${relativeSourceFilename(source.fileName)}:${statement.name.text}:${
          ts.isInterfaceDeclaration(statement) ? "interface" : "type"
        }`,
      );
    }
  }
  return [...contracts].sort();
}

type NamedTypeDeclaration =
  & (ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration)
  & { readonly name: ts.Identifier };

function namedTypeDeclaration(
  program: ts.Program,
  targetFilename: string,
  targetName: string,
): NamedTypeDeclaration {
  const targetSource = program.getSourceFile(
    path.join(SOURCE_ROOT, targetFilename),
  );
  assert.ok(targetSource);
  const target = targetSource.statements.find(
    (statement) =>
      (ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name?.text === targetName,
  );
  if (
    !target ||
    !(
      ts.isClassDeclaration(target) ||
      ts.isInterfaceDeclaration(target) ||
      ts.isTypeAliasDeclaration(target)
    ) ||
    !target.name
  ) {
    throw new Error(`${targetFilename} does not declare ${targetName}`);
  }
  return target as NamedTypeDeclaration;
}

function productionProgramSources(program: ts.Program): readonly ts.SourceFile[] {
  return program.getSourceFiles().filter((source) =>
    normalizeFilename(source.fileName).startsWith(
      `${normalizeFilename(SOURCE_ROOT)}${path.sep}`,
    ) && !source.fileName.endsWith(".test.ts")
  );
}

function isAssignableImplementation(
  checker: ts.TypeChecker,
  candidate: ts.Type,
  target: ts.Type,
): boolean {
  if (
    candidate.flags &
      (ts.TypeFlags.Any | ts.TypeFlags.Never | ts.TypeFlags.Unknown)
  ) {
    return false;
  }
  return checker.isTypeAssignableTo(candidate, target);
}

function classExpressionInstanceType(
  checker: ts.TypeChecker,
  expression: ts.ClassExpression,
): ts.Type {
  const signature = checker
    .getTypeAtLocation(expression)
    .getConstructSignatures()[0];
  if (!signature) {
    throw new Error("class expression has no construct signature");
  }
  return checker.getReturnTypeOfSignature(signature);
}

function crossDomainSqliteImporters(): readonly string[] {
  return productionSourceFiles()
    .map(relativeSourceFilename)
    .filter((filename) =>
      !filename.startsWith("authority/") &&
      !filename.startsWith("demo/") &&
      !filename.startsWith("e2e/") &&
      filename !== "e2e-main.ts" &&
      filename !== "smoke.ts"
    )
    .filter((filename) =>
      staticModuleSpecifiers(parsedSource(filename)).includes("better-sqlite3")
    )
    .sort();
}

function databaseConstructorArguments(
  relativeFilename: string,
): readonly string[] {
  const source = parsedSource(relativeFilename);
  const arguments_: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Database"
    ) {
      assert.equal(
        node.arguments?.length,
        1,
        `${relativeFilename} has an unexpected Database constructor`,
      );
      const argument = node.arguments![0]!;
      arguments_.push(
        ts.isStringLiteral(argument) || ts.isIdentifier(argument)
          ? argument.text
          : argument.getText(source),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return arguments_;
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
    COMPILER_OPTIONS,
    ts.sys,
  ).resolvedModule?.resolvedFileName;
  return resolved ? relativeSourceFilename(resolved) : undefined;
}

function productionSourceFiles(): string[] {
  return sourceFiles(SOURCE_ROOT)
    .filter((filename) => !filename.endsWith(".test.ts"))
    .sort();
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

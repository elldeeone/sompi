import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_ROOT = path.join(ROOT, "src");

test("production entrypoints use only their exact runtime capabilities", () => {
  const roles = [
    {
      name: "API",
      source: sourceFile(path.join(SOURCE_ROOT, "api-main.ts")),
      factory: "createSompiApiRuntime",
      capabilities: [
        "close",
        "fundingIntake",
        "policyChange",
        "purchase",
        "transfer",
        "vaultMigration",
        "walletView",
      ],
    },
    {
      name: "offline-owner Vault Migration",
      source: sourceFile(path.join(SOURCE_ROOT, "operator-main.ts")),
      factory: "createSompiOfflineOwnerRuntime",
      capabilities: [
        "chainEvidence",
        "close",
        "vault",
        "vaultMigration",
        "wallet",
      ],
    },
    {
      name: "bootstrap vault activation",
      source: sourceFile(
        path.join(SOURCE_ROOT, "operator", "vault-activation.ts"),
      ),
      factory: "createSompiBootstrapRuntime",
      capabilities: [
        "close",
        "treasuryOperations",
        "vault",
        "wallet",
      ],
    },
  ] as const;

  for (const role of roles) {
    assert.deepEqual(
      directPropertyNames(role.source, "runtime"),
      [...role.capabilities].sort(),
      `${role.name} runtime capabilities changed`,
    );
    assert.deepEqual(
      unsupportedIdentifierUses(role.source, "runtime"),
      [],
      `${role.name} must not pass, spread, or index the complete runtime`,
    );
    assert.equal(
      identifierCalls(role.source, role.factory).length,
      1,
      `${role.name} must construct its exact role runtime once`,
    );
  }
});

test("role consumers use only their mapped nested methods", () => {
  const contracts = sourceFile(path.join(SOURCE_ROOT, "api", "contracts.ts"));
  const purchaseApplication = functionDeclaration(
    contracts,
    "createPurchaseApplication",
  );
  const sompiApplication = functionDeclaration(
    contracts,
    "createSompiApplication",
  );
  assertOnlyDirectProperties(
    purchaseApplication,
    "module",
    ["purchase", "recover", "status"],
  );
  assertOnlyDirectProperties(
    sompiApplication,
    "transfer",
    ["recover", "status", "transfer"],
  );
  assertOnlyDirectProperties(
    sompiApplication,
    "walletView",
    ["activity", "technical", "wallet"],
  );
  assertOnlyDirectProperties(
    sompiApplication,
    "policyChange",
    ["propose", "recover", "status"],
  );
  assertOnlyDirectProperties(
    sompiApplication,
    "vaultMigration",
    ["propose", "status"],
  );

  const funding = sourceFile(
    path.join(SOURCE_ROOT, "funding-intake", "module.ts"),
  );
  assertOnlyDirectProperties(
    functionDeclaration(funding, "startFundingIntake"),
    "intake",
    ["reconcile"],
  );

  const activation = sourceFile(
    path.join(SOURCE_ROOT, "operator", "vault-activation.ts"),
  );
  assertOnlyChildProperties(
    activation,
    "runtime",
    "wallet",
    ["address", "balanceSompi"],
  );
  assertOnlyChildProperties(
    activation,
    "runtime",
    "vault",
    ["config"],
  );
  assertOnlyDirectProperties(
    functionDeclaration(activation, "driveBootstrapVaultDeposit"),
    "operations",
    ["execute", "recover", "status"],
  );

  const operator = sourceFile(path.join(SOURCE_ROOT, "operator-main.ts"));
  assertOnlyChildProperties(
    operator,
    "runtime",
    "vaultMigration",
    ["execute", "recover"],
  );
});

test("each role retains runtime cleanup on success and failure paths", () => {
  const api = sourceFile(path.join(SOURCE_ROOT, "api-main.ts"));
  const apiMain = functionDeclaration(api, "main");
  const close = variableInitializer(apiMain, "close");
  assert.equal(
    memoizedCallAssignments(close, "closePromise", "closeApiResources"),
    1,
  );
  const apiCleanup = functionDeclaration(api, "closeApiResources");
  const apiCleanupCalls = resourceCleanupCalls(apiCleanup, "resources");
  assert.deepEqual(
    apiCleanupCalls.map((entry) => entry.resource),
    ["fundingIntake", "api", "recoveryApi", "runtimeClose"],
  );
  assert.equal(
    apiCleanupCalls.every((entry) => insideAwaitExpression(entry.call)),
    true,
  );
  const apiCatchClauses = descendants(apiMain, ts.isCatchClause);
  assert.equal(apiCatchClauses.length, 1);
  const failedStartCloseCalls = identifierCalls(apiCatchClauses[0], "close");
  assert.equal(failedStartCloseCalls.length, 1);
  assert.equal(
    failedStartCloseCalls.every(insideAwaitExpression),
    true,
  );
  const shutdown = variableInitializer(apiMain, "shutdown");
  assert.equal(identifierCalls(shutdown, "close").length, 1);
  assert.deepEqual(registeredSignals(apiMain, "shutdown"), [
    "SIGINT",
    "SIGTERM",
  ]);

  for (const filename of [
    path.join(SOURCE_ROOT, "operator-main.ts"),
    path.join(SOURCE_ROOT, "operator", "vault-activation.ts"),
  ]) {
    const source = sourceFile(filename);
    const closeCalls = directCalls(source, "runtime", "close");
    assert.equal(closeCalls.length, 1);
    assert.equal(insideFinallyBlock(closeCalls[0]), true);
    assert.equal(insideAwaitExpression(closeCalls[0]), true);
  }
});

test("the broad runtime and duplicate composition roots do not exist", () => {
  const runtime = sourceFile(
    path.join(SOURCE_ROOT, "runtime", "purchase-runtime.ts"),
  );
  assert.equal(identifierCount(runtime, "SompiPurchaseRuntime"), 0);
  assert.equal(identifierCount(runtime, "createSompiPurchaseRuntime"), 0);

  const composition = functionDeclaration(
    runtime,
    "createSompiRuntimeComposition",
  );
  assert.equal(
    composition.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false,
    false,
  );
  for (const factory of [
    "createSompiApiRuntime",
    "createSompiOfflineOwnerRuntime",
    "createSompiBootstrapRuntime",
  ]) {
    assert.equal(
      identifierCalls(
        functionDeclaration(runtime, factory),
        "createSompiRuntimeComposition",
      ).length,
      1,
      `${factory} must use the shared private composition root`,
    );
  }
  for (const constructor of [
    "PurchaseJournal",
    "KaspaWallet",
    "TreasuryOperationModule",
  ]) {
    assert.equal(
      newExpressionCount(runtime, constructor),
      1,
      `${constructor} must have one runtime construction site`,
    );
  }
});

function sourceFile(filename: string): ts.SourceFile {
  return ts.createSourceFile(
    filename,
    fs.readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function functionDeclaration(
  source: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration {
  const declaration = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === name,
  );
  assert.ok(declaration, `${name} must exist`);
  return declaration;
}

function descendants<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const matches: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return matches;
}

function directPropertyNames(root: ts.Node, objectName: string): string[] {
  return [
    ...new Set(
      descendants(root, ts.isPropertyAccessExpression)
        .filter(
          (access) =>
            ts.isIdentifier(access.expression) &&
            access.expression.text === objectName,
        )
        .map((access) => access.name.text),
    ),
  ].sort();
}

function assertOnlyDirectProperties(
  root: ts.Node,
  objectName: string,
  expected: readonly string[],
): void {
  assert.deepEqual(directPropertyNames(root, objectName), expected);
  assert.deepEqual(unsupportedIdentifierUses(root, objectName), []);
}

function childPropertyNames(
  root: ts.Node,
  objectName: string,
  childName: string,
): string[] {
  return [
    ...new Set(
      descendants(root, ts.isPropertyAccessExpression)
        .filter((access) => {
          const child = access.expression;
          return ts.isPropertyAccessExpression(child) &&
            ts.isIdentifier(child.expression) &&
            child.expression.text === objectName &&
            child.name.text === childName;
        })
        .map((access) => access.name.text),
    ),
  ].sort();
}

function assertOnlyChildProperties(
  root: ts.Node,
  objectName: string,
  childName: string,
  expected: readonly string[],
): void {
  assert.deepEqual(
    childPropertyNames(root, objectName, childName),
    expected,
  );
  const unsupported = descendants(root, ts.isPropertyAccessExpression)
    .filter(
      (access) =>
        ts.isIdentifier(access.expression) &&
        access.expression.text === objectName &&
        access.name.text === childName,
    )
    .filter((access) => {
      const parent = access.parent;
      return !(
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === access &&
        expected.includes(parent.name.text)
      );
    })
    .map((access) => {
      const position = root.getSourceFile().getLineAndCharacterOfPosition(
        access.getStart(),
      );
      return `${position.line + 1}:${position.character + 1}`;
    });
  assert.deepEqual(
    unsupported,
    [],
    `${objectName}.${childName} must use only the mapped child properties`,
  );
}

function unsupportedIdentifierUses(
  root: ts.Node,
  identifierName: string,
): string[] {
  return descendants(root, ts.isIdentifier)
    .filter((identifier) => identifier.text === identifierName)
    .filter((identifier) => {
      const parent = identifier.parent;
      if (
        (ts.isVariableDeclaration(parent) ||
          ts.isParameter(parent)) &&
        parent.name === identifier
      ) {
        return false;
      }
      if (
        ts.isBinaryExpression(parent) &&
        parent.left === identifier &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        return false;
      }
      if (
        (ts.isPropertyAccessExpression(parent) ||
          ts.isPropertyAssignment(parent)) &&
        parent.name === identifier
      ) {
        return false;
      }
      return !(
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === identifier
      );
    })
    .map((identifier) => {
      const position = root.getSourceFile().getLineAndCharacterOfPosition(
        identifier.getStart(),
      );
      return `${position.line + 1}:${position.character + 1}`;
    });
}

function directCalls(
  root: ts.Node,
  objectName: string,
  methodName: string,
): ts.CallExpression[] {
  return descendants(root, ts.isCallExpression).filter((call) => {
    const expression = call.expression;
    return ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === objectName &&
      expression.name.text === methodName;
  });
}

function identifierCalls(
  root: ts.Node,
  functionName: string,
): ts.CallExpression[] {
  return descendants(root, ts.isCallExpression).filter(
    (call) =>
      ts.isIdentifier(call.expression) &&
      call.expression.text === functionName,
  );
}

function identifierCount(root: ts.Node, name: string): number {
  return descendants(root, ts.isIdentifier)
    .filter((identifier) => identifier.text === name)
    .length;
}

function newExpressionCount(root: ts.Node, name: string): number {
  return descendants(root, ts.isNewExpression)
    .filter(
      (expression) =>
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === name,
    )
    .length;
}

function memoizedCallAssignments(
  root: ts.Node,
  promiseName: string,
  functionName: string,
): number {
  return descendants(root, ts.isBinaryExpression)
    .filter(
      (expression) =>
        expression.operatorToken.kind ===
          ts.SyntaxKind.QuestionQuestionEqualsToken &&
        ts.isIdentifier(expression.left) &&
        expression.left.text === promiseName &&
        ts.isCallExpression(expression.right) &&
        ts.isIdentifier(expression.right.expression) &&
        expression.right.expression.text === functionName,
    )
    .length;
}

function resourceCleanupCalls(
  root: ts.Node,
  objectName: string,
): Array<{ resource: string; call: ts.CallExpression }> {
  return descendants(root, ts.isCallExpression).flatMap((call) => {
    const expression = call.expression;
    if (!ts.isPropertyAccessExpression(expression)) return [];
    if (
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === objectName &&
      expression.name.text === "runtimeClose"
    ) {
      return [{ resource: "runtimeClose", call }];
    }
    const resource = expression.expression;
    return expression.name.text === "close" &&
      ts.isPropertyAccessExpression(resource) &&
      ts.isIdentifier(resource.expression) &&
      resource.expression.text === objectName
      ? [{ resource: resource.name.text, call }]
      : [];
  });
}

function registeredSignals(root: ts.Node, handlerName: string): string[] {
  return descendants(root, ts.isCallExpression).flatMap((call) => {
    const expression = call.expression;
    const [signal, handler] = call.arguments;
    return ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "process" &&
      expression.name.text === "once" &&
      signal !== undefined &&
      ts.isStringLiteral(signal) &&
      handler !== undefined &&
      ts.isIdentifier(handler) &&
      handler.text === handlerName
      ? [signal.text]
      : [];
  }).sort();
}

function variableInitializer(root: ts.Node, name: string): ts.Expression {
  const declaration = descendants(root, ts.isVariableDeclaration).find(
    (candidate) =>
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === name,
  );
  assert.ok(declaration?.initializer, `${name} must have an initializer`);
  return declaration.initializer;
}

function insideAwaitExpression(node: ts.Node): boolean {
  return hasAncestor(node, ts.isAwaitExpression);
}

function insideFinallyBlock(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current.parent) {
    if (
      ts.isBlock(current) &&
      ts.isTryStatement(current.parent) &&
      current.parent.finallyBlock === current
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function hasAncestor<T extends ts.Node>(
  node: ts.Node,
  predicate: (candidate: ts.Node) => candidate is T,
): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (predicate(current)) return true;
    current = current.parent;
  }
  return false;
}

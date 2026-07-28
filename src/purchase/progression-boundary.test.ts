import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { PURCHASE_STATES } from "./types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PURCHASE_ROOT = path.join(ROOT, "src", "purchase");

test("Purchase keeps one state-to-action progression decision surface private", () => {
  const coordinator = sourceFile(
    path.join(PURCHASE_ROOT, "coordinator.ts"),
  );
  const types = sourceFile(path.join(PURCHASE_ROOT, "types.ts"));
  const purchaseModule = types.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === "PurchaseModule",
  );
  const coordinatorClass = coordinator.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) &&
      statement.name?.text === "PurchaseCoordinator",
  );

  assert.ok(purchaseModule);
  assert.deepEqual(
    purchaseModule.members
      .filter(ts.isMethodSignature)
      .map((member) => propertyName(member.name))
      .sort(),
    ["purchase", "recover", "status"],
  );
  assert.ok(coordinatorClass);

  const progression = coordinatorClass.members.find(
    (member): member is ts.MethodDeclaration =>
      ts.isMethodDeclaration(member) &&
      propertyName(member.name) === "progressPurchase",
  );
  assert.ok(progression);
  assert.equal(
    hasModifier(progression, ts.SyntaxKind.PrivateKeyword),
    true,
  );

  const progressionSwitches = descendants(
    progression,
    ts.isSwitchStatement,
  );
  assert.equal(progressionSwitches.length, 1);
  const progressionStates = caseNames(progressionSwitches[0]);
  assert.deepEqual(
    [...progressionStates].sort(),
    [...PURCHASE_STATES].sort(),
  );

  const purchaseStates = new Set<string>(PURCHASE_STATES);
  const stateRoutingSwitches = descendants(
    coordinatorClass,
    ts.isSwitchStatement,
  ).filter((statement) =>
    caseNames(statement).some((name) => purchaseStates.has(name))
  );
  assert.deepEqual(stateRoutingSwitches, progressionSwitches);
  assert.equal(
    descendants(progression, isIterationStatement).length,
    1,
  );

  const calls = descendants(coordinatorClass, ts.isCallExpression)
    .map(thisCallName)
    .filter((name): name is string => name !== undefined);
  for (const action of [
    "bindTerms",
    "createAuthorizationRequest",
    "requestAuthorization",
    "prepareExecution",
    "submitExecution",
    "obtainFulfilment",
    "resumeProofBackedState",
  ]) {
    assert.equal(
      calls.filter((name) => name === action).length,
      1,
      `${action} must have one progression call site`,
    );
  }
  assert.equal(
    calls.filter((name) => name === "progressPurchase").length,
    2,
  );

  const forbiddenExports = sourceFiles(PURCHASE_ROOT)
    .filter((filename) => !filename.endsWith(".test.ts"))
    .flatMap((filename) => exportedNames(sourceFile(filename)))
    .filter((name) =>
      /progress|workflow|state.?machine|purchase.?engine/i.test(name)
    );
  assert.deepEqual(forbiddenExports, []);
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

function caseNames(statement: ts.SwitchStatement): string[] {
  return statement.caseBlock.clauses.flatMap((clause) =>
    ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)
      ? [clause.expression.text]
      : []
  );
}

function isIterationStatement(
  node: ts.Node,
): node is ts.ForStatement | ts.ForInStatement | ts.ForOfStatement |
  ts.WhileStatement | ts.DoStatement {
  return ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node);
}

function thisCallName(call: ts.CallExpression): string | undefined {
  if (
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.expression.kind !== ts.SyntaxKind.ThisKeyword
  ) {
    return undefined;
  }
  return call.expression.name.text;
}

function propertyName(name: ts.PropertyName): string {
  return ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
    ? name.text
    : name.getText();
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function exportedNames(source: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
      continue;
    }
    if (
      (ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      names.push(statement.name.text);
    }
  }
  return names;
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

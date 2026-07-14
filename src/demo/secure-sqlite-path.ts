import * as path from "node:path";

import { SecureLocalStateDirectory } from "../secure-local-state.js";

export interface SecureSqlitePath {
  readonly state: SecureLocalStateDirectory;
  readonly basename: string;
}

export function prepareSecureSqlitePath(
  filename: string,
  label: string
): SecureSqlitePath | undefined {
  if (filename === ":memory:") return undefined;
  const resolved = path.resolve(filename);
  const state = new SecureLocalStateDirectory(path.dirname(resolved), label);
  const basename = path.basename(resolved);
  if (!state.fileExists(basename)) state.createEmptyFileExclusive(basename);
  const prepared = Object.freeze({ state, basename });
  validateSecureSqlitePath(prepared);
  return prepared;
}

export function validateSecureSqlitePath(pathInfo: SecureSqlitePath | undefined): void {
  if (!pathInfo) return;
  if (!pathInfo.state.fileExists(pathInfo.basename)) {
    throw new Error("SQLite database disappeared during open");
  }
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    pathInfo.state.fileExists(`${pathInfo.basename}${suffix}`);
  }
}

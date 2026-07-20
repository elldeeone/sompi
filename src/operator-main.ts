#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { CliArgumentError, OPERATOR_USAGE, parseOperatorArguments } from "./cli/arguments.js";
import { OperatorManifestError } from "./operator/manifest.js";
import {
  OperatorProvisioningError,
  installOperatorCandidate,
  loadOperatorProvisioningSpec,
  operatorProvisioningStatus,
  previewOperatorProvisioning,
  provisionOperatorCandidate,
} from "./operator/provisioning.js";
import {
  HostBootstrapError,
  loadHostBootstrapRequest,
  previewHostBootstrap,
} from "./operator/host-bootstrap.js";
import { activateHostBootstrap, installHostBootstrap } from "./operator/host-install.js";
import { OfflineRuntimeIdentityError, enterOfflineOwnerRuntime } from "./operator/offline-runtime.js";
import { activateBootstrapVault } from "./operator/vault-activation.js";
import { generateOwnerKey } from "./vault.js";
import { purchaseRuntimeConfigFromEnv } from "./runtime/config.js";
import { createSompiPurchaseRuntime } from "./runtime/purchase-runtime.js";
import { OfflineOwnerVaultMigrationExecutor } from "./vault-migration/owner-executor.js";
import {
  ApiCredentialInstallError,
  installAgentApiCredential,
  installRecoveryApiCredential,
} from "./operator/api-credential.js";

try {
  const command = parseOperatorArguments(process.argv.slice(2));
  switch (command.kind) {
    case "help": process.stdout.write(`${OPERATOR_USAGE}\n`); break;
    case "bootstrap-preview": print(previewHostBootstrap(
      loadHostBootstrapRequest(command.request),
      packageVersion(),
      command.request,
    )); break;
    case "bootstrap": {
      const request = loadHostBootstrapRequest(command.request);
      print(await installHostBootstrap(request, command.digest, {
        packageRoot: packageRoot(),
        runningPackageVersion: packageVersion(),
        requestFilename: command.request,
      }));
      break;
    }
    case "bootstrap-activate": print(activateHostBootstrap(
      loadHostBootstrapRequest(command.request),
      command.digest,
      { runningPackageVersion: packageVersion() },
    )); break;
    case "bootstrap-activate-worker": print(await activateBootstrapVault()); break;
    case "owner-key": {
      const key = generateOwnerKey();
      process.stdout.write(`private: ${key.privateKey}\npublic: ${key.publicKey}\n`);
      break;
    }
    case "vault-migrate": {
      const ownerPrivateKey = readOwnerKey(command.ownerKeyFile);
      enterOfflineOwnerRuntime(process.env);
      const config = purchaseRuntimeConfigFromEnv(process.env);
      const runtime = createSompiPurchaseRuntime(config);
      try {
        const executor = new OfflineOwnerVaultMigrationExecutor({
          vault: runtime.vault, wallet: runtime.wallet, chainEvidence: runtime.chainEvidence,
          ownerPrivateKey, finalityFloor: config.finalityFloors.vault,
          feeCeilingAtomic: config.treasuryOperationFeeCeilingAtomic,
        });
        const result = command.action === "execute"
          ? await runtime.vaultMigration.execute(command.vaultMigrationId, executor)
          : await runtime.vaultMigration.recover(command.vaultMigrationId, executor);
        print(result);
      } finally { await runtime.close(); }
      break;
    }
    case "preview": print(previewOperatorProvisioning(loadOperatorProvisioningSpec(command.spec))); break;
    case "provision": print(provisionOperatorCandidate(loadOperatorProvisioningSpec(command.spec), command.bundle)); break;
    case "install": {
      const installed = installOperatorCandidate(command.bundle, command.manifest, command.digest, {
        operatorUserId: command.operatorUid,
        runtimeUserId: command.runtimeUid,
        runtimeGroupId: command.runtimeGid,
      });
      print({ status: "installed", ...installed.identity, manifest: installed.filename, vaultAddress: installed.manifest.vault.address });
      break;
    }
    case "status": print(operatorProvisioningStatus(command.manifest, {
      operatorUserId: command.operatorUid,
      runtimeUserId: command.runtimeUid,
      runtimeGroupId: command.runtimeGid,
    })); break;
    case "agent-credential": print({ status: "installed", ...installAgentApiCredential(command.filename, {
      operatorUserId: command.operatorUid,
      runtimeGroupId: command.runtimeGid,
    }) }); break;
    case "recovery-credential": print({ status: "installed", ...installRecoveryApiCredential(command.filename, {
      operatorUserId: command.operatorUid,
      runtimeGroupId: command.recoveryGid,
    }) }); break;
  }
} catch (error) {
  if (error instanceof CliArgumentError) {
    process.stderr.write(`fatal: ${error.message}\n${OPERATOR_USAGE}\n`);
    process.exitCode = 2;
  } else if (error instanceof OperatorProvisioningError || error instanceof OperatorManifestError || error instanceof ApiCredentialInstallError || error instanceof HostBootstrapError || error instanceof OfflineRuntimeIdentityError) {
    process.stderr.write(`fatal: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write("fatal: sompi-operator failed safely; inspect the candidate and target paths\n");
    process.exitCode = 1;
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function packageVersion(): string {
  const value = JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as { version?: unknown };
  if (typeof value.version !== "string" || !value.version) throw new HostBootstrapError("package version is invalid");
  return value.version;
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function readOwnerKey(filename: string): string {
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size < 64 || stat.size > 128) {
      throw new HostBootstrapError("owner key file must be one owner-only regular file");
    }
    const value = fs.readFileSync(descriptor, "utf8").trim();
    if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new HostBootstrapError("owner key file is invalid");
    return value;
  } finally { fs.closeSync(descriptor); }
}

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
import { activateBootstrapVault } from "./operator/vault-activation.js";
import { generateOwnerKey } from "./vault.js";
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
  } else if (error instanceof OperatorProvisioningError || error instanceof OperatorManifestError || error instanceof ApiCredentialInstallError || error instanceof HostBootstrapError) {
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

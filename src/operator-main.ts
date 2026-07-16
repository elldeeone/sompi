#!/usr/bin/env node
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
import { generateOwnerKey } from "./vault.js";
import { AgentApiCredentialInstallError, installAgentApiCredential } from "./operator/agent-credential.js";

try {
  const command = parseOperatorArguments(process.argv.slice(2));
  switch (command.kind) {
    case "help": process.stdout.write(`${OPERATOR_USAGE}\n`); break;
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
    case "status": print(operatorProvisioningStatus(command.manifest, { operatorUserId: command.operatorUid, runtimeGroupId: command.runtimeGid })); break;
    case "agent-credential": print({ status: "installed", ...installAgentApiCredential(command.filename, {
      operatorUserId: command.operatorUid,
      runtimeGroupId: command.runtimeGid,
    }) }); break;
  }
} catch (error) {
  if (error instanceof CliArgumentError) {
    process.stderr.write(`fatal: ${error.message}\n${OPERATOR_USAGE}\n`);
    process.exitCode = 2;
  } else if (error instanceof OperatorProvisioningError || error instanceof OperatorManifestError || error instanceof AgentApiCredentialInstallError) {
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

#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly AGENT_USER="hermes-proof"
readonly AGENT_UID="33001"
readonly AGENT_GROUP="hermes-proof"
readonly AGENT_GID="33001"
readonly AGENT_HOME="/home/hermes-proof"

fail() {
  echo "host bootstrap proof failed: $*" >&2
  exit 1
}

[[ $# -eq 0 ]] || fail "container proof takes no arguments"
[[ $(id -u) == 0 ]] || fail "container proof must start as root"
[[ -d /source/src && -f /source/package-lock.json ]] \
  || fail "repository mount is incomplete"

export DEBIAN_FRONTEND=noninteractive
apt-get update >&2
apt-get install -y --no-install-recommends git systemd >&2

package_version=$(node -p "require('/source/package.json').version")
readonly package_root="/opt/sompi/releases/$package_version/node_modules/@elldeeone/sompi"

mkdir -p "$package_root"
tar -C /source \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./.sompi' \
  --exclude='*.log' \
  -cf - . | tar -C "$package_root" -xf -

source_snapshot_sha256=$(
  cd "$package_root"
  find \
    src integrations scripts test/host-bootstrap \
    package.json package-lock.json tsconfig.json \
    -type f -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum \
    | sha256sum \
    | awk '{print $1}'
)

(
  cd "$package_root"
  npm ci --no-audit --no-fund >&2
  npm run build >&2
)

chown -R root:root /opt/sompi
chmod 0755 /opt /opt/sompi "/opt/sompi/releases" \
  "/opt/sompi/releases/$package_version" \
  "/opt/sompi/releases/$package_version/node_modules" \
  "/opt/sompi/releases/$package_version/node_modules/@elldeeone" \
  "$package_root"
chmod -R go-w,a+rX "$package_root"

groupadd --gid "$AGENT_GID" "$AGENT_GROUP"
useradd --uid "$AGENT_UID" --gid "$AGENT_GID" \
  --home-dir "$AGENT_HOME" --create-home --shell /bin/sh "$AGENT_USER"
chmod 0700 "$AGENT_HOME"
install -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0640 /dev/null \
  "$AGENT_HOME/group-readable-agent-secret"
printf '%s\n' 'agent-group-sentinel' \
  >"$AGENT_HOME/group-readable-agent-secret"
chown "$AGENT_USER:$AGENT_GROUP" "$AGENT_HOME/group-readable-agent-secret"
chmod 0640 "$AGENT_HOME/group-readable-agent-secret"

install -d -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0700 \
  "$AGENT_HOME/.hermes/hermes-agent/plugins/platforms/telegram" \
  "$AGENT_HOME/.hermes/hermes-agent/hermes_cli"
(
  for line in $(seq 1 169); do
    printf '# fixture line %s\n' "$line"
  done
  printf '%s\n' \
    'VALID_HOOKS: Set[str] = {' \
    '    #   {"action": "allow"}  /  None             -> normal dispatch' \
    '    # Kwargs: event: MessageEvent, gateway: GatewayRunner, session_store.' \
    '    "pre_gateway_dispatch",' \
    '    # Approval lifecycle hooks. Fired by tools/approval.py when a dangerous' \
    '    # command needs an approval decision -- fires for CLI-interactive prompts,' \
    '    # gateway/ACP approvals, and smart-mode auxiliary-LLM decisions.' \
    '}'
) >"$AGENT_HOME/.hermes/hermes-agent/hermes_cli/plugins.py"
(
  for line in $(seq 1 6144); do
    printf '# fixture line %s\n' "$line"
  done
  printf '%s\n' \
    'class TelegramAdapter(BasePlatformAdapter):' \
    '        # --- Update prompt callbacks ---' \
    '        if not data.startswith("update_prompt:"):' \
    '            return' \
    '        answer = data.split(":", 1)[1]  # "y" or "n"' \
    '        caller_id = str(getattr(query.from_user, "id", ""))' \
    '        if not self._is_callback_user_authorized(' \
    '            caller_id,' \
    '            chat_id=str(query_chat_id or ""),' \
    '            thread_id=str(query_thread_id) if query_thread_id is not None else None,' \
    '            user_name=query_user_name,' \
    '        ):' \
    '            await query.answer(text="⛔ You are not authorized to answer update prompts.")' \
    '            return' \
    "        await query.answer(text=f\"Sent '{answer}' to the update process.\")" \
    '        # Edit the message to show the choice and remove buttons' \
    '        label = "Yes" if answer == "y" else "No"'
) >"$AGENT_HOME/.hermes/hermes-agent/plugins/platforms/telegram/adapter.py"

git -C "$AGENT_HOME/.hermes/hermes-agent" init --initial-branch proof-main >&2
git -C "$AGENT_HOME/.hermes/hermes-agent" config user.name "Sompi Host Proof"
git -C "$AGENT_HOME/.hermes/hermes-agent" config user.email \
  "sompi-host-proof@example.invalid"
git -C "$AGENT_HOME/.hermes/hermes-agent" add \
  hermes_cli/plugins.py plugins/platforms/telegram/adapter.py
git -C "$AGENT_HOME/.hermes/hermes-agent" commit -m "fixture" >&2
git -C "$AGENT_HOME/.hermes/hermes-agent" remote add origin \
  "https://example.invalid/hermes-agent.git"

install -d -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0700 \
  "$AGENT_HOME/.hermes/hermes-agent/venv/bin"
install -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0700 /dev/null \
  "$AGENT_HOME/.hermes/hermes-agent/venv/bin/python"
install -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0600 /dev/null \
  "$AGENT_HOME/.hermes/config.yaml"
printf '%s\n' 'proof_sentinel: before-bootstrap' \
  >"$AGENT_HOME/.hermes/config.yaml"
chown -R "$AGENT_USER:$AGENT_GROUP" "$AGENT_HOME/.hermes"
chmod 0600 \
  "$AGENT_HOME/.hermes/hermes-agent/plugins/platforms/telegram/adapter.py" \
  "$AGENT_HOME/.hermes/hermes-agent/hermes_cli/plugins.py" \
  "$AGENT_HOME/.hermes/config.yaml"

mkdir -p /run/systemd/system
printf '%s\n' '123456789:host-bootstrap-proof-token-value' \
  >/root/sompi-telegram-token
chmod 0600 /root/sompi-telegram-token

privileged_report=$(mktemp)
trap 'rm -f -- "$privileged_report"' EXIT
SOMPI_PROOF_PACKAGE_ROOT="$package_root" \
SOMPI_PROOF_PRIVILEGED_REPORT="$privileged_report" \
node "$package_root/test/host-bootstrap/privileged-release-transaction.mjs"

SOMPI_PROOF_PACKAGE_ROOT="$package_root" \
SOMPI_PROOF_PACKAGE_VERSION="$package_version" \
SOMPI_PROOF_SOURCE_SNAPSHOT="$source_snapshot_sha256" \
SOMPI_PROOF_PRIVILEGED_REPORT="$privileged_report" \
SOMPI_PROOF_AGENT_USER="$AGENT_USER" \
SOMPI_PROOF_AGENT_UID="$AGENT_UID" \
SOMPI_PROOF_AGENT_GID="$AGENT_GID" \
SOMPI_PROOF_AGENT_HOME="$AGENT_HOME" \
node "$package_root/test/host-bootstrap/proof-main.mjs"

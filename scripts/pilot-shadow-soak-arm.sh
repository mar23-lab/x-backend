#!/bin/bash
# pilot-shadow-soak-arm.sh · install/remove the launchd job that accumulates pilot-shadow soak evidence.
#
# WHY A SCRIPT AND NOT AN AGENT ACTION: installing a launchd job is persistent machine configuration
# and writes outside the governed repo tree, so it stays an explicit operator step.
#
#   ./scripts/pilot-shadow-soak-arm.sh install     # start the soak clock (run AFTER the rollback drill)
#   ./scripts/pilot-shadow-soak-arm.sh status      # sample count + last sample
#   ./scripts/pilot-shadow-soak-arm.sh remove      # stop sampling (evidence file is preserved)
#
# ORDERING (matters): the rollback rehearsal must be COMPLETE and the pinned candidate restored before
# arming — a redeploy mid-soak resets the window and invalidates the health-sample continuity.
#
# The plist runs the sampler directly with an absolute node path. It deliberately does NOT use
# `bash -lc`: a login shell re-runs path_helper and discards the plist's own PATH (documented launchd
# trap in this estate), which would route `node` to the wrong runtime or nothing at all.

set -uo pipefail

LABEL=com.xlooop.pilot-shadow-soak
NODE=/Users/maratbasyrov/.nvm/versions/node/v22.22.2/bin/node
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SAMPLER="$REPO_DIR/scripts/pilot-shadow-soak-sampler.mjs"
SOAKDIR="${XLOOOP_SOAK_DIR:-$HOME/.xlooop/pilot-shadow-soak}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
EVIDENCE="$SOAKDIR/soak-evidence-20260717.json"
ROLLBACK="$SOAKDIR/rollback-rehearsal-20260717.json"
INTERVAL_SECONDS="${XLOOOP_SOAK_INTERVAL_SECONDS:-1800}"   # 30 min -> ~96 samples over 48h (gate needs >=12)

case "${1:-}" in
  install)
    if [ ! -f "$ROLLBACK" ]; then
      echo "REFUSED — $ROLLBACK is absent. Complete the rollback rehearsal first and record its evidence."
      exit 2
    fi
    mkdir -p "$SOAKDIR" "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$SAMPLER</string>
    <string>--rollback-json=$ROLLBACK</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>XLOOOP_PILOT_SHADOW_SOAK_EVIDENCE_FILE</key><string>$EVIDENCE</string>
    <key>XLOOOP_PILOT_SHADOW_API_BASE</key><string>https://xlooop-api-pilot-shadow.xlooop23.workers.dev</string>
    <key>XLOOOP_PILOT_SHADOW_FRONTEND_ORIGIN</key><string>https://codex-pilot-shadow-evidence.xlooop-app-next.pages.dev</string>
    <key>XLOOOP_SOAK_OPERATOR</key><string>marat</string>
  </dict>
  <key>StartInterval</key><integer>$INTERVAL_SECONDS</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$SOAKDIR/sampler.log</string>
  <key>StandardErrorPath</key><string>$SOAKDIR/sampler.err.log</string>
</dict>
</plist>
PLIST_EOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
    launchctl bootstrap "gui/$(id -u)" "$PLIST" || { echo "bootstrap FAILED"; exit 1; }
    launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null
    echo "ARMED · $LABEL every ${INTERVAL_SECONDS}s -> $EVIDENCE"
    echo "Soak clock starts at the first sample. Verify with: $0 status"
    ;;
  status)
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|last exit" | head -3 || echo "job not loaded"
    if [ -f "$EVIDENCE" ]; then
      "$NODE" -e "
        const e=JSON.parse(require('fs').readFileSync('$EVIDENCE','utf8'));
        const s=e.health_samples||[];
        const first=s[0]?.checked_at, last=s[s.length-1]?.checked_at;
        const hours=first&&last?((Date.parse(last)-Date.parse(first))/3.6e6).toFixed(2):0;
        console.log(\`samples=\${s.length} window=\${hours}h build=\${(e.backend_build_sha||'').slice(0,12)} rollback=\${!!e.rollback_rehearsal}\`);
        console.log(hours>=48?'WINDOW COMPLETE — finalize now (see sampler --finalize)':'window still accumulating (need >=48h and >=12 samples)');
      "
    else
      echo "no evidence file yet at $EVIDENCE"
    fi
    ;;
  remove)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
    rm -f "$PLIST"
    echo "REMOVED · $LABEL (evidence preserved at $EVIDENCE)"
    ;;
  *)
    echo "Usage: $0 {install|status|remove}"
    exit 1
    ;;
esac

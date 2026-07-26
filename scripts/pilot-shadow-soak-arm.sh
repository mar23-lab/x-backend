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
# The plist runs an immutable copy of the sampler from the soak directory. It deliberately does NOT
# use `bash -lc`: a login shell re-runs path_helper and discards the plist's own PATH. Copying the
# sampler also prevents worktree cleanup from breaking an active soak.

set -uo pipefail

LABEL=com.xlooop.pilot-shadow-soak
NODE=/Users/maratbasyrov/.nvm/versions/node/v22.22.2/bin/node
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_SAMPLER="$REPO_DIR/scripts/pilot-shadow-soak-sampler.mjs"
SOAKDIR="${XLOOOP_SOAK_DIR:-$HOME/.xlooop/pilot-shadow-soak}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ACTIVE_RUN_FILE="$SOAKDIR/active-run-path"
RUN_ID="${XLOOOP_SOAK_RUN_ID:-}"
EVIDENCE="${XLOOOP_PILOT_SHADOW_SOAK_ROLLBACK_EVIDENCE_FILE:-}"
ROLLBACK="${XLOOOP_ROLLBACK_REHEARSAL_FILE:-}"
RESUME="${XLOOOP_SOAK_RESUME:-0}"
INTERVAL_SECONDS="${XLOOOP_SOAK_INTERVAL_SECONDS:-1800}"   # 30 min -> ~96 samples over 48h (gate needs >=12)

case "${1:-}" in
  install)
    if [[ ! "$RUN_ID" =~ ^[a-zA-Z0-9_.:-]{8,120}$ ]]; then
      echo "REFUSED — set XLOOOP_SOAK_RUN_ID to a candidate-specific 8-120 character identifier."
      exit 2
    fi
    if [ -z "$EVIDENCE" ]; then
      EVIDENCE="$SOAKDIR/soak-evidence-$RUN_ID.json"
    fi
    if [ -z "$ROLLBACK" ]; then
      echo "REFUSED — set XLOOOP_ROLLBACK_REHEARSAL_FILE to candidate-specific rollback evidence."
      exit 2
    fi
    if [[ "$EVIDENCE" != /* || "$ROLLBACK" != /* || "$EVIDENCE$ROLLBACK" =~ [\&\<\>] ]]; then
      echo "REFUSED — evidence and rollback paths must be absolute and XML-safe."
      exit 2
    fi
    if [[ ! "$INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
      echo "REFUSED — XLOOOP_SOAK_INTERVAL_SECONDS must be a positive integer."
      exit 2
    fi
    if [ ! -f "$ROLLBACK" ]; then
      echo "REFUSED — $ROLLBACK is absent. Complete the rollback rehearsal first and record its evidence."
      exit 2
    fi
    if [ -e "$EVIDENCE" ] && [ "$RESUME" != "1" ]; then
      echo "REFUSED — $EVIDENCE already exists. Set XLOOOP_SOAK_RESUME=1 only for the same run."
      exit 2
    fi
    if [ -e "$EVIDENCE" ] && ! "$NODE" -e '
      const e=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      process.exit(e?.producer?.run_id===process.argv[2]?0:1);
    ' "$EVIDENCE" "$RUN_ID"; then
      echo "REFUSED — existing evidence producer.run_id does not match XLOOOP_SOAK_RUN_ID."
      exit 2
    fi
    mkdir -p "$SOAKDIR/runtime" "$HOME/Library/LaunchAgents"
    SAMPLER_HASH="$(shasum -a 256 "$SOURCE_SAMPLER" | awk '{print $1}')"
    SAMPLER="$SOAKDIR/runtime/pilot-shadow-soak-sampler-$SAMPLER_HASH.mjs"
    if [ ! -f "$SAMPLER" ]; then
      cp "$SOURCE_SAMPLER" "$SAMPLER"
      chmod 0444 "$SAMPLER"
    fi
    printf '%s\n' "$EVIDENCE" > "$ACTIVE_RUN_FILE"
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
    <key>XLOOOP_PILOT_SHADOW_SOAK_ROLLBACK_EVIDENCE_FILE</key><string>$EVIDENCE</string>
    <key>XLOOOP_PILOT_SHADOW_API_BASE</key><string>https://xlooop-api-pilot-shadow.xlooop23.workers.dev</string>
    <key>XLOOOP_PILOT_SHADOW_FRONTEND_ORIGIN</key><string>https://test.xlooop.com</string>
    <key>XLOOOP_SOAK_OPERATOR</key><string>marat</string>
    <key>XLOOOP_SOAK_RUN_ID</key><string>$RUN_ID</string>
  </dict>
  <key>StartInterval</key><integer>$INTERVAL_SECONDS</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$SOAKDIR/sampler-$RUN_ID.log</string>
  <key>StandardErrorPath</key><string>$SOAKDIR/sampler-$RUN_ID.err.log</string>
</dict>
</plist>
PLIST_EOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
    launchctl bootstrap "gui/$(id -u)" "$PLIST" || { echo "bootstrap FAILED"; exit 1; }
    launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null
    echo "ARMED · $LABEL every ${INTERVAL_SECONDS}s -> $EVIDENCE"
    echo "Runtime snapshot: $SAMPLER"
    echo "Soak clock starts at the first sample. Verify with: $0 status"
    ;;
  status)
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|last exit" | head -3 || echo "job not loaded"
    if [ -z "$EVIDENCE" ] && [ -f "$ACTIVE_RUN_FILE" ]; then
      IFS= read -r EVIDENCE < "$ACTIVE_RUN_FILE"
    fi
    if [ -z "$EVIDENCE" ]; then
      echo "no active evidence path; set XLOOOP_PILOT_SHADOW_SOAK_ROLLBACK_EVIDENCE_FILE"
      exit 0
    fi
    if [ -f "$EVIDENCE" ]; then
      # shellcheck disable=SC2016 # Template interpolation below is JavaScript, not shell expansion.
      "$NODE" -e '
        const e=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
        const s=e.health_samples||[];
        const first=s[0]?.checked_at, last=s[s.length-1]?.checked_at;
        const hours=first&&last?((Date.parse(last)-Date.parse(first))/3.6e6).toFixed(2):0;
        const gaps=s.slice(1).map((x,i)=>(Date.parse(x.checked_at)-Date.parse(s[i].checked_at))/60000);
        const maxGap=gaps.length?Math.max(...gaps).toFixed(2):"n/a";
        const sampled=s.length>=12 && Number(hours)>=48 && s.every(x=>Number(x.status)===200);
        const missing=[
          !e.soak?.ended_at&&"soak.ended_at",
          !Number.isFinite(Number(e.soak?.duration_hours))&&"soak.duration_hours",
          !e.metrics&&"metrics",
          !e.queue&&"queue",
          !e.rollback_rehearsal&&"rollback_rehearsal",
        ].filter(Boolean);
        console.log(`samples=${s.length} window=${hours}h max_gap=${maxGap}m build=${(e.backend_build_sha||"").slice(0,12)} rollback=${!!e.rollback_rehearsal}`);
        if (!sampled) console.log("SAMPLED WINDOW INCOMPLETE — need >=48h, >=12 samples, and all HTTP 200");
        else if (missing.length) console.log(`SAMPLED WINDOW COMPLETE; EVIDENCE NOT FINALIZED — missing ${missing.join(", ")}`);
        else console.log("EVIDENCE FINALIZED — run the strict verifier before any readiness claim");
      ' "$EVIDENCE"
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

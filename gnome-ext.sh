#!/usr/bin/env bash
# gnome-ext.sh — develop, install and test the Wallfred GNOME Shell extension
# with as little manual fiddling as possible.
#
# The headline command is `test`: it launches a *nested* GNOME Shell in its
# own window with a throwaway XDG profile, installs and enables Wallfred there,
# and turns the carousel on — so you watch it work without ever disturbing your
# real desktop. Close the window to finish.
#
# Usage:
#   ./gnome-ext.sh <command>
#
# Commands:
#   test         Launch an isolated nested GNOME Shell with Wallfred live
#   install      Symlink into ~/.local/share and compile schemas (real session)
#   uninstall    Remove the symlink from ~/.local/share
#   enable       Enable Wallfred in the real session
#   disable      Disable Wallfred in the real session
#   reload       Restart the real GNOME Shell in place (X11 only; disruptive)
#   prefs        Open Wallfred's preferences window
#   status       Show install/enable state
#   schemas      Compile the GSettings schema only
#   logs         Follow the real GNOME Shell journal, filtered to [Wallfred]
#   pack         Build a distributable zip via gnome-extensions pack
set -euo pipefail

UUID="wallfred@sebastjan-rijavec.github.io"
# The extension lives at the repo root (EGO-standard layout), so the repo dir
# *is* the extension source dir.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_SRC="$REPO_DIR"
SCHEMA_DIR="$REPO_DIR/schemas"
SCHEMA_ID="org.gnome.shell.extensions.wallfred"

# Folder Wallfred rotates through. Override with CAROUSEL_DIR=/path ...
CAROUSEL_DIR="${CAROUSEL_DIR:-$HOME/Pictures/Wallpapers}"

USER_EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

# Throwaway profile for the nested test session (git-ignored).
DEV_HOME="$REPO_DIR/.dev-home"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

compile_schemas() {
    info "Compiling GSettings schema"
    glib-compile-schemas "$SCHEMA_DIR"
}

cmd_schemas() { compile_schemas; }

cmd_install() {
    compile_schemas
    mkdir -p "$(dirname "$USER_EXT_DIR")"
    if [ -e "$USER_EXT_DIR" ] && [ ! -L "$USER_EXT_DIR" ]; then
        die "$USER_EXT_DIR exists and is not a symlink — remove it first"
    fi
    ln -sfn "$EXT_SRC" "$USER_EXT_DIR"
    info "Linked $USER_EXT_DIR -> $EXT_SRC"
    # Point the carousel at CAROUSEL_DIR if it exists (else the extension
    # falls back to ~/Pictures/Wallpapers on its own).
    if [ -d "$CAROUSEL_DIR" ]; then
        GSETTINGS_SCHEMA_DIR="$SCHEMA_DIR" \
            gsettings set "$SCHEMA_ID" carousel-dir "$CAROUSEL_DIR" 2>/dev/null || true
        info "carousel-dir set to $CAROUSEL_DIR"
    fi
    warn "On X11 the shell must reload to see a new extension: run '$0 reload'"
    warn "(or log out/in), then: '$0 enable'"
}

cmd_uninstall() {
    if [ -L "$USER_EXT_DIR" ]; then
        rm -f "$USER_EXT_DIR"
        info "Removed $USER_EXT_DIR"
    else
        warn "Nothing to remove at $USER_EXT_DIR"
    fi
}

cmd_enable()  { gnome-extensions enable  "$UUID" && info "enabled";  }
cmd_disable() { gnome-extensions disable "$UUID" && info "disabled"; }
cmd_prefs()   { gnome-extensions prefs   "$UUID"; }

cmd_status() {
    echo "UUID:      $UUID"
    echo "Source:    $EXT_SRC"
    echo "Installed: $([ -e "$USER_EXT_DIR" ] && echo yes || echo no) ($USER_EXT_DIR)"
    echo "Carousel:  $CAROUSEL_DIR"
    echo
    gnome-extensions info "$UUID" 2>/dev/null || echo "(not known to gnome-extensions yet)"
}

cmd_reload() {
    if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
        die "Can't restart the shell in place on Wayland. Log out/in, or use '$0 test'."
    fi
    warn "Restarting GNOME Shell in place (windows survive)…"
    nohup gnome-shell --replace >/dev/null 2>&1 &
    disown || true
}

cmd_logs() {
    info "Following [Wallfred] log lines (Ctrl-C to stop)"
    journalctl /usr/bin/gnome-shell -f -o cat | grep --line-buffered -i 'wallfred' || true
}

cmd_pack() {
    compile_schemas
    local out="$REPO_DIR/dist"
    mkdir -p "$out"
    gnome-extensions pack "$EXT_SRC" \
        --force --out-dir "$out" \
        --extra-source=metadata.json
    info "Packed into $out"
}

# --- the automatic, non-disruptive test harness --------------------------
cmd_test() {
    command -v dbus-run-session >/dev/null || die "dbus-run-session not found"
    command -v gnome-shell       >/dev/null || die "gnome-shell not found"

    compile_schemas

    # Isolated XDG profile so nothing here touches the real session's dconf,
    # enabled-extensions list, or wallpaper.
    local data="$DEV_HOME/data" config="$DEV_HOME/config"
    local cache="$DEV_HOME/cache" state="$DEV_HOME/state" run="$DEV_HOME/run"
    mkdir -p "$data/gnome-shell/extensions" "$config" "$cache" "$state" "$run"

    ln -sfn "$EXT_SRC" "$data/gnome-shell/extensions/$UUID"

    local nested_size="${NESTED_SIZE:-1600x1000}"
    local interval="${TEST_INTERVAL:-1}"   # minutes; 1 = fastest allowed

    info "Nested GNOME Shell — isolated profile at $DEV_HOME"
    info "Wallfred enabled, carousel ON, every ${interval} min, folder: $CAROUSEL_DIR"
    info "Close the nested window to exit and clean up."

    XDG_DATA_HOME="$data" \
    XDG_CONFIG_HOME="$config" \
    XDG_CACHE_HOME="$cache" \
    XDG_STATE_HOME="$state" \
    XDG_RUNTIME_DIR="$run" \
    GSETTINGS_SCHEMA_DIR="$SCHEMA_DIR" \
    CAROUSEL_DIR="$CAROUSEL_DIR" \
    NESTED_SIZE="$nested_size" \
    TEST_INTERVAL="$interval" \
    UUID="$UUID" \
    SCHEMA_ID="$SCHEMA_ID" \
    dbus-run-session -- bash -c '
        set -e
        # Seed the isolated dconf before the shell starts.
        gsettings set org.gnome.shell enabled-extensions "['\''$UUID'\'']"
        gsettings set "$SCHEMA_ID" carousel-dir "$CAROUSEL_DIR"
        gsettings set "$SCHEMA_ID" interval-minutes "$TEST_INTERVAL"
        gsettings set "$SCHEMA_ID" shuffle true
        gsettings set "$SCHEMA_ID" rotate-enabled true
        exec env MUTTER_DEBUG_DUMMY_MODE_SPECS="$NESTED_SIZE" \
            gnome-shell --nested --wayland
    '

    info "Nested session ended."
    info "Remove the throwaway profile with: rm -rf \"$DEV_HOME\""
}

main() {
    local cmd="${1:-}"
    case "$cmd" in
        test)      cmd_test ;;
        install)   cmd_install ;;
        uninstall) cmd_uninstall ;;
        enable)    cmd_enable ;;
        disable)   cmd_disable ;;
        reload)    cmd_reload ;;
        prefs)     cmd_prefs ;;
        status)    cmd_status ;;
        schemas)   cmd_schemas ;;
        logs)      cmd_logs ;;
        pack)      cmd_pack ;;
        ""|-h|--help|help)
            sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            ;;
        *) die "unknown command: $cmd (try '$0 help')" ;;
    esac
}

main "$@"

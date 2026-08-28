# Thin wrapper around gnome-ext.sh for the Wallfred GNOME Shell extension.
# Run `make test` for the automatic, isolated nested-session demo.

DEV := ./gnome-ext.sh

.PHONY: test install uninstall enable disable reload prefs status schemas logs pack help

test install uninstall enable disable reload prefs status schemas logs pack:
	@$(DEV) $@

help:
	@$(DEV) help

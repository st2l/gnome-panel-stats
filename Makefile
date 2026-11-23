UUID := panel-stats@st2l.github.io
EXTENSIONS_DIR := $(HOME)/.local/share/gnome-shell/extensions
SOURCES := $(UUID)/extension.js $(UUID)/prefs.js $(UUID)/menu.js $(UUID)/stats.js \
	$(UUID)/stylesheet.css $(UUID)/metadata.json

.PHONY: install uninstall pack enable disable prefs logs

install:
	./install.sh

uninstall:
	gnome-extensions disable $(UUID) || true
	rm -rf "$(EXTENSIONS_DIR)/$(UUID)"

pack:
	rm -f $(UUID).shell-extension.zip
	glib-compile-schemas --strict $(UUID)/schemas
	cd $(UUID) && zip -q -r ../$(UUID).shell-extension.zip .

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

logs:
	journalctl --user -f -o cat /usr/bin/gnome-shell

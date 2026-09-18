UUID := hinge@agayushh.github.io
SRC := extension
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: install uninstall schemas enable disable test scan dist site

schemas:
	glib-compile-schemas "$(SRC)/schemas"

test:
	gjs -m tests/test-motion.js
	python3 tests/test-sensor-helper.py

scan:
	python3 "$(SRC)/sensor-helper.py" --scan

install: schemas
	rm -rf "$(DEST)"
	mkdir -p "$(DEST)/shaders" "$(DEST)/schemas"
	cp "$(SRC)/metadata.json" "$(SRC)/extension.js" "$(SRC)/prefs.js" "$(SRC)/motion.js" "$(SRC)/sensor.js" "$(SRC)/lidWatch.js" "$(SRC)/foldEffect.js" "$(SRC)/stylesheet.css" "$(SRC)/sensor-helper.py" "$(DEST)/"
	cp "$(SRC)/shaders/fold.glsl" "$(DEST)/shaders/"
	cp "$(SRC)/schemas/"*.xml "$(SRC)/schemas/"gschemas.compiled "$(DEST)/schemas/"
	chmod +x "$(DEST)/sensor-helper.py"
	@echo
	@echo "Installed to $(DEST)"
	@echo "Enable with:  gnome-extensions enable $(UUID)"
	@echo "On Wayland, a new install may need a logout before it appears."

uninstall:
	gnome-extensions disable $(UUID) >/dev/null 2>&1 || true
	rm -rf "$(DEST)"

enable:
	gsettings set org.gnome.shell disable-user-extensions false
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

dist:
	mkdir -p website/downloads
	rm -f website/downloads/hinge-gnome.zip website/downloads/hinge-gnome.zip.sha256
	zip -r website/downloads/hinge-gnome.zip README.md LICENSE Makefile MOTION.md 99-hinge-lid.rules extension tests \
		-x '*.pyc' '*__pycache__*' 'extension/schemas/gschemas.compiled'
	sha256sum website/downloads/hinge-gnome.zip | awk '{print $$1}' > website/downloads/hinge-gnome.zip.sha256

site: dist
	@echo "Serving website at http://127.0.0.1:4173"
	python3 -m http.server 4173 --directory website

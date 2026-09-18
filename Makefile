UUID := lidfx@agayushh.github.io
VERSION := 5
SRC := extension
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
STAGE := .build/extension
DEBROOT := .build/deb
PKG := gnome-shell-extension-lidfx
APPID := io.github.agayushh.LidFx
PACK_ZIP := website/downloads/lidfx.shell-extension.zip
DEB := website/downloads/$(PKG)_$(VERSION)_all.deb
EXT_FILES := metadata.json extension.js prefs.js motion.js sensor.js lidWatch.js foldEffect.js stylesheet.css sensor-helper.py

.PHONY: install uninstall schemas enable disable test scan stage pack deb dist site clean

schemas:
	glib-compile-schemas "$(SRC)/schemas"

test:
	gjs -m tests/test-motion.js
	python3 tests/test-sensor-helper.py

scan:
	python3 "$(SRC)/sensor-helper.py" --scan

stage:
	rm -rf "$(STAGE)"
	mkdir -p "$(STAGE)/shaders" "$(STAGE)/schemas"
	cp $(addprefix $(SRC)/,$(EXT_FILES)) "$(STAGE)/"
	cp "$(SRC)/shaders/fold.glsl" "$(STAGE)/shaders/"
	cp "$(SRC)/schemas/"*.xml "$(STAGE)/schemas/"
	chmod +x "$(STAGE)/sensor-helper.py"

install: schemas stage
	rm -rf "$(DEST)"
	mkdir -p "$(DEST)"
	cp -a "$(STAGE)/." "$(DEST)/"
	cp "$(SRC)/schemas/gschemas.compiled" "$(DEST)/schemas/"
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

pack: stage
	mkdir -p website/downloads
	rm -f "$(PACK_ZIP)" "$(PACK_ZIP).sha256"
	cd "$(STAGE)" && zip -r "$(CURDIR)/$(PACK_ZIP)" .
	sha256sum "$(PACK_ZIP)" | awk '{print $$1}' > "$(PACK_ZIP).sha256"
	@echo "Wrote $(PACK_ZIP)"

deb: stage
	rm -rf "$(DEBROOT)"
	python3 packaging/icons/render.py .build/icons
	mkdir -p "$(DEBROOT)/DEBIAN" \
		"$(DEBROOT)/usr/share/gnome-shell/extensions/$(UUID)" \
		"$(DEBROOT)/usr/share/glib-2.0/schemas" \
		"$(DEBROOT)/usr/lib/udev/rules.d" \
		"$(DEBROOT)/usr/share/doc/$(PKG)" \
		"$(DEBROOT)/usr/share/metainfo" \
		"$(DEBROOT)/usr/share/icons/hicolor/scalable/apps" \
		"$(DEBROOT)/usr/share/icons/hicolor/64x64/apps" \
		"$(DEBROOT)/usr/share/icons/hicolor/128x128/apps" \
		"$(DEBROOT)/usr/share/icons/hicolor/256x256/apps"
	cp -a "$(STAGE)/." "$(DEBROOT)/usr/share/gnome-shell/extensions/$(UUID)/"
	cp "$(SRC)/schemas/"*.xml "$(DEBROOT)/usr/share/glib-2.0/schemas/"
	cp 99-lidfx-lid.rules "$(DEBROOT)/usr/lib/udev/rules.d/"
	cp packaging/debian/copyright "$(DEBROOT)/usr/share/doc/$(PKG)/copyright"
	gzip -9n -c packaging/debian/changelog > "$(DEBROOT)/usr/share/doc/$(PKG)/changelog.gz"
	cp packaging/metainfo/$(APPID).metainfo.xml "$(DEBROOT)/usr/share/metainfo/"
	cp packaging/icons/$(APPID).svg "$(DEBROOT)/usr/share/icons/hicolor/scalable/apps/"
	cp .build/icons/$(APPID)-64.png "$(DEBROOT)/usr/share/icons/hicolor/64x64/apps/$(APPID).png"
	cp .build/icons/$(APPID)-128.png "$(DEBROOT)/usr/share/icons/hicolor/128x128/apps/$(APPID).png"
	cp .build/icons/$(APPID)-256.png "$(DEBROOT)/usr/share/icons/hicolor/256x256/apps/$(APPID).png"
	find "$(DEBROOT)/usr" -type d -exec chmod 755 {} \;
	find "$(DEBROOT)/usr" -type f -exec chmod 644 {} \;
	chmod 755 "$(DEBROOT)/usr/share/gnome-shell/extensions/$(UUID)/sensor-helper.py"
	SIZE=$$(du -sk "$(DEBROOT)/usr" | awk '{print $$1}'); \
	sed "s/@VERSION@/$(VERSION)/; s/@SIZE@/$$SIZE/" packaging/debian/control.in \
		> "$(DEBROOT)/DEBIAN/control"
	cp packaging/debian/postinst packaging/debian/postrm "$(DEBROOT)/DEBIAN/"
	chmod 755 "$(DEBROOT)/DEBIAN/postinst" "$(DEBROOT)/DEBIAN/postrm"
	mkdir -p website/downloads
	rm -f "$(DEB)" "$(DEB).sha256"
	dpkg-deb --root-owner-group --build "$(DEBROOT)" "$(DEB)"
	sha256sum "$(DEB)" | awk '{print $$1}' > "$(DEB).sha256"
	@echo "Wrote $(DEB)"

dist: pack deb
	cd website/downloads && sha256sum lidfx.shell-extension.zip $(PKG)_$(VERSION)_all.deb > SHA256SUMS
	@echo "Install zip: gnome-extensions install --force $(PACK_ZIP)"
	@echo "Install deb: sudo apt install ./$(notdir $(DEB))"

site: dist
	@echo "Serving website at http://127.0.0.1:4173"
	python3 -m http.server 4173 --directory website

clean:
	rm -rf .build

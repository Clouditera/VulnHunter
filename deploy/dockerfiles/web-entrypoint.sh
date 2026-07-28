#!/bin/sh
# Select nginx template + HTML root by NGINX_ROLE (business|admin).
# Runs before official 20-envsubst-on-templates.sh.
set -e
ROLE="${NGINX_ROLE:-business}"
SRC="/etc/nginx/templates-src/${ROLE}.conf.template"
if [ ! -f "$SRC" ]; then
  echo "[web] unknown NGINX_ROLE=$ROLE, falling back to business" >&2
  ROLE=business
  SRC="/etc/nginx/templates-src/business.conf.template"
fi
mkdir -p /etc/nginx/templates
cp "$SRC" /etc/nginx/templates/default.conf.template

# Point the live docroot at the selected bundle (other bundle stays on disk but unused)
rm -rf /usr/share/nginx/html
if [ "$ROLE" = "admin" ]; then
  ln -s /usr/share/nginx/html-admin /usr/share/nginx/html
else
  ln -s /usr/share/nginx/html-business /usr/share/nginx/html
fi
echo "[web] NGINX_ROLE=$ROLE template + html root installed"

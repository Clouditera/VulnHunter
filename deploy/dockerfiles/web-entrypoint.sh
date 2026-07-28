#!/bin/sh
# Select nginx template by NGINX_ROLE (business|admin). Runs before 20-envsubst-on-templates.sh.
set -e
ROLE="${NGINX_ROLE:-business}"
SRC="/etc/nginx/templates-src/${ROLE}.conf.template"
if [ ! -f "$SRC" ]; then
  echo "[web] unknown NGINX_ROLE=$ROLE, falling back to business" >&2
  SRC="/etc/nginx/templates-src/business.conf.template"
fi
mkdir -p /etc/nginx/templates
cp "$SRC" /etc/nginx/templates/default.conf.template
echo "[web] NGINX_ROLE=$ROLE template installed"

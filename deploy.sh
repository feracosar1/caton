#!/bin/bash
set -e

VM="azureuser@20.84.48.138"
KEY="/Users/fernandoaraujo/Downloads/numa-scraper_key.pem"
REMOTE="~/caton"

echo "→ Copiando archivos..."
scp -i "$KEY" -q \
  veedor-server.mjs \
  endpoints-veeduria.mjs \
  smtp-utils.mjs \
  imap-poller.mjs \
  analizador-pliegos.mjs \
  motor-reglas.mjs \
  motor-precontractual.mjs \
  motor-similitud.mjs \
  redactor.mjs \
  score-contrato.mjs \
  busqueda.mjs \
  repo-veeduria.mjs \
  pipeline.mjs \
  package.json \
  "$VM:$REMOTE/"

echo "→ Reiniciando servidor..."
ssh -i "$KEY" "$VM" "cd $REMOTE && npm install --omit=dev --silent && pm2 restart caton --update-env"

echo "✓ Deploy OK"

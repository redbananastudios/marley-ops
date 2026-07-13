#!/bin/bash
# Deploy the current working tree to the OVH VPS (vps-a0b9c066 / 51.195.253.165):
# transfer source → rebuild the standalone image → restart the container → smoke-test.
# Run from the marley-ops repo root on i9 (which holds the repo + the SSH key).
# The box has no GitHub creds by design — i9 is the source of truth and pushes builds.
set -e
BOX="ubuntu@51.195.253.165"
KEY="/c/Users/peter/.ssh/rbs_vps"
SSH="ssh -F /dev/null -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new $BOX"

echo "→ transferring source to /opt/marley-ops ..."
tar --exclude=node_modules --exclude=.next --exclude=.git --exclude='.env*' \
    --exclude=coverage --exclude=docs --exclude=supabase/volumes -czf - . \
  | $SSH "tar xzf - -C /opt/marley-ops"

echo "→ building + restarting on the box ..."
$SSH 'bash -s' <<'EOF'
set -e
cd /opt/marley-ops
URL=$(grep '^NEXT_PUBLIC_SUPABASE_URL=' app.env | cut -d= -f2-)
ANON=$(grep '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' app.env | cut -d= -f2-)
APP=$(grep '^NEXT_PUBLIC_APP_URL=' app.env | cut -d= -f2-)
sudo docker build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="$URL" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON" \
  --build-arg NEXT_PUBLIC_APP_URL="$APP" \
  -t marley-ops:latest .
sudo docker rm -f marley-ops-app 2>/dev/null || true
sudo docker run -d --name marley-ops-app --restart unless-stopped \
  --network rbs -p 127.0.0.1:3000:3000 --env-file /opt/marley-ops/app.env marley-ops:latest
sleep 5
curl -s -o /dev/null -w "  app /login -> HTTP %{http_code}\n" http://127.0.0.1:3000/login
EOF
echo "✓ deployed to https://ops.marleymoves.co.uk"

#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Without root we can neither remap the node user (usermod/groupmod/chown)
# nor switch users (gosu needs CAP_SETUID/CAP_SETGID), so exec directly.
# This covers Kubernetes restricted PodSecurity (runAsNonRoot + runAsUser)
# as well as platforms that assign arbitrary UIDs (e.g. OpenShift); for the
# latter a UID/GID mismatch is unfixable here, so warn instead of letting
# usermod fail cryptically and keep volume-permission issues diagnosable.
if [ "$(id -u)" -ne 0 ]; then
    if [ "$(id -u)" -ne "$PUID" ] || [ "$(id -g)" -ne "$PGID" ]; then
        echo "docker-entrypoint.sh: running unprivileged as $(id -u):$(id -g); cannot remap to requested ${PUID}:${PGID}" >&2
    fi
    exec "$@"
fi

# Adjust the node user's UID/GID if they differ from the runtime request
# and fix volume ownership only when a remap is needed
changed=0

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
fi

if [ "$changed" = "1" ]; then
    chown -R node:node /paperclip
fi

# Always fix npm cache ownership (global installs run as root during build)
chown -R node:node /paperclip/.npm 2>/dev/null || true

# Inject secrets from Infisical via machine identity token
if [ -n "$INFISICAL_CLIENT_ID" ] && [ -n "$INFISICAL_CLIENT_SECRET" ]; then
    echo "Authenticating with Infisical..."
    INFISICAL_TOKEN=$(curl -s "${INFISICAL_API_URL}/v1/auth/universal-auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"clientId\": \"${INFISICAL_CLIENT_ID}\", \"clientSecret\": \"${INFISICAL_CLIENT_SECRET}\"}" \
        | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])" 2>/dev/null)

    if [ -n "$INFISICAL_TOKEN" ]; then
        echo "Loading secrets from Infisical..."
        export INFISICAL_TOKEN
        exec gosu node infisical run \
            --token "$INFISICAL_TOKEN" \
            --projectId "$INFISICAL_PROJECT_ID" \
            --env "${INFISICAL_ENV:-dev}" \
            --domain "$INFISICAL_API_URL" \
            --silent \
            -- "$@"
    else
        echo "WARNING: Infisical auth failed, starting without secrets injection"
        exec gosu node "$@"
    fi
else
    exec gosu node "$@"
fi

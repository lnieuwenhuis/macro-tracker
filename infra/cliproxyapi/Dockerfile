# CLIProxyAPI wraps a ChatGPT/Codex OAuth login as an OpenAI-compatible API.
# Deployed as its own Railway service; the backend reaches it over the
# private network and uses it as the food-photo AI gateway (AI_GATEWAY_URL).
#
# Upstream: https://github.com/router-for-me/CLIProxyAPI (MIT).
# Pinned by version tag; bump deliberately after checking upstream releases.
FROM eceasy/cli-proxy-api:v7.2.132

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Railway injects PORT; CLIProxyAPI also serves the management panel used to
# complete the Codex OAuth login from a browser.
EXPOSE 8317

ENTRYPOINT ["/entrypoint.sh"]

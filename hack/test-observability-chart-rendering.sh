#!/usr/bin/env bash
# Render-only gateway boundary checks; synthetic config and Secret references.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/values.yaml" <<'YAML'
deploymentMode: split
mcp:
  enabled: true
  publicURL: https://paprika.example.test
  oauth:
    clientId: synthetic-render-client
    redirectUris: [http://localhost:8791/callback]
auth:
  enabled: true
apiServer:
  extraEnv:
    - name: PAPRIKA_AUTH_TOKEN_SECRET
      valueFrom:
        secretKeyRef: {name: preexisting-auth, key: token-secret}
observabilityGateway:
  enabled: true
  serviceAccountName: preapproved-observe-reader
  discovery: {enabled: false}
  image:
    repository: ghcr.io/paprikacd/paprika@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    tag: ""
  extraEnv:
    - name: PAPRIKA_AUTH_TOKEN_SECRET
      valueFrom:
        secretKeyRef: {name: preexisting-auth, key: token-secret}
  additionalEgress:
    - to:
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: monitoring}
          podSelector:
            matchLabels: {app: prometheus}
      ports: [{protocol: TCP, port: 9090}]
networkPolicy:
  enabled: true
YAML
render() { helm template paprika "$root/charts/chart" -n paprika-system -f "$work/values.yaml" "$@"; }
render --show-only templates/mcp-client-registries.yaml > "$work/client-registries.yaml"
python3 - "$work/client-registries.yaml" <<'PY'
import pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text()
documents = [doc for doc in text.split('\n---') if 'kind:' in doc]
assert len(documents) == 6, 'fleet and observe need separate ConfigMap/Role/RoleBinding triples'
registries = {}
for doc in documents:
    kind = re.search(r'^kind: (\S+)$', doc, re.M).group(1)
    name = re.search(r'^  name: (\S+)$', doc, re.M).group(1)
    assert '  namespace: paprika-system' in doc
    registries.setdefault(kind, []).append(name)
    if kind == 'ConfigMap':
        assert 'helm.sh/resource-policy: keep' in doc
        resource = re.search(r'^  resource: "([^"]+)"$', doc, re.M).group(1)
        assert resource == 'https://paprika.example.test' + ('/observe/mcp' if 'observe' in name else '/mcp')
    elif kind == 'Role':
        assert 'resources: [configmaps]' in doc
        assert f'resourceNames: ["{name}"]' in doc
        assert 'verbs: [get, update]' in doc
        assert '*' not in doc and 'secrets' not in doc
    elif kind == 'RoleBinding' and 'observe' in name:
        assert 'name: preapproved-observe-reader' in doc
assert sorted(registries['ConfigMap']) == sorted(registries['Role']) == sorted(registries['RoleBinding'])
assert len(set(registries['ConfigMap'])) == 2
PY
render --set mcp.oauth.persistClients=false > "$work/ephemeral-clients.yaml"
if grep -Eq -- '--mcp-client-registry-|component: mcp-client-registry' "$work/ephemeral-clients.yaml"; then
  echo 'Explicit process-local client registration unexpectedly installed durable storage' >&2; exit 1
fi
render --show-only templates/observability-gateway/deployment.yaml > "$work/deployment.yaml"
grep -Eq -- '--mcp-client-registry-configmap=paprika-observe-mcp-clients$' "$work/deployment.yaml"
grep -Eq -- '--mcp-client-registry-namespace=paprika-system$' "$work/deployment.yaml"
render --show-only templates/api-server/deployment.yaml > "$work/fleet-deployment.yaml"
grep -Eq -- '--mcp-client-registry-configmap=paprika-mcp-clients$' "$work/fleet-deployment.yaml"
grep -Eq -- '--mcp-client-registry-namespace=paprika-system$' "$work/fleet-deployment.yaml"
grep -Eq -- '--observability-discovery-enabled=false' "$work/deployment.yaml"
grep -Eq 'serviceAccountName: preapproved-observe-reader$' "$work/deployment.yaml"
grep -Eq 'image: "ghcr.io/paprikacd/paprika@sha256:a{64}"$' "$work/deployment.yaml"
grep -Eq 'name: preexisting-auth$' "$work/deployment.yaml"
grep -Eq -- '--mcp-oauth-client-id=synthetic-render-client$' "$work/deployment.yaml"
grep -Eq -- '--mcp-oauth-redirect-uris=http://localhost:8791/callback$' "$work/deployment.yaml"
if grep -Eq '^kind: (Secret|ServiceAccount|Role|RoleBinding|ClusterRole|ClusterRoleBinding)$' "$work/deployment.yaml"; then
  echo 'Custom identity must not implicitly grant permissions' >&2; exit 1
fi
if grep -Fq 'PAPRIKA_AUTH_RBAC_RULES' "$work/deployment.yaml"; then
  echo 'Empty default auth.rbac unexpectedly installed application permissions' >&2; exit 1
fi
cat > "$work/rbac.yaml" <<'YAML'
auth:
  rbac:
    - subjects: [fixture-observe-subject]
      actions: [read]
      resources: [observabilityproviders]
      namespaces: [paprika-system]
YAML
render -f "$work/rbac.yaml" --show-only templates/observability-gateway/deployment.yaml > "$work/rbac-deployment.yaml"
python3 - "$work/rbac-deployment.yaml" <<'PY'
import json, pathlib, re, sys
manifest = pathlib.Path(sys.argv[1]).read_text()
values = re.findall(r'^        - name: PAPRIKA_AUTH_RBAC_RULES\n          value: (.+)$', manifest, re.M)
assert len(values) == 1
assert json.loads(json.loads(values[0])) == [{"subjects": ["fixture-observe-subject"], "actions": ["read"], "resources": ["observabilityproviders"], "namespaces": ["paprika-system"]}]
assert re.findall(r'^kind: (\S+)$', manifest, re.M) == ["Deployment"]
assert "configMapKeyRef:" not in manifest
PY
cat > "$work/manual-rbac.yaml" <<'YAML'
observabilityGateway:
  extraEnv:
    - name: PAPRIKA_AUTH_TOKEN_SECRET
      valueFrom:
        secretKeyRef: {name: preexisting-auth, key: token-secret}
    - name: PAPRIKA_AUTH_RBAC_RULES
      value: '[{"subjects":["manual-observe-subject"],"actions":["read"],"resources":["observabilityproviders"],"namespaces":["paprika-system"]}]'
YAML
render -f "$work/manual-rbac.yaml" --show-only templates/observability-gateway/deployment.yaml > "$work/manual-rbac-deployment.yaml"
[[ $(grep -c 'name: PAPRIKA_AUTH_RBAC_RULES$' "$work/manual-rbac-deployment.yaml") -eq 1 ]]
grep -Fq 'manual-observe-subject' "$work/manual-rbac-deployment.yaml"
if render -f "$work/manual-rbac.yaml" -f "$work/rbac.yaml" > "$work/duplicate-rbac-error" 2>&1; then
  echo 'Duplicate application RBAC settings unexpectedly rendered' >&2; exit 1
fi
grep -Fq 'must not be set in observabilityGateway.extraEnv when auth.rbac is configured' "$work/duplicate-rbac-error"
cat > "$work/dcr-only.yaml" <<'YAML'
mcp:
  enabled: false
  oauth:
    clientId: ""
    redirectUris: []
YAML
# Render the whole chart: a standalone gateway must not enable the fleet MCP
# surface or register a static client in either Deployment.
render -f "$work/dcr-only.yaml" > "$work/dcr-only-chart.yaml"
grep -Eq -- '--mode=observability-gateway$' "$work/dcr-only-chart.yaml"
if grep -Eq -- '--mcp-enabled=true|--mcp-oauth-(client-id|redirect-uris)=' "$work/dcr-only-chart.yaml"; then
  echo 'DCR-only gateway unexpectedly enabled fleet MCP or configured a static OAuth client' >&2; exit 1
fi
for partial in 'clientId: ""' 'redirectUris: []'; do
  printf 'mcp:\n  enabled: false\n  oauth:\n    %s\n' "$partial" > "$work/partial-oauth.yaml"
  if render -f "$work/partial-oauth.yaml" > "$work/partial-oauth-error" 2>&1; then
    echo 'Partial static OAuth client configuration unexpectedly rendered' >&2; exit 1
  fi
  grep -Fq 'must both be configured or both omitted' "$work/partial-oauth-error"
done
render --show-only templates/observability-gateway/httproute.yaml --set observabilityGateway.ingress.enabled=true --set apiServer.ingress.gateway.hostname=paprika.example.test --set apiServer.ingress.gateway.gatewayRef.name=preexisting-gateway --set apiServer.ingress.gateway.gatewayRef.namespace=paprika-system --set apiServer.ingress.gateway.gatewayRef.sectionName=https > "$work/route.yaml"
grep -Eq '^    sectionName: "https"$' "$work/route.yaml"
for path in /observe /.well-known/oauth-authorization-server/observe /.well-known/oauth-protected-resource/observe/mcp; do
  grep -Fq "value: $path" "$work/route.yaml"
done
render --show-only templates/networkpolicy/observability-gateway.yaml > "$work/policy.yaml"
grep -Eq 'port: 9090' "$work/policy.yaml"
grep -Eq 'kubernetes.io/metadata.name: monitoring' "$work/policy.yaml"
grep -Eq 'app: prometheus' "$work/policy.yaml"
render --set observabilityGateway.additionalEgress=null --show-only templates/networkpolicy/observability-gateway.yaml > "$work/default-policy.yaml"
if grep -Eq 'port: 9090' "$work/default-policy.yaml"; then
  echo 'Unapproved nonstandard backend egress appeared' >&2; exit 1
fi
for invalid in auth.enabled=false mcp.publicURL= deploymentMode=monolith observabilityGateway.replicas=2 observabilityGateway.hpa.enabled=true observabilityGateway.strategy.type=RollingUpdate; do
  if render -f "$work/dcr-only.yaml" --set "$invalid" > "$work/invalid.yaml" 2>&1; then
    echo "Unsafe gateway configuration unexpectedly rendered: $invalid" >&2; exit 1
  fi
done
python3 - "$root" "$work" <<'PY'
import hashlib, json, pathlib, re, ssl, subprocess, sys
root, work = map(pathlib.Path, sys.argv[1:])
certificate = '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n'
def render_ca(overlay, success=True, omega=False):
    values = work / 'ca-values.json'
    values.write_text(json.dumps(overlay))
    command = ['helm', 'template', 'paprika', str(root / 'charts/chart'), '-n', 'paprika-system']
    if omega:
        for path in ('deploy/test-values.yaml', 'deploy/omega-values.yaml', 'deploy/insights-omega-values.yaml'):
            command += ['-f', str(root / path)]
    else:
        command += ['-f', str(work / 'values.yaml')]
    result = subprocess.run(command + ['-f', str(values)], capture_output=True, text=True)
    assert (result.returncode == 0) == success, result.stderr or 'Expected CA configuration rejection'
    return result.stdout
def configured(certs=None, **values):
    return {'observabilityGateway': {'additionalCACertificates': certs or {'trusted.crt': certificate}, **values}}
def checksum(text):
    values = re.findall(r'checksum/additional-ca-certificates: "([0-9a-f]{64})"', text)
    assert len(values) == 1
    return values[0]
plain = render_ca({})
for marker in ('SSL_CERT_DIR', 'additional-ca-certificates', 'name: paprika-observability-ca'):
    assert marker not in plain, 'Default gateway trust unexpectedly changed'
rendered = render_ca(configured())
assert rendered.count('name: SSL_CERT_DIR') == 1
assert 'value: /etc/ssl/certs:/etc/pki/tls/certs:/etc/paprika/additional-ca-certificates' in rendered
assert 'SSL_CERT_FILE' not in rendered, 'Default system certificate file must remain available'
assert re.search(r'- name: observability-ca\n\s+mountPath: /etc/paprika/additional-ca-certificates\n\s+readOnly: true', rendered)
assert re.search(r'- name: observability-ca\n\s+configMap:\n\s+name: paprika-observability-ca', rendered)
assert '"trusted.crt": |\n    -----BEGIN CERTIFICATE-----' in rendered
assert checksum(rendered) == checksum(render_ca(configured())), 'CA checksum is not deterministic'
changed = {'trusted.crt': certificate.replace('QUJD', 'REVG')}
assert checksum(rendered) != checksum(render_ca(configured(changed))), 'CA content update must roll the gateway'
assert checksum(rendered) != checksum(render_ca(configured({'renamed.pem': certificate}))), 'CA filename update must roll the gateway'
multiple = render_ca(configured({'one.crt': certificate, 'two.pem': certificate}))
assert '"one.crt": |' in multiple and '"two.pem": |' in multiple
for disabled in ({'observabilityGateway': {'enabled': False, 'additionalCACertificates': {'trusted.crt': certificate}}}, {'observabilityGateway': {'additionalCACertificates': None}}):
    output = render_ca(disabled)
    assert 'SSL_CERT_DIR' not in output and 'additional-ca-certificates' not in output
environment = [{'name': 'PAPRIKA_AUTH_TOKEN_SECRET', 'valueFrom': {'secretKeyRef': {'name': 'preexisting-auth', 'key': 'token-secret'}}}, {'name': 'SSL_CERT_DIR', 'value': '/custom/trust'}]
render_ca(configured(extraEnv=environment), success=False)
assert re.search(r'value: "?/custom/trust"?', render_ca({'observabilityGateway': {'extraEnv': environment}}))
render_ca(configured(extraVolumes=[{'name': 'observability-ca', 'emptyDir': {}}]), success=False)
render_ca(configured(extraVolumeMounts=[{'name': 'observability-ca', 'mountPath': '/other'}]), success=False)
render_ca(configured(extraVolumeMounts=[{'name': 'other', 'mountPath': '/etc/paprika/additional-ca-certificates'}]), success=False)
combined = configured(extraVolumes=[{'name': 'fixture-data', 'emptyDir': {}}], extraVolumeMounts=[{'name': 'fixture-data', 'mountPath': '/fixture-data'}])
combined['mtls'] = {'enabled': True}
output = render_ca(combined)
assert 'name: fixture-data' in output and 'name: mtls-cert' in output and 'name: observability-ca' in output
for invalid in ('not-a-map', ['not-a-map'], {'../escape.crt': certificate}, {'.hidden.crt': certificate}, {'private.key': certificate}, {'trusted.crt': 123}, {'trusted.crt': '-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----'}, {'trusted.crt': certificate + 'unexpected suffix'}, {f'ca-{i}.crt': certificate for i in range(17)}, {'trusted.crt': certificate.replace('QUJD', 'A' * 32768)}):
    render_ca({'observabilityGateway': {'additionalCACertificates': invalid}}, success=False)
omega = render_ca({}, omega=True)
public_ca = re.search(r'  "supabase-prod-ca-2021.crt": \|\n((?:    .+\n)+)', omega).group(1)
public_ca = '\n'.join(line[4:] for line in public_ca.splitlines()) + '\n'
assert hashlib.sha256(ssl.PEM_cert_to_DER_cert(public_ca)).hexdigest() == '807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa', 'Omega public CA fingerprint changed without review'
assert 'SSL_CERT_FILE' not in omega
checksum(omega)
print('Observability CA defaults, mounting, checksum, conflicts, validation and Omega fingerprint checks passed.')
PY
printf 'Observability chart auth, identity, discovery routing, egress and CA checks passed.\n'

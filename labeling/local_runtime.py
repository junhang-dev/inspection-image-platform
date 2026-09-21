"""Start a local-only Label Studio service; secrets and state never enter Git."""
from pathlib import Path
import json
import secrets
import subprocess
from labeling.bridge import STATE

IMAGE = 'heartexlabs/label-studio:1.23.0'
PINNED = 'heartexlabs/label-studio@sha256:aa461572e8f9d86a1bf9520c1db620204e86160fd2f80dd7e9d40ac84a8828ea'
NAME = 'inspection-label-studio-local'
NETWORK = 'inspection-labeling-local'

def docker(*args, **kwargs):
    return subprocess.run(['docker', '--context', 'orbstack', *args], check=True, capture_output=True, text=True, **kwargs).stdout.strip()

def main():
    STATE.mkdir(parents=True, exist_ok=True)
    for name in ['images', 'db']:
        (STATE / name).mkdir(exist_ok=True)
    secret = STATE / 'secrets.local.env'
    if not secret.exists():
        with secret.open('x') as f:
            f.write('\n'.join([
                'LABEL_STUDIO_USERNAME=operator@localhost',
                'LABEL_STUDIO_PASSWORD=' + secrets.token_urlsafe(32),
                'LABEL_STUDIO_USER_TOKEN=' + secrets.token_hex(32),
                'LABEL_STUDIO_ENABLE_LEGACY_API_TOKEN=true',
                'LABEL_STUDIO_LOCAL_FILES_SERVING_ENABLED=true',
                'LABEL_STUDIO_LOCAL_FILES_DOCUMENT_ROOT=/label-studio/candidates',
                'COLLECT_ANALYTICS=False',
                'SSRF_PROTECTION_ENABLED=true',
                'LABEL_STUDIO_DISABLE_SIGNUP_WITHOUT_LINK=true',
            ]) + '\n')
        secret.chmod(0o600)
    info = json.loads(docker('image', 'inspect', IMAGE))[0]
    reference = PINNED
    if reference not in info['RepoDigests']:
        raise ValueError('Official image digest changed')
    nets = docker('network', 'ls', '--filter', 'name=^' + NETWORK + '$', '--format', '{{.Name}}')
    if not nets:
        docker('network', 'create', '--internal', NETWORK)
    net = json.loads(docker('network', 'inspect', NETWORK))[0]
    if net['Internal'] is not True:
        raise ValueError('Label Studio network must block external egress')
    # Existing service is not removed/replaced implicitly.
    cid = docker('run', '-d', '--name', NAME, '--network', NETWORK,
        '--cpus', '2', '--memory', '2g', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--env-file', str(secret),
        '--mount', f'type=bind,src={STATE / "db"},dst=/label-studio/data',
        '--mount', f'type=bind,src={STATE / "images"},dst=/label-studio/candidates/approved,readonly',
        '-p', '127.0.0.1:8085:8080', reference)
    (STATE / 'runtime.local.json').write_text(json.dumps({'image': IMAGE, 'digest': reference,
        'image_id': info['Id'], 'container_id': cid, 'name': NAME, 'network': NETWORK,
        'url': 'http://127.0.0.1:8085', 'egress': 'internal network', 'candidate_mount_readonly': True}, indent=2))
    print(json.dumps({'name': NAME, 'url': 'http://127.0.0.1:8085', 'digest': reference}))

if __name__ == '__main__': main()

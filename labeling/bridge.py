"""Loopback-only, demo-only Label Studio bridge; no implicit training inclusion."""
from __future__ import annotations
import argparse
import copy
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / 'labeling/state.local'

def digest(data):
    return hashlib.sha256(data).hexdigest()

def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()

def save_new(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as f:
        f.write(encoded(value))

def now():
    return datetime.now(timezone.utc).isoformat()

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Redirects are forbidden')

class Client:
    def __init__(self, base, token=None):
        url = urllib.parse.urlsplit(base)
        if url.scheme != 'http' or url.hostname not in {'127.0.0.1', 'localhost'} or url.username or url.password or url.path not in {'', '/'}:
            raise ValueError('Only explicit local HTTP origin is allowed')
        self.base, self.token = base.rstrip('/'), token
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, path, data=None, method=None, raw=False):
        if not path.startswith('/') or path.startswith('//'):
            raise ValueError('Invalid API path')
        headers = {'Content-Type': 'application/json'}
        if self.token:
            headers['Authorization'] = 'Token ' + self.token
        request = urllib.request.Request(self.base + path, data=None if data is None else encoded(data), headers=headers, method=method)
        with self.opener.open(request, timeout=60) as response:
            payload = response.read()
        return payload if raw else json.loads(payload)

def approved_demo_hashes(directory=None):
    directory = Path(directory or ROOT / 'image/demo')
    allowlist = json.loads((ROOT / 'labeling/demo-allowlist.json').read_text())
    expected = {item['name']: item['sha256'] for item in allowlist}
    if directory.is_symlink() or {p.name for p in directory.iterdir()} != set(expected):
        raise ValueError('Demo directory must contain only the five approved files')
    for name, expected_hash in expected.items():
        path = directory / name
        if path.is_symlink() or not path.is_file() or path.resolve().parent != directory.resolve():
            raise ValueError('Demo file path or symlink is invalid')
        if digest(path.read_bytes()) != expected_hash:
            raise ValueError('Approved demo bytes changed')
    return set(expected.values())

class CandidateQueryError(ValueError):
    """No partial snapshot is safe; the caller may retry the whole prepare later."""

def candidate_scope(purpose):
    if purpose not in {'workflow_test', 'engineer_review_pending'}:
        raise ValueError('Invalid labeling purpose')
    return {'planId': 'all', 'pointId': 'all', 'teamId': 'all', 'rackId': 'all',
            'search': '', 'classification': 'all', 'labeling': 'true',
            'visibility': 'visible',
            'recordPurpose': 'all' if purpose == 'workflow_test' else 'inspection'}

def candidate_pages(client, purpose, page_size=100):
    """Validate full candidate coverage before any image download or snapshot write.

    The API has a snapshot per response, not across requests. Detect observable
    changes; equal totals cannot prove a single point-in-time dataset snapshot.
    """
    scope = candidate_scope(purpose)
    if type(page_size) is not int or not 1 <= page_size <= 100:
        raise ValueError('Invalid candidate page size')
    allowed = {'inspection', 'presentation', 'verification'} if purpose == 'workflow_test' else {'inspection'}
    rows, seen = [], set()
    total, pages, page = None, None, 1

    def fail(reason):
        raise CandidateQueryError('Candidate query incomplete or changed; retry prepare: ' + reason)

    while True:
        requested = {**scope, 'page': page, 'pageSize': page_size}
        result = client.request('/api/inspections/query?' + urllib.parse.urlencode(requested))
        if not isinstance(result, dict) or not isinstance(result.get('items'), list):
            fail('expected paged response')
        for name in ['total', 'page', 'pages', 'pageSize']:
            if type(result.get(name)) is not int:
                fail('invalid numeric page metadata')
        count = result['total']
        if count < 0 or result['page'] != page or result['pageSize'] != page_size:
            fail('negative total, clamped page, or changed page size')
        expected_pages = max(1, (count + page_size - 1) // page_size)
        if result['pages'] != expected_pages:
            fail('page count does not match total')
        if total is None:
            total, pages = count, expected_pages
        elif (count, expected_pages) != (total, pages):
            fail('total or pages changed between responses')
        if result.get('scope') != requested or encoded(result['scope']) != encoded(requested):
            fail('response scope differs from explicit query')
        expected_count = min(page_size, max(0, total - (page - 1) * page_size))
        if len(result['items']) != expected_count:
            fail('empty, short, or oversized page')
        for row in result['items']:
            if not isinstance(row, dict):
                fail('invalid candidate row')
            if (not isinstance(row.get('recordPurpose'), str) or row['recordPurpose'] not in allowed
                    or row.get('visibility') != 'visible'
                    or row.get('labeling') is not True):
                fail('candidate outside permitted purpose, visibility, or labeling scope')
            try:
                if not isinstance(row.get('id'), str):
                    raise ValueError('not a UUID string')
                identity = str(uuid.UUID(row['id']))
            except ValueError:
                fail('invalid candidate UUID')
            if identity in seen:
                fail('duplicate UUID or stalled page')
            seen.add(identity)
            rows.append({**row, 'id': identity})
        if len(seen) > total:
            fail('unique UUID count exceeds total')
        if page == pages:
            if len(seen) != total:
                fail('unique UUID count differs from total')
            return rows, {'endpoint': '/api/inspections/query', 'filters': scope,
                          'allowed_record_purposes': sorted(allowed), 'total': total,
                          'unique_uuid_count': len(seen), 'pages': pages, 'page_size': page_size,
                          'consistency': 'per_response_snapshot_only'}
        page += 1

def prepare(manifest_path, backend='http://127.0.0.1:4000', purpose='workflow_test'):
    if purpose not in {'workflow_test', 'engineer_review_pending'}:
        raise ValueError('Invalid labeling purpose')
    raw = Path(manifest_path).read_bytes()
    manifest = json.loads(raw)
    freeze = json.loads((ROOT / 'ml/artifacts/final-freeze.local.json').read_text())
    if digest(raw) != freeze['manifest_sha256']:
        raise ValueError('Manifest differs from original frozen split')
    included = [e for e in manifest['entries'] if e['included']]
    if Counter(e['split'] for e in included) != {'train':231, 'validation':58, 'test':10} or len({e['id'] for e in included}) != 299:
        raise ValueError('Invalid fixed split structure')
    # Metadata only: no original image, especially no test pixels, is opened.
    fixed = {e['sha256']: e for e in manifest['entries'] if e['included']}
    if len(fixed) != sum(e['included'] for e in manifest['entries']):
        raise ValueError('Duplicate SHA in fixed split')
    approved = approved_demo_hashes()
    client = Client(backend)
    rows, query_scope = candidate_pages(client, purpose)
    grouped = {}
    for row in rows:
        sha = row.get('sha256')
        if not row.get('labeling') or sha not in approved:
            continue
        entry = fixed.get(sha)
        if not entry or entry['split'] != 'train':
            raise ValueError('Demo candidate must map to the original train split')
        inspection_id = str(uuid.UUID(row['id']))
        payload = client.request(f'/api/inspections/{inspection_id}/image', raw=True)
        if digest(payload) != sha:
            raise ValueError('Backend bytes differ from saved SHA')
        path = STATE / 'images' / (sha + '.img')
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.is_symlink():
            raise ValueError('Candidate symlink forbidden')
        if path.exists():
            if digest(path.read_bytes()) != sha:
                raise ValueError('Existing candidate bytes changed')
        else:
            with path.open('xb') as f:
                f.write(payload)
        item = grouped.setdefault(sha, {'source_id': entry['id'], 'sha256': sha, 'split': 'train',
            'image': '/data/local-files/?d=approved/' + sha + '.img', 'inspections': []})
        item['inspections'].append({'inspection_id': inspection_id, 'updated_at': row.get('updatedAt'),
            'original_ai': row.get('ai'), 'human_correction': row.get('humanGrade'),
            'record_purpose': row['recordPurpose'], 'visibility': row['visibility']})
    if not grouped:
        raise ValueError('No approved demo candidates')
    snapshot = {'schema': 1, 'created_at': now(), 'manifest_sha256': digest(raw),
        'annotation_provenance': purpose, 'training_eligible': False, 'candidate_query': query_scope,
        'items': sorted(grouped.values(), key=lambda x: x['sha256'])}
    key = digest(encoded(snapshot))
    save_new(STATE / 'snapshots' / f'{key}.json', snapshot)
    return key

def ls_client():
    env = dict(line.split('=', 1) for line in (STATE / 'secrets.local.env').read_text().splitlines() if '=' in line)
    return Client('http://127.0.0.1:8085', env['LABEL_STUDIO_USER_TOKEN'])

def import_project(snapshot_key):
    snapshot = load_snapshot(snapshot_key)
    client = ls_client()
    receipt = STATE / 'projects' / f'{snapshot_key}.json'
    if receipt.exists():
        raise FileExistsError('Snapshot already imported; use existing project receipt')
    project = client.request('/api/projects/', {'title': 'InspectLoop · ' + snapshot['annotation_provenance'] + ' ' + snapshot_key[:8],
        'description': '로컬 후보 라벨. workflow_test는 학습 금지; 실제 엔지니어 검토 및 별도 학습 승인이 필요합니다.',
        'label_config': (ROOT / 'labeling/config.xml').read_text()})
    # Reserve project receipt before import: failures do not create silent duplicates.
    save_new(receipt, {'project_id': project['id'], 'snapshot_sha256': snapshot_key, 'created_at': now()})
    client.request('/api/storages/localfiles', {'project': project['id'], 'path': '/label-studio/candidates/approved',
        'title': 'Approved demo candidates only', 'use_blob_urls': True, 'recursive_scan': False})
    tasks = [{'data': {'image': i['image'], 'source_id': i['source_id'], 'sha256': i['sha256'],
        'snapshot_sha256': snapshot_key, 'annotation_provenance': snapshot['annotation_provenance']}} for i in snapshot['items']]
    result = client.request(f"/api/projects/{project['id']}/import", tasks)
    save_new(STATE / 'projects' / f'{snapshot_key}-import.json', result)
    return project['id']

def load_snapshot(key):
    if len(key) != 64 or any(c not in '0123456789abcdef' for c in key):
        raise ValueError('Invalid snapshot hash')
    raw = (STATE / 'snapshots' / f'{key}.json').read_bytes()
    if digest(raw) != key:
        raise ValueError('Snapshot changed')
    return json.loads(raw)

def validate_export(snapshot, tasks, key):
    expected = {item['sha256']: item for item in snapshot['items']}
    output, seen = [], set()
    for task in tasks:
        data = task['data']; sha = data.get('sha256'); item = expected.get(sha)
        if not item or sha in seen or data.get('source_id') != item['source_id'] or data.get('image') != item['image'] or data.get('snapshot_sha256') != key:
            raise ValueError('Unknown, duplicate, or modified Label Studio task')
        seen.add(sha)
        annotations = []
        for annotation in task.get('annotations', []):
            if annotation.get('was_cancelled') or annotation.get('ground_truth'):
                raise ValueError('Cancelled or claimed ground-truth annotation requires review')
            result = annotation.get('result', [])
            if len(result) != 1:
                raise ValueError('One complete grade annotation is required')
            r = result[0]; choices = r.get('value', {}).get('choices', [])
            if r.get('from_name') != 'grade' or r.get('to_name') != 'image' or r.get('type') != 'choices' or len(choices) != 1 or choices[0] not in ['1','2','3','4','5']:
                raise ValueError('Unexpected annotation schema')
            annotations.append({'annotation_id': annotation['id'], 'grade': int(choices[0]),
                'annotator': annotation.get('completed_by'), 'updated_at': annotation.get('updated_at')})
        if len({a['grade'] for a in annotations}) > 1:
            raise ValueError('Conflicting labels for one original SHA')
        output.append({**item, 'task_id': task['id'], 'training_annotations': annotations,
            'annotation_provenance': snapshot['annotation_provenance'], 'training_eligible': False})
    if seen != set(expected):
        raise ValueError('Export omitted candidate tasks')
    return output

def export_project(key):
    snapshot = load_snapshot(key)
    project = json.loads((STATE / 'projects' / f'{key}.json').read_text())
    tasks = ls_client().request(f"/api/projects/{project['project_id']}/export?exportType=JSON&download_all_tasks=true")
    items = validate_export(snapshot, tasks, key)
    export = {'schema': 1, 'created_at': now(), 'snapshot_sha256': key,
        'project_id': project['project_id'], 'annotation_provenance': snapshot['annotation_provenance'],
        'training_eligible': False, 'items': items}
    export_key = digest(encoded(export))
    save_new(STATE / 'exports' / f'{export_key}.json', export)
    save_new(STATE / 'exports' / f'{export_key}-raw.json', tasks)
    return export_key

def review_export(key, decisions_path, reviewer, reason):
    if len(key) != 64 or any(c not in '0123456789abcdef' for c in key):
        raise ValueError('Invalid export hash')
    raw = (STATE / 'exports' / f'{key}.json').read_bytes()
    if digest(raw) != key:
        raise ValueError('Export changed since review')
    value = json.loads(raw)
    if value['annotation_provenance'] != 'engineer_review_pending':
        raise ValueError('Workflow-test labels can never be promoted for training')
    if not reviewer.strip() or not reason.strip():
        raise ValueError('Actual reviewer and review reason required')
    decisions_raw = Path(decisions_path).read_bytes()
    decisions = json.loads(decisions_raw)
    approved = {(d['source_id'], d['sha256']): d['grade'] for d in decisions}
    if len(approved) != len(decisions) or len(decisions) != len(value['items']):
        raise ValueError('Each original needs exactly one explicit reviewed grade')
    for item in value['items']:
        if item['annotation_provenance'] != 'engineer_review_pending':
            raise ValueError('Unreviewable provenance')
        grade = approved.get((item['source_id'], item['sha256']))
        actual = {a['grade'] for a in item['training_annotations']}
        if type(grade) is not int or grade not in range(1,6) or actual != {grade}:
            raise ValueError('Review decision must match complete, conflict-free annotations')
        item['annotation_provenance'] = 'engineer_reviewed'; item['training_eligible'] = True
    decision_key = digest(encoded(decisions))
    decision_file = STATE / 'review-decisions' / f'{decision_key}.json'
    if not decision_file.exists():
        save_new(decision_file, decisions)
    elif digest(decision_file.read_bytes()) != decision_key:
        raise ValueError('Stored decisions changed')
    value.update(annotation_provenance='engineer_reviewed', training_eligible=True,
        review={'reviewer': reviewer, 'reason': reason, 'reviewed_at': now(),
                'source_export_sha256': key, 'decisions_sha256': decision_key})
    reviewed_key = digest(encoded(value))
    save_new(STATE / 'reviewed' / f'{reviewed_key}.json', value)
    return reviewed_key

def load_reviewed(path):
    path = Path(path)
    raw = path.read_bytes(); key = digest(raw)
    registry = STATE / 'reviewed' / f'{key}.json'
    if path.resolve() != registry.resolve() or not registry.is_file():
        raise ValueError('Labels must be a registered reviewed artifact')
    value = json.loads(raw); review = value.get('review', {})
    if not review.get('reviewer', '').strip() or not review.get('reason', '').strip() or not review.get('reviewed_at'):
        raise ValueError('Missing explicit review record')
    export_key = review.get('source_export_sha256', '')
    decision_key = review.get('decisions_sha256', '')
    for identity in [export_key, decision_key]:
        if len(identity) != 64 or any(c not in '0123456789abcdef' for c in identity):
            raise ValueError('Invalid review source hash')
    export_raw = (STATE / 'exports' / f'{export_key}.json').read_bytes()
    decisions_raw = (STATE / 'review-decisions' / f'{decision_key}.json').read_bytes()
    if digest(export_raw) != export_key or digest(decisions_raw) != decision_key:
        raise ValueError('Review source changed')
    source = json.loads(export_raw); original = load_snapshot(source['snapshot_sha256'])
    if source['annotation_provenance'] != 'engineer_review_pending' or original['annotation_provenance'] != 'engineer_review_pending':
        raise ValueError('Workflow-test labels cannot enter training')
    expected = copy.deepcopy(source)
    expected['annotation_provenance'] = 'engineer_reviewed'; expected['training_eligible'] = True
    decisions = json.loads(decisions_raw)
    approved = {(d['source_id'], d['sha256']): d['grade'] for d in decisions}
    originals = {(i['source_id'],i['sha256']):i for i in original['items']}
    if len(approved) != len(decisions) or set(approved) != set(originals) or len(source['items']) != len(originals):
        raise ValueError('Review decisions differ from original candidate snapshot')
    seen = set()
    for item in expected['items']:
        identity = (item['source_id'],item['sha256']); candidate = originals.get(identity)
        grade = approved.get(identity)
        if identity in seen or not candidate or item.get('image') != candidate['image'] or item.get('inspections') != candidate['inspections']:
            raise ValueError('Reviewed source identity changed')
        seen.add(identity)
        if item['annotation_provenance'] != 'engineer_review_pending' or type(grade) is not int or grade not in range(1,6) or {a['grade'] for a in item['training_annotations']} != {grade}:
            raise ValueError('Invalid reviewed annotation')
        item['annotation_provenance'] = 'engineer_reviewed'; item['training_eligible'] = True
    expected['review'] = review
    if expected != value:
        raise ValueError('Reviewed artifact differs from bound source and decisions')
    return value

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('prepare'); p.add_argument('--manifest', required=True); p.add_argument('--purpose', choices=['workflow_test','engineer_review_pending'], default='workflow_test')
    for name in ['import', 'export']:
        p = sub.add_parser(name); p.add_argument('--snapshot', required=True)
    p = sub.add_parser('review'); p.add_argument('--export-sha256', required=True); p.add_argument('--decisions', required=True); p.add_argument('--reviewer', required=True); p.add_argument('--reason', required=True)
    args = parser.parse_args()
    if args.command == 'prepare': print(prepare(args.manifest, purpose=args.purpose))
    elif args.command == 'import': print(import_project(args.snapshot))
    elif args.command == 'export': print(export_project(args.snapshot))
    else: print(review_export(args.export_sha256, args.decisions, args.reviewer, args.reason))

if __name__ == '__main__': main()

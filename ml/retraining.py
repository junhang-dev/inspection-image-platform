"""Local snapshot → explicit approval → train/validation-only candidate registry.

No HTTP endpoint, no test execution, and no deployment/model replacement operation.
"""
from __future__ import annotations
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / 'ml/artifacts/retraining.local'
CONFIG = {'method': 'frozen_backbone_logistic_head', 'C': 0.1, 'class_weight': 'balanced',
          'max_iter': 2000, 'seed': 42, 'device': 'cpu', 'threads': 2}

def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()

def sha(data): return hashlib.sha256(data).hexdigest()
def now(): return datetime.now(timezone.utc).isoformat()
def write_new(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as f: f.write(encode(value))

def verified_dataset(manifest_path, labels_path=None):
    from ml.train import validate_manifest
    raw = Path(manifest_path).read_bytes()
    # Bind to the previously frozen split, not a caller-supplied re-split.
    freeze = json.loads((ROOT / 'ml/artifacts/final-freeze.local.json').read_text())
    if sha(raw) != freeze['manifest_sha256']:
        raise ValueError('Manifest differs from the original frozen split')
    manifest = json.loads(raw); validate_manifest(manifest)
    entries = [dict(e) for e in manifest['entries'] if e['included'] and e['split'] in {'train', 'validation'}]
    by_hash = {e['sha256']: e for e in entries}
    if len(by_hash) != 289:
        raise ValueError('Duplicate image bytes in train/validation')
    label_hash = None
    if labels_path:
        from labeling.bridge import load_reviewed
        label_raw = Path(labels_path).read_bytes(); labels = load_reviewed(labels_path)
        if labels.get('annotation_provenance') != 'engineer_reviewed' or labels.get('training_eligible') is not True:
            raise ValueError('Workflow-test or unreviewed annotations cannot enter training')
        label_hash = sha(label_raw)
        seen = set()
        for item in labels['items']:
            entry = by_hash.get(item['sha256'])
            if not entry or entry['split'] != 'train' or entry['id'] != item['source_id'] or item['sha256'] in seen:
                raise ValueError('New/test/validation/duplicate label rejected')
            seen.add(item['sha256'])
            if item.get('annotation_provenance') != 'engineer_reviewed' or item.get('training_eligible') is not True:
                raise ValueError('Every label needs reviewed provenance')
            grades = {a['grade'] for a in item['training_annotations']}
            if len(grades) != 1 or type(next(iter(grades))) is not int or next(iter(grades)) not in range(1, 6):
                raise ValueError('Missing/conflicting/invalid labels')
            entry['original_grade'] = entry['grade']; entry['grade'] = grades.pop()
            entry['label_provenance'] = item
    return raw, manifest, entries, label_hash

def preview(manifest_path, initial, labels_path=None):
    raw, manifest, entries, label_hash = verified_dataset(manifest_path, labels_path)
    contract = json.loads((ROOT / 'ml/model-contract.json').read_text())
    initial = Path(initial).resolve()
    if sha(initial.read_bytes()) != contract['checkpoint_sha256']:
        raise ValueError('Initial model differs from the frozen checkpoint')
    snapshot = {'schema': 1, 'created_at': now(), 'manifest_sha256': sha(raw),
        'manifest_path': str(Path(manifest_path).resolve()), 'labels_path': str(Path(labels_path).resolve()) if labels_path else None,
        'source_root': manifest['source_root'], 'entries': entries, 'labels_sha256': label_hash,
        'initial_checkpoint': str(initial), 'initial_sha256': contract['checkpoint_sha256'],
        'config': CONFIG, 'config_sha256': sha(encode(CONFIG)),
        'counts': dict(Counter(e['split'] for e in entries)),
        'new_samples': 0, 'test_included': False, 'service_replacement': False}
    key = sha(encode(snapshot)); write_new(STATE / 'snapshots' / f'{key}.json', snapshot)
    return {'snapshot_sha256': key, 'config_sha256': snapshot['config_sha256'], 'counts': snapshot['counts'],
        'new_samples': 0, 'test_included': False, 'config': CONFIG}

def snapshot(key):
    if len(key) != 64 or any(c not in '0123456789abcdef' for c in key):
        raise ValueError('Invalid snapshot hash')
    raw = (STATE / 'snapshots' / f'{key}.json').read_bytes()
    if sha(raw) != key: raise ValueError('Snapshot changed after preview')
    value = json.loads(raw)
    if value['config'] != CONFIG or value['config_sha256'] != sha(encode(CONFIG)):
        raise ValueError('Training configuration changed')
    if value['test_included'] or value['service_replacement'] or value['new_samples'] != 0:
        raise ValueError('Unsupported data/deployment scope')
    counts = Counter(e['split'] for e in value['entries'])
    if counts != {'train': 231, 'validation': 58} or len({e['sha256'] for e in value['entries']}) != 289:
        raise ValueError('Invalid train/validation dataset')
    raw, manifest, expected_entries, labels_hash = verified_dataset(value['manifest_path'], value['labels_path'])
    contract = json.loads((ROOT / 'ml/model-contract.json').read_text())
    if (value['manifest_sha256'] != sha(raw) or value['source_root'] != manifest['source_root']
            or value['entries'] != expected_entries or value['labels_sha256'] != labels_hash
            or value['initial_sha256'] != contract['checkpoint_sha256']
            or sha(Path(value['initial_checkpoint']).read_bytes()) != contract['checkpoint_sha256']):
        raise ValueError('Snapshot differs from frozen sources or reviewed labels')
    return value

def approve(key, config_hash, actor, reason):
    value = snapshot(key)
    if config_hash != value['config_sha256'] or not actor.strip() or not reason.strip():
        raise ValueError('Exact configuration hash, local operator and reason are required')
    write_new(STATE / 'approvals' / f'{key}.json', {'snapshot_sha256': key, 'config_sha256': config_hash,
        'approved_by': actor, 'reason': reason, 'approved_at': now(), 'scope': 'one_local_candidate_run'})
    return {'approved_snapshot': key, 'scope': 'one_local_candidate_run'}

def execute(key):
    value = snapshot(key)
    approval = json.loads((STATE / 'approvals' / f'{key}.json').read_text())
    if approval['snapshot_sha256'] != key or approval['config_sha256'] != value['config_sha256']:
        raise ValueError('Approval does not bind this snapshot/configuration')
    # Atomic reservation prevents double execution with one approval.
    run_id = str(uuid.uuid4()); out = STATE / 'runs' / run_id
    write_new(STATE / 'consumed' / f'{key}.json', {'run_id': run_id, 'started_at': now()})
    write_new(out / 'started.json', {'run_id': run_id, 'snapshot_sha256': key, 'started_at': now()})
    try:
        result = train_candidate(value, out)
        write_new(STATE / 'candidates' / f'{run_id}.json', {**result, 'run_id': run_id,
            'snapshot_sha256': key, 'status': 'candidate_only', 'final_test': 'not_evaluated',
            'serving_model_replaced': False})
        write_new(out / 'completed.json', result)
        return {'run_id': run_id, 'status': 'completed', 'metrics': result['metrics'], 'final_test': 'not_evaluated'}
    except BaseException as error:
        write_new(out / 'failed.json', {'failed_at': now(), 'error_type': type(error).__name__, 'error': str(error)})
        raise

def train_candidate(value, output):
    import numpy as np
    import torch
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import accuracy_score, f1_score
    from ml.runtime import backbone, decode_image, PREPROCESSING_VERSION
    torch.set_num_threads(2); torch.manual_seed(42); np.random.seed(42)
    initial = Path(value['initial_checkpoint'])
    if sha(initial.read_bytes()) != value['initial_sha256']:
        raise ValueError('Initial checkpoint changed after approval')
    artifact = torch.load(initial, map_location='cpu', weights_only=True)
    if artifact['preprocessing_version'] != PREPROCESSING_VERSION: raise ValueError('Preprocessing changed')
    model = backbone(); model.load_state_dict(artifact['backbone']); model.eval()
    root = Path(value['source_root']).resolve()
    features, grades, splits = [], [], []
    # Only the 289 snapshot entries exist here: fixed test entries are never exported.
    for offset in range(0, len(value['entries']), 8):
        images = []
        for entry in value['entries'][offset:offset + 8]:
            path = (root / entry['relative_path']).resolve()
            if not path.is_relative_to(root): raise ValueError('Image path escaped source root')
            data = path.read_bytes()
            if sha(data) != entry['sha256']: raise ValueError('Original bytes changed after approval')
            images.append(decode_image(data)); grades.append(entry['grade']); splits.append(entry['split'])
        with torch.inference_mode(): features.append(model(torch.stack(images)).numpy())
        print(json.dumps({'feature_count': min(offset + 8, 289), 'total': 289}), flush=True)
    x = np.concatenate(features); y = np.array(grades); train = np.array(splits) == 'train'
    classifier = LogisticRegression(C=CONFIG['C'], class_weight=CONFIG['class_weight'],
        max_iter=CONFIG['max_iter'], random_state=CONFIG['seed'])
    classifier.fit(x[train], y[train])
    if list(classifier.classes_) != [1, 2, 3, 4, 5]: raise ValueError('All five classes are required')
    version = 'mobilenetv3small-candidate-' + output.name
    checkpoint = {'backbone': artifact['backbone'], 'coef': torch.tensor(classifier.coef_, dtype=torch.float32),
        'intercept': torch.tensor(classifier.intercept_, dtype=torch.float32), 'model_version': version,
        'preprocessing_version': PREPROCESSING_VERSION}
    with (output / 'model.pt').open('xb') as f: torch.save(checkpoint, f)
    # Evaluate the actual serialized float32 runtime, not sklearn's float64 surrogate.
    from ml.runtime import Predictor
    predictor = Predictor(output / 'model.pt')
    with torch.inference_mode():
        predicted = (torch.tensor(x) @ predictor.coef.T + predictor.intercept).argmax(1).numpy() + 1
    metrics = {}
    for split, mask in [('train', train), ('validation', ~train)]:
        metrics[split] = {'count': int(mask.sum()), 'accuracy': float(accuracy_score(y[mask], predicted[mask])),
            'macro_f1': float(f1_score(y[mask], predicted[mask], labels=[1,2,3,4,5], average='macro', zero_division=0))}
    if sha(initial.read_bytes()) != value['initial_sha256']: raise ValueError('Protected serving checkpoint changed')
    return {'completed_at': now(), 'model_version': version, 'checkpoint_sha256': sha((output / 'model.pt').read_bytes()),
        'preprocessing_version': PREPROCESSING_VERSION, 'metrics': metrics, 'test_opened': False,
        'labels_sha256': value['labels_sha256']}

def history():
    return [{'run_id': p.name, 'status': 'failed' if (p/'failed.json').exists() else 'completed' if (p/'completed.json').exists() else 'running_or_interrupted'} for p in (STATE/'runs').glob('*')]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('preview'); p.add_argument('--manifest', required=True); p.add_argument('--initial', required=True); p.add_argument('--labels')
    p = sub.add_parser('approve'); p.add_argument('--snapshot', required=True); p.add_argument('--config-sha256', required=True); p.add_argument('--actor', required=True); p.add_argument('--reason', required=True)
    p = sub.add_parser('run'); p.add_argument('--snapshot', required=True)
    sub.add_parser('history')
    a = parser.parse_args()
    if a.command == 'preview': result = preview(a.manifest, a.initial, a.labels)
    elif a.command == 'approve': result = approve(a.snapshot, a.config_sha256, a.actor, a.reason)
    elif a.command == 'run': result = execute(a.snapshot)
    else: result = history()
    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__': main()

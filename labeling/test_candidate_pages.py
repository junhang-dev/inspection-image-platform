"""Fake HTTP page payloads only; no product, Label Studio, or original data IO."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.parse
import uuid

from labeling import bridge


def row(number, purpose='inspection'):
    return {'id': str(uuid.UUID(int=number)), 'recordPurpose': purpose,
            'visibility': 'visible', 'labeling': True, 'sha256': 'a' * 64}


class FakePages:
    def __init__(self, rows, alter=None):
        self.rows, self.alter, self.calls = rows, alter, []

    def request(self, path, **kwargs):
        self.calls.append(path)
        parsed = urllib.parse.urlsplit(path)
        if parsed.path != '/api/inspections/query':
            raise AssertionError('Unexpected image or legacy endpoint access')
        scope = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
        for key in ['page', 'pageSize']:
            scope[key] = int(scope[key])
        page, size = scope['page'], scope['pageSize']
        total = len(self.rows)
        result = {'items': copy.deepcopy(self.rows[(page-1)*size:page*size]),
                  'total': total, 'page': page, 'pages': max(1, (total+size-1)//size),
                  'pageSize': size, 'scope': scope, 'summary': {'total': total}, 'pointCounts': {}}
        if self.alter:
            self.alter(result, page)
        return result


class CandidatePagesTests(unittest.TestCase):
    def test_all_pages_and_explicit_scope_include_legacy_workflow_purpose(self):
        rows = [row(i, ['inspection', 'verification', 'presentation'][i % 3]) for i in range(1, 102)]
        client = FakePages(rows)
        result, proof = bridge.candidate_pages(client, 'workflow_test')
        self.assertEqual(result, rows)
        self.assertEqual((len(client.calls), proof['total'], proof['unique_uuid_count']), (2, 101, 101))
        self.assertEqual(proof['allowed_record_purposes'], ['inspection', 'presentation', 'verification'])
        for path in client.calls:
            params = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(path).query))
            self.assertEqual((params['recordPurpose'], params['visibility'], params['labeling']), ('all', 'visible', 'true'))

    def test_empty_and_exact_page_boundary(self):
        for size in [0, 2, 4, 5]:
            client = FakePages([row(i) for i in range(1, size+1)])
            result, proof = bridge.candidate_pages(client, 'engineer_review_pending', page_size=2)
            self.assertEqual(len(result), size)
            self.assertEqual(proof['filters']['recordPurpose'], 'inspection')
            self.assertEqual(len(client.calls), max(1, (size+1)//2))

    def test_page_contract_errors_never_return_partial_result(self):
        cases = {
            'total grows': lambda r: r.update(total=6),
            'total shrinks': lambda r: r.update(total=4),
            'pages changes': lambda r: r.update(pages=4),
            'page clamps': lambda r: r.update(page=1),
            'size changes': lambda r: r.update(pageSize=1),
            'empty middle': lambda r: r.update(items=[]),
            'short middle': lambda r: r.update(items=r['items'][:1]),
            'too many rows': lambda r: r['items'].append(row(99)),
            'duplicate across pages': lambda r: r['items'][0].update(id=row(1)['id']),
            'stalled page': lambda r: r.update(items=[row(1), row(2)]),
            'scope drops labeling': lambda r: r['scope'].update(labeling='all'),
            'scope changes purpose': lambda r: r['scope'].update(recordPurpose='inspection'),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name):
                client = FakePages([row(i) for i in range(1, 6)], lambda r, p: mutate(r) if p == 2 else None)
                with self.assertRaisesRegex(bridge.CandidateQueryError, 'retry prepare'):
                    bridge.candidate_pages(client, 'workflow_test', page_size=2)
                self.assertEqual(len(client.calls), 2)

    def test_invalid_metadata_rows_and_uuid_aliases(self):
        cases = [lambda r: r.update(total=-1), lambda r: r.update(total=True),
                 lambda r: r.update(total='2'), lambda r: r.update(pages=0),
                 lambda r: r.update(page=True), lambda r: r.update(scope=[]),
                 lambda r: r.update(items={}), lambda r: r['items'].__setitem__(0, None),
                 lambda r: r['items'][0].update(id='not-a-uuid'),
                 lambda r: r['items'][0].update(id=None),
                 lambda r: r['items'][1].update(id='{'+r['items'][0]['id']+'}')]
        for alter in cases:
            with self.subTest(alter=alter):
                client = FakePages([row(1), row(2)], lambda r, p: alter(r))
                with self.assertRaises(bridge.CandidateQueryError):
                    bridge.candidate_pages(client, 'workflow_test', page_size=2)
        with self.assertRaises(bridge.CandidateQueryError):
            bridge.candidate_pages(type('Legacy', (), {'request': lambda self, path: []})(), 'workflow_test')

    def test_scope_violation_is_rejected_for_both_modes(self):
        for purpose in ['workflow_test', 'engineer_review_pending']:
            invalid = [{'visibility': 'hidden'}, {'labeling': False}, {'labeling': 'true'},
                       {'recordPurpose': 'unknown'}, {'visibility': None}, {'recordPurpose': None},
                       {'recordPurpose': ['inspection']}]
            if purpose == 'engineer_review_pending':
                invalid += [{'recordPurpose': 'verification'}, {'recordPurpose': 'presentation'}]
            for change in invalid:
                with self.subTest(purpose=purpose, change=change):
                    candidate = {**row(1), **change}
                    with self.assertRaises(bridge.CandidateQueryError):
                        bridge.candidate_pages(FakePages([candidate]), purpose)

    def test_bad_purpose_and_page_size_fail_before_http(self):
        client = FakePages([])
        for purpose, size in [('unknown', 100), ('workflow_test', True), ('workflow_test', 0), ('workflow_test', 101)]:
            with self.assertRaises(ValueError):
                bridge.candidate_pages(client, purpose, size)
        self.assertEqual(client.calls, [])

    def test_prepare_checks_complete_pages_before_images_and_preserves_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root/'state'
            (root/'ml/artifacts').mkdir(parents=True)
            payload = b'synthetic-approved-payload'
            sha = bridge.digest(payload)
            entries = []
            for split, count in [('train', 231), ('validation', 58), ('test', 10)]:
                for index in range(count):
                    entries.append({'id': f'{split}-{index}', 'included': True, 'split': split,
                                    'sha256': bridge.digest(f'{split}-{index}'.encode())})
            entries[0]['sha256'] = sha
            manifest = root/'manifest.json'
            manifest.write_text(json.dumps({'entries': entries}))
            (root/'ml/artifacts/final-freeze.local.json').write_text(json.dumps({'manifest_sha256': bridge.digest(manifest.read_bytes())}))

            class Client(FakePages):
                def request(self, path, **kwargs):
                    if path.endswith('/image'):
                        self.calls.append(path)
                        self_outer.assertTrue(kwargs.get('raw'))
                        return payload
                    return super().request(path, **kwargs)

            self_outer = self
            candidates = [row(i) for i in range(1, 102)]
            for candidate in candidates:
                candidate['sha256'] = 'b' * 64
            candidates[0]['sha256'] = sha
            client = Client(candidates, lambda r, p: r.update(items=[]) if p == 2 else None)
            with patch.object(bridge, 'ROOT', root), patch.object(bridge, 'STATE', state), \
                    patch.object(bridge, 'approved_demo_hashes', return_value={sha}), \
                    patch.object(bridge, 'Client', return_value=client):
                with self.assertRaises(bridge.CandidateQueryError):
                    bridge.prepare(manifest)
                self.assertFalse(state.exists())
                self.assertEqual(len(client.calls), 2)
                client.alter = None
                client.calls.clear()
                key = bridge.prepare(manifest)
                snapshot = bridge.load_snapshot(key)
                self.assertFalse(snapshot['training_eligible'])
                self.assertEqual(snapshot['annotation_provenance'], 'workflow_test')
                self.assertEqual(snapshot['candidate_query']['unique_uuid_count'], 101)
                self.assertEqual(snapshot['items'][0]['split'], 'train')
                self.assertEqual(snapshot['items'][0]['source_id'], 'train-0')
                self.assertEqual(snapshot['items'][0]['inspections'][0]['record_purpose'], 'inspection')
                self.assertEqual(sum(path.endswith('/image') for path in client.calls), 1)
                # Even an allowlisted hash cannot cross the frozen train boundary.
                validation_sha = next(e['sha256'] for e in entries if e['split'] == 'validation')
                test_sha = next(e['sha256'] for e in entries if e['split'] == 'test')
                for forbidden in [validation_sha, test_sha]:
                    client.rows = [{**row(1), 'sha256': forbidden}]
                    client.calls.clear()
                    with patch.object(bridge, 'approved_demo_hashes', return_value={forbidden}):
                        with self.assertRaisesRegex(ValueError, 'original train split'):
                            bridge.prepare(manifest)
                    self.assertEqual(sum(path.endswith('/image') for path in client.calls), 0)


if __name__ == '__main__':
    unittest.main()

import copy
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
from labeling import bridge

class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name) / 'demo'
        shutil.copytree(bridge.ROOT / 'image/demo', self.directory)

    def test_exact_demo_allowlist(self):
        self.assertEqual(len(bridge.approved_demo_hashes(self.directory)), 5)
        (self.directory / 'extra.jpg').write_bytes(b'not approved')
        with self.assertRaisesRegex(ValueError, 'five approved'): bridge.approved_demo_hashes(self.directory)

    def test_changed_bytes_rejected(self):
        (self.directory / 'demo-01.jpg').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'bytes changed'): bridge.approved_demo_hashes(self.directory)

    def test_symlink_rejected(self):
        p = self.directory / 'demo-01.jpg'; p.unlink(); p.symlink_to(bridge.ROOT / 'image/demo/demo-01.jpg')
        with self.assertRaisesRegex(ValueError, 'symlink'): bridge.approved_demo_hashes(self.directory)

    def test_nonlocal_origin_rejected(self):
        for url in ['https://example.com', 'http://127.0.0.1@evil.test', 'http://localhost/elsewhere']:
            with self.assertRaises(ValueError): bridge.Client(url)

    def test_export_identity_and_conflict(self):
        item = {'sha256':'a'*64, 'source_id':'IMG-X', 'image':'/data/local-files/?d=approved/x.img'}
        annotation = {'id':1, 'result':[{'from_name':'grade','to_name':'image','type':'choices','value':{'choices':['3']}}]}
        task = {'id':1,'data':{**item,'snapshot_sha256':'k'},'annotations':[annotation]}
        good = bridge.validate_export({'items':[item],'annotation_provenance':'workflow_test'}, [task], 'k')
        self.assertFalse(good[0]['training_eligible'])
        self.assertEqual(good[0]['training_annotations'][0]['grade'], 3)
        bad = copy.deepcopy(task); bad['data']['sha256']='b'*64
        with self.assertRaises(ValueError): bridge.validate_export({'items':[item],'annotation_provenance':'workflow_test'}, [bad], 'k')
        bad = copy.deepcopy(task); extra = copy.deepcopy(annotation); extra['result'][0]['value']['choices']=['4']; bad['annotations'].append(extra)
        with self.assertRaisesRegex(ValueError, 'Conflicting'): bridge.validate_export({'items':[item],'annotation_provenance':'workflow_test'}, [bad], 'k')
        with self.assertRaises(ValueError): bridge.validate_export({'items':[item],'annotation_provenance':'workflow_test'}, [task,task], 'k')

    def test_workflow_labels_cannot_be_promoted(self):
        state = Path(self.tmp.name) / 'state'
        export = {'annotation_provenance':'workflow_test', 'items':[]}
        key = bridge.digest(bridge.encoded(export))
        bridge.save_new(state / 'exports' / f'{key}.json', export)
        with patch.object(bridge, 'STATE', state):
            with self.assertRaisesRegex(ValueError, 'never be promoted'):
                bridge.review_export(key, 'not-opened.json', 'reviewer', 'reason')

    def test_explicit_review_binds_export_and_decisions(self):
        state = Path(self.tmp.name) / 'state'
        item = {'source_id':'IMG-X', 'sha256':'a'*64, 'image':'/data/local-files/?d=approved/a.img', 'inspections':[], 'annotation_provenance':'engineer_review_pending',
                'training_annotations':[{'grade':3}], 'training_eligible':False}
        original = {'annotation_provenance':'engineer_review_pending','items':[{'source_id':item['source_id'],'sha256':item['sha256'],'image':item['image'],'inspections':[]}]}
        snapshot_key = bridge.digest(bridge.encoded(original)); bridge.save_new(state/'snapshots'/f'{snapshot_key}.json',original)
        export = {'annotation_provenance':'engineer_review_pending', 'snapshot_sha256':snapshot_key, 'items':[item]}
        key = bridge.digest(bridge.encoded(export)); bridge.save_new(state / 'exports' / f'{key}.json', export)
        decisions = state / 'decisions.json'; decisions.write_text(json.dumps([{'source_id':'IMG-X','sha256':'a'*64,'grade':3}]))
        with patch.object(bridge, 'STATE', state):
            reviewed_key = bridge.review_export(key, decisions, 'synthetic unit reviewer', 'isolated unit test')
            loaded=bridge.load_reviewed(state/'reviewed'/f'{reviewed_key}.json')
            self.assertTrue(loaded['training_eligible'])
        value=json.loads((state / 'reviewed' / f'{reviewed_key}.json').read_text())
        self.assertTrue(value['training_eligible']); self.assertEqual(value['review']['source_export_sha256'], key)

    def test_wrong_manifest_fails_before_backend_access(self):
        root=Path(self.tmp.name)/'root'; (root/'ml/artifacts').mkdir(parents=True)
        (root/'ml/artifacts/final-freeze.local.json').write_text(json.dumps({'manifest_sha256':'expected'}))
        manifest=root/'wrong.json'; manifest.write_text('{}')
        with patch.object(bridge,'ROOT',root), patch.object(bridge,'Client') as client:
            with self.assertRaisesRegex(ValueError,'original frozen split'): bridge.prepare(manifest)
            client.assert_not_called()

    def test_edited_provenance_flags_do_not_bypass_review(self):
        state=Path(self.tmp.name)/'state'
        forged={'annotation_provenance':'engineer_reviewed','training_eligible':True,'items':[]}
        key=bridge.digest(bridge.encoded(forged)); path=state/'reviewed'/f'{key}.json'
        bridge.save_new(path, forged)
        with patch.object(bridge,'STATE',state):
            with self.assertRaisesRegex(ValueError,'review record'): bridge.load_reviewed(path)

if __name__ == '__main__': unittest.main()

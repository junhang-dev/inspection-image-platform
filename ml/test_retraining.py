import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from ml import retraining as r

class ManagementTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)
        self.patch = patch.object(r, 'STATE', self.state); self.patch.start(); self.addCleanup(self.patch.stop)
        root=self.state/'root'; (root/'ml/artifacts').mkdir(parents=True)
        original={'source_root':str(root/'images'), 'entries':[{'id':str(i),'sha256':f'{i:064x}', 'grade':i%5+1,
            'included':True,'group':str(i),'relative_path':f'{i}.jpg','split':'train' if i<231 else 'validation' if i<289 else 'test'} for i in range(299)]}
        manifest=root/'split.local.json'; manifest.write_bytes(r.encode(original)); manifest_hash=r.sha(manifest.read_bytes())
        (root/'ml/artifacts/final-freeze.local.json').write_text(json.dumps({'manifest_sha256':manifest_hash}))
        checkpoint=root/'initial.pt'; checkpoint.write_bytes(b'synthetic checkpoint'); checkpoint_hash=r.sha(checkpoint.read_bytes())
        (root/'ml/model-contract.json').write_text(json.dumps({'checkpoint_sha256':checkpoint_hash}))
        self.root_patch=patch.object(r,'ROOT',root);self.root_patch.start();self.addCleanup(self.root_patch.stop)
        self.value = {'config':r.CONFIG, 'config_sha256':r.sha(r.encode(r.CONFIG)), 'test_included':False,
            'service_replacement':False,'new_samples':0, 'manifest_path':str(manifest),'labels_path':None,
            'manifest_sha256':manifest_hash,'source_root':original['source_root'], 'labels_sha256':None,
            'initial_checkpoint':str(checkpoint),'initial_sha256':checkpoint_hash,'entries':original['entries'][:289]}
        self.key = r.sha(r.encode(self.value)); r.write_new(self.state/'snapshots'/f'{self.key}.json', self.value)

    def approve(self): r.approve(self.key,self.value['config_sha256'],'test operator','isolated unit check')

    def test_approval_required_and_configuration_bound(self):
        with self.assertRaises(FileNotFoundError): r.execute(self.key)
        with self.assertRaises(ValueError): r.approve(self.key,'bad','test','reason')
        self.approve()
        p=self.state/'snapshots'/f'{self.key}.json'; p.write_text('{}')
        with self.assertRaisesRegex(ValueError,'Snapshot changed'): r.execute(self.key)

    def test_one_execution_and_candidate_only(self):
        self.approve()
        with patch.object(r,'train_candidate',return_value={'metrics':{'validation':{'accuracy':0.5}}}) as train:
            result=r.execute(self.key)
            self.assertEqual(result['status'],'completed'); self.assertEqual(train.call_count,1)
            with self.assertRaises(FileExistsError): r.execute(self.key)
            self.assertEqual(train.call_count,1)
        candidate=json.loads(next((self.state/'candidates').glob('*.json')).read_text())
        self.assertFalse(candidate['serving_model_replaced']); self.assertEqual(candidate['final_test'],'not_evaluated')

    def test_failed_run_recorded_and_approval_consumed(self):
        self.approve()
        with patch.object(r,'train_candidate',side_effect=ValueError('injected failure')):
            with self.assertRaises(ValueError): r.execute(self.key)
        failures=list((self.state/'runs').glob('*/failed.json')); self.assertEqual(len(failures),1)
        self.assertIn('injected failure',failures[0].read_text())
        with self.assertRaises(FileExistsError): r.execute(self.key)

    def test_test_entries_rejected(self):
        self.value['entries'][0]['split']='test'; key=r.sha(r.encode(self.value))
        r.write_new(self.state/'snapshots'/f'{key}.json',self.value)
        with self.assertRaises(ValueError): r.snapshot(key)

    def test_rehashed_snapshot_cannot_relabel_test_or_change_grade(self):
        # Count/hash uniqueness remains valid, so only frozen-source comparison catches it.
        self.value['entries'][0].update(id='289',sha256=f'{289:064x}',relative_path='289.jpg')
        key=r.sha(r.encode(self.value)); r.write_new(self.state/'snapshots'/f'{key}.json',self.value)
        with self.assertRaisesRegex(ValueError,'frozen sources'): r.approve(key,self.value['config_sha256'],'test','reason')
        self.value['entries'][0].update(id='0',sha256=f'{0:064x}',relative_path='0.jpg',grade=5)
        key=r.sha(r.encode(self.value)); r.write_new(self.state/'snapshots'/f'{key}.json',self.value)
        with self.assertRaisesRegex(ValueError,'frozen sources'): r.snapshot(key)

    def test_registry_failure_is_never_reported_completed(self):
        self.approve(); original_write=r.write_new
        def fail_registry(path, value):
            if path.parent == self.state/'candidates': raise OSError('registry unavailable')
            return original_write(path,value)
        with patch.object(r,'train_candidate',return_value={'metrics':{}}), patch.object(r,'write_new',side_effect=fail_registry):
            with self.assertRaises(OSError): r.execute(self.key)
        self.assertEqual(r.history()[0]['status'],'failed')
        self.assertEqual(list((self.state/'runs').glob('*/completed.json')),[])
        # Failure has priority even if an older/mixed record contains completion.
        run=next((self.state/'runs').iterdir()); (run/'completed.json').write_text('{}')
        self.assertEqual(r.history()[0]['status'],'failed')

    def test_rehashed_source_root_and_initial_hash_rejected(self):
        for field,new_value in [('source_root','/wrong'),('initial_sha256','0'*64)]:
            forged={**self.value,field:new_value}; key=r.sha(r.encode(forged))
            r.write_new(self.state/'snapshots'/f'{key}.json',forged)
            with self.assertRaisesRegex(ValueError,'frozen sources'): r.snapshot(key)

if __name__ == '__main__': unittest.main()

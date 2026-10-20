"""Batch render all 17 new products × 3 views = 51 images.
Runs 4 Blender instances in parallel to finish ~20min instead of 80min serial.
"""
import subprocess, pathlib, sys
from pathlib import Path

ROOT = pathlib.Path('/Users/andrewsilva/Documents/ComfortPeptideResearch')
SLUGS = [
    'reta', 'tirz', 'semax', 'selank', 'klow', 'ipamorelin', 'tesamorelin',
    'mots-c', 'nad-plus', 'kpv', 'epithalon', 'thymosin-alpha-1',
    'cjc-1295-ipamorelin', 'bac-water'
]
VIEWS = ['overview', 'detail', 'angle']
PARALLEL = 4

jobs = [(s, v) for s in SLUGS for v in VIEWS]
failed = []
completed = 0
running = []
blender = '/Volumes/Blender/Blender.app/Contents/MacOS/Blender'
render_script = str(ROOT / 'tools/catalog-art/render.py')
logdir = ROOT / '.hermes/cache/scratch/render-logs'
logdir.mkdir(parents=True, exist_ok=True)

for i, (slug, view) in enumerate(jobs):
    if i % PARALLEL == 0 and running:
        # Wait for next batch to finish
        results = []
        for proc in running:
            ret = proc.wait()
            results.append((proc, ret))
        for proc, ret in results:
            if ret != 0:
                fname = Path(proc.stdout.name).name
                failed.append(fname)
            else:
                completed += 1
        running.clear()
        print(f"[{completed}/{len(jobs)}] done")
    
    log_file = logdir / f'{slug}-{view}-batch.log'
    with open(log_file, 'w') as lf:
        proc = subprocess.Popen(
            [blender, '--background', '--python', render_script, '--', slug, view, '--cpu'],
            stdout=lf, stderr=subprocess.STDOUT, cwd=str(ROOT)
        )
        running.append(proc)

# Wait for remaining
for proc in running:
    ret = proc.wait()
    fname = Path(proc.stdout.name).name
    if ret != 0:
        failed.append(fname)
    else:
        completed += 1

print(f"\n{'='*50}")
print(f"Completed: {completed}/{len(jobs)}")
if failed:
    print(f"Failed: {failed}")
    sys.exit(1)
else:
    print("ALL_BATCH_RENDER_COMPLETE")

"""Export immutable Git sources for the six-policy runtime image; no local config."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile


def git(repository, *args):
    return subprocess.check_output(['git', '-C', str(repository), *args])


def archive(repository, commit):
    data = git(repository, 'archive', '--format=tar', commit)
    embedded = subprocess.check_output(['git', 'get-tar-commit-id'], input=data).decode().strip()
    if embedded != commit:
        raise ValueError('Archive identity differs from requested commit')
    with tarfile.open(fileobj=io.BytesIO(data)) as source:
        for entry in source.getmembers():
            path = PurePosixPath(entry.name)
            if path.is_absolute() or '..' in path.parts or any(part in {'.git', 'node_modules'} for part in path.parts):
                raise ValueError('Unsafe source path: ' + entry.name)
            if path.name == '.env' or path.name.startswith('.env.') and path.name != '.env.example':
                raise ValueError('Local environment in source: ' + entry.name)
            if path.suffix in {'.pem', '.key', '.p12', '.pfx', '.dump', '.backup'} or entry.issym() or entry.islnk():
                raise ValueError('Unexpected source artifact: ' + entry.name)
    return data


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--app', type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument('--app-commit', default='HEAD')
parser.add_argument('--harness', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
app_commit = git(args.app, 'rev-parse', args.app_commit + '^{commit}').decode().strip()
lock = json.loads(git(args.app, 'show', app_commit + ':harness-runtime.lock.json'))
harness_commit = git(args.harness, 'rev-parse', lock['sourceCommit'] + '^{commit}').decode().strip()
if harness_commit != lock['sourceCommit']:
    raise ValueError('Harness source differs from host lock')
args.output.mkdir(parents=True, exist_ok=True)
archives = {}
for name, repository, commit in [('app-source.tar', args.app, app_commit), ('harness-source.tar', args.harness, harness_commit)]:
    data = archive(repository, commit)
    (args.output / name).write_bytes(data)
    archives[name] = hashlib.sha256(data).hexdigest()
provenance = {
    'app': {'sourceCommit': app_commit, 'sourceTree': git(args.app, 'rev-parse', app_commit + '^{tree}').decode().strip(), 'workingTreeChanges': False},
    'harness': {'sourceCommit': harness_commit, 'sourceTree': git(args.harness, 'rev-parse', harness_commit + '^{tree}').decode().strip(), 'appSourceHash': lock['appSourceHash']},
    'archives': archives,
}
(args.output / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
(args.output / 'source-archives.sha256').write_text(''.join(f'{digest}  {name}\n' for name, digest in archives.items()))
for name in ['Dockerfile.runtime', 'build-runtime.mjs']:
    shutil.copyfile(Path(__file__).with_name(name), args.output / name)
print(json.dumps(provenance, indent=2))

"""Install the private Mac admin as a per-user launch agent. No public port."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
STATE = Path.home() / 'Library/Application Support/VICTIG TAT Map'
LABEL = 'com.victig.tat-map-admin'
PLIST = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
DOMAIN = f'gui/{os.getuid()}'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stop', action='store_true')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        raise SystemExit('This installer is for macOS.')
    if args.stop:
        subprocess.run(['launchctl', 'bootout', f'{DOMAIN}/{LABEL}'], check=True)
        print('Local admin stopped. Public map is unchanged.')
        return
    python = STATE / 'venv/bin/python'
    node = shutil.which('node')
    if not python.exists() or not node or not (ROOT / 'node_modules/@netlify/blobs').exists():
        raise SystemExit('Install the local Python requirements and run npm ci first.')
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    STATE.chmod(0o700)
    logs = STATE / 'logs'
    logs.mkdir(exist_ok=True, mode=0o700)
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    config = {
        'Label': LABEL,
        'ProgramArguments': [str(python), '-m', 'uvicorn', 'local_admin.server:app',
            '--host', '127.0.0.1', '--port', '8766', '--no-access-log', '--log-level', 'warning'],
        'WorkingDirectory': str(ROOT),
        'EnvironmentVariables': {'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
            'VICTIG_LOCAL_HOME': str(STATE), 'VICTIG_LOCAL_NODE': node,
            'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUNBUFFERED': '1'},
        'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10,
        'ProcessType': 'Background', 'Umask': 0o077,
        'StandardOutPath': str(logs / 'server.log'), 'StandardErrorPath': str(logs / 'error.log'),
    }
    loaded = subprocess.run(['launchctl', 'print', f'{DOMAIN}/{LABEL}'], capture_output=True)
    if loaded.returncode == 0:
        subprocess.run(['launchctl', 'bootout', f'{DOMAIN}/{LABEL}'], check=True)
    PLIST.write_bytes(plistlib.dumps(config))
    PLIST.chmod(0o600)
    subprocess.run(['launchctl', 'bootstrap', DOMAIN, str(PLIST)], check=True)
    shortcut = Path.home() / 'Applications/VICTIG Map Admin.webloc'
    shortcut.parent.mkdir(exist_ok=True)
    shortcut.write_bytes(plistlib.dumps({'URL': 'http://127.0.0.1:8766/admin'}))
    print('Mac admin: http://127.0.0.1:8766/admin')
    print('Starts at user login. Listens only on this Mac.')
    print(f'Shortcut: {shortcut}')


if __name__ == '__main__':
    main()

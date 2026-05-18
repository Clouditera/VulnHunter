# VulnHunt Production Install

## Quick start

```bash
tar -xzf vulnhunt-release-<version>.tar.gz
cd vulnhunt-release-<version>
./install.sh
./doctor.sh
```

Open `http://<server>:23000/`, activate license, bootstrap admin, then configure model credentials.

## Important files

- `.env` — deployment config generated from `.env.example`.
- `.secrets/vulnhunt-master.key` — credential encryption key. Back it up. Never regenerate it for an existing deployment.
- `.secrets/license-public.pem` — placeholder for license public key; license hardening is implemented separately.
- `images/*.tar` — offline Docker images loaded by `install.sh` when present.

## Commands

- `./install.sh` — preflight, generate config/secrets, load images, start services.
- `./doctor.sh` — check web, API, service health, Docker socket, worker images, master key.
- `./upgrade.sh` — backup config/secrets, load new images, restart, run doctor.
- `./uninstall.sh` — stop services, keep data.
- `./uninstall.sh --purge` — stop services and remove compose volumes.

## Defaults

- Web URL: `http://<host>:23000/`
- Data dir: `/opt/vulnhunt/data`
- Master key: `.secrets/vulnhunt-master.key`

## Troubleshooting

- Port occupied: change `WEB_PORT` in `.env`.
- Master key path is directory: remove the directory and rerun `install.sh`; it must be a file.
- Docker unavailable: ensure Docker daemon is running and current user can access it.
- Worker image missing: rerun install with `images/*.tar` present or build/load images manually.

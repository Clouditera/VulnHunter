# VulnHunt Production Install

## Quick start

```bash
sha256sum -c vulnhunt-release-<version>.tar.gz.sha256
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
- `checksums.sha256` — package-internal checksums. `install.sh` verifies it before loading images.

## Commands

- `./install.sh` — preflight, generate config/secrets, load images, start services.
- `./doctor.sh` — check web, API, service health, Docker socket, worker images, master key.
- `./upgrade.sh` — backup config/secrets, load new images, restart, run doctor.
- `./uninstall.sh` — stop services, keep data.
- `./uninstall.sh --purge` — stop services and remove compose volumes.

## Defaults

- Web URL: `http://<host>:23000/`
- Data dir: `/opt/vulnhunt/data`
  - This default usually requires root/sudo permission to create and write.
  - For normal-user installs, run `DATA_DIR=/home/<user>/vulnhunt-data ./install.sh` or edit `.env` before starting. `install.sh` sets `SERVICE_UID/SERVICE_GID` to the installer user so the service can read/write the data dir and secrets.
- Master key: `.secrets/vulnhunt-master.key`

## Troubleshooting

- Port occupied: change `WEB_PORT` in `.env`.
- Master key path is directory: remove the directory and rerun `install.sh`; it must be a file.
- Service cannot write `.install_id`: run `./doctor.sh` and check `SERVICE_UID/SERVICE_GID`. For normal-user installs they must match `id -u` / `id -g`; for root installs ensure data and `.secrets` are owned by `1001:1001`.
- Docker unavailable: ensure Docker daemon is running and current user can access it.
- Service cannot access Docker socket: rerun `install.sh` so `DOCKER_GID` is detected from `/var/run/docker.sock`, or set `DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)` in `.env` and restart.
- Worker image missing: rerun install with `images/*.tar` present or build/load images manually.

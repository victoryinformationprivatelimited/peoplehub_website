# Putting the Proposal Studio online

You need: a Linux server with Docker, a domain name (for example `proposals.example.com`) and about 2 GB of memory.

## 1. Point the domain at the server
Create a DNS **A record** for the address (for example `proposals.example.com`) pointing at the server's public IP. Open ports **80** and **443** in the server's firewall. Do not open any other port.

## 2. Get the code onto the server
```bash
git clone https://github.com/victoryinformationprivatelimited/peoplehub_website.git
cd peoplehub_website
git checkout main
```

## 3. Create the settings file
```bash
cp api/.env.example api/.env
nano api/.env
```
Fill in, at minimum:

| Setting | What to put |
| --- | --- |
| `DB_NAME`, `DB_USER` | any names, for example `peoplehub_pricing` and `peoplehub` |
| `DB_PASSWORD` | a long random password (`openssl rand -base64 24`) |
| `SESSION_SECRET` | a long random string (`openssl rand -hex 32`) |
| `APP_DOMAIN` | the domain only, for example `proposals.example.com` |
| `APP_BASE_URL` | the full address, for example `https://proposals.example.com` |
| `PLUNK_SECRET_KEY`, `PLUNK_FROM`, `PLUNK_FROM_NAME` | your email settings |
| `ESMS_*`, `WA_*`, `NTFY_*` | optional alert settings (leave blank to switch an alert off) |

`COOKIE_SECURE` is switched on automatically by the production compose file. Never commit `api/.env`.

## 4. Start it
The app is a ready-made image in GitHub's container registry, so nothing is built on the server. The image is private: sign in once with a GitHub token that has the `read:packages` permission (the password prompt takes the token).
```bash
docker login ghcr.io -u <github-username>
docker compose -f deploy/docker-compose.prod.yml --env-file api/.env pull
docker compose -f deploy/docker-compose.prod.yml --env-file api/.env up -d
docker compose -f deploy/docker-compose.prod.yml ps
```
The first start creates the database tables. Caddy then gets the HTTPS certificate (give it a minute).

To run a specific version instead of `latest`, add `APP_IMAGE=ghcr.io/victoryinformationprivatelimited/peoplehub-studio:<tag>` to `api/.env`. The repository is still needed on the server, for `deploy/Caddyfile` and `api/schema.sql`.

## 5. Create the first admin login
```bash
docker compose -f deploy/docker-compose.prod.yml exec api node seed-admin.js admin
docker compose -f deploy/docker-compose.prod.yml exec api cat .admin-initial-password
```
Sign in at `https://<your domain>/tool/dashboard.html`, change the password at once, then delete the file:
```bash
docker compose -f deploy/docker-compose.prod.yml exec api rm .admin-initial-password
```

## 6. Load the price list and the sales deck
- In the tool, open **Price editor**, enter the prices (and the implementation guideline) and publish.
- The sales deck is optional. Build it on a PC with `node scripts/sync-deck.js --build`, then copy the `present/` folder to the server next to `deploy/`.

## 7. Point your website at it
Change the website's **Login** link to `https://<your domain>/tool/dashboard.html`.

## Updating later
```bash
git pull
docker compose -f deploy/docker-compose.prod.yml --env-file api/.env pull
docker compose -f deploy/docker-compose.prod.yml --env-file api/.env up -d
```
(`git pull` brings the newest compose, Caddy and schema files; `pull` fetches the newest app image.)
New database tables are not added automatically to an existing database. When a release adds tables, run the new statements once:
```bash
docker compose -f deploy/docker-compose.prod.yml exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < api/schema.sql
```
(`schema.sql` is written so it can safely be run again.)

## Backups
```bash
docker compose -f deploy/docker-compose.prod.yml exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > backup-$(date +%F).sql
```
Run this daily (cron) and copy the file off the server.

## Checklist before real users
- [ ] HTTPS works and `http://` redirects to it
- [ ] `APP_BASE_URL` is the public address (emails, tracked links and alerts use it)
- [ ] The admin password was changed and `.admin-initial-password` deleted
- [ ] A test proposal email arrives and its tracked link opens from a phone
- [ ] A daily database backup is scheduled and copied off the server

# HZ Media

HZ Media is a multi-company media workspace. Super admins can create companies, invite users into those companies, and create albums for images and videos. Normal users only receive access to companies assigned to them.

## What is included

- Responsive Next.js + TypeScript dashboard
- HZ Media login UI with backend-only Keycloak Direct Access Grant and HttpOnly sessions
- Backend-only Keycloak user provisioning through the signed-in super admin session
- Live company, member, album, and R2 media flows with no sample data
- Node.js API in `server/`
- Keycloak JWT verification against the realm JWKS endpoint
- `super_admin` realm-role enforcement for company and member administration
- MongoDB/Mongoose tenant models and indexed queries
- Backend-streamed uploads to private Cloudflare R2
- Non-blocking upload queue with per-file progress and live WebSocket status updates
- Authenticated individual downloads streamed from R2 by the backend
- MIME type and file-size validation, upload rate limits, security headers, restrictive CORS, and graceful database shutdown

## Local setup

Requires Node.js 22.13 or newer, MongoDB, a Keycloak client, and a private Cloudflare R2 bucket.

```bash
npm install
cp .env.example .env
npm run dev
npm run server:dev
```

The site runs on `http://localhost:3000`; the API defaults to `http://localhost:4000`.

## Keycloak

Create a confidential realm client whose access tokens include `sub`, `email`, and `name`. Create a realm role named `super_admin` and assign it only to platform administrators. The API verifies that the token audience or authorized-party claim matches `KEYCLOAK_CLIENT_ID`.

Enable Client Authentication and Direct Access Grants for the confidential client. Put the client secret only in the backend `.env` file. No Keycloak browser redirect URI is used.

Make the `super_admin` realm role a composite role that includes the `realm-management` → `manage-users` client role, or assign `manage-users` directly to your existing super admin account. The backend uses that signed-in super admin's access token to create users. No separate Keycloak admin client is required, and the access token never reaches the browser.

Super admins first create a user with first name, last name, username, email, and password. The backend creates that identity in Keycloak and stores only profile and Keycloak ID metadata in MongoDB. Passwords are never written to MongoDB. The user can then be assigned to any number of companies.

The HZ Media UI sends the username and password only to the backend over HTTPS. The backend exchanges them with Keycloak, then discards the password. The browser receives only an HttpOnly session cookie; Keycloak access and refresh tokens stay in the encrypted MongoDB session store and are refreshed by the backend. Login is rate-limited, and browser mutations require a trusted origin and custom request header.

Keycloak calls this Direct Access Grants. It does not support identity brokering, social login, MFA challenges, registration, or required-action screens; use the redirect-based authorization-code flow if those features become necessary.

Normal users need no elevated role. Their company memberships are enforced from MongoDB on every company, album, and media request.

## Cloudflare R2 uploads

The API stores only searchable metadata in MongoDB. Every image and video byte is stored in the private R2 bucket; MongoDB never stores the binary file.

Create an R2 bucket and an R2 API token with object read/write access limited to that bucket. Add its account ID, bucket name, access key ID, and secret access key to `.env`. Keep the bucket private.

The browser sends each file only to the authenticated HZ Media API. The API validates the user, company, album, MIME type, and file size, then streams the request into R2 without holding the entire file in memory. The browser never receives an R2 hostname, credential, or signed URL. The default maximum asset size is 500 MB.

The album closes as soon as files are submitted, so the user can continue working while the progress tray stays visible. Two files upload concurrently to keep the interface responsive. Images and videos are served through a protected backend endpoint, including byte-range support for video playback. Each media card downloads its original file and extension through that same endpoint.

No R2 CORS policy is required because browsers never communicate with the bucket. Upload progress uses standard XMLHttpRequest events, live status uses WebSocket, and video delivery supports standard HTTP byte ranges for current Safari, Chrome, Edge, and Firefox.

## Checks

```bash
npm run build
npm run app:check
npm run server:check
```

## Contabo deployment with Docker

The Compose setup runs the website and API. Both services read the existing `.env` file. MongoDB, Keycloak, and R2 continue using the addresses and credentials already configured there.

After cloning the repository on the server:

```bash
cp .env.example .env
nano .env
docker compose build
docker compose up -d
docker compose ps
```

For `hzmedia.hij-azi.com`, use these values in `.env`:

```env
NEXT_PUBLIC_API_URL=https://hzmedia.hij-azi.com
WEB_ORIGINS=https://hzmedia.hij-azi.com
```

Do not add `/api` to `NEXT_PUBLIC_API_URL`; the application adds `/api` and `/auth` to the origin itself. The `MONGODB_URI` address must be reachable from inside the API container.

Install the included Nginx configuration and request the HTTPS certificate:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx-hzmedia.conf /etc/nginx/sites-available/hzmedia
sudo ln -s /etc/nginx/sites-available/hzmedia /etc/nginx/sites-enabled/hzmedia
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d hzmedia.hij-azi.com --redirect
```

The DNS `A` record for `hzmedia.hij-azi.com` must point to the Contabo server before running Certbot. The website is exposed locally on port `3001` and the API on port `4001` because ports `3000` and `4000` are already in use. Nginx sends `/api` and `/auth` to the backend, sends `/live` through the WebSocket connection, and sends everything else to the website. Its API location accepts files up to 512 MB and disables request buffering so uploads can stream through the backend into R2.

To deploy a later GitHub update:

```bash
git pull origin main
docker compose build
docker compose up -d
```

View service output with `docker compose logs -f web api`.

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
- Direct-to-Cloudflare-R2 uploads using short-lived signed URLs
- Non-blocking upload queue with per-file progress and live WebSocket status updates
- Streamed album ZIP downloads without copying media onto the API server
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

Uploads go directly from the browser to R2 using five-minute signed PUT URLs. After upload, the API verifies the object's size and media type before marking it ready. Album views receive fifteen-minute signed GET URLs, so the bucket never needs public access. The default maximum asset size is 500 MB.

The album closes as soon as files are submitted, so the user can continue working while the progress tray stays visible. Two files upload concurrently to keep the interface responsive. Album downloads are streamed from R2 into a ZIP response and are limited to the classic ZIP format's 4 GB archive size.

Add an R2 CORS policy allowing the website origin to use `PUT` and `GET` with the `Content-Type` header. For local development, the allowed origin is `http://localhost:3000`.

The upload and download flows use standard WebSocket, XMLHttpRequest progress events, and normal HTTP streaming. They work in current Safari, Chrome, Edge, and Firefox without browser-specific extensions.

## Checks

```bash
npm run build
npm run app:check
npm run server:check
```

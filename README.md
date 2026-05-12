# API - Backend (Express + TypeScript)

## Introduction

### Resume 

Lumière is a cloud-native photography marketplace that lets photographers sell session-based portfolios online without managing any infrastructure of their own. Photographers sign up, create portfolios, upload originals, and invite specific clients to private galleries. Behind the scenes the originals land in a private S3 bucket and trigger an asynchronous SQS + Lambda pipeline that generates watermarked previews and thumbnails. Clients only ever see the watermarked variants until they pay, at which point Stripe Checkout fires a webhook, the purchase is recorded in PostgreSQL (Neon), and the original images become downloadable for that client only.

The whole stack runs serverless on AWS and is provisioned end-to-end with Terraform: Cognito for authentication, API Gateway + Lambda for the Express API, S3 + CloudFront for the React SPA, SQS for the watermark queue, SNS + CloudWatch for transactional notifications and operational alarms, and Neon Postgres for relational state. Three independent repositories (INFRA, API, APP) ship through GitHub Actions — linting and validation on every push, plus automated aws lambda update-function-code and aws s3 sync + CloudFront invalidations on every merge to main — so the same codebase can be torn down and redeployed cleanly into the AWS Academy lab whenever the four-hour session expires.

### Backend Integration

The API is made with Lambda Service. The PostgreSQL serverless database lives on **Neon**. Once the infraestructure is built, we upload the API and after we upload the Frontend.
- https://github.com/VELITA0000/ProyectoNube-INFRA
- https://github.com/VELITA0000/ProyectoNube-FRONT

### AWS service integration

| Service | Where it's used | How |
|---|---|---|
| **Cognito** | `src/auth/jwt.ts`, `src/middleware/requireAuth.ts`, `src/routes/auth.ts` | Admin APIs for user lifecycle; JWKS for ID-token verification on every request. |
| **Neon PostgreSQL** | `src/db/pool.ts` (every route) | Single `pg.Pool` against `DATABASE_URL` (Neon serverless Postgres, TLS only — `sslmode=require`). Schema: `db/schema.sql`. The connection string is provisioned out of band with `npx neonctl@latest init` and pasted into Terraform; nothing in AWS owns the database. |
| **S3 (originals bucket)** | `src/routes/photos.ts`, `src/domain/mappers.ts` | Presigned PUT for uploads, presigned GET for originals (purchases) and for `watermarked/` + `thumbnails/` keys (every list / detail). `DeleteObjectsCommand` on photo removal. |
| **SQS (watermark queue)** | `src/routes/photos.ts` (`SendMessageCommand`) | Triggered when an upload presign is issued. Consumer is the watermark Lambda (`INFRA/modules/lambda`), which copies originals -> watermarked / thumbnails and writes back `status='ready'` + the produced keys to `photos`. Failures land in the configured DLQ after `max_receive_count` retries. |
| **SNS (transactions topic)** | `src/notifications/sns.ts` | Best-effort `Publish` for `purchase.succeeded`, `purchase.failed`, `session.published`. Never blocks the business flow — if the topic ARN is empty or the call fails, the function logs and returns `false`. |
| **Stripe** | `src/routes/cart.ts`, `src/routes/webhooks.ts` | Server-side `PaymentIntent` creation on checkout; signed webhook for status reconciliation. |

### Photo upload pipeline (end-to-end)

1. **Frontend** asks the API for a presign: `POST /photos/presign` with `{ sessionId | portfolioId, fileName, contentType }`.
2. **API** validates ownership, generates a UUID, inserts a `photos` row with `status='processing'`, returns a presigned PUT URL valid 300 s.
3. **Frontend** PUTs the binary directly to S3 (`Content-Type: <file.type>`).
4. **API** sends `{ bucket, key, photoId }` to SQS during the same request that returns the URL. Clients should PUT to S3 *before* the watermark message gets picked up; SQS retries with `visibility_timeout = 90s`, so even with reordering the worker eventually finds the object.
5. **Watermark Lambda** receives the message:
   - Copies `originals/<scope>/<file>` -> `watermarked/<scope>/<file>` and `thumbnails/<scope>/<file>` (stub; replace with real watermarking + resizing).
   - Updates the row in `photos` with `watermarked_url`, `thumbnail_url` (S3 keys, not URLs) and `status='ready'`. On copy failure, sets `status='failed'` and re-throws so SQS retries / DLQ.
6. **Frontend** polls `GET /photos/:id` (`waitForReady`); the API turns the stored S3 keys into 30‑minute presigned GET URLs at read time, so the buckets stay private.

### Runtime architecture

```
APP (SPA on CloudFront)
        │  Authorization: Bearer <Cognito ID token>
        ▼
API Gateway HTTP  ──►  API Lambda (Express via serverless-express)
                          ├── Cognito IDP (admin auth, signin/signup, JWKS)
                          ├── Neon PostgreSQL (pg.Pool over public TLS, sslmode=require)
                          ├── S3 originals bucket (presigned PUT/GET)
                          ├── SQS watermark queue ──► Watermark Lambda
                          │                              ├── S3 copy originals -> watermarked / thumbnails
                          │                              └── pg UPDATE photos SET status='ready', …
                          ├── SNS transactions topic (purchase / session events)
                          └── Stripe (PaymentIntent + signed webhook)
```

### Authorization flow

The API sits behind **AWS Cognito**. The frontend never talks to Cognito directly: it goes through the API, and the API uses the **admin** Cognito APIs.

**1. Sign up (`POST /auth/signup`)**
   - `AdminCreateUserCommand` (email + name + `custom:role` = `photographer | client`, `MessageAction = SUPPRESS` so Cognito does not send the welcome email).
   - `AdminSetUserPasswordCommand` with `Permanent = true` (skips the `FORCE_CHANGE_PASSWORD` state).
   - `AdminGetUserCommand` to read back the canonical `cognito_sub`.
   - `INSERT` into `users` (1‑to‑1 with the Cognito user, `cognito_sub` is the join key).
   - `InitiateAuthCommand` (`USER_PASSWORD_AUTH`) so the API can return tokens immediately.
   - Response: `{ user, idToken, accessToken, refreshToken }` (HTTP 201). The frontend stores `idToken` and uses it as `Authorization: Bearer …`.

**2. Sign in (`POST /auth/signin`)**
   - `InitiateAuthCommand` (`USER_PASSWORD_AUTH`). Bad credentials are normalised to `401 INVALID_CREDENTIALS`.
   - `GetUserCommand(accessToken)` -> resolves `cognito_sub`.
   - DB lookup `SELECT … FROM users WHERE cognito_sub = $1`. If the row is missing the API returns `401 USER_NOT_SYNCED` (signup was incomplete).
   - Same response shape as signup.

**3. Refresh (`POST /auth/refresh`)**
   - `InitiateAuthCommand` (`REFRESH_TOKEN_AUTH`). Returns new `idToken` + `accessToken` (Cognito recycles the same `refreshToken` until it expires; the API returns the value Cognito sent back, falling back to the input).

**4. Sign out (`POST /auth/signout`, requires auth)**
   - `GlobalSignOutCommand` if an access token is provided in the body or in the `Authorization` header. Failures are tolerated by the frontend so the local tokens are always cleared.
   - Returns `204 No Content`.

**5. Per-request validation (`requireAuth`)**
   - Reads `Authorization: Bearer <token>`. Missing -> `401 UNAUTHORIZED`.
   - `jose.jwtVerify(token, getJwks(), { issuer, audience })`:
     - `issuer = https://cognito-idp.<region>.amazonaws.com/<userPoolId>`
     - `audience = COGNITO_CLIENT_ID`
     - JWKS fetched lazily from `${issuer}/.well-known/jwks.json` (cached by `jose`).
   - `SELECT … FROM users WHERE cognito_sub = $1`. Missing row -> `401 USER_NOT_SYNCED`.
   - Stores the row in `req.appUser` so downstream handlers can compare `req.appUser.id` (UUID) and `req.appUser.role`.

**6. Authorization helpers**
   - `requireRole("photographer", "client")` is a tiny middleware that checks `req.appUser.role`.
   - **Resource-level checks** are inlined per route (compare `photographer_id`, `client_id`, `session.status === 'published'` and so on) - there is no row-level security; the DB pool runs as the same user. Any new endpoint **must** repeat the same `assert*Access` pattern.

**7. Profile (`GET /auth/me`, `PATCH /auth/me`, both auth-only)**
   - `GET` returns the user object built by `requireAuth`.
   - `PATCH` does a `COALESCE`-style update on `users` (`name`, `avatar_url`, `studio_name`, `bio`, `phone`) and mirrors the `name` change to Cognito (`AdminUpdateUserAttributesCommand`).

### Endpoints

All endpoints return JSON. Error bodies follow `{ code, message, details? }`. Status codes used by the API: `200` / `201` / `204` / `400` / `401` / `403` / `404` / `409` / `422` / `500` / `503`.

**Health - `src/app.ts`**
| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Always available, even with broken env. Returns `{ ok: true }`. |

When `getEnv()` throws (missing env vars in Lambda or local), every other route falls back to `503 not_ready` so callers can detect a misconfigured deployment.

**Auth - `src/routes/auth.ts`**
| Method | Path | Auth | Body / query | Notes |
|---|---|---|---|---|
| POST | `/auth/signup` | public | `{ email, password, name, role, phone?, studioName? }` | `409 EMAIL_TAKEN` if Cognito already has the user. Returns `{ user, idToken, accessToken, refreshToken }`. |
| POST | `/auth/signin` | public | `{ email, password }` | `401 INVALID_CREDENTIALS` on Cognito failure, `401 USER_NOT_SYNCED` if Cognito user has no `users` row. |
| POST | `/auth/refresh` | public | `{ refreshToken }` | Returns `{ idToken, accessToken, refreshToken }`. |
| POST | `/auth/signout` | bearer | `{ accessToken? }` | Best-effort `GlobalSignOut`; always responds `204`. |
| GET  | `/auth/me` | bearer | - | Returns the hydrated `req.appUser` mapped to API contract. |
| PATCH| `/auth/me` | bearer | `{ name?, avatarUrl?, studioName?, bio?, phone? }` | `COALESCE` update; mirrors `name` to Cognito. |

**Portfolios - `src/routes/portfolios.ts`**
Photographer-owned static showcases (no client assignment).
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/portfolios?photographerId=<uuid>` | bearer | Photographers can only list their own. |
| GET | `/portfolios/:id` | bearer | Photographer must own it. |
| POST | `/portfolios` | photographer | Body `{ title, description? }`. |
| PATCH | `/portfolios/:id` | photographer | Body `{ title?, description?, coverPhotoId? }`. `coverPhotoId` must reference a photo that already belongs to this portfolio; the API copies its `watermarked_url` into `cover_url`. |
| DELETE | `/portfolios/:id` | photographer | Cascades to photos via FK. |

**Sessions - `src/routes/sessions.ts`**
A photo session links one photographer to (eventually) one client and a set of photos. Status: `draft -> published -> archived`.
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/sessions?photographerId=<uuid>` | photographer (self) | Includes `clientName` / `clientEmail` joined from `users`. |
| GET | `/sessions?clientId=<uuid>` | client (self) | Only `published` sessions. Photos are mapped with `forClient = true` (no `originalKey` exposed). |
| GET | `/sessions?portfolioId=<uuid>` | photographer (owner) | Lists sessions linked to a portfolio. |
| GET | `/sessions/:id` | photographer (owner) **or** client (assigned + published) | Includes contact extras (photographer + client). |
| POST | `/sessions` | photographer | Body `{ title, date, portfolioId?, clientEmail? }`. Resolves `clientEmail` to `client_id` if the user exists. Created in `draft`. |
| PATCH | `/sessions/:id` | photographer (owner) | Updates `title`, `date`, `portfolioId`. |
| POST | `/sessions/:id/publish` | photographer (owner) | Body `{ clientEmail, message? }`. Requires that the client already exists in `users`; else `422 CLIENT_NOT_REGISTERED`. Sets `status='published'`, links `client_id`, then publishes a `session.published` event to SNS. Response: `{ session, notificationSent }`. |
| DELETE | `/sessions/:id` | photographer (owner) | Cascades to photos. |

**Photos - `src/routes/photos.ts`**
Drives the upload pipeline. The frontend never PUTs straight to S3 without a presigned URL.
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/photos/presign` | photographer | Body `{ fileName, contentType, sessionId? \| portfolioId? }`. Asserts ownership of the target. Generates a UUID for the photo, builds key `originals/<scope>/<photoId>-<fileName>`, inserts the row in `photos` (status `processing`), generates a presigned PUT URL (300 s), and **enqueues** an SQS message `{ bucket, key, photoId }`. Returns `{ url, photoId, key }`. |
| GET | `/photos?sessionId=<uuid>` | bearer (photographer or assigned client) | Clients only see `status='ready'` photos; their `originalKey` is hidden. |
| GET | `/photos?portfolioId=<uuid>` | photographer (owner) | Same shape. |
| GET | `/photos/:id` | bearer (per-resource check) | Returns the mapped photo (with presigned `watermarkedUrl` / `thumbnailUrl`). |
| GET | `/photos/:id/original` | photographer (owner) **or** client who paid for it | Generates a presigned GET URL (300 s) for the original. Clients without a paid `purchase` get `403 NOT_PURCHASED`. |
| DELETE | `/photos/:id` | photographer (owner) | Deletes original + watermarked + thumbnail S3 objects (`DeleteObjectsCommand`) and removes the DB row. |

**Cart - `src/routes/cart.ts`**
Per-client cart (UNIQUE on `client_id, photo_id`). All endpoints require `role=client`.
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/cart?clientId=<uuid>` | client (self) | Returns `[{ photoId, sessionId, unitPrice }]`. |
| POST | `/cart/items` | client (self) | Body `{ clientId, photoId, sessionId, unitPrice? }`. Defaults `unitPrice` to `DEFAULT_PHOTO_UNIT_PRICE_USD`. Validates the session is `published` and assigned to the caller; rejects `409 ALREADY_PURCHASED` if the photo is in a paid purchase. `ON CONFLICT … UPDATE` allows price refresh. |
| DELETE | `/cart/items/:photoId?clientId=<uuid>` | client (self) | Removes one item. |
| DELETE | `/cart?clientId=<uuid>` | client (self) | Empties the cart. `204 No Content`. |
| POST | `/cart/checkout` | client (self) | Body `{ clientId }`. Groups cart items by `sessionId`, inserts one `purchases` row per session (status `pending`), creates a single Stripe `PaymentIntent` for the grand total, stores its id on every purchase row. Returns `{ paymentIntentId, clientSecret, amount, currency: "usd", pendingPurchases }`. Returns `503 STRIPE_NOT_CONFIGURED` if `STRIPE_SECRET_KEY` is empty. |

**Purchases - `src/routes/purchases.ts`**
Read-only history. Both roles can hit `GET /purchases/:id` if they are involved in it.
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/purchases?clientId=<uuid>` | client (self) | List of the client's purchases. |
| GET | `/purchases/:id` | client (owner) **or** photographer of the purchased session | Single record. |

**Photographer dashboard - `src/routes/photographer.ts`**
Aggregates for the dashboards. All require `role=photographer`.
| Method | Path | Notes |
|---|---|---|
| GET | `/photographer/clients?photographerId=<uuid>` | Distinct clients that have a session with this photographer. |
| GET | `/photographer/purchases?photographerId=<uuid>` | All purchases whose session belongs to this photographer. |

**Stripe webhook - `src/routes/webhooks.ts`**
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/webhooks/stripe` | Stripe signature | Mounted **before** the JSON middleware (`express.raw({ type: "application/json" })`). Verifies `stripe-signature` against `STRIPE_WEBHOOK_SECRET`. |

Handled events:
- `payment_intent.succeeded` - flips matching `purchases.status` to `paid`, empties the client's cart, then publishes a `purchase.succeeded` SNS notification with the totals + payment intent.
- `payment_intent.payment_failed` - flips `purchases.status` to `failed` and publishes `purchase.failed`.

Returns `503` (graceful) if Stripe is not configured, `400` on bad signature, `200 { received: true }` otherwise.

## Launch

### Prerequisites

**1. AWS credentials**   
```bash
aws configure
aws sts get-caller-identity
```

**2. Node + npm (build the bundle)**    
```bash
node --version
npm --version
```

**3. INFRA already applied**    
The API Lambda must exist (always named ```photo-app-prod-api```) and the API Gateway URL must be live.

## Database schema

**1. Execution permission for the scripts**    
```bash
chmod +x API/*.sh
```

**2. Apply the schema once**   
This creates tables ```users```, ```portfolios```, ```sessions```, ```photos```, ```cart_items```, ```purchases``` and the indexes/extensions they need.

Delete
```bash
psql "<database_url>" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
```

**3. Delete and Create**
```bash
psql "<database_url>" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" -f API/db/schema.sql
```

## First Apply (Standalone)

**1. Setup variables**  
```
NODE_ENV
DATABASE_URL
AWS_ENDPOINT_URL
COGNITO_USER_POOL_ID
COGNITO_CLIENT_ID
COGNITO_ENDPOINT_URL
COGNITO_ISSUER_URL
S3_BUCKET_ORIGINALS
SQS_WATERMARK_QUEUE_URL
CLOUDFRONT_ORIGIN_URL
FRONTEND_ORIGIN
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
SNS_TRANSACTIONS_TOPIC_ARN
DEFAULT_PHOTO_UNIT_PRICE_USD
```

**2. Run create.sh**   
```bash
API/create.sh
```

The script executes the following sequence internally:
- Verifies ```AWS_credentials``` work (```aws sts get-caller-identity```).
- Resolves ```API_LAMBDA_FUNCTION_NAME``` (defaults to ```photo-app-prod-api```).
- Runs ```npm install``` in ```API/``` (full install, including dev tools).
- Runs ```npm run bundle:lambda``` (esbuild -> ```API/.lambda-build/index.js```).
- Packages ```API/.lambda-build/function.zip``` with the single ```index.js``` bundle.
- Calls ```aws lambda update-function-code --function-name "$API_LAMBDA_FUNCTION_NAME" --zip-file fileb://API/.lambda-build/function.zip```.

**3. Smoke test**  
```bash
curl "<http_api_endpoint>/health"
```

Should return ```{"ok":true}```

## Second apply (Lambda and Stripe)

**1. Lambda**   
Remove commented route of tfvars

**2. Stripe**   
Read the public API base URL:  
```bash
terraform output -raw http_api_endpoint
```

Stripe - Developers - Webhooks - Payment Intent (succeeded and failed) - Point of webhook connection   
```<http_api_endpoint>/webhooks/stripe```

Update Stripe endpoint in tfvars 
```stripe_webhook_secret = "whsec_..."```

Apply changes       
```bash
INFRA/update.sh
```

## Changes

The script reuses ```node_modules``` if present, rebuilds the bundle, repackages it, and uploads.

**1. Edit**  
- Modify ```API/src/**``` (routes, mappers, auth) use ```API/update.sh```
- Modify ```API/package.json``` (edit dependencies) use ```create.sh```

**2. Apply changes**    
```bash
bash API/update.sh
bash API/create.sh
```

Internal sequence of ```update.sh```:
- Verifies AWS credentials.
- Resolves ```API_LAMBDA_FUNCTION_NAME``` (defaults to ```photo-app-prod-api```).
- Runs ```npm install``` only if ```node_modules/``` is missing.
- Runs ```npm run bundle:lambda```.
- Repackages ```function.zip``` and calls ```aws lambda update-function-code```.

**Update Frontend**   
If you change response shapes, sync ```APP/src/types/index.ts``` and ```APP/src/services/*```; rebuild the SPA with ```bash APP/update.sh```

**Update Lambda env vars**   
If you change an env var, sync ```module/ "api_http".environment_variables``` in ```INFRA/environments/prod/main.tf```, then ```bash INFRA/update.sh```.

## Tear down

**1. Local clean-up**    
```bash
rm -rf API/.lambda-build API/node_modules
```

Deletes ```API/.lambda-build/``` created with the command in the script ```npm run bundle:lambda``` that packages lambda with the ```index.js``` and ```function.zip```

Deletes ```API/node_modules/``` with dependencies from the API installed with ```npm install```

**2. Tear down the AWS Lambda + API Gateway**    
```bash
bash INFRA/destroy.sh
```

Destroys all infraestructure
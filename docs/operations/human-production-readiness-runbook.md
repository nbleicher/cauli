# Human production-readiness runbook

## Purpose

This is the operator checklist for every production-readiness task that requires a human login, payment method, MFA device, physical custody, legal approval, real hardware, or final release judgment.

The tasks are intentionally split into two phases:

- **Phase A — before implementation:** complete account bootstrap, provider ownership, offline-key generation, and access preparation before agents begin implementing the production-readiness tickets.
- **Phase B — after implementation, before launch:** complete tasks that require a working staging release, rendered legal pages, real recovery artifacts, or the final production candidate.

The specification and tickets may be created before either phase is complete. Each manual task must become an explicit `ready-for-human` ticket or acceptance gate, and agent tickets must name the applicable human blocker.

Counsel review is explicitly **out of the current pilot scope**. The operator still approves the pilot legal documents and wording, but the product and documents must not claim that counsel reviewed them.

## Secret-handling rules

1. Never put a password, MFA seed, Recovery Code, API token, private key, database password, provider secret, session cookie, or unredacted provider screenshot in GitHub, this repository, a pull request, an issue, Sentry, Slack, or email.
2. Create a private password-manager collection named `Cauli Production Operations`.
3. Create a private evidence folder named `Cauli Launch Evidence` outside this repository. It must be access-controlled and encrypted by the storage provider or operating system.
4. Store provider recovery codes and emergency kits in the password manager. Store only content-free evidence in GitHub, such as “AWS root MFA verified on YYYY-MM-DD.”
5. Prefer interactive login, SSO, short-lived credentials, or an operator-run command over sharing a long-lived credential with an agent.
6. When an implementation tool requires a token:
   - create the narrowest token that supports the documented task;
   - set an expiration when the provider supports one;
   - enter it directly into the destination secret store;
   - never paste it into chat;
   - revoke it after the task if it is not a required runtime credential.
7. Runtime credentials must be different for staging and production and different for each principal described by the production-readiness specification.
8. Record every credential’s owner, purpose, scope, destination, creation date, revocation procedure, and incident-rotation procedure. Record only the token name or fingerprint, never its secret value.

## Phase A — complete before implementation begins

### H01 — Establish the private operator record

**Owner:** Cauli operator

**Unlocks:** every other human task

1. In the password manager, create the `Cauli Production Operations` collection.
2. Add one secure note named `Provider inventory`.
3. Add every field in the lookup table below. If H02–H10 must create an object first, enter `PENDING — H0x` rather than inventing an identifier. Return to the inventory immediately after that task and replace the pending value.
4. Store only identifiers, names, locations, fingerprints, and links to separate password-manager items in `Provider inventory`. Never put a password, MFA seed, Recovery Code, API-token value, private key, database password, or complete OpenRouter key in this note.
5. Create the private `Cauli Launch Evidence` folder with subfolders:
   - `accounts`;
   - `regions`;
   - `legal`;
   - `recovery`;
   - `release`.
6. Record the evidence folder’s provider and exact private folder path in `Provider inventory`; do not record a public sharing URL.
7. Confirm neither the password-manager collection nor the evidence folder is inside the Cauli repository or a public sharing scope.
8. H01 is initialized when the note and folder structure exist. H11 completes the inventory by verifying that every `PENDING` entry has been replaced.

#### H01 object lookup table

| Inventory field                       | Where to find the object                                                                                                                                                                                 | What to record                                                                                                | Secret handling                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Operator name                         | The name the operator will use for provider ownership, approvals, and release records.                                                                                                                   | Full operator name.                                                                                           | Not a secret; keep personal details out of GitHub unless required.                                                     |
| Operator alert email                  | The inbox the operator will actively monitor for Critical and High alerts. Confirm it by sending and receiving a test message.                                                                           | Complete email address and test date.                                                                         | Personal data; keep in the private inventory.                                                                          |
| GitHub repository                     | In the repository page, copy the owner/repository name from the heading or URL. From this checkout, run `git remote get-url origin`.                                                                     | `nbleicher/cauli` and `https://github.com/nbleicher/cauli`.                                                   | Not a secret. Do not copy a credential-bearing remote URL.                                                             |
| Cloudflare account ID                 | Cloudflare Dashboard → **Account home** → menu beside the account → **Copy account ID**. It is also shown in the account Overview API section.                                                           | 32-character account ID.                                                                                      | Identifier, not a credential.                                                                                          |
| Cloudflare `cauli.pro` zone ID        | Cloudflare Dashboard → select the account → **Websites** → `cauli.pro` → **Overview** → API section → **Zone ID**.                                                                                       | 32-character zone ID.                                                                                         | Identifier, not a credential.                                                                                          |
| Railway production project ID         | Railway Dashboard → `Cauli Production` → **Settings** → **General** → **Project ID**. Before H05 renames it, this is the existing `CallLog` project.                                                     | Project name, project ID, and dashboard URL.                                                                  | Identifier, not a runtime secret.                                                                                      |
| Railway staging project ID            | After H05 creates it: Railway Dashboard → `Cauli Staging` → **Settings** → **General** → **Project ID**.                                                                                                 | Project name, project ID, and dashboard URL. Initially `PENDING — H05`.                                       | Identifier, not a runtime secret.                                                                                      |
| Supabase production project reference | Supabase Dashboard → production project → **Settings** → **General** → **Project Settings** → **Reference ID**. It is also the value after `/project/` in the dashboard URL.                             | 20-character project reference, project name, and exact region.                                               | Identifier, not a credential. Do not record API keys here.                                                             |
| Supabase staging project reference    | After H06 creates it: Supabase Dashboard → `Cauli Staging` → **Settings** → **General** → **Project Settings** → **Reference ID**.                                                                       | 20-character project reference, project name, and `us-east-1`. Initially `PENDING — H06`.                     | Identifier, not a credential. Store the database password in its own password-manager item.                            |
| Sentry organization slug              | After H02 creates it: Sentry → **Settings** → **General Settings**. The slug also appears after `/organizations/` in Sentry URLs.                                                                        | Organization name, organization slug, and U.S. data region. Initially `PENDING — H02`.                        | Identifier, not a credential.                                                                                          |
| Sentry web project slug               | Sentry → **Settings** → **Projects** → `cauli-web` → **General Settings**. The project slug is also used in Sentry project API paths.                                                                    | `cauli-web`, its project slug, and a link to the separate DSN inventory item. Initially `PENDING — H02`.      | Slug is not secret. Keep DSN configuration in its own password-manager item.                                           |
| Sentry worker project slug            | Sentry → **Settings** → **Projects** → `cauli-worker` → **General Settings**.                                                                                                                            | `cauli-worker`, its project slug, and a link to the separate DSN inventory item. Initially `PENDING — H02`.   | Slug is not secret. Keep DSN configuration in its own password-manager item.                                           |
| AWS account ID                        | After H03 creates it: AWS Console → account menu at upper right, or **IAM Dashboard** → AWS account section. With an authenticated CLI, run `aws sts get-caller-identity --query Account --output text`. | 12-digit AWS account ID and IAM Identity Center sign-in URL. Initially `PENDING — H03`.                       | Account ID is not a credential. Root email, password, MFA, and Recovery Codes stay in separate password-manager items. |
| OpenRouter production key identity    | OpenRouter → **API Keys** → existing production key. Use the displayed key name and stable key hash or identifier if shown. Do not derive or copy the plaintext key into this note.                      | `cauli-production-worker`, key hash/identifier, and current spending-limit setting.                           | The name/hash is safe inventory metadata; the plaintext key stays in its own secret item.                              |
| OpenRouter staging key identity       | After H07 creates it: OpenRouter → **API Keys** → `cauli-staging-worker`.                                                                                                                                | Key name, key hash/identifier, expiration if any, and monthly spending limit. Initially `PENDING — H07`.      | The plaintext key is shown only at creation and goes directly into its own secret item.                                |
| Netcup server identifier              | Netcup **Server Control Panel** → select the Manassas ARM64 VPS → server Overview or General information.                                                                                                | Server number/identifier, hostname, primary IP, and account or product reference.                             | Treat the IP as operational metadata; never record the root password or SSH private key here.                          |
| Netcup region                         | In the Netcup order/product details and server-location evidence for the selected VPS. Confirm it matches Manassas, Virginia.                                                                            | `Manassas, Virginia, US`, evidence date, and private evidence filename.                                       | Not a secret; keep the full screenshot in `Cauli Launch Evidence/regions`.                                             |
| Peely host                            | On the synchronization Mac: Apple menu → **System Settings** → **General** → **About** → **Name**. The local hostname is under **General** → **Sharing**.                                                | Mac computer name, local hostname, responsible operator, and macOS version.                                   | Private operational metadata; do not put serial number or personal network address in GitHub.                          |
| Peely mount path and volume identity  | Connect Peely, then open **Disk Utility** → **View** → **Show All Devices** → select `Peely SSD` → **Info**. Confirm the Mount Point, capacity, available space, format, and volume UUID.                | Exact mount path `/Volumes/Peely SSD`, volume name, volume UUID, capacity, free space, and verification date. | Volume metadata is not a decryption secret. Never store the offline recovery identity on Peely.                        |
| Password-manager collection location  | In the password manager, copy the vault or collection name containing `Cauli Production Operations`.                                                                                                     | Password-manager provider, account or vault name, and collection path; do not use a public URL.               | Sensitive location metadata; keep private.                                                                             |
| Launch-evidence folder location       | In the chosen encrypted private storage, open `Cauli Launch Evidence` and note its provider, owning account, and folder path.                                                                            | Provider, private account or vault, exact folder path, access list, and creation date.                        | Never create or record a public sharing link.                                                                          |

#### H01 lookup references

- [Cloudflare: find account and zone IDs](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)
- [Railway: find a project ID in project settings](https://docs.railway.com/projects)
- [Supabase: find the project Reference ID](https://supabase.com/docs/guides/graphql#project-reference-project_ref)
- [Sentry: organization and project slug API identifiers](https://docs.sentry.io/api/projects/create-a-project-for-an-organization/)
- [AWS: view the 12-digit account ID](https://docs.aws.amazon.com/IAM/latest/UserGuide/console-account-id.html)
- [OpenRouter: API-key names and hashes](https://openrouter.ai/docs/guides/overview/auth/management-api-keys)
- [Apple: find the Mac name and local hostname](https://support.apple.com/guide/mac-help/find-your-computers-name-and-network-address-mchlp1177/mac)
- [Apple: inspect the Peely mount point and volume information](https://support.apple.com/guide/disk-utility/get-detailed-information-about-a-disk-dskutl1005/mac)

**Completion evidence:** content-free note recording the inventory and evidence locations and their creation date. H11 records that no `PENDING` values remain.

### H02 — Create and secure the Cauli Sentry organization

**Owner:** Cauli operator

**Unlocks:** Sentry implementation and live telemetry acceptance

1. Go to [Sentry](https://sentry.io/) and create a new account using an operator-controlled email.
2. Verify the email address.
3. Use a unique password stored in the password manager.
4. Enable MFA.
5. Store Sentry Recovery Codes in the password manager, separate from the password field.
6. Create a dedicated organization:
   - organization name: `Cauli`;
   - organization slug: use `cauli` if available, otherwise record the generated slug;
   - plan: free Developer plan;
   - data region: United States.
7. Keep the operator as the sole initial organization owner. Do not invite implementation agents as members.
8. Create two projects:
   - `cauli-web`, using the Next.js platform;
   - `cauli-worker`, using the Node.js platform.
9. Do not enable Session Replay, User Feedback, profiling, log ingestion, Seer/AI, screenshots, attachments, or default PII.
10. Save the organization slug, project slugs, and DSNs in the provider inventory. A DSN is configuration, but it should still be handled through environment configuration rather than committed to source.
11. Do not create a broad personal API token. When build automation is implemented, create a narrowly scoped organization token through a Sentry internal integration and enter it directly into the build secret store.

**Completion evidence:** redacted screenshots showing the organization, free plan, U.S. region, sole owner, MFA, and two project names.

Official references:

- [Create a Sentry project](https://docs.sentry.io/api/projects/create-a-project-for-an-organization/)
- [Create an organizational authentication token](https://docs.sentry.io/api/guides/create-auth-token/)

### H03 — Create and secure the dedicated Cauli AWS account

**Owner:** Cauli operator

**Unlocks:** managed KMS implementation

1. Create a new standalone AWS account used only for Cauli.
2. Use a dedicated, durable root email address controlled by the operator.
3. Use a unique root password stored in the password manager.
4. Enter accurate account and recovery contact details and retain them in the private operator record.
5. Add the payment method and select the Basic support plan unless a later decision changes it.
6. Sign in once as the root user.
7. Register root MFA immediately. Prefer a phishing-resistant passkey or hardware security key and register a second recovery-capable device if available.
8. Confirm the root user has **no access keys**. Do not create one.
9. Add security, operations, and billing alternate contacts.
10. Enable IAM access to billing information.
11. Configure AWS IAM Identity Center for the operator’s daily administrative access, require MFA, and verify that the operator can sign in without root.
12. Create a monthly AWS Budget named `Cauli KMS`:
    - initial amount: USD 5;
    - email at 50%, 80%, and 100% actual spend;
    - email at 100% forecast spend.
13. Record the 12-digit account ID and daily administrative sign-in URL in the provider inventory.
14. Sign out of root and use root only for root-only account recovery or security tasks.
15. Do not create the KMS key manually. The implementation ticket will provision:
    - region `us-east-2`;
    - asymmetric RSA-4096 encrypt/decrypt key;
    - RSA-OAEP-SHA256;
    - worker access to public material only;
    - a normally disabled, MFA-protected restore role with `kms:Decrypt`.
16. Do not give an agent the root password, MFA code, or permanent AWS access key. Use operator-approved infrastructure code with IAM Identity Center temporary credentials.

**Completion evidence:** redacted screenshots showing account ID, root MFA, absence of root access keys, alternate contacts, budget alerts, and successful IAM Identity Center sign-in.

Official references:

- [Create an AWS account](https://docs.aws.amazon.com/hands-on/latest/setup-environment/module-one.html)
- [Protect the AWS root user with MFA](https://docs.aws.amazon.com/IAM/latest/UserGuide/enable-mfa-for-root.html)
- [Avoid root for daily work](https://docs.aws.amazon.com/accounts/latest/reference/root-user.html)
- [Set up daily administrative and billing access](https://docs.aws.amazon.com/IAM/latest/UserGuide/getting-started-account-iam.html)

### H04 — Secure Cloudflare ownership and prepare scoped automation

**Owner:** Cauli operator

**Unlocks:** DNS, TLS, and Cloudflare Access implementation

1. Sign in to the Cloudflare account that owns `cauli.pro`.
2. Confirm the `cauli.pro` zone is Active and that the registrar uses the assigned Cloudflare nameservers.
3. Confirm the operator is an account owner or Super Administrator.
4. Enable MFA and store Cloudflare Recovery Codes in the password manager.
5. Record the Cloudflare account ID and `cauli.pro` zone ID in the provider inventory.
6. Create two user API tokens:
   - `cauli-staging-dns`;
   - `cauli-production-dns`.
7. For each token, grant only:
   - Zone → DNS → Edit;
   - Zone → Zone → Read;
   - zone resource → Include → Specific zone → `cauli.pro`.
8. Use an expiration during bootstrap if the token is only needed for initial DNS configuration.
9. Store each token once in the password manager. Cloudflare displays the secret only at creation.
10. Understand the boundary: Cloudflare scopes DNS tokens to the whole `cauli.pro` zone, not individual record names. Separate staging and production tokens provide audit and revocation separation, but either DNS Edit token can alter any record in that zone.
11. Do not use or share the Global API Key.
12. Do not create application DNS records yet. Railway must first provide the correct custom-domain targets.
13. When Cloudflare Access automation is implemented, create a separate temporary token with only the exact Access application and policy permissions required. Revoke it after configuration.

**Completion evidence:** redacted screenshots showing active zone ownership, MFA, token names, token permissions, zone restriction, and expiration.

Official reference: [Create a scoped Cloudflare API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)

### H05 — Prepare isolated Railway projects

**Owner:** Cauli operator

**Unlocks:** staging infrastructure and immutable promotion

1. Sign in to Railway using the account that owns the current `CallLog` project.
2. Enable MFA on the Railway account if the plan/account supports it; otherwise secure the linked identity provider with MFA.
3. Rename the existing project from `CallLog` to `Cauli Production`.
4. Confirm the production project remains private.
5. Create a new empty, private project named `Cauli Staging`.
6. Do not duplicate production into staging because duplicated environment variables could copy production credentials.
7. Record both project IDs in the provider inventory.
8. Do not create public worker domains.
9. Do not connect custom domains or copy variables yet.
10. Confirm the implementation target for every web and worker service is:
    - Railway region name: `US East Metal`;
    - location: Virginia, USA;
    - identifier: `us-east4-eqdc4a`.
11. Use interactive Railway authorization for implementation where possible. If a project token is required, create it for only the intended project/environment, enter it directly into the implementation secret store, and record its name and revocation procedure.

**Completion evidence:** redacted screenshots showing two private projects and their IDs. Service-region evidence is collected in Phase B after the services exist.

Official references:

- [Railway projects](https://docs.railway.com/projects)
- [Railway regions](https://docs.railway.com/deployments/regions)
- [Railway private domains](https://docs.railway.com/networking/domains/working-with-domains)

### H06 — Create the isolated Supabase staging project

**Owner:** Cauli operator

**Unlocks:** staging database, Auth, and Storage implementation

1. Sign in to the Supabase organization that owns the existing production `CallLog` project.
2. Enable MFA and store Supabase Recovery Codes in the password manager.
3. Confirm the production project reports the exact region `us-east-1` / East US (North Virginia).
4. Create a new project:
   - name: `Cauli Staging`;
   - region: exact `us-east-1` / East US (North Virginia);
   - database password: unique, generated, and stored in the password manager;
   - plan: the lowest plan that supports the staging acceptance workload.
5. Wait for the project to become Healthy.
6. Record the staging project reference and region in the provider inventory.
7. Do not copy production data into staging. Staging is synthetic-data-only.
8. Do not paste the service-role or secret key into chat or source control.
9. Prefer interactive Supabase CLI authorization. If automation needs a personal access token, create it immediately before the task, enter it directly into the local secret store, and revoke it when provisioning is finished because a Supabase PAT carries the user’s management privileges.
10. Leave Auth URLs, email templates, Storage policies, schema migrations, and least-privilege principals to the implementation tickets.

**Completion evidence:** redacted screenshots showing both project names and exact U.S. regions, plus the staging project Healthy state.

Official references:

- [Supabase regions](https://supabase.com/docs/guides/platform/regions)
- [Supabase Management API authentication](https://supabase.com/docs/reference/api/getting-started)

### H07 — Separate OpenRouter staging access

**Owner:** Cauli operator

**Unlocks:** real-provider staging tests

1. Sign in to the existing OpenRouter account.
2. Secure the login identity with MFA.
3. In Privacy settings:
   - keep private input/output logging disabled;
   - keep OpenRouter use of inputs/outputs disabled;
   - enforce Zero Data Retention for every model group used by Cauli.
4. Retain the current OpenRouter key as the production worker key. Rename or label it `cauli-production-worker` if the dashboard permits.
5. Create a separate API key named `cauli-staging-worker`.
6. Give the staging key a conservative monthly spending limit. Start with USD 10 unless the representative five-Call load test demonstrates that a higher temporary limit is required.
7. Store the new key in the password manager when it is shown. Do not commit it or paste it into chat.
8. Record key names or hashes and their spending limits in the provider inventory.
9. Do not put either OpenRouter key in the web service. Only its environment’s worker may receive it.
10. The application must still send per-request `zdr: true` and denied provider data collection; account settings are an additional control, not a replacement for request enforcement.

**Completion evidence:** redacted screenshots showing privacy controls, distinct key names, and the staging spending limit.

Official references:

- [OpenRouter Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr)
- [OpenRouter data-collection settings](https://openrouter.ai/docs/guides/privacy/data-collection)
- [OpenRouter API-key spending limits](https://openrouter.ai/docs/api/api-reference/api-keys/create-keys)

### H08 — Prepare the shared Netcup VPS for reviewed bootstrap

**Owner:** Cauli operator

**Unlocks:** Source Audio Backup receiver implementation

1. Sign in to the Netcup account and secure the account with MFA if available.
2. Confirm account recovery and billing contact details.
3. Confirm the selected server is the existing Manassas, Virginia ARM64 VPS with:
   - 65,536 MiB RAM;
   - 18 CPUs;
   - 2,048 GiB disk;
   - other workloads intentionally present.
4. Confirm operator SSH access works without exposing the private SSH key.
5. Record the server identifier, public hostname or IP, operating-system version, architecture, and patch date in the private provider inventory.
6. Verify at least 800 GB can be reserved for Cauli without threatening the existing workloads.
7. Back up or document the configuration of existing workloads before changing host-level users, firewall rules, mounts, or services.
8. Do not give an implementation agent the root password or unrestricted SSH private key.
9. Require the implementation ticket to produce a reviewed bootstrap script. The operator will run that script with `sudo`.
10. The script must create a dedicated `cauli-backup` service account and isolated service, an 800 GB quota or enforced capacity ceiling, a narrow mTLS receiver, create-only intake, a privileged re-ownership helper, and a separate retention principal.
11. Confirm other workloads receive no Cauli credentials or filesystem permissions.

**Completion evidence:** redacted system inventory and a content-free statement that operator SSH access, free capacity, and existing-workload recovery information were verified.

### H09 — Prepare Peely as the additional offline copy

**Owner:** Cauli operator

**Unlocks:** Peely synchronization implementation

1. Connect Peely SSD to the Mac that will run synchronization.
2. Confirm it mounts exactly at `/Volumes/Peely SSD`.
3. Confirm at least 800 GB is available for the complete Cauli backup set.
4. Confirm the Mac has a stable operator account, disk encryption, automatic security updates, and a reliable way to run the daily synchronization.
5. Record the Mac identifier, operating-system version, mount path, free space, and responsible operator in the private provider inventory.
6. Do not store the offline `age` private identity or its passphrase on Peely.
7. Do not create a broad VPS administrator credential for Peely. Its eventual principal may only read encrypted backup objects and write the offline copy.
8. Keep the drive disconnected when operationally practical, while still meeting the daily synchronization requirement.
9. Do not implement the sync job manually yet. The agent ticket must supply idempotent synchronization, checksum verification, safe retention instructions, and an email alert after 48 hours without success.

**Completion evidence:** redacted screenshot or command output showing the exact mount and at least 800 GB free.

### H10 — Generate and place the offline `age` recovery identity

**Owner:** Cauli operator

**Unlocks:** dual-wrap key implementation

**Critical rule:** the private identity and passphrase never enter GitHub, Railway, Supabase, AWS, Netcup, Sentry, OpenRouter, Peely, chat, or email.

#### Prepare

1. Obtain the official `age` CLI from the [official age project](https://github.com/FiloSottile/age).
2. Verify the release using the official release checksum or Sigsum proof.
3. Use a clean local account or temporary machine.
4. Disable Wi-Fi, unplug Ethernet, disable Bluetooth, and confirm the machine is offline before generating the key.
5. Insert two new removable drives that will become sealed Copy A and Copy B.
6. In the password manager, generate and save a unique high-entropy passphrase named `Cauli offline recovery identity passphrase`.
7. Set a restrictive file-creation mask:

   ```bash
   umask 077
   ```

#### Generate without writing a plaintext identity file

1. In a new empty working directory, run:

   ```bash
   age-keygen 2> cauli-offline-key-public.txt \
     | age --passphrase --output cauli-offline-identity.age
   ```

2. Enter the password-manager passphrase when prompted. The private identity flows directly into passphrase-encrypted `cauli-offline-identity.age`; it is not written as a plaintext file.
3. Open `cauli-offline-key-public.txt`. It must contain one line beginning `Public key: age1`.
4. Copy only the `age1...` value into `cauli-offline-recipient.txt`.
5. Produce a public fingerprint:

   ```bash
   shasum -a 256 cauli-offline-recipient.txt \
     > cauli-offline-recipient.sha256
   ```

6. Read the fingerprint aloud and compare it character by character with the value saved in the password manager.
7. The recipient and its fingerprint are public and may later be committed as configuration. The `.age` identity remains secret even though it is passphrase-encrypted.

#### Build two identical sealed recovery bundles

1. Put these items on each removable drive:
   - `cauli-offline-identity.age`;
   - `cauli-offline-recipient.txt`;
   - `cauli-offline-recipient.sha256`;
   - a PDF or text copy of the recovery instructions;
   - the exact `age` version and installer verification evidence.
2. Produce a printed text or QR representation of the passphrase-encrypted identity, recipient, and fingerprint while the machine remains offline.
3. Do **not** print the passphrase.
4. Verify both removable copies byte-for-byte:

   ```bash
   shasum -a 256 /Volumes/COPY_A/cauli-offline-identity.age
   shasum -a 256 /Volumes/COPY_B/cauli-offline-identity.age
   ```

5. Confirm both hashes match.
6. Seal and label both bundles with:
   - `Cauli offline recovery`;
   - key version `v1`;
   - creation date;
   - public-key fingerprint;
   - seal identifier;
   - “Passphrase held separately.”
7. Place Copy A in the operator’s local fire-resistant safe.
8. Place Copy B in the partner’s office safe.
9. Keep the password-manager emergency kit separate from both copies and from Peely.
10. Delete the temporary working copy only after both physical copies and the public recipient have been verified. Do not rely on secure overwrite behavior on SSD media; destroy or securely reinitialize disposable media if the working environment cannot guarantee removal.
11. Re-enable networking only after all secret-bearing removable media has been ejected and the temporary environment has been cleared.

**Completion evidence:** a content-free custody record containing key version, public fingerprint, creation date, both seal identifiers, both locations, and custodian acknowledgment. Do not photograph private key material or Recovery Codes.

Official reference: [age key generation and passphrase-protected identity files](https://github.com/FiloSottile/age#passphrase-protected-key-files)

### H11 — Prepare the nonsecret implementation handoff

**Owner:** Cauli operator

**Unlocks:** start of agent implementation

1. Confirm H01–H10 are complete.
2. Search the `Provider inventory` note for `PENDING`, `TODO`, blank values, placeholder identifiers, and copied secret values. Resolve every result before continuing.
3. Open each recorded dashboard URL and confirm the recorded account, project, organization, zone, key identity, server, host, region, and mount object still exists and matches the intended environment.
4. Create a content-free handoff record containing:
   - provider names;
   - account, project, organization, and zone identifiers;
   - approved regions;
   - public domains;
   - Sentry DSNs;
   - the public `age` recipient and fingerprint;
   - token names, not token values;
   - which credentials will be entered interactively;
   - which reviewed scripts the operator must run;
   - evidence references, not evidence containing secrets.
5. Confirm the following final topology:
   - `cauli.pro`: public site and policies with a Log in option;
   - `app.cauli.pro/login`: Workspace login;
   - `admin.cauli.pro`: production Platform Admin, protected by Cloudflare Access;
   - `staging.cauli.pro`: staging app, protected by Cloudflare Access;
   - `admin.staging.cauli.pro`: staging Platform Admin, protected by Cloudflare Access;
   - `status.cauli.pro`: public content-free service status;
   - `www.cauli.pro`: redirect to the apex;
   - no public worker domain.
6. Confirm authorization after login is derived server-side from active Workspace membership and roles; client state or a directly entered URL cannot expand access.
7. Confirm staging and production use separate Railway projects, Supabase projects, OpenRouter keys, credentials, and storage.
8. Confirm the operator is ready to perform interactive logins or run reviewed privileged commands without sharing root credentials.
9. Mark the external-account bootstrap human ticket complete.

**Phase A completion gate:** implementation may begin only when H11 is complete.

## Phase B — complete after implementation and before launch

These tasks can be specified and ticketed now, but cannot truthfully be completed until the relevant implementation exists.

### H20 — Complete provider configuration and DNS

1. Review the staging infrastructure plan or pull request.
2. Use interactive or scoped authorization to provision Sentry settings, AWS KMS, Railway services, Supabase configuration, Cloudflare Access, DNS, and alert integrations.
3. Enter runtime secrets directly into the correct provider secret store.
4. Confirm staging secrets cannot access production and production services do not contain staging secrets.
5. Add Railway custom domains only after Railway shows the required DNS targets.
6. Create the approved DNS records and `www` redirect.
7. Confirm Cloudflare Access protects staging and both administration surfaces.
8. Confirm `cauli.pro` remains public and its Log in option reaches `app.cauli.pro/login`.
9. Revoke temporary bootstrap tokens.

**Completion evidence:** redacted configuration inventory, DNS result, Access-policy result, and token-revocation record.

### H21 — Approve the operator-reviewed pilot legal package

1. Provide the implementation agent with:
   - operating legal name;
   - public business name;
   - business mailing address;
   - privacy contact email;
   - security and incident contact email;
   - support email;
   - the current subprocessor inventory.
2. Review the rendered:
   - Terms;
   - Privacy Notice;
   - DPA;
   - subprocessor list;
   - Recording Attestation and recording-responsibility language;
   - retention and deletion disclosures;
   - Security page;
   - incident and support contacts.
3. Verify the pages accurately describe Railway, Supabase, Cloudflare, OpenRouter and applicable model providers, Sentry, Netcup, AWS KMS, and any email provider used by Supabase Auth.
4. Verify they disclose possible transient international OpenRouter/model processing while describing only verified U.S.-hosted persistent systems.
5. Verify they contain exactly this Regulated-Use Disclaimer:

   > Cauli’s pilot has not been independently assessed, certified, or contractually approved for HIPAA, PCI DSS, FedRAMP, CUI, FERPA, COPPA, GLBA, GDPR-specific, or similar regulated workloads.

6. Verify they do not claim certification, compliance, regulated-use readiness, legal exemption, strict U.S. data residency, or counsel review.
7. Verify the disclaimer is public on Legal and Security pages and linked from the public footer and Invitation Activation without a separate checkbox.
8. Verify Terms and Privacy acceptance is versioned for every Workspace Member and the initial Admin also accepts the DPA and recording responsibilities.
9. Record operator approval, document versions, date, and the exact release candidate reviewed.
10. Counsel review remains deferred and out of scope.

**Completion evidence:** operator-signed content-free approval record plus immutable hashes of the approved rendered documents.

### H22 — Complete recovery custody and disaster-recovery acceptance

1. Inspect Copy A and Copy B seals and compare their printed fingerprints with the provider inventory.
2. Confirm Copy A remains at the operator’s residence and Copy B remains in the partner’s office safe.
3. Confirm the passphrase and password-manager emergency kit remain separate.
4. Confirm the production worker has only the AWS KMS public key and offline `age` recipient, with no decrypt credential.
5. Enable the normally disabled AWS restore role for the scheduled drill using fresh MFA.
6. Record a reason and drill identifier.
7. Perform a KMS restore on an isolated ephemeral U.S.-hosted machine.
8. Disable the restore role immediately after the drill.
9. Retrieve one sealed offline bundle under custody procedure.
10. Perform the required offline `age` restore without placing the identity on Railway, Supabase, Netcup, Sentry, GitHub, or Peely.
11. Restore Source Audio independently from both the VPS and Peely encrypted copies.
12. Verify manifest integrity, ciphertext checksum, authentication tag, and usable media regeneration.
13. Restore the database into a new Supabase project and verify Workspace, membership, Call, Review, Audit Event, job, and encrypted-backup-manifest relationships.
14. Demonstrate the four-hour recovery-time objective.
15. Delete temporary plaintext within 24 hours and destroy the ephemeral recovery environment.
16. Reseal the offline bundle with a new seal identifier and return it to its approved location.
17. Retain content-free drill evidence and remediation tickets for every failure.

**Completion evidence:** drill ID, timestamps, key version, safe object identifiers, success/failure, RTO result, new seal identifier, and temporary-plaintext deletion confirmation.

### H23 — Capture and approve production-region evidence

1. Capture timestamped provider screenshots or API output proving:
   - Railway web and worker: Virginia `us-east4-eqdc4a`;
   - Supabase production: `us-east-1`;
   - AWS KMS key: `us-east-2`;
   - Netcup VPS: Manassas, Virginia;
   - Sentry: U.S. data region.
2. Store full evidence only in `Cauli Launch Evidence/regions`.
3. Record a content-free verification in the release evidence.
4. Confirm deployment checks reject a configured region mismatch.
5. Repeat evidence collection after every infrastructure change and at least quarterly.
6. Do not claim OpenRouter/model inference remains exclusively in the United States.

**Completion evidence:** dated provider-evidence index and operator verification.

### H24 — Approve public-repository conversion and GitHub protections

1. Review the all-rights-reserved proprietary notice and confirm there is no open-source license.
2. Confirm tracked temporary files and machine-local provider metadata are removed and ignored.
3. Review the full-history secret-scan result.
4. Confirm `SECURITY.md` provides a private reporting route.
5. Make the repository public only after the preceding checks pass.
6. Enable private vulnerability reporting, secret scanning, push protection, dependency alerts, and weekly dependency-update pull requests.
7. Protect `main`:
   - require the agreed CI checks;
   - disallow force pushes;
   - disallow branch deletion;
   - allow zero mandatory external approvals for the sole maintainer;
   - do not permit required-check bypass.
8. Confirm production deploys only commits merged into `main`.

**Completion evidence:** redacted repository-settings screenshots and the accepted scan report.

### H25 — Perform real-device and accessibility acceptance

1. Test the exact staging candidate on Chrome desktop on macOS.
2. Test the same candidate on Chrome desktop on Windows.
3. On each platform, use real microphone audio and tab audio.
4. Verify microphone-only, tab-only, and combined recording.
5. Verify permissions, Recording Attestation, active-capture warnings, Stop & Save, Incomplete Recording recovery, Degraded Recording behavior, playback, English Transcript, and downloads.
6. Run the representative five-simultaneous-Call load test and confirm at least 95% of Calls no longer than 60 minutes become Ready within five minutes, including queue time.
7. Complete keyboard-only acceptance for activation, login, recording, Calls, Reviews, Follow-ups, retention, and administration.
8. Complete screen-reader acceptance on the critical journeys.
9. Confirm visible focus, error announcement, status announcement, and no keyboard trap.
10. File failures as blockers and repeat the affected test after correction.

**Completion evidence:** device/OS/browser matrix, candidate digest, timestamps, results, and linked remediation tickets.

### H26 — Verify alert delivery and operator readiness

1. Confirm the operator alert email is monitored during the pilot.
2. Trigger synthetic Critical and High alerts from staging.
3. Verify email delivery for:
   - web or worker health failure;
   - queue age over five minutes;
   - processing service-level breach;
   - repeated Needs Attention;
   - budget threshold;
   - backup lag;
   - Peely stale for 48 hours;
   - suspected authentication or Recovery Code attack.
4. Verify alerts contain no customer content, email address, title, Transcript, Review text, signed URL, credential, or request body.
5. Review the incident, credential-rotation, backup, restore, Workspace suspension, and status-page runbooks.
6. Confirm human support is Monday–Friday, 9 a.m.–6 p.m. Eastern, excluding U.S. federal holidays, with best effort after hours.
7. Confirm response targets:
   - Critical: acknowledge within 30 minutes during support hours;
   - High: acknowledge within two hours during support hours;
   - Normal: acknowledge within two business days.

**Completion evidence:** redacted alert receipts and signed operator-readiness checklist.

### H27 — Give final release sign-off

1. Confirm every required automated check passed.
2. Confirm every Phase B task passed for the exact candidate image digest.
3. Confirm staging contains synthetic data only.
4. Confirm production credentials are separated and the principal-denial matrix passed.
5. Confirm the Sentry content-scrubbing canary found no forbidden content.
6. Confirm CSP is enforced, required browser headers pass, and all Cauli subdomains use HTTPS before enabling HSTS `includeSubDomains`.
7. Confirm the legal versions, region evidence, recovery evidence, accessibility evidence, performance evidence, and support evidence reference the same release candidate.
8. Record the pre-migration recovery timestamp.
9. Approve promotion of the exact staging-tested image digest without rebuilding.
10. Run post-promotion smoke and health tests.
11. Record the final decision, operator, time, commit, image digest, migration, and evidence index.

**Completion evidence:** signed content-free release record. The pilot is not launch-ready until H27 is complete.

## Recurring human operations after launch

| Frequency                           | Manual action                                                                                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daily                               | Confirm operator email alerts are reachable; connect Peely as required for the scheduled verified sync.                                                                                                          |
| Weekly                              | Review unresolved Critical/High alerts, backup lag, budget warnings, dependency alerts, and failed jobs.                                                                                                         |
| Quarterly                           | Refresh region evidence; inspect offline seals and public fingerprints; drill AWS KMS restore; drill Supabase point-in-time recovery and Source Audio recovery; verify provider owners and credential inventory. |
| Annually                            | Perform the offline `age` restore drill.                                                                                                                                                                         |
| After infrastructure change         | Refresh affected region and credential evidence.                                                                                                                                                                 |
| After suspected credential exposure | Revoke and rotate the affected principal; rotate and rewrap backup keys if recovery material may be exposed.                                                                                                     |
| After offline-key rotation          | Replace both sealed bundles, verify custody, rewrap every unexpired backup, and repeat the offline restore drill.                                                                                                |
| After material legal change         | Approve new document versions and verify application reacceptance.                                                                                                                                               |

## Human-ticket mapping

The ticket graph should create or update these `ready-for-human` gates:

| Human gate                                | Runbook tasks | Blocks                                                                                                      |
| ----------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| External account bootstrap                | H01–H11       | Start of production-readiness implementation; live Sentry, KMS, staging, DNS, backup, and Peely integration |
| Operator legal approval                   | H21           | Final production sign-off                                                                                   |
| Offline recovery acceptance               | H22           | Final production sign-off                                                                                   |
| Region and public-infrastructure approval | H20, H23, H24 | Final production sign-off                                                                                   |
| Manual product and operations acceptance  | H25–H27       | Production promotion and pilot launch                                                                       |

Agent implementation tickets may be created immediately. They remain `ready-for-agent` when their coding and configuration acceptance criteria are complete, but their live integration or launch path must retain the applicable human dependency.

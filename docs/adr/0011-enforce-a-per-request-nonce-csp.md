# Enforce a per-request nonce CSP

Cauli handles recorded business conversations, so preventing injected browser code takes priority over static rendering and CDN caching for authenticated pages. The web application will generate a fresh nonce per request, allow only nonce-authorized scripts without production `unsafe-inline` or `unsafe-eval`, validate the policy in report-only staging, and enforce it before production promotion; OpenRouter remains server-only and browser destinations are explicitly allowlisted.

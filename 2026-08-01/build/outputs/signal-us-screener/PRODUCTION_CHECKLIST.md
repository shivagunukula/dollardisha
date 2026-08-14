# DollarDisha production checklist

## Complete in this release

- Security headers, HTTPS enforcement and API rate limiting.
- A dedicated `/healthz` endpoint for Render health checks.
- Render Blueprint records the always-on Starter service plan so a future Blueprint sync does not downgrade the service to Free.
- Permanent `/stocks/TICKER` URLs with company-specific titles and descriptions.
- Expanded sitemap and large social-sharing preview.
- Signed-in watchlist, custom-index, notes and alert-state sync through Supabase, with local browser fallback.
- Automated structural tests via `npm run check`.

## Owner actions required

1. In Supabase SQL Editor, run the latest `supabase/schema.sql` so the private `research_state` table and row-level-security policies exist.
2. Rotate the FMP API key that was previously pasted into chat, then replace only the Render environment value. Never place provider or Supabase secret keys in GitHub or browser code.
3. Confirm that the current FMP and Twelve Data plans permit public display/redistribution for every dataset shown by DollarDisha. API access and public redistribution rights are not always the same entitlement.
4. Configure Render service alerts for failed deploys, health-check failures and elevated error rates. Add an error-monitoring service before a broad public launch.
5. Verify Supabase automated backups and test a restore before collecting meaningful user data.
6. Review the privacy policy and terms with qualified counsel before marketing the service or collecting analytics.
7. Price alerts currently persist as research preferences; sending email/SMS/push alerts requires a scheduled worker and a transactional messaging provider.

## Release routine

1. Run `npm run check`.
2. Push to `main` and wait for the Render health check to pass.
3. Test the homepage, a permanent stock URL, Google sign-in, watchlist sync and a mobile layout.
4. Inspect `/healthz` and provider status without exposing any key values.

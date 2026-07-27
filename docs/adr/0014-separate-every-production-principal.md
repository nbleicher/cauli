# Separate every production principal

Cauli will not launch while the web and worker share Supabase’s unrestricted service-role credential. Web, identity, worker, Platform Admin, backup writer, retention deleter, Peely sync, migration/release, and Sentry build/runtime duties each receive a distinct least-privilege principal per environment, with no cross-principal secret reuse; every principal has a documented owner, scope, storage location, revocation and incident-rotation procedure, and automated denial tests for neighboring authority.

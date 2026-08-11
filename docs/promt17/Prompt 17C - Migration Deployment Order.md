# Prompt 17C — Migration deployment order

The forward migration `20260810000000_add_domain_request_governor` must be deployed before application code is allowed to use the Domain Request Governor in `shadow` or `enforce` mode.

## Required order

1. Validate and review the migration in a non-production environment.
2. Deploy the migration through the normal forward-only migration process.
3. Confirm the `DomainRequestGovernor` table and required indexes are available.
4. Deploy application code that can select `shadow` or `enforce` mode.

Do not enable `shadow` or `enforce` against an environment where this migration has not been deployed. The default application mode remains `off` until the migration is verified.

This document does not authorize migration deployment, production database access, or application deployment. No migration was deployed as part of Prompt 17C.

# Security and database baseline — tick what applies; write N/A with a reason otherwise
Security: [ ] authN/authZ tested [ ] least privilege [ ] secrets in a secret store [ ] no cross-user/client access [ ] no control disabled to pass tests
Database: [ ] PK/FK [ ] UNIQUE/NOT NULL/CHECK [ ] controlled migrations [ ] transactions [ ] idempotent retries [ ] indexes [ ] audit history [ ] tested backup + restore [ ] test data separate from production
AI: [ ] source provenance [ ] authorisation-aware retrieval [ ] evidence check [ ] independent test questions [ ] fail-safe [ ] approved write permissions [ ] approval before external actions
Frontend: [ ] desktop + mobile [ ] validated forms [ ] loading/error states [ ] no misleading actions or progress
Operations: [ ] versioned releases [ ] rollback [ ] monitoring/alerts [ ] logs [ ] performance budget [ ] health checks

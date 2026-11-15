# Release runbook notes (TASK-013)

- **First release has no previous record.** With no earlier release record for the environment, there is no previous digest to recover to. A failed smoke or observe step then exits 2 (`recovery-failed`), the job stays red and an alert is emitted; nothing is rolled back automatically. The incident owner decides the next step.
- **A previous record missing a service digest** also exits 2 with an alert before any rollback call is made for that service.
- **Without `HOST_ADAPTER`** the release only records "deployment-ready-not-deployed". Approval is verified in that mode only when a G3 record is passed to `verify-release-approval.sh`; with no G3 record there is nothing to verify and nothing is mutated.
- A G3 record must carry a non-empty `ref`; it is also used for the replay check.

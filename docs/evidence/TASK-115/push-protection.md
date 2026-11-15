# Host push protection read-back

- Repository: `zainnaeem28/meta-ads`
- Read at: 2026-11-15T20:38:48Z, commit 480b209
- Result: **GAP**
- Detail: security_and_analysis is not returned to this token (needs admin or security-manager access on the repository)

Recorded gap: the host does not confirm push protection here. The gitleaks gate on the diff, the full history and the
built bundle is the enforced control; enabling GitHub secret scanning and push protection is a repository-owner action
(go-live owner item), to be re-read with this script after it is switched on.

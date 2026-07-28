# Cauli

Cauli captures browser-based calls as durable records for agency quality assurance and feedback workflows. CallLog is the legacy extension name used only when discussing migration from v1.1.8.

## Language

**Call**:
A business interaction captured for quality assurance and feedback. In this release, each Call owns exactly one Recording.
_Avoid_: Recording, session

**Recording**:
A saved media artifact owned by a Call, comprising Source Audio and metadata with an optional Transcript. After “Stop & Save” succeeds, it remains available until deleted manually or by the Workspace Retention Policy.
_Avoid_: Audio blob, call file

**Incomplete Recording**:
A Recording recovered after capture ended unexpectedly rather than through the user’s Stop action. It is retained until the user finalizes or discards it.
_Avoid_: Failed Recording

**Degraded Recording**:
A Recording that is missing one selected audio source for part of the Call but retains the surviving captured audio.
_Avoid_: Broken Recording

**Recording Attestation**:
A Workspace Member’s recorded confirmation, made before capture begins, that all notices and consents required for the Call have been obtained.
_Avoid_: Consent, legal approval

**Retention Policy**:
A Workspace rule that permanently deletes Calls and all owned artifacts after a configured period. In this release, every Workspace has one Retention Policy.
_Avoid_: Expiration, cleanup schedule

**Source Audio**:
The authoritative audio retained for a Recording. Exports and transcripts can be regenerated from it without recapturing the call.
_Avoid_: Raw blob, temporary audio

**Source Audio Backup**:
An encrypted recovery copy of Source Audio held outside the primary storage failure domain and governed by the same Retention Policy.
_Avoid_: Archive, export

**U.S.-Hosted Production**:
The pilot boundary in which Cauli’s persistent production systems are hosted in verified U.S. regions while an approved zero-retention transcription provider may process Source Audio transiently elsewhere.
_Avoid_: U.S. data residency, U.S.-only processing

**Regulated-Use Disclaimer**:
Cauli’s statement that the pilot has not been independently assessed, certified, or contractually approved for named regulated workloads; it does not claim that a law cannot apply to Cauli or a Workspace.
_Avoid_: Compliance exemption, Prohibited Workload

**Transcript**:
The text representation derived from a Recording’s Source Audio. It can be regenerated without changing the Recording.
_Avoid_: Transcription

**Transcription Job**:
The background effort to derive a Transcript from Source Audio. It may retry recoverable failures without altering the Recording.
_Avoid_: Transcription request

**Needs Attention**:
A Transcription Job state used when automated retries cannot safely continue and admin action is required.
_Avoid_: Broken, permanently failed

**Budget Paused**:
A Transcription Job state in which Source Audio is safe but transcription waits for Platform Admin budget capacity without consuming a retry attempt.
_Avoid_: Failed, Needs Attention

### Workspace and access

**Workspace**:
The organizational boundary containing Workspace Members, Calls, Scorecards, and Reviews.
_Avoid_: Team, account

**Suspended Workspace**:
A Workspace whose member access and content-processing work are paused while backups, retention, auditing, and security controls continue.
_Avoid_: Disabled Workspace, deleted Workspace

**Workspace Closure**:
The irreversible deletion of a Workspace and its content after a 30-day cancellable suspension period. Content-free Audit Events remain until their own retention period ends.
_Avoid_: Workspace deletion, cancellation

**Workspace Member**:
A person with access to a Workspace through one assigned role. In this release, a person belongs to exactly one Workspace.
_Avoid_: User

**Former Workspace Member**:
A person whose Workspace access has been revoked while their historical attribution remains until the records carrying it are deleted.
_Avoid_: Deleted user, inactive user

**Workspace Invitation**:
A time-limited offer from an Admin for a person to become a Workspace Member with an assigned role.
_Avoid_: Signup, registration

**Invitation Activation**:
The one-time transition from an invited person to an active Workspace Member, completed only after required credentials and security factors are established.
_Avoid_: First login, signup

**Recovery Code**:
A single-use secret that, after password verification, permits a Workspace Member to replace a required second factor without granting application access by itself.
_Avoid_: Backup password, MFA bypass

**Audit Event**:
An immutable, content-free record of a privileged or destructive action, including who acted, what changed, the affected entity, and when.
_Avoid_: Activity log, application log

**Member Role**:
The baseline role that can access and delete only the Workspace Member’s own Calls.
_Avoid_: Member

**Manager**:
A Workspace role that can access and review every Call but cannot delete another Workspace Member’s Call.
_Avoid_: Reviewer

**Admin**:
A Workspace role that can manage the Workspace and delete any Call.
_Avoid_: Owner

**Platform Admin**:
A Cauli operator responsible for system-wide policy and operational controls across Workspaces. Platform Admins have no routine access to Call content; exceptional access requires an audited, time-limited break-glass grant.
_Avoid_: Power Admin, super admin

### Quality assurance

**Review**:
A Manager or Admin’s current evaluation of a Call. Each Call has one Review with an optional Review Assignee; it remains private from the Call’s owner while In Progress and becomes visible when submitted as Reviewed or Needs Follow-up.
_Avoid_: Feedback, assessment

**Review Assignee**:
The Manager or Admin accountable for completing a Review. Only the Review Assignee or an Admin may change an assigned Review.
_Avoid_: Reviewer, owner

**Review Revision**:
An immutable snapshot created whenever a Review is submitted, preserving its answers, outcome, and reviewer attribution at that moment.
_Avoid_: Review version

**Follow-up**:
A dated obligation created by a Needs Follow-up Review and assigned to the Call owner. The Call owner may mark it Resolved, and the Review Assignee or an Admin verifies closure.
_Avoid_: Review note, reminder

**Scorecard**:
A Workspace’s named framework for evaluating Calls.
_Avoid_: Rubric, evaluation form

**Scorecard Version**:
An immutable published definition of a Scorecard’s categories, criteria, and weights. Each Review remains tied to the version used for that evaluation.
_Avoid_: Scorecard draft

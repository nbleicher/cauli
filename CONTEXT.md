# Cauli

Cauli captures browser-based calls as durable records for agency quality assurance and feedback workflows. CallLog is the legacy extension name used only when discussing migration from v1.1.8.

## Language

**Call**:
A business interaction captured for quality assurance and feedback. In this release, each Call owns exactly one Recording.
_Avoid_: Recording, session

**Recording**:
A saved media artifact owned by a Call, comprising Source Audio and metadata with an optional Transcript. After “Stop & Save” succeeds, it remains available until the user deletes it.
_Avoid_: Audio blob, call file

**Incomplete Recording**:
A Recording recovered after capture ended unexpectedly rather than through the user’s Stop action. It is retained until the user finalizes or discards it.
_Avoid_: Failed Recording

**Degraded Recording**:
A Recording that is missing one selected audio source for part of the Call but retains the surviving captured audio.
_Avoid_: Broken Recording

**Source Audio**:
The authoritative audio retained for a Recording. Exports and transcripts can be regenerated from it without recapturing the call.
_Avoid_: Raw blob, temporary audio

**Transcript**:
The text representation derived from a Recording’s Source Audio. It can be regenerated without changing the Recording.
_Avoid_: Transcription

**Transcription Job**:
The background effort to derive a Transcript from Source Audio. It may retry recoverable failures without altering the Recording.
_Avoid_: Transcription request

**Needs Attention**:
A Transcription Job state used when automated retries cannot safely continue and admin action is required.
_Avoid_: Broken, permanently failed

### Workspace and access

**Workspace**:
The organizational boundary containing Workspace Members, Calls, Scorecards, and Reviews.
_Avoid_: Team, account

**Workspace Member**:
A person with access to a Workspace through one assigned role. In this release, a person belongs to exactly one Workspace.
_Avoid_: User

**Member Role**:
The baseline role that can access and delete only the Workspace Member’s own Calls.
_Avoid_: Member

**Manager**:
A Workspace role that can access and review every Call but cannot delete another Workspace Member’s Call.
_Avoid_: Reviewer

**Admin**:
A Workspace role that can manage the Workspace and delete any Call.
_Avoid_: Owner

### Quality assurance

**Review**:
A Manager or Admin’s current evaluation of a Call. Each Call has one Review, which remains private from the Call’s owner while In Progress and becomes visible when submitted as Reviewed or Needs Follow-up.
_Avoid_: Feedback, assessment

**Review Revision**:
An immutable snapshot created whenever a Review is submitted, preserving its answers, outcome, and reviewer attribution at that moment.
_Avoid_: Review version

**Scorecard**:
A Workspace’s named framework for evaluating Calls.
_Avoid_: Rubric, evaluation form

**Scorecard Version**:
An immutable published definition of a Scorecard’s categories, criteria, and weights. Each Review remains tied to the version used for that evaluation.
_Avoid_: Scorecard draft
